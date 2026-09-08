/**
 * Evidence API routes.
 *
 * GET /api/investigations/:id/evidence                     - List evidence
 * GET /api/investigations/:id/evidence/:evId               - Get evidence metadata
 * GET /api/investigations/:id/evidence/:evId/content       - Get artifact bytes
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { getEvidenceContent } from "../evidence/index.js";
import { param } from "./helpers.js";

export const evidenceRouter = Router({ mergeParams: true });

/** The authenticated caller's owner id (set by requireAuth). */
function ownerIdOf(req: Request): string {
  return (req as Request & { ownerId?: string }).ownerId ?? "";
}

evidenceRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation || store.getOwner(id) !== ownerIdOf(req)) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  const evidence = store.listEvidence(id);
  res.json(evidence);
});

evidenceRouter.get("/:evId", (req: Request, res: Response) => {
  const investigationId = param(req, "id");
  const evidence = store.getEvidence(param(req, "evId"));
  // Ownership: the evidence must belong to the investigation in the URL AND
  // that investigation must belong to the caller. Missing and foreign ids are
  // indistinguishable 404s — no enumeration signal.
  if (!evidence || !store.resourceBelongsTo(ownerIdOf(req), investigationId, evidence)) {
    res.status(404).json({ error: "Evidence not found" });
    return;
  }
  res.json(evidence);
});

/**
 * Serve the persisted artifact bytes for an evidence item.
 *
 * Screenshots download/display as images; JSON artifacts as JSON. 404s when
 * the evidence item is unknown, has no artifact, or the artifact is no longer
 * on disk — the metadata endpoint remains the source of truth for availability.
 *
 * Ownership: the evidence must belong to the investigation in the URL. The
 * store's IDs are system-owned, but the route still enforces the boundary
 * explicitly so a mismatched pair can never leak artifacts.
 */
evidenceRouter.get("/:evId/content", async (req: Request, res: Response) => {
  const investigationId = param(req, "id");
  const evidence = store.getEvidence(param(req, "evId"));

  // Ownership boundary: evidence must exist, belong to the investigation in
  // the URL, AND that investigation must belong to the authenticated caller.
  // Missing evidence, foreign evidence, and another caller's evidence are
  // indistinguishable 404s — no information leak about foreign IDs.
  if (
    !evidence ||
    evidence.investigationId !== investigationId ||
    store.getOwner(investigationId) !== ownerIdOf(req)
  ) {
    res.status(404).json({ error: "Evidence not found" });
    return;
  }

  const { buffer, sha256, hashVerified } = await getEvidenceContent(evidence);
  if (!buffer) {
    res.status(404).json({ error: "Evidence artifact not available" });
    return;
  }

  res.setHeader("Content-Type", (evidence.metadata?.mimeType as string) ?? "application/octet-stream");
  res.setHeader("Content-Length", String(buffer.length));
  res.setHeader("X-Evidence-SHA256", `sha256:${sha256 ?? ""}`);
  // Artifacts are immutable once persisted; verify fresh on every fetch.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Evidence-Hash-Verified", String(hashVerified));

  // Artifacts can be large (screenshots, replays); only JSON evidence types
  // that clients typically render inline get an inline disposition.
  const isInline = evidence.type === "action_trace" || evidence.type === "repository_source";
  const ext = isInline ? "json" : evidence.type === "screenshot" ? "png" : "bin";
  res.setHeader(
    "Content-Disposition",
    `${isInline ? "inline" : "attachment"}; filename="${evidence.id}.${ext}"`
  );

  res.send(buffer);
});
