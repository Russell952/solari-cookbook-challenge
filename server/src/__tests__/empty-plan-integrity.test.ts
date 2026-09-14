/**
 * Empty-plan lifecycle integrity tests.
 *
 * Live regression: for the objective "can a user sign up?" against a real
 * target, the AI planner returned `experiments: []` (its prompt tells it to
 * SKIP an experiment when no recon element fits). The plan validator
 * accepted the empty array, runExperiments iterated nothing, and the
 * pipeline marched through execute → observe → analyze → hypothesis →
 * verification → report → complete, producing a normal-looking Completed
 * investigation that had tested NOTHING (0/0 experiments, only recon
 * evidence, an honest-but-misleading "inconclusive" report).
 *
 * These tests pin the integrity gate: an empty plan is an execution
 * problem of Probe, never an application result. The investigation must
 * FAIL with a structured `no_executable_experiments` reason, must carry a
 * truthful report that says no experiment ran, and must NEVER be
 * presented as a completed investigation of the objective.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
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

vi.mock("../solari/browser.js", () => ({
  createBrowserSession: vi.fn(async () => ({
    probeSessionId: "bsess_empty",
    session: { close: vi.fn(async () => {}) },
    solariSessionId: "solari-empty-1",
    recordingEnabled: true,
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "App", url: "https://app.test/" })),
  screenshot: vi.fn(async () =>
    Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex")
  ),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => "App"),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () => "text"),
  evaluate: vi.fn(async () => []),
  getReplay: vi.fn(async () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => ({ probeSessionId: "ssess_empty", sandbox: {}, investigationId: "x" })),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async (_s: unknown, p: string) =>
    p.endsWith("package.json") ? JSON.stringify({ scripts: { dev: "vite" } }) : "# Demo App\n\nSign up flow."
  ),
  listDirectory: vi.fn(async () => ["src", "package.json"]),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

/** Scripted AI: the planner returns an EMPTY experiment list. */
let plannerExperiments: Array<{
  objective: string;
  preconditions: string[];
  plannedActions: Array<{ tool: string; action: string; target: string }>;
}> = [];

/** Tracks whether the AI report generator was ever invoked. */
let aiReportCalled = false;

vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({ experiments: plannerExperiments })),
    decideNextStep: vi.fn(async () => ({ shouldContinue: false, reason: "nothing to do" })),
    analyzeRepository: vi.fn(async () => "repo analysis"),
    analyzeObservation: vi.fn(async () => "observation analysis"),
    generateHypothesis: vi.fn(async () => ({
      statement: "would-be hypothesis",
      confidence: 0.5,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(async () => ({ shouldVerify: false, verificationExperiment: null })),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.5, status: "inconclusive" })),
    generateReport: vi.fn(async () => {
      aiReportCalled = true;
      return {
        summary: "AI-generated report that must NEVER be used for an empty plan.",
        confirmedFindings: [],
        rejectedHypotheses: [],
        inconclusiveHypotheses: [],
      };
    }),
  })),
}));

import { store } from "../store/index.js";
import { buildApp } from "../app.js";
import { registerTokenForTesting } from "../security/auth.js";
import { runInvestigation } from "../orchestrator/runner.js";

const TEST_TOKEN = "empty-plan-test-token";

let server: Server;
let baseUrl: string;
let evidenceDir: string;

beforeAll(() => {
  registerTokenForTesting(TEST_TOKEN);
});

beforeEach(async () => {
  plannerExperiments = [];
  aiReportCalled = false;
  evidenceDir = await mkdtemp(join(tmpdir(), "probe-empty-plan-"));
  process.env.PROBE_EVIDENCE_DIR = evidenceDir;
  store.clearAll();
  vi.clearAllMocks();
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.PROBE_EVIDENCE_DIR;
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await rm(evidenceDir, { recursive: true, force: true });
});

