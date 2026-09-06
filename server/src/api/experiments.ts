/**
 * Experiment API routes.
 *
 * GET /api/investigations/:id/experiments          - List experiments
 * GET /api/investigations/:id/experiments/:expId   - Get experiment
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { param } from "./helpers.js";

export const experimentsRouter = Router({ mergeParams: true });

experimentsRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  const experiments = store.listExperiments(id);
  res.json(experiments);
});

experimentsRouter.get("/:expId", (req: Request, res: Response) => {
  const experiment = store.getExperiment(param(req, "expId"));
  if (!experiment) {
    res.status(404).json({ error: "Experiment not found" });
    return;
  }
  res.json(experiment);
});
