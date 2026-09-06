/**
 * SSE events route.
 *
 * GET /api/investigations/:id/events
 *
 * Streams real-time investigation progress events.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { subscribe } from "./events.js";
import { param } from "./helpers.js";

export const eventsRouter = Router({ mergeParams: true });

eventsRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);
  if (!investigation) {
    res.status(404).json({ error: "Investigation not found" });
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
  });
});
