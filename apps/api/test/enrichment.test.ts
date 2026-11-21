import { describe, expect, it } from "vitest";
import {
  ENRICHMENT_DEFAULTS,
  SettingsConfigSchema,
  DEFAULT_SETTINGS_CONFIG,
  SsrfError,
  assertHostResolvesPublic,
  assertPublicUrl,
  createDohResolver,
  decodeEntities,
  enrichProspect,
  extractCodeFacts,
  extractCopyrightYear,
  extractEmailsFromText,
  extractPhonesFromText,
  fetchPublicUrl,
  isBlockedIp,
  isPathAllowed,
  isUsableText,
  loadRobots,
  mergeExtractions,
  normalizeEmail,
  normalizePhone,
  parseRobots,
  pickContactPages,
  socialHostOf,
  type DnsAddress,
  type EnrichmentConfig,
  type PageExtraction,
} from "@kripa/shared";

function publicResolver(addresses: string[] = ["93.184.216.34"]): (host: string) => Promise<DnsAddress[]> {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

function mapFetcher(
  routes: Record<string, () => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = routes[url];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return handler();
  }) as typeof fetch;
}

const allowRobots = async () => ({ groups: [], fetched: false, error: null });

function extractor(html: string): PageExtraction {
  const isHome = html === "home";
  return {
    title: isHome ? "Acme" : null,
    description: null,
    text: `${html} page with enough words to look real`,
    links: isHome ? [{ href: "/contact", text: "Contact us" }] : [],
    emails: ["Sales@Acme.test"],
    phones: ["+91 98765 43210"],
    socialLinks: isHome ? ["https://www.linkedin.com/company/acme"] : [],
    hasContactForm: html === "contact",
    copyrightYear: isHome ? 2025 : null,
  };
}

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and reserved IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.5.4",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedIp(address), address).toBe(true);
    }
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("93.184.216.34")).toBe(false);
  });

  it("blocks private and mapped IPv6 ranges", () => {
    for (const address of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2001:db8::1",
    ]) {
      expect(isBlockedIp(address), address).toBe(true);
    }
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
  });

  it("rejects bad schemes, credentials, ports and internal hostnames", () => {
    expect(() => assertPublicUrl(new URL("ftp://example.com/file"))).toThrow(SsrfError);
    expect(() => assertPublicUrl(new URL("https://user:pass@example.com"))).toThrow(SsrfError);
    expect(() => assertPublicUrl(new URL("https://example.com:8080/"))).toThrow(SsrfError);
    expect(() => assertPublicUrl(new URL("http://localhost/"))).toThrow(SsrfError);
    expect(() => assertPublicUrl(new URL("http://metadata.google.internal/"))).toThrow(SsrfError);
    expect(() => assertPublicUrl(new URL("https://example.com/"))).not.toThrow();
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(
      assertHostResolvesPublic("example.com", publicResolver(["10.0.0.5"])),
    ).rejects.toBeInstanceOf(SsrfError);
    await expect(
      assertHostResolvesPublic("example.com", publicResolver(["93.184.216.34"])),
    ).resolves.toHaveLength(1);
  });

  it("rejects a redirect that lands on a private address", async () => {
    const fetchImpl = mapFetcher({
      "https://example.com/": () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    });
    await expect(
      fetchPublicUrl(
        "https://example.com/",
        { maxRedirects: 3, timeoutMs: 1_000, readBody: true },
        { fetchImpl, resolveHost: publicResolver() },
      ),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("stops after the configured redirect limit", async () => {
    const fetchImpl = mapFetcher({
      "https://example.com/": () =>
        new Response(null, { status: 302, headers: { location: "/again" } }),
      "https://example.com/again": () =>
        new Response(null, { status: 302, headers: { location: "/again" } }),
    });
    await expect(
      fetchPublicUrl(
        "https://example.com/",
        { maxRedirects: 1, timeoutMs: 1_000 },
        { fetchImpl, resolveHost: publicResolver() },
      ),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("reads a capped body", async () => {
    const fetchImpl = mapFetcher({
      "https://example.com/": () => htmlResponse("0123456789abcdef"),
    });
    const result = await fetchPublicUrl(
      "https://example.com/",
      { maxRedirects: 0, timeoutMs: 1_000, readBody: true, maxBodyBytes: 5 },
      { fetchImpl, resolveHost: publicResolver() },
    );
    expect(result.text).toBe("01234");
    expect(result.truncated).toBe(true);
  });

  it("resolves addresses through DoH", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const type = url.searchParams.get("type");
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer:
            type === "A"
              ? [{ type: 1, data: "93.184.216.34" }]
              : [{ type: 28, data: "2001:4860:4860::8888" }],
        }),
        { headers: { "content-type": "application/dns-json" } },
      );
    }) as typeof fetch;
    const resolver = createDohResolver(fetchImpl);
    const addresses = await resolver("example.com");
    expect(addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
  });
});

