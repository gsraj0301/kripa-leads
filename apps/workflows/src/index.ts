import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { insertEvent, updateRunStatus } from "@kripa/db";
import { discoverRun } from "./discovery";

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
      return await step.do("discover", async () => {
        await updateRunStatus(this.env.DB, runId, "discovering");
        return discoverRun(this.env, runId);
      });
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
