import type { Tag } from "../prospect";
import type { Rubric } from "../settings";
import type { Segment } from "../segment";
import type { ExtractionCounts } from "../scoring";

export interface ExtractionTagDefinition {
  id: string;
  definition: string;
}

export interface ExtractionSchema {
  tags: ExtractionTagDefinition[];
  flags: ExtractionTagDefinition[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ExtractionResponse {
  payload: unknown;
  usage: TokenUsage;
  model: string;
  providerRequestId: string | null;
}

export interface ExtractionProvider {
  extract(text: string, schema: ExtractionSchema): Promise<ExtractionResponse>;
}

export interface ParsedTagValue {
  present: boolean;
  quote: string | null;
}

export interface ParsedCount {
  value: number;
  quote: string | null;
}

export interface ParsedCounts {
  team: ParsedCount | null;
  offices: ParsedCount | null;
  founded: ParsedCount | null;
}

export interface CountEvidence {
  value: number;
  quote: string | null;
  verified: boolean;
  source?: "code" | "model";
  sourceUrl?: string;
}

export interface ParsedExtraction {
  tags: Record<string, ParsedTagValue>;
  counts: ParsedCounts;
  flags: Record<string, ParsedTagValue>;
}

export interface ExtractionOutcome {
  tags: Record<string, Tag>;
  counts: ExtractionCounts;
  countEvidence: Record<"team" | "offices" | "founded", CountEvidence | null>;
  quoteFailures: number;
  quoteChecks: number;
  countFailures: number;
  countChecks: number;
  usage: TokenUsage;
  model: string;
  providerRequestId: string | null;
}

export interface ExtractProspectInput {
  text: string;
  segment: Segment;
  rubric: Rubric;
  sourceUrl: string | null;
  provider: ExtractionProvider;
  now?: Date;
}
