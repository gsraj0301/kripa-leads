import { nowIso } from "../util";

export interface RecordDeliveryInput {
  companyKey: string;
  name: string;
  domain: string | null;
  runId: string;
}

export async function isDelivered(db: D1Database, companyKey: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM deliveries WHERE company_key = ?")
    .bind(companyKey)
    .first<{ found: number }>();
  return row?.found === 1;
}

export async function getDeliveredCompanyKeys(
  db: D1Database,
  companyKeys: string[],
): Promise<Set<string>> {
  const unique = [...new Set(companyKeys.filter(Boolean))];
  const found = new Set<string>();
  for (let start = 0; start < unique.length; start += 90) {
    const chunk = unique.slice(start, start + 90);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT company_key FROM deliveries WHERE company_key IN (${placeholders})`)
      .bind(...chunk)
      .all<{ company_key: string }>();
    for (const row of rows.results) found.add(row.company_key);
  }
  return found;
}

export async function recordDelivery(db: D1Database, input: RecordDeliveryInput): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO deliveries
        (company_key, name, domain, first_run_id, first_delivered_at, last_delivered_at, export_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (company_key) DO UPDATE SET
         name = excluded.name,
         domain = excluded.domain,
         last_delivered_at = excluded.last_delivered_at,
         export_count = deliveries.export_count + 1`,
    )
    .bind(input.companyKey, input.name, input.domain, input.runId, now, now)
    .run();
}
