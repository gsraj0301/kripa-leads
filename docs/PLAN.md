# PLAN — Kripa Lead Discovery and Qualification

Status: M4 extraction and scoring deployed. Next: M5 review.
Last updated: 2026-11-19.

## 1. Objective

Internal dashboard at `leads.kripa.tech` that:

1. Takes an area name and one or more segments from the operator.
2. Discovers businesses in that area from Geoapify (OpenStreetMap data).
3. Validates and deduplicates them, excluding companies already delivered.
4. Enriches from each prospect's own website.
5. Extracts evidence tags with Groq, then computes two deterministic scores in code.
6. Lets a human review, approve, and export a client-side Excel file.

No outreach is sent. No lead is auto-qualified. No prospect is contacted by the system.

## 2. Locked decisions

| Topic | Decision |
|---|---|
| Hosting | Cloudflare, Workers Paid. Single Worker serving API, Workflows, and static assets. |
| Discovery | Geoapify Places + Place Details + Geocoding. Free plan. No Google Places. |
| Frontend | React + TypeScript + Vite + Tailwind. Normal browser app, not a PWA. |
| Auth | Cloudflare Access, One-time PIN (no external IdP). JWT validated with `jose`. |
| Storage | D1 only. No R2. Six tables. |
| Scoring | Two scores: Fit and Contactability, 0-100 each. No composite. |
| Scoring engine | Groq extracts tags and quotes; pure code computes scores. |
| Export | Client-side SheetJS CE, cap 5,000 rows. No server archive. |
| Delivered | Included in an export. Excluded forever unless the per-run toggle is on. |
| Validity | Name plus at least one contact channel. Enrichment = website fetched successfully. |
| Qualification | Human approval only. |
| M0 city | Chennai. |

## 3. Architecture

```
leads-kripa (single Worker)
  /                static assets from apps/web/dist
  /api/*           Hono routes + Access JWT middleware
  LeadRunWorkflow  WorkflowEntrypoint exported from the same Worker
```

Repo layout (created at M1):

```
apps/web                 React + Vite + Tailwind
apps/api                 Hono routes, Access middleware
apps/workflows           LeadRunWorkflow class
packages/shared          zod schemas, Geoapify client, SSRF guard, scoring, providers
packages/db              D1 migrations, queries
docs/PLAN.md             this file
spikes/geoapify_probe.mjs  M0 only, not production code
```

## 4. Data model

Six tables. All configuration lives in `settings`; nothing scoring-related is hardcoded.

### `runs`
`id`, `area`, `resolved_place_id`, `resolved_area_label`, `segment_ids_json`, `include_previously_delivered`, `plan_json`, `segments_snapshot_json`, `scoring_snapshot_json`, `scoring_config_version`, `status` (`draft|planned|approved|discovering|enriching|scoring|review|exported|failed|paused`), `counts_json`, `created_at`, `approved_at`, `approved_by`.

`counts_json` holds `raw`, `valid`, `enriched`, `not_scored`, `scored`, `below_floor`, `review`, `qualified`, `exported`, `credits_used`, `tokens_in`, `tokens_out`, `extraction_calls`, `extraction_failures`, `quote_failures`.

### `prospects`
`id`, `run_id`, `segment_id`, `source`, `source_id`, `company_key`, `name`, `category`, `address`, `city`, `phone`, `website`, `email`, `lat`, `lng`, `status` (`raw|valid|enriched|not_scored|scored|review|qualified|rejected|below_floor`), `fit_score`, `fit_band`, `contactability_score`, `contactability_band`, `tags_json`, `facts_json`, `score_explain_json`, `score_config_version`, `needs_manual_contact_research`, `provenance_json`, `enrichment_json`, `created_at`, `updated_at`.

`provenance_json` maps each field to `{source, source_url, retrieved_at, kind: verified|extracted|assumed}`.

### `deliveries`
`company_key` (primary key), `first_run_id`, `first_delivered_at`, `last_run_id`, `last_delivered_at`.

### `events`
`id`, `run_id`, `prospect_id`, `type`, `actor_email`, `payload_json`, `created_at`. Includes `lead_label` events for calibration.

### `settings`
`key`, `value_json`, `updated_at`, `updated_by`. Holds segments, rubric points, floors, budgets, retention, do-not-contact list reference, geocode cache.

