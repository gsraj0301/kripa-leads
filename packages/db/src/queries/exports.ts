import { newId, nowIso, jsonText } from "../util";

export interface RecordExportInput {
  runId: string;
  rowCount: number;
  filename: string;
  filters: Record<string, unknown>;
  actorEmail: string;
}

export async function recordExport(db: D1Database, input: RecordExportInput): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO exports (id, run_id, row_count, filename, filters_json, actor_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.runId,
      input.rowCount,
      input.filename,
      jsonText(input.filters),
      input.actorEmail,
      nowIso(),
    )
    .run();
  return id;
}
