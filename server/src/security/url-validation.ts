/**
 * SSRF-safe URL validation for browser navigation targets.
 *
 * Single source of truth for every URL that reaches Probe's cloud browser —
 * the investigation's `applicationUrl` AND every AI-planned `navigate` target.
 * Validation happens at the dispatch boundary (runner `executeAction` →
 * `browser.navigate`), so a malicious or manipulated AI plan cannot steer the
 * browser into private infrastructure.
 *
 * Design notes:
 *  - Scheme allowlist: http/https only. Everything else (file:, data:,
 *    javascript:, about:, blob:, ws:, custom schemes) is rejected outright.
 *  - Credentials (user:pass@) are rejected: they leak into logs/upstreams and
 *    are never legitimate for a target application.
 *  - Host checks cover IP literals (IPv4 + IPv6, including alternate
 *    representations like 0x7f.0.0.1, 0177.0.0.1, ::ffff:127.0.0.1 and the
 *    hex-group form ::ffff:7f00:1) and hostnames (localhost and *.localhost
 *    variants, which browsers resolve to the loopback).
 *  - CONNECTION-TIME ENFORCEMENT: URL-string validation alone cannot stop
 *    DNS rebinding (a hostname that resolves to a public IP during validation
 *    but to a private IP when the browser connects). Enforcement therefore
 *    happens where the connection is actually made: every browser session
 *    installs a Playwright network route that resolves the target host at
 *    request time (same resolver the browser would use) and blocks any
 *    request — navigation, redirect, iframe, subresource, download — whose
 *    resolved address is non-public. See solari/browser.ts
 *    (installNetworkPolicy) and isPubliclyRoutableHost().
 *  - Ports: only 80/443/8080/8443 and other >=1024 unprivileged ports are
 *    allowed; low privileged service ports (22, 25, ...) are rejected to
 *    reduce internal-service probing surface.
 */
import { isIP } from "net";
import { lookup } from "dns/promises";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const BLOCKED_PORTS = new Set([22, 23, 25, 53, 110, 143, 445, 873, 1080, 5432, 6379, 9200, 27017, 3389]);

/** True when an IPv4/IPv6 literal (or IPv4-mapped IPv6) is a private/loopback/link-local address. */
function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) {
    // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1) and reject embedded v4.
    const mapped = ip.toLowerCase().match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    const lower = ip.toLowerCase().replace(/[^\da-f:]/g, "");
    if (lower === "::1" || lower === "::" || lower === "0:0:0:0:0:0:0:1") return true; // loopback / unspecified
    if (lower.startsWith("fe80") || lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee")) return true; // link-local fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    if (/^f[fde]/.test(lower)) return true; // reserved multicast/documentation ranges
    if (lower.startsWith("64:ff9b") || lower.startsWith("100:")) return true; // NAT64 / CGNAT-style ranges
    if (lower.startsWith("::ffff:0:")) return true; // translated
    // IPv4-mapped IPv6 in ANY textual form: ::ffff:127.0.0.1 AND the
    // compressed hex form ::ffff:7f00:1 both embed a real IPv4 address —
    // analyze the embedded address, don't pattern-match the text.
    const mappedV6 = lower.match(/::ffff:([0-9a-f:]+)$/);
    if (mappedV6) {
      const embedded = mappedV6[1];
      if (embedded.includes(".")) return isPrivateV4(embedded); // dotted form
      // Hex-group form (e.g. 7f00:1 → 127.0.0.1): expand to 32-bit value.
      const groups = embedded.split(":").filter(Boolean);
      if (groups.length === 2) {
        const hi = parseInt(groups[0], 16);
        const lo = parseInt(groups[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateV4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
        }
      }
      return true; // unparseable mapped form — fail closed
    }
    // 6to4 (2002::/16) embeds an IPv4 address after the prefix.
    const sixToFour = lower.match(/^2002:([0-9a-f]{4}):([0-9a-f]{4})/);
    if (sixToFour) {
      const a = parseInt(sixToFour[1], 16);
      const b = parseInt(sixToFour[2], 16);
      return isPrivateV4(`${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`);
    }
    // Teredo (2001::/32) hides an IPv4 pair too — block conservatively.
    if (lower.startsWith("2001:0:")) return true;
    return false;
  }
  // Hostnames are NOT IP literals — the hostname policy (isPrivateHostname)
  // governs them, so don't fail closed here.
  return false;
}

function isPrivateV4(ip: string): boolean {
  // Accept the canonical dotted-quad form only; callers normalize first.
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP/Azure metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Reject decimal/octal/hex IPv4 encodings (e.g. 0x7f000001, 2130706433,
 * 0177.0.0.1, 127.1) while ALLOWING canonical dotted-quad IPv4 literals
 * (e.g. 93.184.216.34). Browsers/URL parsers normalize the packed forms to
 * their real 32-bit value — a packed loopback must not slip through just
 * because it isn't written as "127.0.0.1".
 */
function looksLikeEncodedIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^0x[0-9a-f]+$/i.test(h)) return true; // pure hex (0x7f000001)
  if (/^\d{8,}$/.test(h)) return true; // 8+ digit decimal = packed IPv4
  if (/^\d+(\.\d+)*$/.test(h)) {
    // Dotted-quad with all four octets in canonical 0-255 decimal form is a
    // legitimate literal — keep it (isPrivateV4 does the safety analysis).
    const parts = h.split(".");
    const canonical =
      parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && !/^0\d/.test(p));
    if (canonical) return false;
    // Anything else numeric (127.1, 0177.0.0.1, 1.2.3.4.5, 010.0.0.1) is a
    // non-canonical form some parser will reinterpret — reject.
    return true;
  }
  return false;
}

