// ── Investigation ──────────────────────────────────────────────────────────

export type InvestigationStatus =
  | "created"
  | "running"
  | "paused"
  | "cancelled"
  | "completed"
  | "failed";

export type InvestigationPhase =
  | "created"
  | "recon"
  | "plan"
  | "experiment"
  | "execute"
  | "observe"
  | "analyze"
  | "hypothesis"
  | "verification"
  | "confirmed"
  | "rejected"
  | "inconclusive"
  | "report"
  | "complete";

export interface Investigation {
  id: string;
  repositoryUrl: string;
  applicationUrl: string;
  objective: string;
  status: InvestigationStatus;
  currentPhase: InvestigationPhase;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvestigationInput {
  repositoryUrl: string;
  applicationUrl: string;
  objective: string;
}

// ── Experiment ─────────────────────────────────────────────────────────────

export type ExperimentStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "inconclusive";

export interface Experiment {
  id: string;
  investigationId: string;
  sequence: number;
  objective: string;
  hypothesisId: string | null;
  status: ExperimentStatus;
  preconditions: string[];
  plannedActions: PlannedAction[];
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ViewportPreset = "desktop" | "mobile";

export interface Viewport {
  /** Preset name */
  preset?: ViewportPreset;
  /** Viewport width in pixels */
  width: number;
  /** Viewport height in pixels */
  height: number;
}

/** Well-known viewport presets */
export const VIEWPORT_PRESETS: Record<ViewportPreset, Viewport> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export interface PlannedAction {
  tool: "browser" | "sandbox" | "git";
  action: string;
  target: string;
  input?: Record<string, unknown>;
  /** Optional viewport to apply before this action. Only valid for the first browser action in an experiment. */
  viewport?: Viewport;
}

export interface CreateExperimentInput {
  investigationId: string;
  objective: string;
  hypothesisId?: string | null;
  preconditions?: string[];
  plannedActions: PlannedAction[];
}

// ── Action ─────────────────────────────────────────────────────────────────

export type ActionStatus =
  | "pending"
  | "running"
  | "success"
  | "retryable_failure"
  | "non_retryable_failure"
  | "timeout"
  | "blocked";

export interface Action {
  id: string;
  experimentId: string;
  sequence: number;
  tool: string;
  action: string;
  target: string;
  input: Record<string, unknown>;
  status: ActionStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

// ── Observation ────────────────────────────────────────────────────────────

export type ObservationType =
  | "behavior"
  | "error"
  | "screenshot"
  | "dom_snapshot"
  | "network"
  | "console";

export interface Observation {
  id: string;
  experimentId: string;
  actionId: string | null;
  expected: string | null;
  actual: string;
  type: ObservationType;
  description: string;
  timestamp: string;
}

// ── Evidence ───────────────────────────────────────────────────────────────

export type EvidenceType =
  | "screenshot"
  | "url"
  | "action_trace"
  | "expected_result"
  | "observed_result"
  | "repository_source"
  | "dom_snapshot"
  | "replay"
  | "console_output";

export interface Evidence {
  id: string;
  investigationId: string;
  experimentId: string | null;
  observationId: string | null;
  type: EvidenceType;
  uri: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ── Hypothesis ─────────────────────────────────────────────────────────────

export type HypothesisStatus =
  | "proposed"
  | "investigating"
  | "confirmed"
  | "rejected"
  | "inconclusive";

export interface Hypothesis {
  id: string;
  investigationId: string;
  statement: string;
  status: HypothesisStatus;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Finding ────────────────────────────────────────────────────────────────

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "draft" | "confirmed" | "rejected" | "inconclusive";

export interface Finding {
  id: string;
  investigationId: string;
  title: string;
  severity: FindingSeverity;
  description: string;
  status: FindingStatus;
  confidence: number;
  rootCause: string | null;
  reproductionSteps: string[];
  recommendation: string | null;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Report ─────────────────────────────────────────────────────────────────

export interface Report {
  id: string;
  investigationId: string;
  summary: string;
  confirmedFindings: Finding[];
  rejectedHypotheses: string[];
  inconclusiveHypotheses: string[];
  totalExperiments: number;
  totalEvidence: number;
  createdAt: string;
}

// ── Solari Session ─────────────────────────────────────────────────────────

export type SolariSessionType = "browser" | "sandbox" | "desktop";

export interface SolariSession {
  id: string;
  investigationId: string;
  type: SolariSessionType;
  externalSessionId: string;
  status: "active" | "released" | "destroyed";
  createdAt: string;
  releasedAt: string | null;
}

// ── SSE Events ─────────────────────────────────────────────────────────────

export type SSEEventType =
  | "phase_change"
  | "experiment_started"
  | "experiment_completed"
  | "action_started"
  | "action_completed"
  | "observation_recorded"
  | "hypothesis_proposed"
  | "hypothesis_updated"
  | "finding_created"
  | "finding_updated"
  | "evidence_captured"
  | "error"
  | "complete";

export interface SSEEvent {
  type: SSEEventType;
  investigationId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// ── Budget ─────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  maxExperiments: number;
  maxBrowserActions: number;
  maxSandboxCommands: number;
  maxRuntimeMs: number;
  maxAiCalls: number;
  /** Number of experiments reserved for hypothesis verification. */
  verificationReserve: number;
}

export interface Budget extends BudgetConfig {
  usedExperiments: number;
  usedBrowserActions: number;
  usedSandboxCommands: number;
  usedRuntime: number;
  usedAiCalls: number;
  /** Number of verification experiments actually used. */
  usedVerificationExperiments: number;
}

// ── Recon Results ──────────────────────────────────────────────────────────

export interface RepositoryRecon {
  readme: string | null;
  packageManager: string | null;
  language: string | null;
  framework: string | null;
  testScripts: string[];
  devScripts: string[];
  startScripts: string[];
  sourceDirectories: string[];
  configFiles: string[];
  packageJson: Record<string, unknown> | null;
  /** Error message if repository recon failed. */
  error?: string;
  /** Source of the error: 'git' (clone failed), 'sandbox' (connection/VM issue), or undefined. */
  errorSource?: string;
}

export interface InteractableElement {
  /** CSS selector to target this element (e.g. "a[href='#about']", "#contact-form input[name='email']") */
  selector: string;
  /** Visible text content */
  text: string;
  /** Element tag name */
  tag: string;
  /** href attribute if applicable */
  href?: string;
  /** name attribute for form inputs */
  name?: string;
  /** type attribute for inputs */
  type?: string;
  /** placeholder text for inputs */
  placeholder?: string;
  /** id attribute */
  id?: string;
  /** role attribute */
  role?: string;
  /** aria-label attribute */
  ariaLabel?: string;
  /** Class names (first 3 only, for context) */
  classes?: string[];
}

export interface ApplicationRecon {
  pageTitle: string;
  initialUrl: string;
  navigation: string[];
  forms: string[];
  buttons: string[];
  links: string[];
  screenshot: string; // base64 or path
  primaryWorkflow: string | null;
  /** Structured interactable elements with CSS selectors for the planner */
  interactableElements?: InteractableElement[];
}
