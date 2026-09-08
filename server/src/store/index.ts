/**
 * In-memory data store.
 *
 * Implements repository pattern so persistence can be swapped
 * for PostgreSQL without rewriting business logic.
 *
 * Every method mirrors what a real DB repository would expose.
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

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ── In-memory collections ──────────────────────────────────────────────────

const investigations = new Map<string, Investigation>();
const experiments = new Map<string, Experiment>();
const actions = new Map<string, Action>();
const observations = new Map<string, Observation>();
const evidenceItems = new Map<string, Evidence>();
const hypotheses = new Map<string, Hypothesis>();
const findings = new Map<string, Finding>();
const reports = new Map<string, Report>();
const sessions = new Map<string, SolariSession>();

// ── Investigations ─────────────────────────────────────────────────────────

function createInvestigation(input: CreateInvestigationInput): Investigation {
  const inv: Investigation = {
    id: generateId("inv"),
    repositoryUrl: input.repositoryUrl,
    applicationUrl: input.applicationUrl,
    objective: input.objective,
    status: "created",
    currentPhase: "created",
    createdAt: now(),
    updatedAt: now(),
  };
  investigations.set(inv.id, inv);
  return inv;
}

function getInvestigation(id: string): Investigation | undefined {
  return investigations.get(id);
}

function listInvestigations(): Investigation[] {
  return Array.from(investigations.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

function updateInvestigation(id: string, patch: Partial<Investigation>): Investigation {
  const inv = investigations.get(id);
  if (!inv) throw new Error(`Investigation ${id} not found`);
  const updated = { ...inv, ...patch, updatedAt: now() };
  investigations.set(id, updated);
  return updated;
}

// ── Experiments ────────────────────────────────────────────────────────────

function createExperiment(input: CreateExperimentInput): Experiment {
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
}

function getExperiment(id: string): Experiment | undefined {
  return experiments.get(id);
}

function listExperiments(investigationId: string): Experiment[] {
  return Array.from(experiments.values())
    .filter((e) => e.investigationId === investigationId)
    .sort((a, b) => a.sequence - b.sequence);
}

function updateExperiment(id: string, patch: Partial<Experiment>): Experiment {
  const exp = experiments.get(id);
  if (!exp) throw new Error(`Experiment ${id} not found`);
  const updated = { ...exp, ...patch, updatedAt: now() };
  experiments.set(id, updated);
  return updated;
}

// ── Actions ────────────────────────────────────────────────────────────────

function createAction(patch: Omit<Action, "id">): Action {
  const action: Action = { ...patch, id: generateId("act") };
  actions.set(action.id, action);
  return action;
}

function getAction(id: string): Action | undefined {
  return actions.get(id);
}

function listActions(experimentId: string): Action[] {
  return Array.from(actions.values())
    .filter((a) => a.experimentId === experimentId)
    .sort((a, b) => a.sequence - b.sequence);
}

function listActionsForInvestigation(investigationId: string): Action[] {
  const experimentIds = new Set(
    Array.from(experiments.values())
      .filter((e) => e.investigationId === investigationId)
      .map((e) => e.id)
  );
  return Array.from(actions.values())
    .filter((a) => experimentIds.has(a.experimentId))
    .sort((a, b) => a.sequence - b.sequence);
}

function updateAction(id: string, patch: Partial<Action>): Action {
  const action = actions.get(id);
  if (!action) throw new Error(`Action ${id} not found`);
  const updated = { ...action, ...patch };
  actions.set(id, updated);
  return updated;
}

// ── Observations ───────────────────────────────────────────────────────────

function createObservation(patch: Omit<Observation, "id" | "timestamp">): Observation {
  const obs: Observation = { ...patch, id: generateId("obs"), timestamp: now() };
  observations.set(obs.id, obs);
  return obs;
}

function listObservations(experimentId: string): Observation[] {
  return Array.from(observations.values())
    .filter((o) => o.experimentId === experimentId)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ── Evidence ───────────────────────────────────────────────────────────────

function createEvidence(
  patch: Omit<Evidence, "id" | "createdAt"> & { id?: string }
): Evidence {
  // An explicit id lets the evidence collector name the artifact file after
  // the evidence item before the store record exists.
  const ev: Evidence = { ...patch, id: patch.id ?? generateId("ev"), createdAt: now() };
  evidenceItems.set(ev.id, ev);
  return ev;
}

function getEvidence(id: string): Evidence | undefined {
  return evidenceItems.get(id);
}

function listEvidence(investigationId: string): Evidence[] {
  return Array.from(evidenceItems.values())
    .filter((e) => e.investigationId === investigationId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

// ── Hypotheses ─────────────────────────────────────────────────────────────

function createHypothesis(patch: Omit<Hypothesis, "id" | "createdAt" | "updatedAt">): Hypothesis {
  const hyp: Hypothesis = { ...patch, id: generateId("hyp"), createdAt: now(), updatedAt: now() };
  hypotheses.set(hyp.id, hyp);
  return hyp;
}

function getHypothesis(id: string): Hypothesis | undefined {
  return hypotheses.get(id);
}

function listHypotheses(investigationId: string): Hypothesis[] {
  return Array.from(hypotheses.values())
    .filter((h) => h.investigationId === investigationId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function updateHypothesis(id: string, patch: Partial<Hypothesis>): Hypothesis {
  const hyp = hypotheses.get(id);
  if (!hyp) throw new Error(`Hypothesis ${id} not found`);
  const updated = { ...hyp, ...patch, updatedAt: now() };
  hypotheses.set(id, updated);
  return updated;
}

// ── Findings ───────────────────────────────────────────────────────────────

function createFinding(patch: Omit<Finding, "id" | "createdAt" | "updatedAt">): Finding {
  const f: Finding = { ...patch, id: generateId("fnd"), createdAt: now(), updatedAt: now() };
  findings.set(f.id, f);
  return f;
}

function getFinding(id: string): Finding | undefined {
  return findings.get(id);
}

function listFindings(investigationId: string): Finding[] {
  return Array.from(findings.values())
    .filter((f) => f.investigationId === investigationId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function updateFinding(id: string, patch: Partial<Finding>): Finding {
  const f = findings.get(id);
  if (!f) throw new Error(`Finding ${id} not found`);
  const updated = { ...f, ...patch, updatedAt: now() };
  findings.set(id, updated);
  return updated;
}

// ── Reports ────────────────────────────────────────────────────────────────

function createReport(patch: Omit<Report, "id" | "createdAt">): Report {
  const r: Report = { ...patch, id: generateId("rpt"), createdAt: now() };
  reports.set(r.id, r);
  return r;
}

function getReport(investigationId: string): Report | undefined {
  return Array.from(reports.values()).find((r) => r.investigationId === investigationId);
}

// ── Sessions ───────────────────────────────────────────────────────────────

function createSession(patch: SolariSession): SolariSession {
  sessions.set(patch.id, patch);
  return patch;
}

function updateSession(id: string, patch: Partial<SolariSession>): SolariSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`Session ${id} not found`);
  const updated = { ...s, ...patch };
  sessions.set(id, updated);
  return updated;
}

function listSessions(investigationId: string): SolariSession[] {
  return Array.from(sessions.values()).filter((s) => s.investigationId === investigationId);
}

function getActiveSessions(investigationId: string): SolariSession[] {
  return listSessions(investigationId).filter((s) => s.status === "active");
}

// ── Ownership index (single-owner MVP model) ──────────────────────────────

/** investigationId → ownerId. Set at creation, checked on every read. */
const ownership = new Map<string, string>();

