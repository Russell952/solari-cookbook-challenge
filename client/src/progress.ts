/**
 * Investigation progress model.
 *
 * Pure functions that derive the presentation progress state from the actual
 * backend summary (the investigation state machine is the single source of
 * truth — nothing here invents progress, counts, or percentages).
 */
import type {
  InvestigationSummary,
  InvestigationPhase,
  InvestigationStatus,
} from "./api";

/** Human-readable SSE event label — shared by the progress activity feed. */
export function formatEventType(type: string): string {
  const labels: Record<string, string> = {
    connected: "Connected",
    phase_change: "Phase",
    experiment_started: "Experiment started",
    experiment_completed: "Experiment done",
    action_started: "Action",
    action_completed: "Action done",
    observation_recorded: "Observation",
    hypothesis_proposed: "Hypothesis",
    hypothesis_updated: "Hypothesis updated",
    finding_created: "Finding",
    error: "Error",
    complete: "Complete",
  };
  return labels[type] || type;
}
/**
 * Failure reasons that are a graceful stop at a budget boundary, NOT an
 * execution error: the pipeline detected the limit itself, produced a
 * structured report from the work that DID complete, and terminalized
 * honestly. A budget-exhausted run with a persisted report must never be
 * presented as "ended before a report could be produced" (live regression:
 * inv_1789470483431_1bpnr8 finished 4/5 experiments + 49 evidence + a
 * persisted fallback report at the 10-minute boundary, but the UI claimed
 * an infrastructure failure and hid the report).
 */
const BUDGET_EXHAUSTION_REASONS = new Set([
  "runtime_expired",
  "ai_call_budget_exhausted",
  "ai_token_budget_exhausted",
  "analysis_budget_exhausted",
]);

/** True when a failed investigation actually stopped gracefully at a budget boundary. */
export function isBudgetExhaustionStop(summary: InvestigationSummary): boolean {
  return (
    summary.investigation.status === "failed" &&
    summary.failure != null &&
    BUDGET_EXHAUSTION_REASONS.has(summary.failure.reason)
  );
}

/** A major presentation stage, mapped 1:1 onto the backend phase machine. */
export interface ProgressStage {
  /** Backend phase key driving this stage (source of truth). */
  phase: InvestigationPhase;
  /** Human presentation label — never a raw internal state name. */
  label: string;
}

/**
 * The ordered investigation lifecycle. `experiment` and `execute` are distinct
 * backend phases (designing vs. running), as are `observe`/`analyze`/`hypothesis`.
 *
 * `created` (pre-recon) and the post-verification outcome phases
 * (`confirmed`/`rejected`/`inconclusive` — real backend phases the state
 * machine passes through on the way to `report`) map onto their neighboring
 * presentation stage via PHASE_TO_STAGE below, so the stepper always has a
 * current stage no matter which backend phase is live.
 */
export const PROGRESS_STAGES: ProgressStage[] = [
  { phase: "recon", label: "Understanding the target" },
  { phase: "plan", label: "Designing experiments" },
  { phase: "experiment", label: "Preparing experiments" },
  { phase: "execute", label: "Running experiments" },
  { phase: "observe", label: "Capturing evidence" },
  { phase: "analyze", label: "Evaluating observations" },
  { phase: "hypothesis", label: "Testing hypotheses" },
  { phase: "verification", label: "Verifying results" },
  { phase: "report", label: "Preparing report" },
  { phase: "complete", label: "Investigation complete" },
];

/**
 * Backend phases that are not stepper rows of their own, mapped to the row
 * that represents them. Everything not listed maps to itself. Source:
 * shared/src/states.ts VALID_PHASE_TRANSITIONS — kept in sync by test.
 */
const PHASE_TO_STAGE: Record<InvestigationPhase, ProgressStage["phase"]> = {
  created: "recon",          // pre-recon: nothing collected yet
  recon: "recon",
  plan: "plan",
  experiment: "experiment",
  execute: "execute",
  observe: "observe",
  analyze: "analyze",
  hypothesis: "hypothesis",
  verification: "verification",
  confirmed: "report",       // outcome phases sit between verification and report
  rejected: "report",
  inconclusive: "report",
  report: "report",
  complete: "complete",
};

