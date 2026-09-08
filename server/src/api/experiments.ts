/**
 * Experiment API routes.
 *
 * GET /api/investigations/:id/experiments          - List experiments (owner-scoped)
 * GET /api/investigations/:id/experiments/:expId   - Get experiment (owner-scoped)
 *
 * Ownership: the :expId lookup is validated against BOTH the investigation
 * in the URL and the authenticated owner — a global id from another
 * investigation or another caller returns the same 404 as a missing one.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { param } from "./helpers.js";

export const experimentsRouter = Router({ mergeParams: true });

function ownerIdOf(req: Request): string {
  return (req as Request & { ownerId?: string }).ownerId ?? "";
}

experimentsRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation || store.getOwner(id) !== ownerIdOf(req)) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  const experiments = store.listExperiments(id);
  res.json(experiments);
});

experimentsRouter.get("/:expId", (req: Request, res: Response) => {
  const investigationId = param(req, "id");
  const experiment = store.getExperiment(param(req, "expId"));
  // Indistinguishable 404 for missing AND foreign resources.
  if (!experiment || !store.resourceBelongsTo(ownerIdOf(req), investigationId, experiment)) {
    res.status(404).json({ error: "Experiment not found" });
    return;
  }
  res.json(experiment);
});
