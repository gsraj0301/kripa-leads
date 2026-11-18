import { z } from "zod";

type JsonRecord = Record<string, unknown>;

export const GeocodeCandidateSchema = z.object({
  placeId: z.string().min(1),
  label: z.string().min(1),
  resultType: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  postcode: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  confidence: z.number().nullable(),
});

export const GeocodeResponseSchema = z.object({
  candidates: z.array(GeocodeCandidateSchema),
  creditsUsed: z.number().int().min(0),
});

export type GeocodeCandidate = z.infer<typeof GeocodeCandidateSchema>;
export type GeocodeResponse = z.infer<typeof GeocodeResponseSchema>;

export interface DiscoveryCandidate {
  placeId: string;
  category: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  raw: {
    place: JsonRecord;
    details: JsonRecord | null;
  };
}

export interface DedupeResult {
  candidates: DiscoveryCandidate[];
  duplicatePlaceIds: number;
  duplicateCompanyKeys: number;
}

export interface CreditEstimate {
  geocode: number;
  places: number;
  details: number;
  total: number;
}

export class GeoapifyError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "GeoapifyError";
  }
}

export class CreditBudgetError extends Error {
  constructor(readonly creditsUsed: number, readonly limit: number) {
    super(`Geoapify credit budget exceeded: ${creditsUsed}/${limit}.`);
    this.name = "CreditBudgetError";
  }
}

export interface GeoapifyClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  timeoutMs?: number;
  creditLimit?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const GEOAPIFY_BASE = "https://api.geoapify.com";
const PAGE_SIZE = 500;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function propertiesOf(data: JsonRecord): JsonRecord[] {
  const features = Array.isArray(data.features) ? data.features : [];
  const out: JsonRecord[] = [];
  for (const feature of features) {
    const record = asRecord(feature);
    const properties = record ? asRecord(record.properties) : null;
    if (properties) out.push(properties);
  }
  return out;
}

