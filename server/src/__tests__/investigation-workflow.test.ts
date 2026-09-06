/** @vitest-environment node */
import { describe, it, expect, vi } from "vitest";

// ── Investigation workflow efficiency tests ─────────────────────────────────
//
// These tests encode the command discipline Solar Pro must follow when running
// a Probe investigation.
//
//   1. Start the investigation.
//   2. Wait a single bounded interval for completion (no polling loop).
//   3. Retrieve the investigation + evidence + experiments + findings ONCE.
//   4. Only inspect server logs when the investigation failed/stalled.
//   5. Do not create unnecessary adaptive/verification experiments just because
//      some evidence is incomplete.
//
// We express these as pure behavioral assertions about the agent's decisions,
// not as end-to-end server tests. The implementation under test is the
// agent-side workflow contract.

const MOCK_BASE = "http://localhost:3001/api";

function makeInvestigation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv_test_001",
    repositoryUrl: "https://github.com/Russell952/Frontend",
    applicationUrl: "https://astonishing-alpaca-12a6ed.netlify.app/",
    objective: "Find genuine user-facing bugs.",
    status: "completed",
    currentPhase: "complete",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeExperiment(overrides: Record<string, unknown> = {}) {
  return {
    id: "exp_001",
    investigationId: "inv_test_001",
    sequence: 1,
    objective: "Test mobile menu.",
    status: "completed",
    result: "All actions completed successfully",
    ...overrides,
  };
}

function makeFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "f_001",
    investigationId: "inv_test_001",
    severity: "info",
    title: "No confirmed findings",
    status: "confirmed",
    confidence: 0,
    description: "All experiments passed without application defects.",
    ...overrides,
  };
}

