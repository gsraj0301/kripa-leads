export type PageKind = "home" | "about" | "team" | "contact" | "other";

export interface ExtractionPageSnippet {
  kind: PageKind;
  url: string;
  text: string;
}

export interface PageCharacterBudgets {
  home: number;
  about: number;
  team: number;
  contact: number;
  other: number;
}

export interface ExtractionCoverageConfig {
  maxInputChars: number;
  pageBudgets: PageCharacterBudgets;
}

const HOME_PATH = /^\/(?:index\.(?:html?|php|aspx?))?\/?$/;

export function classifyPageKind(url: string): PageKind {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "other";
  }
  if (HOME_PATH.test(path)) return "home";
  if (/(about|company|our-story|who-we-are|profile|overview|organisation|organization)/.test(path)) {
    return "about";
  }
  if (/(team|people|staff|leadership|partners|careers?|jobs|hiring|our-people|management)/.test(path)) {
    return "team";
  }
  if (/(contact|enquir|reach-us|get-in-touch|touch|connect)/.test(path)) return "contact";
  return "other";
}

function chunk(text: string, length: number): string {
  return text.slice(0, Math.max(0, length));
}

/**
 * Builds the model input from per-page snippets under a total character budget.
 * Evidence pages (about, team, contact) are allocated first so they are not crowded
 * out by a long homepage. The homepage keeps a base budget and then absorbs whatever
 * the evidence pages left unused, so the total stays near `maxInputChars`.
 */
export function buildExtractionText(
  pages: ExtractionPageSnippet[],
  config: ExtractionCoverageConfig,
): string {
  const total = Math.max(0, Math.floor(config.maxInputChars));
  if (total === 0) return "";
  const budgets = config.pageBudgets;

  const byKind = new Map<PageKind, ExtractionPageSnippet[]>();
  for (const page of pages) {
    if (!page.text) continue;
    const list = byKind.get(page.kind) ?? [];
    list.push(page);
    byKind.set(page.kind, list);
  }

  const parts: string[] = [];
  let used = 0;

  const takeFromKind = (kind: PageKind, cap: number): void => {
    if (cap <= 0) return;
    const list = byKind.get(kind) ?? [];
    let remaining = cap;
    for (const page of list) {
      if (used >= total || remaining <= 0) break;
      const take = Math.min(remaining, total - used, page.text.length);
      if (take > 0) {
        parts.push(chunk(page.text, take));
        used += take;
        remaining -= take;
      }
    }
  };

  const home = byKind.get("home") ?? [];
  let homeOffset = 0;
  const takeHome = (cap: number): void => {
    if (cap <= 0) return;
    let remaining = cap;
    for (const page of home) {
      if (used >= total || remaining <= 0) break;
      const available = Math.max(0, page.text.length - homeOffset);
      const take = Math.min(remaining, total - used, available);
      if (take > 0) {
        parts.push(page.text.slice(homeOffset, homeOffset + take));
        homeOffset += take;
        used += take;
        remaining -= take;
      }
    }
  };

  takeHome(budgets.home);
  takeFromKind("about", budgets.about);

  const hasTeam = (byKind.get("team")?.length ?? 0) > 0;
  const hasContact = (byKind.get("contact")?.length ?? 0) > 0;
  const shared = budgets.team + budgets.contact;
  if (hasTeam && hasContact) {
    const teamCap = Math.floor(shared / 2);
    takeFromKind("team", teamCap);
    takeFromKind("contact", shared - teamCap);
  } else if (hasTeam) {
    takeFromKind("team", shared);
  } else {
    takeFromKind("contact", shared);
  }

  takeHome(total - used);
  takeFromKind("other", total - used);

  return parts.filter(Boolean).join("\n");
}