### `exports`
`id`, `run_id`, `row_count`, `created_at`, `actor_email`.

## 5. Pipeline

1. **Plan.** Operator enters area and segment(s). Client calls Geocoding, shows candidates if confidence is low, stores `resolved_place_id`. Plan shows estimated provider credits, Groq tokens, and minutes. Human approves; snapshot is frozen.
2. **Discovery.** For each segment category: Places query with `filter=place:<resolved_place_id>`, `limit=500` (paged). Dedupe by `place_id`, then by `company_key` (normalized domain, else E.164 phone, else name+city). Drop `deliveries` unless the toggle is on. Store `raw` with provenance.
3. **Validation.** Require name plus at least one of phone, website, email. Assign `valid`; write counts. No silent drops.
4. **Enrichment.** Fetch up to 3 same-registrable-domain pages. SSRF guard: manual redirects, DoH A/AAAA checks, block private and link-local ranges. Extract facts with HTMLRewriter: HTTP status, HTTPS, final URL, emails, phones, contact form, social links, copyright year. Respect `robots.txt` via `caches.default`. Per-page timeout 10s, per-prospect budget 60s. Failure degrades to `enriched` with partial facts.
5. **Extraction.** Groq reads 3,000 chars of usable text and returns tags with verbatim quotes. Quote verification runs in code; failed quotes force the tag false.
6. **Scoring.** `scoreProspect(tags, facts, config)` runs pure. Writes two scores, bands, and `score_explain_json`.
7. **Review.** Human approves or rejects. `qualified` only by human action. `below_floor` stays visible, never deleted.
8. **Export.** Client downloads xlsx; server records `exports` and upserts `deliveries`.

Workflow granularity: one instance per run; steps batch 20-25 prospects to stay under the 1 MiB step-result cap; `step.do` retries with idempotency keys.

## 6. Discovery provider

Verified against Geoapify documentation on 2026-11-18:

- Places search: `GET /v2/places`, max 500 per page, `filter=place:<id>` bounds results to the resolved area.
- Contact fields come from Place Details (`GET /v2/place-details`): `website`, `contact.phone`, `contact.email`, `opening_hours`, `brand`, `operator`, `description`.
- Credits: Places costs 1 credit for up to 20 results, plus 1 per additional 20; Place Details costs 1 credit; Geocoding 1 credit.
- Free plan: 3,000 credits/day, 5 requests/second. FAQ allows commercial use in production with attribution. Terms say "with some limitations in the production phase" — Kripa sign-off pending.
- Required attribution: OSM always; Geoapify mandatory on the free plan.

Fallback options, documented but not built now: Open Places API (hosted Overture, ~$2 per 1,000 searches after 2,500 free), Overture offline (CDLA-Permissive, batch ETL), self-hosted Overpass. Foursquare Places API is excluded by its terms; Brave Search cannot persist results on the self-serve plan.

### Attribution wording

Footer:

> Business data © OpenStreetMap contributors (ODbL) · Powered by Geoapify

Excel `Sources` sheet and row 1 of `Prospects`:

> Place data sourced from OpenStreetMap via Geoapify. © OpenStreetMap contributors, available under the Open Database License (ODbL): https://www.openstreetmap.org/copyright. Place search and geocoding powered by Geoapify: https://www.geoapify.com/. Fields marked `enriched` come from the prospect's own website; each carries its source URL and retrieval date in the `Provenance` column.

## 7. Segments

Segment selection happens at plan time. Each segment is configuration and owns its discovery categories, tag schema, weights, flags, solo policy, and floor.

| Segment | Status | Discovery categories | Buyer |
|---|---|---|---|
| `ca_firm` | Parked for MVP (M0: no usable CA data in Geoapify) | `office.accountant`, `office.tax_advisor`, `office.financial_advisor` | Accounting practices buying white-label capacity |
| `msme` | Enabled at M1 (M0 passed) | `office.company`, `office.it`, `commercial` | Indian MSMEs, funded startups, proprietors |
| `manufacturer_distributor` | Disabled template | `production.factory`, `commercial.trade`, `office.company` | Manufacturers and distributors, pending Kripa confirmation |

Verified against Geoapify's category list: there is no wholesale or distributor category; `commercial.trade` is the proxy. `production.factory` is the manufacturer category. The earlier guess is corrected.

