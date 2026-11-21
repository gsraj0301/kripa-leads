import type { ParsedCounts, ParsedExtraction, ParsedTagValue } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTagValue(value: unknown): ParsedTagValue {
  if (typeof value === "boolean") {
    return { present: value, quote: null };
  }
  if (!isRecord(value)) {
    return { present: false, quote: null };
  }
  const present = value.p === true;
  const quote = typeof value.q === "string" && value.q.trim() ? value.q.trim() : null;
  return { present, quote };
}

function parseCountNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
  const integer = Math.trunc(parsed);
  return integer >= 0 ? integer : null;
}

function parseCount(value: unknown): ParsedCounts["team"] {
  if (typeof value === "number" || typeof value === "string") {
    const number = parseCountNumber(value);
    return number === null ? null : { value: number, quote: null };
  }
  if (!isRecord(value)) return null;
  const number = parseCountNumber(value.v ?? value.value);
  if (number === null) return null;
  const quote =
    typeof value.q === "string" && value.q.trim()
      ? value.q.trim()
      : typeof value.quote === "string" && value.quote.trim()
        ? value.quote.trim()
        : null;
  return { value: number, quote };
}

export function parseExtractionPayload(payload: unknown): ParsedExtraction {
  const root = isRecord(payload) ? payload : {};
  const tagRoot = isRecord(root.tags) ? root.tags : {};
  const flagRoot = isRecord(root.flags) ? root.flags : {};
  const countRoot = isRecord(root.counts) ? root.counts : {};

  const tags: Record<string, ParsedTagValue> = {};
  for (const [id, value] of Object.entries(tagRoot)) {
    tags[id] = parseTagValue(value);
  }
  const flags: Record<string, ParsedTagValue> = {};
  for (const [id, value] of Object.entries(flagRoot)) {
    flags[id] = parseTagValue(value);
  }

  const counts: ParsedCounts = {
    team: parseCount(countRoot.team),
    offices: parseCount(countRoot.offices),
    founded: parseCount(countRoot.founded),
  };

  return { tags, counts, flags };
}

export function normalizeExtractionJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(jsonText.slice(first, last + 1));
    }
    throw new Error("Groq returned invalid JSON.");
  }
}
