/**
 * API authentication + ownership.
 *
 * Model: single-deployment bearer tokens. Each configured token is a distinct
 * caller identity ("owner"); investigations and evidence are owned by the
 * token that created them, and all reads are scoped to that owner.
 *
 * - `PROBE_API_TOKEN` / `PROBE_API_TOKENS` (comma-separated) configure the
 *   accepted tokens. Multiple tokens exist so tests can simulate two users.
 * - Comparison is timing-safe (double-HMAC) — never a plain `===`.
 * - The token is never logged. Authentication failures return the same
 *   response shape whether the header is missing or invalid.
 * - In dev, with no token configured, an ephemeral random token is generated
 *   and printed once so local development keeps working.
 * - `PROBE_ALLOW_ANONYMOUS=true` (dev only, ignored in production) disables
 *   auth entirely for trivial local testing; all data is owned by "anonymous".
 */
import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config, isProduction } from "../config/index.js";

/** Token → owner id. Each token is its own owner identity. */
const tokenOwnerById = new Map<string, string>();

// Initialize from config once at module load.
(function initTokens(): void {
  const raw = config.apiTokens;
  if (raw.length === 0) {
    if (isProduction) {
      // validateConfig() blocks production boot without a token; this guard
      // covers tests/dev misconfiguration where the check was skipped.
      const dev = `dev_${randomBytes(24).toString("hex")}`;
      tokenOwnerById.set(dev, "dev");
      console.warn(
        "⚠️  No PROBE_API_TOKEN configured — generated an ephemeral dev token. " +
        "Do not run production without PROBE_API_TOKEN."
      );
    } else {
      const dev = `dev_${randomBytes(24).toString("hex")}`;
      tokenOwnerById.set(dev, "dev");
      console.log(`\n🔓 Probe dev auth token (not for production):\n   ${dev}\n`);
    }
    return;
  }
  for (const token of raw) {
    // Owner identity = the token itself hashed once (never the raw token).
    tokenOwnerById.set(token, `tok_${createHmac("sha256", "probe-owner-id").update(token).digest("hex").slice(0, 16)}`);
  }
})();

/** Test-only helper: register an extra token (e.g. a second "user"). */
export function registerTokenForTesting(token: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (!tokenOwnerById.has(token)) {
    tokenOwnerById.set(token, `tok_${createHmac("sha256", "probe-owner-id").update(token).digest("hex").slice(0, 16)}`);
  }
}

/** True when auth is disabled via PROBE_ALLOW_ANONYMOUS (dev only). */
export function isAnonymousMode(): boolean {
  return config.allowAnonymous;
}

export function hasAnyTokens(): boolean {
  return tokenOwnerById.size > 0;
}

/** Timing-safe string comparison (double-HMAC). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "probe-auth").update(a).digest();
  const hb = createHmac("sha256", "probe-auth").update(b).digest();
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

/** Extract the caller's owner id from the Authorization header, or null. */
function authenticate(req: Request): string | null {
  if (config.allowAnonymous) return "anonymous";
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  for (const [known] of tokenOwnerById) {
    if (safeEqual(token, known)) return tokenOwnerById.get(known)!;
  }
  return null;
}

export interface AuthedRequest extends Request {
  ownerId?: string;
}

/**
 * Centralized authentication middleware. Attach before every API route.
 * Emits `WWW-Authenticate` so clients know the scheme. 401 for missing or
 * invalid credentials; this middleware never differentiates the two.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ownerId = authenticate(req);
  if (ownerId === null) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="probe-api"');
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  (req as AuthedRequest).ownerId = ownerId;
  next();
}

// ── Ownership ───────────────────────────────────────────────────────────────

/**
 * Extend the shared Investigation record with an owner at creation time.
 * The Investigation type lives in @probe/shared and is intentionally not
 * modified; ownership rides in an index alongside the in-memory store.
 */
const investigationOwners = new Map<string, string>();

export function recordOwnership(investigationId: string, ownerId: string): void {
  investigationOwners.set(investigationId, ownerId);
}

export function getOwnership(investigationId: string): string | undefined {
  return investigationOwners.get(investigationId);
}

/** All investigation ids owned by a caller (for list scoping). */
export function investigationsForOwner(ownerId: string): Set<string> {
  const out = new Set<string>();
  for (const [id, owner] of investigationOwners) {
    if (owner === ownerId) out.add(id);
  }
  return out;
}

/** Forget ownership on cleanup (tests). */
export function clearOwnership(): void {
  investigationOwners.clear();
}

/**
 * Resolve the caller's ownerId for a request, or null. Used by tests.
 */
export function ownerIdOf(req: Request): string | null {
  return (req as AuthedRequest).ownerId ?? null;
}
