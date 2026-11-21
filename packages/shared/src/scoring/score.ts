import type { Tag } from "../prospect";
import { normalizeEmail, normalizePhone, sameSite } from "../enrichment/html";
import type { ComponentExplanation, ScoreExplanation, ScoreProspectInput, ScoreResult } from "./types";

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function verifiedTag(tags: Record<string, Tag>, id: string): Tag | null {
  const tag = tags[id];
  return tag && tag.present && tag.verified ? tag : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function headcountPoints(value: number | null, input: ScoreProspectInput): ComponentExplanation {
  const points = input.rubric.points.size.headcount;
  const max = Math.max(...Object.values(points));
  if (value === null) {
    return {
      points: round1(max * input.rubric.unknownCredit.size),
      max,
      observation: "not_observable",
      reason: "Headcount not stated; unknown credit applied.",
    };
  }
  if (value <= 1) {
    return { points: points.one, max, observation: "observed_true", reason: "1 person." };
  }
  if (value <= 4) {
    return { points: points.micro, max, observation: "observed_true", reason: "2-4 people." };
  }
  if (value <= 50) {
    return { points: points.small, max, observation: "observed_true", reason: "5-50 people." };
  }
  if (value <= 200) {
    return { points: points.mid, max, observation: "observed_true", reason: "51-200 people." };
  }
  return { points: points.large, max, observation: "observed_true", reason: "More than 200 people." };
}

function officePoints(value: number | null, input: ScoreProspectInput): ComponentExplanation {
  const points = input.rubric.points.size.offices;
  const max = Math.max(...Object.values(points));
  if (value === null) {
    return {
      points: round1(max * input.rubric.unknownCredit.size),
      max,
      observation: "not_observable",
      reason: "Office count not stated; unknown credit applied.",
    };
  }
  if (value <= 1) {
    return { points: points.one, max, observation: "observed_true", reason: "1 office." };
  }
  if (value <= 3) {
    return { points: points.few, max, observation: "observed_true", reason: "2-3 offices." };
  }
  return { points: points.many, max, observation: "observed_true", reason: "4 or more offices." };
}

function foundedPoints(
  founded: number | null,
  nowYear: number,
  input: ScoreProspectInput,
): ComponentExplanation {
  const points = input.rubric.points.tenure;
  const max = Math.max(points.foundedRecent, points.foundedMid, points.foundedOld);
  if (founded === null) {
    return {
      points: round1(max * input.rubric.unknownCredit.tenure),
      max,
      observation: "not_observable",
      reason: "Founding year not stated; unknown credit applied.",
    };
  }
  const age = nowYear - founded;
  if (age >= 5) {
    return { points: points.foundedOld, max, observation: "observed_true", reason: `Founded ${founded}, 5+ years.` };
  }
  if (age >= 2) {
    return { points: points.foundedMid, max, observation: "observed_true", reason: `Founded ${founded}, 2-4 years.` };
  }
  return { points: points.foundedRecent, max, observation: "observed_true", reason: `Founded ${founded}, under 2 years.` };
}

function emailPoints(
  emails: string[],
  input: ScoreProspectInput,
): { points: number; email: string | null; role: boolean } {
  const prefixes = new Set(input.scoring.roleEmailPrefixes.map((prefix) => prefix.toLowerCase()));
  let best = { points: 0, email: null as string | null, role: false };
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email) continue;
    const local = email.split("@")[0]?.split("+")[0]?.toLowerCase() ?? "";
    const role = prefixes.has(local);
    const points = role
      ? input.rubric.points.reachable.emailRole
      : input.rubric.points.reachable.emailPersonal;
    if (points > best.points) best = { points, email, role };
  }
  return best;
}

function fitBand(
  score: number,
  floor: number,
  thresholds: { low: number; medium: number; high: number },
): "below_floor" | "low" | "medium" | "high" {
  if (score < floor) return "below_floor";
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  return "low";
}