async function createInvestigation(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify({
      repositoryUrl: "",
      applicationUrl: "https://app.test/",
      objective: "Can a user successfully sign up?",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function getSummary(id: string): Promise<{
  investigation: { status: string; currentPhase: string };
  experimentCounts: { total: number };
  report: { summary: string } | null;
  hypothesesCount: number;
  findingsCount: number;
  runtime: { startedAt: string | null; completedAt: string | null; durationMs: number | null } | null;
  failure: { reason: string; message: string; phase: string | null; at: string } | null;
}> {
  const res = await fetch(`${baseUrl}/api/investigations/${id}/summary`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof getSummary>>;
}

describe("empty-plan lifecycle integrity", () => {
  it("an empty planner response FAILS the investigation — never completes", async () => {
    const id = await createInvestigation();
    await runInvestigation(id);

    const summary = await getSummary(id);
    expect(summary.investigation.status).toBe("failed");
    expect(summary.failure?.reason).toBe("no_executable_experiments");
    expect(summary.failure?.message).toContain("no executable experiments");
  }, 30000);

  it("zero experiments are persisted and the report states nothing was tested", async () => {
    const id = await createInvestigation();
    await runInvestigation(id);

    const summary = await getSummary(id);
    expect(summary.experimentCounts.total).toBe(0);
    expect(summary.report).not.toBeNull();
    expect(summary.report!.summary).toContain("without running any experiments");
    expect(summary.report!.summary).toContain("NOT tested");
  }, 30000);

  it("no hypothesis is fabricated from an empty run", async () => {
    const id = await createInvestigation();
    await runInvestigation(id);

    const summary = await getSummary(id);
    expect(summary.hypothesesCount).toBe(0);
    expect(summary.findingsCount).toBe(0);
  }, 30000);

  it("does not call the AI report generator for the forced inconclusive report", async () => {
    const id = await createInvestigation();
    await runInvestigation(id);
    expect(aiReportCalled).toBe(false);
  }, 30000);

  it("a non-empty plan still completes normally (guard does not over-trigger)", async () => {
    plannerExperiments = [
      {
        objective: "Exercise the signup form and observe the post-submit state",
        preconditions: ["signup page loads"],
        plannedActions: [
          { tool: "browser", action: "navigate", target: "https://app.test/signup" },
          { tool: "browser", action: "getTitle", target: "page" },
        ],
      },
    ];
    const id = await createInvestigation();
    await runInvestigation(id);

    const summary = await getSummary(id);
    expect(summary.investigation.status).toBe("completed");
    expect(summary.experimentCounts.total).toBe(1);
  }, 30000);

  it("a RUNNING investigation exposes null durationMs so the client timer derives from startedAt", async () => {
    // Regression: the summary sent durationMs = updatedAt − createdAt even
    // while running; the client prefers durationMs, so the live timer froze
    // at the last fetch (the 01:54 stuck runtime on the zero-experiment run).
    const id = await createInvestigation();
    const summaryBefore = await getSummary(id);
    expect(summaryBefore.runtime).not.toBeNull();
    expect(summaryBefore.runtime!.durationMs).toBeNull();
    expect(summaryBefore.runtime!.startedAt).toBeTruthy();
  }, 30000);

  it("a terminal investigation exposes durationMs from the record", async () => {
    const id = await createInvestigation();
    await runInvestigation(id);
    const summary = await getSummary(id);
    expect(summary.investigation.status).toBe("failed");
    expect(summary.runtime).not.toBeNull();
    expect(summary.runtime!.durationMs).not.toBeNull();
    expect(summary.runtime!.durationMs).toBeGreaterThanOrEqual(0);
  }, 30000);

  it("the failure record carries phase context for the UI", async () => {
    const id = await createInvestigation();
    await runInvestigation(id);
    const summary = await getSummary(id);
    expect(summary.failure).not.toBeNull();
    expect(summary.failure!.phase).toBe("plan");
    expect(summary.failure!.at).toBeTruthy();
  }, 30000);
});
