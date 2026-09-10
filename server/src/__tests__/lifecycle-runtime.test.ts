/**
 * Focused regression: investigations must reach EXECUTION within the runtime
 * budget — the failure mode under test is the historical bug where runtime
 * was double-counted (1s interval + elapsed-time top-up in the runner's
 * finally), so a run died with "Runtime budget expired" while still in
 * "Preparing experiments" (phase=experiment) with 0/N experiments executed.
 *
 * Runs the REAL orchestrator + REAL store + REAL app over HTTP, with only the
 * Solari boundaries and the AI adapter mocked (same harness pattern as
 * runner-integration.test.ts). The AI plan mirrors the real rayern scenario:
 * 4 planned experiments, none executed before the fix.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "Rayern", url: "https://app.rayern.com.ng/" })),
  screenshot: vi.fn(async () => PNG_BYTES),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => "Rayern App"),
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
  readFile: vi.fn(async (_s: unknown, p: string) =>
    p.endsWith("package.json")
      ? JSON.stringify({ scripts: { dev: "vite" } })
      : "# Rayern demo app"
  ),
  listDirectory: vi.fn(async () => ["src", "package.json", "README.md"]),
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// AI adapter mirroring the observed production shape: a plan of 4 experiments.
vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({
      experiments: [
        { objective: "Verify desktop Get Started CTA leads to signup", preconditions: [], plannedActions: [{ tool: "browser", action: "navigate", target: "https://app.rayern.com.ng/" }, { tool: "browser", action: "click", target: "a[href='#get-started']" }, { tool: "browser", action: "getTitle", target: "page" }] },
        { objective: "Verify responsive mobile navigation reaches signup", preconditions: [], plannedActions: [{ tool: "browser", action: "navigate", target: "https://app.rayern.com.ng/" }, { tool: "browser", action: "getTitle", target: "page" }] },
        { objective: "Verify direct signup route renders", preconditions: [], plannedActions: [{ tool: "browser", action: "navigate", target: "https://app.rayern.com.ng/signup" }, { tool: "browser", action: "getTitle", target: "page" }] },
        { objective: "Verify login path authenticates existing accounts", preconditions: [], plannedActions: [{ tool: "browser", action: "navigate", target: "https://app.rayern.com.ng/login" }, { tool: "browser", action: "getTitle", target: "page" }] },
      ],
    })),
    decideNextStep: vi.fn(async () => ({ shouldContinue: false, reason: "Enough coverage" })),
    analyzeRepository: vi.fn(async () => "Repo analysis"),
    analyzeObservation: vi.fn(async () => "The signup CTA rendered and navigation behaved as documented."),
    generateHypothesis: vi.fn(async () => ({ statement: "No application bug identified", confidence: 0.3, supportingEvidenceIds: [], contradictingEvidenceIds: [] })),
    designVerification: vi.fn(async () => ({ shouldVerify: false, verificationExperiment: null })),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.3, status: "inconclusive" })),
    generateReport: vi.fn(async () => ({
      summary: "All experiments completed; no confirmed application findings.",
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
    })),
  })),
  getAI: vi.fn(() => (requireMock())),
}));

function requireMock() {
  // getAI() is called inside the runner; the vi.mock factory above already
  // provides createOpenAIAdapter, and ai/index getAI() delegates to it in
  // production. For the harness we re-create the adapter per call.
  return (createOpenAIAdapterRef as () => unknown)();
}

let createOpenAIAdapterRef: () => unknown = () => ({});

import { buildApp } from "../app.js";
import { store } from "../store/index.js";
import { registerTokenForTesting } from "../security/auth.js";
import * as budget from "../orchestrator/budget.js";

let server: Server;
let baseUrl: string;
let token: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "probe-lifecycle-"));
  process.env.PROBE_STORE_DIR = dataDir;
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  registerTokenForTesting("lifecycle-test-token");
  token = "lifecycle-test-token"; // the helper returns void, not the token
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: res.json() };
}

beforeEach(() => {
  store.clearAll();
  vi.clearAllMocks();
});

describe("investigation reaches execution within the runtime budget", () => {

  it("planned experiments actually execute (runtime not exhausted in preparation)", async () => {
    const created = await api("POST", "/api/investigations", {
      objective: "can a user sign up?",
      applicationUrl: "https://app.rayern.com.ng/",
    });
    expect(created.status).toBe(201);
    const inv = (await created.json) as { id: string };
    const id = inv.id;

    const start = await api("POST", `/api/investigations/${id}/start`);
    expect(start.status).toBeLessThan(500);

    // The runner is async; wait until it reaches a terminal state.
    const deadline = Date.now() + 30_000;
    let status = "created";
    while (Date.now() < deadline) {
      const s = await api("GET", `/api/investigations/${id}/summary`);
      const body = (await s.json) as { investigation?: { status?: string }; experiments?: Array<{ status: string }> };
      status = body.investigation?.status ?? "running";
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(status).toBe("completed");

    const summary = (await (await api("GET", `/api/investigations/${id}/summary`)).json) as {
      investigation: { status: string; currentPhase: string };
      experiments: Array<{ status: string; objective: string }>;
      evidence: Array<{ type: string; provenance?: string }>;
      findings: unknown[];
    };

    // THE regression: experiments must have EXECUTED, not stuck planned/0-run.
    expect(summary.experiments.length).toBe(4);
    const executed = summary.experiments.filter((e) => e.status === "completed");
    expect(executed.length).toBeGreaterThanOrEqual(1);

    // Terminal phase must be past preparation — not stuck in experiment prep.
    expect(summary.investigation.status).toBe("completed");
    expect(summary.investigation.currentPhase).toBe("complete");

    // Evidence attribution: recon evidence has no experiment; executed
    // experiments produce their own evidence with provenance set.
    const reconEvidence = summary.evidence.filter((e) => e.provenance === "recon");
    const experimentEvidence = summary.evidence.filter((e) => e.provenance === "experiment");
    expect(reconEvidence.length).toBeGreaterThanOrEqual(1);
    expect(experimentEvidence.length).toBeGreaterThanOrEqual(1);

    // No fabricated findings from an execution-less run.
    expect(summary.findings).toEqual([]);
  }, 45_000);

  it("a pre-expired runtime budget still stops the run safely at the first boundary", async () => {
    const created = await api("POST", "/api/investigations", {
      objective: "can a user sign up?",
      applicationUrl: "https://app.rayern.com.ng/",
    });
    const inv = (await created.json) as { id: string };
    const id = inv.id;

    budget.initBudget(id);
    budget.startRuntimeClock(id, Date.now() - (budget.getBudget(id).maxRuntimeMs + 1));
    expect(budget.isExpired(id)).toBe(true);

    const start = await api("POST", `/api/investigations/${id}/start`);
    expect(start.status).toBeLessThan(500);

    const deadline = Date.now() + 15_000;
    let status = "created";
    while (Date.now() < deadline) {
      const s = await api("GET", `/api/investigations/${id}/summary`);
      const body = (await s.json) as { investigation?: { status?: string } };
      status = body.investigation?.status ?? "running";
      if (status === "failed" || status === "completed") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(status).toBe("failed");
    const summary = (await (await api("GET", `/api/investigations/${id}/summary`)).json) as {
      experiments: Array<{ status: string }>;
      findings: unknown[];
    };
    // No experiments executed, no findings fabricated.
    expect(summary.experiments.every((e) => e.status !== "completed")).toBe(true);
    expect(summary.findings).toEqual([]);
  }, 30_000);
});
