import { edgeCache } from "./cache";
import { fetchPublicUrl } from "./ssrf";
import type { LoadRobots, ResolveHost, RobotsGroup, RobotsResult, RobotsRule } from "./types";

const ROBOTS_CACHE_HOST = "https://robots-cache.kripa.internal";
const MAX_ROBOTS_BYTES = 512_000;

export function parseRobots(text: string): RobotsResult {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;

    if (key === "allow" || key === "disallow") {
      if (!value) continue;
      current.rules.push({ type: key, path: value });
    } else if (key === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelaySeconds = delay;
    }
  }

  return { groups, fetched: true, error: null };
}

function matchingGroups(groups: RobotsGroup[], userAgent: string): RobotsGroup[] {
  const ua = userAgent.toLowerCase();
  let bestLength = 0;
  const specific: RobotsGroup[] = [];
  const wildcard: RobotsGroup[] = [];

  for (const group of groups) {
    let groupBest = 0;
    for (const agent of group.agents) {
      if (agent === "*") continue;
      if (ua.includes(agent) && agent.length > groupBest) groupBest = agent.length;
    }
    if (groupBest > 0) {
      if (groupBest > bestLength) {
        bestLength = groupBest;
        specific.length = 0;
      }
      if (groupBest === bestLength) specific.push(group);
    } else if (group.agents.includes("*")) {
      wildcard.push(group);
    }
  }

  return specific.length > 0 ? specific : wildcard;
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}${anchored ? "$" : ""}`);
  return regex.test(path);
}

export function isPathAllowed(groups: RobotsGroup[], path: string, userAgent: string): boolean {
  const selected = matchingGroups(groups, userAgent);
  if (selected.length === 0) return true;

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let best: { length: number; type: RobotsRule["type"] } | null = null;

  for (const group of selected) {
    for (const rule of group.rules) {
      if (!ruleMatches(rule.path, normalizedPath)) continue;
      const length = rule.path.replace(/\$$/, "").length;
      if (!best || length > best.length || (length === best.length && rule.type === "allow")) {
        best = { length, type: rule.type };
      }
    }
  }

  return !best || best.type === "allow";
}

export async function loadRobots(
  origin: string,
  deps: {
    fetchImpl: typeof fetch;
    resolveHost: ResolveHost;
    timeoutMs: number;
    ttlSeconds: number;
    userAgent: string;
    maxRedirects: number;
  },
): Promise<RobotsResult> {
  const cache = edgeCache();
  const cacheKey = `${ROBOTS_CACHE_HOST}/${encodeURIComponent(origin)}`;

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const text = await cached.text();
        return parseRobots(text);
      }
    } catch {
      // Cache read failures fall through to a live fetch.
    }
  }

  try {
    const result = await fetchPublicUrl(
      `${origin}/robots.txt`,
      {
        maxRedirects: deps.maxRedirects,
        timeoutMs: deps.timeoutMs,
        headers: { "user-agent": deps.userAgent },
        readBody: true,
        maxBodyBytes: MAX_ROBOTS_BYTES,
      },
      deps,
    );

    if (result.response.status === 401 || result.response.status === 403) {
      return {
        groups: [{ agents: ["*"], rules: [{ type: "disallow", path: "/" }], crawlDelaySeconds: null }],
        fetched: true,
        error: `robots.txt returned ${result.response.status}`,
      };
    }

    if (!result.response.ok || result.text === null) {
      return { groups: [], fetched: false, error: `robots.txt returned ${result.response.status}` };
    }

    if (cache) {
      try {
        await cache.put(
          cacheKey,
          new Response(result.text, {
            headers: {
              "content-type": "text/plain",
              "cache-control": `max-age=${Math.max(60, deps.ttlSeconds)}`,
            },
          }),
        );
      } catch {
        // Cache write failures are non-fatal.
      }
    }

    return parseRobots(result.text);
  } catch (error) {
    return {
      groups: [],
      fetched: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createRobotsLoader(options: {
  fetchImpl: typeof fetch;
  resolveHost: ResolveHost;
  timeoutMs: number;
  ttlSeconds: number;
  userAgent: string;
  maxRedirects: number;
}): LoadRobots {
  return (origin: string) => loadRobots(origin, options);
}

export function isAllowedByRobots(
  result: RobotsResult,
  url: URL,
  userAgent: string,
): boolean {
  if (!result.fetched || result.groups.length === 0) return true;
  return isPathAllowed(result.groups, `${url.pathname}${url.search}`, userAgent);
}
