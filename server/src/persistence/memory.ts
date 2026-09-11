/**
 * In-memory persistence implementation.
 *
 * Same behavior as the historical singleton store: process-local Maps, so
 * everything resets on restart. Used for local development and tests.
 */
import type {
  Investigation,
  Experiment,
  Action,
  Observation,
  Evidence,
  Hypothesis,
  Finding,
  Report,
  SolariSession,
  CreateInvestigationInput,
  CreateExperimentInput,
} from "@probe/shared";
import type {
  Persistence,
  StoredUser,
  UserRepository,
} from "./types.js";
import { EmailAlreadyExistsError } from "./types.js";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

const users = new Map<string, StoredUser>(); // key: normalized email
const usersById = new Map<string, StoredUser>();

export const memoryUsers: UserRepository = {
  async getUserByEmail(email) {
    return users.get(email.trim().toLowerCase()) ?? null;
  },
  async getUserById(id) {
    return usersById.get(id) ?? null;
  },
  async createUser(email, passwordHash) {
    const normalized = email.trim().toLowerCase();
    if (users.has(normalized)) throw new EmailAlreadyExistsError(normalized);
    const user: StoredUser = {
      id: `usr_${crypto.randomUUID()}`,
      email: normalized,
      passwordHash,
      createdAt: now(),
    };
    users.set(normalized, user);
    usersById.set(user.id, user);
    return user;
  },
  async preload() {
    /* nothing to preload in memory */
  },
};

/** Test helper: drop the in-memory user records (dev/test isolation only). */
export function clearMemoryUsersForTest(): void {
  users.clear();
  usersById.clear();
}

const investigations = new Map<string, Investigation>();
const experiments = new Map<string, Experiment>();
const actions = new Map<string, Action>();
const observations = new Map<string, Observation>();
const evidenceItems = new Map<string, Evidence>();
const hypotheses = new Map<string, Hypothesis>();
const findings = new Map<string, Finding>();
const reports = new Map<string, Report>();
const sessions = new Map<string, SolariSession>();
const ownership = new Map<string, string>();

function createInvestigation(input: CreateInvestigationInput & { ownerId: string }): Investigation {
  const inv: Investigation = {
    id: generateId("inv"),
    repositoryUrl: input.repositoryUrl,
    applicationUrl: input.applicationUrl,
    objective: input.objective,
    status: "created",
    currentPhase: "created",
    createdAt: now(),
    updatedAt: now(),
    ownerId: input.ownerId,
  };
  investigations.set(inv.id, inv);
  ownership.set(inv.id, input.ownerId);
  return inv;
}

