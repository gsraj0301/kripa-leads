# M0 Geoapify Coverage Spike

- City: Chennai, TN, India (51927538ba4a11544059d8bf46edd92a2a40f00101f901d6f31a0000000000c002089203074368656e6e6169)
- Run started: 2026-11-18T14:47:50.813Z
- Requests: 114
- Estimated credits: 115 of 3,000/day
- Raw rows: 104

## Bucket summary

| Bucket | Rows | Website (OSM) | Website reachable | Phone | Email | Any channel | Suspected junk | Duplicates | In area | Brand/operator |
|---|---|---|---|---|---|---|---|---|---|---|
| CA firms | 4 | 25% | 25% | 25% | 0% | 25% | 0% | 0% | 100% | 0% |
| General business | 100 | 58% | 46% | 45% | 17% | 63% | 8% | 2% | 100% | 10% |

## Gate verdict

### CA firms: FAIL

| Gate | Observed | Result |
|---|---|---|
| rows >= target | 4 / 100 | fail |
| website present >= 40% | 25% | fail |
| any channel >= 60% | 25% | fail |
| suspected junk <= 15% | 0% | pass |
| in area >= 80% | 100% | pass |

### General business: PASS

| Gate | Observed | Result |
|---|---|---|
| rows >= target | 100 / 100 | pass |
| website present >= 40% | 58% | pass |
| any channel >= 60% | 63% | pass |
| suspected junk <= 15% | 8% | pass |
| in area >= 80% | 100% | pass |

## Category results

| Bucket | Category | Returned |
|---|---|---|
| CA firms | office.accountant | 1 |
| CA firms | office.tax_advisor | 2 |
| CA firms | office.financial_advisor | 1 |
| General business | office.company | 50 |
| General business | office.it | 33 |
| General business | commercial | 50 |

## Suspected defunct or stale entries

| Bucket | Name | Address | Website | Reasons |
|---|---|---|---|---|
| General business | McKinsey & Company Chennai Knowledge Center | McKinsey & Company Chennai Knowledge Center, Taramani Road, Zone 13 Adyar, Chennai - 600113, Tamil Nadu, India | https://www.mckinsey.com/knowledge-network/chennai | website_dead |
| General business | Shastra Cards Private Limited | Shastra Cards Private Limited, 4, Bazullah Road, Zone 9 Teynampet, Chennai - 600017, Tamil Nadu, India | http://www.shastracards.com/ | website_dead |
| General business | Trail cloud innovation services Pvt.Ltd | Trail cloud innovation services Pvt.Ltd, 187/188, Thiruvalluvar Saalai, Ward 92, Chennai - 600037, Tamil Nadu, India | https://www.trail.do/ | website_dead |
| General business | Nesh Technologies | Nesh Technologies, Type II/8, OMR Service Road, Zone 13 Adyar, Chennai - 600041, Tamil Nadu, India | https://nesh.live | duplicate_address |
| General business | Touchmark Media | Touchmark Media, 10-C, 92nd Street, Zone 10 Kodambakkam, Chennai - 600083, Tamil Nadu, India | http://www.touchmarkmedia.in | website_dead |
| General business | Nesh Technologies | Nesh Technologies, Type II/8, OMR Service Road, Zone 13 Adyar, Chennai - 600041, Tamil Nadu, India | https://nesh.live | duplicate_address |
| General business | Pandian Computers Chennai | Pandian Computers Chennai, 13/26, Kattabomman Street, Ward 88, Chennai - 600101, Tamil Nadu, India | https://www.pcchennai.in | website_dead |
| General business | Roro Garage | Roro Garage, 5, Gandhi Street, Zone 14 Perungudi, Chennai - 600100, Tamil Nadu, India | https://rorogarage.com/ | website_dead |

## Notes

- Website present is the OSM/Geoapify `website` field; reachable is a 10s homepage probe with one retry on timeout/network errors.
- Email and phone come from Place Details (`contact.email`, `contact.phone`).
- Suspected junk means closed text, missing address, duplicate name+address, or a confirmed-dead site (404/410/DNS/refused). Sparse contact data alone is not junk. Review `probe.csv` before deciding.
- Credits are an estimate: Places cost 1 credit for up to 20 results plus 1 per 20 after; Details cost 1 each.
- Next step: stop and review. No M1 work until the report is accepted.

## Errors

- details:512bc885b91310544059482889b2c8242a40f00103f901e5e8890901000000920308466f746f5a6f6e65: network error fetch failed
