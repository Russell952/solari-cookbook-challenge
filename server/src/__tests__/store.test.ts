/**
 * In-memory store tests.
 *
 * Verifies CRUD operations and data integrity.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../store/index.js";

describe("In-Memory Store", () => {
  beforeEach(() => {
    store.clearAll();
  });

  describe("Investigations", () => {
    it("creates an investigation", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "https://github.com/user/repo",
        applicationUrl: "https://example.com",
        objective: "Test login flow",
      });

      expect(inv.id).toMatch(/^inv_/);
      expect(inv.status).toBe("created");
      expect(inv.currentPhase).toBe("created");
      expect(inv.repositoryUrl).toBe("https://github.com/user/repo");
    });

    it("gets an investigation by id", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "https://example.com",
        objective: "test",
      });
      const found = store.getInvestigation(inv.id);
      expect(found?.id).toBe(inv.id);
    });

    it("returns undefined for unknown id", () => {
      expect(store.getInvestigation("nonexistent")).toBeUndefined();
    });

    it("lists investigations sorted by creation time", () => {
      const inv1 = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "first",
      });
      // Force inv1 to have an older timestamp
      store.updateInvestigation(inv1.id, {
        createdAt: new Date(Date.now() - 10_000).toISOString(),
      });
      const inv2 = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "second",
      });
      const list = store.listInvestigations();
      expect(list).toHaveLength(2);
      // Most recent first
      expect(list[0].id).toBe(inv2.id);
      expect(list[1].id).toBe(inv1.id);
    });

    it("updates an investigation", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      const updated = store.updateInvestigation(inv.id, {
        status: "running",
        currentPhase: "recon",
      });
      expect(updated.status).toBe("running");
      expect(updated.currentPhase).toBe("recon");
      // Original fields preserved
      expect(updated.objective).toBe("test");
    });

    it("throws when updating nonexistent investigation", () => {
      expect(() =>
        store.updateInvestigation("nonexistent", { status: "running" })
      ).toThrow("not found");
    });
  });

  describe("Experiments", () => {
    it("creates an experiment with sequence number", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      const exp = store.createExperiment({
        investigationId: inv.id,
        objective: "Test login",
        plannedActions: [{ tool: "browser", action: "navigate", target: "http://x" }],
      });
      expect(exp.id).toMatch(/^exp_/);
      expect(exp.sequence).toBe(1);
      expect(exp.status).toBe("planned");
    });

    it("increments sequence for experiments in same investigation", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      store.createExperiment({
        investigationId: inv.id,
        objective: "exp 1",
        plannedActions: [],
      });
      const exp2 = store.createExperiment({
        investigationId: inv.id,
        objective: "exp 2",
        plannedActions: [],
      });
      expect(exp2.sequence).toBe(2);
    });

    it("lists experiments sorted by sequence", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      store.createExperiment({
        investigationId: inv.id,
        objective: "exp 2",
        plannedActions: [],
      });
      store.createExperiment({
        investigationId: inv.id,
        objective: "exp 1",
        plannedActions: [],
      });
      const list = store.listExperiments(inv.id);
      expect(list[0].objective).toBe("exp 2");
      expect(list[1].objective).toBe("exp 1");
    });
  });

  describe("Actions", () => {
    it("creates an action", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      const exp = store.createExperiment({
        investigationId: inv.id,
        objective: "test",
        plannedActions: [],
      });
      const action = store.createAction({
        experimentId: exp.id,
        sequence: 1,
        tool: "browser",
        action: "navigate",
        target: "http://example.com",
        input: {},
        status: "pending",
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
      });
      expect(action.id).toMatch(/^act_/);
      expect(action.status).toBe("pending");
    });
  });

  describe("Observations", () => {
    it("creates an observation with timestamp", () => {
      const inv = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      const exp = store.createExperiment({
        investigationId: inv.id,
        objective: "test",
        plannedActions: [],
      });
      const obs = store.createObservation({
        experimentId: exp.id,
        actionId: null,
        expected: null,
        actual: "page loaded",
        type: "behavior",
        description: "Navigation completed",
      });
      expect(obs.id).toMatch(/^obs_/);
      expect(obs.timestamp).toBeTruthy();
    });
  });

  describe("Evidence", () => {
    it("creates evidence with hash", () => {
      const ev = store.createEvidence({
        investigationId: "inv_1",
        experimentId: null,
        observationId: null,
        type: "screenshot",
        uri: null,
        contentHash: "abc123",
        metadata: {},
      });
      expect(ev.id).toMatch(/^ev_/);
      expect(ev.contentHash).toBe("abc123");
    });
  });

  describe("Hypotheses", () => {
    it("creates a hypothesis", () => {
      const hyp = store.createHypothesis({
        investigationId: "inv_1",
        statement: "Login validates email",
        status: "proposed",
        confidence: 0.8,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      });
      expect(hyp.id).toMatch(/^hyp_/);
      expect(hyp.status).toBe("proposed");
    });
  });

  describe("Findings", () => {
    it("creates a finding", () => {
      const f = store.createFinding({
        investigationId: "inv_1",
        title: "XSS vulnerability",
        severity: "critical",
        description: "Input not sanitized",
        status: "draft",
        confidence: 0.9,
        rootCause: null,
        reproductionSteps: [],
        recommendation: null,
        evidenceIds: [],
      });
      expect(f.id).toMatch(/^fnd_/);
      expect(f.status).toBe("draft");
    });
  });

  describe("Reports", () => {
    it("creates a report", () => {
      const r = store.createReport({
        investigationId: "inv_1",
        summary: "Found 1 critical issue",
        confirmedFindings: [],
        rejectedHypotheses: [],
        inconclusiveHypotheses: [],
        totalExperiments: 3,
        totalEvidence: 5,
      });
      expect(r.id).toMatch(/^rpt_/);
    });
  });

  describe("Sessions", () => {
    it("creates and retrieves a session", () => {
      const session: import("@probe/shared").SolariSession = {
        id: "sess_1",
        investigationId: "inv_1",
        type: "browser",
        externalSessionId: "ext_1",
        status: "active",
        createdAt: new Date().toISOString(),
        releasedAt: null,
      };
      store.createSession(session);
      const active = store.getActiveSessions("inv_1");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("sess_1");
    });

    it("getActiveSessions excludes released sessions", () => {
      const session: import("@probe/shared").SolariSession = {
        id: "sess_1",
        investigationId: "inv_1",
        type: "browser",
        externalSessionId: "ext_1",
        status: "active",
        createdAt: new Date().toISOString(),
        releasedAt: null,
      };
      store.createSession(session);
      store.updateSession("sess_1", { status: "released" });

      const active = store.getActiveSessions("inv_1");
      expect(active).toHaveLength(0);
    });
  });

  describe("clearAll", () => {
    it("clears all collections", () => {
      store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "",
        objective: "test",
      });
      store.clearAll();
      expect(store.listInvestigations()).toHaveLength(0);
    });
  });
});