function isPrivateHostname(host: string): boolean {
  // Strip ALL trailing dots — "localhost.." must not evade the localhost
  // policy just because more than one dot was appended (FQDN root form).
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost") || h === "local") return true;
  if (h === "localhost.localdomain" || h.endsWith(".internal") || h.endsWith(".local") ||
      h.endsWith(".home.arpa") || h.endsWith(".lan") || h.endsWith(".intranet")) return true;
  // Metadata hosts for all major clouds.
  if (h === "metadata.goog" || h === "metadata.google.internal" || h === "metadata" ||
      h.endsWith(".internal.cloudapp.net") || h === "instance-data") return true;
  // Docker-style single-label hostnames (compose service names) — ambiguous,
  // could resolve to private infra inside a container network.
  if (!h.includes(".") && !/^\d+$/.test(h)) return true;
  return false;
}

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

/**
 * Validate a URL for safe navigation by Probe's cloud browser.
 * Throws UrlValidationError with a safe (non-leaking) message on rejection.
 */
export function validateApplicationUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new UrlValidationError("URL is required");
  }
  if (raw.length > 2048) {
    throw new UrlValidationError("URL exceeds maximum length");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new UrlValidationError("URL is malformed");
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new UrlValidationError("Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new UrlValidationError("URLs must not contain credentials");
  }

  const host = parsed.hostname;
  if (!host) {
    throw new UrlValidationError("URL is missing a host");
  }
  // Bracket-stripped for IPv6 literals
  const bareHost = host.replace(/^\[|\]$/g, "");

  if (isPrivateOrReservedIp(bareHost) || isPrivateHostname(host) || looksLikeEncodedIp(bareHost)) {
    throw new UrlValidationError("URL host is not a routable public address");
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
  if (Number.isNaN(port) || port <= 0 || port > 65535 || BLOCKED_PORTS.has(port)) {
    throw new UrlValidationError("URL port is not allowed");
  }

  return parsed;
}

/**
 * Resolve a hostname and confirm every resolved address is publicly routable.
 *
 * This is the CONNECTION-TIME half of the SSRF policy: string validation at
 * dispatch can be defeated by DNS rebinding, so the actual request path
 * (solari/browser.ts network policy) re-resolves the host when the browser
 * makes the request and consults this same policy. A hostname that resolves
 * to ANY private/loopback/link-local/metadata address is rejected.
 *
 * Returns the resolved addresses so callers can pin DNS (see pinDnsForHost)
 * — eliminating the rebinding race entirely for that navigation.
 */
export async function isPubliclyRoutableHost(hostname: string): Promise<{ ok: boolean; addresses: string[] }> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  // IP literals never resolve — analyze directly.
  if (isIP(bare) !== 0) {
    return { ok: !isPrivateOrReservedIp(bare) && !looksLikeEncodedIp(bare), addresses: [bare] };
  }
  // Hostname policy first (localhost etc.) — no DNS needed.
  if (isPrivateHostname(bare)) return { ok: false, addresses: [] };

  try {
    const result = await lookup(bare, { all: true, verbatim: true });
    if (result.length === 0) return { ok: false, addresses: [] };
    const addresses = result.map((r) => r.address);
    const allPublic = addresses.every((a) => !isPrivateOrReservedIp(a));
    return { ok: allPublic, addresses };
  } catch {
    // Unresolvable hostnames cannot be routed by the browser either.
    return { ok: false, addresses: [] };
  }
}

/**
 * Build Playwright host-resolver overrides from a validation result so the
 * browser connects to the EXACT addresses that were validated — closing the
 * classic rebinding window between check and connect.
 */
export function dnsPin(addresses: string[]): Record<string, string[]> {
  if (addresses.length === 0) return {};
  return { ["*"]: [] as string[], ...Object.fromEntries(addresses.map((a) => [a, [a]])) };
}

/**
 * Safe error message for API responses — never leaks the rejected value.
 */
export function safeUrlError(err: unknown): string {
  if (err instanceof UrlValidationError) return `Invalid application URL: ${err.message}`;
  return "Invalid application URL";
}
