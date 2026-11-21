import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_CONFIG,
  EXTRACTION_DEFAULTS,
  GroqQuotaError,
  buildExtractionSchema,
  createGroqProvider,
  extractProspect,
  normalizeExtractionJson,
  parseExtractionPayload,
  quoteAppearsInText,
  countAppearsInQuote,
  budgetAfterUsage,
  type ExtractionProvider,
  type ExtractionResponse,
} from "@kripa/shared";

const config = DEFAULT_SETTINGS_CONFIG;
const segment = config.segments[0]!;
const rubric = config.rubrics[segment.id]!;

function provider(payload: unknown): ExtractionProvider {
  return {
    async extract(): Promise<ExtractionResponse> {
      return {
        payload,
        usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000 },
        model: "test-model",
        providerRequestId: "req-1",
      };
    },
  };
}

describe("quote verification", () => {
  it("normalizes case, unicode, and whitespace", () => {
    expect(quoteAppearsInText("  GST   Registration ", "We offer GST registration and filing.")).toBe(true);
    expect(quoteAppearsInText("GST registration", "We offer only bookkeeping.")).toBe(false);
  });

  it("parses fenced and embedded JSON", () => {
    expect(normalizeExtractionJson("```json\n{\"tags\":{}}\n```")).toEqual({ tags: {} });
    expect(normalizeExtractionJson("Here: {\"tags\":{}} done")).toEqual({ tags: {} });
  });
});

describe("count quote verification", () => {
  it("matches spelled-out numbers in quotes", () => {
    expect(countAppearsInQuote(7, "network had grown to seven outlets")).toBe(true);
    expect(countAppearsInQuote(2, "two staff members on site")).toBe(true);
    expect(countAppearsInQuote(25, "twenty-five staff members")).toBe(true);
    expect(countAppearsInQuote(125, "one hundred and twenty-five looms")).toBe(true);
  });

  it("rejects wrong spelled-out numbers", () => {
    expect(countAppearsInQuote(7, "network had grown to six outlets")).toBe(false);
    expect(countAppearsInQuote(7, "no numeric figure mentioned")).toBe(false);
  });
});

describe("budget checks", () => {
  const config = { runTokenBudget: 140_000, dailyTokenBudget: 200_000 };

  it("stays ok within run and daily budgets", () => {
    expect(
      budgetAfterUsage(100_000, 50_000, { promptTokens: 4_000, completionTokens: 6_000, totalTokens: 10_000 }, config),
    ).toBe("ok");
  });

  it("flags run budget overshoot", () => {
    expect(
      budgetAfterUsage(139_000, 50_000, { promptTokens: 800, completionTokens: 1_200, totalTokens: 2_000 }, config),
    ).toBe("run_budget");
  });

  it("flags daily quota overshoot", () => {
    expect(
      budgetAfterUsage(100_000, 199_000, { promptTokens: 800, completionTokens: 1_200, totalTokens: 2_000 }, config),
    ).toBe("quota");
  });

  it("prefers run_budget when both exceed", () => {
    expect(
      budgetAfterUsage(139_000, 199_000, { promptTokens: 800, completionTokens: 1_200, totalTokens: 2_000 }, config),
    ).toBe("run_budget");
  });
});

describe("extraction schema and payload", () => {
  it("builds tags and flags from configuration", () => {
    const schema = buildExtractionSchema(segment, rubric);
    expect(schema.tags.map((tag) => tag.id)).toEqual(segment.tags);
    expect(schema.tags[0]?.definition).toContain("GST");
    expect(schema.flags.map((flag) => flag.id)).toContain("directory_aggregator");
    expect(schema.flags.map((flag) => flag.id)).toContain("solo");
  });

  it("accepts tagged values, booleans, and numeric strings", () => {
    const parsed = parseExtractionPayload({
      tags: {
        gst: { p: true, q: "GST" },
        none: { p: false },
      },
      counts: { team: "12", offices: 3, founded: null },
      flags: { franchise: true },
    });
    expect(parsed.tags.gst).toEqual({ present: true, quote: "GST" });
    expect(parsed.tags.none!.present).toBe(false);
    expect(parsed.counts).toEqual({
      team: { quote: null, value: 12 },
      offices: { quote: null, value: 3 },
      founded: null,
    });
    expect(parsed.flags.franchise!.present).toBe(true);
  });
});

