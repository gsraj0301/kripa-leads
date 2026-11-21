# Kripa Leads

Internal lead discovery and qualification tool for Kripa Associates, served at `leads.kripa.tech`. It finds businesses in a chosen area, enriches from their own websites, scores them on two separate axes (Fit and Contactability), and exports a reviewed Excel sheet. It does not send outreach. Nothing auto-qualifies and nothing auto-contacts.

## Status

M1–M4 implemented and deployed at `leads.kripa.tech` behind Cloudflare Access. Next milestone: M5 review.

## Tech stack

- **Runtime:** Node 18.19, Wrangler 3.114.17 (do not use Wrangler 4 — needs Node 22)
- **Language:** TypeScript (ES modules), npm workspaces
- **Worker:** Single Cloudflare Worker serving API (`/api/*`), Workflows (`LeadRunWorkflow`), and static assets (`apps/web/dist`)
- **Storage:** Cloudflare D1 (`leads-kripa`, database `2ffe66f7…`), six tables: `runs`, `prospects`, `deliveries`, `events`, `exports`, `settings`
- **Providers:** Geoapify (Places, Place Details, Geocoding — free tier), Groq (`openai/gpt-oss-120b` extraction), Cloudflare Access (JWT OTP auth)
- **Frontend:** React + Vite + Tailwind

## Repo layout

```
apps/api         Hono API routes + Access JWT middleware
apps/web         React shell (plan screen, run list, scoring explain panel, export)
apps/workflows   LeadRunWorkflow: discovery -> enrichment -> scoring -> completed
packages/shared  Zod schemas, Geoapify client, SSRF guard, scoring, Groq provider, coverage
packages/db      D1 migrations + queries (runs, prospects, deliveries, events, exports, settings)
docs/PLAN.md     Full product plan and pipeline spec
spikes/          M0 Geoapify coverage diagnostics (not production code)
```

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Local smoke | `npm run smoke` |
| Local Worker dev | `npm run dev` (needs `.dev.vars`) |
| Apply D1 migrations local | `npx wrangler d1 migrations apply leads-kripa --local` |
| Apply D1 migrations remote | `npx wrangler d1 migrations apply leads-kripa --remote` |
| Deploy | `npm run deploy` |

## Required secrets

`GEOAPIFY_API_KEY`, `GROQ_API_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`. Local scripts read `.env`; Wrangler reads `.dev.vars` (same keys, plus `ENVIRONMENT=development` and `AUTH_DEV_BYPASS=true`). Never commit `.env` or `.dev.vars` — both are gitignored. Strip surrounding quotes before copying a key into `.dev.vars` or piping to `wrangler secret put`.

## Pipeline

1. **Plan** — operator enters area + segment(s); geocode via Geoapify; plan shows estimated credits, Groq tokens, and minutes; human approves and freezes a settings snapshot.
2. **Discovery** — Geoapify Places per category (paged to 500), Place Details for contacts, dedupe by `place_id` then company key, exclude previously delivered unless the per-run toggle is on.
3. **Validation** — require name + at least one contact channel (phone/website/email).
4. **Enrichment** — fetch up to 3 same-domain pages (homepage + contact/about/team), SSRF guard via DoH, robots.txt via cache, extract facts with HTMLRewriter (two-pass).
5. **Extraction** — Groq reads up to 3,000 chars of budgeted per-page text and returns tags with verbatim quotes; code verifies each quote appears in the text; failed quotes force the tag false.
6. **Scoring** — pure `scoreProspect`: Fit (verified service tags, size, tenure, geography) and Contactability (reachable channel, working site, contact path, freshness), each 0–100. Unknown credit only for size and tenure.
7. **Review** — human approve/reject; `qualified` only by human action.
8. **Export** — client-side SheetJS XLSX with Prospects, Sources (attribution), and Run Summary sheets; gated behind `settings.exports.enabled` (off by default) and a logged admin toggle event.

## Segments

- `msme` (enabled): Indian MSMEs, funded startups, proprietors — categories `office.company`, `office.it`, `commercial`.
- `ca_firm` (parked): no usable CA data in Geoapify at scale.
- `manufacturer_distributor` (disabled template).

## Calibration (this branch)

Items on `feature/m4-extraction-scoring-calibration`:
1. Budgeted per-page extraction snippets instead of a flat 3,000-char slice.
2. Code-based fact extraction (founding year, headcount, office count) with source URL + matched quote; LLM counts keep quote verification.
3. Pre-enrichment enterprise/chain filter: any `brand:wikidata` tags the row as a chain (generic rule), plus config-driven brand/operator name list.
4. `fetch` classifies NXDOMAIN (DoH status 3) as `dead_site` and retries SERVFAIL / connection-lost / timeout once.
5. Extraction prompt forbids ellipses; typo/typographic-quote normalization added.
6. `manufacturing` / `distribution_network` tag definitions tightened to company-own statements.
7. M6 Excel export gated behind `settings.exports.enabled`, logged as a separate `exports_toggled` admin event (who/when/note); tested at 0, 1, and 500 rows; `@e965/xlsx` pinned; `npm audit --production` clean.
8. Plan screen shows expected raw/valid/enriched/scored/above-floor counts for a target of 100 valid, labeled "observed in N runs / cities".

## Verification

- `npm run typecheck` — clean across all workspaces.
- `npm test` — 74/74 unit tests pass.
- `npm run smoke` — passes against real local D1 + Worker.

## Attribution (mandatory)

Business data © OpenStreetMap contributors (ODbL) · Powered by Geoapify. Every export carries the Sources sheet and the attribution note in row 1 of Prospects. Geoapify/OSM attribution wording is pending Kripa's written sign-off.

## Pending sign-offs

- Geoapify terms and attribution wording (in writing).
- Groq commercial-use reading (Services Agreement).
- Default rubric weights, `fit_floor` 40, solo policy `off`, retention numbers.
- First real city after Chennai; Kripa's labeling session.

## Deploy

Do not deploy without Kripa's approval. `npm run deploy` builds web assets and runs `wrangler deploy`. Deployed Worker versions are tracked in `docs/PLAN.md` §15 (verification log).