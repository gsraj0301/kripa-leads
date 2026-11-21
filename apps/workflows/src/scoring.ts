import {
  createGroqProvider,
  EXTRACTION_DEFAULTS,
  extractProspect,
  GroqQuotaError,
  SCORING_DEFAULTS,
  ScoringSnapshotSchema,
  SegmentsSnapshotSchema,
  budgetAfterUsage,
  buildExtractionText,
  classifyPageKind,
  scoreProspect,
  type ExtractionConfig,
  type Rubric,
  type CountEvidence,
  type RunCounts,
  type ScoringConfig,
  type Segment,
  type TokenUsage,
} from "@kripa/shared";
import {
  ensureSettings,
  getGroqUsageOnDate,
  getNextProspectForExtraction,
  getRun,
  getRunGroqTokens,
  insertEvent,
  markNotScoredProspects,
  markProspectNotScored,
  markRemainingEnrichedNotScored,
  summarizeEnrichment,
  summarizeGroqUsage,
  summarizeScoring,
  updateProspectScore,
} from "@kripa/db";

export interface ScoringEnv {
  DB: D1Database;
  GROQ_API_KEY?: string;
}

export interface ScoringContext {
  configVersion: number;
  resolvedPlaceId: string | null;
  segments: Segment[];
  rubrics: Record<string, Rubric>;
  scoring: ScoringConfig;
  extraction: ExtractionConfig;
}

export type ScoringStepResult =
  | { kind: "done" }
  | { kind: "processed"; status: string; fitScore: number | null; usage: TokenUsage | null }
  | { kind: "quota"; retryAt: number }
  | { kind: "run_budget"; used: number }
  | { kind: "failed"; message: string };

