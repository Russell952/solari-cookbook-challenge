/**
 * Data store facade.
 *
 * Preserves the historical synchronous store API (every controller, the
 * orchestrator, and the tests call `store.*` synchronously) while making
 * persistence DURABLE when MongoDB is configured:
 *
 *   reads   → served from the in-process cache (hydrated from MongoDB at
 *             startup, kept warm by write-through)
 *   writes  → applied to the cache synchronously, then persisted to MongoDB
 *             write-through; `store.flush()` awaits the durable checkpoint
 *             queue (used at meaningful checkpoints and on shutdown)
 *
 * The synchronous API is load-bearing: the orchestrator and ~20 test files
 * use it, and the HTTP handlers are synchronous today. Durable writes are
 * fire-and-forget from the caller's perspective but serialized through a
 * per-collection queue so ordering is preserved and checkpoint callers can
 * await consistency with flush()/flushAll().
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
import type { StoredUser } from "../persistence/types.js";
import { type DurableBackend, type RawDocumentPersistence } from "../persistence/types.js";
import { memoryUsers, clearMemoryUsersForTest } from "../persistence/memory.js";
import { setDurableBackend, getDurableBackendSync } from "../persistence/index.js";
import { profiler } from "../profiler/index.js";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ── In-process cache (single source for synchronous reads) ────────────────

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

// ── Durable backend (write-through) ─────────────────────────────────────

/**
 * The durable backend (Mongo in production) or null in dev/test mode, where
 * the in-process cache IS the store. Users are the exception: when no backend
 * is configured they are served by the in-memory user repository.
 */
let durableBackend: DurableBackend | null = null;
/** Per-collection serialized write chains; keep latest chain per collection. */
const durableChains = new Map<string, Promise<void>>();

/**
 * Queue a durable write. The cache mutation has ALREADY happened (callers
 * hold the synchronous contract); this only persists it. Errors are logged
 * once per chain — a failed checkpoint never crashes the API handler, but
 * `store.flushAll()` exposes the error for explicit checkpoint handling.
 */
function persist(collection: string, op: () => Promise<void>): void {
  const prev = durableChains.get(collection) ?? Promise.resolve();
  const wrapped = async () => {
    await profiler.span("db", `mongo.upsert:${collection}`, { collection }, op);
  };
  const next = prev.then(wrapped, wrapped);
  durableChains.set(
    collection,
    next.then(
      () => undefined,
      (err) => {
        console.error(`[store] durable write failed (${collection}):`, err instanceof Error ? err.message : err);
      }
    )
  );
}

/**
 * Persist the CURRENT state of a document (last-write-wins). Because the
 * cache is already mutated, replaying the latest state is always correct —
 * the queue only provides ordering.
 */
function persistUpsert(collection: string, doc: Record<string, unknown> & { id: string }): void {
  if (!durableBackend) return; // dev/test: the cache IS the store
  persist(collection, () => durableBackend!.upsertRaw(collection, doc));
}

/** Await every queued durable write (used at checkpoints and shutdown). */
export async function flushAll(): Promise<void> {
  await Promise.all(Array.from(durableChains.values()).map((p) => p.catch(() => undefined)));
}

// ── Hydration (startup) ──────────────────────────────────────────────────

/**
 * Load the durable state into the in-process cache. Called once at server
 * startup AFTER persistence is initialized. In-memory mode is a no-op (the
 * cache IS the store).
 */
export async function hydrate(): Promise<void> {
  const backend = durableBackend;
  if (!backend) return;
  const all = await backend.hydrateAll();
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
  for (const inv of all.investigations) {
    investigations.set(inv.id, inv);
    if (inv.ownerId) ownership.set(inv.id, inv.ownerId);
  }
  for (const e of all.experiments) experiments.set(e.id, e);
  for (const a of all.actions) actions.set(a.id, a);
  for (const o of all.observations) observations.set(o.id, o);
  for (const e of all.evidence) evidenceItems.set(e.id, e);
  for (const h of all.hypotheses) hypotheses.set(h.id, h);
  for (const f of all.findings) findings.set(f.id, f);
  for (const r of all.reports) reports.set(r.id, r);
  for (const s of all.sessions) sessions.set(s.id, s);
}

