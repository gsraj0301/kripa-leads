import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/auth";

const TEAM_DOMAIN = "https://team.example.com";
const AUDIENCE = "test-aud-tag";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
const keySet = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] });

async function signToken(options: {
  audience?: string;
  issuer?: string;
  expiresAt?: number;
  email?: string;
}) {
  return new SignJWT({ email: options.email ?? "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? TEAM_DOMAIN)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? "5m")
    .sign(privateKey);
}

describe("verifyAccessJwt", () => {
  it("accepts a valid Access token and returns the email claim", async () => {
    const token = await signToken({ email: "valid@example.com" });
    const payload = await verifyAccessJwt(token, {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      keySet,
    });
    expect(payload.email).toBe("valid@example.com");
  });

  it("rejects a token for another audience", async () => {
    const token = await signToken({ audience: "someone-else" });
    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, keySet }),
    ).rejects.toThrow();
  });

  it("rejects a token for another issuer", async () => {
    const token = await signToken({ issuer: "https://evil.example.com" });
    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, keySet }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await signToken({
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: AUDIENCE, keySet }),
    ).rejects.toThrow();
  });
});
