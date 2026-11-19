export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export interface LinkRef {
  href: string;
  text: string;
}

export interface PageExtraction {
  title: string | null;
  description: string | null;
  text: string;
  links: LinkRef[];
  emails: string[];
  phones: string[];
  socialLinks: string[];
  hasContactForm: boolean;
  copyrightYear: number | null;
}

export interface PageRecord {
  url: string;
  finalUrl: string | null;
  status: number | null;
  ok: boolean;
  https: boolean;
  contentType: string | null;
  fetchedAt: string;
  chars: number;
  robotsAllowed: boolean;
  redirects: number;
  error: string | null;
}

export interface PageResult {
  record: PageRecord;
  extraction: PageExtraction | null;
}

export interface EnrichmentStats {
  pagesFetched: number;
  failures: number;
  robotsBlocked: number;
  usableChars: number;
}

export interface EnrichmentOutcome {
  status: "enriched";
  facts: Record<string, unknown>;
  provenance: Record<string, unknown>;
  enrichment: Record<string, unknown>;
  stats: EnrichmentStats;
}

export interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsResult {
  groups: RobotsGroup[];
  fetched: boolean;
  error: string | null;
}

export type ResolveHost = (hostname: string) => Promise<DnsAddress[]>;
export type ExtractPage = (html: string, url: string) => Promise<PageExtraction>;
export type LoadRobots = (origin: string) => Promise<RobotsResult>;

export interface EnrichmentDeps {
  fetchImpl: typeof fetch;
  resolveHost: ResolveHost;
  extract: ExtractPage;
  loadRobots?: LoadRobots;
  now?: () => Date;
}
