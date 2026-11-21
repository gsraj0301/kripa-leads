import { getDomain } from "tldts";
import type { LinkRef, PageExtraction } from "./types";

const SOCIAL_HOSTS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "github.com",
];

const SKIPPED_EXTENSIONS =
  /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|avi|mov|css|js|woff2?|ttf)$/i;

const SKIPPED_PATHS = /\/(?:privacy|terms|login|signin|sign-in|signup|sign-up|cart|checkout|wp-admin)\b/i;

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

export function normalizeText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

export function isUsableText(text: string, minChars: number): boolean {
  const normalized = normalizeText(text);
  return normalized.length >= minChars;
}

export function normalizeEmail(value: string): string | null {
  const trimmed = decodeEntities(value).trim().replace(/^mailto:/i, "").split(/[?;,]/)[0]?.trim() ?? "";
  const email = trimmed.toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  if (/\.(?:png|jpe?g|gif|webp|svg)$/i.test(email)) return null;
  if (email.endsWith("@example.com") || email.endsWith("@sentry.io")) return null;
  return email;
}

export function normalizePhone(value: string): string | null {
  const digits = decodeEntities(value).replace(/\D/g, "").replace(/^00/, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.startsWith("0")) return null;
  return `+${digits}`;
}

export function extractEmailsFromText(text: string): string[] {
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return unique(matches.map(normalizeEmail).filter((value): value is string => value !== null));
}

const PHONE_CONTEXT =
  /(?:phone|telephone|mobile|whatsapp|call(?:\s+us)?|tel|contact|reach|dial)\b[^0-9+]{0,24}$/i;

export function extractPhonesFromText(text: string): string[] {
  const pattern = /(?<![\w+])\+?\d[\d\s().-]{7,18}\d(?![\w])/g;
  const found: string[] = [];

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 60), index);
    if (!PHONE_CONTEXT.test(before)) continue;
    const phone = normalizePhone(raw);
    if (phone) found.push(phone);
    if (found.length >= 10) break;
  }

  return unique(found);
}

export function socialHostOf(href: string): string | null {
  let host: string;
  try {
    host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const matched = SOCIAL_HOSTS.find((social) => host === social || host.endsWith(`.${social}`));
  return matched ?? null;
}

export function extractCopyrightYear(text: string, now = new Date()): number | null {
  const currentYear = now.getUTCFullYear();
  const matches = text.matchAll(/(?:©|\(c\)|copyright)[^0-9]{0,12}((?:19|20)\d{2})/gi);
  let best: number | null = null;
  for (const match of matches) {
    const year = Number(match[1]);
    if (year < 1990 || year > currentYear + 1) continue;
    if (best === null || year > best) best = year;
  }
  return best;
}

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

export function sameSite(a: string, b: string): boolean {
  try {
    const hostA = new URL(a).hostname;
    const hostB = new URL(b).hostname;
    return registrableDomain(hostA) === registrableDomain(hostB);
  } catch {
    return false;
  }
}

export function absoluteUrl(href: string, baseUrl: string): string | null {
  const decoded = decodeEntities(href).trim();
  if (!decoded || decoded.startsWith("#")) return null;
  if (/^(?:mailto|tel|javascript|data):/i.test(decoded)) return null;
  try {
    const url = new URL(decoded, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const CONTACT_PAGE_SCORES: Array<[RegExp, number]> = [
  [/\bcontact(?:-us)?\b|\bget-in-touch\b|\breach-us\b|\benquiry\b|\benquiries\b/i, 100],
  [/\babout(?:-us)?\b|\bwho-we-are\b|\bcompany\b/i, 80],
  [/\bteam\b|\bpeople\b|\bleadership\b|\bpartners\b/i, 70],
  [/\bservices?\b|\bsolutions?\b/i, 20],
];

function contactPageScore(href: string, text: string): number {
  let score = 0;
  for (const [pattern, points] of CONTACT_PAGE_SCORES) {
    if (pattern.test(href) || pattern.test(text)) score = Math.max(score, points);
  }
  return score;
}

export function pickContactPages(
  homepage: string,
  links: LinkRef[],
  maxPages: number,
): string[] {
  if (maxPages <= 0) return [];
  let homepageUrl: URL;
  try {
    homepageUrl = new URL(homepage);
  } catch {
    return [];
  }

  const homepageHost = homepageUrl.hostname.toLowerCase();
  const seen = new Set<string>([homepageUrl.toString()]);
  const candidates: Array<{ url: string; score: number; length: number; sameHost: boolean }> = [];

  for (const link of links) {
    const url = absoluteUrl(link.href, homepage);
    if (!url) continue;
    if (SKIPPED_EXTENSIONS.test(url) || SKIPPED_PATHS.test(new URL(url).pathname)) continue;
    if (!sameSite(homepage, url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const parsed = new URL(url);
    const score = contactPageScore(parsed.pathname + parsed.search, link.text);
    if (score === 0) continue;
    candidates.push({
      url,
      score,
      length: parsed.pathname.length,
      sameHost: parsed.hostname.toLowerCase() === homepageHost,
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.sameHost) - Number(a.sameHost) ||
      b.score - a.score ||
      a.length - b.length,
  );
  return candidates.slice(0, maxPages).map((candidate) => candidate.url);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export interface MergedExtractions {
  title: string | null;
  description: string | null;
  text: string;
  emails: string[];
  phones: string[];
  socialLinks: string[];
  hasContactForm: boolean;
  copyrightYear: number | null;
}

export function mergeExtractions(
  pages: PageExtraction[],
  totalTextChars: number,
  now = new Date(),
): MergedExtractions {
  const parts: string[] = [];
  const emails: string[] = [];
  const phones: string[] = [];
  const socialLinks: string[] = [];
  let title: string | null = null;
  let description: string | null = null;
  let hasContactForm = false;
  let copyrightYear: number | null = null;

  for (const page of pages) {
    if (!title && page.title) title = page.title;
    if (!description && page.description) description = page.description;
    hasContactForm = hasContactForm || page.hasContactForm;
    for (const email of page.emails) {
      const normalized = normalizeEmail(email);
      if (normalized) emails.push(normalized);
    }
    for (const phone of page.phones) {
      const normalized = normalizePhone(phone);
      if (normalized) phones.push(normalized);
    }
    for (const social of page.socialLinks) {
      const host = socialHostOf(social);
      if (host) socialLinks.push(social);
    }
    if (page.copyrightYear !== null) {
      copyrightYear = copyrightYear === null ? page.copyrightYear : Math.max(copyrightYear, page.copyrightYear);
    }
    if (page.text) parts.push(normalizeText(page.text));
  }

  const text = normalizeText(parts.join(" ")).slice(0, totalTextChars);
  return {
    title,
    description,
    text,
    emails: unique(emails),
    phones: unique(phones),
    socialLinks: unique(socialLinks),
    hasContactForm,
    copyrightYear: copyrightYear ?? extractCopyrightYear(text, now),
  };
}
