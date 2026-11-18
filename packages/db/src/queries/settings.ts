import {
  DEFAULT_SETTINGS_CONFIG,
  PROVISIONAL_REASON,
  SettingsConfigSchema,
  SettingsSchema,
  type Segment,
  type Settings,
  type SettingsConfig,
} from "@kripa/shared";
import type { SettingsRow } from "../types";
import { jsonText, nowIso } from "../util";

function toSettings(row: SettingsRow): Settings {
  const config = SettingsConfigSchema.parse(JSON.parse(row.config_json));
  return SettingsSchema.parse({
    ...config,
    configVersion: row.config_version,
    approved: row.approved === 1,
    provisional: row.provisional === 1,
    provisionalReason: row.provisional_reason,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });
}

async function getSettingsRow(db: D1Database): Promise<SettingsRow | null> {
  return db.prepare("SELECT * FROM settings WHERE id = 1").first<SettingsRow>();
}

export async function ensureSettings(db: D1Database): Promise<Settings> {
  const existing = await getSettingsRow(db);
  if (existing) return toSettings(existing);

  const now = nowIso();
  await db
    .prepare(
      `INSERT OR IGNORE INTO settings
        (id, config_json, config_version, approved, provisional, provisional_reason, updated_at, updated_by)
       VALUES (1, ?, 1, 0, 1, ?, ?, 'system')`,
    )
    .bind(jsonText(DEFAULT_SETTINGS_CONFIG), PROVISIONAL_REASON, now)
    .run();

  const created = await getSettingsRow(db);
  if (!created) throw new Error("settings row missing after bootstrap");
  return toSettings(created);
}

export async function putSettings(
  db: D1Database,
  input: SettingsConfig,
  actorEmail: string,
): Promise<Settings> {
  await ensureSettings(db);
  const config = SettingsConfigSchema.parse(input);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE settings
          SET config_json = ?,
              config_version = config_version + 1,
              approved = 0,
              provisional = 1,
              provisional_reason = ?,
              updated_at = ?,
              updated_by = ?
        WHERE id = 1`,
    )
    .bind(
      jsonText(config),
      "Configuration changed; pending Kripa's approval.",
      now,
      actorEmail,
    )
    .run();
  return ensureSettings(db);
}

export async function approveSettings(db: D1Database, actorEmail: string): Promise<Settings> {
  await ensureSettings(db);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE settings
          SET approved = 1,
              provisional = 0,
              provisional_reason = NULL,
              updated_at = ?,
              updated_by = ?
        WHERE id = 1`,
    )
    .bind(now, actorEmail)
    .run();
  return ensureSettings(db);
}

export async function getEnabledSegments(db: D1Database): Promise<Segment[]> {
  const settings = await ensureSettings(db);
  return settings.segments.filter((segment) => segment.enabled);
}
