import type { ExtractionConfig } from "../settings";
import { normalizeExtractionJson } from "./parse";
import { buildExtractionPrompt } from "./prompt";
import type {
  ExtractionProvider,
  ExtractionResponse,
  ExtractionSchema,
  TokenUsage,
} from "./types";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_INLINE_RETRY_MS = 60_000;

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export class GroqQuotaError extends GroqError {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message, 429, retryAt - Date.now());
    this.name = "GroqQuotaError";
  }
}

export interface GroqProviderOptions {
  apiKey: string;
  config: Pick<
    ExtractionConfig,
    | "model"
    | "temperature"
    | "maxOutputTokens"
    | "reasoningEffort"
    | "timeoutMs"
    | "maxRetries"
    | "minIntervalMs"
  >;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface GroqResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usageFrom(body: GroqResponse): TokenUsage {
  const promptTokens = body.usage?.prompt_tokens ?? 0;
  const completionTokens = body.usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: body.usage?.total_tokens ?? promptTokens + completionTokens,
  };
}

function retryAfterMs(response: Response, now: Date): number | null {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now.getTime());
  }
  const reset = response.headers.get("x-ratelimit-reset-tokens");
  if (reset) {
    const seconds = Number.parseFloat(reset);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  }
  return null;
}

export function createGroqProvider(options: GroqProviderOptions): ExtractionProvider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");

  return {
    async extract(text: string, schema: ExtractionSchema): Promise<ExtractionResponse> {
      if (options.config.minIntervalMs > 0) {
        await sleep(options.config.minIntervalMs);
      }
      const messages = buildExtractionPrompt(text, schema);
      let useJsonMode = true;

      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.config.timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(GROQ_ENDPOINT, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: options.config.model,
              messages,
              temperature: options.config.temperature,
              max_tokens: options.config.maxOutputTokens,
              reasoning_effort: options.config.reasoningEffort,
              ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
              stream: false,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (attempt < options.config.maxRetries) {
            await sleep(1_000 * 2 ** attempt);
            continue;
          }
          throw new GroqError(
            error instanceof Error ? error.message : "Groq request failed.",
            0,
          );
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) {
          const body = (await response.json()) as GroqResponse;
          const choice = body.choices?.[0];
          const content = choice?.message?.content;
          if (!content) throw new GroqError("Groq returned an empty completion.", 200);
          if (choice?.finish_reason === "length") {
            throw new GroqError(
              "Groq completion was truncated at max_tokens before finishing.",
              200,
            );
          }
          return {
            payload: normalizeExtractionJson(content),
            usage: usageFrom(body),
            model: body.model ?? options.config.model,
            providerRequestId: response.headers.get("x-request-id"),
          };
        }

        const errorText = await response.text().catch(() => "");
        const detail = errorText.slice(0, 300);
        if (
          useJsonMode &&
          attempt === 0 &&
          response.status === 400 &&
          detail.includes("json_validate_failed")
        ) {
          useJsonMode = false;
          continue;
        }
        if (response.status === 429) {
          const waitMs = retryAfterMs(response, now()) ?? 60_000;
          if (waitMs > MAX_INLINE_RETRY_MS) {
            throw new GroqQuotaError(
              `Groq quota exhausted; retry after ${new Date(now().getTime() + waitMs).toISOString()}.`,
              now().getTime() + waitMs,
            );
          }
          if (attempt < options.config.maxRetries) {
            await sleep(waitMs);
            continue;
          }
          throw new GroqError(`Groq rate limited: ${detail}`, 429, waitMs);
        }
        if (response.status >= 500 && attempt < options.config.maxRetries) {
          await sleep(1_000 * 2 ** attempt);
          continue;
        }
        throw new GroqError(`Groq request failed (${response.status}): ${detail}`, response.status);
      }
    },
  };
}
