/**
 * Investigation API routes.
 *
 * POST /api/investigations            - Create investigation (rate limited)
 * GET  /api/investigations            - List investigations (owner-scoped)
 * GET  /api/investigations/:id        - Get investigation (owner-scoped)
 * POST /api/investigations/:id/start  - Start investigation (rate limited + concurrency cap)
 * POST /api/investigations/:id/pause  - Pause investigation
 * POST /api/investigations/:id/resume - Resume investigation
 * POST /api/investigations/:id/cancel - Cancel investigation
 *
 * Every route requires authentication (mounted in app.ts) and enforces
 * ownership: callers can only see/act on investigations they created.
 */
import { Router, type Request, type Response } from "express";
import { param } from "./helpers.js";
import { store } from "../store/index.js";
import { runInvestigation } from "../orchestrator/runner.js";
import { transitionStatus } from "@probe/shared";
import { emit } from "./events.js";
import type { CreateInvestigationInput } from "@probe/shared";
import { validateApplicationUrl, safeUrlError } from "../security/url-validation.js";
import {
  createInvestigationLimiter,
  startInvestigationLimiter,
  tryAcquireSlot,
  releaseSlot,
  tryConsumeInvestigationQuota,
  investigationQuotaDenial,
  investigationQuotaRetryAt,
  tryAcquireUserSlot,
  releaseUserSlot,
} from "../security/rate-limit.js";
import { config } from "../config/index.js";

export const investigationsRouter = Router();

/** The authenticated caller's owner id (set by requireAuth). */
function ownerIdOf(req: Request): string {
  return (req as Request & { ownerId?: string }).ownerId ?? "";
}

/** 404 when the investigation does not exist or belongs to another caller. */
function findOwned(req: Request, res: Response) {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation || store.getOwner(id) !== ownerIdOf(req)) {
    // Indistinguishable 404: existence is not leaked to non-owners.
    res.status(404).json({ error: "Investigation not found" });
    return null;
  }
  return investigation;
}

// Create investigation — per-IP window limiter first, then per-USER
// creation quotas (5/hour, 20/day) so direct API calls cannot bypass them.
investigationsRouter.post("/", createInvestigationLimiter, (req: Request, res: Response) => {
  const { repositoryUrl, applicationUrl, objective } = req.body as CreateInvestigationInput;

  const ownerId = ownerIdOf(req);
  const denial = investigationQuotaDenial(ownerId);
  if (denial) {
    // 429 with machine-readable shape + Retry-After hint. The rejected
    // investigation is never created.
    const retryAt = investigationQuotaRetryAt(ownerId, denial);
    res.setHeader("Retry-After", String(
      Math.max(1, Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1000))
    ));
    res.status(429).json({
      error:
        denial === "hourly"
          ? "Investigation creation limit reached (5 per hour). Try again later."
          : "Daily investigation quota reached (20 per day). Try again tomorrow.",
      code: "INVESTIGATION_QUOTA_EXCEEDED",
      limit: denial,
      retryAt,
    });
    return;
  }

  if (!repositoryUrl && !applicationUrl) {
    res.status(400).json({ error: "At least one of repositoryUrl or applicationUrl is required" });
    return;
  }
  if (!objective || typeof objective !== "string" || objective.trim().length === 0) {
    res.status(400).json({ error: "objective is required" });
    return;
  }
  // Server-side enforcement is authoritative — the frontend counter is a
  // usability aid, never the security boundary. Length counts EVERY
  // character (spaces, punctuation, newlines); oversized input is rejected,
  // never silently truncated.
  if (objective.length > config.limits.maxObjectiveLength) {
    res.status(400).json({
      error: `objective exceeds maximum length of ${config.limits.maxObjectiveLength} characters (got ${objective.length})`,
    });
    return;
  }
  if (repositoryUrl && (typeof repositoryUrl !== "string" || repositoryUrl.length > config.limits.maxUrlLength)) {
    res.status(400).json({ error: "repositoryUrl is too long" });
    return;
  }
  if (applicationUrl && (typeof applicationUrl !== "string" || applicationUrl.length > config.limits.maxUrlLength)) {
    res.status(400).json({ error: "applicationUrl is too long" });
    return;
  }

  // Basic URL validation
  if (repositoryUrl && !repositoryUrl.startsWith("https://github.com/")) {
    res.status(400).json({ error: "repositoryUrl must be a GitHub URL" });
    return;
  }

  // SSRF validation: the application target must be a safe public URL.
  // (AI-planned navigate targets are validated again at the dispatch boundary.)
  if (applicationUrl) {
    try {
      validateApplicationUrl(applicationUrl);
    } catch (err) {
      res.status(400).json({ error: safeUrlError(err) });
      return;
    }
  }

  // Quota consumed only when creation actually succeeds — validation
  // rejections must not burn the user's allowance.
  if (tryConsumeInvestigationQuota(ownerId)) {
    // Lost a race between the denial check and consumption; treat as the
    // hourly denial for honesty (the next request will report precisely).
    const retryAt = investigationQuotaRetryAt(ownerId, "hourly");
    res.setHeader("Retry-After", String(
      Math.max(1, Math.ceil((new Date(retryAt).getTime() - Date.now()) / 1000))
    ));
    res.status(429).json({
      error: "Investigation creation limit reached (5 per hour). Try again later.",
      code: "INVESTIGATION_QUOTA_EXCEEDED",
      limit: "hourly",
      retryAt,
    });
    return;
  }

  const investigation = store.createInvestigation({
    repositoryUrl: repositoryUrl || "",
    applicationUrl: applicationUrl || "",
    objective: objective.trim(),
  });
  store.setOwner(investigation.id, ownerId);

  res.status(201).json(investigation);
});

