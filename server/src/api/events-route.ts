/**
 * SSE events route.
 *
 * GET /api/investigations/:id/events
 *
 * Streams real-time investigation progress events. Owner-scoped and
 * connection-capped (globally and per investigation) so SSE cannot be used
 * to exhaust server sockets.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { subscribe } from "./events.js";
import { param } from "./helpers.js";
import { tryAcquireSse, releaseSse } from "../security/rate-limit.js";

export const eventsRouter = Router({ mergeParams: true });

eventsRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  const ownerId = (req as Request & { ownerId?: string }).ownerId ?? "";
  if (!investigation || store.getOwner(id) !== ownerId) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  // Connection cap: reject when this investigation or the deployment is at
  // its SSE limit (malicious or buggy clients cannot pin unlimited sockets).
  if (!tryAcquireSse(id)) {
    res.status(429).json({ error: "Too many event connections" });
    return;
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send initial state
  res.write(`data: ${JSON.stringify({
    type: "connected",
    investigationId: id,
    data: { status: investigation.status, phase: investigation.currentPhase },
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // Subscribe to future events
  subscribe(id, res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    releaseSse(id);
  });
});
