import * as XLSX from "@e965/xlsx";
import type { Prospect, Run, Settings } from "@kripa/shared";

const ATTRIBUTION =
  "Place data sourced from OpenStreetMap via Geoapify. © OpenStreetMap contributors, available under the Open Database License (ODbL): " +
  "https://www.openstreetmap.org/copyright. Place search and geocoding powered by Geoapify: https://www.geoapify.com/. " +
  "Fields marked `enriched` come from the prospect's own website; each carries its source URL and retrieval date.";

const SOURCE_NOTE =
  "Business data © OpenStreetMap contributors (ODbL) · Powered by Geoapify";

interface ProspectRow {
  rank: number;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  fitScore: number | null;
  fitBand: string | null;
  contactabilityScore: number | null;
  contactabilityBand: string | null;
  status: string;
  notScoredReason: string | null;
  needsManualContactResearch: boolean;
  sourceUrl: string | null;
  verifiedTags: string;
}

function verifiedTagsOf(prospect: Prospect): string {
  const explain = prospect.scoreExplain as { tags?: Array<{ id: string; present: boolean; verified: boolean; quote: string | null }> } | null;
  const tags = (explain?.tags ?? []).filter((tag) => tag.present && tag.verified && tag.quote);
  return tags.map((tag) => `${tag.id}: “${tag.quote}”`).join("; ");
}

function notScoredReasonOf(prospect: Prospect): string | null {
  const explain = prospect.scoreExplain as { reason?: string; detail?: string } | null;
  if (!explain) return null;
  if (explain.reason) return explain.reason + (explain.detail ? ` — ${explain.detail}` : "");
  return null;
}

export function buildProspectsRows(prospects: Prospect[]): ProspectRow[] {
  const scored = [...prospects].sort((a, b) => {
    const fitA = a.fitScore ?? -1;
    const fitB = b.fitScore ?? -1;
    if (fitB !== fitA) return fitB - fitA;
    const contA = a.contactabilityScore ?? -1;
    const contB = b.contactabilityScore ?? -1;
    return contB - contA;
  });

  return scored.map((prospect, index) => ({
    rank: index + 1,
    name: prospect.name,
    category: prospect.category ?? null,
    address: prospect.address ?? null,
    city: prospect.city ?? null,
    website: prospect.website ?? null,
    phone: prospect.phone ?? null,
    email: prospect.email ?? null,
    fitScore: prospect.fitScore ?? null,
    fitBand: prospect.fitBand ?? null,
    contactabilityScore: prospect.contactabilityScore ?? null,
    contactabilityBand: prospect.contactabilityBand ?? null,
    status: prospect.status,
    notScoredReason: notScoredReasonOf(prospect),
    needsManualContactResearch: prospect.needsManualContactResearch,
    sourceUrl: prospect.website ?? null,
    verifiedTags: verifiedTagsOf(prospect),
  }));
}

export function buildExportWorkbook(prospects: Prospect[], run: Run, settings: Settings): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  const rows = buildProspectsRows(prospects);

  const headers = [
    "Rank",
    "Name",
    "Category",
    "Address",
    "City",
    "Website",
    "Phone",
    "Email",
    "Fit Score",
    "Fit Band",
    "Contactability Score",
    "Contactability Band",
    "Status",
    "Not Scored Reason",
    "Needs Manual Research",
    "Source URL",
    "Verified Evidence Tags",
  ];

  const prospectData = rows.map((row) => [
    row.rank,
    row.name,
    row.category ?? "",
    row.address ?? "",
    row.city ?? "",
    row.website ?? "",
    row.phone ?? "",
    row.email ?? "",
    row.fitScore ?? "",
    row.fitBand ?? "",
    row.contactabilityScore ?? "",
    row.contactabilityBand ?? "",
    row.status,
    row.notScoredReason ?? "",
    row.needsManualContactResearch ? "Yes" : "No",
    row.sourceUrl ?? "",
    row.verifiedTags,
  ]);

  const prospectsSheet = XLSX.utils.aoa_to_sheet([
    [ATTRIBUTION, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    headers,
    ...prospectData,
  ]);
  XLSX.utils.book_append_sheet(workbook, prospectsSheet, "Prospects");

  // Sources sheet with attribution.
  const sourcesSheet = XLSX.utils.aoa_to_sheet([
    ["Source", "Description", "URL", "License"],
    ["OpenStreetMap", "Business place data (names, addresses, categories, brands)", "https://www.openstreetmap.org/copyright", "Open Database License (ODbL)"],
    ["Geoapify", "Place search, place details, and geocoding", "https://www.geoapify.com/", "Geoapify terms of service"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sourcesSheet, "Sources");

  // Run summary sheet.
  const counts = run.counts ?? {};
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["Run Summary", ""],
    ["Area", run.areaText ?? ""],
    ["Resolved area", run.resolvedLabel ?? ""],
    ["Segments", run.segmentIds.join(", ")],
    ["Raw", counts.raw ?? ""],
    ["Valid", counts.valid ?? ""],
    ["Enriched", counts.enriched ?? ""],
    ["Scored", counts.scored ?? ""],
    ["Below floor", counts.belowFloor ?? ""],
    ["Not scored", counts.notScored ?? ""],
    ["Exported", counts.exported ?? ""],
    ["Credits used", counts.creditsUsed ?? ""],
    ["Tokens used", counts.tokensUsed ?? ""],
    ["Config version", run.scoringConfigVersion ?? ""],
    ["Attribution", SOURCE_NOTE],
  ]);
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Run Summary");

  return workbook;
}

export function downloadWorkbook(workbook: XLSX.WorkBook, filename: string): void {
  const data = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function exportFilename(run: Run): string {
  const safe = (run.areaText ?? "run").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const day = new Date(run.createdAt ?? Date.now()).toISOString().slice(0, 10);
  return `kripa-leads-${safe}-${day}.xlsx`;
}
