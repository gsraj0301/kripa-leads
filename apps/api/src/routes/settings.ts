import { Hono } from "hono";
import { approveSettings, ensureSettings, insertEvent, putSettings } from "@kripa/db";
import {
  SettingsApproveSchema,
  SettingsUpdateSchema,
  type SettingsResponse,
} from "@kripa/shared";
import type { AppEnv } from "../env";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", async (c) => {
  const settings = await ensureSettings(c.env.DB);
  return c.json({ settings } satisfies SettingsResponse);
});

settingsRoutes.put("/", async (c) => {
  const body = SettingsUpdateSchema.parse(await c.req.json());
  const actor = c.get("actor");
  const settings = await putSettings(c.env.DB, body, actor.email);
  await insertEvent(c.env.DB, {
    eventType: "settings_updated",
    payload: { configVersion: settings.configVersion },
    actorEmail: actor.email,
  });
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