describe("robots.txt", () => {
  it("parses groups and applies longest-match rules", () => {
    const parsed = parseRobots(
      [
        "User-agent: *",
        "Disallow: /private",
        "Allow: /private/public",
        "Disallow: /*.pdf$",
        "",
        "User-agent: KripaLeadsBot",
        "Disallow: /bot-only",
        "Crawl-delay: 2",
      ].join("\n"),
    );
    const { groups } = parsed;
    expect(isPathAllowed(groups, "/", "KripaLeadsBot/0.1")).toBe(true);
    expect(isPathAllowed(groups, "/bot-only", "KripaLeadsBot/0.1")).toBe(false);
    expect(isPathAllowed(groups, "/bot-only", "OtherBot")).toBe(true);
    expect(isPathAllowed(groups, "/private", "OtherBot")).toBe(false);
    expect(isPathAllowed(groups, "/private/public", "OtherBot")).toBe(true);
    expect(isPathAllowed(groups, "/files/report.pdf", "OtherBot")).toBe(false);
    expect(isPathAllowed(groups, "/files/report.pdf?x=1", "OtherBot")).toBe(true);
  });

  it("fails open when robots.txt is missing", async () => {
    const fetchImpl = mapFetcher({
      "https://example.com/robots.txt": () => new Response("nope", { status: 404 }),
    });
    const result = await loadRobots("https://example.com", {
      fetchImpl,
      resolveHost: publicResolver(),
      timeoutMs: 1_000,
      ttlSeconds: 60,
      userAgent: "KripaLeadsBot/0.1",
      maxRedirects: 2,
    });
    expect(result.fetched).toBe(false);
    expect(result.groups).toHaveLength(0);
  });

  it("treats 403 as a full disallow", async () => {
    const fetchImpl = mapFetcher({
      "https://example.com/robots.txt": () => new Response("", { status: 403 }),
    });
    const result = await loadRobots("https://example.com", {
      fetchImpl,
      resolveHost: publicResolver(),
      timeoutMs: 1_000,
      ttlSeconds: 60,
      userAgent: "KripaLeadsBot/0.1",
      maxRedirects: 2,
    });
    expect(result.groups[0]?.rules).toEqual([{ type: "disallow", path: "/" }]);
  });
});

