import { describe, expect, it } from "vitest";
import {
  CreditBudgetError,
  GeoapifyClient,
  candidateFromProperties,
  creditsForPlaces,
  dedupeCandidates,
  estimateDiscoveryCredits,
  isValidCandidate,
  normalizeCompanyKey,
  websiteDomain,
} from "@kripa/shared";

function candidate(placeId: string, overrides: Record<string, unknown> = {}) {
  return candidateFromProperties(
    {
      place_id: placeId,
      name: `Business ${placeId}`,
      formatted: "1 Test Street, Chennai",
      city: "Chennai",
      ...overrides,
    },
    null,
    "office.company",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("company identity", () => {
  it("normalizes websites and prefers domains over phones and names", () => {
    expect(websiteDomain("https://www.Example.com/about")).toBe("example.com");
    expect(
      normalizeCompanyKey({
        placeId: "p1",
        name: "Example",
        city: "Chennai",
        website: "http://www.example.com",
        phone: "+91 44 1234 5678",
      }),
    ).toBe("domain:example.com");
    expect(
      normalizeCompanyKey({
        placeId: "p2",
        name: "Example",
        city: "Chennai",
        website: null,
        phone: "+91 44 1234 5678",
      }),
    ).toBe("phone:914412345678");
  });

  it("dedupes by place id and company key", () => {
    const result = dedupeCandidates([
      candidate("p1", { website: "https://one.example" }),
      candidate("p1", { website: "https://one.example" }),
      candidate("p2", { website: "https://two.example" }),
      candidate("p3", { website: "https://two.example" }),
    ]);
    expect(result.candidates).toHaveLength(2);
    expect(result.duplicatePlaceIds).toBe(1);
    expect(result.duplicateCompanyKeys).toBe(1);
  });

  it("requires a name and one contact channel to be valid", () => {
    expect(isValidCandidate(candidate("p1"))).toBe(false);
    expect(isValidCandidate(candidate("p1", { phone: "+91 44 1234 5678" }))).toBe(true);
    expect(isValidCandidate(candidate("p1", { website: "example.com" }))).toBe(true);
  });
});

describe("credit estimates", () => {
  it("counts places in batches of twenty plus one detail per result", () => {
    expect(creditsForPlaces(0)).toBe(1);
    expect(creditsForPlaces(20)).toBe(1);
    expect(creditsForPlaces(21)).toBe(2);
    expect(estimateDiscoveryCredits(3, 500)).toEqual({
      geocode: 1,
      places: 75,
      details: 1500,
      total: 1576,
    });
  });
});

describe("GeoapifyClient", () => {
  it("parses geocode candidates", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        features: [
          {
            properties: {
              place_id: "place-1",
              formatted: "Chennai, Tamil Nadu, India",
              result_type: "city",
              city: "Chennai",
              state: "Tamil Nadu",
              country: "India",
              country_code: "in",
              lat: 13.08,
              lon: 80.27,
              rank: { confidence: 0.95 },
            },
          },
        ],
      })) as typeof fetch;

    const client = new GeoapifyClient({
      apiKey: "test-key",
      fetchImpl,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const candidates = await client.geocode("Chennai");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.placeId).toBe("place-1");
    expect(candidates[0]?.confidence).toBe(0.95);
    expect(client.creditsUsed).toBe(1);
  });

  it("pages places and stops at the requested maximum", async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("categories")).toBe("office.company");
      calls += 1;
      const offset = Number(url.searchParams.get("offset"));
      const base = offset;
      return jsonResponse({
        features: [0, 1, 2, 3].map((index) => ({
          properties: { place_id: `place-${base + index}`, name: `Business ${base + index}` },
        })),
      });
    }) as typeof fetch;

    const client = new GeoapifyClient({
      apiKey: "test-key",
      fetchImpl,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const places = await client.searchPlaces("office.company", "place-1", 4);
    expect(places).toHaveLength(4);
    expect(calls).toBe(1);
    expect(client.creditsUsed).toBe(1);
  });

  it("refuses a request that would exceed the credit limit", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ features: [] })) as typeof fetch;
    const client = new GeoapifyClient({
      apiKey: "test-key",
      fetchImpl,
      minIntervalMs: 0,
      creditLimit: 1,
      sleep: async () => {},
    });
    await client.geocode("Chennai");
    await expect(client.geocode("Mumbai")).rejects.toBeInstanceOf(CreditBudgetError);
  });
});
