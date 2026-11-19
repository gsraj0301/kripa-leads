import { normalizeWebsite } from "../discovery";
import type { EnrichmentConfig } from "../settings";
import { isUsableText, mergeExtractions, pickContactPages } from "./html";
import { extractPageWithHtmlRewriter } from "./html-rewriter";
import { createRobotsLoader, isAllowedByRobots } from "./robots";
import {
  createDohResolver,
  fetchPublicUrl,
  SsrfError,
} from "./ssrf";
import type {
  EnrichmentDeps,
  EnrichmentOutcome,
  EnrichmentStats,
  PageRecord,
  PageResult,
  RobotsResult,
} from "./types";

interface PageContext {
  config: EnrichmentConfig;
  deps: Required<Pick<EnrichmentDeps, "fetchImpl" | "resolveHost" | "extract">> & {
    now: () => Date;
  };
  loadRobots: (origin: string) => Promise<RobotsResult>;
  deadline: number;
}

function remainingMs(ctx: PageContext): number {
  return ctx.deadline - ctx.deps.now().getTime();
}

function provenanceEntry(sourceUrl: string | null, retrievedAt: string) {
  return {
    source: "website",
    source_url: sourceUrl,
    retrieved_at: retrievedAt,
    kind: "verified" as const,
  };
}

async function fetchPage(url: string, ctx: PageContext): Promise<PageResult> {
  const fetchedAt = ctx.deps.now().toISOString();
  const parsed = new URL(url);
  const baseRecord: PageRecord = {
    url,
    finalUrl: null,
    status: null,
    ok: false,
    https: parsed.protocol === "https:",
    contentType: null,
    fetchedAt,
    chars: 0,
    robotsAllowed: true,
    redirects: 0,
    error: null,
  };

  if (ctx.config.respectRobots) {
    const robots = await ctx.loadRobots(parsed.origin);
    if (!isAllowedByRobots(robots, parsed, ctx.config.userAgent)) {
      return {
        record: { ...baseRecord, robotsAllowed: false },
        extraction: null,
      };
    }
  }

  const budget = remainingMs(ctx);
  if (budget <= 500) {
    return {
      record: { ...baseRecord, error: "Prospect time budget exhausted before page fetch." },
      extraction: null,
    };
  }

  try {
    const result = await fetchPublicUrl(
      parsed,
      {
        maxRedirects: ctx.config.maxRedirects,
        timeoutMs: Math.min(ctx.config.pageTimeoutMs, budget),
        headers: { "user-agent": ctx.config.userAgent },
        readBody: true,
        maxBodyBytes: ctx.config.maxHtmlBytes,
      },
      { fetchImpl: ctx.deps.fetchImpl, resolveHost: ctx.deps.resolveHost },
    );

    const contentType = result.response.headers.get("content-type");
    const isHtml =
      contentType === null ||
      contentType.toLowerCase().includes("text/html") ||
      contentType.toLowerCase().includes("application/xhtml");

    const record: PageRecord = {
      ...baseRecord,
      finalUrl: result.finalUrl.toString(),
      status: result.response.status,
      ok: result.response.ok,
      https: result.finalUrl.protocol === "https:",
      contentType,
      chars: result.text?.length ?? 0,
      redirects: result.redirects,
    };

    if (!result.response.ok || !isHtml || result.text === null) {
      return {
        record: {
          ...record,
          error: !result.response.ok
            ? `HTTP ${result.response.status}`
            : !isHtml
              ? `Unsupported content type ${contentType}`
              : null,
        },
        extraction: null,
      };
    }

    const extraction = await ctx.deps.extract(result.text, result.finalUrl.toString());
    return { record, extraction };
  } catch (error) {
    const message =
      error instanceof SsrfError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      record: { ...baseRecord, error: message },
      extraction: null,
    };
  }
}

