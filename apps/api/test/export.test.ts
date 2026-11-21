import { describe, expect, it } from "vitest";
import { buildExportWorkbook, exportFilename } from "../../web/src/export";
import * as XLSX from "@e965/xlsx";
import type { Prospect, Run, Settings } from "@kripa/shared";

function makeRun(area = "Chennai"): Run {
  return {
    id: "run-1",
    areaText: area,
    resolvedPlaceId: "place-1",
    resolvedLabel: "Chennai, TN, India",
    segmentIds: ["msme"],
    includePreviouslyDelivered: false,
    plan: {},
    segmentsSnapshot: { segments: [] },
    scoringSnapshot: {},
    scoringConfigVersion: 1,
    status: "completed",
    counts: {
      raw: 0,
      valid: 0,
      enriched: 0,
      scored: 0,
      belowFloor: 0,
      notScored: 0,
      exported: 0,
      creditsUsed: 0,
      tokensUsed: 0,
    },
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
  } as Run;
}

function makeSettings(): Settings {
  return {
    segments: [],
    rubrics: {},
    retention: {
      deliveriesMonths: null,
      rejectedProspectsMonths: 12,
      enrichmentTextMonths: 12,
      rawProviderPayloadDays: 90,
      eventsMonths: 12,
      runMetadataMonths: 24,
    },
    discovery: {
      maxResultsPerCategory: 500,
      minIntervalMs: 300,
      dailyCreditBudget: 3000,
      defaultCountryCode: "in",
      enterpriseFilter: { enabled: true, brands: [], operators: [] },
    },
    enrichment: {
      maxPagesPerProspect: 3,
      pageTimeoutMs: 10000,
      prospectBudgetMs: 60000,
      maxConcurrency: 4,
      maxRedirects: 5,
      maxHtmlBytes: 750000,
      totalTextChars: 30000,
      minUsableTextChars: 400,
      respectRobots: true,
      robotsCacheTtlSeconds: 86400,
      userAgent: "KripaLeadsBot/0.1",
    },
    extraction: {
      enabled: true,
      model: "openai/gpt-oss-120b",
      maxInputChars: 3000,
      pageBudgets: { home: 1000, about: 1200, team: 800, contact: 800, other: 400 },
      maxOutputTokens: 800,
      temperature: 0,
      reasoningEffort: "low",
      timeoutMs: 30000,
      maxRetries: 2,
      minIntervalMs: 10000,
      dailyTokenBudget: 200000,
      runTokenBudget: 140000,
      estimatedTokensPerProspect: 1300,
    },
    scoring: {
      bands: { fit: { low: 40, medium: 60, high: 80 }, contactability: { low: 20, medium: 40, high: 70 } },
      manualResearchBelowContactability: 40,
      roleEmailPrefixes: ["info"],
    },
    exports: { enabled: false },
    planYields: {
      rawPerValid: 1.35,
      enrichedPerValid: 0.56,
      scoredPerEnriched: 0.84,
      aboveFloorPerScored: 0.30,
    },
    configVersion: 1,
    approved: false,
    provisional: true,
    provisionalReason: "pending",
    updatedAt: "2026-11-21T10:00:00.000Z",
    updatedBy: "test",
  } as Settings;
}

function makeProspect(index: number): Prospect {
  return {
    id: `p-${index}`,
    runId: "run-1",
    segmentId: "msme",
    source: "geoapify",
    sourceId: `src-${index}`,
    category: "office.company",
    companyKey: `ck-${index}`,
    name: `Business ${index}`,
    website: `https://business${index}.test/`,
    phone: index % 2 === 0 ? "+919876543210" : null,
    email: index % 3 === 0 ? `info@business${index}.test` : null,
    address: `Address ${index}, Chennai`,
    city: "Chennai",
    state: "Tamil Nadu",
    postcode: "600001",
    latitude: 13.08,
    longitude: 80.27,
    fitScore: index % 100,
    fitBand: index >= 40 ? "low" : "below_floor",
    contactabilityScore: index % 100,
    contactabilityBand: "medium",
    tags: {},
    facts: {},
    raw: {},
    scoreExplain: {},
    needsManualContactResearch: index % 5 === 0,
    provenance: {},
    enrichment: {},
    status: "scored",
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
  } as Prospect;
}

describe("buildExportWorkbook", () => {
  const run = makeRun();
  const settings = makeSettings();

  it("builds a workbook with zero rows", () => {
    const workbook = buildExportWorkbook([], run, settings);
    expect(workbook.SheetNames).toContain("Prospects");
    expect(workbook.SheetNames).toContain("Sources");
    expect(workbook.SheetNames).toContain("Run Summary");
    const sheet = workbook.Sheets["Prospects"];
    expect(sheet["A1"].v).toContain("OpenStreetMap");
    // header row + attribution row, no data rows
    expect(sheet["A2"].v).toBe("Rank");
  });

  it("builds a workbook with one row", () => {
    const workbook = buildExportWorkbook([makeProspect(1)], run, settings);
    const sheet = workbook.Sheets["Prospects"];
    expect(sheet["A3"].v).toBe(1); // rank
    expect(sheet["B3"].v).toBe("Business 1");
  });

  it("builds a workbook with 500 rows", () => {
    const prospects = Array.from({ length: 500 }, (_, i) => makeProspect(i));
    const workbook = buildExportWorkbook(prospects, run, settings);
    const sheet = workbook.Sheets["Prospects"];
    // attribution row 1, header row 2, data rank N at row N+2
    expect(sheet["A502"].v).toBe(500);
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("exportFilename uses area and date", () => {
    expect(exportFilename(makeRun("Chennai"))).toContain("kripa-leads-chennai");
    expect(exportFilename(makeRun("Chennai"))).toContain("2026-11-21");
  });
});
