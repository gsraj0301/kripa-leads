import {
  RunSchema,
  RunStatusSchema,
  type Run,
  type RunCounts,
} from "@kripa/shared";
import type { RunRow } from "../types";
import { jsonText, newId, nowIso, parseJson } from "../util";

export interface CreateRunInput {
  areaText: string;
  resolvedPlaceId: string | null;
  resolvedLabel: string | null;
  segmentIds: string[];
  includePreviouslyDelivered: boolean;
  plan: Record<string, unknown>;
  segmentsSnapshot: Record<string, unknown>;
  scoringSnapshot: Record<string, unknown>;
  scoringConfigVersion: number;
}

function toRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    areaText: row.area_text,
    resolvedPlaceId: row.resolved_place_id,
    resolvedLabel: row.resolved_label,
    segmentIds: parseJson<string[]>(row.segment_ids_json, []),
    includePreviouslyDelivered: row.include_previously_delivered === 1,
    plan: parseJson<Record<string, unknown>>(row.plan_json, {}),
    segmentsSnapshot: parseJson<Record<string, unknown>>(row.segments_snapshot_json, {}),
    scoringSnapshot: parseJson<Record<string, unknown>>(row.scoring_snapshot_json, {}),
    scoringConfigVersion: row.scoring_config_version,
    status: row.status,
    counts: parseJson<RunCounts>(row.counts_json, {} as RunCounts),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function createRun(db: D1Database, input: CreateRunInput): Promise<Run> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO runs
        (id, area_text, resolved_place_id, resolved_label, segment_ids_json,
         include_previously_delivered, plan_json, segments_snapshot_json,
         scoring_snapshot_json, scoring_config_version, status, counts_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', '{}', ?, ?)`,
    )
    .bind(
      id,
      input.areaText,
      input.resolvedPlaceId,
      input.resolvedLabel,
      jsonText(input.segmentIds),
      input.includePreviouslyDelivered ? 1 : 0,
      jsonText(input.plan),
      jsonText(input.segmentsSnapshot),
      jsonText(input.scoringSnapshot),
      input.scoringConfigVersion,
      now,
      now,
    )
    .run();
  const run = await getRun(db, id);
  if (!run) throw new Error("run missing after insert");
  return run;
}

export async function getRun(db: D1Database, id: string): Promise<Run | null> {
  const row = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
  return row ? toRun(row) : null;
}

export async function listRuns(db: D1Database, limit = 50): Promise<Run[]> {
  const rows = await db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<RunRow>();
  return rows.results.map(toRun);
}

export async function updateRunStatus(
  db: D1Database,
  id: string,
  status: string,
  counts?: RunCounts,
): Promise<Run | null> {
  const parsedStatus = RunStatusSchema.parse(status);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE runs
          SET status = ?, counts_json = COALESCE(?, counts_json), updated_at = ?
        WHERE id = ?`,
    )
    .bind(parsedStatus, counts ? jsonText(counts) : null, now, id)
    .run();
  return getRun(db, id);
}

export async function updateRunCounts(
  db: D1Database,
  id: string,
  counts: RunCounts,
): Promise<void> {
  await db
    .prepare("UPDATE runs SET counts_json = ?, updated_at = ? WHERE id = ?")
    .bind(jsonText(counts), nowIso(), id)
    .run();
}

export interface EnrichmentSummary {
  enriched: number;
  skippedNoWebsite: number;
  pagesFetched: number;
  failures: number;
  robotsBlocked: number;
  failureReasons: Record<string, number>;
}

export function classifyEnrichmentFailure(reason: string): string {
  const value = reason.toLowerCase();
  const http = value.match(/^http (\d{3})/);
  if (http) return `http_${http[1]}`;
  if (value.includes("dead_site") || value.includes("nxdomain")) return "dead_site";
  if (value.includes("unsupported content type")) return "non_html";
  if (value.includes("robots")) return "robots";
  if (value.includes("doh lookup") || value.includes("no a or aaaa") || value.includes("dns")) {
    return "dns_failure";
  }
  if (value.includes("redirect")) return "redirect";
  if (value.includes("timeout") || value.includes("timed out") || value.includes("aborted")) {
    return "timeout";
  }
  if (value.includes("enotfound") || value.includes("eai_again")) return "network_dns";
  if (
    value.includes("fetch failed") ||
    value.includes("network") ||
    value.includes("connection lost") ||
    value.includes("internal error")
  ) {
    return "network";
  }
  if (value.includes("ssrf") || value.includes("blocked") || value.includes("private")) {
    return "ssrf_blocked";
  }
  if (value.includes("budget")) return "budget";
  return "other";
}

export async function summarizeEnrichment(
  db: D1Database,
  runId: string,
): Promise<EnrichmentSummary> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN COALESCE(json_extract(enrichment_json, '$.pagesFetched'), 0) > 0 THEN 1 ELSE 0 END), 0) AS enriched,
         COALESCE(SUM(CASE WHEN status <> 'raw' AND (website IS NULL OR website = '') THEN 1 ELSE 0 END), 0) AS skipped_no_website,
         COALESCE(SUM(COALESCE(json_extract(enrichment_json, '$.pagesFetched'), 0)), 0) AS pages_fetched,
         COALESCE(SUM(CASE WHEN json_extract(enrichment_json, '$.failed') = 1 THEN 1 ELSE 0 END), 0) AS failures,
         COALESCE(SUM(CASE WHEN json_extract(enrichment_json, '$.robotsBlocked') = 1 THEN 1 ELSE 0 END), 0) AS robots_blocked
       FROM prospects
       WHERE run_id = ?`,
    )
    .bind(runId)
    .first<{
      enriched: number;
      skipped_no_website: number;
      pages_fetched: number;
      failures: number;
      robots_blocked: number;
    }>();

  const factsRows = await db
    .prepare("SELECT facts_json FROM prospects WHERE run_id = ?")
    .bind(runId)
    .all<{ facts_json: string }>();
  const failureReasons: Record<string, number> = {};
  for (const item of factsRows.results) {
    const facts = parseJson<{ websiteFailureReason?: unknown }>(item.facts_json, {});
    if (typeof facts.websiteFailureReason === "string" && facts.websiteFailureReason.trim()) {
      const reason = classifyEnrichmentFailure(facts.websiteFailureReason);
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
  }

  return {
    enriched: Number(row?.enriched ?? 0),
    skippedNoWebsite: Number(row?.skipped_no_website ?? 0),
    pagesFetched: Number(row?.pages_fetched ?? 0),
    failures: Number(row?.failures ?? 0),
    robotsBlocked: Number(row?.robots_blocked ?? 0),
    failureReasons,
  };
}