describe("HTML helpers", () => {
  it("normalizes entities, emails, phones and social links", () => {
    expect(decodeEntities("A &amp; B &copy; 2025")).toBe("A & B © 2025");
    expect(normalizeEmail("mailto:HELLO@Acme.test?subject=Hi")).toBe("hello@acme.test");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("logo@2x.png")).toBeNull();
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalizePhone("+02 905 64057")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(socialHostOf("https://www.linkedin.com/company/acme")).toBe("linkedin.com");
    expect(socialHostOf("https://example.com/about")).toBeNull();
    expect(extractEmailsFromText("Write to sales@acme.test or jobs@acme.test")).toEqual([
      "sales@acme.test",
      "jobs@acme.test",
    ]);
    expect(extractPhonesFromText("Call +91 98765 43210 today")).toEqual(["+919876543210"]);
    expect(extractPhonesFromText("Reference 9876543210 was generated")).toEqual([]);
    expect(extractCopyrightYear("© 2019 Acme. Updated 2025.")).toBe(2019);
    expect(isUsableText("  short  ", 10)).toBe(false);
    expect(isUsableText("this is definitely long enough", 10)).toBe(true);
  });

  it("picks same-site contact, about and team pages only", () => {
    const pages = pickContactPages(
      "https://acme.co.in/",
      [
        { href: "/contact-us", text: "Contact us" },
        { href: "/about", text: "About" },
        { href: "/team", text: "Our team" },
        { href: "https://other.co.in/contact", text: "Contact" },
        { href: "mailto:sales@acme.co.in", text: "Email" },
        { href: "/brochure.pdf", text: "About brochure" },
        { href: "/privacy", text: "Contact privacy" },
        { href: "https://sub.acme.co.in/contact", text: "Contact" },
      ],
      3,
    );
    expect(pages).toEqual([
      "https://acme.co.in/contact-us",
      "https://acme.co.in/about",
      "https://acme.co.in/team",
    ]);
  });

  it("merges page extractions with caps and dedupe", () => {
    const merged = mergeExtractions(
      [
        {
          title: "Acme",
          description: null,
          text: "one two three",
          links: [],
          emails: ["Sales@Acme.test", "sales@acme.test"],
          phones: ["+91 98765 43210"],
          socialLinks: ["https://linkedin.com/company/acme"],
          hasContactForm: false,
          copyrightYear: 2024,
        },
        {
          title: null,
          description: "Contact Acme",
          text: "four five six",
          links: [],
          emails: ["jobs@acme.test"],
          phones: ["+919876543210"],
          socialLinks: ["https://linkedin.com/company/acme"],
          hasContactForm: true,
          copyrightYear: 2025,
        },
      ],
      20,
    );
    expect(merged.title).toBe("Acme");
    expect(merged.description).toBe("Contact Acme");
    expect(merged.text.length).toBeLessThanOrEqual(20);
    expect(merged.emails).toEqual(["sales@acme.test", "jobs@acme.test"]);
    expect(merged.phones).toEqual(["+919876543210"]);
    expect(merged.socialLinks).toHaveLength(1);
    expect(merged.hasContactForm).toBe(true);
    expect(merged.copyrightYear).toBe(2025);
  });
});

describe("enrichProspect", () => {
  const config: EnrichmentConfig = {
    ...ENRICHMENT_DEFAULTS,
    pageTimeoutMs: 1_000,
    prospectBudgetMs: 5_000,
    totalTextChars: 1_000,
  };

  it("fetches the homepage and one contact page, then records facts", async () => {
    const fetchImpl = mapFetcher({
      "https://acme.test/": () => htmlResponse("home"),
      "https://acme.test/contact": () => htmlResponse("contact"),
    });
    const outcome = await enrichProspect("https://acme.test", config, {
      fetchImpl,
      resolveHost: publicResolver(),
      extract: async (html) => extractor(html),
      loadRobots: allowRobots,
      now: () => new Date("2026-11-19T00:00:00.000Z"),
    });

    expect(outcome.status).toBe("enriched");
    expect(outcome.facts.websiteReachable).toBe(true);
    expect(outcome.facts.websiteFinalUrl).toBe("https://acme.test/");
    expect(outcome.facts.websitePagesFetched).toBe(2);
    expect(outcome.facts.websiteEmails).toEqual(["sales@acme.test"]);
    expect(outcome.facts.websitePhones).toEqual(["+919876543210"]);
    expect(outcome.facts.websiteHasContactForm).toBe(true);
    expect(outcome.facts.websiteHasContactPage).toBe(true);
    expect(outcome.facts.websiteCopyrightYear).toBe(2025);
    expect(outcome.stats).toEqual({
      pagesFetched: 2,
      failures: 0,
      robotsBlocked: 0,
      usableChars: outcome.stats.usableChars,
    });
    expect(outcome.enrichment.pages).toHaveLength(2);
    expect(outcome.provenance.websiteEmails).toMatchObject({
      source: "website",
      source_url: "https://acme.test/",
      kind: "verified",
    });
  });

  it("degrades to enriched with a failure fact when the homepage is dead", async () => {
    const fetchImpl = mapFetcher({
      "https://acme.test/": () => new Response("gone", { status: 404 }),
    });
    const outcome = await enrichProspect("https://acme.test", config, {
      fetchImpl,
      resolveHost: publicResolver(),
      extract: async (html) => extractor(html),
      loadRobots: allowRobots,
    });
    expect(outcome.status).toBe("enriched");
    expect(outcome.facts.websiteReachable).toBe(false);
    expect(outcome.facts.websiteStatus).toBe(404);
    expect(outcome.enrichment.failed).toBe(true);
    expect(outcome.stats.failures).toBe(1);
  });

  it("does not fetch a robots-disallowed page", async () => {
    const fetchImpl = mapFetcher({});
    const outcome = await enrichProspect("https://acme.test", config, {
      fetchImpl,
      resolveHost: publicResolver(),
      extract: async (html) => extractor(html),
      loadRobots: async () => ({
        groups: [{ agents: ["*"], rules: [{ type: "disallow", path: "/" }], crawlDelaySeconds: null }],
        fetched: true,
        error: null,
      }),
    });
    expect(outcome.facts.websiteRobotsBlocked).toBe(true);
    expect(outcome.facts.websitePagesFetched).toBe(0);
    expect(outcome.stats.robotsBlocked).toBe(1);
    expect(outcome.stats.failures).toBe(0);
  });

  it("records an SSRF failure when the site redirects to a private address", async () => {
    const fetchImpl = mapFetcher({
      "https://acme.test/": () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    });
    const outcome = await enrichProspect("https://acme.test", config, {
      fetchImpl,
      resolveHost: publicResolver(),
      extract: async (html) => extractor(html),
      loadRobots: allowRobots,
    });
    expect(outcome.stats.failures).toBe(1);
    expect(String((outcome.enrichment.errors as Array<{ error: string }>)[0]?.error)).toContain(
      "blocked_address",
    );
  });

  it("stops at the configured page timeout", async () => {
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof fetch;
    const outcome = await enrichProspect("https://acme.test", { ...config, pageTimeoutMs: 50 }, {
      fetchImpl,
      resolveHost: publicResolver(),
      extract: async (html) => extractor(html),
      loadRobots: allowRobots,
    });
    expect(outcome.stats.failures).toBe(1);
    expect(String((outcome.enrichment.errors as Array<{ error: string }>)[0]?.error)).toContain(
      "timeout",
    );
  });
});