/**
 * Bind the facade to a durable backend (called at startup). Passing null
 * (or omitting) clears the binding — the in-memory state becomes the store
 * (dev/test mode).
 */
export function useDurableBackend(p: DurableBackend | null): void {
  durableBackend = p;
  setDurableBackend(p);
}

/** The active durable backend (for tests/smoke checks). */
export function activeDurableBackend(): DurableBackend | null {
  return durableBackend;
}

// ── Investigations ────────────────────────────────────────────────────────

function createInvestigation(input: CreateInvestigationInput & { ownerId?: string }): Investigation {
  const inv: Investigation = {
    id: generateId("inv"),
    repositoryUrl: input.repositoryUrl,
    applicationUrl: input.applicationUrl,
    objective: input.objective,
    status: "created",
    currentPhase: "created",
    createdAt: now(),
    updatedAt: now(),
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
  };
  investigations.set(inv.id, inv);
  if (input.ownerId) ownership.set(inv.id, input.ownerId);
  // Always persist; setOwner() patches ownerId right after in the API path.
  persistUpsert("investigations", inv as unknown as Record<string, unknown> & { id: string });
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
  persistUpsert("investigations", updated as unknown as Record<string, unknown> & { id: string });
  return updated;
}

// ── Experiments ───────────────────────────────────────────────────────────

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
  persistUpsert("experiments", exp as unknown as Record<string, unknown> & { id: string });
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
  persistUpsert("experiments", updated as unknown as Record<string, unknown> & { id: string });
  return updated;
}

// ── Actions ───────────────────────────────────────────────────────────────

function createAction(patch: Omit<Action, "id">): Action {
  const action: Action = { ...patch, id: generateId("act") };
  actions.set(action.id, action);
  persistUpsert("actions", action as unknown as Record<string, unknown> & { id: string });
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
  persistUpsert("actions", updated as unknown as Record<string, unknown> & { id: string });
  return updated;
}

// ── Observations ──────────────────────────────────────────────────────────

function createObservation(patch: Omit<Observation, "id" | "timestamp">): Observation {
  const obs: Observation = { ...patch, id: generateId("obs"), timestamp: now() };
  observations.set(obs.id, obs);
  persistUpsert("observations", obs as unknown as Record<string, unknown> & { id: string });
  return obs;
}

function listObservations(experimentId: string): Observation[] {
  return Array.from(observations.values())
    .filter((o) => o.experimentId === experimentId)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ── Evidence ──────────────────────────────────────────────────────────────

function createEvidence(
  patch: Omit<Evidence, "id" | "createdAt"> & { id?: string }
): Evidence {
  const ev: Evidence = { ...patch, id: patch.id ?? generateId("ev"), createdAt: now() };
  evidenceItems.set(ev.id, ev);
  persistUpsert("evidence", ev as unknown as Record<string, unknown> & { id: string });
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

// ── Hypotheses ────────────────────────────────────────────────────────────

function createHypothesis(patch: Omit<Hypothesis, "id" | "createdAt" | "updatedAt">): Hypothesis {
  const hyp: Hypothesis = { ...patch, id: generateId("hyp"), createdAt: now(), updatedAt: now() };
  hypotheses.set(hyp.id, hyp);
  persistUpsert("hypotheses", hyp as unknown as Record<string, unknown> & { id: string });
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
  persistUpsert("hypotheses", updated as unknown as Record<string, unknown> & { id: string });
  return updated;
}

// ── Findings ──────────────────────────────────────────────────────────────

function createFinding(patch: Omit<Finding, "id" | "createdAt" | "updatedAt">): Finding {
  const f: Finding = { ...patch, id: generateId("fnd"), createdAt: now(), updatedAt: now() };
  findings.set(f.id, f);
  persistUpsert("findings", f as unknown as Record<string, unknown> & { id: string });
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
  persistUpsert("findings", updated as unknown as Record<string, unknown> & { id: string });
  return updated;
}

// ── Reports ───────────────────────────────────────────────────────────────

function createReport(patch: Omit<Report, "id" | "createdAt">): Report {
  const r: Report = { ...patch, id: generateId("rpt"), createdAt: now() };
  reports.set(r.id, r);
  // Reports are replaced per investigation (unique index on investigationId).
  const backend = durableBackend;
  if (backend) {
    persist("reports", () => backend.upsertReportRaw(r as unknown as Record<string, unknown>));
  }
  return r;
}

function getReport(investigationId: string): Report | undefined {
  return Array.from(reports.values()).find((r) => r.investigationId === investigationId);
}

// ── Sessions ──────────────────────────────────────────────────────────────

function createSession(patch: SolariSession): SolariSession {
  sessions.set(patch.id, patch);
  persistUpsert("solari_sessions", patch as unknown as Record<string, unknown> & { id: string });
  return patch;
}

function updateSession(id: string, patch: Partial<SolariSession>): SolariSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`Session ${id} not found`);
  const updated = { ...s, ...patch };
  sessions.set(id, updated);
  persistUpsert("solari_sessions", updated as unknown as Record<string, unknown> & { id: string });
  return updated;
}

