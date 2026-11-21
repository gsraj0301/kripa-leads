import { Hono } from "hono";
import { approveSettings, ensureSettings, insertEvent, putSettings } from "@kripa/db";
import {
  SettingsApproveSchema,
  SettingsUpdateSchema,
  type SettingsResponse,
} from "@kripa/shared";
import type { AppEnv } from "../env";
import { nowIso } from "@kripa/db";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", async (c) => {
  const settings = await ensureSettings(c.env.DB);
  return c.json({ settings } satisfies SettingsResponse);
});

settingsRoutes.put("/", async (c) => {
  const raw = await c.req.json();
  const body = SettingsUpdateSchema.parse(raw);
  const actor = c.get("actor");
  const previous = await ensureSettings(c.env.DB);
  const settings = await putSettings(c.env.DB, body, actor.email);
  await insertEvent(c.env.DB, {
    eventType: "settings_updated",
    payload: { configVersion: settings.configVersion },
    actorEmail: actor.email,
  });
  if (previous.exports.enabled !== settings.exports.enabled) {
    const note = (raw as { note?: string }).note ?? null;
    await insertEvent(c.env.DB, {
      eventType: "exports_toggled",
      actorEmail: actor.email,
      payload: {
        enabled: settings.exports.enabled,
        note,
        at: nowIso(),
      },
    });
  }
  return c.json({ settings } satisfies SettingsResponse);
});

settingsRoutes.post("/approve", async (c) => {
  const body = SettingsApproveSchema.parse(await c.req.json().catch(() => ({})));
  const actor = c.get("actor");
  const settings = await approveSettings(c.env.DB, actor.email);
  await insertEvent(c.env.DB, {
    eventType: "settings_approved",
    payload: { configVersion: settings.configVersion, note: body.note ?? null },
    actorEmail: actor.email,
  });
  return c.json({ settings } satisfies SettingsResponse);
});
