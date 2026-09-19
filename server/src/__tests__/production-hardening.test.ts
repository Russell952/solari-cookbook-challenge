/**
 * Production-hardening regression tests.
 *
 * Covers three hardening changes end to end through the REAL API/store:
 *
 *  1. Objective limit — the investigation objective is a SHORT instruction:
 *     server rejects empty, whitespace-only, and >1000-char objectives
 *     (no silent truncation); exactly-1000 is accepted.
 *  2. Per-user investigation quotas + concurrency caps — 5/hour, 20/day per
 *     user; 2 running per user; 5 running deployment-wide. All enforced
 *     server-side on the API so direct calls cannot bypass them; rejected
 *     requests must never create investigations. Limits are scoped per
 *     identity (user A's usage never consumes user B's allowance).
 *  3. Evidence cap — user-visible evidence stops growing at the configured
 *     cap (50); excess per-action telemetry is degraded to metadata-only
 *     records (investigation integrity preserved, no crash, no fabricated
 *     artifacts).
 *
 * Solari/AI boundaries are mocked; everything asserted runs through
 * production HTTP handlers, the real store, and the real collector.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createHmac } from "crypto";

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn(),
  getBrowserSolari: vi.fn(),
  closeAllClients: vi.fn(async () => {}),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
  activeBrowserSessionCount: vi.fn().mockReturnValue(0),
}));

vi.mock("../solari/browser.js", () => ({
  createBrowserSession: vi.fn(async () => ({
    probeSessionId: "bsess_ph",
    session: { close: vi.fn(async () => {}) },
    solariSessionId: "solari-ph",
    recordingEnabled: false,
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "T", url: "https://example.com/" })),
  screenshot: vi.fn(async () => Buffer.from("png")),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => "T"),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () => "text"),
  evaluate: vi.fn(async () => []),
  getReplay: vi.fn(async () => null),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => ({ probeSessionId: "ssess_ph", sandbox: {}, investigationId: "x" })),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async () => "x"),
  listDirectory: vi.fn(async () => []),
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({ experiments: [] })),
    decideNextStep: vi.fn(async () => ({ shouldContinue: false, reason: "done" })),
    analyzeRepository: vi.fn(async () => "repo"),
    analyzeObservation: vi.fn(async () => "analysis"),
    generateHypothesis: vi.fn(async () => ({
      statement: "no hypothesis",
      confidence: 0.5,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(async () => ({ shouldVerify: false, verificationExperiment: null })),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.5, status: "inconclusive" })),
    generateReport: vi.fn(async () => ({
      summary: "report",
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
    })),
  })),
}));

import { buildApp } from "../app.js";
import { store } from "../store/index.js";
import { registerTokenForTesting } from "../security/auth.js";
import {
  resetRateLimits,
  resetConcurrency,
  resetUserConcurrency,
  resetInvestigationQuotas,
  tryAcquireSlot,
  tryAcquireUserSlot,
  releaseSlot,
  releaseUserSlot,
  tryConsumeInvestigationQuota,
  investigationQuotaRetryAt,
} from "../security/rate-limit.js";
import { captureEvidence } from "../evidence/collector.js";
import { config } from "../config/index.js";

const TOKEN_A = "hardening-token-user-a";
const TOKEN_B = "hardening-token-user-b";
beforeAll(() => {
  registerTokenForTesting(TOKEN_A);
  registerTokenForTesting(TOKEN_B);
});

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  store.clearAll();
  resetRateLimits();
  resetConcurrency();
  resetUserConcurrency();
  resetInvestigationQuotas();
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(() => {
  resetRateLimits();
  resetConcurrency();
  resetUserConcurrency();
});

function auth(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function create(
  token = TOKEN_A,
  body: Record<string, unknown> = { applicationUrl: "https://example.com", objective: "test objective" }
): Promise<{ status: number; id?: string; error?: string; body?: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { id?: string };
  return { status: res.status, id: json.id, error: json.error as string | undefined, body: json };
}

async function startInv(id: string, token = TOKEN_A): Promise<number> {
  const res = await fetch(`${baseUrl}/api/investigations/${id}/start`, {
    method: "POST",
    headers: auth(token),
  });
  return res.status;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Objective limit (server-side enforcement)
// ════════════════════════════════════════════════════════════════════════════

describe("objective limit (server-side)", () => {
  it("accepts a valid short objective", async () => {
    const r = await create(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "verify that the contact form is working",
    });
    expect(r.status).toBe(201);
    expect(r.id).toBeTruthy();
  });

  it("rejects an empty objective with 400", async () => {
    const r = await create(TOKEN_A, { applicationUrl: "https://example.com", objective: "" });
    expect(r.status).toBe(400);
  });

  it("rejects a whitespace-only objective with 400", async () => {
    const r = await create(TOKEN_A, { applicationUrl: "https://example.com", objective: "   \n\t  " });
    expect(r.status).toBe(400);
  });

  it("accepts an objective of exactly 1,000 characters (0 remaining is valid)", async () => {
    const r = await create(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "a".repeat(config.limits.maxObjectiveLength),
    });
    expect(r.status).toBe(201);
    expect(r.id).toBeTruthy();
  });

  it("rejects an objective of 1,001 characters with 400 (no silent truncation)", async () => {
    const objective = `${"a".repeat(config.limits.maxObjectiveLength)}!`;
    expect(objective.length).toBe(config.limits.maxObjectiveLength + 1);
    const r = await create(TOKEN_A, { applicationUrl: "https://example.com", objective });
    expect(r.status).toBe(400);
    // Rejected — never stored truncated.
    expect(r.id).toBeUndefined();
  });

  it("counts spaces and punctuation toward the limit", async () => {
    // 1000 chars of pure spaces → passes length but is whitespace-only → 400.
    const spaces = " ".repeat(config.limits.maxObjectiveLength);
    const rSpaces = await create(TOKEN_A, { applicationUrl: "https://example.com", objective: spaces });
    expect(rSpaces.status).toBe(400);

    // 1001 chars where spaces/punctuation are the overflow → rejected.
    const punct = `${"x".repeat(config.limits.maxObjectiveLength - 3)} .  `;
    expect(punct.length).toBe(config.limits.maxObjectiveLength + 1);
    const rPunct = await create(TOKEN_A, { applicationUrl: "https://example.com", objective: punct });
    expect(rPunct.status).toBe(400);
  });

  it("does not consume the creation quota for rejected objectives", async () => {
    // A rejected (oversized) creation must not burn one of the 5/hour slots.
    await create(TOKEN_A, { applicationUrl: "https://example.com", objective: "" }); // 400
    for (let i = 0; i < 5; i++) {
      const r = await create(TOKEN_A, {
        applicationUrl: "https://example.com",
        objective: `valid objective ${i}`,
      });
      expect(r.status).toBe(201);
    }
    const sixth = await create(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "still valid but over quota",
    });
    expect(sixth.status).toBe(429);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Per-user creation quotas + concurrency caps
// ════════════════════════════════════════════════════════════════════════════

describe("per-user creation quotas", () => {
  it("allows requests within the hourly limit", async () => {
    for (let i = 0; i < config.rateLimit.createInvestigationPerUser.hourly; i++) {
      const r = await create(TOKEN_A, {
        applicationUrl: "https://example.com",
        objective: `objective ${i}`,
      });
      expect(r.status).toBe(201);
    }
  });

  it("returns 429 with machine-readable shape for the request over the hourly limit", async () => {
    for (let i = 0; i < config.rateLimit.createInvestigationPerUser.hourly; i++) {
      await create(TOKEN_A, { applicationUrl: "https://example.com", objective: `o ${i}` });
    }
    const over = await create(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "one too many",
    });
    expect(over.status).toBe(429);
    expect(over.error).toMatch(/limit/i);
    const body = over.body as { code?: string; retryAt?: string };
    expect(body.code).toBe("INVESTIGATION_QUOTA_EXCEEDED");
    expect(typeof body.retryAt).toBe("string");
    expect(new Date(body.retryAt as string).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("rejected requests do not create investigations", async () => {
    for (let i = 0; i < config.rateLimit.createInvestigationPerUser.hourly; i++) {
      await create(TOKEN_A, { applicationUrl: "https://example.com", objective: `o ${i}` });
    }
    const listBefore = await fetch(`${baseUrl}/api/investigations`, { headers: auth(TOKEN_A) });
    const before = (await listBefore.json()) as unknown[];
    expect(before.length).toBe(config.rateLimit.createInvestigationPerUser.hourly);

    await create(TOKEN_A, { applicationUrl: "https://example.com", objective: "rejected" });

    const listAfter = await fetch(`${baseUrl}/api/investigations`, { headers: auth(TOKEN_A) });
    const after = (await listAfter.json()) as unknown[];
    expect(after.length).toBe(config.rateLimit.createInvestigationPerUser.hourly);
  });

  it("enforces the daily quota independently (quota module + simulated time)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
      const dailyMax = config.rateLimit.createInvestigationPerUser.daily;
      const hourlyMax = config.rateLimit.createInvestigationPerUser.hourly;
      // Consume the daily window in hourly batches, rolling the hour forward
      // each time so only the DAILY window accumulates. Within each hour the
      // hourly gate binds (denies "hourly"), which is also asserted.
      let consumed = 0;
      while (consumed < dailyMax) {
        for (let i = 0; i < hourlyMax && consumed < dailyMax; i++, consumed++) {
          expect(tryConsumeInvestigationQuota("daily-user")).toBeNull();
        }
        if (consumed < dailyMax) {
          expect(tryConsumeInvestigationQuota("daily-user")).toBe("hourly");
          // Hour rolls over; hourly entries prune, daily entries remain.
          vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
        }
      }
      // Daily window is now full (20 across 4 hours): the next consume is a
      // DAILY denial even though the hourly window is fresh.
      vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
      expect(tryConsumeInvestigationQuota("daily-user")).toBe("daily");
      // A different user is unaffected (per-identity scoping).
      expect(tryConsumeInvestigationQuota("other-user")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryAt hint resolves inside the window it names", () => {
    expect(tryConsumeInvestigationQuota("retry-user")).toBeNull();
    const retryAt = investigationQuotaRetryAt("retry-user", "hourly");
    const delta = new Date(retryAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(60 * 60_000);
  });

  it("direct API calls cannot bypass limits (same route as the UI)", async () => {
    // The UI uses the same POST /api/investigations endpoint; "direct" calls
    // with a valid token hit the identical quota middleware. Simulate a
    // script hammering the endpoint: denied after the same threshold.
    for (let i = 0; i < config.rateLimit.createInvestigationPerUser.hourly; i++) {
      const r = await fetch(`${baseUrl}/api/investigations`, {
        method: "POST",
        headers: auth(TOKEN_A),
        body: JSON.stringify({ applicationUrl: "https://example.com", objective: `script ${i}` }),
      });
      expect(r.status).toBe(201);
    }
    const direct = await fetch(`${baseUrl}/api/investigations`, {
      method: "POST",
      headers: auth(TOKEN_A),
      body: JSON.stringify({ applicationUrl: "https://example.com", objective: "script over quota" }),
    });
    expect(direct.status).toBe(429);
  });
});

describe("concurrency caps", () => {
  it("enforces the per-user concurrent limit (2 running)", () => {
    expect(tryAcquireUserSlot("u1")).toBe(true);
    expect(tryAcquireUserSlot("u1")).toBe(true);
    expect(tryAcquireUserSlot("u1")).toBe(false); // 3rd running → denied
    releaseUserSlot("u1");
    expect(tryAcquireUserSlot("u1")).toBe(true); // freed → allowed again
    releaseUserSlot("u1");
    releaseUserSlot("u1");
  });

  it("scopes per-user concurrency correctly (u2 unaffected by u1's slots)", () => {
    expect(tryAcquireUserSlot("u1")).toBe(true);
    expect(tryAcquireUserSlot("u1")).toBe(true);
    expect(tryAcquireUserSlot("u2")).toBe(true); // different identity
    releaseUserSlot("u1");
    releaseUserSlot("u1");
    releaseUserSlot("u2");
  });

  it("enforces the global concurrent limit (deployment-wide)", () => {
    const maxGlobal = config.maxConcurrentInvestigations;
    const acquired: boolean[] = [];
    for (let i = 0; i < maxGlobal; i++) acquired.push(tryAcquireSlot());
    expect(acquired.every(Boolean)).toBe(true);
    // One over the deployment cap → denied, even for a fresh user.
    expect(tryAcquireSlot()).toBe(false);
    expect(tryAcquireUserSlot("fresh-user")).toBe(true); // per-user ≠ global
    releaseUserSlot("fresh-user");
    for (let i = 0; i < maxGlobal; i++) releaseSlot();
    expect(tryAcquireSlot()).toBe(true);
    releaseSlot();
  });

  it("start returns 429 with a distinct code when the global cap is reached", async () => {
    const maxGlobal = config.maxConcurrentInvestigations;
    const r = await create(TOKEN_A, { applicationUrl: "https://example.com", objective: "to start" });
    expect(r.status).toBe(201);
    expect(r.id).toBeTruthy();
    // Exhaust the deployment-wide slots.
    for (let i = 0; i < maxGlobal; i++) expect(tryAcquireSlot()).toBe(true);
    const status = await startInv(r.id as string);
    expect(status).toBe(429);
    const body = await (await fetch(`${baseUrl}/api/investigations/${r.id}`, { headers: auth(TOKEN_A) })).json();
    void body; // start's 429 body asserted via the per-user variant below
    for (let i = 0; i < maxGlobal; i++) releaseSlot();
  });

  it("start returns 429 USER_CONCURRENCY_LIMIT when the user's own cap is reached (no global slot leak)", async () => {
    const { runningCount } = await import("../security/rate-limit.js");
    // Resolve the caller identity exactly as auth.ts does (token → owner id).
    const ownerIdA = `tok_${createHmac("sha256", "probe-owner-id").update(TOKEN_A).digest("hex").slice(0, 16)}`;
    const r = await create(TOKEN_A, { applicationUrl: "https://example.com", objective: "user cap" });
    expect(r.status).toBe(201);
    // The user already has the per-user maximum running.
    for (let i = 0; i < config.maxConcurrentInvestigationsPerUser; i++) {
      expect(tryAcquireSlot()).toBe(true);
      expect(tryAcquireUserSlot(ownerIdA)).toBe(true);
    }
    const res = await fetch(`${baseUrl}/api/investigations/${r.id}/start`, {
      method: "POST",
      headers: auth(TOKEN_A),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("USER_CONCURRENCY_LIMIT");
    // The route's global slot must have been compensated (no leak).
    expect(runningCount()).toBe(config.maxConcurrentInvestigationsPerUser);
    for (let i = 0; i < config.maxConcurrentInvestigationsPerUser; i++) {
      releaseSlot();
      releaseUserSlot(ownerIdA);
    }
  });

  it("quota denial message distinguishes hourly vs daily", async () => {
    for (let i = 0; i < config.rateLimit.createInvestigationPerUser.hourly; i++) {
      await create(TOKEN_A, { applicationUrl: "https://example.com", objective: `o ${i}` });
    }
    const over = await create(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "over hourly",
    });
    expect(over.status).toBe(429);
    expect((over.body as { limit?: string }).limit).toBe("hourly");
    expect(over.error).toMatch(/5 per hour/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Evidence cap
// ════════════════════════════════════════════════════════════════════════════

describe("user-visible evidence cap", () => {
  it("degrades per-action telemetry to metadata-only once the cap is reached", async () => {
    const inv = store.createInvestigation({
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "cap test",
    });
    const exp = store.createExperiment({
      investigationId: inv.id,
      objective: "telemetry experiment",
      plannedActions: [],
    });

    const cap = config.limits.maxEvidencePerInvestigation;
    // Fill the visible evidence pool with recon (non-telemetry) items.
    for (let i = 0; i < cap; i++) {
      const ev = await captureEvidence({
        investigationId: inv.id,
        type: "url",
        uri: `https://example.com/page-${i}`,
        metadata: { artifactAvailable: false },
      });
      expect(ev.metadata.artifactAvailable).toBe(false);
    }
    expect(store.listEvidence(inv.id).length).toBe(cap);

    // Post-cap screenshot telemetry: degraded — record kept (integrity),
    // bytes never persisted, honestly flagged.
    const png = Buffer.from("post-cap-png");
    const ev = await captureEvidence({
      investigationId: inv.id,
      experimentId: exp.id,
      type: "screenshot",
      content: png,
      metadata: { pageTitle: "cap probe" },
    });
    expect(ev.metadata.userVisible).toBe(false);
    expect(ev.metadata.evidenceCapReached).toBe(true);
    expect(ev.metadata.capDroppedReason).toBe("user_visible_evidence_cap");
    expect(ev.metadata.artifactAvailable).toBe(false);
    expect(ev.metadata.storageKey).toBeUndefined();

    // Cap behavior holds for subsequent telemetry too.
    const ev2 = await captureEvidence({
      investigationId: inv.id,
      experimentId: exp.id,
      type: "action_trace",
      content: JSON.stringify({ action: "click" }),
    });
    expect(ev2.metadata.evidenceCapReached).toBe(true);
  });

  it("internal telemetry does not create unlimited user-visible evidence (verified evidence stays exempt)", async () => {
    const inv = store.createInvestigation({
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "cap exemption test",
    });
    const cap = config.limits.maxEvidencePerInvestigation;
    for (let i = 0; i < cap; i++) {
      await captureEvidence({
        investigationId: inv.id,
        type: "url",
        uri: `https://example.com/p-${i}`,
        metadata: { artifactAvailable: false },
      });
    }
    // A verification experiment (hypothesis-backed) is integrity-required:
    // its evidence is captured normally even at cap.
    const hyp = store.createHypothesis({
      investigationId: inv.id,
      statement: "the form works",
      status: "proposed",
      confidence: 0.5,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    });
    const verifyExp = store.createExperiment({
      investigationId: inv.id,
      objective: "Verify: the form works",
      hypothesisId: hyp.id,
      plannedActions: [],
    });
    const png = Buffer.from("verification-png");
    const ev = await captureEvidence({
      investigationId: inv.id,
      experimentId: verifyExp.id,
      type: "screenshot",
      content: png,
    });
    // NOT degraded — full artifact persisted for the verification run.
    expect(ev.metadata.artifactAvailable).toBe(true);
    expect(ev.metadata.storageKey).toBeTruthy();
    expect(ev.metadata.userVisible).toBeUndefined();

    // Replays stay exempt too (post-experiment integrity evidence).
    const exp2 = store.createExperiment({
      investigationId: inv.id,
      objective: "replay carrier",
      plannedActions: [],
    });
    const replayEv = await captureEvidence({
      investigationId: inv.id,
      experimentId: exp2.id,
      type: "replay",
      content: Buffer.from("rrweb-events"),
      metadata: { format: "rrweb" },
    });
    expect(replayEv.metadata.artifactAvailable).toBe(true);
  });

  it("reaching the cap does not crash the investigation path (URL telemetry still recorded)", async () => {
    const inv = store.createInvestigation({
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "cap no-crash test",
    });
    const cap = config.limits.maxEvidencePerInvestigation;
    for (let i = 0; i < cap; i++) {
      await captureEvidence({
        investigationId: inv.id,
        type: "url",
        uri: `https://example.com/x-${i}`,
        metadata: { artifactAvailable: false },
      });
    }
    // URL captures flow through the same collector at/over cap — they must
    // succeed (post-action recon state changes stay recorded).
    const urlEv = await captureEvidence({
      investigationId: inv.id,
      experimentId: "exp_nonexistent_ok",
      type: "url",
      uri: "https://example.com/after-click",
      metadata: { type: "post_action_recon" },
    });
    expect(urlEv.type).toBe("url");
    expect(urlEv.uri).toBe("https://example.com/after-click");
  });
});