describe("code-facts", () => {
  const now = new Date("2026-01-01T00:00:00.000Z").getUTCFullYear();

  it("extracts founding year from a founded/since statement", () => {
    const { founded } = extractCodeFacts(
      [
        {
          url: "https://acme.test/",
          text: "Welcome to Acme. Founded in 1979, we have served Chennai for decades.",
        },
      ],
      now,
    );
    expect(founded).toEqual({ value: 1979, quote: "Founded in 1979", sourceUrl: "https://acme.test/" });
  });

  it("extracts founding year from 'since' and rejects copyright years", () => {
    const { founded } = extractCodeFacts(
      [
        {
          url: "https://acme.test/",
          text: "&copy; Acme, Since 1999. All rights reserved. Our story began in 2005.",
        },
      ],
      now,
    );
    expect(founded).toEqual({
      value: 2005,
      quote: "story began in 2005",
      sourceUrl: "https://acme.test/",
    });
  });

  it("extracts office count and rejects sales-unit statements", () => {
    const { offices } = extractCodeFacts(
      [
        {
          url: "https://acme.test/",
          text: "We have 3 offices in Chennai and reported 650 unit sales last year.",
        },
      ],
      now,
    );
    expect(offices).toEqual({ value: 3, quote: "3 offices", sourceUrl: "https://acme.test/" });
  });

  it("extracts employee count", () => {
    const { team } = extractCodeFacts(
      [{ url: "https://acme.test/", text: "Our team of 45 people builds software." }],
      now,
    );
    expect(team).toEqual({ value: 45, quote: "team of 45", sourceUrl: "https://acme.test/" });
  });

  it("returns null when no fact is stated", () => {
    const result = extractCodeFacts([{ url: "https://acme.test/", text: "Welcome to our store." }], now);
    expect(result.founded).toBeNull();
    expect(result.team).toBeNull();
    expect(result.offices).toBeNull();
  });
});

describe("enrichment settings", () => {
  it("defaults enrichment config for older stored settings", () => {
    const parsed = SettingsConfigSchema.parse({
      segments: DEFAULT_SETTINGS_CONFIG.segments,
      rubrics: DEFAULT_SETTINGS_CONFIG.rubrics,
      retention: DEFAULT_SETTINGS_CONFIG.retention,
      discovery: DEFAULT_SETTINGS_CONFIG.discovery,
    });
    expect(parsed.enrichment.maxPagesPerProspect).toBe(3);
    expect(parsed.enrichment.respectRobots).toBe(true);
    expect(parsed.enrichment.pageTimeoutMs).toBe(10_000);
  });
});