function utcDatePrefix(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export async function loadScoringContext(
  env: ScoringEnv,
  runId: string,
): Promise<ScoringContext> {
  const run = await getRun(env.DB, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const settings = await ensureSettings(env.DB);
  const segments = SegmentsSnapshotSchema.parse(run.segmentsSnapshot).segments;
  const snapshot = ScoringSnapshotSchema.parse(run.scoringSnapshot);
  return {
    configVersion: run.scoringConfigVersion,
    resolvedPlaceId: run.resolvedPlaceId,
    segments,
    rubrics: snapshot.rubrics,
    scoring: snapshot.scoring ?? settings.scoring ?? SCORING_DEFAULTS,
    extraction: snapshot.extraction ?? settings.extraction ?? EXTRACTION_DEFAULTS,
  };
}

export async function markUnscorableProspects(
  env: ScoringEnv,
  runId: string,
): Promise<number> {
  return markNotScoredProspects(
    env.DB,
    runId,
    "no_usable_text",
    "The website did not yield enough readable text to score.",
  );
}

export async function markExtractionDisabled(env: ScoringEnv, runId: string): Promise<number> {
  return markRemainingEnrichedNotScored(
    env.DB,
    runId,
    "extraction_disabled",
    "Extraction is disabled in settings.",
  );
}

export async function markRunBudgetShortfall(env: ScoringEnv, runId: string): Promise<number> {
  return markRemainingEnrichedNotScored(
    env.DB,
    runId,
    "run_token_budget",
    "The run token budget was exhausted before this prospect could be extracted.",
  );
}

function mergedProvenance(
  existing: Record<string, unknown>,
  input: {
    sourceUrl: string | null;
    model: string;
    providerRequestId: string | null;
    now: string;
    configVersion: number;
  },
): Record<string, unknown> {
  return {
    ...existing,
    tags: {
      source: "groq",
      source_url: input.sourceUrl,
      retrieved_at: input.now,
      kind: "extracted",
      model: input.model,
      provider_request_id: input.providerRequestId,
    },
    fitScore: {
      source: "scoring",
      source_url: null,
      retrieved_at: input.now,
      kind: "verified",
      config_version: input.configVersion,
    },
    contactabilityScore: {
      source: "scoring",
      source_url: null,
      retrieved_at: input.now,
      kind: "verified",
      config_version: input.configVersion,
    },
  };
}

interface StoredCodeFact {
  value: number;
  quote: string;
  sourceUrl: string;
}

function mergeCodeCounts(
  facts: Record<string, unknown>,
  llmCounts: { team: number | null; offices: number | null; founded: number | null },
  llmEvidence: Record<"team" | "offices" | "founded", CountEvidence | null>,
): {
  counts: { team: number | null; offices: number | null; founded: number | null };
  evidence: Record<"team" | "offices" | "founded", CountEvidence | null>;
} {
  const code = (facts.websiteCodeFacts ?? {}) as Partial<
    Record<"team" | "offices" | "founded", StoredCodeFact>
  >;
  const pick = (key: "team" | "offices" | "founded") => {
    const fact = code[key];
    if (fact && Number.isFinite(fact.value)) {
      return {
        value: fact.value,
        evidence: {
          value: fact.value,
          quote: fact.quote,
          verified: true,
          source: "code",
          sourceUrl: fact.sourceUrl,
        } as CountEvidence,
      };
    }
    const evidence = llmEvidence[key];
    return {
      value: llmCounts[key],
      evidence: evidence ? ({ ...evidence, source: "model" } as CountEvidence) : null,
    };
  };
  const team = pick("team");
  const offices = pick("offices");
  const founded = pick("founded");
  return {
    counts: { team: team.value, offices: offices.value, founded: founded.value },
    evidence: { team: team.evidence, offices: offices.evidence, founded: founded.evidence },
  };
}

export async function scoreNextProspect(
  env: ScoringEnv,
  runId: string,
  context: ScoringContext,
): Promise<ScoringStepResult> {
  const prospect = await getNextProspectForExtraction(env.DB, runId);
  if (!prospect) return { kind: "done" };

  const extraction = context.extraction;
  const usableText =
    typeof prospect.enrichment.usableText === "string" ? prospect.enrichment.usableText : "";
  const storedPages = Array.isArray(prospect.enrichment.pages) ? prospect.enrichment.pages : [];
  const snippets = storedPages.map((page) => ({
    kind: (page?.kind ?? classifyPageKind(typeof page?.url === "string" ? page.url : "")) as
      | "home"
      | "about"
      | "team"
      | "contact"
      | "other",
    url: typeof page?.url === "string" ? page.url : "",
    text: typeof page?.text === "string" ? page.text : "",
  }));
  const coverageText = buildExtractionText(snippets, extraction);
  const text = coverageText || usableText.slice(0, extraction.maxInputChars);
  if (!text.trim()) {
    await markProspectNotScored(
      env.DB,
      prospect.id,
      "no_usable_text",
      "The enrichment record has no readable text.",
    );
    return { kind: "processed", status: "not_scored", fitScore: null, usage: null };
  }

  const runTokens = await getRunGroqTokens(env.DB, runId);
  if (runTokens + extraction.estimatedTokensPerProspect > extraction.runTokenBudget) {
    return { kind: "run_budget", used: runTokens };
  }
  const usedToday = await getGroqUsageOnDate(env.DB, utcDatePrefix());
  if (usedToday + extraction.estimatedTokensPerProspect > extraction.dailyTokenBudget) {
    return { kind: "quota", retryAt: nextUtcMidnight() };
  }

  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");

  const segment = context.segments.find((candidate) => candidate.id === prospect.segmentId);
  if (!segment) throw new Error(`Segment ${prospect.segmentId} is missing from the run snapshot.`);
  const rubric = context.rubrics[prospect.segmentId];
  if (!rubric) throw new Error(`Rubric ${prospect.segmentId} is missing from the run snapshot.`);

  const provider = createGroqProvider({ apiKey, config: extraction });
  const sourceUrl =
    typeof prospect.facts.websiteFinalUrl === "string"
      ? prospect.facts.websiteFinalUrl
      : prospect.website;

  let outcome;
  try {
    outcome = await extractProspect({
      text: text.slice(0, extraction.maxInputChars),
      segment,
      rubric,
      sourceUrl,
      provider,
    });
  } catch (error) {
    if (error instanceof GroqQuotaError) {
      return { kind: "quota", retryAt: Math.max(error.retryAt, Date.now() + 1_000) };
    }
    const message = error instanceof Error ? error.message : String(error);
    await markProspectNotScored(env.DB, prospect.id, "extraction_failed", message);
    await insertEvent(env.DB, {
      runId,
      prospectId: prospect.id,
      eventType: "extraction_failed",
      payload: { message, model: extraction.model },
    });
    return { kind: "failed", message };
  }

  const now = new Date();
  const mergedCounts = mergeCodeCounts(prospect.facts, outcome.counts, outcome.countEvidence);
  const result = scoreProspect({
    segment,
    rubric,
    scoring: context.scoring,
    tags: outcome.tags,
    counts: mergedCounts.counts,
    facts: prospect.facts,
    contacts: { phone: prospect.phone, email: prospect.email },
    geography: context.resolvedPlaceId ? "in" : "unknown",
    hasUsableText: true,
    configVersion: context.configVersion,
    now,
  });

  await updateProspectScore(env.DB, {
    id: prospect.id,
    status: result.status,
    tags: outcome.tags,
    fitScore: result.fitScore,
    fitBand: result.fitBand,
    contactabilityScore: result.contactabilityScore,
    contactabilityBand: result.contactabilityBand,
    scoreExplain: {
      ...result.scoreExplain,
      counts: mergedCounts.evidence,
    } as unknown as Record<string, unknown>,
    needsManualContactResearch: result.needsManualContactResearch,
    provenance: mergedProvenance(prospect.provenance, {
      sourceUrl,
      model: outcome.model,
      providerRequestId: outcome.providerRequestId,
      now: now.toISOString(),
      configVersion: context.configVersion,
    }),
  });

  await insertEvent(env.DB, {
    runId,
    prospectId: prospect.id,
    eventType: "groq_usage",
    payload: {
      model: outcome.model,
      providerRequestId: outcome.providerRequestId,
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      totalTokens: outcome.usage.totalTokens,
      quoteFailures: outcome.quoteFailures,
      quoteChecks: outcome.quoteChecks,
      countFailures: outcome.countFailures,
      countChecks: outcome.countChecks,
      status: result.status,
      fitScore: result.fitScore,
      contactabilityScore: result.contactabilityScore,
    },
  });

  const budget = budgetAfterUsage(
    runTokens,
    usedToday,
    outcome.usage,
    {
      runTokenBudget: extraction.runTokenBudget,
      dailyTokenBudget: extraction.dailyTokenBudget,
    },
  );
  if (budget === "run_budget") {
    return { kind: "run_budget", used: runTokens + outcome.usage.totalTokens };
  }
  if (budget === "quota") {
    return { kind: "quota", retryAt: nextUtcMidnight() };
  }

  return {
    kind: "processed",
    status: result.status,
    fitScore: result.fitScore,
    usage: outcome.usage,
  };
}

export async function finalizeScoringCounts(
  env: ScoringEnv,
  runId: string,
  base: RunCounts,
): Promise<RunCounts> {
  const [enrichment, scoring, usage] = await Promise.all([
    summarizeEnrichment(env.DB, runId),
    summarizeScoring(env.DB, runId),
    summarizeGroqUsage(env.DB, runId),
  ]);
  return {
    ...base,
    enriched: enrichment.enriched,
    enrichmentFailures: enrichment.failures,
    pagesFetched: enrichment.pagesFetched,
    skippedNoWebsite: enrichment.skippedNoWebsite,
    robotsBlocked: enrichment.robotsBlocked,
    scored: scoring.scored,
    notScored: scoring.notScored,
    belowFloor: scoring.belowFloor,
    extractionFailures: scoring.extractionFailures,
    tokensUsed: usage.tokensUsed,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    extractionCalls: usage.calls,
    quoteFailures: usage.quoteFailures,
    quoteChecks: usage.quoteChecks,
    countFailures: usage.countFailures,
    countChecks: usage.countChecks,
    enrichmentFailureReasons: enrichment.failureReasons,
  };
}

export async function emitQuoteWarningIfNeeded(env: ScoringEnv, runId: string): Promise<void> {
  const usage = await summarizeGroqUsage(env.DB, runId);
  if (usage.quoteChecks > 0 && usage.quoteFailures / usage.quoteChecks > 0.05) {
    await insertEvent(env.DB, {
      runId,
      eventType: "run_warning",
      payload: {
        code: "quote_failure_rate",
        quoteFailures: usage.quoteFailures,
        quoteChecks: usage.quoteChecks,
        rate: usage.quoteFailures / usage.quoteChecks,
      },
    });
  }
}
