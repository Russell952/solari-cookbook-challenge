/**
 * Email/password auth routes.
 *
 *   POST /api/auth/signup  — create account + session
 *   POST /api/auth/login   — verify credentials + session
 *   POST /api/auth/logout  — clear cookie (idempotent)
 *   GET  /api/auth/me      — current user or 401
 *
 * Errors are deliberately generic where they could leak account existence:
 * login always answers "Invalid email or password" for both unknown account
 * and wrong password. Passwords are hashed (scrypt) and never returned.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config/index.js";
import { authLimiter } from "../security/rate-limit.js";
import {
  createUser,
  EmailAlreadyExistsError,
  getUserByEmail,
  getUserById,
  isValidEmail,
  verifyPassword,
} from "./users.js";
import {
  clearSessionCookie,
  createSessionToken,
  requireSameOrigin,
  sessionUserId,
  setSessionCookie,
} from "./session.js";

/** The only user shape that ever leaves the server. */
function safeUser(user: { id: string; email: string; createdAt: string }): {
  id: string;
  email: string;
  createdAt: string;
} {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

function normalizeEmailInput(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function passwordOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const authRouter = Router();

// State-changing auth endpoints: rate limit first (bounds guessing/spam),
// then the CSRF origin check.
authRouter.post("/signup", authLimiter, requireSameOrigin, signup);
authRouter.post("/login", authLimiter, requireSameOrigin, login);
authRouter.post("/logout", requireSameOrigin, logout);
authRouter.get("/me", me);

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

async function signup(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmailInput(body.email);
  const password = passwordOf(body.password);

  if (!email || !isValidEmail(email)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: "Password is too long" });
    return;
  }

  try {
    const user = await createUser(email, password);
    setSessionCookie(res, createSessionToken(user.id));
    res.status(201).json({ user: safeUser(user) });
  } catch (err) {
    if (err instanceof EmailAlreadyExistsError) {
      // 409 without confirming more than the client already knows: the email
      // it just submitted is taken. No internal details.
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    throw err;
  }
}

async function login(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = normalizeEmailInput(body.email);
  const password = passwordOf(body.password);

  if (!email || !password || !isValidEmail(email)) {
    // Same generic error for malformed and wrong credentials.
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const user = await getUserByEmail(email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  setSessionCookie(res, createSessionToken(user.id));
  res.status(200).json({ user: safeUser(user) });
}

function logout(_req: Request, res: Response): void {
  // Idempotent: clearing an absent cookie is a no-op that still succeeds.
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function me(req: Request, res: Response): Promise<void> {
  // /api/auth/* is mounted before the /api auth gate (signup/login must be
  // reachable), so /me resolves its own session from the cookie rather than
  // relying on requireAuth having run.
  const userId = sessionUserId(req);
  if (!userId) {
    // Expired/invalid/absent session: clear whatever cookie the browser sent
    // (it may be a stale token the server can never accept again — e.g. one
    // signed by a replaced secret). The next login/signup sets a fresh one;
    // existing accounts are unaffected. Idempotent when no cookie was sent.
    clearSessionCookie(res);
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const user = await getUserById(userId);
  if (!user) {
    // Signed for a user that no longer exists on disk — treat as unauthenticated
    // and clear the now-orphaned cookie.
    clearSessionCookie(res);
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  res.status(200).json({ user: safeUser(user) });
}
