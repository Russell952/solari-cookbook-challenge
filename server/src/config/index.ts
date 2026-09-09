import { randomBytes } from "crypto";

export const isProduction = process.env.NODE_ENV === "production";

/**
 * Resolve the session signing secret. Production: required (validateConfig
 * fails closed when absent). Dev: ephemeral random secret so local signup
 * works out of the box — sessions reset on restart, mirroring the ephemeral
 * dev API-token convention. Never the API token, never sent to the client.
 */
function resolveSessionSecret(): string {
  const raw = process.env.PROBE_SESSION_SECRET || "";
  if (raw) return raw;
  if (isProduction) return "";
  return randomBytes(32).toString("hex");
}

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  solariApiKey: process.env.SOLARI_API_KEY || "",
  aiApiKey: process.env.AI_API_KEY || "",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL || "gpt-4o",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",

  /**
   * Session-cookie signing secret for email/password accounts.
   * Required in production (validateConfig fails closed); dev falls back to an
   * ephemeral random secret (sessions reset on restart — acceptable in dev).
   * Never shared with the client and never the API token.
   */
  sessionSecret: resolveSessionSecret(),
  /** Session lifetime in hours (finite expiration; default 30 days). */
  sessionTtlHours: parseInt(process.env.PROBE_SESSION_TTL_HOURS || "720", 10),

  // ── Security hardening (P0 pre-hosting) ──────────────────────────────────
  /**
   * API bearer tokens. Comma-separated list; each token is a distinct caller
   * identity (ownership is enforced per token). Set PROBE_API_TOKEN in
   * production — the server refuses to boot without one when NODE_ENV=production.
   */
  apiTokens: (process.env.PROBE_API_TOKEN || process.env.PROBE_API_TOKENS || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0),
  /** When true (set in dev), authentication is disabled entirely. Never set in production. */
  allowAnonymous: process.env.PROBE_ALLOW_ANONYMOUS === "true" && !isProduction,

  /** Maximum investigations running concurrently (protects Solari/AI spend). */
  maxConcurrentInvestigations: parseInt(process.env.PROBE_MAX_CONCURRENT_INVESTIGATIONS || "2", 10),
  /** Max simultaneous SSE connections, globally and per investigation. */
  maxSseConnections: parseInt(process.env.PROBE_MAX_SSE_CONNECTIONS || "50", 10),
  maxSsePerInvestigation: parseInt(process.env.PROBE_MAX_SSE_PER_INVESTIGATION || "5", 10),

  /** Rate limits (requests per window). All env-overridable. */
  rateLimit: {
    general: { max: parseInt(process.env.PROBE_RATE_MAX_GENERAL || "300", 10), windowMs: 5 * 60_000 },
    createInvestigation: { max: parseInt(process.env.PROBE_RATE_MAX_CREATE || "20", 10), windowMs: 60 * 60_000 },
    startInvestigation: { max: parseInt(process.env.PROBE_RATE_MAX_START || "30", 10), windowMs: 60 * 60_000 },
    /** Signup + login share one bucket — bounds password guessing and account spam. */
    auth: { max: parseInt(process.env.PROBE_RATE_MAX_AUTH || "20", 10), windowMs: 15 * 60_000 },
  },

  /** JSON body size limit — Probe payloads are small; 1 MB is generous. */
  bodyLimit: process.env.PROBE_BODY_LIMIT || "1mb",

  /**
   * Express `trust proxy` setting. MUST match the real deployment topology:
   *   - "false"            → directly internet-facing (default; safest)
   *   - a hop count ("1")  → behind exactly N trusted reverse proxies that
   *                          OVERWRITE X-Forwarded-For
   *   - a CIDR/IP list     → behind proxies at known addresses
   * "true" is deliberately not documented and startup validation rejects it:
   * trusting every proxy makes X-Forwarded-For attacker-controlled, which
   * would let an attacker rotate rate-limit identities at will.
   */
  trustProxy: parseTrustProxy(process.env.PROBE_TRUST_PROXY || "false"),

  /** Input length caps for user-controlled strings. */
  limits: {
    maxUrlLength: parseInt(process.env.PROBE_MAX_URL_LENGTH || "2048", 10),
    maxObjectiveLength: parseInt(process.env.PROBE_MAX_OBJECTIVE_LENGTH || "2000", 10),
  },

  /** Evidence artifact caps: per-artifact bytes and per-investigation total. */
  maxArtifactBytes: parseInt(process.env.PROBE_MAX_ARTIFACT_BYTES || String(20 * 1024 * 1024), 10),
  maxInvestigationArtifactBytes: parseInt(
    process.env.PROBE_MAX_INVESTIGATION_ARTIFACT_BYTES || String(100 * 1024 * 1024), 10
  ),
} as const;

export function validateConfig(): void {
  // trust proxy "true" is never acceptable: it makes X-Forwarded-For
  // attacker-controlled and lets one client rotate unlimited rate-limit IPs.
  // Checked against the LIVE env value first — this is a pure misconfiguration
  // guard, independent of the module-load config snapshot.
  if (process.env.PROBE_TRUST_PROXY === "true") {
    throw new Error(
      'PROBE_TRUST_PROXY=true is not allowed — set "false" (direct exposure), ' +
      'a hop count like "1", or a comma-separated list of trusted proxy IPs/CIDRs '
      + 'that match the real deployment topology'
    );
  }
  if (!config.solariApiKey) {
    throw new Error("SOLARI_API_KEY is required");
  }
  // Session signing secret: fail closed in production. Dev keeps working with
  // an ephemeral secret (mirrors the ephemeral dev API-token convention).
  if (isProduction && !process.env.PROBE_SESSION_SECRET) {
    throw new Error(
      "PROBE_SESSION_SECRET is required when NODE_ENV=production — sessions cannot be signed without it"
    );
  }
  // Fail closed in production: an unauthenticated cost-incurring API must
  // never be exposed. Dev gets an ephemeral token (printed once by auth.ts).
  if (isProduction && config.apiTokens.length === 0 && !config.allowAnonymous) {
    throw new Error(
      "PROBE_API_TOKEN (or PROBE_API_TOKENS) is required when NODE_ENV=production — " +
      "Probe refuses to host an unauthenticated, cost-incurring API"
    );
  }
}

/**
 * Parse PROBE_TRUST_PROXY into an Express trust-proxy value.
 * Accepts: "false" | hop count | comma-separated IPs/CIDRs. Never "true".
 */
function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "") return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  // Address/CIDR list — preserved verbatim for Express to match against
  // the socket's immediate peer (hop 0), not attacker headers.
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
