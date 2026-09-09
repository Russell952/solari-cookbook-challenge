/**
 * Investigation progress experience tests.
 *
 * Covers the stage stepper derived from the real backend phases, truthful
 * metrics, evidence breakdown, experiment checklist, terminal states, and the
 * no-fake-progress guarantees. All data comes from a summary fixture shaped
 * exactly like the backend GET /summary response.
 */
/** @vitest-environment node */
import { describe, it, expect } from "vitest";
import {
  PROGRESS_STAGES,
  stageStates,
  buildProgressModel,
} from "../progress";
import type { InvestigationSummary, InvestigationPhase } from "../api";

function makeSummary(overrides: {
  status?: InvestigationSummary["investigation"]["status"];
  phase?: InvestigationPhase;
  experiments?: InvestigationSummary["experiments"];
  evidence?: Partial<InvestigationSummary["evidence"][number]>[];
  hypotheses?: InvestigationSummary["hypotheses"];
  findingsCount?: number;
  runtime?: InvestigationSummary["runtime"];
  report?: InvestigationSummary["report"];
}): InvestigationSummary {
  const phase = overrides.phase ?? "execute";
  const status = overrides.status ?? "running";
  return {
    investigation: {
      id: "inv_1",
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "Verify the login flow",
      status,
      currentPhase: phase,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:01:00.000Z",
    },
    experiments: overrides.experiments ?? [],
    experimentCounts: {
      total: (overrides.experiments ?? []).length,
      completed: (overrides.experiments ?? []).filter((e) => e.status === "completed").length,
      failed: (overrides.experiments ?? []).filter((e) => e.status === "failed").length,
      planned: (overrides.experiments ?? []).filter((e) => e.status === "planned").length,
      running: (overrides.experiments ?? []).filter((e) => e.status === "running").length,
      inconclusive: (overrides.experiments ?? []).filter((e) => e.status === "inconclusive").length,
      cancelled: 0,
    },
    evidence: (overrides.evidence ?? []).map((e, i) => ({
      id: `ev_${i}`,
      investigationId: "inv_1",
      experimentId: null,
      observationId: null,
      type: "screenshot",
      uri: null,
      contentHash: null,
      metadata: {},
      createdAt: "2026-09-06T00:00:10.000Z",
      ...e,
    })),
    evidenceCount: (overrides.evidence ?? []).length,
    findings: [],
    findingsCount: overrides.findingsCount ?? 0,
    hypotheses: overrides.hypotheses ?? [],
    hypothesesCount: (overrides.hypotheses ?? []).length,
    report: overrides.report ?? null,
    budget: {
      usedExperiments: 0, usedBrowserActions: 0, usedSandboxCommands: 0, usedAiCalls: 0,
      usedVerificationExperiments: 0, maxExperiments: 7, maxBrowserActions: 40,
      maxSandboxCommands: 20, maxAiCalls: 20, verificationReserve: 2,
    },
    probeFailures: [],
    runtime: overrides.runtime ?? { startedAt: null, completedAt: null, durationMs: null },
    incomplete: status === "running",
  };
}

const sixExperiments: InvestigationSummary["experiments"] = [
  { id: "e1", sequence: 1, objective: "Homepage navigation", status: "completed", result: "ok", error: null },
  { id: "e2", sequence: 2, objective: "Project links", status: "completed", result: "ok", error: null },
  { id: "e3", sequence: 3, objective: "Contact form behavior", status: "running", result: null, error: null },
  { id: "e4", sequence: 4, objective: "Certificate access", status: "planned", result: null, error: null },
  { id: "e5", sequence: 5, objective: "Resume download", status: "planned", result: null, error: null },
  { id: "e6", sequence: 6, objective: "Mobile navigation", status: "planned", result: null, error: null },
];

