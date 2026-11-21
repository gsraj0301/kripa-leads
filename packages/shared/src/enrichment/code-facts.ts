export interface CodeFact {
  value: number;
  quote: string;
  sourceUrl: string;
}

export interface CodeFacts {
  founded: CodeFact | null;
  team: CodeFact | null;
  offices: CodeFact | null;
}

export interface CodeFactPage {
  url: string;
  text: string;
}

const MAX_QUOTE = 160;
const CONTEXT = 30;

const COPYRIGHT_CTX = /©|copyright|&copy;/i;
const CORPORATE_CTX = /headquarters|group company|corporate headquarters|multinational|conglomerate/i;
const TESTIMONIAL_CTX = /testimonial|client says|customer says|review/i;
const SALES_CTX = /\bsales?\b|\bsold\b|unit sales|lakh|units? of /i;

function normalizeYear(value: number, nowYear: number): number | null {
  return value >= 1800 && value <= nowYear ? value : null;
}

function cleanQuote(text: string, start: number, end: number): string {
  const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
  return raw.slice(0, MAX_QUOTE);
}

function contextOf(text: string, index: number): string {
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(text.length, index + CONTEXT);
  return text.slice(start, end);
}

function rejected(context: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(context));
}

function findFirst(
  text: string,
  sourceUrl: string,
  patterns: RegExp[],
  validate: (value: number) => number | null,
  rejectPatterns: RegExp[] = [],
): CodeFact | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rawValue = match[1];
    if (rawValue === undefined) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const validated = validate(value);
    if (validated === null) continue;
      if (rejected(contextOf(text, match.index), rejectPatterns)) continue;
    return {
      value: validated,
      quote: cleanQuote(text, match.index, match.index + match[0].length),
      sourceUrl,
    };
  }
  return null;
}

const FOUNDING_PATTERNS = [
  /\b(?:founded|established|est\.?|since|incorporated|inc\.|started|incepted|began)\s*(?:in|on|:)?\s*(\d{4})\b/i,
  /\b(?:year of incorporation|incorporation year|established in|est in|established on)\s*[:\-]?\s*(\d{4})\b/i,
  /\b(?:journey|story|legacy|operations?)\s+(?:began|started|commenced)\s+(?:in|on)?\s*(\d{4})\b/i,
];

const TEAM_PATTERNS = [
  /\b(?:team|staff|workforce|headcount|people)\s*(?:of|size of|_strength|totalling|totaling|:)\s*(\d{1,6})\b/i,
  /\b(?:over|more than|above|at least)\s*(\d{1,6})\s+(?:employees?|staff|people|members?|team members?)\b/i,
  /\b(\d{1,6})\s*(?:\+)?\s*(?:employees?|staff|people|team members?|members?|headcount|workforce)\b/i,
];

const OFFICE_PATTERNS = [
  /\b(\d{1,5})\s*(?:\+)?\s*(?:offices?|locations?|branches?|outlets?|stores?|showrooms?|depots?|warehouses?|facilities|plants?|clinics?|hospitals?|schools?|colleges?|campuses?)\b/i,
  /\b(?:offices?|locations?|branches?|outlets?|stores?|showrooms?)\s*(?:in|across|near|throughout)\s*(\d{1,4})\s+(?:cities|states|countries|districts)\b/i,
];

export function extractCodeFacts(pages: CodeFactPage[], nowYear = new Date().getUTCFullYear()): CodeFacts {
  let founded: CodeFact | null = null;
  let team: CodeFact | null = null;
  let offices: CodeFact | null = null;

  for (const page of pages) {
    const text = page.text ?? "";
    if (!text.trim()) continue;
    if (!founded) {
      founded = findFirst(text, page.url, FOUNDING_PATTERNS, (value) => normalizeYear(value, nowYear), [
        CORPORATE_CTX,
        TESTIMONIAL_CTX,
        COPYRIGHT_CTX,
      ]);
    }
    if (!team) {
      team = findFirst(text, page.url, TEAM_PATTERNS, (value) =>
        value >= 1 && value <= 1_000_000 ? value : null,
      );
    }
    if (!offices) {
      offices = findFirst(text, page.url, OFFICE_PATTERNS, (value) =>
        value >= 1 && value <= 100_000 ? value : null,
        [SALES_CTX],
      );
    }
    if (founded && team && offices) break;
  }

  return { founded, team, offices };
}
