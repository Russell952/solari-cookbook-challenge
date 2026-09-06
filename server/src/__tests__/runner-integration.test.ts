/**
 * Runner-level integration coverage.
 *
 * Executes the REAL production lifecycle:
 *   real runInvestigation() → real store → real evidence persistence →
 *   real API router over HTTP (start / cancel / summary) → real summary build
 *
 * Only the external Solari boundaries (browser + sandbox I/O) and the AI
 * adapter are mocked, so every assertion below depends on actual production
 * code paths: state machine transitions, evidence hashing/persistence,
 * finding→evidence validation, report construction, and the summary endpoint.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";

// ── External boundary mocks (Solari + AI) ──────────────────────────────────

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex"
);

const mockSandboxSession = {
  probeSessionId: "ssess_test",
  sandbox: {},
  investigationId: "inv_test",
};

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
    probeSessionId: "bsess_test",
    session: { close: vi.fn(async () => {}) },
    solariSessionId: "solari-session-1",
    recordingEnabled: true,
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "Test App", url: "https://example.com/" })),
  screenshot: vi.fn(async () => PNG_BYTES),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => "Test App"),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () => "some text"),
  evaluate: vi.fn(async () => []),
  getReplay: vi.fn(async () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => mockSandboxSession),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async (_s: unknown, p: string) =>
    p.endsWith("package.json")
      ? JSON.stringify({ scripts: { test: "vitest", dev: "vite" } })
      : "# Test Repo\nA demo application used by Probe integration tests."
  ),
  listDirectory: vi.fn(async () => ["src", "client", "server", "package.json", "README.md"]),
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Realistic AI: plans browser experiments, proposes a hypothesis backed by
// evidence, asks for verification, then confirms it and reports a finding
// that references the supporting evidence.
vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({
      experiments: [
        {
          objective: "Verify the login flow renders the submit button",
          preconditions: ["app loads"],
          plannedActions: [
            { tool: "browser", action: "navigate", target: "https://example.com/login" },
            { tool: "browser", action: "getTitle", target: "page" },
          ],
        },
      ],
    })),
    decideNextStep: vi.fn(async () => ({
      shouldContinue: false,
      reason: "Enough evidence collected for the objective",
    })),
    analyzeRepository: vi.fn(async () => "Repository analysis"),
    analyzeObservation: vi.fn(async () =>
      "The login page rendered with title 'Test App'; the submit button was present and the navigation behaved as documented."
    ),
    generateHypothesis: vi.fn(async (_analysis: string, evidence: Array<{ id: string }>) => ({
      statement: "The login flow renders as documented",
      confidence: 0.7,
      supportingEvidenceIds: evidence.slice(0, 2).map((e) => e.id),
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(async () => ({
      shouldVerify: true,
      verificationExperiment: {
        objective: "Re-verify the login flow renders as documented",
        plannedActions: [
          { tool: "browser", action: "navigate", target: "https://example.com/login" },
          { tool: "browser", action: "getTitle", target: "page" },
        ],
      },
    })),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.95, status: "confirmed" })),
    generateReport: vi.fn(
      async (
        _inv: unknown,
        _findings: unknown,
        _hyps: unknown,
        _exps: unknown,
        evidence: Array<{ id: string }>
      ) => ({
        summary: "Investigation confirmed the documented login behavior with browser evidence.",
        confirmedFindings: [
          {
            title: "Login flow renders as documented",
            description: "The submit button rendered and navigation matched the README claim.",
            severity: "info",
            confidence: 0.95,
            status: "confirmed",
            rootCause: null,
            recommendation: null,
            reproductionSteps: ["Open https://example.com/login", "Observe the submit button"],
          },
        ],
        rejectedHypotheses: [],
        inconclusiveHypotheses: [],
      })
    ),
  })),
}));

// Import production modules AFTER mocks are registered
import { store } from "../store/index.js";
import { buildApp } from "../app.js";
import * as browser from "../solari/browser.js";
import * as evidenceStore from "../evidence/store.js";

// ── Harness: real HTTP server + real router ────────────────────────────────

let server: Server;
let baseUrl: string;
let evidenceDir: string;

async function startApp(): Promise<void> {
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "probe-runner-int-"));
  process.env.PROBE_EVIDENCE_DIR = evidenceDir;
  store.clearAll();
  vi.clearAllMocks();
  await startApp();
});

afterEach(async () => {
  delete process.env.PROBE_EVIDENCE_DIR;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await rm(evidenceDir, { recursive: true, force: true });
});

interface Investigation {
  id: string;
  status: string;
  currentPhase: string;
}

async function createInvestigation(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      applicationUrl: "https://example.com",
      objective: "Verify the login flow behaves as documented",
    }),
  });
  expect(res.status).toBe(201);
  const inv = (await res.json()) as Investigation;
  return inv.id;
}

async function waitForTerminal(id: string, timeoutMs = 15_000): Promise<Investigation> {
  const deadline = Date.now() + timeoutMs;
  let last: Investigation | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/investigations/${id}`);
    last = (await res.json()) as Investigation;
    if (["completed", "failed", "cancelled"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Investigation did not reach a terminal state; last=${JSON.stringify(last)}`);
}

// ── The full lifecycle ──────────────────────────────────────────────────────

describe("runInvestigation end-to-end (real runner, real API)", () => {
  it("runs recon → plan → experiment → hypothesis → verification → report → completed with consistent evidence, findings, and summary", async () => {
    const id = await createInvestigation();

    const startRes = await fetch(`${baseUrl}/api/investigations/${id}/start`, { method: "POST" });
    expect(startRes.status).toBe(200);

    const final = await waitForTerminal(id);
    expect(final.status).toBe("completed");
    expect(final.currentPhase).toBe("complete");

    // ── Real evidence was captured and persisted to disk ──────────────────
    const evidenceRes = await fetch(`${baseUrl}/api/investigations/${id}/evidence`);
    const evidence = (await evidenceRes.json()) as Array<{
      id: string;
      type: string;
      investigationId: string;
      contentHash: string | null;
      metadata: Record<string, unknown>;
    }>;
    expect(evidence.length).toBeGreaterThan(0);
    for (const ev of evidence) {
      expect(ev.investigationId).toBe(id);
    }

    // Screenshot bytes really persisted under the evidence root
    const screenshots = evidence.filter((e) => e.type === "screenshot");
    expect(screenshots.length).toBeGreaterThan(0);
    const shot = screenshots[0];
    expect(shot.metadata.artifactAvailable).toBe(true);
    const onDisk = await readFile(shot.metadata.artifactPath as string);
    expect(onDisk.equals(PNG_BYTES)).toBe(true);
    expect(shot.metadata.sha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));

    // Action traces persisted as JSON artifacts
    const traces = evidence.filter((e) => e.type === "action_trace");
    expect(traces.length).toBeGreaterThan(0);
    const traceJson = JSON.parse(await readFile(traces[0].metadata.artifactPath as string, "utf-8"));
    expect(traceJson).toHaveProperty("action");

    // Session replay persisted as evidence. The runner polls with getReplay()'s
    // documented default window (10 × 3s ≈ 30s) — Solari uploads the recording
    // asynchronously after release, so the args must not shorten it.
    const replays = evidence.filter((e) => e.type === "replay");
    expect(replays.length).toBeGreaterThan(0);
    expect(browser.getReplay).toHaveBeenCalledWith("solari-session-1");

    // ── Content endpoint serves the real artifact with verified hash ──────
    const contentRes = await fetch(`${baseUrl}/api/investigations/${id}/evidence/${shot.id}/content`);
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("x-evidence-hash-verified")).toBe("true");
    const served = Buffer.from(await contentRes.arrayBuffer());
    expect(served.equals(PNG_BYTES)).toBe(true);

    // ── Hypothesis + verification actually ran ────────────────────────────
    const hypRes = await fetch(`${baseUrl}/api/investigations/${id}/summary`);
    expect(hypRes.status).toBe(200);
    const summary = (await hypRes.json()) as {
      investigation: Investigation;
      experiments: Array<{ id: string; status: string; objective: string }>;
      experimentCounts: { total: number; completed: number };
      evidence: Array<{ id: string }>;
      findings: Array<{ id: string; title: string; evidenceIds?: string[]; status: string }>;
      hypotheses: Array<{ id: string; statement: string; status: string; confidence: number }>;
      hypothesesCount: number;
      report: {
        summary: string;
        confirmedFindings: Array<{ id: string; title: string }>;
        totalExperiments: number;
        totalEvidence: number;
      } | null;
      budget: { usedExperiments: number };
      incomplete: boolean;
    };

    expect(summary.investigation.id).toBe(id);
    expect(summary.investigation.status).toBe("completed");
    expect(summary.hypothesesCount).toBeGreaterThan(0);
    expect(summary.hypotheses[0].status).toBe("confirmed");
    expect(summary.hypotheses[0].confidence).toBeGreaterThan(0.9);

    // Verification experiment was created and completed
    const verifyExps = summary.experiments.filter((e) => e.objective.startsWith("Verify:"));
    expect(verifyExps.length).toBe(1);
    expect(verifyExps[0].status).toBe("completed");
    expect(summary.experimentCounts.completed).toBeGreaterThanOrEqual(2);

    // ── Finding → evidence integrity (real validation path) ───────────────
    expect(summary.findings.length).toBe(1);
    const finding = summary.findings[0];
    expect(finding.title).toBe("Login flow renders as documented");
    expect(finding.status).toBe("confirmed");
    const evidenceIds = new Set(evidence.map((e) => e.id));
    for (const evId of finding.evidenceIds ?? []) {
      expect(evidenceIds.has(evId)).toBe(true);
    }

    // ── Report integrity: confirmedFindings == persisted findings ─────────
    expect(summary.report).not.toBeNull();
    expect(summary.report!.confirmedFindings.map((f) => f.id)).toEqual([finding.id]);
    expect(summary.report!.totalEvidence).toBe(evidence.length);
    expect(summary.report!.totalExperiments).toBe(summary.experiments.length);

    // ── Summary consistency: counts match the store truth ─────────────────
    expect(summary.evidence.length).toBe(evidence.length);
    expect(summary.incomplete).toBe(false);
    expect(summary.budget.usedExperiments).toBeGreaterThanOrEqual(2); // primary + verification
  });

  it("cancellation during an active run ends as cancelled — never completed — and stops before expensive phases", async () => {
    const id = await createInvestigation();
    await fetch(`${baseUrl}/api/investigations/${id}/start`, { method: "POST" });

    // Cancel while the runner is active (runner set status=running synchronously
    // before its first await; this cancel lands during recon/plan).
    const cancelRes = await fetch(`${baseUrl}/api/investigations/${id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);

    const final = await waitForTerminal(id);
    expect(final.status).toBe("cancelled");

    // Give any in-flight continuation a chance to wrongly overwrite status
    await new Promise((r) => setTimeout(r, 150));
    const after = await fetch(`${baseUrl}/api/investigations/${id}`);
    const inv = (await after.json()) as Investigation;
    expect(inv.status).toBe("cancelled");

    // Cancelled runs must not proceed into hypothesis/verification/report:
    // no hypotheses, findings, or report may exist.
    const summaryRes = await fetch(`${baseUrl}/api/investigations/${id}/summary`);
    const summary = (await summaryRes.json()) as {
      hypothesesCount: number;
      findingsCount: number;
      report: unknown;
      incomplete: boolean;
    };
    expect(summary.hypothesesCount).toBe(0);
    expect(summary.findingsCount).toBe(0);
    expect(summary.report).toBeNull();
    expect(summary.incomplete).toBe(true);
  });

  it("evidence survives an in-memory wipe via the on-disk artifact index (restart-like)", async () => {
    const id = await createInvestigation();
    await fetch(`${baseUrl}/api/investigations/${id}/start`, { method: "POST" });
    await waitForTerminal(id);

    const evidence = (await (
      await fetch(`${baseUrl}/api/investigations/${id}/evidence`)
    ).json()) as Array<{ id: string; metadata: Record<string, unknown> }>;
    const shot = evidence.find((e) => (e.metadata.artifactAvailable as boolean) === true)!;

    // Wipe in-memory state, then read the artifact back purely from disk
    store.clearAll();
    const indexed = await evidenceStore.getArtifactFromIndex(id, shot.id);
    expect(indexed).not.toBeNull();
    const bytes = await readFile(indexed!.storagePath);
    expect(bytes.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(indexed!.sha256);
  });
});
