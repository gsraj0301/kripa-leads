import type { ExtractionConfig } from "../settings";
import type { TokenUsage } from "./types";

export type BudgetStatus = "ok" | "run_budget" | "quota";

export function budgetAfterUsage(
  runTokens: number,
  usedToday: number,
  usage: TokenUsage,
  config: Pick<ExtractionConfig, "runTokenBudget" | "dailyTokenBudget">,
): BudgetStatus {
  if (runTokens + usage.totalTokens > config.runTokenBudget) return "run_budget";
  if (usedToday + usage.totalTokens > config.dailyTokenBudget) return "quota";
  return "ok";
}