function setOwner(investigationId: string, ownerId: string): void {
  ownership.set(investigationId, ownerId);
}

function getOwner(investigationId: string): string | undefined {
  return ownership.get(investigationId);
}

/** All investigation ids owned by a caller, newest first (matches listInvestigations order). */
function listInvestigationIdsForOwner(ownerId: string): string[] {
  return listInvestigations()
    .filter((inv) => ownership.get(inv.id) === ownerId)
    .map((inv) => inv.id);
}

/** True when the resource id belongs to the given investigation+owner. */
function resourceBelongsTo(
  ownerId: string,
  investigationId: string | null,
  resource: { investigationId: string } | undefined | null
): boolean {
  if (!resource) return false;
  if (resource.investigationId !== investigationId) return false;
  return ownership.get(investigationId) === ownerId;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function clearAll(): void {
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
}

// ── Export ─────────────────────────────────────────────────────────────────

export const store = {
  // Investigations
  createInvestigation,
  getInvestigation,
  listInvestigations,
  updateInvestigation,
  // Experiments
  createExperiment,
  getExperiment,
  listExperiments,
  updateExperiment,
  // Actions
  createAction,
  getAction,
  listActions,
  listActionsForInvestigation,
  updateAction,
  // Observations
  createObservation,
  listObservations,
  // Evidence
  createEvidence,
  getEvidence,
  listEvidence,
  // Hypotheses
  createHypothesis,
  getHypothesis,
  listHypotheses,
  updateHypothesis,
  // Findings
  createFinding,
  getFinding,
  listFindings,
  updateFinding,
  // Reports
  createReport,
  getReport,
  // Sessions
  createSession,
  updateSession,
  listSessions,
  getActiveSessions,
  // Ownership (security: every read is scoped to the authenticated owner)
  setOwner,
  getOwner,
  listInvestigationIdsForOwner,
  resourceBelongsTo,
  // Cleanup
  clearAll,
};
