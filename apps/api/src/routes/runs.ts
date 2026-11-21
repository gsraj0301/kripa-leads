import { Hono } from "hono";
import {
  createRun,
  ensureSettings,
  getCreditsUsedOnDate,
  getRun,
  insertEvent,
  listProspectsByRun,
  listRuns,
  updateRunStatus,
} from "@kripa/db";
import {
  GeocodeRequestSchema,
  GeoapifyClient,
  GeoapifyError,
  CreditBudgetError,
  RunCreateSchema,
  estimateDiscoveryCredits,
  type ProspectListResponse,
  type RunListResponse,
  type RunResponse,
} from "@kripa/shared";
import type { AppEnv } from "../env";
import { HttpError } from "../http";

export const runRoutes = new Hono<AppEnv>();

function geocodeError(error: unknown): HttpError {
  if (error instanceof CreditBudgetError) {
    return new HttpError(429, "credit_budget_exhausted", error.message);
  }
  if (error instanceof GeoapifyError) {
    return new HttpError(502, "geoapify_error", error.message);
  }
  return new HttpError(502, "geoapify_error", "Geoapify request failed.");
}

runRoutes.post("/geocode", async (c) => {
  const body = GeocodeRequestSchema.parse(await c.req.json());
  const settings = await ensureSettings(c.env.DB);
  const apiKey = c.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(500, "geoapify_not_configured", "GEOAPIFY_API_KEY is not configured.");
  }

  const client = new GeoapifyClient({
    apiKey,
    minIntervalMs: settings.discovery.minIntervalMs,
  });
  try {
    const candidates = await client.geocode(body.area, {
      countryCode: body.countryCode ?? settings.discovery.defaultCountryCode,
    });
    await insertEvent(c.env.DB, {
      eventType: "geocode_search",
      actorEmail: c.get("actor").email,
      payload: {
        area: body.area,
        countryCode: body.countryCode ?? settings.discovery.defaultCountryCode,
        candidates: candidates.length,
        creditsUsed: client.creditsUsed,
      },
    });
    return c.json({ candidates, creditsUsed: client.creditsUsed });
  } catch (error) {
    throw geocodeError(error);
  }
});

runRoutes.get("/runs", async (c) => {
  const runs = await listRuns(c.env.DB);
  return c.json({ runs } satisfies RunListResponse);
});

runRoutes.post("/runs", async (c) => {
  const body = RunCreateSchema.parse(await c.req.json());
  const settings = await ensureSettings(c.env.DB);
  const requested = [...new Set(body.segmentIds)];
  const selected = settings.segments.filter(
    (segment) => requested.includes(segment.id) && segment.enabled,
  );
  if (selected.length !== requested.length) {
    throw new HttpError(
      400,
      "invalid_segments",
      "Every selected segment must exist and be enabled.",
    );
  }

  const categories = [...new Set(selected.flatMap((segment) => segment.categories))];
  const estimate = estimateDiscoveryCredits(
    categories.length,
    settings.discovery.maxResultsPerCategory,
  );
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = await getCreditsUsedOnDate(c.env.DB, today);
  if (usedToday + estimate.total > settings.discovery.dailyCreditBudget) {
    const remaining = Math.max(0, settings.discovery.dailyCreditBudget - usedToday);
    throw new HttpError(
      400,
      "credit_budget_shortfall",
      `Estimated up to ${estimate.total} credits but only ${remaining} remain today. Reduce max results per category or run tomorrow.`,
    );
  }

  const run = await createRun(c.env.DB, {
    areaText: body.areaText,
    resolvedPlaceId: body.resolvedPlaceId,
    resolvedLabel: body.resolvedLabel,
    segmentIds: selected.map((segment) => segment.id),
    includePreviouslyDelivered: body.includePreviouslyDelivered,
    plan: {
      estimate,
      categories,
      maxResultsPerCategory: settings.discovery.maxResultsPerCategory,
      minIntervalMs: settings.discovery.minIntervalMs,
      dailyCreditBudget: settings.discovery.dailyCreditBudget,
      usedToday,
    },
    segmentsSnapshot: { segments: selected },
    scoringSnapshot: {
      rubrics: Object.fromEntries(selected.map((segment) => [segment.id, settings.rubrics[segment.id]])),
      scoring: settings.scoring,
      extraction: settings.extraction,
    },
    scoringConfigVersion: settings.configVersion,
  });
  await insertEvent(c.env.DB, {
    runId: run.id,
    eventType: "run_planned",
    actorEmail: c.get("actor").email,
    payload: {
      area: body.areaText,
      segmentIds: run.segmentIds,
      estimate,
      includePreviouslyDelivered: body.includePreviouslyDelivered,
    },
  });
  return c.json({ run } satisfies RunResponse, 201);
});

runRoutes.get("/runs/:id", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (!run) throw new HttpError(404, "not_found", "Run not found.");
  return c.json({ run } satisfies RunResponse);
});

runRoutes.get("/runs/:id/prospects", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (!run) throw new HttpError(404, "not_found", "Run not found.");
  const prospects = await listProspectsByRun(c.env.DB, run.id);
  return c.json({ prospects } satisfies ProspectListResponse);
});

runRoutes.post("/runs/:id/start", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (!run) throw new HttpError(404, "not_found", "Run not found.");
  if (run.status !== "planned") {
    throw new HttpError(409, "invalid_run_status", "Only a planned run can be started.");
  }
  const workflow = c.env.LEAD_RUN_WORKFLOW;
  if (!workflow) {
    throw new HttpError(500, "workflow_not_configured", "LEAD_RUN_WORKFLOW is not bound.");
  }

  const started = await updateRunStatus(c.env.DB, run.id, "discovering");
  if (!started) throw new HttpError(404, "not_found", "Run not found.");
  try {
    await workflow.create({ params: { runId: run.id } });
  } catch (error) {
    await updateRunStatus(c.env.DB, run.id, "failed");
    throw new HttpError(
      502,
      "workflow_start_failed",
      error instanceof Error ? error.message : "Could not start the discovery workflow.",
    );
  }
  await insertEvent(c.env.DB, {
    runId: run.id,
    eventType: "run_started",
    actorEmail: c.get("actor").email,
    payload: { area: run.areaText },
  });
  return c.json({ run: started } satisfies RunResponse, 202);
});