export interface ScoringSummary {
  scored: number;
  notScored: number;
  belowFloor: number;
  extractionFailures: number;
}

export async function summarizeScoring(db: D1Database, runId: string): Promise<ScoringSummary> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END), 0) AS scored,
         COALESCE(SUM(CASE WHEN status = 'not_scored' THEN 1 ELSE 0 END), 0) AS not_scored,
         COALESCE(SUM(CASE WHEN status = 'below_floor' THEN 1 ELSE 0 END), 0) AS below_floor,
         (SELECT COUNT(*) FROM events WHERE run_id = ? AND event_type = 'extraction_failed') AS extraction_failures
       FROM prospects
       WHERE run_id = ?`,
    )
    .bind(runId, runId)
    .first<{
      scored: number;
      not_scored: number;
      below_floor: number;
      extraction_failures: number;
    }>();
  return {
    scored: Number(row?.scored ?? 0),
    notScored: Number(row?.not_scored ?? 0),
    belowFloor: Number(row?.below_floor ?? 0),
    extractionFailures: Number(row?.extraction_failures ?? 0),
  };
}

export interface GroqUsageSummary {
  calls: number;
  tokensUsed: number;
  tokensIn: number;
  tokensOut: number;
  quoteFailures: number;
  quoteChecks: number;
  countFailures: number;
  countChecks: number;
}

export async function summarizeGroqUsage(
  db: D1Database,
  runId: string,
): Promise<GroqUsageSummary> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS calls,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.totalTokens'), 0)), 0) AS tokens_used,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.promptTokens'), 0)), 0) AS tokens_in,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.completionTokens'), 0)), 0) AS tokens_out,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.quoteFailures'), 0)), 0) AS quote_failures,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.quoteChecks'), 0)), 0) AS quote_checks,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.countFailures'), 0)), 0) AS count_failures,
         COALESCE(SUM(COALESCE(json_extract(payload_json, '$.countChecks'), 0)), 0) AS count_checks
       FROM events
       WHERE run_id = ? AND event_type = 'groq_usage'`,
    )
    .bind(runId)
    .first<{
      calls: number;
      tokens_used: number;
      tokens_in: number;
      tokens_out: number;
      quote_failures: number;
      quote_checks: number;
      count_failures: number;
      count_checks: number;
    }>();
  return {
    calls: Number(row?.calls ?? 0),
    tokensUsed: Number(row?.tokens_used ?? 0),
    tokensIn: Number(row?.tokens_in ?? 0),
    tokensOut: Number(row?.tokens_out ?? 0),
    quoteFailures: Number(row?.quote_failures ?? 0),
    quoteChecks: Number(row?.quote_checks ?? 0),
    countFailures: Number(row?.count_failures ?? 0),
    countChecks: Number(row?.count_checks ?? 0),
  };
}

export async function getGroqUsageOnDate(
  db: D1Database,
  datePrefix: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(json_extract(payload_json, '$.totalTokens'), 0)), 0) AS tokens
         FROM events
        WHERE event_type = 'groq_usage' AND created_at LIKE ?`,
    )
    .bind(`${datePrefix}%`)
    .first<{ tokens: number }>();
  return Number(row?.tokens ?? 0);
}

export async function getRunGroqTokens(db: D1Database, runId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(json_extract(payload_json, '$.totalTokens'), 0)), 0) AS tokens
         FROM events
        WHERE run_id = ? AND event_type = 'groq_usage'`,
    )
    .bind(runId)
    .first<{ tokens: number }>();
  return Number(row?.tokens ?? 0);
}

export async function getCreditsUsedOnDate(
  db: D1Database,
  datePrefix: string,
): Promise<number> {
  const rows = await db
    .prepare("SELECT counts_json FROM runs WHERE created_at >= ? AND created_at < ?")
    .bind(`${datePrefix}T00:00:00.000Z`, `${datePrefix}T23:59:59.999Z`)
    .all<{ counts_json: string }>();
  let total = 0;
  for (const row of rows.results) {
    const counts = parseJson<{ creditsUsed?: number }>(row.counts_json, {});
    total += typeof counts.creditsUsed === "number" ? counts.creditsUsed : 0;
  }
  return total;
}
