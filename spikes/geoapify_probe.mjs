#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function parseEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const ENV = { ...parseEnv(join(ROOT, ".env")), ...process.env };
const API_KEY = (ENV.GEOAPIFY_API_KEY || "").trim();
const CITY = (ENV.SPIKE_CITY || "Chennai").trim();
const COUNTRY = (ENV.SPIKE_COUNTRY || "India").trim();
const COUNTRY_CODE = (ENV.SPIKE_COUNTRY_CODE || "in").trim();
const PLACE_ID_OVERRIDE = (ENV.SPIKE_PLACE_ID || "").trim();
const PER_CATEGORY = Number(ENV.SPIKE_PER_CATEGORY || 50);
const TARGET_PER_BUCKET = Number(ENV.SPIKE_TARGET_BUCKET || 100);
const MIN_INTERVAL_MS = Number(ENV.SPIKE_MIN_INTERVAL_MS || 300);
const PROBE_TIMEOUT_MS = Number(ENV.SPIKE_PROBE_TIMEOUT_MS || 10000);

const BUCKETS = [
  {
    id: "ca_firm",
    label: "CA firms",
    categories: ["office.accountant", "office.tax_advisor", "office.financial_advisor"],
  },
  {
    id: "general_business",
    label: "General business",
    categories: ["office.company", "office.it", "commercial"],
  },
];

const GENERIC_NAME =
  /^(accountant|accountants|tax consultant|tax advisor|chartered accountant|ca|ca firm|office|company|business)$/i;
const CLOSED_TEXT = /\b(closed|shut down|permanently closed|disused|abandoned)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { requests: 0, credits: 0, errors: [] };

