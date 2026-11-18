import {
  CreditBudgetError,
  GeoapifyClient,
  GeoapifyError,
  candidateFromProperties,
  companyKeyOf,
  dedupeCandidates,
  isValidCandidate,
  type DiscoveryCandidate,
  type RunCounts,
  type Segment,
} from "@kripa/shared";
import {
  ensureSettings,
  getCreditsUsedOnDate,
  getDeliveredCompanyKeys,
  getRun,
  insertEvent,
  insertProspects,
  updateRunStatus,
  type ProspectInsert,
} from "@kripa/db";

export interface DiscoveryEnv {
  DB: D1Database;
  GEOAPIFY_API_KEY?: string;
}

export interface DiscoveryOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface DiscoveryResult extends RunCounts {
  detailsFailures: number;
}

function selectedSegments(runSegmentsSnapshot: unknown, settingsSegments: Segment[]): Segment[] {
  if (
    runSegmentsSnapshot &&
    typeof runSegmentsSnapshot === "object" &&
    Array.isArray((runSegmentsSnapshot as { segments?: unknown }).segments)
  ) {
    return (runSegmentsSnapshot as { segments: Segment[] }).segments;
  }
  return settingsSegments;
}

function provenanceFor(candidate: DiscoveryCandidate, retrievedAt: string) {
  const sourceUrl = `https://api.geoapify.com/v2/place-details?id=${encodeURIComponent(candidate.placeId)}`;
  const entry = (kind: "verified" = "verified") => ({
    source: "geoapify",
    source_url: sourceUrl,
    retrieved_at: retrievedAt,
    kind,
  });
  const provenance: Record<string, unknown> = {};
  if (candidate.name) provenance.name = entry();
  if (candidate.address) provenance.address = entry();
  if (candidate.city) provenance.city = entry();
  if (candidate.state) provenance.state = entry();
  if (candidate.postcode) provenance.postcode = entry();
  if (candidate.website) provenance.website = entry();
  if (candidate.phone) provenance.phone = entry();
  if (candidate.email) provenance.email = entry();
  if (candidate.latitude !== null) provenance.latitude = entry();
  if (candidate.longitude !== null) provenance.longitude = entry();
  return provenance;
}

function factsFor(candidate: DiscoveryCandidate): Record<string, unknown> {
  const place = candidate.raw.place;
  return {
    placeId: candidate.placeId,
    category: candidate.category,
    categories: place.categories ?? null,
    openingHours: place.opening_hours ?? null,
    brand: place.brand ?? null,
    operator: place.operator ?? null,
  };
}

export async function discoverRun(
  env: DiscoveryEnv,
  runId: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const run = await getRun(env.DB, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  if (!run.resolvedPlaceId) throw new Error("Run has no resolved area place id.");

  const apiKey = env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) throw new Error("GEOAPIFY_API_KEY is not configured.");

  const settings = await ensureSettings(env.DB);
  const segments = selectedSegments(run.segmentsSnapshot, settings.segments).filter(
    (segment) => run.segmentIds.includes(segment.id) && segment.enabled,
  );
  if (segments.length === 0) throw new Error("No enabled segment selected for this run.");

  const categoryToSegment = new Map<string, string>();
  for (const segment of segments) {
    for (const category of segment.categories) {
      if (!categoryToSegment.has(category)) categoryToSegment.set(category, segment.id);
    }
  }
  const categories = [...categoryToSegment.keys()];

  const now = options.now ?? (() => new Date());
  const today = now().toISOString().slice(0, 10);
  const priorCredits = await getCreditsUsedOnDate(env.DB, today);
  const remaining = settings.discovery.dailyCreditBudget - priorCredits;
  if (remaining <= 0) {
    throw new Error(
      `Daily Geoapify budget is exhausted: ${priorCredits}/${settings.discovery.dailyCreditBudget} credits used.`,
    );
  }

  const client = new GeoapifyClient({
    apiKey,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    now: options.now ? () => options.now!().getTime() : undefined,
    minIntervalMs: settings.discovery.minIntervalMs,
    creditLimit: remaining,
  });

  const places = new Map<string, { properties: Record<string, unknown>; category: string }>();
  const detailsFailures: string[] = [];

  for (const category of categories) {
    const found = await client.searchPlaces(
      category,
      run.resolvedPlaceId,
      settings.discovery.maxResultsPerCategory,
    );
    for (const properties of found) {
      const placeId =
        typeof properties.place_id === "string" ? properties.place_id.trim() : "";
      if (!placeId || places.has(placeId)) continue;
      places.set(placeId, { properties, category });
    }
  }

  const candidates: DiscoveryCandidate[] = [];
  for (const { properties, category } of places.values()) {
    const placeId = String(properties.place_id);
    let details: Record<string, unknown> | null = null;
    try {
      details = await client.placeDetails(placeId);
    } catch (error) {
      if (error instanceof CreditBudgetError) throw error;
      if (error instanceof GeoapifyError && error.status === 404) {
        detailsFailures.push(`${placeId}: not found`);
      } else {
        detailsFailures.push(`${placeId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    candidates.push(candidateFromProperties(properties, details, category));
  }

  const deduped = dedupeCandidates(candidates);
  const keys = deduped.candidates.map(companyKeyOf);
  const delivered = run.includePreviouslyDelivered
    ? new Set<string>()
    : await getDeliveredCompanyKeys(env.DB, keys);

  const kept = deduped.candidates.filter((candidate) => !delivered.has(companyKeyOf(candidate)));
  const droppedDelivered = deduped.candidates.length - kept.length;
  const retrievedAt = now().toISOString();

  const inserts: ProspectInsert[] = [];
  let valid = 0;
  let invalid = 0;

  for (const candidate of kept) {
    if (!candidate.name?.trim()) {
      invalid += 1;
      continue;
    }
    const segmentId = categoryToSegment.get(candidate.category);
    if (!segmentId) continue;
    const hasChannel = isValidCandidate(candidate);
    if (hasChannel) valid += 1;
    else invalid += 1;

    inserts.push({
      runId,
      segmentId,
      source: "geoapify",
      sourceId: candidate.placeId,
      category: candidate.category,
      companyKey: companyKeyOf(candidate),
      name: candidate.name,
      website: candidate.website,
      phone: candidate.phone,
      email: candidate.email,
      address: candidate.address,
      city: candidate.city,
      state: candidate.state,
      postcode: candidate.postcode,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      facts: factsFor(candidate),
      raw: candidate.raw,
      provenance: provenanceFor(candidate, retrievedAt),
      status: hasChannel ? "valid" : "raw",
    });
  }

  for (let start = 0; start < inserts.length; start += 50) {
    await insertProspects(env.DB, inserts.slice(start, start + 50));
  }

  const counts: RunCounts = {
    raw: kept.length,
    valid,
    enriched: 0,
    scored: 0,
    notScored: 0,
    belowFloor: 0,
    exported: 0,
    creditsUsed: client.creditsUsed,
    tokensUsed: 0,
    quoteFailures: 0,
    droppedDelivered,
    invalid,
    duplicatePlaceIds: deduped.duplicatePlaceIds,
    duplicateCompanyKeys: deduped.duplicateCompanyKeys,
  };

  await updateRunStatus(env.DB, runId, "completed", counts);
  await insertEvent(env.DB, {
    runId,
    eventType: "run_discovered",
    payload: {
      ...counts,
      requests: client.requests,
      categories,
      detailsFailures: detailsFailures.slice(0, 20),
    },
  });

  return { ...counts, detailsFailures: detailsFailures.length };
}
