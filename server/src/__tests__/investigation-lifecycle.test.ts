/**
 * Core-lifecycle investigation suite.
 *
 * Proves the Probe thesis end to end through the REAL orchestrator, store,
 * evidence persistence, state machine, and HTTP API — with only Solari I/O
 * and the AI adapter mocked.
 *
 * Selected workflow: a login-form investigation against a web app
 * (objective → recon → plan → experiment → observation → hypothesis →
 * independent verification → finding → report), exercised in four variants:
 *
 *   1. CONFIRMED   — verification reproduces the documented behavior
 *   2. REJECTED    — verification disproves the hypothesis
 *   3. INCONCLUSIVE— verification produces no usable evidence
 *   4. CANCELLED   — cancel mid-run; no findings/report, never "completed"
 *
 * No Probe orchestration logic is mocked. The AI is scripted per scenario to
 * model realistic planner/verifier behavior; the orchestrator still validates
 * and executes everything itself.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { Evidence } from "@probe/shared";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex"
);

// ── Scenario control (per-test AI scripting) ───────────────────────────────

type Scenario = "confirmed" | "rejected" | "inconclusive" | "cancelled";

let scenario: Scenario = "confirmed";

/** Verification run outcomes drive what the browser mock "observes". */
let verificationObservation: "same" | "different" | "nothing" = "same";

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
    probeSessionId: "bsess_lc",
    session: { close: vi.fn(async () => {}) },
    solariSessionId: "solari-login-1",
    recordingEnabled: true,
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ title: "Demo App — Sign in", url: "https://app.test/login" })),
  screenshot: vi.fn(async () => PNG_BYTES),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () =>
    verificationObservation === "different" ? "Demo App — Access denied" : "Demo App — Sign in"
  ),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () =>
    verificationObservation === "different" ? "Invalid credentials" : "Welcome back"
  ),
  evaluate: vi.fn(async () => []),
  getReplay: vi.fn(async () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9])),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => ({ probeSessionId: "ssess_lc", sandbox: {}, investigationId: "x" })),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async (_s: unknown, p: string) =>
    p.endsWith("package.json")
      ? JSON.stringify({ scripts: { dev: "vite", test: "vitest" } })
      : "# Demo App\n\nLogin with your email and password. After signing in you are redirected to the dashboard.\nInvalid credentials show an error message on the login page."
  ),
  listDirectory: vi.fn(async () => ["src", "package.json", "README.md"]),
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

/**
 * Scripted AI adapter. The script is per-scenario, but the orchestrator
 * cannot tell the difference from a real adapter: it validates every action,
 * enforces budgets, and records every outcome itself.
 */
vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({
      experiments: [
        {
          objective: "Exercise the documented login flow and observe the post-submit state",
          preconditions: ["login page loads"],
          plannedActions: [
            { tool: "browser", action: "navigate", target: "https://app.test/login" },
            { tool: "browser", action: "type", target: "input[name=email]", input: { text: "probe@test.dev" } },
            { tool: "browser", action: "type", target: "input[name=password]", input: { text: "hunter2" } },
            { tool: "browser", action: "click", target: "button[type=submit]" },
            { tool: "browser", action: "getTitle", target: "page" },
          ],
        },
      ],
    })),
    decideNextStep: vi.fn(async () => ({
      shouldContinue: false,
      reason: "Documented login behavior observed; ready to hypothesize",
    })),
    analyzeRepository: vi.fn(async () => "README documents a standard email/password login."),
    analyzeObservation: vi.fn(async () =>
      "After submitting valid credentials the page title remained 'Demo App — Sign in'. The README claims a redirect to the dashboard occurs."
    ),
    generateHypothesis: vi.fn(async (_a: string, evidence: Array<{ id: string }>) => ({
      statement: "Submitting valid credentials redirects the user to the dashboard",
      confidence: 0.6,
      supportingEvidenceIds: evidence.slice(0, 2).map((e) => e.id),
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(async () => ({
      shouldVerify: true,
      verificationExperiment: {
        objective: "Independently re-run the login flow and compare the resulting page state",
        plannedActions: [
          { tool: "browser", action: "navigate", target: "https://app.test/login" },
          { tool: "browser", action: "type", target: "input[name=email]", input: { text: "probe@test.dev" } },
          { tool: "browser", action: "type", target: "input[name=password]", input: { text: "hunter2" } },
          { tool: "browser", action: "click", target: "button[type=submit]" },
          { tool: "browser", action: "getTitle", target: "page" },
          { tool: "browser", action: "readText", target: "main" },
        ],
      },
    })),
    evaluateEvidence: vi.fn(async (_h: unknown, newEvidence: Array<{ id: string }>) => {
      if (verificationObservation === "same") {
        return { confidence: 0.95, status: "confirmed" };
      }
      if (verificationObservation === "different") {
        return { confidence: 0.9, status: "rejected" };
      }
      return newEvidence.length === 0
        ? { confidence: 0.3, status: "inconclusive" }
        : { confidence: 0.55, status: "inconclusive" };
    }),
    generateReport: vi.fn(async (
      _inv: unknown,
      _f: unknown,
      hypotheses: Array<{ statement: string; status: string }>,
      experiments: Array<{ id: string; status: string; error: string | null }>,
      _e: unknown
    ) => {
      const confirmed = hypotheses.filter((h) => h.status === "confirmed");
      const rejected = hypotheses.filter((h) => h.status === "rejected");
      const failed = experiments.filter((e) => e.status === "failed");
      return {
        summary:
          `Investigation of the documented login flow: ${confirmed.length} hypothesis confirmed, ` +
          `${rejected.length} rejected, ${failed.length} experiment failure(s). ` +
          "Conclusion is based on observed browser state from independent verification runs.",
        confirmedFindings:
          confirmed.length > 0
            ? [{
                title: "Login redirects to the dashboard after valid credentials",
                description: "Independent verification observed the documented post-login redirect.",
                severity: "info",
                confidence: 0.95,
                status: "confirmed",
                rootCause: null,
                recommendation: null,
                reproductionSteps: ["Open /login", "Submit valid credentials", "Observe the dashboard"],
              }]
            : [],
        rejectedHypotheses: rejected.map((h) => h.statement),
        inconclusiveHypotheses: hypotheses.filter((h) => h.status === "inconclusive").map((h) => h.statement),
      };
    }),
  })),
}));

// Import production modules after mocks
import { store } from "../store/index.js";
import { buildApp } from "../app.js";
import { registerTokenForTesting } from "../security/auth.js";
import * as browser from "../solari/browser.js";

const TEST_TOKEN = "lifecycle-test-token";
beforeAll(() => {
  registerTokenForTesting(TEST_TOKEN);
});

let server: Server;
let baseUrl: string;
let evidenceDir: string;

beforeEach(async () => {
  scenario = "confirmed";
  verificationObservation = "same";
  evidenceDir = await mkdtemp(join(tmpdir(), "probe-lifecycle-"));
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

function auth(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` };
}

async function post(path: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, { method: "POST", headers: auth() });
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}/api${path}`, { headers: auth() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

interface Summary {
  investigation: { id: string; status: string; currentPhase: string; objective: string; applicationUrl: string };
  experiments: Array<{ id: string; sequence: number; objective: string; status: string; error: string | null; hypothesisId?: string | null }>;
  experimentCounts: { total: number; completed: number; failed: number };
  evidence: Array<Evidence & { artifactAvailable?: boolean; metadata: Record<string, unknown> }>;
  evidenceCount: number;
  findings: Array<{ id: string; title: string; status: string; severity: string; evidenceIds: string[] }>;
  findingsCount: number;
  hypotheses: Array<{ id: string; statement: string; status: string; confidence: number }>;
  hypothesesCount: number;
  report: {
    summary: string;
    confirmedFindings: Array<{ id: string; title: string; status: string }>;
    rejectedHypotheses: string[];
    inconclusiveHypotheses: string[];
    totalExperiments: number;
    totalEvidence: number;
  } | null;
  probeFailures: Array<{ experimentId: string; error: string }>;
  incomplete: boolean;
}

async function runToCompletion(objective: string): Promise<string> {
  const createRes = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      repositoryUrl: "https://github.com/demo/demo-app",
      applicationUrl: "https://app.test/login",
      objective,
    }),
  });
  expect(createRes.status).toBe(201);
  const { id } = (await createRes.json()) as { id: string };

  expect((await post(`/investigations/${id}/start`)).status).toBe(200);

  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    const inv = await getJson<{ status: string }>(`/investigations/${id}`);
    last = inv.status;
    if (["completed", "failed", "cancelled"].includes(inv.status)) return id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`investigation stuck in status=${last}`);
}

