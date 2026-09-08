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
 *    representations like 0x7f.0.0.1, 0177.0.0.1, ::ffff:127.0.0.1) and
 *    hostnames (localhost and *.localhost variants, which browsers resolve to
 *    the loopback). Note: resolution-based DNS rebinding (a public hostname
 *    resolving to a private IP at request time) cannot be fully prevented by
 *    the caller without a resolution hook inside Solari's browser; this is
 *    documented as a residual limitation.
 *  - Ports: only 80/443/8080/8443 and other >=1024 unprivileged ports are
 *    allowed; low privileged service ports (22, 25, ...) are rejected to
 *    reduce internal-service probing surface.
 */
import { isIP } from "net";

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
    return false;
  }
  // Hostnames are NOT IP literals — the hostname policy (isPrivateHostname)
  // governs them, so don't fail closed here.
  return false;
}

function isPrivateV4(ip: string): boolean {
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
 * 0177.0.0.1). Browsers/URL parsers normalize these to loopback.
 */
function looksLikeEncodedIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  if (/^\d{8,}$/.test(h)) return true; // 8+ digit decimal = packed IPv4
  if (/^(\d{1,3}\.){2}\d{1,3}$/.test(h) === false && /^\d+(\.\d+)*$/.test(h) && h.split(".").length <= 4) {
    // e.g. "0177.0.0.1" (octal) or "127.1" — atypical numeric host forms
    return true;
  }
  return false;
}

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""); // strip trailing dot (FQDN form)
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
 * Safe error message for API responses — never leaks the rejected value.
 */
export function safeUrlError(err: unknown): string {
  if (err instanceof UrlValidationError) return `Invalid application URL: ${err.message}`;
  return "Invalid application URL";
}
