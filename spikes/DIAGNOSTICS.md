# M0 Diagnostics: Why the CA-firm Bucket Fails

Run date: 2026-11-18. City: Chennai (`place_id 51927538…`). Purpose: decide whether the CA-firm failure is a script/boundary bug or a data-availability limit, and whether the general-business bucket can reach 100 rows with better categories.

All counts below are live Geoapify calls, `limit=500`, Chennai `filter=place:<id>` unless marked otherwise. Costs were a few hundred credits; well inside the 3,000/day free tier.

## 1. Boundary filter is not the cause

`filter=place:<chennai>` is a boundary filter, not a radius. To test whether it was dropping places near the edge, the same categories were queried with `filter=rect:80.05,12.85,80.32,13.25` (a box that extends past the city boundary).

| Category | place filter | rect filter |
|---|---|---|
| `office.accountant` | 1 | 2 |
| `office.tax_advisor` | 2 | 2 |
| `office.financial_advisor` | 1 | 1 |

The rect adds at most one adjacent place. Boundary filtering is not the problem.

## 2. CA categories are nearly empty across India

A large rect (`68.0,6.0,98.0,36.0`) covering India and neighbouring countries:

| Category | Places | With website | With phone |
|---|---|---|---|
| `office.accountant` | 180 | 14 | 33 |
| `office.tax_advisor` | 55 | 9 | 16 |
| `office.financial_advisor` | 0 | 0 | 0 |
| `office.financial` | 0 | 0 | 0 |

`office.accountant` samples included firms in Myanmar and Bangladesh, so the India-only count is lower than 180. Even at 180, OSM does not have enough CA firms nationwide to fill 100 leads for one city, let alone one segment.

Note: `filter=countrycode:in` is rejected by the Places API (`Invalid filterType`), so the national probe used a rect.

## 3. Name search does not recover hidden CA firms

Searching the whole `office` parent in Chennai with `name=`:

| Name query | Results | What they were |
|---|---|---|
| `accountant` | 2 | ICAI institute, Accountant General (government) |
| `associates` | 3 | law firms |
| `chartered` | 1 | ICAI institute |
| `tax` | 4 | government tax offices + one tax site |

The parent `office` has 485 places in Chennai (82 with a website, 75 with a phone), but it is dominated by government offices, IT companies, insurers, and schools. A name classifier would add noise, not 100 usable firms.

## 4. Where the volume actually is (Chennai)

| Category | Places | Website | Phone |
|---|---|---|---|
| `commercial` | 500 (cap) | 125 | 185 |
| `commercial.food_and_drink` | 407 | 53 | 58 |
| `commercial.clothing` | 500 (cap) | 17 | 15 |
| `commercial.supermarket` | 204 | 22 | 16 |
| `commercial.vehicle` | 117 | 11 | 19 |
| `office.company` | 98 | 28 | 20 |
| `office.it` | 33 | 14 | 12 |
| `office` (parent) | 485 | 82 | 75 |
| `office.insurance` | 18 | 0 | 1 |
| `office.lawyer` | 10 | 0 | 0 |
| `office.consulting` | 3 | 3 | 2 |
| `production` | 24 | 1 | 1 |
| `production.factory` | 2 | 0 | 0 |
| `commercial.trade` | 2 | 0 | 0 |

The original general bucket (`office.company`, `commercial.trade`, `production.factory`) was a poor choice: two of its three categories are effectively empty in Chennai. Retail/office categories have the volume, at lower website density.

## 5. Probe reliability

The first run used a 5s timeout and treated any probe failure as a dead site. That over-counted junk. Re-checking failures at 10s:

| Site | Result |
|---|---|
| `zeqube.com` | 200 in Node at 10s (failed in the 5s run) |
| `jf.ag/en` | 200 in Node at 10s (failed in the 5s run) |
| `tvfplay.com` | TLS handshake failure (real) |
| `trail.do` | DNS failure (real) |
| `shastracards.com` | DNS failure (real) |
| `mckinsey.com/.../chennai` | 404 (real) |

The spike now uses a 10s timeout with one retry on timeout/network errors, records the error kind, and only counts a site as dead on 404/410, DNS failure, or connection refused. TLS failures, 403s, and timeouts are "unverified", not junk.

## 6. Fixed run results (2026-11-18T14:47Z)

Revised general bucket: `office.company`, `office.it`, `commercial`.

| Bucket | Rows | Website | Reachable | Phone | Email | Any channel | Junk |
|---|---|---|---|---|---|---|---|
| CA firms | 4 | 25% | 25% | 25% | 0% | 25% | 0% |
| General business | 100 | 58% | 46% | 45% | 17% | 63% | 8% |

General business passes all gates, including rows >= 100. The 8 junk rows are 6 confirmed-dead sites and 2 duplicate rows. CA firms fail on row count, website presence, and any-channel; the junk heuristic is no longer inflating the failure.

Cost: 114 requests, ~115 credits. One Place Details call failed after four attempts; it is listed in the report's Errors section and does not change the verdict.

## 7. Options for the CA-firm segment

1. **ICAI firm directory.** The official body publishes a firm/CA search. This is the most complete source, but access, terms, and whether bulk retrieval is permitted must be checked and agreed with Kripa before any use. It would likely be an import pipeline, not a Places search.
2. **Paid provider with India SMB coverage.** Re-check licensing specifically for lead-generation use; several consumer places APIs prohibit it.
3. **Widen to `office` parent + name classifier.** Low yield, noisy (government offices, IT firms), and still cannot reach 100 in Chennai.
4. **Park CA firms for the MVP.** Ship the MSME segment first and keep `ca_firm` as configuration so it can be enabled when a data source exists. This was chosen on 2026-11-18.

## 8. Recommendation

- Ship the MSME segment using `office.company`, `office.it`, `commercial` (retail/wholesale). It clears the gates in Chennai.
- Park the CA-firm segment for the MVP (decided 2026-11-18). Keep `ca_firm` as disabled configuration. Revisit with the ICAI directory route or a licensed provider after the MVP.
- Keep the corrected junk definition: sparse contact data is not junk; only confirmed-dead or duplicate/closed entries are.
