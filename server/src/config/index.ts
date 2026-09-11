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
  },  /** Evidence artifact caps: per-artifact bytes and per-investigation total. */
  maxArtifactBytes: parseInt(process.env.PROBE_MAX_ARTIFACT_BYTES || String(20 * 1024 * 1024), 10),
  maxInvestigationArtifactBytes: parseInt(
    process.env.PROBE_MAX_INVESTIGATION_ARTIFACT_BYTES || String(100 * 1024 * 1024),
    10
  ),

  // ── Durable persistence (production) ───────────────────────────────────
  /**
   * MongoDB connection string. When set, structured application state
   * (users, investigations, experiments, observations, hypotheses, findings,
   * evidence metadata, reports) is persisted durably; the in-memory store
   * becomes a write-through cache. Unset keeps the fully in-memory behavior
   * (local development and tests).
   */
  mongodbUri: process.env.MONGODB_URI || "",
  mongodbDbName: process.env.MONGODB_DB_NAME || "probe",

  // ── Evidence artifact storage (Backblaze B2) ──────────────────────────
  /** B2 KeyID — the S3 access key id of the bucket-restricted application key. */
  b2KeyId: process.env.B2_KEY_ID || "",
  /** B2 applicationKey — the S3 secret access key. Never logged. */
  b2ApplicationKey: process.env.B2_APPLICATION_KEY || "",
  b2BucketName: process.env.B2_BUCKET_NAME || "",
  b2Endpoint: process.env.B2_ENDPOINT || "https://s3.us-east-005.backblazeb2.com",
  b2Region: process.env.B2_REGION || "us-east-005",

  // ── Runtime/AI budget defaults (env-overridable) ───────────────────────
  maxAiTokens: parseInt(process.env.PROBE_MAX_AI_TOKENS || "400000", 10),
  maxAiCalls: parseInt(process.env.PROBE_MAX_AI_CALLS || "20", 10),
  maxRuntimeMs: parseInt(process.env.PROBE_MAX_RUNTIME_MS || String(10 * 60 * 1000), 10),
  maxExperiments: parseInt(process.env.PROBE_MAX_EXPERIMENTS || "7", 10),
  maxBrowserActions: parseInt(process.env.PROBE_MAX_BROWSER_ACTIONS || "40", 10),
  maxSandboxCommands: parseInt(process.env.PROBE_MAX_SANDBOX_COMMANDS || "20", 10),
  /**
   * Wall-clock ceiling for any single AI provider call. Keeps one model call
   * (including its provider-side retries) from consuming the entire
   * investigation runtime budget when the AI endpoint degrades.
   */
  aiCallTimeoutMs: parseInt(process.env.PROBE_AI_CALL_TIMEOUT_MS || String(90 * 1000), 10),
} as const;

/** True when MongoDB is configured (production durable persistence). */
export function isMongoConfigured(): boolean {
  return config.mongodbUri.length > 0;
}

/** True when B2 evidence storage is configured. */
export function isB2Configured(): boolean {
  return !!(config.b2KeyId && config.b2ApplicationKey && config.b2BucketName);
}

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
  // Production MUST have durable persistence configured. Silently falling
  // back to the ephemeral Render filesystem (in-memory state, local evidence
  // files) is exactly the data-loss failure mode this migration removes —
  // fail clearly at startup instead.
  if (isProduction && !isMongoConfigured()) {
    throw new Error(
      "MONGODB_URI is required when NODE_ENV=production — Probe does not silently " +
      "fall back to ephemeral local state in production"
    );
  }
  if (isProduction && !isB2Configured()) {
    throw new Error(
      "B2_KEY_ID, B2_APPLICATION_KEY and B2_BUCKET_NAME are required when NODE_ENV=production — " +
      "Probe does not silently fall back to ephemeral local evidence storage in production"
    );
  }
  if (Number.isNaN(config.maxAiTokens) || config.maxAiTokens < 1000) {
    throw new Error(`PROBE_MAX_AI_TOKENS must be a positive integer; got "${process.env.PROBE_MAX_AI_TOKENS ?? "(unset)"}"`);
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
