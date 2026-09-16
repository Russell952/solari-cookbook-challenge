/**
 * Planning-state semantics regression tests.
 *
 * Live bug: while an investigation was still in the PLAN phase ("Designing
 * experiments — current stage", 00:27 runtime, 3 recon evidence items), the
 * UI simultaneously displayed "No executable experiments were planned — the
 * application was not tested. This is a Probe execution limitation, not an
 * application result."
 *
 * Root cause: the client derived the terminal planning message from
 * `experimentCounts.total === 0` — but the summary legitimately has zero
 * experiments during the WHOLE planning phase. A final verdict was inferred
 * from missing data.
 *
 * The corrected contract:
 *  - the backend sets investigation.planningOutcome ONLY when planning has
 *    actually completed ("planned" or "no_executable_experiments");
 *  - the UI renders the no-experiments message ONLY for the explicit
 *    "no_executable_experiments" outcome;
 *  - empty experiments during active planning is NOT a planning result.
 *
 * These tests pin all four required cases.
 */
/** @vitest-environment node */
import { describe, it, expect } from "vitest";
import { buildProgressModel } from "../progress";
import type { InvestigationSummary } from "../api";

function makeSummary(overrides: Partial<InvestigationSummary> = {}): InvestigationSummary {
  return {
    investigation: {
      id: "inv_test",
      objective: "verify that the contact form is working",
      applicationUrl: "https://astonishing-alpaca-12a6ed.netlify.app/",
      status: "running",
      currentPhase: "plan",
      createdAt: "t",
      planningOutcome: null,
    },
    experiments: [],
    experimentCounts: { total: 0, completed: 0, failed: 0, planned: 0, running: 0, inconclusive: 0, cancelled: 0 },
    evidence: [],
    evidenceCount: 3,
    findings: [],
    findingsCount: 0,
    hypotheses: [],
    hypothesesCount: 0,
    report: null,
    budget: {
      usedExperiments: 0, usedBrowserActions: 0, usedSandboxCommands: 0, usedAiCalls: 2,
      usedVerificationExperiments: 0, maxExperiments: 7, maxBrowserActions: 40,
      maxSandboxCommands: 20, maxAiCalls: 20, verificationReserve: 2,
    },
    probeFailures: [],
    runtime: { startedAt: "t", completedAt: null, durationMs: null },
    incomplete: true,
    failure: null,
    ...overrides,
  } as unknown as InvestigationSummary;
}

describe("planning-state semantics", () => {
  it("Case 1 — planning in progress: NO no-experiments message while PLAN is active", () => {
    // Running, phase=plan, experiments empty, no failure — exactly the state
    // that used to render the final planning verdict prematurely.
    const model = buildProgressModel(makeSummary());
    expect(model.noExperimentsPlanned).toBe(false);
    expect(model.activity).not.toMatch(/no executable experiments/i);
    expect(model.activity).not.toMatch(/was not tested/i);
    // The truthful planning activity is shown instead.
    expect(model.activity).toMatch(/Designing experiments/i);
    expect(model.terminal).toBeNull();
  });

  it("Case 2 — planning COMPLETED with zero experiments: honest limitation message IS shown", () => {
    const model = buildProgressModel(
      makeSummary({
        investigation: {
          id: "inv_test",
          objective: "verify that the contact form is working",
          applicationUrl: "https://example.com/",
          status: "failed",
          currentPhase: "complete",
          createdAt: "t",
          planningOutcome: "no_executable_experiments",
        },
        failure: {
          reason: "no_executable_experiments",
          message: "Planning produced no executable experiments…",
          phase: "plan",
          at: "t",
        },
      } as unknown as Partial<InvestigationSummary>)
    );
    expect(model.noExperimentsPlanned).toBe(true);
    expect(model.activity).toMatch(/No executable experiments were produced/i);
    expect(model.activity).toMatch(/not an application result|not tested/i);
  });

  it("Case 3 — genuine execution failure still shows the honest execution-error state (no budget-stop regression)", () => {
    const model = buildProgressModel(
      makeSummary({
        investigation: {
          id: "inv_test",
          objective: "o",
          applicationUrl: "https://example.com/",
          status: "failed",
          currentPhase: "complete",
          createdAt: "t",
          planningOutcome: "planned",
        },
        experiments: [
          { id: "e1", sequence: 1, objective: "A", status: "failed", result: null, error: "boom" },
          { id: "e2", sequence: 2, objective: "B", status: "completed", result: "ok", error: null },
        ],
        experimentCounts: { total: 2, completed: 1, failed: 1, planned: 0, running: 0, inconclusive: 0, cancelled: 0 },
        failure: { reason: "error", message: "boom", phase: "execute", at: "t" },
      } as unknown as Partial<InvestigationSummary>)
    );
    expect(model.noExperimentsPlanned).toBe(false);
    expect(model.budgetExhaustionStop).toBe(false);
    expect(model.activity).toMatch(/ended with an execution error/i);
  });

  it("Case 3b — budget-expiry stop still classifies as a graceful budget stop (previous fix preserved)", () => {
    const model = buildProgressModel(
      makeSummary({
        investigation: {
          id: "inv_test",
          objective: "o",
          applicationUrl: "https://example.com/",
          status: "failed",
          currentPhase: "complete",
          createdAt: "t",
          planningOutcome: "planned",
        },
        experiments: [{ id: "e1", sequence: 1, objective: "A", status: "completed", result: "ok", error: null }],
        experimentCounts: { total: 1, completed: 1, failed: 0, planned: 0, running: 0, inconclusive: 0, cancelled: 0 },
        failure: { reason: "runtime_expired", message: "Investigation stopped: runtime budget exhausted", phase: "analyze", at: "t" },
      } as unknown as Partial<InvestigationSummary>)
    );
    expect(model.noExperimentsPlanned).toBe(false);
    expect(model.budgetExhaustionStop).toBe(true);
    expect(model.activity).not.toMatch(/execution error/i);
  });

  it("Case 4 — partial SSE/initial state: zero experiments with no completed planning outcome never renders the final verdict", () => {
    // The initial summary hydration arrives before any planning SSE event:
    // empty experiments, unknown outcome. This MUST NOT show the final
    // planning message even when the phase has already advanced (stale
    // summary), because no completed planning outcome exists yet.
    for (const phase of ["plan", "experiment", "execute", "created"] as const) {
      const model = buildProgressModel(
        makeSummary({ investigation: { ...(makeSummary().investigation as { currentPhase: string }), currentPhase: phase } } as unknown as Partial<InvestigationSummary>)
      );
      expect(model.noExperimentsPlanned).toBe(false);
      expect(model.activity).not.toMatch(/no executable experiments/i);
    }
  });

  it("legacy server responses without planningOutcome never trigger the message", () => {
    const legacy = makeSummary();
    delete (legacy.investigation as { planningOutcome?: string }).planningOutcome;
    const model = buildProgressModel(legacy);
    expect(model.noExperimentsPlanned).toBe(false);
  });
});
