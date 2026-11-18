export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  AUTH_DEV_BYPASS?: string;
  DEV_ACTOR_EMAIL?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  GEOAPIFY_API_KEY?: string;
  GROQ_API_KEY?: string;
  LEAD_RUN_WORKFLOW?: Workflow<{ runId: string }>;
}

export interface Actor {
  email: string;
  mode: "access" | "dev";
}

export interface Variables {
  actor: Actor;
  requestId: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};

export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

export function normalizeTeamDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function readAccessConfig(env: Env): AccessConfig | null {
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN ?? "");
  const audience = (env.CF_ACCESS_AUD ?? "").trim();
  if (!teamDomain || !audience) return null;
  return { teamDomain, audience };
}

export function isDevBypass(env: Env): boolean {
  return env.ENVIRONMENT === "development" && env.AUTH_DEV_BYPASS === "true";
}
