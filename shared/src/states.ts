import type { InvestigationPhase, InvestigationStatus } from "./types";

// ── Phase transitions ──────────────────────────────────────────────────────
// Which phases can follow which. The orchestrator enforces these.

export const VALID_PHASE_TRANSITIONS: Record<InvestigationPhase, InvestigationPhase[]> = {
  created:        ["recon"],
  recon:           ["plan"],
  plan:            ["experiment"],
  experiment:      ["execute"],
  execute:         ["observe"],
  observe:         ["analyze"],
  analyze:         ["hypothesis", "experiment", "report"],
  hypothesis:      ["verification", "experiment", "report"],
  verification:    ["confirmed", "rejected", "inconclusive"],
  confirmed:       ["experiment", "report"],
  rejected:        ["experiment", "report"],
  inconclusive:    ["experiment", "report"],
  report:          ["complete"],
  complete:        [],
};

export function isValidPhaseTransition(from: InvestigationPhase, to: InvestigationPhase): boolean {
  return VALID_PHASE_TRANSITIONS[from].includes(to);
}

// ── Status transitions ─────────────────────────────────────────────────────

export const VALID_STATUS_TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]> = {
  created:   ["running", "cancelled"],
  running:   ["paused", "cancelled", "completed", "failed"],
  paused:    ["running", "cancelled"],
  cancelled: [],
  completed: [],
  failed:    ["running"],
};

export function isValidStatusTransition(from: InvestigationStatus, to: InvestigationStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from].includes(to);
}

// ── Phase sequencing ───────────────────────────────────────────────────────
// The ordered pipeline for a typical investigation run.

export const PHASE_SEQUENCE: InvestigationPhase[] = [
  "recon",
  "plan",
  "experiment",
  "execute",
  "observe",
  "analyze",
  "hypothesis",
  "verification",
  "report",
  "complete",
];

export function nextPhase(current: InvestigationPhase): InvestigationPhase | null {
  const idx = PHASE_SEQUENCE.indexOf(current);
  if (idx === -1 || idx >= PHASE_SEQUENCE.length - 1) return null;
  return PHASE_SEQUENCE[idx + 1];
}

// ── Transition enforcement ────────────────────────────────────────────────
// These throw on invalid transitions. The orchestrator MUST call them
// before updating the store — they are the single source of truth for
// whether a state change is allowed.

export class InvalidTransitionError extends Error {
  constructor(
    public readonly kind: "phase" | "status",
    public readonly from: string,
    public readonly to: string
  ) {
    super(`Invalid ${kind} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Validate a phase transition. Returns `to` if valid, throws otherwise.
 */
export function transitionPhase<To extends InvestigationPhase>(
  from: InvestigationPhase,
  to: To
): To {
  if (!isValidPhaseTransition(from, to)) {
    throw new InvalidTransitionError("phase", from, to);
  }
  return to;
}

/**
 * Validate a status transition. Returns `to` if valid, throws otherwise.
 */
export function transitionStatus<To extends InvestigationStatus>(
  from: InvestigationStatus,
  to: To
): To {
  if (!isValidStatusTransition(from, to)) {
    throw new InvalidTransitionError("status", from, to);
  }
  return to;
}
