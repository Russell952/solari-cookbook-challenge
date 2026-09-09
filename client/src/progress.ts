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
  const currentIdx = PROGRESS_STAGES.findIndex((s) => s.phase === currentPhase);
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
  /** Report-generation context lines (report phase, real data only). */
  reportContext: string[];
  /** Hypothesis outcome counts for honest result communication. */
  hypothesisOutcomes: { confirmed: number; rejected: number; inconclusive: number; other: number };
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
 */
export function buildProgressModel(summary: InvestigationSummary): ProgressModel {
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

  // Metrics — real data only; Report presence is factual (available/none).
  const metrics: Array<{ label: string; value: string }> = [
    {
      label: "Experiments",
      value: `${summary.experimentCounts.completed}/${summary.experimentCounts.total}`,
    },
    { label: "Evidence", value: String(summary.evidenceCount) },
    { label: "Hypotheses", value: String(summary.hypothesesCount) },
    { label: "Findings", value: String(summary.findingsCount) },
  ];
  const runtimeMs =
    summary.runtime?.durationMs != null
      ? summary.runtime.durationMs
      : isRunning && summary.runtime?.startedAt
        ? Date.now() - new Date(summary.runtime.startedAt).getTime()
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
  if (status === "failed") {
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
    reportContext,
    hypothesisOutcomes,
  };
}
