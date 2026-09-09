/**
 * Production-environment session-cookie regression tests.
 *
 * These run the REAL app and REAL cookie serializer with NODE_ENV=production
 * (set in vi.hoisted, before any module evaluates — isProduction is captured
 * at import time, so a separate file with its own module graph is the only
 * reliable way to test the production branch).
 *
 * What this pins:
 *   - Production Set-Cookie: SameSite=None; Secure; HttpOnly; Path=/; Max-Age
 *     (cross-site Vercel → Render requires None; browsers require Secure with it)
 *   - Production logout clears with matching attributes
 *   - Signup → cookie → /api/auth/me works end-to-end under production config
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { buildApp } from "../app.js";
import { resetUserStore } from "../auth/users.js";
import { resetRateLimits } from "../security/rate-limit.js";

// Before ANY module import evaluates: config + auth snapshot NODE_ENV at import.
vi.hoisted(() => {
  process.env.NODE_ENV = "production";
  process.env.PROBE_SESSION_SECRET = "test-production-session-secret";
  process.env.CORS_ORIGIN = "https://probe-challenge.vercel.app";
});

let usersDir: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  usersDir = await mkdtemp(join(tmpdir(), "probe-users-prod-"));
  process.env.PROBE_USERS_DIR = usersDir;
});

afterAll(async () => {
  await rm(usersDir, { recursive: true, force: true });
  delete process.env.PROBE_USERS_DIR;
  // Restore for any same-process consumer (vitest isolates per file by default).
  process.env.NODE_ENV = "test";
});

beforeEach(async () => {
  resetUserStore();
  resetRateLimits();
  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function sessionCookieHeader(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("expected Set-Cookie on the response");
  return raw;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("production session cookie (NODE_ENV=production)", () => {
  it("signup sets SameSite=None; Secure; HttpOnly; Path=/; finite Max-Age", async () => {
    const res = await postJson("/api/auth/signup", {
      email: "prod-cookie@example.com",
      password: "longenough1",
    });
    expect(res.status).toBe(201);
    const header = sessionCookieHeader(res);
    expect(header).toContain("probe_session=");
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/");
    expect(header).toMatch(/Max-Age=\d+/);
    // None without Secure is rejected by browsers — both must be present.
    expect(header).not.toContain("SameSite=Lax");
  });

  it("login sets the same production attributes", async () => {
    await postJson("/api/auth/signup", { email: "prod-login@example.com", password: "longenough1" });
    const res = await postJson("/api/auth/login", {
      email: "prod-login@example.com",
      password: "longenough1",
    });
    expect(res.status).toBe(200);
    const header = sessionCookieHeader(res);
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Secure");
  });

  it("logout clears with matching production attributes (SameSite=None; Secure)", async () => {
    await postJson("/api/auth/signup", { email: "prod-logout@example.com", password: "longenough1" });
    const res = await postJson("/api/auth/logout", {});
    expect(res.status).toBe(200);
    const header = sessionCookieHeader(res);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
  });

  it("the production cookie authenticates /api/auth/me (signup → cookie → 200)", async () => {
    const signup = await postJson("/api/auth/signup", {
      email: "prod-me@example.com",
      password: "longenough1",
    });
    const setCookie = sessionCookieHeader(signup);
    const cookie = setCookie.split(";")[0]; // "probe_session=..."
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { email: string } };
    expect(body.user.email).toBe("prod-me@example.com");
  });

  it("without a cookie, protected routes stay 401 in production mode", async () => {
    const me = await fetch(`${baseUrl}/api/auth/me`);
    expect(me.status).toBe(401);
    const inv = await fetch(`${baseUrl}/api/investigations`);
    expect(inv.status).toBe(401);
  });
});