/** The stepper row a backend phase is presented by. */
export function stagePhaseFor(phase: InvestigationPhase): ProgressStage["phase"] {
  return PHASE_TO_STAGE[phase] ?? phase;
}

export type StageState = "completed" | "current" | "pending" | "failed" | "cancelled";

export interface StageViewState extends ProgressStage {
  state: StageState;
}

/**
 * Per-stage visual state derived from the REAL status + current phase.
 *
 * Terminal status semantics:
 *  - failed:    stages before the failure point completed, stage at/after the
 *               current phase failed (execution error, not an app finding)
 *  - cancelled: stages before the cancel point completed; the rest is neither
 *               success nor failure — cancelled, pending
 *  - completed: everything up to `complete` completed
 */
export function stageStates(
  status: InvestigationStatus,
  currentPhase: InvestigationPhase
): StageViewState[] {
  const currentIdx = PROGRESS_STAGES.findIndex((s) => s.phase === stagePhaseFor(currentPhase));
  return PROGRESS_STAGES.map((stage, i) => {
    let state: StageState;
    if (status === "completed") {
      state = "completed";
    } else if (status === "failed") {
      state = i < currentIdx ? "completed" : i === currentIdx ? "failed" : "pending";
    } else if (status === "cancelled") {
      state = i < currentIdx ? "completed" : i === currentIdx ? "cancelled" : "pending";
    } else if (i < currentIdx) {
      state = "completed";
    } else if (i === currentIdx) {
      state = "current";
    } else {
      state = "pending";
    }
    return { ...stage, state };
  });
}

/** Generic, truthful phase-level description (used when no richer data exists). */
const PHASE_ACTIVITY: Record<string, string> = {
  recon: "Reviewing the application and its documentation…",
  plan: "Designing experiments to test the objective…",
  experiment: "Preparing experiments…",
  execute: "Executing the current experiment…",
  observe: "Capturing screenshots, traces, and artifacts…",
  analyze: "Evaluating the collected observations…",
  hypothesis: "Assessing whether observations support the hypothesis…",
  verification: "Running verification experiments…",
  report: "Synthesizing the verified results…",
  complete: "Investigation complete.",
};

export interface EvidenceBreakdown {
  type: string;
  count: number;
}

export interface ProgressModel {
  /** Ordered stages with their visual state. */
  stages: StageViewState[];
  /** Presentation label of the stage Probe is actually in. */
  stageLabel: string;
  /** Truthful one-line description of current activity. */
  activity: string;
  /** True when the current experiment objective is known and shown. */
  hasCurrentExperiment: boolean;
  /** Current (in-flight) experiment objective — real data, never invented. */
  currentExperimentObjective: string | null;
  /** "3 of 6" for the running experiment, when known. */
  currentExperimentPosition: string | null;
  /** Real counters derived from the summary. */
  metrics: Array<{ label: string; value: string }>;
  /** Evidence type counts that actually exist (only non-zero types). */
  evidenceBreakdown: EvidenceBreakdown[];
  /** Experiment checklist (objective + real status), for experiment-level view. */
  experimentList: Array<{
    sequence: number;
    objective: string;
    state: "completed" | "failed" | "inconclusive" | "running" | "pending";
  }>;
  /** Whether the investigation is still running (show live indicator). */
  isRunning: boolean;
  /** Terminal status, if any. */
  terminal: "completed" | "failed" | "cancelled" | null;
  /** Formatted runtime (mm:ss), when known. */
  runtime: string | null;
  /**
   * True when zero experiments were planned/persisted (planning produced an
   * empty plan). The UI must render an explicit honest state — never a
   * normal-looking 0/0 — and the Experiments metric is withheld.
   */
  noExperimentsPlanned: boolean;
  /** Report-generation context lines (report phase, real data only). */
  reportContext: string[];
  /** Hypothesis outcome counts for honest result communication. */
  hypothesisOutcomes: { confirmed: number; rejected: number; inconclusive: number; other: number };
  /**
   * True when the failed run actually stopped gracefully at a runtime/budget
   * boundary (failure.reason in BUDGET_EXHAUSTION_REASONS). Such a run has a
   * persisted structured report and must NEVER be presented as "ended before
   * a report could be produced".
   */
  budgetExhaustionStop: boolean;
}

