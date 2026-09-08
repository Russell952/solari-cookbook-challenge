/**
 * Findings API routes.
 *
 * GET /api/investigations/:id/findings          - List findings (owner-scoped)
 * GET /api/investigations/:id/findings/:fndId   - Get finding (owner-scoped)
 *
 * Ownership: :fndId is validated against BOTH the investigation in the URL
 * and the authenticated owner; foreign/missing ids 404 identically.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { param } from "./helpers.js";

export const findingsRouter = Router({ mergeParams: true });

function ownerIdOf(req: Request): string {
  return (req as Request & { ownerId?: string }).ownerId ?? "";
}

findingsRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation || store.getOwner(id) !== ownerIdOf(req)) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  const findings = store.listFindings(id);
  res.json(findings);
});

findingsRouter.get("/:fndId", (req: Request, res: Response) => {
  const investigationId = param(req, "id");
  const finding = store.getFinding(param(req, "fndId"));
  if (!finding || !store.resourceBelongsTo(ownerIdOf(req), investigationId, finding)) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.json(finding);
});
