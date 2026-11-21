import { z } from "zod";
import type { Tag } from "../prospect";
import { RubricSchema, ScoringConfigSchema, type Rubric, type ScoringConfig } from "../settings";
import { ExtractionConfigSchema, type ExtractionConfig } from "../settings";
import { SegmentSchema, type Segment } from "../segment";

export const GeographySchema = z.enum(["in", "adjacent", "outside", "unknown"]);
export type Geography = z.infer<typeof GeographySchema>;

export const SegmentsSnapshotSchema = z.object({
  segments: z.array(SegmentSchema),
});

export const ScoringSnapshotSchema = z
  .object({
    rubrics: z.record(z.string(), RubricSchema),
    scoring: ScoringConfigSchema.optional(),
    extraction: ExtractionConfigSchema.optional(),
  })
  .passthrough();

export interface ScoringContextConfig {
  segments: Segment[];
  rubrics: Record<string, Rubric>;
  scoring: ScoringConfig;
  extraction: ExtractionConfig;
}

export interface ExtractionCounts {
  team: number | null;
  offices: number | null;
  founded: number | null;
}

export interface ScoreContacts {
  phone: string | null;
  email: string | null;
}

export interface ScoreProspectInput {
  segment: Segment;
  rubric: Rubric;
  scoring: ScoringConfig;
  tags: Record<string, Tag>;
  counts: ExtractionCounts;
  facts: Record<string, unknown>;
  contacts: ScoreContacts;
  geography: Geography;
  hasUsableText: boolean;
  configVersion: number;
  now?: Date;
}

export interface ComponentExplanation {
  points: number;
  max: number;
  observation: "observed_true" | "observed_false" | "not_observable";
  reason: string;
  parts?: Record<string, unknown>;
}

export interface ScoreExplanation {
  version: 1;
  configVersion: number;
  segmentId: string;
  fitFloor: number;
  fit: {
    serviceFit: ComponentExplanation;
    size: ComponentExplanation;
    tenure: ComponentExplanation;
    geography: ComponentExplanation;
    negativeFlags: Array<{ id: string; mode: "exclude" | "deduct"; points: number; applied: boolean }>;
    soloPolicy: { policy: string; applied: boolean; cap: number | null };
    totalBeforeDeductions: number;
    deductions: number;
    total: number;
  };
  contactability: {
    reachableChannel: ComponentExplanation;
    workingSite: ComponentExplanation;
    contactPath: ComponentExplanation;
    freshness: ComponentExplanation;
    total: number;
  };
  tags: Array<{
    id: string;
    points: number;
    present: boolean;
    verified: boolean;
    quote: string | null;
  }>;
}

export interface ScoreResult {
  fitScore: number | null;
  fitBand: "excluded" | "below_floor" | "low" | "medium" | "high" | null;
  contactabilityScore: number | null;
  contactabilityBand: "none" | "low" | "medium" | "high" | null;
  status: "scored" | "not_scored" | "below_floor";
  needsManualContactResearch: boolean;
  scoreExplain: ScoreExplanation | { version: 1; reason: string; detail?: string };
}
