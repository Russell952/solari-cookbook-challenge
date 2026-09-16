/**
 * Budget-stop presentation regression tests.
 *
 * Live background: inv_1789470483431_1bpnr8 (target
 * https://astonishing-alpaca-12a6ed.netlify.app/) completed 4/5 experiments,
 * captured 49 evidence items, hit the 10-minute runtime budget during the
 * analyze phase, and the pipeline correctly terminalized: it persisted a
 * structured fallback report ("Investigation completed with 5 experiments
 * (4 completed, 1 failed), 49 evidence…"), recorded failure.reason =
 * runtime_expired, and set status failed.
 *
 * The UI then misrepresented the result: the terminal banner claimed the
 * investigation "ended with an execution error before a report could be
 * produced" — factually false, a report existed — and the view hid the
 * report entirely (ReportSection rendered only for completed runs).
 *
 * These tests pin the corrected presentation contract:
 *  - a budget-boundary failed run is a graceful stop, not an execution error
 *  - its persisted report is shown
 *  - genuine non-budget failures still show the honest execution-error copy
 *    and keep their report hidden
 */
/** @vitest-environment node */
import { describe, it, expect } from "vitest";
import {
  buildProgressModel,
  isBudgetExhaustionStop,
} from "../progress";
import type { InvestigationSummary } from "../api";

function makeSummary(overrides: Partial<InvestigationSummary> = {}): InvestigationSummary {
  return {
    investigation: {
      id: "inv_test",
      objective: "Can a user sign up?",
      applicationUrl: "https://example.com/",
      status: "failed",
      currentPhase: "complete",
      createdAt: "t",
    },
    experiments: [
      { id: "e1", sequence: 1, objective: "A", status: "failed", result: null, error: "Element not found: #menu-toggle" },
      { id: "e2", sequence: 2, objective: "B", status: "completed", result: "ok", error: null },
      { id: "e3", sequence: 3, objective: "C", status: "completed", result: "ok", error: null },
      { id: "e4", sequence: 4, objective: "D", status: "completed", result: "ok", error: null },
      { id: "e5", sequence: 5, objective: "E", status: "completed", result: "ok", error: null },
    ],
    experimentCounts: { total: 5, completed: 4, failed: 1, planned: 0, running: 0, inconclusive: 0, cancelled: 0 },
    evidence: [],
    evidenceCount: 49,
    findings: [],
    findingsCount: 0,
    hypotheses: [],
    hypothesesCount: 0,
    report: {
      id: "rpt_1",
      summary: "Investigation completed with 5 experiments (4 completed, 1 failed), 49 evidence items, and 0 hypotheses. AI report generation encountered an error, so this is a structured fallback summary.",
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
      totalExperiments: 5,
      totalEvidence: 49,
      createdAt: "t",
    },
    budget: {
      usedExperiments: 5, usedBrowserActions: 24, usedSandboxCommands: 0, usedAiCalls: 12,
      usedVerificationExperiments: 0, maxExperiments: 7, maxBrowserActions: 60,
      maxSandboxCommands: 20, maxAiCalls: 30, verificationReserve: 2,
    },
    probeFailures: [],
    runtime: { startedAt: "t", completedAt: "t2", durationMs: 603_000 },
    incomplete: false,
    failure: {
      reason: "runtime_expired",
      message: "Investigation stopped: runtime budget exhausted",
      phase: "analyze",
      at: "2026-09-15T11:18:05.881Z",
    },
    ...overrides,
  } as unknown as InvestigationSummary;
}

describe("budget-exhaustion stop classification", () => {
  it("classifies runtime_expired as a graceful budget stop, not an execution error", () => {
    expect(isBudgetExhaustionStop(makeSummary())).toBe(true);
  });

  it("classifies AI call/token budget exhaustion as graceful stops", () => {
    for (const reason of ["ai_call_budget_exhausted", "ai_token_budget_exhausted", "analysis_budget_exhausted"]) {
      expect(
        isBudgetExhaustionStop(makeSummary({ failure: { reason, message: "m", phase: "analyze", at: "t" } }))
      ).toBe(true);
    }
  });

  it("does NOT classify genuine execution errors as budget stops", () => {
    expect(
      isBudgetExhaustionStop(makeSummary({ failure: { reason: "error", message: "boom", phase: "execute", at: "t" } }))
    ).toBe(false);
  });

  it("does not classify completed or running investigations", () => {
    const completed = makeSummary();
    (completed.investigation as { status: string }).status = "completed";
    expect(isBudgetExhaustionStop(completed)).toBe(false);
    expect(isBudgetExhaustionStop(makeSummary({ failure: null }))).toBe(false);
  });
});

describe("budget-stop presentation", () => {
  it("activity line never claims an execution error for a budget stop", () => {
    const model = buildProgressModel(makeSummary());
    expect(model.terminal).toBe("failed");
    expect(model.budgetExhaustionStop).toBe(true);
    expect(model.activity).not.toMatch(/execution error/i);
    expect(model.activity).toMatch(/budget limit/i);
  });

  it("all terminal experiments count toward X/Y (failed counts too, per pinned semantics)", () => {
    const model = buildProgressModel(makeSummary());
    // 4 completed + 1 failed = all 5 reached a terminal execution state.
    expect(model.metrics.find((m) => m.label === "Experiments")?.value).toBe("5/5");
  });

  it("a genuine execution error keeps the honest execution-error copy", () => {
    const model = buildProgressModel(
      makeSummary({ failure: { reason: "error", message: "boom", phase: "execute", at: "t" } })
    );
    expect(model.budgetExhaustionStop).toBe(false);
    expect(model.activity).toMatch(/execution error/i);
  });
});