// List investigations — only the caller's own
investigationsRouter.get("/", (_req: Request, res: Response) => {
  const ids = store.listInvestigationIdsForOwner(ownerIdOf(_req));
  const investigations = ids
    .map((id) => store.getInvestigation(id))
    .filter((inv): inv is NonNullable<typeof inv> => inv !== undefined);
  res.json(investigations);
});

// Get investigation
investigationsRouter.get("/:id", (req: Request, res: Response) => {
  const investigation = findOwned(req, res);
  if (!investigation) return;
  res.json(investigation);
});

// Start investigation
investigationsRouter.post("/:id/start", startInvestigationLimiter, async (req: Request, res: Response) => {
  const investigation = findOwned(req, res);
  if (!investigation) return;
  if (investigation.status !== "created") {
    res.status(400).json({ error: `Cannot start investigation in status: ${investigation.status}` });
    return;
  }

  // Concurrency caps: protect Solari/AI spend from unbounded parallel runs.
  // Deployment-wide cap first (coarser bound), then the per-user cap.
  const ownerId = ownerIdOf(req);
  if (!tryAcquireSlot()) {
    res.status(429).json({
      error: "Concurrent investigation limit reached (server is at capacity). Try again when a run finishes.",
      code: "GLOBAL_CONCURRENCY_LIMIT",
    });
    return;
  }
  if (!tryAcquireUserSlot(ownerId)) {
    releaseSlot();
    res.status(429).json({
      error: `You already have ${config.maxConcurrentInvestigationsPerUser} investigations running. Wait for one to finish.`,
      code: "USER_CONCURRENCY_LIMIT",
    });
    return;
  }

  // Start asynchronously. The runner releases the global concurrency slot in
  // its `finally` (completion, failure, cancellation, expiry, or throw); the
  // per-user slot rides the same lifecycle via the released slot registry.
  runInvestigation(investigation.id, {
    releaseSlotOnFinish: true,
    slotOwnerId: ownerId,
  }).catch((err) => {
    console.error(`Investigation ${investigation.id} failed:`, err);
  });

  res.json({ message: "Investigation started", id: investigation.id });
});

// Pause investigation
investigationsRouter.post("/:id/pause", (req: Request, res: Response) => {
  const investigation = findOwned(req, res);
  if (!investigation) return;
  try {
    transitionStatus(investigation.status, "paused");
  } catch {
    res.status(400).json({ error: `Cannot pause investigation in status: ${investigation.status}` });
    return;
  }

  store.updateInvestigation(investigation.id, { status: "paused" });
  // "paused" is an InvestigationStatus, not an InvestigationPhase — emitting
  // it as a phase would violate the state machine. Announce via SSE without
  // a fake phase.
  emit("phase_change", investigation.id, { status: "paused" });
  res.json({ message: "Investigation paused" });
});

// Resume investigation
investigationsRouter.post("/:id/resume", async (req: Request, res: Response) => {
  const investigation = findOwned(req, res);
  if (!investigation) return;
  try {
    transitionStatus(investigation.status, "running");
  } catch {
    res.status(400).json({ error: `Cannot resume investigation in status: ${investigation.status}` });
    return;
  }

  const ownerId = ownerIdOf(req);
  if (!tryAcquireSlot()) {
    res.status(429).json({
      error: "Concurrent investigation limit reached (server is at capacity). Try again when a run finishes.",
      code: "GLOBAL_CONCURRENCY_LIMIT",
    });
    return;
  }
  if (!tryAcquireUserSlot(ownerId)) {
    releaseSlot();
    res.status(429).json({
      error: `You already have ${config.maxConcurrentInvestigationsPerUser} investigations running. Wait for one to finish.`,
      code: "USER_CONCURRENCY_LIMIT",
    });
    return;
  }

  store.updateInvestigation(investigation.id, { status: "running" });
  runInvestigation(investigation.id, {
    releaseSlotOnFinish: true,
    slotOwnerId: ownerId,
  }).catch((err) => {
    console.error(`Investigation ${investigation.id} failed:`, err);
  });

  res.json({ message: "Investigation resumed" });
});

// Cancel investigation
investigationsRouter.post("/:id/cancel", (req: Request, res: Response) => {
  const investigation = findOwned(req, res);
  if (!investigation) return;
  try {
    transitionStatus(investigation.status, "cancelled");
  } catch {
    res.status(400).json({ error: `Cannot cancel investigation in status: ${investigation.status}` });
    return;
  }

  store.updateInvestigation(investigation.id, { status: "cancelled" });
  // "cancelled" is a status, not a phase. Announce via SSE without a fake phase.
  emit("phase_change", investigation.id, { status: "cancelled" });
  res.json({ message: "Investigation cancelled" });
});
