/**
 * Findings API routes.
 *
 * GET /api/investigations/:id/findings          - List findings
 * GET /api/investigations/:id/findings/:fndId   - Get finding
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { param } from "./helpers.js";

export const findingsRouter = Router({ mergeParams: true });

findingsRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  const findings = store.listFindings(id);
  res.json(findings);
});

findingsRouter.get("/:fndId", (req: Request, res: Response) => {
  const finding = store.getFinding(param(req, "fndId"));
  if (!finding) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.json(finding);
});
