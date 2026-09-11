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
import { sessionUserId } from "../auth/session.js";

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

/**
 * Extract the caller's owner id (synchronous part).
 *
 * Two credential types, both resolving to a stable owner identity:
 *   1. Bearer API token (machine/API access; unchanged) — owner is derived
 *      from the token itself.
 *   2. Signed session cookie (browser accounts) — owner is the verified
 *      `sub` (user id) from the HttpOnly cookie, but the user record must
 *      still exist; that existence check is async (see requireAuth), so this
 *      function only fast-paths sessions whose user is in the TTL cache.
 * Anonymous mode (dev-only) still short-circuits to "anonymous".
 */
function authenticateSync(req: Request): string | null {
  if (config.allowAnonymous) return "anonymous";
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) {
      for (const [known] of tokenOwnerById) {
        if (safeEqual(token, known)) return tokenOwnerById.get(known)!;
      }
    }
  }
  // Browser session: signature + expiry verified; user existence is checked
  // against the TTL cache here — cache misses fall through to the async
  // checker in requireAuth (indexed store lookup).
  const sessionSub = sessionUserId(req);
  if (sessionSub && sessionUserExistsCached(sessionSub)) return sessionSub;
  return null;
}

/**
 * Pluggable async session-user existence check. The users store is injected
 * at startup (avoids a circular import between security/auth and auth/users)
 * and defaults to rejecting all session credentials.
 */
let sessionUserExistsAsync: (userId: string) => Promise<boolean> = async () => false;
/** Fast-path: TTL-cache existence check (no I/O); cache misses go async. */
let sessionUserExistsCachedFn: (userId: string) => boolean = () => false;
export function setSessionUserChecker(
  fn: (userId: string) => Promise<boolean>,
  cached?: (userId: string) => boolean
): void {
  sessionUserExistsAsync = fn;
  if (cached) sessionUserExistsCachedFn = cached;
}

function sessionUserExistsCached(userId: string): boolean {
  return sessionUserExistsCachedFn(userId);
}

export interface AuthedRequest extends Request {
  ownerId?: string;
}

/**
 * Centralized authentication middleware. Attach before every API route.
 * Emits `WWW-Authenticate` so clients know the scheme. 401 for missing or
 * invalid credentials; this middleware never differentiates the two.
 *
 * Express 4 does not forward rejected middleware promises, so the async
 * session-user existence check resolves/rejects explicitly.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const syncOwner = authenticateSync(req);
  if (syncOwner !== null) {
    attachOwner(req, syncOwner, sessionUserId(req) ?? undefined);
    next();
    return;
  }
  const sessionSub = sessionUserId(req);
  if (!sessionSub || config.allowAnonymous) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="probe-api"');
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  sessionUserExistsAsync(sessionSub)
    .then((exists) => {
      if (exists) {
        attachOwner(req, sessionSub, sessionSub);
        next();
      } else {
        res.setHeader("WWW-Authenticate", 'Bearer realm="probe-api"');
        res.status(401).json({ error: "Authentication required" });
      }
    })
    .catch((err) => {
      console.error("Session user lookup failed:", err instanceof Error ? err.message : err);
      res.setHeader("WWW-Authenticate", 'Bearer realm="probe-api"');
      res.status(401).json({ error: "Authentication required" });
    });
}

function attachOwner(req: Request, ownerId: string, sessionSub?: string): void {
  (req as AuthedRequest).ownerId = ownerId;
  // Session-authenticated requests expose the user id for /api/auth/me.
  (req as AuthedRequest & { sessionUserId?: string }).sessionUserId = sessionSub;
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
