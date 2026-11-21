export interface ExtractionEstimate {
  calls: number;
  tokens: number;
  minutes: number;
}

export function estimateExtractionRun(input: {
  categories: number;
  maxResultsPerCategory: number;
  runTokenBudget: number;
  estimatedTokensPerProspect: number;
  minIntervalMs: number;
}): ExtractionEstimate {
  const categoriesCount = Math.max(0, Math.floor(input.categories));
  const maxResults = Math.max(0, Math.floor(input.maxResultsPerCategory));
  const affordable = Math.floor(
    input.runTokenBudget / Math.max(1, input.estimatedTokensPerProspect),
  );
  const calls = Math.max(0, Math.min(categoriesCount * maxResults, affordable));
  return {
    calls,
    tokens: calls * Math.max(1, input.estimatedTokensPerProspect),
    minutes: Math.ceil((calls * Math.max(0, input.minIntervalMs)) / 60_000),
  };
}