describe("extractProspect", () => {
  it("keeps only quotes that appear in the source text", async () => {
    const text =
      "Acme offers GST registration, payroll processing, and multi-state operations. We are a franchise.";
    const outcome = await extractProspect({
      text,
      segment,
      rubric,
      sourceUrl: "https://acme.test/",
      provider: provider({
        tags: {
          gst_registered: { p: true, q: "GST registration" },
          hiring_team: { p: true, q: "payroll processing" },
          manufacturing: { p: true, q: "we make things" },
        },
        counts: { team: 12, offices: 2, founded: 2015 },
        flags: { franchise: { p: true, q: "a franchise" } },
      }),
    });

    expect(outcome.tags.gst_registered).toMatchObject({
      present: true,
      verified: true,
      quote: "GST registration",
    });
    expect(outcome.tags.hiring_team).toMatchObject({
      present: true,
      verified: true,
      quote: "payroll processing",
    });
    expect(outcome.tags.manufacturing).toMatchObject({
      present: false,
      verified: false,
      quote: "we make things",
    });
    expect(outcome.tags.franchise!.present).toBe(true);
    expect(outcome.tags.solo!.present).toBe(false);
    expect(outcome.counts).toEqual({ team: null, offices: null, founded: null });
    expect(outcome.quoteChecks).toBe(7);
    expect(outcome.quoteFailures).toBe(4);
    expect(outcome.usage.totalTokens).toBe(1_000);
  });

  it("marks a claimed tag with a missing quote as false", async () => {
    const outcome = await extractProspect({
      text: "Acme offers bookkeeping.",
      segment,
      rubric,
      sourceUrl: "https://acme.test/",
      provider: provider({ tags: { gst_registered: { p: true, q: null } } }),
    });
    expect(outcome.tags.gst_registered!.present).toBe(false);
    expect(outcome.quoteFailures).toBe(1);
    expect(outcome.quoteChecks).toBe(1);
  });
});

describe("Groq provider", () => {
  function providerWithFetch(fetchImpl: typeof fetch, maxRetries = 1) {
    return createGroqProvider({
      apiKey: "test-key",
      config: { ...EXTRACTION_DEFAULTS, minIntervalMs: 0, maxRetries },
      fetchImpl,
      sleep: async () => undefined,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });
  }

  it("returns parsed JSON, usage, and the provider request id", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: '{"tags":{},"counts":{},"flags":{}}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { "x-request-id": "req-1" } },
      );
    }) as typeof fetch;

    const result = await providerWithFetch(fetchImpl).extract("text", { tags: [], flags: [] });
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(result.providerRequestId).toBe("req-1");
    expect(captured?.method).toBe("POST");
    expect(String(captured?.headers && (captured.headers as Record<string, string>).authorization)).toContain(
      "Bearer",
    );
  });

  it("retries short 429 responses", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"tags":{}}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await providerWithFetch(fetchImpl).extract("text", { tags: [], flags: [] });
    expect(calls).toBe(2);
    expect(result.usage.totalTokens).toBe(2);
  });

  it("surfaces long 429 responses as quota errors", async () => {
    const fetchImpl = (async () =>
      new Response("daily limit", {
        status: 429,
        headers: { "retry-after": "3600" },
      })) as typeof fetch;

    await expect(
      providerWithFetch(fetchImpl).extract("text", { tags: [], flags: [] }),
    ).rejects.toBeInstanceOf(GroqQuotaError);
  });

  it("rejects truncated max_tokens completions", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: "test-model",
          choices: [
            {
              message: { content: '{"tags":{},"counts":{},"flags":{}}' },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 800, total_tokens: 810 },
        }),
        { status: 200 },
      )) as typeof fetch;

    await expect(
      providerWithFetch(fetchImpl).extract("text", { tags: [], flags: [] }),
    ).rejects.toThrow(/truncated/);
  });
});
