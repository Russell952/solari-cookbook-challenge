/**
 * Express app construction.
 *
 * Separated from server.ts so the exact production app (middleware, routes,
 * error handling) can be instantiated without binding a port — used by the
 * server entry point and by the runner integration tests.
 */
import express from "express";
import cors from "cors";
import { config } from "./config/index.js";
import { apiRouter } from "./api/index.js";

export function buildApp(): express.Express {
  const app = express();

  // Middleware
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "10mb" }));

  // API routes
  app.use("/api", apiRouter);

  // Health check. `/api/health` is the canonical path the client uses
  // through the dev proxy; `/health` is kept as an alias for direct access.
  const healthHandler = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  return app;
}
