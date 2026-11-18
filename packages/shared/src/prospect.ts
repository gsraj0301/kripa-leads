import { z } from "zod";
import {
  ContactabilityBandSchema,
  FitBandSchema,
  IsoDateSchema,
  ObservabilitySchema,
  ProspectStatusSchema,
} from "./common";

export const TagSchema = z.object({
  id: z.string().min(1),
  present: z.boolean(),
  observability: ObservabilitySchema,
  points: z.number(),
  quote: z.string().nullable(),
  verified: z.boolean(),
  sourceUrl: z.string().url().nullable(),
});

export const ProspectSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  segmentId: z.string().min(1),
  source: z.string().min(1).default("geoapify"),
  sourceId: z.string().nullable(),
  category: z.string().nullable(),
  companyKey: z.string().min(1),
  name: z.string().min(1),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postcode: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  fitScore: z.number().int().min(0).max(100).nullable(),
  fitBand: FitBandSchema.nullable(),
  contactabilityScore: z.number().int().min(0).max(100).nullable(),
  contactabilityBand: ContactabilityBandSchema.nullable(),
  tags: z.record(z.string(), TagSchema),
  facts: z.record(z.string(), z.unknown()),
  raw: z.record(z.string(), z.unknown()),
  scoreExplain: z.record(z.string(), z.unknown()),
  needsManualContactResearch: z.boolean(),
  provenance: z.record(z.string(), z.unknown()),
  enrichment: z.record(z.string(), z.unknown()),
  status: ProspectStatusSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});

export type Tag = z.infer<typeof TagSchema>;
export type Prospect = z.infer<typeof ProspectSchema>;