function formatRuntime(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Derives the full progress model from a real summary. No synthetic numbers:
 * counts come straight from experimentCounts/evidence/hypotheses, and there is
 * deliberately no percentage anywhere.
 *
 * `now` is the wall-clock instant the model is derived for. The running
 * runtime is always `now - startedAt` (never accumulated) — callers tick
 * `now` roughly once a second so the runtime counter advances every second
 * independently of SSE events (regression: the timer only updated when an
 * SSE event happened to trigger a re-render, so it jumped in ~2-3 min steps).
 */
export function buildProgressModel(
  summary: InvestigationSummary,
  now: number = Date.now()
): ProgressModel {
  const inv = summary.investigation;
  const status = inv.status;
  const phase = inv.currentPhase;
  const stages = stageStates(status, phase);
  const stageLabel =
    stages.find((s) => s.state === "current" || s.state === "failed" || s.state === "cancelled")
      ?.label ?? stages[stages.length - 1].label;

  const terminal =
    status === "completed" || status === "failed" || status === "cancelled"
      ? status
      : null;
  const isRunning = status === "running";

  // Current experiment: the actually-running one, else the next pending one.
  const runningExp = summary.experiments.find((e) => e.status === "running");
  const focusExp =
    runningExp ?? (phase === "experiment" || phase === "execute"
      ? summary.experiments.find((e) => e.status === "planned")
      : undefined);
  const doneBeforeFocus = focusExp
    ? summary.experiments.filter((e) => e.sequence < focusExp.sequence && e.status === "completed").length
    : 0;
  const currentExperimentObjective = focusExp?.objective ?? null;
  const currentExperimentPosition =
    focusExp && summary.experiments.length > 0
      ? `${doneBeforeFocus + 1} of ${summary.experiments.length}`
      : null;

  // Evidence breakdown — only types that actually exist in the data.
  const byType = new Map<string, number>();
  for (const ev of summary.evidence) {
    byType.set(ev.type, (byType.get(ev.type) ?? 0) + 1);
  }
  const evidenceBreakdown = [...byType.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  // Experiment checklist with honest per-item states.
  const experimentList = summary.experiments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => ({
      sequence: e.sequence,
      objective: e.objective,
      state: (["completed", "failed", "inconclusive", "running"].includes(e.status)
        ? e.status
        : "pending") as "completed" | "failed" | "inconclusive" | "running" | "pending",
    }));

  // Hypothesis outcomes — an inconclusive hypothesis is a legitimate result,
  // never a failure.
  const hypothesisOutcomes = { confirmed: 0, rejected: 0, inconclusive: 0, other: 0 };
  for (const h of summary.hypotheses) {
    if (h.status === "confirmed") hypothesisOutcomes.confirmed += 1;
    else if (h.status === "rejected") hypothesisOutcomes.rejected += 1;
    else if (h.status === "inconclusive") hypothesisOutcomes.inconclusive += 1;
    else hypothesisOutcomes.other += 1;
  }

  // Experiment counter — X/Y where Y is the number of experiments actually
  // planned/persisted and X the number that reached a terminal execution
  // state (completed/failed/inconclusive/cancelled). Recon evidence and
  // hypotheses are never counted. With zero planned experiments the metric
  // is withheld entirely and the model reports `noExperimentsPlanned`, so a
  // planning failure can never render as a normal-looking 0/0.
  const terminalExpStatuses = ["completed", "failed", "inconclusive", "cancelled"];
  const experimentsTerminal = summary.experiments.filter((e) =>
    terminalExpStatuses.includes(e.status)
  ).length;
  // ── Planning-state semantics ───────────────────────────────────────────
  // `noExperimentsPlanned` is true ONLY when the backend has explicitly
  // reported a COMPLETED planning outcome of zero executable experiments
  // (investigation.planningOutcome === "no_executable_experiments"). The
  // summary's experiments array is legitimately empty during the whole PLAN
  // phase — deriving a terminal message from that emptiness presented a
  // final planning verdict while planning was still active (live bug: the
  // no-experiments warning rendered alongside "Designing experiments —
  // current stage"). Empty experiments during active planning is NOT a
  // planning result.
  const planningOutcome = summary.investigation.planningOutcome ?? null;
  const noExperimentsPlanned = planningOutcome === "no_executable_experiments";
  const metrics: Array<{ label: string; value: string }> = [];
  if (!noExperimentsPlanned) {
    metrics.push({
      label: "Experiments",
      value: `${experimentsTerminal}/${summary.experimentCounts.total}`,
    });
  }
  metrics.push(
    { label: "Evidence", value: String(summary.evidenceCount) },
    { label: "Hypotheses", value: String(summary.hypothesesCount) },
    { label: "Findings", value: String(summary.findingsCount) }
  );

  // Runtime: while running, ALWAYS derive from startedAt with the live tick
  // (the server's durationMs while running is a stale fetch-time snapshot —
  // regression: the timer only moved when the summary was refetched, e.g.
  // 01:54 shown for a run that had been going for minutes). durationMs is
  // used only once the investigation is terminal, then frozen.
  const runtimeMs =
    isRunning && summary.runtime?.startedAt
      ? Math.max(0, now - new Date(summary.runtime.startedAt).getTime())
      : !isRunning && summary.runtime?.durationMs != null
        ? summary.runtime.durationMs
        : null;
  const runtime = runtimeMs != null ? formatRuntime(runtimeMs) : null;
  if (runtime) metrics.push({ label: "Runtime", value: runtime });

  // Report-phase context — only claims backed by data.
  const reportContext: string[] = [];
  if (phase === "report" && !terminal) {
    reportContext.push("Experiments complete");
    if (summary.evidenceCount > 0) reportContext.push("Evidence collected");
    if (hypothesisOutcomes.confirmed > 0) reportContext.push("Hypotheses confirmed");
    if (hypothesisOutcomes.rejected > 0) reportContext.push("Hypotheses rejected");
    if (hypothesisOutcomes.inconclusive > 0) reportContext.push("Hypotheses inconclusive");
  }

  // Activity line: phase-level description, enriched only with real facts.
  let activity: string;
  if (noExperimentsPlanned && summary.failure?.reason === "no_executable_experiments") {
    activity =
      "No executable experiments were produced — the application behavior was not tested.";
  } else if (isBudgetExhaustionStop(summary)) {
    // Graceful stop at the budget boundary — the pipeline completed the
    // experiments it could, produced a structured report from that work,
    // and terminalized honestly. Never call this an execution error.
    activity =
      "Stopped at the runtime/budget limit after the experiments it could run — a structured report from that work is below.";
  } else if (
    status === "failed" &&
    /AI API (response read )?timeout/i.test(summary.failure?.message ?? "")
  ) {
    // AI provider timeout: the model provider accepted the request but the
    // response never completed within the per-call deadline. This is an
    // infrastructure failure — not a budget stop, not an application bug.
    activity =
      "Stopped early: the AI provider did not complete its response in time. No findings can be drawn from this run.";
  } else if (status === "failed") {
    activity = "The investigation ended with an execution error.";
  } else if (status === "cancelled") {
    activity = "This investigation was cancelled before completion.";
  } else if (status === "completed") {
    activity = "Investigation complete.";
  } else if (runningExp) {
    activity = PHASE_ACTIVITY[phase] ?? "Working…";
  } else {
    activity = PHASE_ACTIVITY[phase] ?? "Working…";
  }

  return {
    stages,
    stageLabel,
    activity,
    hasCurrentExperiment: currentExperimentObjective != null,
    currentExperimentObjective,
    currentExperimentPosition,
    metrics,
    evidenceBreakdown,
    experimentList,
    isRunning,
    terminal,
    runtime,
    noExperimentsPlanned,
    reportContext,
    hypothesisOutcomes,
    budgetExhaustionStop: isBudgetExhaustionStop(summary),
  };
}
