/**
 * Express app construction.
 *
 * Separated from server.ts so the exact production app (middleware, routes,
 * error handling) can be instantiated without binding a port — used by the
 * server entry point and by the integration tests.
 *
 * Security middleware order matters:
 *   helmet → json parser → (mount) auth → rate limit → routes → 404 → errors
 */
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config, isProduction } from "./config/index.js";
import { apiRouter } from "./api/index.js";
import { authRouter } from "./auth/routes.js";
import { sessionUserExists, sessionUserExistsCached } from "./auth/users.js";
import { requireAuth, setSessionUserChecker } from "./security/auth.js";
import { generalLimiter } from "./security/rate-limit.js";
import { safeUrlError } from "./security/url-validation.js";

export function buildApp(): express.Express {
  const app = express();

  // ── Proxy topology (rate-limit correctness) ────────────────────────────
  // Explicitly configured via PROBE_TRUST_PROXY (validated at startup; the
  // unsafe "true" value is rejected). Default false = direct internet
  // exposure: req.ip is the socket address and X-Forwarded-For is ignored,
  // so an attacker cannot spoof identities to evade rate limits.
  app.set("trust proxy", config.trustProxy);

  // Identity: never advertise the framework.
  app.disable("x-powered-by");

  // ── Security headers ─────────────────────────────────────────────────────
  app.use(
    helmet({
      // The API serves JSON and evidence artifacts only — no HTML framing of
      // its own, so framing can be denied outright.
      frameguard: { action: "deny" },
      noSniff: true, // X-Content-Type-Options: nosniff (evidence artifacts!)
      referrerPolicy: { policy: "no-referrer" },
      // CSP for an API: default-deny object/frame/base; scripts are not
      // served from this origin. Kept deliberately non-breaking for JSON +
      // image artifacts.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );

  // ── CORS ─────────────────────────────────────────────────────────────────
  // Production must set CORS_ORIGIN explicitly (single allowed frontend
  // origin). Same-origin deployments can set CORS_ORIGIN to the site origin.
  // `*` is never used: requests carry an Authorization header.
  const allowedOrigins = config.corsOrigin
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser clients (curl, tests) send no Origin header — allow.
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false); // deny silently → no CORS headers
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      // Cookie sessions: the allowlisted frontend must be able to send its
      // credentials; `*` is still never used with credentials.
      credentials: true,
      maxAge: 600,
    })
  );

  // Health check: unauthenticated by design (no sensitive data, used by
  // uptime probes and the client's connectivity indicator). Registered
  // BEFORE the /api auth middleware so it stays reachable anonymously.
  const healthHandler = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  // ── Session-user lookup for cookie auth ─────────────────────────────
  // Injected here (module load time) so requireAuth can verify that a
  // session's `sub` refers to an existing user without a circular import.
  // `sessionUserExists` is the async source of truth (Mongo/memory user
  // store, indexed lookup); `sessionUserExistsCached` is a TTL-cache
  // fast-path so most request paths never await I/O.
  setSessionUserChecker(sessionUserExists, sessionUserExistsCached);

  // ── Body parsing ─────────────────────────────────────────────────────────
  app.use(express.json({ limit: config.bodyLimit }));
  // Malformed JSON must be a 400 JSON response, not an HTML stack page.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
        res.status(400).json({ error: "Malformed JSON body" });
        return;
      }
      if (
        err &&
        typeof err === "object" &&
        "type" in err &&
        ((err as { type?: string }).type === "entity.too.large" ||
          (err as { statusCode?: number }).statusCode === 413)
      ) {
        res.status(413).json({ error: "Request body too large" });
        return;
      }
      next(err);
    }
  );

  // ── Authentication: every /api route requires credentials ───────────────
  // /api/auth/* is mounted BEFORE the gate: signup/login must be reachable
  // unauthenticated (they are rate-limited and CSRF-checked internally);
  // /api/auth/me performs its own session check.
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth);

  // ── Rate limiting (after auth so 401s aren't counted against callers) ────
  app.use("/api", generalLimiter);

  // ── API routes ───────────────────────────────────────────────────────────
  app.use("/api", apiRouter);

  // Unknown /api routes: clean JSON 404 (Express's default HTML 404 would
  // leak the framework and helps nobody).
  app.use("/api", (_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // ── Centralized error handler (last middleware) ──────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // Known, intentional rejections keep their specific status + message.
      if (err && typeof err === "object" && "name" in err) {
        const name = (err as { name?: string }).name;
        const message = (err as { message?: string }).message ?? "";
        if (name === "UrlValidationError") {
          res.status(400).json({ error: safeUrlError(err) });
          return;
        }
      }
      if (err && typeof err === "object" && (err as { statusCode?: number }).statusCode === 429) {
        res.status(429).json({ error: "Too many requests" });
        return;
      }

      // Unexpected errors: log server-side (without secrets), return a
      // generic JSON 500. Stack traces are never sent to clients.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${req.method} ${req.path}: ${message}`);
      if (!isProduction && err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      res.status(500).json({ error: "Internal server error" });
    }
  );

  return app;
}