function listSessions(investigationId: string): SolariSession[] {
  return Array.from(sessions.values()).filter((s) => s.investigationId === investigationId);
}

function getActiveSessions(investigationId: string): SolariSession[] {
  return listSessions(investigationId).filter((s) => s.status === "active");
}

// ── Ownership index (single-owner model) ──────────────────────────────────

function setOwner(investigationId: string, ownerId: string): void {
  ownership.set(investigationId, ownerId);
  // Persist ownership on the investigation document itself.
  const inv = investigations.get(investigationId);
  if (inv) {
    const updated = { ...inv, ownerId, updatedAt: now() };
    investigations.set(investigationId, updated);
    persistUpsert("investigations", updated as unknown as Record<string, unknown> & { id: string });
  }
}

function getOwner(investigationId: string): string | undefined {
  return ownership.get(investigationId);
}

function listInvestigationIdsForOwner(ownerId: string): string[] {
  return listInvestigations()
    .filter((inv) => ownership.get(inv.id) === ownerId)
    .map((inv) => inv.id);
}

function resourceBelongsTo(
  ownerId: string,
  investigationId: string | null,
  resource: { investigationId: string } | undefined | null
): boolean {
  if (!resource) return false;
  if (resource.investigationId !== investigationId) return false;
  return ownership.get(investigationId) === ownerId;
}

// ── Users (facade over the persistence UserRepository) ────────────────────

/**
 * Async user operations. Auth routes were already async, so they consume
 * these directly. With a durable backend (Mongo, production) accounts are
 * served by its indexed UserRepository; without one (dev/tests) they fall
 * back to the in-memory user repository.
 */
export const users = {
  getUserByEmail: (email: string): Promise<StoredUser | null> =>
    (durableBackend?.users ?? memoryUsers).getUserByEmail(email),
  getUserById: (id: string): Promise<StoredUser | null> =>
    (durableBackend?.users ?? memoryUsers).getUserById(id),
  createUser: (email: string, passwordHash: string): Promise<StoredUser> =>
    (durableBackend?.users ?? memoryUsers).createUser(email, passwordHash),
  preload: (): Promise<void> => (durableBackend?.users ?? memoryUsers).preload(),
};

/** Exported so auth routes can import the error class from one place. */
export { EmailAlreadyExistsError } from "../persistence/types.js";

// ── Cleanup ───────────────────────────────────────────────────────────────

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
  durableChains.clear();
  if (!durableBackend) clearMemoryUsersForTest();
}

// ── Export ────────────────────────────────────────────────────────────────

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
  // Durability
  flushAll,
  hydrate,
  // Cleanup
  clearAll,
};

// Re-export for modules that want the current backend without importing
// the persistence module directly.
export { getDurableBackendSync };