M0 finding: the CA-firm categories have only 4 places in Chennai and 180 `office.accountant` places in a rect covering India and neighbours. Geoapify/OSM cannot supply a CA-firm segment at the 100-lead scale. `msme` was re-based on `office.company`, `office.it`, and `commercial`, which have volume in Chennai (see `spikes/DIAGNOSTICS.md`).

`msme` size bands follow Kripa's published plans: Nano (proprietor/dormant), Starter (< INR 2 cr), Growth (INR 2-15 cr), Scale (INR 15-50 cr), Enterprise (INR 50 cr+).

Segment tags describe what each buyer *needs*, not what a CA firm advertises. `msme` tags include entity type, GSTIN count, payroll headcount, multi-state or export mentions, funding, audit mentions, years in business. `ca_firm` tags include advertised services, partner/team page, client volume, locations, tenure.

## 8. Scoring

### Fit (0-100)

| Component | Max | Rule |
|---|---|---|
| Service fit | 50 | Sum of matched segment tag points, capped at 50. Tag points configured per segment. |
| Size and scale | 25 | Headcount band 15 (1 -> 0, 2-4 -> 8, 5-50 -> 15, 51-200 -> 10, >200 -> 4) + office locations 10 (1 -> 0, 2-3 -> 3, 4+ -> 5) + 5 for unknown coverage handled by the unknown rule. |
| Tenure and named people | 15 | Founding year 8 (>= 5y -> 8, 2-4y -> 5, < 2y -> 0) + team/partners page 7. |
| Geography | 10 | In boundary 10, adjacent 5, outside 0. Computed from provider address, never from model output. |

### Contactability (0-100), segment independent

| Component | Max | Rule |
|---|---|---|
| Reachable channel | 40 | Format-valid phone 25 + published email 15 (role) or 10 (personal); capped at 40. |
| Working site | 30 | 200 + HTML + HTTPS 30; HTTP-only 15; redirect to unrelated domain 5; dead 0. |
| Contact path | 20 | Contact page or form 12 + at least one social profile 8. |
| Freshness | 10 | Copyright year current 10; current-1 6; current-2 3; else 0. |

### Observability, missing data, and `not_scored`

- `observed_false`: a successfully read page was searched and the signal is absent. Scores 0. Service fit always uses this when text exists.
- `not_observable`: the signal cannot be determined. Unknown credit is allowed only for Size and Tenure sub-signals, capped at 50% of that sub-signal's maximum. Never for Service fit or Geography.
- `not_scored`: no usable text (fetch failure, non-HTML, JS shell, or fewer than 400 chars after boilerplate strip). Both scores null. No unknown credit. Shown in a separate list with the reason and `needs_manual_contact_research`.

Every component stores `observation` and the reason, so the UI distinguishes "not stated" from "site unreadable".

### Negative signals

Configured per segment, two modes:

- `exclude`: clamp Fit to 0 and set band `excluded`. Used for directory/aggregator listings and defunct or closed signals.
- `deduct`: additive after components, then clamped to 0-100. Defaults: franchise or chain -30, enterprise brand -15.

No other hidden caps. Solo practitioners get no cap by default (`solo_policy: off`); Kripa can later set a deduction or cap as configuration.

### Gate and ranking

- No Contactability gate. Validity already requires one channel.
- Per-segment `fit_floor`, provisional 40 until the M0 spike calibrates it.
- Everything at or above the floor is exportable, sorted Fit descending then Contactability descending, with both bands visible.
- Below floor is `below_floor`, visible with explanations, not rejected or deleted.
- `needs_manual_contact_research` when no verified email or phone from the site, or Contactability below 40. Filterable, never disqualifying.
- `qualified` is human-only.

### Quote verification

For every tag with `present: true`, NFKC-normalize, lowercase, and collapse whitespace on both the quote and the full fetched text. Substring check. Miss -> tag false, `verified: false`, event `quote_unverified`. Per-run failure rate above 5% raises a run warning. Raw stored tags also record a `verified_quote` boolean.

## 9. Extraction with Groq

Schema is compact: short tag keys, booleans with one quote each (max 120 chars), integer counts, and flags. Example:

```json
{"tags":{"bookkeeping":{"p":true,"q":"monthly bookkeeping and bank reconciliation"},"gst":{"p":true,"q":"GSTR-1 and GSTR-3B filing"}},
 "counts":{"team":7,"offices":2,"founded":2011},
 "flags":{"directory":false,"franchise":false,"enterprise":false,"solo":false}}
```

Limits and accounting:

- Input: 3,000 chars of page text (~750 tokens) plus ~350 tokens of instructions/schema, output ~200 tokens. About 1,300 tokens per prospect.
- 100 prospects is ~130,000 tokens. Run hard budget 140,000. Free tier TPD is 200,000, leaving ~60,000 for the spike and one retry pass, including developer testing.
- TPM 8,000 means roughly 6 calls/min; 100 prospects takes 17-20 minutes.
- Count real `usage.total_tokens` from responses into `runs.counts_json` and a daily quota row. Do not estimate.
- If remaining quota cannot cover the next batch, `step.sleep` until the next UTC day and resume. Sleeping instances do not consume Workflow concurrency.
- 429 handling: honour `retry-after`, exponential backoff, idempotent per-prospect steps.
- Provider interface `ExtractionProvider.extract(text, schema)` with a Groq implementation, so Workers AI or another provider can replace it without pipeline changes.

Commercial use: the website Terms of Use exclude GroqCloud; the Groq Services Agreement governs and permits building a Customer Application on the service, provides for fee-free usage, and states Inputs/Outputs are not used for training. This is a reading, not legal advice. Kripa signs off in writing before production; the sign-off cites the agreement URL and date.

## 10. Export

Client-side SheetJS CE (`@e965/xlsx`). `XLSX.write({type:"array",bookType:"xlsx"})`. Cap 5,000 rows.

Sheets: `Prospects` (attribution note in row 1; Fit and Contactability scores and bands; top score evidence; provenance per field), `Sources`, `Run Summary` (counts, shortfall, config version, provider credits and tokens used).

Shortfall: if valid prospects are below the requested target, report the gap and offer widening options (expand area, add categories, lower the floor). Never pad.

On export, server records `exports`, upserts `deliveries`, and sets `run.status = exported`.

## 11. Auth

