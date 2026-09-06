/** @vitest-environment node */
import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { buildApp } from "/home/daytona/codebase/server/src/app.js";

let server: Server;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

describe("health endpoint", () => {
  it("exposes /api/health for the client", async () => {
    server = buildApp().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });
});
