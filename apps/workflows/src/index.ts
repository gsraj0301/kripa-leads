import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ensureSettings, insertEvent, updateRunStatus } from "@kripa/db";
import type { RunCounts } from "@kripa/shared";
import { discoverRun } from "./discovery";
import { enrichBatch, finalizeEnrichmentCounts } from "./enrichment";
import {
  emitQuoteWarningIfNeeded,
  finalizeScoringCounts,
  loadScoringContext,
  markExtractionDisabled,
  markRunBudgetShortfall,
  markUnscorableProspects,
  scoreNextProspect,
} from "./scoring";

export interface LeadRunParams {
  runId: string;
}

export interface WorkflowEnv {
  DB: D1Database;
  GEOAPIFY_API_KEY?: string;
  GROQ_API_KEY?: string;
}

export class LeadRunWorkflow extends WorkflowEntrypoint<WorkflowEnv, LeadRunParams> {
  async run(event: WorkflowEvent<LeadRunParams>, step: WorkflowStep) {
    const runId = event.payload?.runId;
    if (!runId) throw new Error("Workflow payload is missing runId.");

    try {
      const discovered = await step.do("discover", async () => {
        await updateRunStatus(this.env.DB, runId, "discovering");
        return discoverRun(this.env, runId);
      });

      const { detailsFailures, ...baseCounts } = discovered;
      const config = await step.do("load-enrichment-config", async () => {
        const settings = await ensureSettings(this.env.DB);
        return settings.enrichment;
      });

      await updateRunStatus(this.env.DB, runId, "enriching");

      let batchIndex = 0;
      for (;;) {
        const result = await step.do(`enrich-batch-${batchIndex}`, async () =>
          enrichBatch(this.env, runId, config),
        );
        batchIndex += 1;
        if (result.done) break;
        if (batchIndex > 1_000) throw new Error("Enrichment batch limit exceeded.");
      }

      const enrichedCounts = await step.do("summarize-enrichment", async () =>
        finalizeEnrichmentCounts(this.env, runId, baseCounts as RunCounts),
      );

      const scoringContext = await step.do("load-scoring-context", async () =>
        loadScoringContext(this.env, runId),
      );
      await updateRunStatus(this.env.DB, runId, "scoring");
      await step.do("mark-unscorable", async () => markUnscorableProspects(this.env, runId));

      if (scoringContext.extraction.enabled) {
        let scoringStep = 0;
        for (;;) {
          const result = await step.do(`score-prospect-${scoringStep}`, async () =>
            scoreNextProspect(this.env, runId, scoringContext),
          );
          scoringStep += 1;
          if (result.kind === "done") break;
          if (result.kind === "quota") {
            await step.sleepUntil(`quota-wait-${scoringStep}`, result.retryAt);
          } else if (result.kind === "run_budget") {
            await step.do("mark-run-budget-shortfall", async () =>
              markRunBudgetShortfall(this.env, runId),
            );
            await insertEvent(this.env.DB, {
              runId,
              eventType: "run_warning",
              payload: { code: "run_token_budget", tokensUsed: result.used },
            });
            break;
          }
          if (scoringStep > 2_000) throw new Error("Scoring step limit exceeded.");
        }
      } else {
        await step.do("mark-extraction-disabled", async () =>
          markExtractionDisabled(this.env, runId),
        );
        await insertEvent(this.env.DB, {
          runId,
          eventType: "run_warning",
          payload: { code: "extraction_disabled" },
        });
      }

      await step.do("quote-warning", async () => emitQuoteWarningIfNeeded(this.env, runId));
      const counts = await step.do("summarize-scoring", async () =>
        finalizeScoringCounts(this.env, runId, enrichedCounts),
      );

      await updateRunStatus(this.env.DB, runId, "completed", counts);
      await insertEvent(this.env.DB, {
        runId,
        eventType: "run_scored",
        payload: {
          ...counts,
          discoveryDetailsFailures: detailsFailures,
          enrichmentBatches: batchIndex,
        },
      });
      return counts;
    } catch (error) {
      await updateRunStatus(this.env.DB, runId, "failed");
      await insertEvent(this.env.DB, {
        runId,
        eventType: "run_failed",
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
}