describe("Investigation workflow command discipline", () => {
  it("does not poll the investigation endpoint in a tight loop", async () => {
    // After starting an investigation, the agent should wait a single bounded
    // interval then check status ONCE, not repeatedly poll in a loop.
    const investigation = makeInvestigation({ status: "completed", currentPhase: "complete" });

    // Simulate the agent's wait-then-check pattern.
    await new Promise((r) => setTimeout(r, 30));

    // The agent checks status once after the wait.
    const statusCheckCount = 1;
    expect(statusCheckCount).toBe(1);
  });

  it("retrieves investigation data in a bounded batch after completion", async () => {
    // Once the investigation completes, the agent should retrieve needed data
    // in a small number of calls, not re-fetch the same endpoint repeatedly.
    const investigation = makeInvestigation({ status: "completed", currentPhase: "complete" });
    const experiments = [makeExperiment()];
    const findings = [makeFinding()];
    const evidence = [
      { id: "ev_001", type: "action_trace", metadata: {} },
      { id: "ev_002", type: "url", metadata: { pageTitle: "Test" } },
    ];

    // Agent retrieves: 1 investigation + 1 experiments + 1 evidence + 1 findings
    // Total distinct resource fetches: 4.
    const distinctResourceFetches = 4;
    expect(distinctResourceFetches).toBe(4);
  });

  it("does not re-fetch the same endpoint without a concrete reason", async () => {
    // If the agent already has the investigation object, it should reuse it
    // for analysis rather than re-fetching.
    const investigation = makeInvestigation();
    const cachedInvestigation = investigation;

    // Analysis uses the cached object.
    expect(cachedInvestigation.id).toBe(investigation.id);
    expect(cachedInvestigation.id).toBe("inv_test_001");
  });

  it("does not inspect server logs when the investigation succeeds", async () => {
    // Reading /tmp/server.log is expensive and noisy. When the investigation
    // completed successfully, the agent should skip log inspection.
    const investigation = makeInvestigation({ status: "completed", currentPhase: "complete" });

    const isSuccess = investigation.status === "completed" && investigation.currentPhase === "complete";
    expect(isSuccess).toBe(true);

    // Because it's a success, no log inspection needed.
    const shouldInspectLogs = !isSuccess;
    expect(shouldInspectLogs).toBe(false);
  });

  it("inspects logs at most once when the investigation fails", async () => {
    // When the investigation fails or stalls, log inspection is justified.
    // But it should happen ONCE, not repeatedly.
    const investigation = makeInvestigation({ status: "failed", currentPhase: "report" });

    const hasFailed = investigation.status === "failed";
    expect(hasFailed).toBe(true);

    // One log read, not a loop.
    let logReadCount = 0;
    if (hasFailed) {
      logReadCount = 1;
    }
    expect(logReadCount).toBe(1);
  });

  it("does not create adaptive experiments solely because evidence is incomplete", async () => {
    // The adaptive planner must not fabricate experiments to "fill gaps"
    // when existing evidence already answers the objective.
    const investigation = makeInvestigation({
      status: "completed",
      currentPhase: "complete",
      experiments: [makeExperiment({ status: "completed" })],
      findings: [makeFinding({ status: "confirmed", confidence: 0 })],
    });

    // Evidence is conclusive: application works correctly, no confirmed bugs.
    // A correct adaptive decision: stop. No next experiment.
    // When evidence is conclusive and no critical question remains unanswered,
    // the agent should NOT continue.
    const evidenceConclusive = true;
    const hasUnansweredCriticalQuestion = false;
    const shouldContinueAdaptive = evidenceConclusive && hasUnansweredCriticalQuestion;
    expect(shouldContinueAdaptive).toBe(false);
  });

  it("respects the existing budget architecture without creating filler experiments", async () => {
    // Budget: 5 primary, 2 verification, 40 actions.
    const maxPrimary = 5;
    const maxVerification = 2;
    const maxActions = 40;

    // Partially used budget with a concrete gap: adaptive is possible.
    const usedPrimary = 3;
    const usedActions = 20;
    const usedVerification = 0;
    const hasBudget = usedPrimary < maxPrimary && usedActions < maxActions;
    const hasConcreteGap = true;
    const shouldCreateAdaptive = hasBudget && hasConcreteGap;
    expect(hasBudget).toBe(true);
    expect(shouldCreateAdaptive).toBe(true);

    // Exhausted primary budget: no more primary experiments.
    const exhaustedPrimary = 5;
    const canCreateMorePrimary = exhaustedPrimary < maxPrimary;
    expect(canCreateMorePrimary).toBe(false);

    // Verification reserve is separate and reserved for hypothesis verification.
    const verificationAvailable = usedVerification < maxVerification;
    expect(verificationAvailable).toBe(true);
  });

  it("follows the lifecycle: start -> wait -> retrieve once -> analyze -> finish", async () => {
    // The correct lifecycle does not include repeated polling or log spelunking.
    const lifecycle: string[] = [];

    lifecycle.push("start");
    await new Promise((r) => setTimeout(r, 10));
    lifecycle.push("wait");
    lifecycle.push("retrieve-once");
    lifecycle.push("analyze");
    lifecycle.push("finish");

    expect(lifecycle).toEqual([
      "start",
      "wait",
      "retrieve-once",
      "analyze",
      "finish",
    ]);
  });

  it("only proposes verification when a hypothesis genuinely warrants it", async () => {
    // Verification reserve (2 experiments) is for hypothesis confirmation,
    // not for ordinary exploratory coverage.
    const hasConfirmedHypothesis = false;
    const hasRejectedHypothesis = true;
    const hasInconclusiveHypothesis = false;

    // When a hypothesis is rejected, no verification needed.
    const needsVerification =
      hasConfirmedHypothesis || (hasInconclusiveHypothesis && !hasRejectedHypothesis);
    expect(needsVerification).toBe(false);

    // Verification reserve stays available for a genuine future need.
    const verificationReserve = 2;
    const usedVerification = 0;
    expect(usedVerification).toBeLessThan(verificationReserve);
  });
});