describe("progress stages: phase mapping", () => {
  it("maps RECON to the understanding-the-target stage", () => {
    const model = buildProgressModel(makeSummary({ phase: "recon" }));
    const stage = model.stages.find((s) => s.phase === "recon");
    expect(stage?.label).toBe("Understanding the target");
    expect(stage?.state).toBe("current");
    expect(model.stageLabel).toBe("Understanding the target");
  });

  it("maps EXECUTE to the running-experiments stage", () => {
    const model = buildProgressModel(makeSummary({ phase: "execute" }));
    expect(model.stageLabel).toBe("Running experiments");
    const stage = model.stages.find((s) => s.phase === "execute");
    expect(stage?.state).toBe("current");
  });

  it("maps ANALYZE to the analysis stage", () => {
    const model = buildProgressModel(makeSummary({ phase: "analyze" }));
    expect(model.stageLabel).toBe("Evaluating observations");
  });

  it("maps VERIFICATION to the verification stage", () => {
    const model = buildProgressModel(makeSummary({ phase: "verification" }));
    expect(model.stageLabel).toBe("Verifying results");
  });

  it("maps REPORT to the report-preparation stage", () => {
    const model = buildProgressModel(makeSummary({ phase: "report" }));
    expect(model.stageLabel).toBe("Preparing report");
  });

  it("marks earlier stages completed and later stages pending while running", () => {
    const states = stageStates("running", "analyze");
    const labels = Object.fromEntries(states.map((s) => [s.phase, s.state]));
    expect(labels.recon).toBe("completed");
    expect(labels.plan).toBe("completed");
    expect(labels.analyze).toBe("current");
    expect(labels.hypothesis).toBe("pending");
    expect(labels.complete).toBe("pending");
  });

  it("uses presentation labels only — no raw internal state names", () => {
    for (const stage of PROGRESS_STAGES) {
      expect(stage.label).not.toBe(stage.phase);
      expect(stage.label.toLowerCase()).not.toContain("recon");
      expect(stage.label.toLowerCase()).not.toMatch(/\bplan\b/);
    }
  });
});

