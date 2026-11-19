# AGENTS.md

Durable constraints for this repository. Read `docs/PLAN.md` before changing anything.

## Project

Internal lead discovery and qualification tool for Kripa Associates, served at `leads.kripa.tech`. It finds businesses in a chosen area, enriches from their own websites, scores them on two separate axes, and exports a reviewed Excel sheet. It does not send outreach.

Status: M1-M3 deployed at `leads.kripa.tech`. Access JWT middleware, D1 schema, settings API, Geoapify geocoding/Places/Details discovery, dedupe, delivery exclusion, run counts, credit budget, and website enrichment with SSRF guard, robots handling, HTMLRewriter facts and provenance are implemented. The web app can plan, start, and monitor discovery plus enrichment runs. Scoring, review, and export (M4-M6) remain.

Runtime: Node 18.19 with Wrangler 3.x. `@cloudflare/vitest-pool-workers` cannot resolve module paths containing spaces, so tests are plain Vitest unit tests plus `scripts/smoke-local.sh` (real D1 + Worker over HTTP).

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| M0 coverage spike | `node spikes/geoapify_probe.mjs` |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Local end-to-end smoke | `npm run smoke` |
| Local Worker dev | `npm run dev` |
| Web dev server (proxies `/api` to :8787) | `npm run dev:web` |
| Apply D1 migrations locally | `npx wrangler d1 migrations apply leads-kripa --local` |
| Apply D1 migrations remote | `npx wrangler d1 migrations apply leads-kripa --remote` |
| Deploy | `npm run deploy` |

Secrets: local scripts read `.env`; Wrangler reads `.dev.vars` with the same keys. Never commit either file. `.dev.vars` also carries `ENVIRONMENT=development` and `AUTH_DEV_BYPASS=true` for local login; production must use `ENVIRONMENT=production` with no bypass and `wrangler secret put` for the Access values.

Required keys: `GEOAPIFY_API_KEY`, `GROQ_API_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.

## Invariants

- Never hardcode categories, tag points, scoring weights, floors, budgets, or credentials. All of it lives in `settings` (segments, rubric, thresholds) or environment variables.
- Every prospect belongs to exactly one segment. Scoring loads that segment's rubric snapshot. Adding a segment is configuration, not code.
- Two scores only: `fit_score` and `contactability_score`, each 0-100. No composite score unless explicitly requested.
- Scoring is a pure function of stored tags, facts, and a versioned config snapshot. The model extracts evidence; code computes numbers.
- Three observability states per component: `observed_true`, `observed_false`, `not_observable`. Unknown credit is allowed only for size and tenure. Service fit never gets unknown credit.
- No usable page text means `not_scored` (both scores null). Never fabricate 50/100 for a dead site.
- A tag marked present must carry a quote that appears verbatim in the fetched page text. Verify in code; a failed check makes the tag false.
- Aggregators and defunct signals are exclusions (`fit = 0`), not additive deductions. No hidden caps that silently discard solos.
- Validity is `name + at least one contact channel`. Enrichment is `website fetched successfully`. Report counts separately.
- Delivered means included in an export. Exclude those companies from future runs forever unless the per-run `include_previously_delivered` toggle is on.
- `qualified` requires human approval. Nothing auto-qualifies and nothing auto-contacts.
- Provenance on every stored field: source, source URL, retrieved at, and one of `verified` (code-observed), `extracted` (model-extracted with quote), `assumed`.
- If a number cannot be met, report the shortfall and offer widening options. Never pad the list.
- Fixtures are allowed for provider responses. Mock data must never appear in production code paths.

## Budgets

- Geoapify free tier: 3,000 credits/day. Estimate before a run, count actual usage, abort before exceeding.
- Groq free tier: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD. Per-prospect input capped at 3,000 chars. Run token budget defaults to 140,000. Pause with `step.sleep` until the next UTC day when quota is short.
- Dev and test runs use recorded fixtures. Only the M0 spike and a real run spend live quota.

## Attribution

- UI footer: `Business data © OpenStreetMap contributors (ODbL) · Powered by Geoapify` with both links.
- Every export carries the `Sources` sheet and the attribution note in row 1 of `Prospects`.
- Geoapify attribution is mandatory on the free plan; OSM attribution is always mandatory.

## Data and privacy

- Store business contact channels only; prefer role addresses over named personal addresses.
- Maintain a `do_not_contact` suppression list checked at export. Honour deletion requests within 30 days.
- Retention: deliveries forever (company key only), rejected prospects and enrichment text 12 months, raw provider payloads 90 days, events 12 months, run and export metadata 24 months.

## Pending sign-offs

- Kripa to confirm Geoapify terms and attribution wording in writing.
- Kripa to confirm the Groq commercial-use reading (Services Agreement, free tier).
- Kripa to approve default rubric weights, `fit_floor`, retention numbers, and Solo policy (`off`).
- Book Kripa's 60-90 minute hand-labeling session when M1 starts.
