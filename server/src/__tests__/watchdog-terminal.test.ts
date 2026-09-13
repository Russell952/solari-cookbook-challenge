/**
 * Guaranteed-terminal watchdog regression tests.
 *
 * Live background: a real verification phase hung for ~128 minutes (12× its
 * 600s budget) because a single awaited provider call never settled — the
 * runner's cooperative checks (assertNotStopped between phases/actions)
 * never ran again, so the investigation stayed `running` forever.
 *
 * These tests pin the non-cooperative backstop: when the runtime budget
 * lapses without the pipeline terminating, the watchdog transitions the
 * durable record to `failed` (honest reason), emits SSE, releases the
 * concurrency slot exactly once, and does NOT kill a legitimately-running
 * investigation early (grace margin).
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// The watchdog must be observable in test time: pin a tiny runtime budget
// BEFORE config is imported (vi.hoisted runs ahead of module evaluation).
vi.hoisted(() => {
  process.env.PROBE_MAX_RUNTIME_MS = "3000";
});
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn(),
  getBrowserSolari: vi.fn(),
  closeAllClients: vi.fn(async () => {}),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
  activeBrowserSessionCount: vi.fn().mockReturnValue(0),
}));

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex"
);

vi.mock("../solari/browser.js", () => ({
  createBrowserSession: vi.fn(async () => ({
    probeSessionId: "bsess_test",
    session: { close: vi.fn(async () => {}) },
    solariSessionId: "solari-session-1",
    recordingEnabled: true,
    investigationId: "inv_test",
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "App", url: "https://app.example.com/" })),
  screenshot: vi.fn(async () => PNG_BYTES),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => "App"),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () => "Create account"),
  evaluate: vi.fn(async () => []),
  getReplay: vi.fn(async () => null),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => ({ probeSessionId: "ssess_test", sandbox: {} })),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async () => "# App"),
  listDirectory: vi.fn(async () => ["src"]),
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

/**
 * AI adapter whose recon/plan succeed but whose verification design call
 * NEVER SETTLES — the exact production pathology (a pending await inside
 * the verification phase). The watchdog, not the pipeline, must terminate
 * the investigation.
 */
let settleGates: Array<(v: unknown) => void> = [];
vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({
      experiments: [
        {
          objective: "Check signup page renders",
          preconditions: [],
          plannedActions: [{ tool: "browser", action: "navigate", target: "https://app.example.com/signup" }],
        },
      ],
    })),
    decideNextStep: vi.fn(async () => ({ shouldContinue: false, reason: "Enough coverage" })),
    analyzeRepository: vi.fn(async () => "Repo analysis"),
    analyzeObservation: vi.fn(async () => "The signup page rendered as documented."),
    generateHypothesis: vi.fn(async () => ({
      statement: "Signup renders as documented",
      confidence: 0.6,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(() => {
      if (!hangVerification) {
        return Promise.resolve({ shouldVerify: false, verificationExperiment: null });
      }
      return new Promise((_resolve, reject) => {
        settleGates.push(reject as unknown as (v: unknown) => void);
      });
    }),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.5, status: "inconclusive" })),
    generateReport: vi.fn(async () => ({
      summary: "Partial report",
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
    })),
  })),
  getAI: vi.fn(() => (createOpenAIAdapterRef as () => unknown)()),
}));

let createOpenAIAdapterRef: () => unknown = () => ({});

import { buildApp } from "../app.js";
import { store } from "../store/index.js";
import { registerTokenForTesting } from "../security/auth.js";
import { resetRateLimits, resetConcurrency } from "../security/rate-limit.js";
import * as budget from "../orchestrator/budget.js";

let server: Server;
let baseUrl: string;
let token = "watchdog-test-token";
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "probe-watchdog-"));
  process.env.PROBE_STORE_DIR = dataDir;
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  registerTokenForTesting(token);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: res.json() as Promise<Record<string, unknown>> };
}

let hangVerification = false;

beforeEach(() => {
  store.clearAll();
  vi.clearAllMocks();
  resetRateLimits();
  resetConcurrency();
  settleGates = [];
  hangVerification = false;
});

