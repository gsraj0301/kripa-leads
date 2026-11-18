import type { EventRow } from "../types";
import { jsonText, newId, nowIso, parseJson } from "../util";

export interface InsertEventInput {
  runId?: string | null;
  prospectId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
  actorEmail?: string | null;
}

export interface Event {
  id: string;
  runId: string | null;
  prospectId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  actorEmail: string | null;
  createdAt: string;
}

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    runId: row.run_id,
    prospectId: row.prospect_id,
    eventType: row.event_type,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    actorEmail: row.actor_email,
    createdAt: row.created_at,
  };
}

export async function insertEvent(db: D1Database, input: InsertEventInput): Promise<Event> {
  const id = newId();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO events (id, run_id, prospect_id, event_type, payload_json, actor_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.runId ?? null,
      input.prospectId ?? null,
      input.eventType,
      jsonText(input.payload ?? {}),
      input.actorEmail ?? null,
      now,
    )
    .run();
  return {
    id,
    runId: input.runId ?? null,
    prospectId: input.prospectId ?? null,
    eventType: input.eventType,
    payload: input.payload ?? {},
    actorEmail: input.actorEmail ?? null,
    createdAt: now,
  };
}

export async function listEventsByRun(db: D1Database, runId: string): Promise<Event[]> {
  const rows = await db
    .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC")
    .bind(runId)
    .all<EventRow>();
  return rows.results.map(toEvent);
}
