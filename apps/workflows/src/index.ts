import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ensureSettings, insertEvent, updateRunStatus } from "@kripa/db";
import type { RunCounts } from "@kripa/shared";
import { discoverRun } from "./discovery";
import { enrichBatch, finalizeEnrichmentCounts } from "./enrichment";

export interface LeadRunParams {
  runId: string;
}

export interface WorkflowEnv {
  DB: D1Database;
  GEOAPIFY_API_KEY?: string;
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

      const counts = await step.do("summarize-enrichment", async () =>
        finalizeEnrichmentCounts(this.env, runId, baseCounts as RunCounts),
      );

      await updateRunStatus(this.env.DB, runId, "completed", counts);
      await insertEvent(this.env.DB, {
        runId,
        eventType: "run_enriched",
        payload: {
          ...counts,
          discoveryDetailsFailures: detailsFailures,
          batches: batchIndex,
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
