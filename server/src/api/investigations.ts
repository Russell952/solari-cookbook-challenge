/**
 * Investigation API routes.
 *
 * POST /api/investigations          - Create investigation
 * GET  /api/investigations          - List investigations
 * GET  /api/investigations/:id      - Get investigation
 * POST /api/investigations/:id/start  - Start investigation
 * POST /api/investigations/:id/pause  - Pause investigation
 * POST /api/investigations/:id/resume - Resume investigation
 * POST /api/investigations/:id/cancel - Cancel investigation
 */
import { Router, type Request, type Response } from "express";
import { param } from "./helpers.js";
import { store } from "../store/index.js";
import { runInvestigation } from "../orchestrator/runner.js";
import { transitionStatus } from "@probe/shared";
import { emit } from "./events.js";
import type { CreateInvestigationInput } from "@probe/shared";

export const investigationsRouter = Router();

// Create investigation
investigationsRouter.post("/", (req: Request, res: Response) => {
  const { repositoryUrl, applicationUrl, objective } = req.body as CreateInvestigationInput;

  if (!repositoryUrl && !applicationUrl) {
    res.status(400).json({ error: "At least one of repositoryUrl or applicationUrl is required" });
    return;
  }
  if (!objective) {
    res.status(400).json({ error: "objective is required" });
    return;
  }

  // Basic URL validation
  if (repositoryUrl && !repositoryUrl.startsWith("https://github.com/")) {
    res.status(400).json({ error: "repositoryUrl must be a GitHub URL" });
    return;
  }

  const investigation = store.createInvestigation({
    repositoryUrl: repositoryUrl || "",
    applicationUrl: applicationUrl || "",
    objective,
  });

  res.status(201).json(investigation);
});

// List investigations
investigationsRouter.get("/", (_req: Request, res: Response) => {
  const investigations = store.listInvestigations();
  res.json(investigations);
});

// Get investigation
investigationsRouter.get("/:id", (req: Request, res: Response) => {
  const investigation = store.getInvestigation(param(req, "id"));
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }
  res.json(investigation);
});

// Start investigation
investigationsRouter.post("/:id/start", async (req: Request, res: Response) => {
  const investigation = store.getInvestigation(param(req, "id"));
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }
  if (investigation.status !== "created") {
    res.status(400).json({ error: `Cannot start investigation in status: ${investigation.status}` });
    return;
  }

  // Start asynchronously - don't await
  runInvestigation(investigation.id).catch((err) => {
    console.error(`Investigation ${investigation.id} failed:`, err);
  });

  res.json({ message: "Investigation started", id: investigation.id });
});

// Pause investigation
investigationsRouter.post("/:id/pause", (req: Request, res: Response) => {
  const investigation = store.getInvestigation(param(req, "id"));
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }
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
  const investigation = store.getInvestigation(param(req, "id"));
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }
  try {
    transitionStatus(investigation.status, "running");
  } catch {
    res.status(400).json({ error: `Cannot resume investigation in status: ${investigation.status}` });
    return;
  }

  store.updateInvestigation(investigation.id, { status: "running" });
  runInvestigation(investigation.id).catch((err) => {
    console.error(`Investigation ${investigation.id} failed:`, err);
  });

  res.json({ message: "Investigation resumed" });
});

// Cancel investigation
investigationsRouter.post("/:id/cancel", (req: Request, res: Response) => {
  const investigation = store.getInvestigation(param(req, "id"));
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }
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
