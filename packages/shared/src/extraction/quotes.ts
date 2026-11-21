export function normalizeForQuoteMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function quoteAppearsInText(quote: string, text: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  if (!normalizedQuote) return false;
  return normalizeForQuoteMatch(text).includes(normalizedQuote);
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALE_WORDS: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  lakh: 100_000,
  million: 1_000_000,
};

export function spelledNumbersInText(text: string): number[] {
  const tokens = normalizeForQuoteMatch(text)
    .replace(/-/g, " ")
    .split(/[^a-z]+/)
    .filter(Boolean);
  const values: number[] = [];
  let current = 0;
  let total = 0;
  let active = false;
  const flush = () => {
    if (active) values.push(total + current);
    current = 0;
    total = 0;
    active = false;
  };
  for (const token of tokens) {
    if (token === "and") continue;
    const small = NUMBER_WORDS[token];
    if (small !== undefined) {
      current += small;
      active = true;
      continue;
    }
    const scale = SCALE_WORDS[token];
    if (scale !== undefined) {
      if (!active) current = 1;
      if (scale === 100) {
        current *= scale;
      } else {
        total += current * scale;
        current = 0;
      }
      active = true;
      continue;
    }
    flush();
  }
  flush();
  return values;
}

export function countAppearsInQuote(value: number, quote: string): boolean {
  const normalized = normalizeForQuoteMatch(quote).replace(/,/g, "");
  const number = String(Math.trunc(value));
  if (!number) return false;
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(normalized)) return true;
  return spelledNumbersInText(quote).includes(Math.trunc(value));
}
