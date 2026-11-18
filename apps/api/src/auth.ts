import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import { HttpError } from "./http";
import { isDevBypass, readAccessConfig, type AppEnv } from "./env";

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteKeySet(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteKeySets.get(teamDomain);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  remoteKeySets.set(teamDomain, created);
  return created;
}

export interface VerifyOptions {
  teamDomain: string;
  audience: string;
  keySet?: JWTVerifyGetKey;
}

export async function verifyAccessJwt(token: string, options: VerifyOptions) {
  const keySet = options.keySet ?? remoteKeySet(options.teamDomain);
  const { payload } = await jwtVerify(token, keySet, {
    issuer: options.teamDomain,
    audience: options.audience,
  });
  return payload;
}

export const requireActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;

  if (env.AUTH_DEV_BYPASS === "true" && env.ENVIRONMENT !== "development") {
    throw new HttpError(
      500,
      "auth_misconfigured",
      "AUTH_DEV_BYPASS is only allowed when ENVIRONMENT=development.",
    );
  }

  if (isDevBypass(env)) {
    c.set("actor", {
      email: env.DEV_ACTOR_EMAIL?.trim() || "dev@kripa.local",
      mode: "dev",
    });
    await next();
    return;
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    throw new HttpError(401, "unauthenticated", "Missing Cloudflare Access token.");
  }

  const access = readAccessConfig(env);
  if (!access) {
    throw new HttpError(500, "auth_misconfigured", "Cloudflare Access is not configured.");
  }

  let payload;
  try {
    payload = await verifyAccessJwt(token, access);
  } catch {
    throw new HttpError(401, "unauthenticated", "Invalid or expired Cloudflare Access token.");
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) {
    throw new HttpError(401, "unauthenticated", "Access token does not contain an email.");
  }

  c.set("actor", { email, mode: "access" });
  await next();
};