function pct(n, d) {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function getJson(url, label, attempt = 1) {
  state.requests += 1;
  if (state.requests > 1) await sleep(MIN_INTERVAL_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "KripaLeadSpike/0.1 (internal research)" },
    });
  } catch (err) {
    if (attempt <= 3) {
      await sleep(1000 * attempt);
      return getJson(url, label, attempt + 1);
    }
    throw new Error(`${label}: network error ${err.message || err}`);
  }
  if (res.status === 429 && attempt <= 3) {
    const retryAfter = Number(res.headers.get("retry-after") || 2);
    await sleep(Math.max(1000, retryAfter * 1000) * attempt);
    return getJson(url, label, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON response`);
  }
}

async function geocodeCity() {
  if (PLACE_ID_OVERRIDE) {
    state.credits += 1;
    return { placeId: PLACE_ID_OVERRIDE, label: `${CITY} (override)`, lat: null, lon: null };
  }
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set("text", `${CITY}, ${COUNTRY}`);
  url.searchParams.set("filter", `countrycode:${COUNTRY_CODE}`);
  url.searchParams.set("limit", "5");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", API_KEY);
  const data = await getJson(url.toString(), "geocode");
  state.credits += 1;
  const features = data.features || [];
  if (features.length === 0) throw new Error(`Could not geocode ${CITY}, ${COUNTRY}`);
  const hit =
    features.find((f) => ["city", "district", "county"].includes(f.properties?.result_type)) ||
    features[0];
  return {
    placeId: hit.properties.place_id,
    label: hit.properties.formatted || CITY,
    lat: hit.properties.lat,
    lon: hit.properties.lon,
  };
}

async function searchCategory(category, placeId) {
  const url = new URL("https://api.geoapify.com/v2/places");
  url.searchParams.set("categories", category);
  url.searchParams.set("filter", `place:${placeId}`);
  url.searchParams.set("limit", String(PER_CATEGORY));
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", API_KEY);
  const data = await getJson(url.toString(), `places:${category}`);
  const features = data.features || [];
  state.credits += features.length <= 20 ? 1 : 1 + Math.ceil((features.length - 20) / 20);
  return features.map((f) => ({ ...f.properties, __category: category }));
}

async function fetchDetails(placeId) {
  const url = new URL("https://api.geoapify.com/v2/place-details");
  url.searchParams.set("id", placeId);
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", API_KEY);
  const data = await getJson(url.toString(), `details:${placeId}`);
  state.credits += 1;
  return data.features?.[0]?.properties || {};
}

function normalizeWebsite(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

function errorKindOf(err) {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return "timeout";
  const code = String(err?.cause?.code || err?.code || "");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.startsWith("CERT_") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return "tls";
  }
  return "network";
}

async function probeOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KripaLeadSpike/0.1)" },
    });
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    const info = {
      status: res.status,
      finalUrl: res.url,
      contentType,
      ok: res.ok && contentType.includes("text/html"),
      error: null,
      errorKind: null,
    };
    try {
      await res.arrayBuffer();
    } catch {}
    return info;
  } catch (err) {
    return {
      status: 0,
      finalUrl: null,
      contentType: "",
      ok: false,
      error: err.name === "AbortError" ? "timeout" : String(err.message || err),
      errorKind: errorKindOf(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeWebsite(url) {
  const first = await probeOnce(url);
  if (first.status !== 0) return first;
  if (!["timeout", "network"].includes(first.errorKind)) return first;
  await sleep(1000);
  return probeOnce(url);
}

function isConfirmedDead(probe) {
  if (!probe) return false;
  if (probe.status === 404 || probe.status === 410) return true;
  return probe.status === 0 && ["dns", "refused"].includes(probe.errorKind);
}

function contactOf(props) {
  const c = props.contact || {};
  const phones = [c.phone, ...(Array.isArray(c.phone_other) ? c.phone_other : [])].filter(Boolean);
  const emails = [c.email, ...(Array.isArray(c.email_other) ? c.email_other : [])].filter(Boolean);
  return { phone: phones[0] || null, phones, email: emails[0] || null, emails };
}

function duplicateKey(row) {
  return `${(row.name || "").trim().toLowerCase()}|${(row.address || "").trim().toLowerCase()}`;
}

function flagRow(row, duplicateSet) {
  const flags = [];
  if (!row.name || GENERIC_NAME.test(row.name.trim())) flags.push("generic_name");
  if (!row.address) flags.push("no_address");
  if (CLOSED_TEXT.test(`${row.name || ""} ${(row.categories || []).join(" ")}`)) {
    flags.push("closed_text");
  }
  if (!row.website) flags.push("no_website");
  if (!row.phone && !row.email) flags.push("no_osm_phone_email");
  if (!row.website && !row.phone && !row.email && !row.openingHours) {
    flags.push("no_contact_no_hours");
  }
  if (row.website && row.websiteProbe && !row.websiteProbe.ok) {
    flags.push(`website_${row.websiteProbe.status || row.websiteProbe.errorKind || "error"}`);
  }
  if (isConfirmedDead(row.websiteProbe)) flags.push("website_dead");
  if (duplicateSet.has(duplicateKey(row))) flags.push("duplicate_address");
  return flags;
}

function isJunk(row, flags) {
  return (
    flags.includes("closed_text") ||
    flags.includes("no_address") ||
    flags.includes("website_dead") ||
    flags.includes("duplicate_address")
  );
}

function summarize(rows) {
  const total = rows.length;
  const withWebsite = rows.filter((r) => r.website).length;
  const websiteOk = rows.filter((r) => r.websiteProbe?.ok).length;
  const withPhone = rows.filter((r) => r.phone).length;
  const withEmail = rows.filter((r) => r.email).length;
  const anyChannel = rows.filter((r) => r.phone || r.email || r.website).length;
  const junk = rows.filter((r) => isJunk(r, r.flags)).length;
  const duplicates = rows.filter((r) => r.flags.includes("duplicate_address")).length;
  const inArea = rows.filter((r) => r.city || r.state || r.postcode).length;
  const chain = rows.filter((r) => r.brand || r.operator).length;
  return {
    total,
    websitePct: pct(withWebsite, total),
    websiteOkPct: pct(websiteOk, total),
    phonePct: pct(withPhone, total),
    emailPct: pct(withEmail, total),
    anyChannelPct: pct(anyChannel, total),
    junkPct: pct(junk, total),
    duplicatePct: pct(duplicates, total),
    inAreaPct: pct(inArea, total),
    chainPct: pct(chain, total),
  };
}

function gatesFor(summary) {
  return [
    { name: "rows >= target", value: `${summary.total} / ${TARGET_PER_BUCKET}`, pass: summary.total >= TARGET_PER_BUCKET },
    { name: "website present >= 40%", value: `${summary.websitePct}%`, pass: summary.websitePct >= 40 },
    { name: "any channel >= 60%", value: `${summary.anyChannelPct}%`, pass: summary.anyChannelPct >= 60 },
    { name: "suspected junk <= 15%", value: `${summary.junkPct}%`, pass: summary.junkPct <= 15 },
    { name: "in area >= 80%", value: `${summary.inAreaPct}%`, pass: summary.inAreaPct >= 80 },
  ];
}

function verdict(gates) {
  return gates.every((g) => g.pass) ? "PASS" : "FAIL";
}

function mdCell(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function csvCell(value) {
  return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
  const header = [
    "bucket",
    "category",
    "name",
    "address",
    "city",
    "state",
    "postcode",
    "website",
    "website_status",
    "website_ok",
    "website_error",
    "phone",
    "email",
    "opening_hours",
    "brand",
    "operator",
    "place_id",
    "flags",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.bucketLabel,
        r.category,
        r.name,
        r.address,
        r.city,
        r.state,
        r.postcode,
        r.website,
        r.websiteProbe ? r.websiteProbe.status : "",
        r.websiteProbe ? String(r.websiteProbe.ok) : "",
        r.websiteProbe ? r.websiteProbe.error || r.websiteProbe.errorKind || "" : "",
        r.phone,
        r.email,
        r.openingHours,
        r.brand,
        r.operator,
        r.placeId,
        r.flags.join("; "),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildReport(context) {
  const { city, startedAt, buckets, categoryCounts, rows } = context;
  const lines = [];
  lines.push("# M0 Geoapify Coverage Spike");
  lines.push("");
  lines.push(`- City: ${city.label} (${city.placeId})`);
  lines.push(`- Run started: ${startedAt}`);
  lines.push(`- Requests: ${state.requests}`);
  lines.push(`- Estimated credits: ${round1(state.credits)} of 3,000/day`);
  lines.push(`- Raw rows: ${rows.length}`);
  lines.push("");
  lines.push("## Bucket summary");
  lines.push("");
  lines.push(
    "| Bucket | Rows | Website (OSM) | Website reachable | Phone | Email | Any channel | Suspected junk | Duplicates | In area | Brand/operator |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const b of buckets) {
    const s = b.summary;
    lines.push(
      `| ${b.label} | ${s.total} | ${s.websitePct}% | ${s.websiteOkPct}% | ${s.phonePct}% | ${s.emailPct}% | ${s.anyChannelPct}% | ${s.junkPct}% | ${s.duplicatePct}% | ${s.inAreaPct}% | ${s.chainPct}% |`,
    );
  }
  lines.push("");
  lines.push("## Gate verdict");
  lines.push("");
  for (const b of buckets) {
    lines.push(`### ${b.label}: ${verdict(b.gates)}`);
    lines.push("");
    lines.push("| Gate | Observed | Result |");
    lines.push("|---|---|---|");
    for (const g of b.gates) {
      lines.push(`| ${g.name} | ${g.value} | ${g.pass ? "pass" : "fail"} |`);
    }
    lines.push("");
  }
  lines.push("## Category results");
  lines.push("");
  lines.push("| Bucket | Category | Returned |");
  lines.push("|---|---|---|");
  for (const row of categoryCounts) {
    lines.push(`| ${row.bucket} | ${row.category} | ${row.returned} |`);
  }
  lines.push("");
  lines.push("## Suspected defunct or stale entries");
  lines.push("");
  const junkRows = rows.filter((r) => isJunk(r, r.flags));
  if (junkRows.length === 0) {
    lines.push("None detected by the heuristics.");
  } else {
    lines.push("| Bucket | Name | Address | Website | Reasons |");
    lines.push("|---|---|---|---|---|");
    for (const r of junkRows.slice(0, 25)) {
      const reasons = r.flags.filter((f) =>
        ["closed_text", "no_address", "website_dead", "duplicate_address"].includes(f),
      );
      lines.push(
        `| ${mdCell(r.bucketLabel)} | ${mdCell(r.name)} | ${mdCell(r.address)} | ${mdCell(r.website)} | ${mdCell(reasons.join(", "))} |`,
      );
    }
    if (junkRows.length > 25) lines.push(`| ... | ${junkRows.length - 25} more in probe.csv | | | |`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- Website present is the OSM/Geoapify `website` field; reachable is a 10s homepage probe with one retry on timeout/network errors.");
  lines.push("- Email and phone come from Place Details (`contact.email`, `contact.phone`).");
  lines.push("- Suspected junk means closed text, missing address, duplicate name+address, or a confirmed-dead site (404/410/DNS/refused). Sparse contact data alone is not junk. Review `probe.csv` before deciding.");
  lines.push("- Credits are an estimate: Places cost 1 credit for up to 20 results plus 1 per 20 after; Details cost 1 each.");
  lines.push("- Next step: stop and review. No M1 work until the report is accepted.");
  if (state.errors.length > 0) {
    lines.push("");
    lines.push("## Errors");
    lines.push("");
    for (const err of state.errors) lines.push(`- ${err}`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

async function main() {
  if (!API_KEY) {
    console.error("GEOAPIFY_API_KEY is missing. Add it to .env and re-run.");
    process.exit(1);
  }
  const startedAt = new Date().toISOString();
  console.log(`Spike city: ${CITY}, ${COUNTRY}`);
  const city = await geocodeCity();
  console.log(`Resolved: ${city.label} (${city.placeId})`);

  const seen = new Set();
  const rows = [];
  const buckets = [];
  const categoryCounts = [];

  for (const bucket of BUCKETS) {
    const bucketRows = [];
    for (const category of bucket.categories) {
      if (bucketRows.length >= TARGET_PER_BUCKET) {
        categoryCounts.push({ bucket: bucket.label, category, returned: 0 });
        continue;
      }
      let found = [];
      try {
        found = await searchCategory(category, city.placeId);
      } catch (err) {
        state.errors.push(String(err.message || err));
        categoryCounts.push({ bucket: bucket.label, category, returned: 0 });
        continue;
      }
      categoryCounts.push({ bucket: bucket.label, category, returned: found.length });
      for (const item of found) {
        if (bucketRows.length >= TARGET_PER_BUCKET) break;
        if (!item.place_id || seen.has(item.place_id)) continue;
        seen.add(item.place_id);
        let details = {};
        try {
          details = await fetchDetails(item.place_id);
        } catch (err) {
          state.errors.push(String(err.message || err));
        }
        const contact = contactOf(details);
        const website = normalizeWebsite(details.website || item.website || null);
        const probe = website ? await probeWebsite(website) : null;
        bucketRows.push({
          bucket: bucket.id,
          bucketLabel: bucket.label,
          category,
          name: details.name || item.name || null,
          address: details.formatted || item.formatted || null,
          city: details.city || item.city || null,
          state: details.state || item.state || null,
          postcode: details.postcode || item.postcode || null,
          website,
          websiteProbe: probe,
          phone: contact.phone,
          email: contact.email,
          openingHours: details.opening_hours || null,
          brand: details.brand || null,
          operator: details.operator || null,
          categories: details.categories || item.categories || [],
          lat: item.lat,
          lon: item.lon,
          placeId: item.place_id,
          flags: [],
        });
      }
    }
    const keys = new Map();
    for (const row of bucketRows) {
      const key = duplicateKey(row);
      keys.set(key, (keys.get(key) || 0) + 1);
    }
    const duplicates = new Set([...keys.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    for (const row of bucketRows) row.flags = flagRow(row, duplicates);
    rows.push(...bucketRows);
    const summary = summarize(bucketRows);
    buckets.push({ label: bucket.label, summary, gates: gatesFor(summary) });
    console.log(
      `${bucket.label}: ${summary.total} rows | website ${summary.websitePct}% (reachable ${summary.websiteOkPct}%) | phone ${summary.phonePct}% | email ${summary.emailPct}% | any ${summary.anyChannelPct}% | junk ${summary.junkPct}% | ${verdict(gatesFor(summary))}`,
    );
  }

  mkdirSync(HERE, { recursive: true });
  writeFileSync(join(HERE, "probe.csv"), buildCsv(rows), "utf8");
  writeFileSync(
    join(HERE, "REPORT.md"),
    buildReport({ city, startedAt, buckets, categoryCounts, rows }),
    "utf8",
  );

  console.log(`Requests: ${state.requests} | estimated credits: ${round1(state.credits)}`);
  if (state.errors.length > 0) console.log(`Errors: ${state.errors.length} (see REPORT.md)`);
  console.log(`Wrote ${join(HERE, "REPORT.md")}`);
  console.log(`Wrote ${join(HERE, "probe.csv")}`);
  console.log("Stop here. Review the report before starting M1.");
}

main().catch((err) => {
  console.error(`Spike failed: ${err.message || err}`);
  process.exit(1);
});
