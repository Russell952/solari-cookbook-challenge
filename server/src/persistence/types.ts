/**
 * Persistence boundary.
 *
 * Probe's domain logic (auth, orchestrator, evidence collector) talks to these
 * repository interfaces only — it must never know whether the backing store is
 * the in-memory dev store or MongoDB. Concrete implementations:
 *
 *   persistence/memory.ts   — in-memory (tests, local dev without MONGODB_URI)
 *   persistence/mongo.ts    — MongoDB (production, durable across restarts)
 *
 * The in-memory store stays the fallback for tests because spinning a real
 * database for unit tests would require a live Atlas account.
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

/** Email/password account record. `passwordHash` NEVER leaves this layer. */
export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

/** Thrown when signup hits a unique-email conflict (race or explicit). */
export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`An account with this email already exists`);
    this.name = "EmailAlreadyExistsError";
  }
}

export interface UserRepository {
  /** Case-normalized lookup by email. One indexed query. */
  getUserByEmail(email: string): Promise<StoredUser | null>;
  getUserById(id: string): Promise<StoredUser | null>;
  /**
   * Create an account. Must be safe against duplicate-email races: the
   * implementation enforces a unique index on the normalized email and
   * translates the duplicate-key error into EmailAlreadyExistsError.
   */
  createUser(email: string, passwordHash: string): Promise<StoredUser>;
  /** Preload/warm-up hook (no-op for Mongo). */
  preload(): Promise<void>;
}

export interface InvestigationRepository {
  createInvestigation(input: CreateInvestigationInput & { ownerId: string }): Investigation;
  getInvestigation(id: string): Investigation | undefined;
  /** Newest first, owner-scoped. */
  listInvestigationsForOwner(ownerId: string): Investigation[];
  /** Patch-merge update; throws when the id does not exist. */
  updateInvestigation(id: string, patch: Partial<Investigation>): Investigation;
  getOwner(investigationId: string): string | undefined;
}

export interface ExperimentRepository {
  createExperiment(input: CreateExperimentInput): Experiment;
  getExperiment(id: string): Experiment | undefined;
  /** Ordered by sequence. */
  listExperiments(investigationId: string): Experiment[];
  updateExperiment(id: string, patch: Partial<Experiment>): Experiment;
}

export interface ActionRepository {
  createAction(patch: Omit<Action, "id">): Action;
  getAction(id: string): Action | undefined;
  listActions(experimentId: string): Action[];
  /** Actions across every experiment of an investigation (batched, no N+1). */
  listActionsForInvestigation(investigationId: string): Action[];
  updateAction(id: string, patch: Partial<Action>): Action;
}

export interface ObservationRepository {
  createObservation(patch: Omit<Observation, "id" | "timestamp">): Observation;
  listObservations(experimentId: string): Observation[];
}

export interface EvidenceRepository {
  createEvidence(patch: Omit<Evidence, "id" | "createdAt"> & { id?: string }): Evidence;
  getEvidence(id: string): Evidence | undefined;
  listEvidence(investigationId: string): Evidence[];
}

export interface HypothesisRepository {
  createHypothesis(patch: Omit<Hypothesis, "id" | "createdAt" | "updatedAt">): Hypothesis;
  getHypothesis(id: string): Hypothesis | undefined;
  listHypotheses(investigationId: string): Hypothesis[];
  updateHypothesis(id: string, patch: Partial<Hypothesis>): Hypothesis;
}

export interface FindingRepository {
  createFinding(patch: Omit<Finding, "id" | "createdAt" | "updatedAt">): Finding;
  getFinding(id: string): Finding | undefined;
  listFindings(investigationId: string): Finding[];
  updateFinding(id: string, patch: Partial<Finding>): Finding;
}

export interface ReportRepository {
  createReport(patch: Omit<Report, "id" | "createdAt">): Report;
  getReport(investigationId: string): Report | undefined;
}

export interface SessionRepository {
  createSession(patch: SolariSession): SolariSession;
  updateSession(id: string, patch: Partial<SolariSession>): SolariSession;
  listSessions(investigationId: string): SolariSession[];
  getActiveSessions(investigationId: string): SolariSession[];
}

/**
 * The full persistence surface. `clearAll` is a TEST/dev helper only — the
 * production repositories must never be mass-cleared by the orchestrator.
 */
export interface Persistence {
  readonly kind: "memory" | "mongo";
  users: UserRepository;
  investigations: InvestigationRepository;
  experiments: ExperimentRepository;
  actions: ActionRepository;
  observations: ObservationRepository;
  evidence: EvidenceRepository;
  hypotheses: HypothesisRepository;
  findings: FindingRepository;
  reports: ReportRepository;
  sessions: SessionRepository;
  /** Connect/initialize indexes (Mongo) or no-op (memory). */
  init(): Promise<void>;
  /** Close connections (Mongo) or no-op (memory). */
  close(): Promise<void>;
  /** Test/dev cleanup — never called in production. */
  clearAll(): void;
}

/** Documents hydrated from the durable backend at startup. */
export interface HydratedState {
  investigations: Investigation[];
  experiments: Experiment[];
  actions: Action[];
  observations: Observation[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  findings: Finding[];
  reports: Report[];
  sessions: SolariSession[];
}

/**
 * Raw document surface of the durable backend. The store facade keeps the
 * synchronous domain API over its in-process cache and uses these methods
 * for write-through persistence and startup hydration — the sync domain
 * repositories above are served from the cache, never from Mongo directly.
 */
export interface RawDocumentPersistence {
  upsertRaw(collection: string, doc: Record<string, unknown> & { id: string }): Promise<void>;
  upsertReportRaw(doc: Record<string, unknown>): Promise<void>;
  hydrateAll(): Promise<HydratedState>;
}

/**
 * The durable backend (MongoDB in production): async user repository plus
 * the raw document surface. Domain state flows through the facade's cache
 * with write-through; users are always read through this repository.
 */
export interface DurableBackend extends RawDocumentPersistence {
  readonly kind: "mongo";
  users: UserRepository;
  init(): Promise<void>;
  close(): Promise<void>;
}
