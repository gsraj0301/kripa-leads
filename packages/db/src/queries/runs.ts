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
}

export async function summarizeEnrichment(
  db: D1Database,
  runId: string,
): Promise<EnrichmentSummary> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'enriched' THEN 1 ELSE 0 END), 0) AS enriched,
         COALESCE(SUM(CASE WHEN status = 'valid' AND (website IS NULL OR website = '') THEN 1 ELSE 0 END), 0) AS skipped_no_website,
         COALESCE(SUM(CASE WHEN status = 'enriched' THEN COALESCE(json_extract(enrichment_json, '$.pagesFetched'), 0) ELSE 0 END), 0) AS pages_fetched,
         COALESCE(SUM(CASE WHEN status = 'enriched' AND json_extract(enrichment_json, '$.failed') = 1 THEN 1 ELSE 0 END), 0) AS failures,
         COALESCE(SUM(CASE WHEN status = 'enriched' AND json_extract(enrichment_json, '$.robotsBlocked') = 1 THEN 1 ELSE 0 END), 0) AS robots_blocked
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

  return {
    enriched: Number(row?.enriched ?? 0),
    skippedNoWebsite: Number(row?.skipped_no_website ?? 0),
    pagesFetched: Number(row?.pages_fetched ?? 0),
    failures: Number(row?.failures ?? 0),
    robotsBlocked: Number(row?.robots_blocked ?? 0),
  };
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
