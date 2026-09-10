/** @vitest-environment node */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { store } from "../store/index.js";
import * as budget from "../orchestrator/budget.js";
import { runInvestigation } from "../orchestrator/runner.js";
import {
  VALID_TOOLS,
  VALID_ACTIONS_BY_TOOL,
  SANDBOX_READ_ONLY_COMMANDS,
  isAllowedToolAction,
  isReadOnlySandboxCommand,
} from "../orchestrator/action-allowlist.js";
import { transitionStatus } from "@probe/shared";

// The runner is exercised end-to-end with mocked Solari + AI modules so the
// cancellation/expiry/budget behavior of the real orchestrator is verified.

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn(() => {
    throw new Error("no SDK in unit tests");
  }),
  closeAllClients: vi.fn(async () => {}),
}));

vi.mock("../solari/browser.js", () => ({
  createBrowserSession: vi.fn(async () => {
    throw new Error("no browser in unit tests");
  }),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(),
  screenshot: vi.fn(),
  setViewport: vi.fn(async (s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(),
  getTitle: vi.fn(),
  click: vi.fn(),
  type: vi.fn(),
  readText: vi.fn(),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
  runCommand: vi.fn(),
  runReadOnlyCommand: vi.fn(),
}));

vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({
      experiments: [
        {
          objective: "Test experiment",
          preconditions: [],
          plannedActions: [
            { tool: "browser", action: "getTitle", target: "page" },
          ],
        },
      ],
    })),
    decideNextStep: vi.fn(async () => ({ shouldContinue: false, reason: "done" })),
    analyzeRepository: vi.fn(async () => "repo analysis"),
    analyzeObservation: vi.fn(async () => "observation analysis"),
    generateHypothesis: vi.fn(async () => ({
      statement: "hypothesis",
      confidence: 0.5,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(async () => ({
      shouldVerify: false,
      verificationExperiment: null,
    })),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.5, status: "inconclusive" })),
    generateReport: vi.fn(async () => ({
      summary: "report",
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
    })),
  })),
}));

function createTestInvestigation(): string {
  const inv = store.createInvestigation({
    repositoryUrl: "https://github.com/test/repo",
    applicationUrl: "https://example.com",
    objective: "Control-plane test",
  });
  return inv.id;
}

beforeEach(() => {
  store.clearAll();
  vi.clearAllMocks();
});

// ── Cancellation ───────────────────────────────────────────────────────────

describe("cancellation is real", () => {
  it("a cancelled investigation never transitions to completed", async () => {
    const id = createTestInvestigation();

    // Start the runner. Its synchronous prefix sets status → running, then
    // it suspends at the first awaited boundary (mocked Solari call).
    const runPromise = runInvestigation(id);

    // Cancel immediately — while the runner is suspended mid-phase.
    const inv = store.getInvestigation(id)!;
    expect(inv.status).toBe("running");
    transitionStatus(inv.status, "cancelled");
    store.updateInvestigation(id, { status: "cancelled" });

    await expect(runPromise).resolves.toBeUndefined();

    // The investigation must still be cancelled — never completed
    expect(store.getInvestigation(id)!.status).toBe("cancelled");
  });

  it("cancelling an already-terminal investigation is rejected by the state machine", () => {
    const id = createTestInvestigation();
    const inv = store.getInvestigation(id)!;
    transitionStatus(inv.status, "cancelled");
    store.updateInvestigation(id, { status: "cancelled" });

    // cancelled → cancelled is invalid; cancelled → running is invalid
    expect(() => transitionStatus("cancelled", "cancelled")).toThrow();
    expect(() => transitionStatus("cancelled", "running")).toThrow();
    expect(() => transitionStatus("cancelled", "completed")).toThrow();
  });
});

// ── Runtime budget enforcement ─────────────────────────────────────────────

