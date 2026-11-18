import { Hono } from "hono";
import { getEnabledSegments } from "@kripa/db";
import type { MeResponse, SegmentsResponse } from "@kripa/shared";
import type { AppEnv } from "../env";

export const metaRoutes = new Hono<AppEnv>();

metaRoutes.get("/me", (c) => {
  return c.json({ actor: c.get("actor") } satisfies MeResponse);
});

metaRoutes.get("/segments", async (c) => {
  const segments = await getEnabledSegments(c.env.DB);
  return c.json({ segments } satisfies SegmentsResponse);
});