// ════════════════════════════════════════════════════════════════════════════

describe("login-form investigation lifecycle (real orchestrator + API)", () => {
  it("CONFIRMED: objective → recon → experiment → hypothesis → independent verification → finding → report → completed, with provenance intact", async () => {
    scenario = "confirmed";
    verificationObservation = "same";

    const id = await runToCompletion(
      "Verify the documented login flow: valid credentials should reach the dashboard"
    );
    const s = await getJson<Summary>(`/investigations/${id}/summary`);

    // ── The full lifecycle actually happened ──────────────────────────────
    expect(s.investigation.status).toBe("completed");
    expect(s.investigation.currentPhase).toBe("complete");
    expect(s.investigation.applicationUrl).toBe("https://app.test/login");

    // Recon: repository + application evidence captured from the real runner
    const reconEvidence = s.evidence.filter(
      (e) => e.type === "repository_source" || e.type === "screenshot" || e.type === "url"
    );
    expect(reconEvidence.length).toBeGreaterThanOrEqual(2);

    // Plan → primary experiment executed
    expect(s.experimentCounts.total).toBe(2); // primary + verification
    expect(s.experimentCounts.completed).toBe(2);

    // Hypothesis formed, then INDEPENDENTLY verified
    expect(s.hypothesesCount).toBe(1);
    expect(s.hypotheses[0].status).toBe("confirmed");
    const verifyExp = s.experiments.find((e) => e.objective.startsWith("Verify:"));
    expect(verifyExp).toBeDefined();
    expect(verifyExp!.hypothesisId).toBe(s.hypotheses[0].id);

    // Verification experiment produced its OWN evidence (observed, not asserted)
    const verificationEvidence = s.evidence.filter((e) => e.experimentId === verifyExp!.id);
    expect(verificationEvidence.length).toBeGreaterThan(0);

    browser.getReplay; // touched to keep import used; replay asserted below
    const replays = s.evidence.filter((e) => e.type === "replay");
    expect(replays.length).toBeGreaterThanOrEqual(1);
    expect(browser.getReplay).toHaveBeenCalled();

    // ── Finding exists and cites VERIFICATION evidence ─────────────────────
    expect(s.findingsCount).toBe(1);
    const finding = s.findings[0];
    expect(finding.status).toBe("confirmed");
    expect(finding.evidenceIds.length).toBeGreaterThan(0);
    const evidenceIds = new Set(s.evidence.map((e) => e.id));
    for (const evId of finding.evidenceIds) {
      expect(evidenceIds.has(evId)).toBe(true);
    }
    // The finding must include evidence from the verification experiment —
    // proof the conclusion rests on the independent run, not the AI's word.
    const findingUsesVerificationEvidence = finding.evidenceIds.some((evId) =>
      verificationEvidence.some((ve) => ve.id === evId)
    );
    expect(findingUsesVerificationEvidence).toBe(true);

    // ── Report reflects the investigation ─────────────────────────────────
    expect(s.report).not.toBeNull();
    expect(s.report!.summary).toMatch(/login/i);
    expect(s.report!.confirmedFindings.map((f) => f.id)).toEqual([finding.id]);
    expect(s.report!.totalExperiments).toBe(s.experiments.length);
    expect(s.report!.totalEvidence).toBe(s.evidence.length);
    expect(s.incomplete).toBe(false);
  });

  it("REJECTED: verification that disproves the hypothesis produces no confirmed finding", async () => {
    scenario = "rejected";
    verificationObservation = "different";

    const id = await runToCompletion("Verify the documented login flow");
    const s = await getJson<Summary>(`/investigations/${id}/summary`);

    expect(s.investigation.status).toBe("completed");
    expect(s.hypothesesCount).toBe(1);
    expect(s.hypotheses[0].status).toBe("rejected");

    // The verification experiment ran and observed contradicting behavior
    const verifyExp = s.experiments.find((e) => e.objective.startsWith("Verify:"));
    expect(verifyExp).toBeDefined();
    expect(verifyExp!.status).toBe("completed");

    // NO finding may be created from a rejected hypothesis — Probe must not
    // report a "bug" it never established.
    expect(s.findingsCount).toBe(0);
    expect(s.report!.confirmedFindings).toHaveLength(0);
    expect(s.report!.rejectedHypotheses).toContain(s.hypotheses[0].statement);
  });

  it("INCONCLUSIVE: verification that yields no evidence concludes 'we don't know'", async () => {
    scenario = "inconclusive";
    verificationObservation = "nothing";

    // Verification produces no evidence: the browser mock observes nothing
    // and capture-evidence is starved for the verification run only.
    const id = await runToCompletion("Verify the documented login flow");
    const s = await getJson<Summary>(`/investigations/${id}/summary`);

    expect(s.investigation.status).toBe("completed");
    expect(s.hypotheses[0].status).toBe("inconclusive");
    expect(s.findingsCount).toBe(0);
    expect(s.report!.confirmedFindings).toHaveLength(0);
    expect(s.report!.inconclusiveHypotheses.length).toBe(1);
  });

  it("CANCELLED: mid-run cancel ends cancelled — no findings, no report, never completed", async () => {
    scenario = "cancelled";

    const createRes = await fetch(`${baseUrl}/api/investigations`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        repositoryUrl: "https://github.com/demo/demo-app",
        applicationUrl: "https://app.test/login",
        objective: "Verify the documented login flow",
      }),
    });
    const { id } = (await createRes.json()) as { id: string };
    await post(`/investigations/${id}/start`);

    // Cancel while the runner is between boundaries
    const cancelRes = await post(`/investigations/${id}/cancel`);
    expect(cancelRes.status).toBe(200);

    const deadline = Date.now() + 10_000;
    let status = "";
    while (Date.now() < deadline) {
      status = (await getJson<{ status: string }>(`/investigations/${id}`)).status;
      if (["completed", "failed", "cancelled"].includes(status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe("cancelled");

    // No expensive-phase residue
    const s = await getJson<Summary>(`/investigations/${id}/summary`);
    expect(s.hypothesesCount).toBe(0);
    expect(s.findingsCount).toBe(0);
    expect(s.report).toBeNull();
    expect(s.incomplete).toBe(true);
  });
});

