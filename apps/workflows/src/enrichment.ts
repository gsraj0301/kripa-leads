import {
  createDohResolver,
  enrichProspect,
  extractPageWithHtmlRewriter,
  type EnrichmentConfig,
  type EnrichmentOutcome,
  type Prospect,
  type RunCounts,
} from "@kripa/shared";
import {
  listProspectsForEnrichment,
  summarizeEnrichment,
  updateProspectEnrichments,
  type ProspectEnrichmentUpdate,
} from "@kripa/db";

export interface EnrichmentEnv {
  DB: D1Database;
}

export interface EnrichmentBatchResult {
  processed: number;
  done: boolean;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T);
      }
    }),
  );

  return results;
}

function failedOutcome(website: string, error: unknown): EnrichmentOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const fetchedAt = new Date().toISOString();
  return {
    status: "enriched",
    facts: {
      websiteUrl: website,
      websiteReachable: false,
      websiteFinalUrl: null,
      websiteStatus: null,
      websiteHttps: null,
      websiteEmails: [],
      websitePhones: [],
      websiteSocialLinks: [],
      websiteHasContactForm: false,
      websiteCopyrightYear: null,
      websitePagesFetched: 0,
      websiteTextChars: 0,
      websiteUsableText: false,
      websiteErrors: [{ url: website, error: message }],
      websiteRobotsBlocked: false,
    },
    provenance: {
      websiteReachable: {
        source: "website",
        source_url: website,
        retrieved_at: fetchedAt,
        kind: "verified",
      },
    },
    enrichment: {
      version: 1,
      fetchedAt,
      usableText: "",
      textChars: 0,
      usable: false,
      pages: [],
      pagesFetched: 0,
      failed: true,
      robotsBlocked: false,
      errors: [{ url: website, error: message }],
    },
    stats: { pagesFetched: 0, failures: 1, robotsBlocked: 0, usableChars: 0 },
  };
}

function enrichmentDeps() {
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, init)) as typeof fetch;
  return {
    fetchImpl,
    resolveHost: createDohResolver(fetchImpl),
    extract: (html: string, url: string) => extractPageWithHtmlRewriter(html, url),
    now: () => new Date(),
  };
}

export async function enrichBatch(
  env: EnrichmentEnv,
  runId: string,
  config: EnrichmentConfig,
  limit = 20,
): Promise<EnrichmentBatchResult> {
  const prospects = await listProspectsForEnrichment(env.DB, runId, limit);
  if (prospects.length === 0) return { processed: 0, done: true };

  const deps = enrichmentDeps();
  const outcomes = await mapLimit<Prospect, EnrichmentOutcome>(
    prospects,
    config.maxConcurrency,
    async (prospect) => {
      const website = prospect.website?.trim();
      if (!website) return failedOutcome("", new Error("Prospect has no website."));
      try {
        return await enrichProspect(website, config, deps);
      } catch (error) {
        return failedOutcome(website, error);
      }
    },
  );

  const updates: ProspectEnrichmentUpdate[] = prospects.map((prospect, index) => {
    const outcome = outcomes[index] as EnrichmentOutcome;
    return {
      id: prospect.id,
      facts: { ...prospect.facts, ...outcome.facts },
      provenance: { ...prospect.provenance, ...outcome.provenance },
      enrichment: outcome.enrichment,
      status: "enriched",
    };
  });

  await updateProspectEnrichments(env.DB, updates);
  return { processed: updates.length, done: prospects.length < limit };
}

export async function finalizeEnrichmentCounts(
  env: EnrichmentEnv,
  runId: string,
  base: RunCounts,
): Promise<RunCounts> {
  const summary = await summarizeEnrichment(env.DB, runId);
  return {
    ...base,
    enriched: summary.enriched,
    enrichmentFailures: summary.failures,
    pagesFetched: summary.pagesFetched,
    skippedNoWebsite: summary.skippedNoWebsite,
    robotsBlocked: summary.robotsBlocked,
  };
}
