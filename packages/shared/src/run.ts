import { z } from "zod";
import { IsoDateSchema, RunStatusSchema } from "./common";

export const RunCountsSchema = z.object({
  raw: z.number().int().min(0).default(0),
  valid: z.number().int().min(0).default(0),
  enriched: z.number().int().min(0).default(0),
  enrichmentFailures: z.number().int().min(0).default(0),
  pagesFetched: z.number().int().min(0).default(0),
  skippedNoWebsite: z.number().int().min(0).default(0),
  robotsBlocked: z.number().int().min(0).default(0),
  scored: z.number().int().min(0).default(0),
  notScored: z.number().int().min(0).default(0),
  belowFloor: z.number().int().min(0).default(0),
  exported: z.number().int().min(0).default(0),
  creditsUsed: z.number().int().min(0).default(0),
  tokensUsed: z.number().int().min(0).default(0),
  tokensIn: z.number().int().min(0).default(0),
  tokensOut: z.number().int().min(0).default(0),
  extractionCalls: z.number().int().min(0).default(0),
  extractionFailures: z.number().int().min(0).default(0),
  quoteFailures: z.number().int().min(0).default(0),
  quoteChecks: z.number().int().min(0).default(0),
  countFailures: z.number().int().min(0).default(0),
  countChecks: z.number().int().min(0).default(0),
  enrichmentFailureReasons: z.record(z.string(), z.number().int().min(0)).default({}),
  droppedDelivered: z.number().int().min(0).default(0),
  enterpriseExcluded: z.number().int().min(0).default(0),
  invalid: z.number().int().min(0).default(0),
  duplicatePlaceIds: z.number().int().min(0).default(0),
  duplicateCompanyKeys: z.number().int().min(0).default(0),
});

export const RunSchema = z.object({
  id: z.string().min(1),
  areaText: z.string().min(1),
  resolvedPlaceId: z.string().nullable(),
  resolvedLabel: z.string().nullable(),
  segmentIds: z.array(z.string().min(1)).min(1),
  includePreviouslyDelivered: z.boolean(),
  plan: z.record(z.string(), z.unknown()),
  segmentsSnapshot: z.record(z.string(), z.unknown()),
  scoringSnapshot: z.record(z.string(), z.unknown()),
  scoringConfigVersion: z.number().int().positive(),
  status: RunStatusSchema,
  counts: RunCountsSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

export const RunListSchema = z.object({
  runs: z.array(RunSchema),
});

export type RunCounts = z.infer<typeof RunCountsSchema>;
export type Run = z.infer<typeof RunSchema>;