Cloudflare Access in front of `leads.kripa.tech`. One-time PIN for the initial user set; no external IdP. The Worker validates `Cf-Access-Jwt-Assertion` with `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking issuer and `CF_ACCESS_AUD`. `ctx.access` is not used because static assets are served by the same Worker. Every mutation records `actor_email` from the verified JWT.

## 12. Retention, privacy, legal

- Deliveries: forever, company key plus name and domain only.
- Rejected prospects and enrichment text: 12 months.
- Raw provider payloads: 90 days.
- Events: 12 months. Run and export metadata: 24 months.
- Monthly purge Workflow.
- Store business channels only; prefer role addresses. Honour deletion requests within 30 days. Maintain `do_not_contact`, checked at export.
- Outbound calls, personal mobile numbers, or exporting outside the firm would require a DPDP Act 2023 review. Not in MVP scope.

## 13. Milestones

### M0 — Geoapify coverage spike (current)

Script: `spikes/geoapify_probe.mjs`, no production code. City: Chennai. Two buckets, same gates:

| Bucket | Categories |
|---|---|
| CA firms | `office.accountant`, `office.tax_advisor`, `office.financial_advisor` |
| General business | `office.company`, `office.it`, `commercial` |

Up to 50 results per category, deduped, capped at 100 per bucket. Place Details for every deduped place, then a 10-second homepage probe with one retry on timeout/network errors. Writes `spikes/REPORT.md` and `spikes/probe.csv`.

Gates per bucket:

- Rows >= 100
- Website present in OSM >= 40%
- Any contact channel >= 60%
- Suspected junk <= 15%
- Address in area >= 80%

Suspected junk means closed text, missing address, duplicate name+address, or a confirmed-dead site (404/410/DNS/refused). Sparse contact data is reported separately, not counted as junk.

M0 outcome (2026-11-18, Chennai, 114 requests / ~115 credits):

| Bucket | Rows | Website | Reachable | Phone | Email | Any channel | Junk | Verdict |
|---|---|---|---|---|---|---|---|---|
| CA firms | 4 | 25% | 25% | 25% | 0% | 25% | 0% | FAIL |
| General business | 100 | 58% | 46% | 45% | 17% | 63% | 8% | PASS |

CA firms fail because the source data is absent, not because of the probe or boundary filter; see `spikes/DIAGNOSTICS.md`. Decision: CA firms are parked for the MVP. The MSME segment ships; `ca_firm` stays as disabled configuration until a data source (ICAI directory or a licensed provider) is agreed.

### M1 — Skeleton

Implemented locally (not deployed yet):

- npm workspaces: `apps/web`, `apps/api`, `apps/workflows`, `packages/shared`, `packages/db`. One Worker entry (`apps/api/src/index.ts`) serves `/api/*` and static assets; `LeadRunWorkflow` is exported as a stub.
- D1 schema `0001_init.sql` for the six tables. Settings are bootstrapped lazily from `DEFAULT_SETTINGS_CONFIG` in `@kripa/shared` (`INSERT OR IGNORE`), so defaults live in one place instead of a duplicated SQL seed.
- Access JWT middleware (`jose`, remote JWKS, issuer/audience checks) with a dev-only bypass that refuses to run outside `ENVIRONMENT=development`.
- Endpoints: `GET /api/health`, `GET /api/me`, `GET /api/segments`, `GET /api/settings`, `PUT /api/settings` (bumps `configVersion`, returns to provisional), `POST /api/settings/approve`.
- Provisional metadata (`approved`, `provisional`, `provisionalReason`) is stored and shown in the web shell. Any config update clears approval.
- Web shell shows session, enabled segments, config version, fit floor, and the provisional banner.
- Verification: `npm run typecheck`, 9 Vitest unit tests (JWT verification, defaults/schema), and `npm run smoke` against real local D1 + Worker.

Deployed: remote D1 `leads-kripa` created; migration applied; `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` set as Worker secrets; `leads.kripa.tech` custom domain attached and protected by Cloudflare Access OTP.

### M2 — Discovery

Implemented and deployed:

- Area input with Geoapify Geocoding candidates and optional country filter; plan shows selected segments and a worst-case credit estimate.
- Segment categories drive Geoapify Places queries with 500-result paging, 429/5xx retry, and rate limiting from settings.
- Place Details supplies website/phone/email; raw payloads and per-field provenance are stored.
- Dedupe by `place_id` then company key (normalized domain, else E.164 phone, else name+city); `deliveries` exclusion unless the per-run toggle is on.
- Run creation snapshots selected segments and rubrics; start triggers the `LeadRunWorkflow` instance; statuses `planned`/`discovering`/`completed`/`failed`; raw/valid/invalid/credit counts are persisted.
- Daily credit budget is checked before planning and enforced by the client during discovery.

Verified locally against live Geoapify with a 2-result-per-category Chennai run: 6 raw/valid prospects, 9 credits, workflow completed.

### M3 — Enrichment

Implemented and deployed:

- Settings `enrichment`: max pages per prospect (3), page timeout (10s), prospect budget (60s), concurrency (4), redirect cap, HTML byte cap, total text cap, minimum usable text, robots cache TTL, user agent. Defaults are applied to older stored settings.
- SSRF guard: manual redirects with per-hop validation, DoH A/AAAA resolution via `cloudflare-dns.com`, blocked loopback/private/link-local/CGNAT/multicast/reserved IPv4 and IPv6 (including mapped, NAT64, 6to4 and Teredo forms), credentials and non-standard ports rejected, hostname suffix blocklist, fail closed on DNS failure.
- `robots.txt`: fetched through the same SSRF path, cached with `caches.default`, longest-match Allow/Disallow with wildcard and `$`, 403 treated as full disallow, 4xx/5xx fail open with the reason recorded.
- HTML extraction: two-pass HTMLRewriter. The first pass strips script/style/noscript/svg/template and collects title, description, links, forms, `mailto`/`tel` and social links; the second pass reads visible text from the cleaned markup. Phone numbers require a `tel:` link or nearby phone/call/mobile/contact context, which avoids numeric false positives.
- Page selection: homepage plus up to two same-registrable-domain contact/about/team pages, same-host pages ranked first, auth/privacy/file URLs skipped.
- Facts and provenance: status, final URL, HTTPS, content type, redirects, reachable, emails, phones, socials, contact form, copyright year, text length and usability, per-page errors, robots block. Provenance entries are `verified` with source page and retrieval time.
- Workflow: discovery then `enriching`, 20-prospect `enrich-batch-N` steps with a persisted max-concurrency config, idempotent retries, final summary counts and `run_enriched`. Site fetch failures stay `enriched` with partial facts; prospects without a website stay `valid` and are counted separately.
- Counts: `enriched`, `enrichmentFailures`, `pagesFetched`, `skippedNoWebsite`, `robotsBlocked`.
- Verification: typecheck clean, 36 unit tests, smoke, and a live local Chennai run (6 valid, 6 enriched, 6 pages, 3 site failures) against real websites. Deployed as Worker version `6c28e0ab-9bf7-4657-844c-03f890b6e75f`; Access still gates the domain.

### M4 — Extraction and scoring

Implemented and deployed:

- Settings `extraction`: enabled, Groq model (`openai/gpt-oss-120b`), input cap 3,000 chars, output cap 800 tokens, temperature 0, `reasoningEffort` (low/medium/high, default low), timeout, retries, `minIntervalMs` 10s, daily and per-run token budgets, estimated tokens per prospect. Settings `scoring`: Fit/Contactability bands, manual-research threshold, role-email prefixes. Segments carry `tagDefinitions` and `soloCap`; rubric subcomponent points are configurable and validated against component maxima.
- Groq provider behind `ExtractionProvider`: compact JSON mode, one fallback without `response_format` when Groq rejects JSON validation, 429/5xx retry with backoff, quota detection, and real `usage` totals returned to the workflow.
- Prompt limits input to usable page text and requires a verbatim quote for every present tag. Code verifies quotes after NFKC normalization, lowercasing and whitespace collapse; a failed or missing quote forces the tag false and records `quote_unverified`. Over 5% failures raises a run warning.
- Pure `scoreProspect`: Fit from verified service tags, size (`headcount`, `offices`), tenure (`founded`, configured team-page signal) and geography; Contactability from reachable channel, working site, contact path and freshness. Unknown credit only for size and tenure; service fit never gets unknown credit. Negative flags exclude or deduct; solo policy `off`/`cap`/`exclude`. Fit floor is checked before bands. Statuses: `scored`, `below_floor`, `not_scored`; no usable text yields both scores null.
- `needs_manual_contact_research` when the site supplies no email or phone or Contactability is below the configured threshold. Explain JSON records component points, maxima, observation, reason, negative flags, solo policy and verified tag evidence.
- Workflow: discovery -> enrichment -> `scoring`. Per-prospect `score-prospect-N` steps extract and score idempotently. Daily quota shortfall pauses with `step.sleepUntil` at the next UTC midnight; run-budget shortfall marks remaining enriched prospects `not_scored` with reason `run_token_budget`; missing/unusable text is marked `not_scored` with `no_usable_text`.
- Counts/events: `scored`, `belowFloor`, `notScored`, `tokensIn`, `tokensOut`, `extractionCalls`, `extractionFailures`, `quoteChecks`, `quoteFailures`; `groq_usage`, `prospect_scored`, `quote_unverified`, `run_warning`, `run_scored`.
- Web UI shows scoring counts, token usage, quote failures and an explain panel with component breakdown and verified evidence.
- Verification: typecheck clean, 54 unit tests, smoke, and a live local Chennai run: 6 valid, 3 enriched, 3 site failures, 3 below floor, 3 not scored, 3,986 tokens, 1 quote check with 0 failures, 9 credits. Groq extraction now completes with low reasoning effort and an 800-token output cap. Deployed as Worker version `3d2f3245-ae0b-4a2b-9642-b7837c7ceab3`; `GROQ_API_KEY` set as a Worker secret; Access still gates the domain.

### M5 — Review

Two scores and bands; evidence quotes; `needs_manual_contact_research` filter; approve/reject; below-floor and not-scored views; events.

### M6 — Export

Client xlsx with attribution and provenance; deliveries write; include-previously-delivered toggle; exports audit; shortfall and widening options.

### M7 — Calibration and hardening

Kripa labels ~20 prospects good/bad. Present as a sanity check, not proof: 70% top-half agreement is 20 points above chance and noisy at n=20. Any disagreement is fixed by editing weights in settings and re-scoring stored tags, never by code changes. Book the 60-90 minute labeling session when M1 starts, targeting the day after the first export. Also: purge job, run warnings, README.

## 14. Open questions

1. Access allowlist: `gsraj0301@gmail.com` is configured; add Kripa's users before rollout.
2. Kripa sign-off on Geoapify terms and attribution wording.
3. Kripa sign-off on the Groq commercial-use reading.
4. Post-MVP: choose a CA-firm data source (ICAI directory access or a licensed provider); segment is parked until then.
5. `msme` categories approved for build (`office.company`, `office.it`, `commercial`).
6. Confirm whether `manufacturer_distributor` is a real target.
7. Weights, `fit_floor` 40, solo `off`, and retention are approved for build but stored as provisional/versioned pending Kripa's sign-off.
8. Book the labeling session date.
9. Which city after Chennai for the first real run.

## 15. Verification log

| Date | Item | Result |
|---|---|---|
| 2026-11-18 | Geoapify free plan commercial use | Pricing FAQ: allowed in production with attribution. Terms: "with some limitations"; sign-off pending. |
| 2026-11-18 | Geoapify credits | Places 1 credit <= 20 results, +1 per 20; Details 1 credit; Geocoding 1. |
| 2026-11-18 | Geoapify categories | `office.accountant`, `office.tax_advisor`, `office.financial_advisor`, `office.company`, `commercial.trade`, `production.factory` verified. No wholesale/distributor category. |
| 2026-11-18 | Groq limits | gpt-oss-120b free: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD. |
| 2026-11-18 | Groq terms | Services Agreement permits Customer Applications; no training on Inputs/Outputs; website ToU excludes GroqCloud. Reading only, not legal advice. |
| 2026-11-18 | Workflow sleep | `step.sleep` up to 365 days; waiting instances do not count against concurrency. |
| 2026-11-18 | kripa.tech positioning | Serves Indian MSMEs, funded startups, and CA firms; plan tiers give size bands. |
| 2026-11-18 | M0 coverage (Chennai) | MSME bucket: 100 rows, 58% website, 46% reachable, 63% any channel, 8% junk — PASS. CA bucket: 4 rows — FAIL. |
| 2026-11-18 | OSM CA coverage | `office.accountant` = 1 in Chennai, 180 in a rect covering India + neighbours; `office.tax_advisor` = 2 / 55; `office.financial_advisor` = 1 / 0. Boundary filter not the cause. |
| 2026-11-18 | CA segment decision | Parked for MVP; `ca_firm` remains disabled configuration. MSME segment proceeds. |
| 2026-11-18 | M1 local verification | Typecheck clean; 9 unit tests pass; smoke test covers health, dev session, settings bootstrap/update/approve, invalid input (400), API 404, and static shell against real D1. |
| 2026-11-18 | M1 deploy | Remote D1 `leads-kripa` created, migrations applied, Access secrets set, `leads.kripa.tech` custom domain attached, Worker deployed. |
| 2026-11-18 | M2 verification | Typecheck clean; 16 unit tests pass; smoke covers geocode/run validation; live local workflow run returned 6 valid prospects for 9 credits. |
| 2026-11-19 | M3 verification | Typecheck clean; 36 unit tests pass; smoke covers settings enrichment defaults; live local Chennai run: 6 valid, 6 enriched, 6 pages, 3 site failures, 9 credits. Website text no longer includes script/style content; phone extraction is context-scoped. |
| 2026-11-19 | M3 deploy | Worker `6c28e0ab-9bf7-4657-844c-03f890b6e75f` deployed; no new migration; `leads.kripa.tech` and `/api/health` still 302 to Access. |
| 2026-11-19 | M4 verification | Typecheck clean; 54 unit tests pass; smoke covers extraction/scoring defaults; live local Chennai run: 6 valid, 3 enriched, 3 below floor, 3 not scored, 3,986 tokens, 1/1 verified quotes, 9 credits. |
| 2026-11-19 | Groq JSON validation | `openai/gpt-oss-120b` returned `json_validate_failed` with empty generation at a 400-token cap. Low reasoning effort plus an 800-token cap fixed it; a retry without `response_format` is retained as fallback. |
| 2026-11-19 | M4 deploy | Worker `3d2f3245-ae0b-4a2b-9642-b7837c7ceab3` deployed; no new migration; `GROQ_API_KEY` set; `leads.kripa.tech` and `/api/health` still 302 to Access. |
