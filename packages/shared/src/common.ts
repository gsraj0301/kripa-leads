import { z } from "zod";

export const IsoDateSchema = z.string().datetime();
export const IdentifierSchema = z.string().min(1).max(120);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ObservabilitySchema = z.enum([
  "observed_true",
  "observed_false",
  "not_observable",
  "not_scored",
]);

export const FitBandSchema = z.enum([
  "excluded",
  "below_floor",
  "low",
  "medium",
  "high",
]);

export const ContactabilityBandSchema = z.enum(["none", "low", "medium", "high"]);

export const ProspectStatusSchema = z.enum([
  "raw",
  "valid",
  "enriched",
  "scored",
  "not_scored",
  "approved",
  "rejected",
  "exported",
]);

export const RunStatusSchema = z.enum([
  "planned",
  "discovering",
  "enriching",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