function listInvestigationsForOwner(ownerId: string): Investigation[] {
  return Array.from(investigations.values())
    .filter((inv) => ownership.get(inv.id) === ownerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export const memoryPersistence: Persistence = {
  kind: "memory",
  users: memoryUsers,
  investigations: {
    createInvestigation,
    getInvestigation: (id) => investigations.get(id),
    listInvestigationsForOwner,
    updateInvestigation(id, patch) {
      const inv = investigations.get(id);
      if (!inv) throw new Error(`Investigation ${id} not found`);
      const updated = { ...inv, ...patch, updatedAt: now() };
      investigations.set(id, updated);
      return updated;
    },
    getOwner: (id) => ownership.get(id),
  },
  experiments: {
    createExperiment(input) {
      const existing = Array.from(experiments.values()).filter(
        (e) => e.investigationId === input.investigationId
      );
      const exp: Experiment = {
        id: generateId("exp"),
        investigationId: input.investigationId,
        sequence: existing.length + 1,
        objective: input.objective,
        hypothesisId: input.hypothesisId ?? null,
        status: "planned",
        preconditions: input.preconditions ?? [],
        plannedActions: input.plannedActions,
        result: null,
        error: null,
        createdAt: now(),
        updatedAt: now(),
      };
      experiments.set(exp.id, exp);
      return exp;
    },
    getExperiment: (id) => experiments.get(id),
    listExperiments(investigationId) {
      return Array.from(experiments.values())
        .filter((e) => e.investigationId === investigationId)
        .sort((a, b) => a.sequence - b.sequence);
    },
    updateExperiment(id, patch) {
      const exp = experiments.get(id);
      if (!exp) throw new Error(`Experiment ${id} not found`);
      const updated = { ...exp, ...patch, updatedAt: now() };
      experiments.set(id, updated);
      return updated;
    },
  },
  actions: {
    createAction(patch) {
      const action: Action = { ...patch, id: generateId("act") };
      actions.set(action.id, action);
      return action;
    },
    getAction: (id) => actions.get(id),
    listActions(experimentId) {
      return Array.from(actions.values())
        .filter((a) => a.experimentId === experimentId)
        .sort((a, b) => a.sequence - b.sequence);
    },
    listActionsForInvestigation(investigationId) {
      const experimentIds = new Set(
        Array.from(experiments.values())
          .filter((e) => e.investigationId === investigationId)
          .map((e) => e.id)
      );
      return Array.from(actions.values())
        .filter((a) => experimentIds.has(a.experimentId))
        .sort((a, b) => a.sequence - b.sequence);
    },
    updateAction(id, patch) {
      const action = actions.get(id);
      if (!action) throw new Error(`Action ${id} not found`);
      const updated = { ...action, ...patch };
      actions.set(id, updated);
      return updated;
    },
  },
  observations: {
    createObservation(patch) {
      const obs: Observation = { ...patch, id: generateId("obs"), timestamp: now() };
      observations.set(obs.id, obs);
      return obs;
    },
    listObservations(experimentId) {
      return Array.from(observations.values())
        .filter((o) => o.experimentId === experimentId)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },
  },
  evidence: {
    createEvidence(patch) {
      const ev: Evidence = { ...patch, id: patch.id ?? generateId("ev"), createdAt: now() };
      evidenceItems.set(ev.id, ev);
      return ev;
    },
    getEvidence: (id) => evidenceItems.get(id),
    listEvidence(investigationId) {
      return Array.from(evidenceItems.values())
        .filter((e) => e.investigationId === investigationId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
  },
  hypotheses: {
    createHypothesis(patch) {
      const hyp: Hypothesis = { ...patch, id: generateId("hyp"), createdAt: now(), updatedAt: now() };
      hypotheses.set(hyp.id, hyp);
      return hyp;
    },
    getHypothesis: (id) => hypotheses.get(id),
    listHypotheses(investigationId) {
      return Array.from(hypotheses.values())
        .filter((h) => h.investigationId === investigationId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
    updateHypothesis(id, patch) {
      const hyp = hypotheses.get(id);
      if (!hyp) throw new Error(`Hypothesis ${id} not found`);
      const updated = { ...hyp, ...patch, updatedAt: now() };
      hypotheses.set(id, updated);
      return updated;
    },
  },
  findings: {
    createFinding(patch) {
      const f: Finding = { ...patch, id: generateId("fnd"), createdAt: now(), updatedAt: now() };
      findings.set(f.id, f);
      return f;
    },
    getFinding: (id) => findings.get(id),
    listFindings(investigationId) {
      return Array.from(findings.values())
        .filter((f) => f.investigationId === investigationId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
    updateFinding(id, patch) {
      const f = findings.get(id);
      if (!f) throw new Error(`Finding ${id} not found`);
      const updated = { ...f, ...patch, updatedAt: now() };
      findings.set(id, updated);
      return updated;
    },
  },
  reports: {
    createReport(patch) {
      const r: Report = { ...patch, id: generateId("rpt"), createdAt: now() };
      reports.set(r.id, r);
      return r;
    },
    getReport(investigationId) {
      return Array.from(reports.values()).find((r) => r.investigationId === investigationId);
    },
  },
  sessions: {
    createSession(patch) {
      sessions.set(patch.id, patch);
      return patch;
    },
    updateSession(id, patch) {
      const s = sessions.get(id);
      if (!s) throw new Error(`Session ${id} not found`);
      const updated = { ...s, ...patch };
      sessions.set(id, updated);
      return updated;
    },
    listSessions(investigationId) {
      return Array.from(sessions.values()).filter((s) => s.investigationId === investigationId);
    },
    getActiveSessions(investigationId) {
      return Array.from(sessions.values())
        .filter((s) => s.investigationId === investigationId && s.status === "active");
    },
  },
  async init() {
    /* no-op */
  },
  async close() {
    /* no-op */
  },
  clearAll() {
    users.clear();
    usersById.clear();
    investigations.clear();
    experiments.clear();
    actions.clear();
    observations.clear();
    evidenceItems.clear();
    hypotheses.clear();
    findings.clear();
    reports.clear();
    sessions.clear();
    ownership.clear();
  },
};