function contactabilityBand(
  score: number,
  thresholds: { low: number; medium: number; high: number },
): "none" | "low" | "medium" | "high" {
  if (score <= 0) return "none";
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  if (score >= thresholds.low) return "low";
  return "none";
}

export function scoreProspect(input: ScoreProspectInput): ScoreResult {
  if (!input.hasUsableText) {
    return {
      fitScore: null,
      fitBand: null,
      contactabilityScore: null,
      contactabilityBand: null,
      status: "not_scored",
      needsManualContactResearch: true,
      scoreExplain: {
        version: 1,
        reason: "no_usable_text",
        detail: "The website did not yield enough readable text to score.",
      },
    };
  }

  const now = input.now ?? new Date();
  const facts = input.facts;
  const tagExplanations: ScoreExplanation["tags"] = [];

  let serviceFit = 0;
  for (const id of input.segment.tags) {
    const tag = input.tags[id];
    const points = input.rubric.serviceFitTagPoints[id] ?? 0;
    const counted = Boolean(tag?.present && tag.verified);
    if (counted) serviceFit += points;
    tagExplanations.push({
      id,
      points,
      present: Boolean(tag?.present),
      verified: Boolean(tag?.verified),
      quote: tag?.quote ?? null,
    });
  }
  serviceFit = Math.min(serviceFit, input.rubric.fit.serviceFit);

  const headcount = headcountPoints(input.counts.team, input);
  const offices = officePoints(input.counts.offices, input);
  const sizePoints = headcount.points + offices.points;
  const sizeObservation =
    headcount.observation === "not_observable" && offices.observation === "not_observable"
      ? "not_observable"
      : "observed_true";

  const founded = foundedPoints(input.counts.founded, now.getUTCFullYear(), input);
  const tenureTagId =
    input.segment.tenureTag ??
    (input.segment.tags.includes("team_page") ? "team_page" : null);
  const hasTeamTag = tenureTagId !== null && input.segment.tags.includes(tenureTagId);
  const teamTag = tenureTagId ? input.tags[tenureTagId] : undefined;
  const teamPresent = Boolean(teamTag?.present && teamTag.verified);
  const teamPoints = hasTeamTag
    ? teamPresent
      ? input.rubric.points.tenure.teamPage
      : 0
    : round1(input.rubric.points.tenure.teamPage * input.rubric.unknownCredit.tenure);
  const tenurePoints = founded.points + teamPoints;
  const tenureObservation =
    founded.observation === "not_observable" && !hasTeamTag ? "not_observable" : "observed_true";

  const geographyPoints =
    input.geography === "in"
      ? input.rubric.points.geography.in
      : input.geography === "adjacent"
        ? input.rubric.points.geography.adjacent
        : input.geography === "outside"
          ? input.rubric.points.geography.outside
          : 0;
  const geographyObservation =
    input.geography === "unknown" ? "not_observable" : "observed_true";

  const totalBeforeDeductions =
    serviceFit + sizePoints + tenurePoints + geographyPoints;

  const deductions: Array<{ id: string; mode: "exclude" | "deduct"; points: number; applied: boolean }> = [];
  let deductionTotal = 0;
  let excluded = false;
  for (const flag of input.rubric.negativeFlags) {
    const tag = verifiedTag(input.tags, flag.id);
    if (!tag) {
      deductions.push({ id: flag.id, mode: flag.mode, points: flag.points, applied: false });
      continue;
    }
    if (flag.mode === "exclude") {
      excluded = true;
      deductions.push({ id: flag.id, mode: flag.mode, points: 0, applied: true });
    } else {
      deductionTotal += flag.points;
      deductions.push({ id: flag.id, mode: flag.mode, points: flag.points, applied: true });
    }
  }

  const soloTriggered = Boolean(verifiedTag(input.tags, "solo"));
  let soloApplied = false;
  let soloCap: number | null = null;
  if (soloTriggered && input.segment.soloPolicy === "exclude") {
    excluded = true;
    soloApplied = true;
  } else if (soloTriggered && input.segment.soloPolicy === "cap") {
    soloCap = input.segment.soloCap;
    soloApplied = true;
  }

  let fitTotal = clamp(totalBeforeDeductions - deductionTotal, 0, 100);
  if (soloCap !== null) fitTotal = Math.min(fitTotal, soloCap);
  if (excluded) fitTotal = 0;

  const fitScore = roundScore(fitTotal);
  const band = excluded
    ? "excluded"
    : fitBand(fitScore, input.segment.fitFloor, input.scoring.bands.fit);

  const sitePhones = stringArray(facts.websitePhones);
  const siteEmails = stringArray(facts.websiteEmails);
  const providerPhone = input.contacts.phone ? normalizePhone(input.contacts.phone) : null;
  const channelPhone = providerPhone ?? sitePhones.map(normalizePhone).find((value) => value !== null) ?? null;
  const email = emailPoints(
    [input.contacts.email, ...siteEmails].filter((value): value is string => Boolean(value)),
    input,
  );
  const reachablePointsRaw =
    (channelPhone ? input.rubric.points.reachable.phone : 0) + email.points;
  const reachable = {
    points: Math.min(reachablePointsRaw, input.rubric.contactability.reachableChannel),
    max: input.rubric.contactability.reachableChannel,
    observation: channelPhone || email.email ? ("observed_true" as const) : ("observed_false" as const),
    reason:
      channelPhone || email.email
        ? `${channelPhone ? "format-valid phone" : "no phone"}; ${
            email.email ? (email.role ? "role email" : "personal email") : "no email"
          }.`
        : "No format-valid phone or published email.",
    parts: { phone: channelPhone, email: email.email, roleEmail: email.role },
  };

  const website = stringValue(facts.websiteUrl);
  const finalUrl = stringValue(facts.websiteFinalUrl);
  const status = numberValue(facts.websiteStatus);
  const reachableSite = booleanValue(facts.websiteReachable);
  const https = booleanValue(facts.websiteHttps);
  const contentType = stringValue(facts.websiteContentType)?.toLowerCase() ?? null;
  const isHtml = contentType === null || contentType.includes("text/html") || contentType.includes("application/xhtml");
  const unrelatedRedirect = Boolean(website && finalUrl && !sameSite(website, finalUrl));
  let workingSitePoints = 0;
  let workingSiteReason = "Website did not respond with a usable HTML page.";
  if (reachableSite && unrelatedRedirect) {
    workingSitePoints = input.rubric.points.workingSite.unrelatedRedirect;
    workingSiteReason = "Redirected to an unrelated domain.";
  } else if (reachableSite && status !== null && status >= 200 && status < 300 && isHtml) {
    if (https) {
      workingSitePoints = input.rubric.points.workingSite.https;
      workingSiteReason = "HTTP 200, HTML, HTTPS.";
    } else {
      workingSitePoints = input.rubric.points.workingSite.httpOnly;
      workingSiteReason = "HTTP 200, HTML, HTTP only.";
    }
  }
  const workingSite = {
    points: Math.min(workingSitePoints, input.rubric.contactability.workingSite),
    max: input.rubric.contactability.workingSite,
    observation: reachableSite ? ("observed_true" as const) : ("observed_false" as const),
    reason: workingSiteReason,
    parts: { status, https, contentType, finalUrl, unrelatedRedirect },
  };

  const socials = stringArray(facts.websiteSocialLinks);
  const hasContactPage = booleanValue(facts.websiteHasContactPage);
  const hasContactForm = booleanValue(facts.websiteHasContactForm);
  const contactPart = hasContactPage || hasContactForm ? input.rubric.points.contactPath.contact : 0;
  const socialPart = socials.length > 0 ? input.rubric.points.contactPath.social : 0;
  const contactPath = {
    points: Math.min(contactPart + socialPart, input.rubric.contactability.contactPath),
    max: input.rubric.contactability.contactPath,
    observation: contactPart || socialPart ? ("observed_true" as const) : ("observed_false" as const),
    reason:
      contactPart || socialPart
        ? `${hasContactPage ? "contact page" : hasContactForm ? "contact form" : "no contact path"}; ${
            socials.length > 0 ? "social profile" : "no social profile"
          }.`
        : "No contact page, contact form, or social profile found.",
    parts: { hasContactPage, hasContactForm, socials: socials.length },
  };

  const copyrightYear = numberValue(facts.websiteCopyrightYear);
  let freshnessPoints = 0;
  let freshnessReason = "No copyright year found.";
  if (copyrightYear !== null) {
    const age = now.getUTCFullYear() - copyrightYear;
    if (age <= 0) {
      freshnessPoints = input.rubric.points.freshness.current;
      freshnessReason = `Copyright ${copyrightYear}.`;
    } else if (age === 1) {
      freshnessPoints = input.rubric.points.freshness.previous;
      freshnessReason = `Copyright ${copyrightYear}, one year old.`;
    } else if (age === 2) {
      freshnessPoints = input.rubric.points.freshness.older;
      freshnessReason = `Copyright ${copyrightYear}, two years old.`;
    } else {
      freshnessReason = `Copyright ${copyrightYear}, older than two years.`;
    }
  }
  const freshness = {
    points: Math.min(freshnessPoints, input.rubric.contactability.freshness),
    max: input.rubric.contactability.freshness,
    observation: copyrightYear !== null ? ("observed_true" as const) : ("observed_false" as const),
    reason: freshnessReason,
  };

  const contactabilityTotal = clamp(
    reachable.points + workingSite.points + contactPath.points + freshness.points,
    0,
    100,
  );
  const contactabilityScore = roundScore(contactabilityTotal);

  const needsManualContactResearch =
    (siteEmails.length === 0 && sitePhones.length === 0) ||
    contactabilityScore < input.scoring.manualResearchBelowContactability;

  const scoreExplain: ScoreExplanation = {
    version: 1,
    configVersion: input.configVersion,
    segmentId: input.segment.id,
    fitFloor: input.segment.fitFloor,
    fit: {
      serviceFit: {
        points: round1(serviceFit),
        max: input.rubric.fit.serviceFit,
        observation: "observed_true",
        reason: `${tagExplanations.filter((tag) => tag.present && tag.verified).length} verified service tags.`,
      },
      size: {
        points: round1(sizePoints),
        max: input.rubric.fit.size,
        observation: sizeObservation,
        reason: `${headcount.reason} ${offices.reason}`,
        parts: { headcount, offices },
      },
      tenure: {
        points: round1(tenurePoints),
        max: input.rubric.fit.tenure,
        observation: tenureObservation,
        reason: `${founded.reason} ${
          hasTeamTag
            ? teamPresent
              ? "Team page present."
              : "Team page not found."
            : "No tenure team tag configured; unknown credit applied."
        }`,
        parts: { founded, teamPage: { configured: hasTeamTag, present: teamPresent, points: teamPoints } },
      },
      geography: {
        points: geographyPoints,
        max: input.rubric.fit.geography,
        observation: geographyObservation,
        reason:
          input.geography === "unknown"
            ? "Geography could not be derived from provider data."
            : `Provider address is ${input.geography} the boundary.`,
      },
      negativeFlags: deductions,
      soloPolicy: { policy: input.segment.soloPolicy, applied: soloApplied, cap: soloCap },
      totalBeforeDeductions: round1(totalBeforeDeductions),
      deductions: deductionTotal,
      total: fitScore,
    },
    contactability: {
      reachableChannel: reachable,
      workingSite,
      contactPath,
      freshness,
      total: contactabilityScore,
    },
    tags: tagExplanations,
  };

  return {
    fitScore,
    fitBand: band,
    contactabilityScore,
    contactabilityBand: contactabilityBand(contactabilityScore, input.scoring.bands.contactability),
    status: band === "below_floor" || band === "excluded" ? "below_floor" : "scored",
    needsManualContactResearch,
    scoreExplain,
  };
}
