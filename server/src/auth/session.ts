/**
 * Stateless signed sessions for browser accounts.
 *
 * No server-side session store: the cookie carries a signed, expiring
 * payload (sub = user id, iat, exp) verified with PROBE_SESSION_SECRET.
 * Format: `v1.<base64url(payload)>.<base64url(hmac-sha256(payload))>`
 *
 * Cookie contract (set with matching attributes on login/signup and logout):
 *   HttpOnly | Secure in production | SameSite=Lax | Path=/ | Max-Age
 *
 * CSRF posture: SameSite=Lax already blocks cross-site POSTs from being
 * sent with the cookie in modern browsers. As defense in depth for the
 * cross-origin (Vercel → Render) deployment, requireSameOrigin() also
 * verifies the Origin header on state-changing requests against the CORS
 * allowlist — a forged cross-site request cannot present a trusted Origin.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { config, isProduction } from "../config/index.js";

export const SESSION_COOKIE = "probe_session";

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", config.sessionSecret).update(data).digest("base64url");
}

/** Create a signed session token for a user id. Throws if no secret is configured. */
export function createSessionToken(userId: string): string {
  if (!config.sessionSecret) {
    throw new Error("PROBE_SESSION_SECRET is not configured");
  }
  const payload: SessionPayload = {
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlHours * 3600,
  };
  const body = base64url(JSON.stringify(payload));
  return `v1.${body}.${sign(body)}`;
}

/** Verify a token's signature and expiry; returns the user id or null. Never throws. */
export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;
  try {
    const expected = Buffer.from(sign(body));
    const provided = Buffer.from(sig);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Parse the `Cookie` header into a map (minimal, standard format). */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // malformed encoding — verify will reject it anyway
    }
  }
  return out;
}

/** Extract the session user id from the request's cookie, or null. */
export function sessionUserId(req: Request): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  return verifySessionToken(cookies[SESSION_COOKIE]);
}

/** Cookie attributes used by BOTH establishing (login/signup) and clearing. */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionTtlHours * 3600 * 1000,
  };
}

/** Establish the session cookie (signup/login). */
export function setSessionCookie(res: Response, token: string): void {
  const opts = sessionCookieOptions();
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.floor(opts.maxAge / 1000)}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : []),
  ];
  const existing = res.getHeader("Set-Cookie");
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader("Set-Cookie", [...list, attrs.join("; ")]);
}

/** Clear the session cookie with matching attributes. Idempotent. */
export function clearSessionCookie(res: Response): void {
  const opts = sessionCookieOptions();
  const attrs = [
    `${SESSION_COOKIE}=`,
    `Path=${opts.path}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : []),
  ];
  const existing = res.getHeader("Set-Cookie");
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader("Set-Cookie", [...list, attrs.join("; ")]);
}

/**
 * CSRF defense in depth: on state-changing requests, a browser always sends
 * Origin. It must be in the CORS allowlist (the deployed frontend) or match
 * the request's own host (same-origin deployments, curl/tests send no Origin
 * and are not CSRF — they cannot present the cookie a browser holds).
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser client
  const allowed = config.corsOrigin
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  let host = req.headers.host ?? "";
  try {
    host = new URL(origin).host;
  } catch {
    // malformed origin — falls through to the deny below
  }
  if (allowed.includes(origin) || host === (req.headers.host ?? "")) return next();
  res.status(403).json({ error: "Cross-origin request rejected" });
}
