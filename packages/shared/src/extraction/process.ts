import type { Tag } from "../prospect";
import { buildExtractionSchema } from "./prompt";
import { parseExtractionPayload } from "./parse";
import type {
  CountEvidence,
  ParsedCount,
  ParsedTagValue,
  ExtractProspectInput,
  ExtractionOutcome,
} from "./types";
import { countAppearsInQuote, quoteAppearsInText } from "./quotes";

function buildTag(
  id: string,
  raw: ParsedTagValue | undefined,
  text: string,
  sourceUrl: string | null,
  points: number,
): { tag: Tag; checked: boolean; failed: boolean } {
  const claimed = raw?.present === true;
  const quote = raw?.quote ?? null;
  const quoteVerified = claimed && quote !== null && quoteAppearsInText(quote, text);
  const present = claimed && quoteVerified;
  return {
    tag: {
      id,
      present,
      observability: present ? "observed_true" : "observed_false",
      points,
      quote: quoteVerified ? quote : claimed ? quote : null,
      verified: quoteVerified,
      sourceUrl,
    },
    checked: claimed,
    failed: claimed && !quoteVerified,
  };
}

function verifyCount(
  raw: ParsedCount | null,
  text: string,
): { evidence: CountEvidence | null; checked: boolean; failed: boolean } {
  if (!raw) return { evidence: null, checked: false, failed: false };
  const quotePresent = raw.quote !== null && quoteAppearsInText(raw.quote, text);
  const numberPresent = quotePresent && countAppearsInQuote(raw.value, raw.quote ?? "");
  const verified = quotePresent && numberPresent;
  return {
    evidence: { value: raw.value, quote: raw.quote, verified },
    checked: true,
    failed: !verified,
  };
}

export async function extractProspect(input: ExtractProspectInput): Promise<ExtractionOutcome> {
  const schema = buildExtractionSchema(input.segment, input.rubric);
  const response = await input.provider.extract(
    input.text,
    schema,
  );

  const parsed = parseExtractionPayload(response.payload);

  let quoteChecks = 0;
  let quoteFailures = 0;
  const tags: Record<string, Tag> = {};

  for (const id of input.segment.tags) {
    const result = buildTag(
      id,
      parsed.tags[id],
      input.text,
      input.sourceUrl,
      input.rubric.serviceFitTagPoints[id] ?? 0,
    );
    tags[id] = result.tag;
    if (result.checked) quoteChecks += 1;
    if (result.failed) quoteFailures += 1;
  }

  const flagIds = [...input.rubric.negativeFlags.map((flag) => flag.id), "solo"];
  for (const id of flagIds) {
    const result = buildTag(id, parsed.flags[id], input.text, input.sourceUrl, 0);
    tags[id] = result.tag;
    if (result.checked) quoteChecks += 1;
    if (result.failed) quoteFailures += 1;
  }

  const countEvidence: ExtractionOutcome["countEvidence"] = {
    team: null,
    offices: null,
    founded: null,
  };
  let countChecks = 0;
  let countFailures = 0;
  for (const key of ["team", "offices", "founded"] as const) {
    const result = verifyCount(parsed.counts[key], input.text);
    countEvidence[key] = result.evidence;
    if (result.checked) {
      quoteChecks += 1;
      countChecks += 1;
    }
    if (result.failed) {
      quoteFailures += 1;
      countFailures += 1;
    }
  }
  const counts = {
    team: countEvidence.team?.verified ? countEvidence.team.value : null,
    offices: countEvidence.offices?.verified ? countEvidence.offices.value : null,
    founded: countEvidence.founded?.verified ? countEvidence.founded.value : null,
  };

  return {
    tags,
    counts,
    countEvidence,
    quoteChecks,
    quoteFailures,
    countChecks,
    countFailures,
    usage: response.usage,
    model: response.model,
    providerRequestId: response.providerRequestId,
  };
}