export function normalizeWebsite(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function websiteDomain(value: unknown): string | null {
  const website = normalizeWebsite(value);
  if (!website) return null;
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function phoneDigits(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 7 ? digits : null;
}

function normalizedName(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || null;
}

export function normalizeCompanyKey(input: {
  placeId: string;
  name: string | null;
  city: string | null;
  website: string | null;
  phone: string | null;
}): string {
  const domain = websiteDomain(input.website);
  if (domain) return `domain:${domain}`;
  const phone = phoneDigits(input.phone);
  if (phone) return `phone:${phone}`;
  const name = normalizedName(input.name);
  if (name) {
    const city = normalizedName(input.city);
    return `name:${name}|${city ?? ""}`;
  }
  return `place:${input.placeId}`;
}

function contactOf(properties: JsonRecord): { phone: string | null; email: string | null } {
  const contact = asRecord(properties.contact);
  if (!contact) return { phone: null, email: null };
  const phone = asString(contact.phone) ?? asString(contact.phone_other);
  const email = asString(contact.email) ?? asString(contact.email_other);
  return { phone, email };
}

export function candidateFromProperties(
  place: JsonRecord,
  details: JsonRecord | null,
  category: string,
): DiscoveryCandidate {
  const merged = details ? { ...place, ...details } : place;
  const placeContact = contactOf(place);
  const detailsContact = details ? contactOf(details) : { phone: null, email: null };
  const placeId = asString(merged.place_id) ?? "";
  return {
    placeId,
    category,
    name: asString(merged.name),
    address: asString(merged.formatted) ?? asString(merged.address_line1),
    city: asString(merged.city),
    state: asString(merged.state),
    postcode: asString(merged.postcode),
    website: normalizeWebsite(merged.website),
    phone: detailsContact.phone ?? placeContact.phone ?? asString(merged.phone),
    email: detailsContact.email ?? placeContact.email ?? asString(merged.email),
    latitude: asNumber(place.lat) ?? asNumber(merged.lat),
    longitude: asNumber(place.lon) ?? asNumber(merged.lon),
    raw: { place, details },
  };
}

export function isValidCandidate(candidate: DiscoveryCandidate): boolean {
  if (!candidate.name?.trim()) return false;
  return Boolean(candidate.phone || candidate.website || candidate.email);
}

export function dedupeCandidates(candidates: DiscoveryCandidate[]): DedupeResult {
  const byPlace = new Map<string, DiscoveryCandidate>();
  let duplicatePlaceIds = 0;
  for (const candidate of candidates) {
    if (!candidate.placeId) continue;
    if (byPlace.has(candidate.placeId)) {
      duplicatePlaceIds += 1;
      continue;
    }
    byPlace.set(candidate.placeId, candidate);
  }

  const byCompany = new Map<string, DiscoveryCandidate>();
  let duplicateCompanyKeys = 0;
  for (const candidate of byPlace.values()) {
    const key = normalizeCompanyKey(candidate);
    if (byCompany.has(key)) {
      duplicateCompanyKeys += 1;
      continue;
    }
    byCompany.set(key, candidate);
  }

  return {
    candidates: [...byCompany.values()],
    duplicatePlaceIds,
    duplicateCompanyKeys,
  };
}

export function companyKeyOf(candidate: DiscoveryCandidate): string {
  return normalizeCompanyKey(candidate);
}

export function creditsForPlaces(resultCount: number): number {
  return Math.max(1, Math.ceil(resultCount / 20));
}

export function estimateDiscoveryCredits(
  categoryCount: number,
  maxResultsPerCategory: number,
): CreditEstimate {
  const categories = Math.max(0, categoryCount);
  const maxResults = Math.max(1, maxResultsPerCategory);
  const places = categories * creditsForPlaces(maxResults);
  const details = categories * maxResults;
  const geocode = 1;
  return { geocode, places, details, total: geocode + places + details };
}

export class GeoapifyClient {
  creditsUsed = 0;
  requests = 0;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly creditLimit: number | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastRequestAt = 0;

  constructor(options: GeoapifyClientOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("Geoapify API key is missing.");
    this.fetchImpl =
      options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 300);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);
    this.creditLimit = options.creditLimit ?? null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private assertBudget(cost: number): void {
    if (this.creditLimit !== null && this.creditsUsed + cost > this.creditLimit) {
      throw new CreditBudgetError(this.creditsUsed + cost, this.creditLimit);
    }
  }

  private addCredits(cost: number): void {
    this.creditsUsed += cost;
    if (this.creditLimit !== null && this.creditsUsed > this.creditLimit) {
      throw new CreditBudgetError(this.creditsUsed, this.creditLimit);
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const elapsed = this.now() - this.lastRequestAt;
    const remaining = this.minIntervalMs - elapsed;
    if (this.lastRequestAt > 0 && remaining > 0) await this.sleep(remaining);
    this.lastRequestAt = this.now();
  }

  private async requestJson(path: string, params: Record<string, string>): Promise<JsonRecord> {
    const url = new URL(path, GEOAPIFY_BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apiKey", this.apiKey);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.waitForRateLimit();
      this.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), {
          headers: {
            accept: "application/json",
            "user-agent": "KripaLeads/0.1 (internal lead research)",
          },
          signal: controller.signal,
        });
        const text = await response.text();
        if (response.status === 429 || response.status >= 500) {
          lastError = new GeoapifyError(
            `Geoapify returned HTTP ${response.status}.`,
            response.status,
          );
          if (attempt < 3) {
            const retryAfter = Number(response.headers.get("retry-after") ?? 0);
            await this.sleep(Math.max(500, retryAfter * 1000) * attempt);
            continue;
          }
          throw lastError;
        }
        if (!response.ok) {
          throw new GeoapifyError(`Geoapify returned HTTP ${response.status}.`, response.status);
        }
        const parsed: unknown = JSON.parse(text);
        const record = asRecord(parsed);
        if (!record) throw new GeoapifyError("Geoapify returned a non-object response.");
        return record;
      } catch (error) {
        if (error instanceof GeoapifyError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 3) {
          await this.sleep(500 * attempt);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new GeoapifyError("Geoapify request failed.");
  }

  async geocode(
    text: string,
    options: { countryCode?: string | null; limit?: number } = {},
  ): Promise<GeocodeCandidate[]> {
    this.assertBudget(1);
    const params: Record<string, string> = {
      text,
      limit: String(Math.max(1, Math.min(10, options.limit ?? 5))),
      lang: "en",
    };
    if (options.countryCode) params.filter = `countrycode:${options.countryCode}`;
    const data = await this.requestJson("/v1/geocode/search", params);
    this.addCredits(1);
    const candidates: GeocodeCandidate[] = [];
    for (const properties of propertiesOf(data)) {
      const placeId = asString(properties.place_id);
      const label = asString(properties.formatted);
      if (!placeId || !label) continue;
      const rank = asRecord(properties.rank);
      candidates.push({
        placeId,
        label,
        resultType: asString(properties.result_type),
        city: asString(properties.city),
        state: asString(properties.state),
        country: asString(properties.country),
        countryCode: asString(properties.country_code),
        postcode: asString(properties.postcode),
        lat: asNumber(properties.lat),
        lon: asNumber(properties.lon),
        confidence: rank ? asNumber(rank.confidence) : null,
      });
    }
    return candidates;
  }

  async searchPlaces(
    category: string,
    placeId: string,
    maxResults: number,
  ): Promise<JsonRecord[]> {
    const limit = Math.max(1, Math.min(PAGE_SIZE, maxResults));
    const collected: JsonRecord[] = [];
    const seen = new Set<string>();
    const maxPages = Math.max(1, Math.ceil(maxResults / limit) + 2);

    for (let page = 0; page < maxPages && collected.length < maxResults; page += 1) {
      this.assertBudget(creditsForPlaces(limit));
      const data = await this.requestJson("/v2/places", {
        categories: category,
        filter: `place:${placeId}`,
        limit: String(limit),
        offset: String(page * limit),
        lang: "en",
      });
      const properties = propertiesOf(data);
      this.addCredits(creditsForPlaces(properties.length));
      if (properties.length === 0) break;

      let added = 0;
      for (const place of properties) {
        const id = asString(place.place_id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        collected.push(place);
        added += 1;
        if (collected.length >= maxResults) break;
      }
      if (added === 0 || properties.length < limit) break;
    }
    return collected;
  }

  async placeDetails(placeId: string): Promise<JsonRecord> {
    this.assertBudget(1);
    const data = await this.requestJson("/v2/place-details", { id: placeId, lang: "en" });
    this.addCredits(1);
    return propertiesOf(data)[0] ?? {};
  }
}