export async function enrichProspect(
  website: string,
  config: EnrichmentConfig,
  deps: EnrichmentDeps,
): Promise<EnrichmentOutcome> {
  const websiteUrl = normalizeWebsite(website);
  if (!websiteUrl) {
    throw new Error(`Invalid website URL: ${website}`);
  }

  const fetchImpl = deps.fetchImpl;
  const resolveHost = deps.resolveHost;
  const now = deps.now ?? (() => new Date());
  const extract = deps.extract;
  const startedAt = now().getTime();
  const ctx: PageContext = {
    config,
    deps: { fetchImpl, resolveHost, extract, now },
    loadRobots:
      deps.loadRobots ??
      createRobotsLoader({
        fetchImpl,
        resolveHost,
        timeoutMs: Math.min(config.pageTimeoutMs, 5_000),
        ttlSeconds: config.robotsCacheTtlSeconds,
        userAgent: config.userAgent,
        maxRedirects: Math.min(config.maxRedirects, 3),
      }),
    deadline: startedAt + config.prospectBudgetMs,
  };

  const pages: PageResult[] = [];
  const homepage = await fetchPage(websiteUrl, ctx);
  pages.push(homepage);
  const homepageFailed = !homepage.record.ok && homepage.record.robotsAllowed;

  const extraPages = homepage.extraction
    ? pickContactPages(
        homepage.record.finalUrl ?? websiteUrl,
        homepage.extraction.links,
        config.maxPagesPerProspect - 1,
      )
    : [];

  for (const pageUrl of extraPages) {
    if (remainingMs(ctx) <= 500) break;
    const page = await fetchPage(pageUrl, ctx);
    pages.push(page);
  }

  const extractions = pages
    .map((page) => page.extraction)
    .filter((extraction): extraction is NonNullable<typeof extraction> => extraction !== null);
  const merged = mergeExtractions(extractions, config.totalTextChars, now());

  const fetchedAt = now().toISOString();
  const homepageRecord = pages[0]?.record;
  const finalUrl = homepageRecord?.finalUrl ?? websiteUrl;
  const robotsBlocked = pages.some((page) => !page.record.robotsAllowed);
  const errors = pages
    .filter((page) => page.record.error !== null)
    .map((page) => ({ url: page.record.url, error: page.record.error }));
  const pagesFetched = pages.filter(
    (page) => page.record.robotsAllowed && page.record.status !== null,
  ).length;
  const usable = isUsableText(merged.text, config.minUsableTextChars);

  const facts: Record<string, unknown> = {
    websiteUrl,
    websiteFinalUrl: homepageRecord?.finalUrl ?? null,
    websiteStatus: homepageRecord?.status ?? null,
    websiteHttps: homepageRecord?.https ?? null,
    websiteReachable: Boolean(homepageRecord?.ok),
    websiteContentType: homepageRecord?.contentType ?? null,
    websiteFetchedAt: fetchedAt,
    websitePagesFetched: pagesFetched,
    websiteTextChars: merged.text.length,
    websiteUsableText: usable,
    websiteEmails: merged.emails,
    websitePhones: merged.phones,
    websiteSocialLinks: merged.socialLinks,
    websiteHasContactForm: merged.hasContactForm,
    websiteCopyrightYear: merged.copyrightYear,
    websiteTitle: merged.title,
    websiteDescription: merged.description,
    websiteErrors: errors,
    websiteRobotsBlocked: robotsBlocked,
  };

  const provenance: Record<string, unknown> = {
    websiteStatus: provenanceEntry(finalUrl, fetchedAt),
    websiteHttps: provenanceEntry(finalUrl, fetchedAt),
    websiteReachable: provenanceEntry(finalUrl, fetchedAt),
    websitePagesFetched: provenanceEntry(finalUrl, fetchedAt),
    websiteTextChars: provenanceEntry(finalUrl, fetchedAt),
    websiteUsableText: provenanceEntry(finalUrl, fetchedAt),
  };
  if (merged.emails.length > 0) provenance.websiteEmails = provenanceEntry(finalUrl, fetchedAt);
  if (merged.phones.length > 0) provenance.websitePhones = provenanceEntry(finalUrl, fetchedAt);
  if (merged.socialLinks.length > 0) provenance.websiteSocialLinks = provenanceEntry(finalUrl, fetchedAt);
  if (merged.hasContactForm) provenance.websiteHasContactForm = provenanceEntry(finalUrl, fetchedAt);
  if (merged.copyrightYear !== null) provenance.websiteCopyrightYear = provenanceEntry(finalUrl, fetchedAt);
  if (merged.title) provenance.websiteTitle = provenanceEntry(finalUrl, fetchedAt);
  if (merged.description) provenance.websiteDescription = provenanceEntry(finalUrl, fetchedAt);

  const stats: EnrichmentStats = {
    pagesFetched,
    failures: homepageFailed ? 1 : 0,
    robotsBlocked: robotsBlocked ? 1 : 0,
    usableChars: merged.text.length,
  };

  const enrichment: Record<string, unknown> = {
    version: 1,
    fetchedAt,
    durationMs: now().getTime() - startedAt,
    config: {
      maxPagesPerProspect: config.maxPagesPerProspect,
      pageTimeoutMs: config.pageTimeoutMs,
      prospectBudgetMs: config.prospectBudgetMs,
      maxHtmlBytes: config.maxHtmlBytes,
      totalTextChars: config.totalTextChars,
      minUsableTextChars: config.minUsableTextChars,
      respectRobots: config.respectRobots,
    },
    usableText: merged.text,
    textChars: merged.text.length,
    usable,
    title: merged.title,
    description: merged.description,
    emails: merged.emails,
    phones: merged.phones,
    socialLinks: merged.socialLinks,
    hasContactForm: merged.hasContactForm,
    copyrightYear: merged.copyrightYear,
    pagesFetched,
    failed: homepageFailed,
    robotsBlocked,
    pages: pages.map((page) => page.record),
    errors,
  };

  return {
    status: "enriched",
    facts,
    provenance,
    enrichment,
    stats,
  };
}
