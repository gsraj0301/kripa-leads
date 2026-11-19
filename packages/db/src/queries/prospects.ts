import { ProspectSchema, type Prospect } from "@kripa/shared";
import type { ProspectRow } from "../types";
import { jsonText, newId, nowIso, parseJson } from "../util";

export interface ProspectInsert {
  runId: string;
  segmentId: string;
  source?: string;
  sourceId?: string | null;
  category?: string | null;
  companyKey: string;
  name: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  tags?: Record<string, unknown>;
  facts?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  enrichment?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  status?: "raw" | "valid";
}

function toProspect(row: ProspectRow): Prospect {
  return ProspectSchema.parse({
    id: row.id,
    runId: row.run_id,
    segmentId: row.segment_id,
    source: row.source,
    sourceId: row.source_id,
    category: row.category,
    companyKey: row.company_key,
    name: row.name,
    website: row.website,
    phone: row.phone,
    email: row.email,
    address: row.address,
    city: row.city,
    state: row.state,
    postcode: row.postcode,
    latitude: row.latitude,
    longitude: row.longitude,
    fitScore: row.fit_score,
    fitBand: row.fit_band,
    contactabilityScore: row.contactability_score,
    contactabilityBand: row.contactability_band,
    tags: parseJson<Record<string, unknown>>(row.tags_json, {}),
    facts: parseJson<Record<string, unknown>>(row.facts_json, {}),
    raw: parseJson<Record<string, unknown>>(row.raw_json, {}),
    scoreExplain: parseJson<Record<string, unknown>>(row.score_explain_json, {}),
    needsManualContactResearch: row.needs_manual_contact_research === 1,
    provenance: parseJson<Record<string, unknown>>(row.provenance_json, {}),
    enrichment: parseJson<Record<string, unknown>>(row.enrichment_json, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function insertProspects(
  db: D1Database,
  prospects: ProspectInsert[],
): Promise<number> {
  if (prospects.length === 0) return 0;
  const now = nowIso();
  const statements = prospects.map((prospect) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO prospects
          (id, run_id, segment_id, source, source_id, category, company_key,
           name, website, phone, email, address, city, state, postcode,
           latitude, longitude, tags_json, facts_json, raw_json, provenance_json,
           enrichment_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        prospect.runId,
        prospect.segmentId,
        prospect.source ?? "geoapify",
        prospect.sourceId ?? null,
        prospect.category ?? null,
        prospect.companyKey,
        prospect.name,
        prospect.website ?? null,
        prospect.phone ?? null,
        prospect.email ?? null,
        prospect.address ?? null,
        prospect.city ?? null,
        prospect.state ?? null,
        prospect.postcode ?? null,
        prospect.latitude ?? null,
        prospect.longitude ?? null,
        jsonText(prospect.tags ?? {}),
        jsonText(prospect.facts ?? {}),
        jsonText(prospect.raw ?? {}),
        jsonText(prospect.provenance ?? {}),
        jsonText(prospect.enrichment ?? {}),
        prospect.status ?? "raw",
        now,
        now,
      ),
  );
  const results = await db.batch(statements);
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

export async function listProspectsForEnrichment(
  db: D1Database,
  runId: string,
  limit: number,
): Promise<Prospect[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM prospects
        WHERE run_id = ? AND status = 'valid' AND website IS NOT NULL AND website != ''
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(runId, limit)
    .all<ProspectRow>();
  return rows.results.map(toProspect);
}

export interface ProspectEnrichmentUpdate {
  id: string;
  facts: Record<string, unknown>;
  provenance: Record<string, unknown>;
  enrichment: Record<string, unknown>;
  status: "enriched";
}

export async function updateProspectEnrichments(
  db: D1Database,
  updates: ProspectEnrichmentUpdate[],
): Promise<number> {
  if (updates.length === 0) return 0;
  const now = nowIso();
  const statements = updates.map((update) =>
    db
      .prepare(
        `UPDATE prospects
            SET facts_json = ?, provenance_json = ?, enrichment_json = ?,
                status = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        jsonText(update.facts),
        jsonText(update.provenance),
        jsonText(update.enrichment),
        update.status,
        now,
        update.id,
      ),
  );
  const results = await db.batch(statements);
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

export async function listProspectsByRun(db: D1Database, runId: string): Promise<Prospect[]> {
  const rows = await db
    .prepare("SELECT * FROM prospects WHERE run_id = ? ORDER BY created_at ASC")
    .bind(runId)
    .all<ProspectRow>();
  return rows.results.map(toProspect);
}

export async function getProspect(db: D1Database, id: string): Promise<Prospect | null> {
  const row = await db.prepare("SELECT * FROM prospects WHERE id = ?").bind(id).first<ProspectRow>();
  return row ? toProspect(row) : null;
}

export async function setProspectStatus(
  db: D1Database,
  id: string,
  status: string,
): Promise<Prospect | null> {
  await db
    .prepare("UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), id)
    .run();
  return getProspect(db, id);
}