describe("runtime budget is enforced", () => {
  it("an expired runtime budget stops the investigation and marks it failed", async () => {
    const id = createTestInvestigation();

    // Pre-exhaust the runtime budget (pin the clock origin past the limit).
    budget.initBudget(id);
    budget.startRuntimeClock(id, Date.now() - (budget.getBudget(id).maxRuntimeMs + 1));
    expect(budget.isExpired(id)).toBe(true);

    await runInvestigation(id);

    // Must not be "completed" — the run stopped safely at the first boundary
    const status = store.getInvestigation(id)!.status;
    expect(status).not.toBe("completed");
  });

  it("isExpired() derives from the runtime clock and never double-counts", () => {
    const id = createTestInvestigation();
    budget.initBudget(id);
    // No clock started: not expired.
    expect(budget.isExpired(id)).toBe(false);
    budget.startRuntimeClock(id);
    try {
      // A short wall-clock span well under the limit is NOT expired — even
      // though the runner used to ALSO tick a 1s interval on top.
      budget.startRuntimeClock(id, Date.now() - 1000);
      expect(budget.isExpired(id)).toBe(false);
      // Backdate past the limit: expired.
      budget.startRuntimeClock(id, Date.now() - (budget.getBudget(id).maxRuntimeMs + 1));
      expect(budget.isExpired(id)).toBe(true);
    } finally {
      budget.stopRuntimeClock(id);
    }
  });
});

// ── Budget charging per tool ───────────────────────────────────────────────

describe("budget charging follows the action tool", () => {
  it("sandbox and browser resources are separate pools with correct limits", () => {
    const id = createTestInvestigation();
    budget.initBudget(id);
    const b = budget.getBudget(id);
    expect(b.maxBrowserActions).toBe(40);
    expect(b.maxSandboxCommands).toBe(20);
    expect(b.maxAiCalls).toBe(20);
    expect(b.maxRuntimeMs).toBe(10 * 60 * 1000);
    expect(b.verificationReserve).toBe(2);
  });

  it("consuming sandboxCommands does not deplete browserActions", () => {
    const id = createTestInvestigation();
    budget.initBudget(id);
    for (let i = 0; i < 5; i++) budget.consume(id, "sandboxCommands");
    const b = budget.getBudget(id);
    expect(b.usedSandboxCommands).toBe(5);
    expect(b.usedBrowserActions).toBe(0);
  });
});

// ── Allowlist single source of truth ───────────────────────────────────────

describe("action allowlist has one source of truth", () => {
  it("exposes exactly two tools with no git tool", () => {
    expect([...VALID_TOOLS].sort()).toEqual(["browser", "sandbox"]);
    expect(VALID_TOOLS).not.toContain("git");
  });

  it("browser actions include setViewport and exclude DOM eval", () => {
    const browser = VALID_ACTIONS_BY_TOOL.browser;
    expect(browser).toContain("setViewport");
    expect(browser).not.toContain("evaluate");
  });

  it("sandbox actions exclude arbitrary command execution", () => {
    const sandbox = VALID_ACTIONS_BY_TOOL.sandbox;
    expect(sandbox).not.toContain("runCommand");
    expect(sandbox).not.toContain("runShellCommand");
  });

  it("read-only command allowlist contains no shells or network tools", () => {
    for (const cmd of SANDBOX_READ_ONLY_COMMANDS) {
      expect(["sh", "bash", "zsh", "curl", "wget", "nc", "eval", "exec"]).not.toContain(cmd);
    }
  });

  it("isAllowedToolAction rejects cross-tool and unknown actions", () => {
    expect(isAllowedToolAction("browser", "navigate")).toBe(true);
    expect(isAllowedToolAction("browser", "runCommand")).toBe(false);
    expect(isAllowedToolAction("sandbox", "readFile")).toBe(true);
    expect(isAllowedToolAction("sandbox", "navigate")).toBe(false);
    expect(isAllowedToolAction("git", "cloneRepo")).toBe(false);
    expect(isReadOnlySandboxCommand("cat")).toBe(true);
    expect(isReadOnlySandboxCommand("rm")).toBe(false);
    expect(isReadOnlySandboxCommand("sh")).toBe(false);
  });
});
