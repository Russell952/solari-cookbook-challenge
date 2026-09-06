/**
 * API router.
 *
 * Mounts all route handlers under /api.
 */
import { Router } from "express";
import { investigationsRouter } from "./investigations.js";
import { experimentsRouter } from "./experiments.js";
import { findingsRouter } from "./findings.js";
import { evidenceRouter } from "./evidence.js";
import { eventsRouter } from "./events-route.js";
import { summaryRouter } from "./summary.js";

export const apiRouter = Router();

apiRouter.use("/investigations", investigationsRouter);
apiRouter.use("/investigations/:id/experiments", experimentsRouter);
apiRouter.use("/investigations/:id/findings", findingsRouter);
apiRouter.use("/investigations/:id/evidence", evidenceRouter);
apiRouter.use("/investigations/:id/events", eventsRouter);
apiRouter.use("/investigations/:id/summary", summaryRouter);
