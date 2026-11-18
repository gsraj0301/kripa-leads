import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { formatZodError, isZodError, type HealthResponse } from "@kripa/shared";
import { requireActor } from "./auth";
import { HttpError } from "./http";
import type { AppEnv } from "./env";
import { metaRoutes } from "./routes/meta";
import { runRoutes } from "./routes/runs";
import { settingsRoutes } from "./routes/settings";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.trim() || crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.header("x-request-id", requestId);
  });

  const api = new Hono<AppEnv>();

  api.get("/health", async (c) => {
    let ok = false;
    try {
      const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      ok = row?.ok === 1;
    } catch {
      ok = false;
    }
    const body: HealthResponse = {
      ok,
      service: "leads-kripa",
      environment: c.env.ENVIRONMENT ?? "unknown",
      now: new Date().toISOString(),
    };
    return c.json(body, ok ? 200 : 503);
  });

  api.use("/me", requireActor);
  api.use("/segments", requireActor);
  api.use("/settings", requireActor);
  api.use("/settings/*", requireActor);
  api.use("/geocode", requireActor);
  api.use("/runs", requireActor);
  api.use("/runs/*", requireActor);

  api.route("/", metaRoutes);
  api.route("/settings", settingsRoutes);
  api.route("/", runRoutes);

  api.all("*", (c) => {
    return c.json(
      {
        error: {
          code: "not_found",
          message: "API route not found.",
          requestId: c.get("requestId"),
        },
      },
      404,
    );
  });

  app.route("/api", api);

  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: "API route not found.",
            requestId: c.get("requestId"),
          },
        },
        404,
      );
    }

    if (!c.env.ASSETS) return c.text("Not found", 404);
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status !== 404) return asset;

    const acceptsHtml = (c.req.header("accept") ?? "").includes("text/html");
    if (!acceptsHtml || (c.req.method !== "GET" && c.req.method !== "HEAD")) {
      return c.text("Not found", 404);
    }

    const indexUrl = new URL("/index.html", c.req.url);
    return c.env.ASSETS.fetch(
      new Request(indexUrl.toString(), { method: "GET", headers: c.req.raw.headers }),
    );
  });

  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);

    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code, message: err.message, requestId } },
        err.status as ContentfulStatusCode,
      );
    }

    if (isZodError(err)) {
      return c.json(
        { error: { code: "invalid_request", message: formatZodError(err), requestId } },
        400,
      );
    }

    console.error("unhandled_error", requestId, err);
    return c.json(
      { error: { code: "internal_error", message: "Unexpected error.", requestId } },
      500,
    );
  });

  return app;
}
