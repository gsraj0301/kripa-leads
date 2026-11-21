# Kripa Leads

A lead discovery and qualification tool that finds businesses in a chosen area, enriches them from their own websites, scores them on two separate axes (Fit and Contactability), and exports a reviewed Excel sheet. It does not send outreach — nothing auto-qualifies and nothing auto-contacts.

## Tech stack

- **Runtime:** Node.js, TypeScript (ES modules), npm workspaces
- **Worker:** Single Cloudflare Worker serving API routes, Workflows, and static assets
- **Storage:** Cloudflare D1 — six tables: runs, prospects, deliveries, events, exports, settings
- **Providers:** Geoapify (Places, Place Details, Geocoding), Groq (extraction), Cloudflare Access (auth)
- **Frontend:** React + Vite + Tailwind

## Repo layout

```
apps/api         Hono API routes + auth middleware
apps/web         React shell (plan screen, run list, scoring explain panel, export)
apps/workflows   LeadRunWorkflow: discovery → enrichment → scoring → completed
packages/shared  Zod schemas, provider clients, SSRF guard, scoring, coverage
packages/db      D1 migrations + queries
docs/PLAN.md     Full product plan and pipeline spec
spikes/          Coverage diagnostics (not production code)
```

## Commands

| Task | Command |
|---|---|
| Install | `npm install` |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Local smoke | `npm run smoke` |
| Local Worker dev | `npm run dev` |
| Deploy | `npm run deploy` |

## Required secrets

`GEOAPIFY_API_KEY`, `GROQ_API_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`. Local scripts read `.env`; Wrangler reads `.dev.vars`. Never commit either file — both are gitignored.

## Pipeline

1. **Plan** — operator enters area + segment(s); geocode; plan shows estimated credits, tokens, and minutes; human approves and freezes a settings snapshot.
2. **Discovery** — provider Places per category (paged), place details for contacts, dedupe, exclude previously delivered unless toggled on.
3. **Validation** — require name + at least one contact channel (phone/website/email).
4. **Enrichment** — fetch up to 3 same-domain pages, SSRF guard, robots.txt via cache, extract facts with HTMLRewriter (two-pass).
5. **Extraction** — model reads budgeted per-page text and returns tags with verbatim quotes; code verifies each quote appears in the text; failed quotes force the tag false.
6. **Scoring** — pure `scoreProspect`: Fit (verified service tags, size, tenure, geography) and Contactability (reachable channel, working site, contact path, freshness), each 0–100. Unknown credit only for size and tenure.
7. **Review** — human approve/reject; `qualified` only by human action.
8. **Export** — client-side SheetJS XLSX with Prospects, Sources (attribution), and Run Summary sheets; gated behind `settings.exports.enabled` (off by default) and a logged admin toggle event.

## Segments

- `msme` — Indian MSMEs, funded startups, proprietors.
- `ca_firm` — parked (no usable data at scale).
- `manufacturer_distributor` — disabled template.

## Verification

- `npm run typecheck` — clean across all workspaces.
- `npm test` — unit tests pass.
- `npm run smoke` — passes against real local D1 + Worker.

## Attribution (mandatory)

Business data © OpenStreetMap contributors (ODbL) · Powered by Geoapify. Every export carries the Sources sheet and the attribution note.

## License

Private — internal tool. Not for outreach or auto-contact.