describe("progress metrics: real data only", () => {
  it("displays real experiment/evidence/hypothesis/finding counts", () => {
    const model = buildProgressModel(
      makeSummary({
        phase: "observe",
        experiments: sixExperiments,
        evidence: [
          { type: "screenshot" }, { type: "screenshot" },
          { type: "action_trace" }, { type: "replay" },
        ],
        hypotheses: [
          { id: "h1", statement: "s", status: "confirmed", confidence: 0.9, createdAt: "t" },
        ],
        findingsCount: 2,
      })
    );
    const byLabel = Object.fromEntries(model.metrics.map((m) => [m.label, m.value]));
    expect(byLabel.Experiments).toBe("2/6");
    expect(byLabel.Evidence).toBe("4");
    expect(byLabel.Hypotheses).toBe("1");
    expect(byLabel.Findings).toBe("2");
  });

  it("generates no fake percentage anywhere in the model", () => {
    const model = buildProgressModel(
      makeSummary({ phase: "execute", experiments: sixExperiments })
    );
    const serialized = JSON.stringify(model);
    expect(serialized).not.toMatch(/"\s*\d+\s*%/);
    expect(serialized).not.toMatch(/percent/i);
    expect(serialized).not.toMatch(/"progress":/);
  });

  it("formats runtime from real durationMs", () => {
    const model = buildProgressModel(
      makeSummary({ phase: "execute", runtime: { startedAt: "t", completedAt: null, durationMs: 161000 } })
    );
    expect(model.runtime).toBe("02:41");
    const runtimeMetric = model.metrics.find((m) => m.label === "Runtime");
    expect(runtimeMetric?.value).toBe("02:41");
  });

  it("derives running-time from the real startedAt when durationMs is absent", () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const model = buildProgressModel(
      makeSummary({ phase: "execute", runtime: { startedAt, completedAt: null, durationMs: null } })
    );
    expect(model.runtime).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("experiment-level progress", () => {
  it("shows the running experiment with its real position and objective", () => {
    const model = buildProgressModel(
      makeSummary({ phase: "execute", experiments: sixExperiments })
    );
    expect(model.hasCurrentExperiment).toBe(true);
    expect(model.currentExperimentObjective).toBe("Contact form behavior");
    expect(model.currentExperimentPosition).toBe("3 of 6");
  });

  it("falls back to the next planned experiment during the experiment phase", () => {
    const model = buildProgressModel(
      makeSummary({
        phase: "experiment",
        experiments: sixExperiments.map((e) =>
          e.id === "e3" ? { ...e, status: "planned" as const } : e
        ),
      })
    );
    expect(model.currentExperimentObjective).toBe("Contact form behavior");
  });

  it("renders the honest experiment checklist states", () => {
    const model = buildProgressModel(
      makeSummary({ phase: "execute", experiments: sixExperiments })
    );
    const states = model.experimentList.map((e) => e.state);
    expect(states).toEqual(["completed", "completed", "running", "pending", "pending", "pending"]);
  });
});

describe("evidence activity", () => {
  it("breaks evidence down by the types that actually exist", () => {
    const model = buildProgressModel(
      makeSummary({
        phase: "observe",
        evidence: [
          { type: "screenshot" }, { type: "screenshot" }, { type: "screenshot" },
          { type: "action_trace" }, { type: "action_trace" },
          { type: "replay" },
        ],
      })
    );
    expect(model.evidenceBreakdown).toEqual([
      { type: "screenshot", count: 3 },
      { type: "action_trace", count: 2 },
      { type: "replay", count: 1 },
    ]);
  });

  it("omits the evidence panel entirely when no evidence exists", () => {
    const model = buildProgressModel(makeSummary({ phase: "execute" }));
    expect(model.evidenceBreakdown).toEqual([]);
  });
});

describe("terminal states", () => {
  it("completed investigations show the completed stage, not a loading state", () => {
    const model = buildProgressModel(
      makeSummary({
        status: "completed",
        phase: "complete",
        experiments: sixExperiments.map((e) => ({ ...e, status: "completed" as const })),
        report: {
          id: "rpt", summary: "s", confirmedFindings: [], rejectedHypotheses: [],
          inconclusiveHypotheses: [], totalExperiments: 6, totalEvidence: 0,
          createdAt: "t",
        },
      })
    );
    expect(model.terminal).toBe("completed");
    expect(model.isRunning).toBe(false);
    expect(model.stages.every((s) => s.state === "completed")).toBe(true);
    expect(model.stageLabel).toBe("Investigation complete");
  });

  it("failed investigations mark the failure point and never present success", () => {
    const states = stageStates("failed", "execute");
    const labels = Object.fromEntries(states.map((s) => [s.phase, s.state]));
    expect(labels.recon).toBe("completed");
    expect(labels.plan).toBe("completed");
    expect(labels.execute).toBe("failed");
    expect(labels.observe).toBe("pending");
    expect(labels.complete).toBe("pending");
    const model = buildProgressModel(makeSummary({ status: "failed", phase: "execute" }));
    expect(model.terminal).toBe("failed");
    expect(model.activity).toMatch(/execution error/i);
  });

  it("cancelled investigations are visually distinct from completed ones", () => {
    const states = stageStates("cancelled", "observe");
    const labels = Object.fromEntries(states.map((s) => [s.phase, s.state]));
    expect(labels.recon).toBe("completed");
    expect(labels.observe).toBe("cancelled");
    expect(labels.analyze).toBe("pending");
    const model = buildProgressModel(makeSummary({ status: "cancelled", phase: "observe" }));
    expect(model.terminal).toBe("cancelled");
    expect(model.activity).toMatch(/cancelled/i);
  });

  it("failed/cancelled investigations never show a report context", () => {
    const failed = buildProgressModel(makeSummary({ status: "failed", phase: "report" }));
    const cancelled = buildProgressModel(makeSummary({ status: "cancelled", phase: "report" }));
    expect(failed.reportContext).toEqual([]);
    expect(cancelled.reportContext).toEqual([]);
  });
});

describe("hypothesis outcomes: honest semantics", () => {
  it("treats inconclusive hypotheses as legitimate results, not failures", () => {
    const model = buildProgressModel(
      makeSummary({
        status: "completed",
        phase: "complete",
        hypotheses: [
          { id: "h1", statement: "s1", status: "confirmed", confidence: 0.9, createdAt: "t" },
          { id: "h2", statement: "s2", status: "rejected", confidence: 0.4, createdAt: "t" },
          { id: "h3", statement: "s3", status: "inconclusive", confidence: 0.5, createdAt: "t" },
        ],
      })
    );
    expect(model.hypothesisOutcomes).toEqual({
      confirmed: 1, rejected: 1, inconclusive: 1, other: 0,
    });
    expect(model.activity).not.toMatch(/fail/i);
  });

  it("report context distinguishes confirmed, rejected, and inconclusive", () => {
    const model = buildProgressModel(
      makeSummary({
        phase: "report",
        evidence: [{ type: "screenshot" }],
        hypotheses: [
          { id: "h1", statement: "s1", status: "confirmed", confidence: 0.9, createdAt: "t" },
          { id: "h2", statement: "s2", status: "inconclusive", confidence: 0.5, createdAt: "t" },
        ],
      })
    );
    expect(model.reportContext).toContain("Experiments complete");
    expect(model.reportContext).toContain("Evidence collected");
    expect(model.reportContext).toContain("Hypotheses confirmed");
    expect(model.reportContext).toContain("Hypotheses inconclusive");
    expect(model.reportContext).not.toContain("Hypotheses rejected");
  });

  it("makes no unverified claims in report context", () => {
    const model = buildProgressModel(makeSummary({ phase: "report" }));
    expect(model.reportContext).toEqual(["Experiments complete"]);
  });
});
