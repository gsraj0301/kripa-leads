import { z } from "zod";
import { ProspectSchema } from "./prospect";
import { RunSchema } from "./run";
import { SegmentSchema } from "./segment";
import { SettingsApproveSchema, SettingsSchema, SettingsUpdateSchema } from "./settings";

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  environment: z.string(),
  now: z.string().datetime(),
});

export const MeResponseSchema = z.object({
  actor: z.object({
    email: z.string().email(),
    mode: z.enum(["access", "dev"]),
  }),
});

export const SegmentsResponseSchema = z.object({
  segments: z.array(SegmentSchema),
});

export const SettingsResponseSchema = z.object({
  settings: SettingsSchema,
});

export const GeocodeRequestSchema = z.object({
  area: z.string().trim().min(2).max(200),
  countryCode: z
    .string()
    .regex(/^[a-z]{2}$/, "Use a lowercase ISO country code")
    .optional(),
});

export const RunCreateSchema = z.object({
  areaText: z.string().trim().min(2).max(200),
  resolvedPlaceId: z.string().trim().min(1).max(200),
  resolvedLabel: z.string().trim().min(1).max(300),
  segmentIds: z.array(z.string().min(1)).min(1),
  includePreviouslyDelivered: z.boolean().default(false),
});

export const RunResponseSchema = z.object({ run: RunSchema });
export const RunListResponseSchema = z.object({ runs: z.array(RunSchema) });
export const ProspectListResponseSchema = z.object({ prospects: z.array(ProspectSchema) });

export { SettingsApproveSchema, SettingsSchema, SettingsUpdateSchema };

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type SegmentsResponse = z.infer<typeof SegmentsResponseSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type GeocodeRequest = z.infer<typeof GeocodeRequestSchema>;
export type RunCreate = z.infer<typeof RunCreateSchema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
export type ProspectListResponse = z.infer<typeof ProspectListResponseSchema>;
