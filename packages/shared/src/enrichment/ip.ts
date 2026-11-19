export function parseIpv4(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4InRange(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isBlockedIpv4(value: number): boolean {
  for (const [base, prefix] of BLOCKED_IPV4) {
    const parsed = parseIpv4(base);
    if (parsed !== null && ipv4InRange(value, parsed, prefix)) return true;
  }
  return false;
}

export function parseIpv6(value: string): bigint | null {
  let input = value.trim().toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  if (!input.includes(":")) return null;

  const lastColon = input.lastIndexOf(":");
  const tail = input.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    input = `${input.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailGroups = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tailGroups];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    result = (result << 16n) + BigInt(parseInt(group, 16));
  }
  return result;
}

function inPrefix(value: bigint, prefix: string, bits: number): boolean {
  const base = parseIpv6(prefix);
  if (base === null) return false;
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

const BLOCKED_IPV6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:0::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

export function isBlockedIpv6(value: bigint): boolean {
  for (const [base, prefix] of BLOCKED_IPV6) {
    if (inPrefix(value, base, prefix)) return true;
  }

  if (value >> 32n === 0xffffn) {
    return isBlockedIpv4(Number(value & 0xffffffffn));
  }

  if (value >> 32n === 0n) {
    return isBlockedIpv4(Number(value & 0xffffffffn));
  }

  if (inPrefix(value, "64:ff9b::", 96)) {
    return isBlockedIpv4(Number(value & 0xffffffffn));
  }

  if (inPrefix(value, "2002::", 16)) {
    return isBlockedIpv4(Number((value >> 80n) & 0xffffffffn));
  }

  return false;
}

export function isBlockedIp(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(address);
  if (ipv6 !== null) return isBlockedIpv6(ipv6);
  return true;
}
