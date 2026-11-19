import { edgeCache } from "./cache";
import { isBlockedIp, parseIpv4, parseIpv6 } from "./ip";
import type { DnsAddress, ResolveHost } from "./types";

export class SsrfError extends Error {
  readonly code:
    | "invalid_url"
    | "blocked_address"
    | "blocked_hostname"
    | "blocked_port"
    | "dns_failure"
    | "too_many_redirects"
    | "timeout"
    | "network";

  constructor(code: SsrfError["code"], message: string) {
    super(message);
    this.name = "SsrfError";
    this.code = code;
  }
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_CACHE_HOST = "https://dns-cache.kripa.internal";
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default.svc",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];
const ALLOWED_PORTS = new Set(["", "80", "443"]);

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

export function hostnameIsIpLiteral(hostname: string): boolean {
  const host = stripBrackets(hostname);
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

export function assertPublicHostname(hostname: string): void {
  const host = stripBrackets(hostname).toLowerCase().replace(/\.$/, "");
  if (!host) throw new SsrfError("invalid_url", "URL has no hostname.");
  if (hostnameIsIpLiteral(host)) {
    if (isBlockedIp(host)) {
      throw new SsrfError("blocked_address", `Refusing to fetch private address ${host}.`);
    }
    return;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new SsrfError("blocked_hostname", `Refusing to fetch internal hostname ${host}.`);
  }
}

export function assertPublicUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("invalid_url", `Unsupported URL scheme ${url.protocol}.`);
  }
  if (url.username || url.password) {
    throw new SsrfError("invalid_url", "URLs with credentials are not allowed.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new SsrfError("blocked_port", `Port ${url.port} is not allowed.`);
  }
  assertPublicHostname(url.hostname);
}

async function fetchDnsType(
  hostname: string,
  type: "A" | "AAAA",
  fetchImpl: typeof fetch,
): Promise<DnsAddress[]> {
  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  const response = await fetchImpl(url.toString(), {
    headers: { accept: "application/dns-json" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new SsrfError("dns_failure", `DoH lookup failed with ${response.status}.`);
  }
  const body = (await response.json()) as {
    Status?: number;
    Answer?: Array<{ type?: number; data?: string }>;
  };
  if (body.Status !== 0) {
    throw new SsrfError("dns_failure", `DoH lookup returned status ${body.Status ?? "unknown"}.`);
  }
  const expectedType = type === "A" ? 1 : 28;
  const addresses: DnsAddress[] = [];
  for (const answer of body.Answer ?? []) {
    if (answer.type !== expectedType || typeof answer.data !== "string") continue;
    const address = answer.data.trim();
    const valid = type === "A" ? parseIpv4(address) !== null : parseIpv6(address) !== null;
    if (valid) addresses.push({ address, family: type === "A" ? 4 : 6 });
  }
  return addresses;
}

export function createDohResolver(fetchImpl: typeof fetch): ResolveHost {
  return async (hostname: string) => {
    const host = stripBrackets(hostname).toLowerCase().replace(/\.$/, "");
    if (hostnameIsIpLiteral(host)) {
      const family = parseIpv4(host) !== null ? 4 : 6;
      return [{ address: host, family }];
    }

    const cacheKey = `${DNS_CACHE_HOST}/${encodeURIComponent(host)}`;
    const cache = edgeCache();
    if (cache) {
      try {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const parsed = (await cached.json()) as DnsAddress[];
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch {
        // A cache miss or unsupported Cache API should not block enrichment.
      }
    }

    const [ipv4, ipv6] = await Promise.all([
      fetchDnsType(host, "A", fetchImpl),
      fetchDnsType(host, "AAAA", fetchImpl),
    ]);
    const addresses = [...ipv4, ...ipv6];
    if (addresses.length === 0) {
      throw new SsrfError("dns_failure", `No A or AAAA records for ${host}.`);
    }

    if (cache) {
      try {
        await cache.put(
          cacheKey,
          new Response(JSON.stringify(addresses), {
            headers: { "content-type": "application/json", "cache-control": "max-age=300" },
          }),
        );
      } catch {
        // Cache write failures are non-fatal.
      }
    }
    return addresses;
  };
}

export async function assertHostResolvesPublic(
  hostname: string,
  resolveHost: ResolveHost,
): Promise<DnsAddress[]> {
  assertPublicHostname(hostname);
  if (hostnameIsIpLiteral(stripBrackets(hostname))) {
    return [{ address: stripBrackets(hostname), family: parseIpv4(stripBrackets(hostname)) !== null ? 4 : 6 }];
  }
  const addresses = await resolveHost(stripBrackets(hostname));
  if (addresses.length === 0) {
    throw new SsrfError("dns_failure", `No addresses for ${hostname}.`);
  }
  for (const entry of addresses) {
    if (isBlockedIp(entry.address)) {
      throw new SsrfError(
        "blocked_address",
        `Refusing to fetch ${hostname}; it resolves to private address ${entry.address}.`,
      );
    }
  }
  return addresses;
}

export interface PublicFetchOptions {
  maxRedirects: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  readBody?: boolean;
  maxBodyBytes?: number;
}

export interface PublicFetchResult {
  response: Response;
  finalUrl: URL;
  redirects: number;
  text: string | null;
  truncated: boolean;
  bytesRead: number;
}

async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const body = response.body;
  if (!body) return { text: "", truncated: false, bytesRead: 0 };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    for (;;) {
      if (signal.aborted) throw new SsrfError("timeout", "Reading the response timed out.");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        const remaining = Math.max(0, maxBytes - (bytesRead - value.byteLength));
        chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    if (signal.aborted) throw new SsrfError("timeout", "Reading the response timed out.");
    throw error;
  } finally {
    reader.releaseLock();
  }

  return { text: chunks.join(""), truncated, bytesRead };
}

export async function fetchPublicUrl(
  rawUrl: string | URL,
  options: PublicFetchOptions,
  deps: { fetchImpl: typeof fetch; resolveHost: ResolveHost },
): Promise<PublicFetchResult> {
  let current: URL;
  try {
    current = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid_url", "Could not parse URL.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  let redirects = 0;
  try {
    for (;;) {
      assertPublicUrl(current);
      await assertHostResolvesPublic(current.hostname, deps.resolveHost);

      let response: Response;
      try {
        response = await deps.fetchImpl(current.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": options.headers?.["user-agent"] ?? "KripaLeadsBot/0.1",
            accept: options.headers?.accept ?? "text/html,application/xhtml+xml",
            "accept-language": options.headers?.["accept-language"] ?? "en",
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SsrfError("timeout", `Fetching ${current.hostname} timed out.`);
        }
        if (error instanceof SsrfError) throw error;
        throw new SsrfError(
          "network",
          `Fetching ${current.hostname} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        redirects += 1;
        if (redirects > options.maxRedirects) {
          await response.body?.cancel();
          throw new SsrfError("too_many_redirects", `Exceeded ${options.maxRedirects} redirects.`);
        }
        await response.body?.cancel();
        try {
          current = new URL(location, current);
        } catch {
          throw new SsrfError("invalid_url", "Redirect target is not a valid URL.");
        }
        continue;
      }

      let text: string | null = null;
      let truncated = false;
      let bytesRead = 0;
      if (options.readBody) {
        const capped = await readCapped(response, options.maxBodyBytes ?? 750_000, controller.signal);
        text = capped.text;
        truncated = capped.truncated;
        bytesRead = capped.bytesRead;
      }

      return { response, finalUrl: current, redirects, text, truncated, bytesRead };
    }
  } finally {
    clearTimeout(timer);
  }
}
