export const isProduction = process.env.NODE_ENV === "production";

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  solariApiKey: process.env.SOLARI_API_KEY || "",
  aiApiKey: process.env.AI_API_KEY || "",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL || "gpt-4o",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",

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
  },

  /** JSON body size limit — Probe payloads are small; 1 MB is generous. */
  bodyLimit: process.env.PROBE_BODY_LIMIT || "1mb",

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
  if (!config.solariApiKey) {
    throw new Error("SOLARI_API_KEY is required");
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
