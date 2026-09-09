/** @vitest-environment node */
import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../store/index.js";
import { resolveFindingEvidenceIds } from "../orchestrator/finding-evidence.js";
import type { Evidence, Experiment, Hypothesis } from "@probe/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvidence(overrides: Partial<Evidence>): Evidence {
  return {
    id: "ev_x",
    investigationId: "inv_1",
    experimentId: "exp_1",
    observationId: null,
    type: "screenshot",
    uri: null,
    contentHash: "abc",
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Evidence;
}

function makeExperiment(overrides: Partial<Experiment>): Experiment {
  return {
    id: "exp_1",
    investigationId: "inv_1",
    sequence: 1,
    objective: "Verify the login flow shows an error for invalid credentials",
    hypothesisId: null,
    status: "completed",
    preconditions: [],
    plannedActions: [],
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Experiment;
}

function makeHypothesis(overrides: Partial<Hypothesis>): Hypothesis {
  return {
    id: "hyp_1",
    investigationId: "inv_1",
    statement: "The login form rejects invalid credentials",
    status: "confirmed",
    confidence: 0.9,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Hypothesis;
}

beforeEach(() => {
  store.clearAll();
});

// ── resolveFindingEvidenceIds ──────────────────────────────────────────────

describe("resolveFindingEvidenceIds", () => {
  const invId = "inv_1";
  const exp = makeExperiment({});
  const evidence = [
    makeEvidence({ id: "ev_exp1_a", experimentId: "exp_1" }),
    makeEvidence({ id: "ev_exp1_b", experimentId: "exp_1" }),
    makeEvidence({ id: "ev_exp2", experimentId: "exp_2" }),
    // A dangling experiment reference (the "recon" sentinel id used
    // historically): provenance cannot be established, so it must never
    // support a finding.
    makeEvidence({ id: "ev_recon", experimentId: "recon", type: "url" }),
    makeEvidence({ id: "ev_recon_null", experimentId: null, type: "url" }),
  ];

  it("keeps hypothesis-linked evidence that exists in the investigation", () => {
    const hyp = makeHypothesis({ supportingEvidenceIds: ["ev_exp1_a"] });
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: hyp,
      experiments: [exp],
      evidence,
    });
    expect(ids).toEqual(["ev_exp1_a"]);
  });

  it("drops dangling evidence IDs that do not exist in the store", () => {
    const hyp = makeHypothesis({ supportingEvidenceIds: ["ev_ghost"] });
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: hyp,
      experiments: [exp],
      evidence,
    });
    expect(ids).toEqual([]);
  });

  it("drops evidence belonging to a different investigation", () => {
    const foreign = makeEvidence({ id: "ev_foreign", investigationId: "inv_other" });
    const hyp = makeHypothesis({ supportingEvidenceIds: ["ev_foreign", "ev_exp1_a"] });
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: hyp,
      experiments: [exp],
      evidence: [...evidence, foreign],
    });
    expect(ids).toEqual(["ev_exp1_a"]);
  });

  it("falls back to experiment evidence only — never recon-only or unrelated evidence", () => {
    const ids = resolveFindingEvidenceIds({ title: "Unrelated title" }, {
      investigationId: invId,
      hypothesis: null,
      experiments: [exp],
      evidence,
    });
    // No hypothesis linkage and no text match → experiment-generated evidence
    // for the investigation, excluding the recon-only URL evidence.
    expect(ids).toContain("ev_exp1_a");
    expect(ids).toContain("ev_exp1_b");
    expect(ids).not.toContain("ev_exp2"); // references exp_2, not in this investigation's experiment set
    expect(ids).not.toContain("ev_recon"); // sentinel experimentId "recon"
    expect(ids).not.toContain("ev_recon_null"); // no experimentId = recon
  });

  it("rejects recon-only evidence cited by a hypothesis — findings require behavioral proof", () => {
    const hyp = makeHypothesis({ supportingEvidenceIds: ["ev_recon_null", "ev_recon", "ev_exp1_a"] });
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: hyp,
      experiments: [exp],
      evidence,
    });
    // Only the experiment-generated citation survives the provenance gate.
    expect(ids).toEqual(["ev_exp1_a"]);
  });

  it("rejects evidence whose experimentId does not reference a known experiment", () => {
    const hyp = makeHypothesis({ supportingEvidenceIds: ["ev_recon"] });
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: hyp,
      experiments: [exp],
      evidence,
    });
    expect(ids).toEqual([]);
  });

  it("resolves experiment evidence by explicit text cross-reference", () => {
    const exp2 = makeExperiment({ id: "exp_2", objective: "Check the signup page renders" });
    const ids = resolveFindingEvidenceIds(
      { title: "Signup page renders incorrectly", description: "observed on the signup page" },
      { investigationId: invId, hypothesis: null, experiments: [exp, exp2], evidence }
    );
    expect(ids).toContain("ev_exp2");
  });

  it("deduplicates overlapping candidate IDs", () => {
    const hyp = makeHypothesis({
      supportingEvidenceIds: ["ev_exp1_a", "ev_exp1_a"],
      contradictingEvidenceIds: ["ev_exp1_a"],
    });
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: hyp,
      experiments: [exp],
      evidence,
    });
    expect(ids.filter((id: string) => id === "ev_exp1_a")).toHaveLength(1);
  });

  it("returns empty for an investigation with no evidence rather than inventing IDs", () => {
    const ids = resolveFindingEvidenceIds({ title: "T" }, {
      investigationId: invId,
      hypothesis: null,
      experiments: [exp],
      evidence: [],
    });
    expect(ids).toEqual([]);
  });
});

// ── Report construction via the store ──────────────────────────────────────

describe("report reflects persisted findings", () => {
  it("a report created after findings contains those findings, not a stale snapshot", () => {
    const inv = store.createInvestigation({
      repositoryUrl: "https://github.com/test/repo",
      applicationUrl: "https://example.com",
      objective: "Test",
    });

    // Findings created before the report (e.g. verification flow)
    store.createFinding({
      investigationId: inv.id,
      title: "Pre-report finding",
      severity: "high",
      description: "d",
      status: "confirmed",
      confidence: 0.8,
      rootCause: null,
      reproductionSteps: [],
      recommendation: null,
      evidenceIds: [],
    });

    const preReport = store.listFindings(inv.id);

    // Findings created from the report (report phase)
    store.createFinding({
      investigationId: inv.id,
      title: "Report-created finding",
      severity: "medium",
      description: "d",
      status: "confirmed",
      confidence: 0.7,
      rootCause: null,
      reproductionSteps: [],
      recommendation: null,
      evidenceIds: [],
    });

    // Report is built by re-reading the store (the fixed behavior)
    store.createReport({
      investigationId: inv.id,
      summary: "s",
      confirmedFindings: store.listFindings(inv.id),
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
      totalExperiments: 0,
      totalEvidence: 0,
    });

    const report = store.getReport(inv.id)!;
    expect(report.confirmedFindings).toHaveLength(2);
    expect(preReport).toHaveLength(1);
    expect(report.confirmedFindings.map((f) => f.title)).toContain("Report-created finding");
  });
});