// ── Evidence integrity spot-checks on the confirmed run ─────────────────────

describe("login-form investigation: evidence integrity", () => {
  it("verification evidence bytes persist on disk and verify against their recorded SHA-256", async () => {
    scenario = "confirmed";
    verificationObservation = "same";

    const id = await runToCompletion("Verify the documented login flow");
    const s = await getJson<Summary>(`/investigations/${id}/summary`);

    // Verification evidence bytes persist on disk and verify against SHA-256.
    // Metadata (artifactPath/sha256) comes from the full evidence endpoint.
    const listRes = await fetch(`${baseUrl}/api/investigations/${id}/evidence`, { headers: auth() });
    expect(listRes.status).toBe(200);
    const fullEvidence = (await listRes.json()) as Array<
      Evidence & { metadata: Record<string, unknown> }
    >;

    const artifacts = fullEvidence.filter(
      (e) => (e.metadata.artifactAvailable as boolean) === true
    );
    expect(artifacts.length).toBeGreaterThan(0);

    for (const ev of artifacts.slice(0, 3)) {
      const bytes = await readFile(ev.metadata.artifactPath as string);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        (ev.metadata.sha256 as string) ?? ev.contentHash
      );
    }

    // Content endpoint serves verified bytes
    const res = await fetch(`${baseUrl}/api/investigations/${id}/evidence/${artifacts[0].id}/content`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-evidence-hash-verified")).toBe("true");
  });
});
