import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_CONFIG,
  scoreProspect,
  type Tag,
} from "@kripa/shared";

const config = DEFAULT_SETTINGS_CONFIG;
const segment = config.segments[0]!;
const rubric = config.rubrics[segment.id]!;
const now = new Date("2026-06-01T00:00:00.000Z");

function tag(id: string, present = true, verified = true): Tag {
  return {
    id,
    present,
    observability: present ? "observed_true" : "observed_false",
    points: 0,
    quote: present ? "evidence" : null,
    verified,
    sourceUrl: "https://acme.test/",
  };
}

function baseTags(ids: string[] = []): Record<string, Tag> {
  const tags: Record<string, Tag> = {};
  for (const id of segment.tags) tags[id] = tag(id, ids.includes(id));
  return tags;
}

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    websiteUrl: "https://acme.test",
    websiteFinalUrl: "https://acme.test/",
    websiteStatus: 200,
    websiteReachable: true,
    websiteHttps: true,
    websiteContentType: "text/html; charset=utf-8",
    websiteEmails: ["info@acme.test"],
    websitePhones: ["+919876543210"],
    websiteSocialLinks: ["https://linkedin.com/company/acme"],
    websiteHasContactForm: true,
    websiteHasContactPage: true,
    websiteCopyrightYear: 2026,
    ...overrides,
  };
}

function score(input: {
  tags?: Record<string, Tag>;
  counts?: { team: number | null; offices: number | null; founded: number | null };
  facts?: Record<string, unknown>;
  contacts?: { phone: string | null; email: string | null };
  hasUsableText?: boolean;
  geography?: "in" | "adjacent" | "outside" | "unknown";
  segmentOverride?: Partial<typeof segment>;
}) {
  return scoreProspect({
    segment: { ...segment, ...input.segmentOverride },
    rubric,
    scoring: config.scoring,
    tags: input.tags ?? baseTags(segment.tags),
    counts: input.counts ?? { team: 10, offices: 2, founded: 2010 },
    facts: input.facts ?? facts(),
    contacts: input.contacts ?? { phone: "+919876543210", email: "info@acme.test" },
    geography: input.geography ?? "in",
    hasUsableText: input.hasUsableText ?? true,
    configVersion: 7,
    now,
  });
}

describe("scoreProspect", () => {
  it("scores a fully supported prospect on both axes", () => {
    const result = score({ tags: baseTags(segment.tags) });
    expect(result.fitScore).toBe(93);
    expect(result.fitBand).toBe("high");
    expect(result.contactabilityScore).toBe(100);
    expect(result.contactabilityBand).toBe("high");
    expect(result.status).toBe("scored");
    expect(result.needsManualContactResearch).toBe(false);
    const explain = result.scoreExplain as {
      fit: { serviceFit: { points: number }; size: { points: number } };
    };
    expect(explain.fit.serviceFit.points).toBe(50);
    expect(explain.fit.size.points).toBe(21);
  });

  it("returns not_scored when no usable text exists", () => {
    const result = score({ hasUsableText: false });
    expect(result.fitScore).toBeNull();
    expect(result.contactabilityScore).toBeNull();
    expect(result.status).toBe("not_scored");
    expect(result.needsManualContactResearch).toBe(true);
  });

  it("applies unknown credit only to size and tenure", () => {
    const result = score({
      tags: baseTags(),
      counts: { team: null, offices: null, founded: null },
    });
    expect(result.fitScore).toBe(30);
    expect(result.fitBand).toBe("below_floor");
    const explain = result.scoreExplain as {
      fit: { size: { observation: string; points: number }; tenure: { points: number } };
    };
    expect(explain.fit.size.observation).toBe("not_observable");
    expect(explain.fit.size.points).toBe(12.5);
    expect(explain.fit.tenure.points).toBe(7.5);
  });

  it("does not count tags whose quote was not verified", () => {
    const tags = baseTags();
    tags.gst_registered = tag("gst_registered", true, false);
    const result = score({ tags });
    const explain = result.scoreExplain as { fit: { serviceFit: { points: number } } };
    expect(explain.fit.serviceFit.points).toBe(0);
  });

  it("excludes directory and defunct signals from fit", () => {
    const tags = baseTags(segment.tags);
    tags.directory_aggregator = tag("directory_aggregator");
    const result = score({ tags });
    expect(result.fitScore).toBe(0);
    expect(result.fitBand).toBe("excluded");
    expect(result.status).toBe("below_floor");
    expect(result.contactabilityScore).toBe(100);
  });

  it("deducts franchise points after components", () => {
    const tags = baseTags(segment.tags);
    tags.franchise = tag("franchise");
    const result = score({ tags });
    expect(result.fitScore).toBe(63);
    expect(result.fitBand).toBe("medium");
  });

  it("scores a weak contact path without gating fit", () => {
    const tags = baseTags(segment.tags);
    const result = score({
      tags,
      facts: facts({
        websiteEmails: [],
        websitePhones: [],
        websiteHttps: false,
        websiteSocialLinks: [],
        websiteHasContactForm: false,
        websiteHasContactPage: false,
        websiteCopyrightYear: 2023,
      }),
      contacts: { phone: null, email: "raj@acme.test" },
    });
    expect(result.contactabilityScore).toBe(25);
    expect(result.contactabilityBand).toBe("low");
    expect(result.status).toBe("scored");
    expect(result.needsManualContactResearch).toBe(true);
  });

  it("applies solo policy as configuration", () => {
    const tags = baseTags(segment.tags);
    tags.solo = tag("solo");
    const capped = score({ tags, segmentOverride: { soloPolicy: "cap", soloCap: 20 } });
    expect(capped.fitScore).toBe(20);
    expect(capped.fitBand).toBe("below_floor");

    const excluded = score({ tags, segmentOverride: { soloPolicy: "exclude" } });
    expect(excluded.fitBand).toBe("excluded");
    expect(excluded.fitScore).toBe(0);
  });

  it("keeps geography out of unknown credit", () => {
    const result = score({ geography: "unknown" });
    const explain = result.scoreExplain as { fit: { geography: { points: number; observation: string } } };
    expect(explain.fit.geography.points).toBe(0);
    expect(explain.fit.geography.observation).toBe("not_observable");
    expect(result.fitScore).toBe(83);
  });

  it("honours an explicit tenure team tag instead of hardcoded team_page", () => {
    const caSegment = config.segments.find((s) => s.id === "ca_firm")!;
    const caRubric = config.rubrics[caSegment.id]!;
    const tags: Record<string, Tag> = {};
    for (const id of caSegment.tags) tags[id] = tag(id, id === "team_page");
    const result = scoreProspect({
      segment: caSegment,
      rubric: caRubric,
      scoring: config.scoring,
      tags,
      counts: { team: 10, offices: 2, founded: 2010 },
      facts: facts(),
      contacts: { phone: "+919876543210", email: "info@acme.test" },
      geography: "in",
      hasUsableText: true,
      configVersion: 7,
      now,
    });
    const explain = result.scoreExplain as unknown as { fit: { tenure: { parts: { teamPage: { configured: boolean; points: number } } } } };
    expect(explain.fit.tenure.parts.teamPage).toMatchObject({ configured: true, points: 7 });
  });
});
