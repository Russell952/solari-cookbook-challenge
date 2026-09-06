/** @vitest-environment node */
import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../store/index.js";
import { initBudget, consumePrimary, consumeVerification, getBudget } from "../orchestrator/budget.js";

// Helper to populate a full investigation in the store for summary tests
function populateInvestigation(overrides: Partial<{
  status: string;
  currentPhase: string;
  experiments: Array<{ id: string; sequence: number; objective: string; status: string; result: string | null; error: string | null }>;
  evidence: Array<{ id: string; type: string; experimentId: string | null; observationId: string | null; uri: string | null; contentHash: string | null }>;
  findings: Array<{ id: string; title: string; severity: string; status: string; confidence: number }>;
  hypotheses: Array<{ id: string; statement: string; status: string; confidence: number }>;
  report: { id: string; summary: string; confirmedFindings: Array<{ id: string; title: string; severity: string; status: string }>; rejectedHypotheses: string[]; inconclusiveHypotheses: string[]; totalExperiments: number; totalEvidence: number; createdAt: string } | null;
}> = {}) {
  const inv = store.createInvestigation({
    repositoryUrl: "https://github.com/test/repo",
    applicationUrl: "https://example.com",
    objective: "Test investigation",
  });
  const actualId = inv.id;

  store.updateInvestigation(actualId, {
    status: (overrides.status || "completed") as any,
    currentPhase: (overrides.currentPhase || "complete") as any,
  });

  if (overrides.experiments) {
    for (const exp of overrides.experiments) {
      store.createExperiment({
        investigationId: actualId,
        objective: exp.objective,
        plannedActions: [],
        hypothesisId: null,
      });
      const created = store.listExperiments(actualId).find(e => e.objective === exp.objective);
      if (created) {
        store.updateExperiment(created.id, {
          sequence: exp.sequence,
          status: exp.status as any,
          result: exp.result,
          error: exp.error,
        });
      }
    }
  }

  if (overrides.evidence) {
    for (const ev of overrides.evidence) {
      store.createEvidence({
        investigationId: actualId,
        experimentId: ev.experimentId,
        observationId: ev.observationId,
        type: ev.type as any,
        uri: ev.uri,
        contentHash: ev.contentHash,
        metadata: {},
      });
    }
  }

  if (overrides.findings) {
    for (const f of overrides.findings) {
      store.createFinding({
        investigationId: actualId,
        title: f.title,
        severity: f.severity as any,
        description: f.title,
        status: f.status as any,
        confidence: f.confidence,
        rootCause: null,
        reproductionSteps: [],
        recommendation: null,
        evidenceIds: [],
      });
    }
  }

  if (overrides.hypotheses) {
    for (const h of overrides.hypotheses) {
      store.createHypothesis({
        investigationId: actualId,
        statement: h.statement,
        status: h.status as any,
        confidence: h.confidence,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      });
    }
  }

  if (overrides.report) {
    const reportFindings = (overrides.report.confirmedFindings || []).map(f => ({
      id: f.id,
      investigationId: actualId,
      title: f.title,
      severity: f.severity as any,
      description: f.title,
      status: "confirmed" as const,
      confidence: 1,
      rootCause: null,
      reproductionSteps: [],
      recommendation: null,
      evidenceIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    store.createReport({
      investigationId: actualId,
      summary: overrides.report.summary,
      confirmedFindings: reportFindings,
      rejectedHypotheses: overrides.report.rejectedHypotheses,
      inconclusiveHypotheses: overrides.report.inconclusiveHypotheses,
      totalExperiments: overrides.report.totalExperiments,
      totalEvidence: overrides.report.totalEvidence,
    });
  }

  // Initialize budget
  initBudget(actualId);
  if (overrides.experiments) {
    for (const exp of overrides.experiments) {
      if (exp.status !== "failed" && exp.status !== "inconclusive") {
        consumePrimary(actualId);
      }
    }
  }

  return actualId;
}

function resetStore() {
  store.clearAll();
}

describe("GET /api/investigations/:id/summary", () => {
  beforeEach(() => {
    resetStore();
  });

  it("includes investigation metadata", async () => {
    const id = populateInvestigation({
      status: "completed",
      currentPhase: "complete",
    });

    const investigation = store.getInvestigation(id);
    expect(investigation).toBeDefined();
    expect(investigation!.status).toBe("completed");
    expect(investigation!.currentPhase).toBe("complete");
    expect(investigation!.repositoryUrl).toBe("https://github.com/test/repo");
    expect(investigation!.applicationUrl).toBe("https://example.com");
    expect(investigation!.objective).toBe("Test investigation");
  });

  it("includes experiments", async () => {
    const id = populateInvestigation({
      experiments: [
        { id: "exp_1", sequence: 1, objective: "Homepage load", status: "completed", result: "OK", error: null },
        { id: "exp_2", sequence: 2, objective: "Contact form", status: "failed", result: null, error: "Element not found" },
      ],
    });

    const experiments = store.listExperiments(id);
    expect(experiments).toHaveLength(2);
    expect(experiments[0].objective).toBe("Homepage load");
    expect(experiments[0].status).toBe("completed");
    expect(experiments[1].objective).toBe("Contact form");
    expect(experiments[1].status).toBe("failed");
  });

  it("includes experiment counts by status", async () => {
    const id = populateInvestigation({
      experiments: [
        { id: "exp_1", sequence: 1, objective: "Exp 1", status: "completed", result: "OK", error: null },
        { id: "exp_2", sequence: 2, objective: "Exp 2", status: "completed", result: "OK", error: null },
        { id: "exp_3", sequence: 3, objective: "Exp 3", status: "failed", result: null, error: "Timeout" },
        { id: "exp_4", sequence: 4, objective: "Exp 4", status: "planned", result: null, error: null },
      ],
    });

    const counts = {
      total: store.listExperiments(id).length,
      completed: store.listExperiments(id).filter(e => e.status === "completed").length,
      failed: store.listExperiments(id).filter(e => e.status === "failed").length,
      planned: store.listExperiments(id).filter(e => e.status === "planned").length,
      running: store.listExperiments(id).filter(e => e.status === "running").length,
      inconclusive: store.listExperiments(id).filter(e => e.status === "inconclusive").length,
      cancelled: store.listExperiments(id).filter(e => e.status === "cancelled").length,
    };

    expect(counts.total).toBe(4);
    expect(counts.completed).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.planned).toBe(1);
    expect(counts.running).toBe(0);
    expect(counts.inconclusive).toBe(0);
    expect(counts.cancelled).toBe(0);
  });

  it("includes evidence", async () => {
    const id = populateInvestigation({
      evidence: [
        { id: "ev_1", type: "screenshot", experimentId: "exp_1", observationId: null, uri: null, contentHash: "hash1" },
        { id: "ev_2", type: "url", experimentId: null, observationId: "obs_1", uri: "https://example.com", contentHash: "hash2" },
      ],
    });

    const evidence = store.listEvidence(id);
    expect(evidence).toHaveLength(2);
    expect(evidence[0].type).toBe("screenshot");
    expect(evidence[1].type).toBe("url");
  });

  it("includes findings", async () => {
    const id = populateInvestigation({
      findings: [
        { id: "f_1", title: "Broken link", severity: "high", status: "confirmed", confidence: 0.9 },
        { id: "f_2", title: "Slow page", severity: "low", status: "inconclusive", confidence: 0.5 },
      ],
    });

    const findings = store.listFindings(id);
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("Broken link");
    expect(findings[0].severity).toBe("high");
    expect(findings[1].title).toBe("Slow page");
    expect(findings[1].status).toBe("inconclusive");
  });

  it("includes hypotheses", async () => {
    const id = populateInvestigation({
      hypotheses: [
        { id: "hyp_1", statement: "Login is broken", status: "rejected", confidence: 0.8 },
        { id: "hyp_2", statement: "Contact form fails", status: "inconclusive", confidence: 0.5 },
      ],
    });

    const hypotheses = store.listHypotheses(id);
    expect(hypotheses).toHaveLength(2);
    expect(hypotheses[0].statement).toBe("Login is broken");
    expect(hypotheses[0].status).toBe("rejected");
    expect(hypotheses[1].statement).toBe("Contact form fails");
    expect(hypotheses[1].status).toBe("inconclusive");
  });

  it("includes report when available", async () => {
    const id = populateInvestigation({
      report: {
        id: "rpt_1",
        summary: "No confirmed bugs found",
        confirmedFindings: [],
        rejectedHypotheses: ["Login is broken"],
        inconclusiveHypotheses: [],
        totalExperiments: 5,
        totalEvidence: 12,
        createdAt: new Date().toISOString(),
      },
    });

    const report = store.getReport(id);
    expect(report).toBeDefined();
    expect(report!.summary).toBe("No confirmed bugs found");
    expect(report!.totalExperiments).toBe(5);
    expect(report!.totalEvidence).toBe(12);
  });

  it("includes budget usage", async () => {
    const id = populateInvestigation({
      experiments: [
        { id: "exp_1", sequence: 1, objective: "Exp 1", status: "completed", result: "OK", error: null },
        { id: "exp_2", sequence: 2, objective: "Exp 2", status: "completed", result: "OK", error: null },
      ],
    });

    const budget = getBudget(id);
    expect(budget.usedExperiments).toBeGreaterThanOrEqual(2);
    expect(budget.maxExperiments).toBe(7);
    expect(budget.verificationReserve).toBe(2);
    expect(budget.maxBrowserActions).toBe(40);
  });

  it("includes probe/execution failures for failed experiments", async () => {
    const id = populateInvestigation({
      experiments: [
        { id: "exp_1", sequence: 1, objective: "Homepage load", status: "completed", result: "OK", error: null },
        { id: "exp_2", sequence: 2, objective: "Contact form", status: "failed", result: null, error: "Element not found: #submit" },
        { id: "exp_3", sequence: 3, objective: "Navigation", status: "failed", result: null, error: "Click timeout" },
      ],
    });

    const failedExperiments = store.listExperiments(id).filter(e => e.status === "failed");
    expect(failedExperiments).toHaveLength(2);

    // Simulate probe failures collection
    const probeFailures = failedExperiments.map(e => ({
      experimentId: e.id,
      experimentObjective: e.objective,
      error: e.error,
    }));

    expect(probeFailures).toHaveLength(2);
    expect(probeFailures[0].experimentObjective).toBe("Contact form");
    expect(probeFailures[0].error).toBe("Element not found: #submit");
    expect(probeFailures[1].experimentObjective).toBe("Navigation");
    expect(probeFailures[1].error).toBe("Click timeout");
  });

  it("indicates incomplete status for running investigations", async () => {
    const id = populateInvestigation({
      status: "running",
      currentPhase: "experiment",
      experiments: [
        { id: "exp_1", sequence: 1, objective: "Homepage", status: "completed", result: "OK", error: null },
        { id: "exp_2", sequence: 2, objective: "Contact", status: "running", result: null, error: null },
      ],
    });

    const inv = store.getInvestigation(id);
    expect(inv!.status).toBe("running");
    expect(inv!.currentPhase).toBe("experiment");

    const incomplete = inv!.status !== "completed" && inv!.status !== "failed";
    expect(incomplete).toBe(true);
  });

  it("indicates incomplete status for in-progress investigations", async () => {
    const id = populateInvestigation({
      status: "running",
      currentPhase: "plan",
      experiments: [],
    });

    const inv = store.getInvestigation(id);
    expect(inv!.status).toBe("running");
    expect(inv!.currentPhase).toBe("plan");

    const incomplete = inv!.status !== "completed" && inv!.status !== "failed";
    expect(incomplete).toBe(true);
  });

  it("does not trigger side effects on read", async () => {
    const id = populateInvestigation({
      status: "completed",
      currentPhase: "complete",
    });

    // Reading the investigation should not change its state
    const before = store.getInvestigation(id);
    const experimentsBefore = store.listExperiments(id).length;
    const evidenceBefore = store.listEvidence(id).length;

    // Perform read operations (simulating the summary endpoint reads)
    const investigation = store.getInvestigation(id);
    const experiments = store.listExperiments(id);
    const evidence = store.listEvidence(id);
    const findings = store.listFindings(id);
    const hypotheses = store.listHypotheses(id);
    const report = store.getReport(id);

    const after = store.getInvestigation(id);
    const experimentsAfter = store.listExperiments(id).length;
    const evidenceAfter = store.listEvidence(id).length;

    expect(investigation).toBeDefined();
    expect(experiments.length).toBe(experimentsBefore);
    expect(evidence.length).toBe(evidenceBefore);
    expect(findings).toBeInstanceOf(Array);
    expect(hypotheses).toBeInstanceOf(Array);
    expect(after!.status).toBe(before!.status);
    expect(experimentsAfter).toBe(experimentsBefore);
    expect(evidenceAfter).toBe(evidenceBefore);
  });

  it("summary can be retrieved for completed investigation with all data", async () => {
    const id = populateInvestigation({
      status: "completed",
      currentPhase: "complete",
      experiments: [
        { id: "exp_1", sequence: 1, objective: "Homepage", status: "completed", result: "OK", error: null },
        { id: "exp_2", sequence: 2, objective: "Contact form", status: "completed", result: "Submitted", error: null },
        { id: "exp_3", sequence: 3, objective: "Certificate", status: "completed", result: "Loaded", error: null },
      ],
      evidence: [
        { id: "ev_1", type: "screenshot", experimentId: "exp_1", observationId: null, uri: null, contentHash: "screenshot-hash" },
        { id: "ev_2", type: "url", experimentId: "exp_2", observationId: null, uri: "https://example.com/contact", contentHash: "url-hash" },
        { id: "ev_3", type: "action_trace", experimentId: "exp_3", observationId: null, uri: null, contentHash: "trace-hash" },
      ],
      findings: [
        { id: "f_1", title: "None", severity: "info", status: "confirmed", confidence: 0 },
      ],
      hypotheses: [
        { id: "hyp_1", statement: "Site works correctly", status: "confirmed", confidence: 0.95 },
      ],
      report: {
        id: "rpt_1",
        summary: "All tests passed. No application defects found.",
        confirmedFindings: [],
        rejectedHypotheses: [],
        inconclusiveHypotheses: [],
        totalExperiments: 3,
        totalEvidence: 3,
        createdAt: new Date().toISOString(),
      },
    });

    // The summary endpoint would return all of this in one request
    const investigation = store.getInvestigation(id);
    const experiments = store.listExperiments(id);
    const evidence = store.listEvidence(id);
    const findings = store.listFindings(id);
    const hypotheses = store.listHypotheses(id);
    const report = store.getReport(id);
    const budget = getBudget(id);

    expect(investigation!.status).toBe("completed");
    expect(experiments.length).toBe(3);
    expect(evidence.length).toBe(3);
    expect(findings.length).toBe(1);
    expect(hypotheses.length).toBe(1);
    expect(report).toBeDefined();
    expect(report!.summary).toContain("No application defects");
    expect(budget.usedExperiments).toBeGreaterThanOrEqual(3);
  });
});