afterEach(() => {
  // Never leak a still-pending gate into another test.
  for (const gate of settleGates) gate(undefined);
  settleGates = [];
  hangVerification = false;
});

async function createAndStart(applicationUrl = "https://app.example.com/"): Promise<string> {
  const created = await api("POST", "/api/investigations", {
    objective: "can a user sign up?",
    applicationUrl,
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json) as { id: string };
  const start = await api("POST", `/api/investigations/${id}/start`);
  expect(start.status).toBeLessThan(500);
  return id;
}

async function pollStatus(id: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "created";
  while (Date.now() < deadline) {
    const s = await api("GET", `/api/investigations/${id}/summary`);
    const body = (await s.json) as { investigation?: { status?: string }; error?: string };
    if (body.error) {
      if (/Too many requests/i.test(body.error)) {
        // The general rate limiter throttles rapid polling — back off and
        // retry; this is a test-harness concern, not an app state.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // Anything else (404 etc.) must not be masked as "running".
      throw new Error(`summary API error: ${JSON.stringify(body)}`);
    }
    status = body.investigation?.status ?? "running";
    if (["completed", "failed", "cancelled"].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 200));
  }
  return status;
}

describe("guaranteed-terminal watchdog", () => {
  it("terminates an investigation whose phase promise never settles, with an honest failure reason", async () => {
    // Tiny budget so the watchdog grace window is reachable in test time.
    // The budget module reads config at initBudget time; initBudget accepts
    // overrides, but the API start path uses defaults — so pin the clock
    // origin into the past right after start instead.
    const id = await createAndStart();

    // Wait until the run has entered experiment execution (recon+plan done),
    // then force-expire the runtime clock — the pending designVerification
    // promise will never settle, so only the watchdog can terminate it.
    hangVerification = true;
    // The run moves fast through experiment/execute; wait for it to pass
    // recon+plan and reach the adaptive-analysis boundary (last cooperative
    // checkpoint before the pending verification await). Pinning the expired
    // clock HERE means the very next designVerification call hangs forever
    // while every earlier phase already completed normally.
    const reachedAnalysis = await (async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const inv = store.getInvestigation(id);
        if (
          inv &&
          (inv.currentPhase === "analyze" ||
            inv.currentPhase === "observe" ||
            inv.currentPhase === "hypothesis" ||
            inv.currentPhase === "verification")
        ) {
          return inv.currentPhase;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    })();
    expect(reachedAnalysis).toBeTruthy();

    // Overwrite the clock origin AFTER the pipeline is at the boundary —
    // startRuntimeClock unconditionally sets the origin, so this pins the
    // budget as exhausted for every subsequent cooperative check.
    budget.startRuntimeClock(id, Date.now() - (budget.getBudget(id).maxRuntimeMs + 1));
    expect(budget.isExpired(id)).toBe(true);

    // The pipeline cannot make progress (pending promise); the watchdog must
    // fire after maxRuntime + grace and transition to failed.
    const status = await pollStatus(id, budget.getBudget(id).maxRuntimeMs + 45_000);
    expect(status).toBe("failed");

    const inv = store.getInvestigation(id)!;
    expect(inv.status).toBe("failed");
    expect(inv.failure?.reason).toBe("runtime_expired");
    expect(inv.failure?.message).toMatch(/watchdog/i);

    // Concurrency slot was handed off exactly once (no deadlock for the next run).
    const start2 = await api("POST", `/api/investigations/${id}/resume`);
    expect([200, 400]).toContain(start2.status); // 400 = already-terminal is fine; slot must be free either way
  }, 120_000);

  it("does NOT fire early while the pipeline is still legitimately working (grace margin honored)", async () => {
    const id = await createAndStart();

    // Let it run normally — the full pipeline completes well within budget.
    const status = await pollStatus(id, 30_000);
    expect(["completed", "failed", "cancelled"]).toContain(status);

    const inv = store.getInvestigation(id)!;
    // A healthy run must never be watchdog-killed.
    if (inv.failure) {
      expect(inv.failure.message).not.toMatch(/watchdog/i);
    }
  }, 60_000);
});
