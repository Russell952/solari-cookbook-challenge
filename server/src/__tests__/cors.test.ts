/**
 * CORS allowlist tests.
 *
 * The app's cors() middleware allowlists origins from config.corsOrigin
 * (CORS_ORIGIN, comma-separated) and denies everything else by issuing no
 * CORS headers. Requests without an Origin header (curl, tests, uptime
 * probes) are allowed through since they are not browser requests.
 *
 * These tests boot the real production app on an ephemeral port so the
 * middleware order (helmet → cors → auth) is exercised exactly as deployed.
 */
/** @vitest-environment node */
import { afterEach, describe, it, expect, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { buildApp } from "../app.js";
import { config as liveConfig } from "../config/index.js";

const PROD_FRONTEND = "https://probe-challenge.vercel.app";

// config/index.ts snapshots CORS_ORIGIN at import time, and app.ts reads
// config.corsOrigin at buildApp() time. Each test sets the env var, re-imports
// config for a fresh snapshot, and mirrors that snapshot onto the live module
// object app.ts references, so the middleware sees the test's origin list.
async function withCorsEnv<T>(
  corsOrigin: string,
  fn: () => Promise<T>
): Promise<T> {
  const saved = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = corsOrigin;
  vi.resetModules();
  const { config } = await import("../config/index.js");
  const mutable = liveConfig as { corsOrigin: string };
  const prev = mutable.corsOrigin;
  mutable.corsOrigin = config.corsOrigin;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = saved;
    mutable.corsOrigin = prev;
  }
}

async function startApp(): Promise<{ server: Server; base: string }> {
  const server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

let active: Server[] = [];
afterEach(async () => {
  const toClose = active;
  active = [];
  await Promise.all(
    toClose.map((s) => new Promise<void>((r) => s.close(() => r())))
  );
});

describe("CORS allowlist (production deployment)", () => {
  it(
    "issues Access-Control-Allow-Origin for the production frontend origin",
    async () => {
      await withCorsEnv(PROD_FRONTEND, async () => {
        const { server, base } = await startApp();
        active.push(server);
        const res = await fetch(`${base}/health`, {
          headers: { Origin: PROD_FRONTEND },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe(
          PROD_FRONTEND
        );
      });
    }
  );

  it("denies a foreign origin by sending no CORS headers", async () => {
    await withCorsEnv(PROD_FRONTEND, async () => {
      const { server, base } = await startApp();
      active.push(server);
      const res = await fetch(`${base}/health`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  it("allows requests without an Origin header (curl, uptime probes)", async () => {
    await withCorsEnv(PROD_FRONTEND, async () => {
      const { server, base } = await startApp();
      active.push(server);
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    });
  });

  it("supports multiple comma-separated origins", async () => {
    await withCorsEnv(`${PROD_FRONTEND},http://localhost:5173`, async () => {
      const { server, base } = await startApp();
      active.push(server);
      const vercel = await fetch(`${base}/health`, {
        headers: { Origin: PROD_FRONTEND },
      });
      expect(vercel.headers.get("access-control-allow-origin")).toBe(
        PROD_FRONTEND
      );
      const local = await fetch(`${base}/health`, {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(local.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:5173"
      );
    });
  });

  it("never reflects an arbitrary Origin (no wildcard echo)", async () => {
    await withCorsEnv(PROD_FRONTEND, async () => {
      const { server, base } = await startApp();
      active.push(server);
      const res = await fetch(`${base}/health`, {
        headers: { Origin: "null" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});
