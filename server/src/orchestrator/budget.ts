/**
 * Budget manager.
 *
 * Enforces SEPARATE resource limits — wall-clock runtime, AI calls, AI
 * tokens, experiments, browser actions, sandbox commands — with a
 * verification reserve for experiments. The AI cannot override these.
 *
 * Budget architecture:
 *   total experiments = primary experiments + verification reserve
 *   primary experiments <= maxExperiments - verificationReserve
 *   verification experiments <= verificationReserve
 *   total actions = global (shared by primary and verification)
 *   AI calls and AI tokens are independent budgets: a few huge model
 *   requests exhaust the token budget even when call count remains, and
 *   vice versa.
 *
 * Wall-clock runtime is monotonic: derived from a started-at timestamp (the
 * runtime clock), never accumulated (double-counting once expired runs at
 * ~half the configured budget). Phase budgets are separate ceilings per
 * phase so no phase can silently consume the entire investigation.
 */
import type { Budget, InvestigationPhase } from "@probe/shared";
import { config } from "../config/index.js";

const DEFAULT_BUDGET: Budget = {
  maxExperiments: config.maxExperiments,
  maxBrowserActions: config.maxBrowserActions,
  maxSandboxCommands: config.maxSandboxCommands,
  maxRuntimeMs: config.maxRuntimeMs,
  maxAiCalls: config.maxAiCalls,
  maxAiTokens: config.maxAiTokens,
  verificationReserve: 2,
  usedExperiments: 0,
  usedBrowserActions: 0,
  usedSandboxCommands: 0,
  usedRuntime: 0,
  usedAiCalls: 0,
  usedAiTokens: 0,
  usedVerificationExperiments: 0,
};

const budgets = new Map<string, Budget>();

export function getBudget(investigationId: string): Budget {
  const b = budgets.get(investigationId);
  return b ? { ...b } : { ...DEFAULT_BUDGET };
}

export function initBudget(investigationId: string, overrides?: Partial<Budget>): Budget {
  const budget: Budget = { ...DEFAULT_BUDGET, ...overrides };
  budgets.set(investigationId, budget);
  return budget;
}

/**
 * Get the number of experiments available for primary (non-verification) planning.
 * This is maxExperiments - verificationReserve.
 */
export function getPrimaryExperimentBudget(investigationId: string): number {
  const b = getBudget(investigationId);
  return Math.max(0, b.maxExperiments - b.verificationReserve);
}

/**
 * Get the number of verification experiments still available.
 */
export function getVerificationBudget(investigationId: string): number {
  const b = getBudget(investigationId);
  return Math.max(0, b.verificationReserve - b.usedVerificationExperiments);
}

/**
 * Check if a primary experiment can be consumed.
 * Primary experiments cannot use the verification reserve.
 */
export function canConsumePrimary(investigationId: string): boolean {
  const b = getBudget(investigationId);
  const primaryBudget = getPrimaryExperimentBudget(investigationId);
  // Count primary experiments = total used - verification used
  const primaryUsed = b.usedExperiments - b.usedVerificationExperiments;
  return primaryUsed < primaryBudget;
}

/**
 * Check if a verification experiment can be consumed.
 * Verification can use the reserved capacity.
 */
export function canConsumeVerification(investigationId: string): boolean {
  const b = getBudget(investigationId);
  return b.usedVerificationExperiments < b.verificationReserve;
}

export type BudgetResource =
  | "experiments"
  | "browserActions"
  | "sandboxCommands"
  | "aiCalls";

export function canConsume(investigationId: string, resource: BudgetResource): boolean {
  const b = getBudget(investigationId);
  switch (resource) {
    case "experiments":
      return b.usedExperiments < b.maxExperiments;
    case "browserActions":
      return b.usedBrowserActions < b.maxBrowserActions;
    case "sandboxCommands":
      return b.usedSandboxCommands < b.maxSandboxCommands;
    case "aiCalls":
      return b.usedAiCalls < b.maxAiCalls;
  }
}

/**
 * Consume a primary experiment slot.
 */
export function consumePrimary(investigationId: string): Budget {
  const b = getBudget(investigationId);
  b.usedExperiments++;
  budgets.set(investigationId, b);
  return { ...b };
}

/**
 * Consume a verification experiment slot.
 */
export function consumeVerification(investigationId: string): Budget {
  const b = getBudget(investigationId);
  b.usedExperiments++;
  b.usedVerificationExperiments++;
  budgets.set(investigationId, b);
  return { ...b };
}

export function consume(investigationId: string, resource: BudgetResource): Budget {
  const b = getBudget(investigationId);
  switch (resource) {
    case "experiments":
      b.usedExperiments++;
      break;
    case "browserActions":
      b.usedBrowserActions++;
      break;
    case "sandboxCommands":
      b.usedSandboxCommands++;
      break;
    case "aiCalls":
      b.usedAiCalls++;
      break;
  }
  budgets.set(investigationId, b);
  return { ...b };
}

// ── AI token budget (separate from call count) ───────────────────────────

/** True when more estimated AI input tokens can still be charged. */
export function canConsumeAiTokens(investigationId: string, estimatedTokens: number): boolean {
  const b = getBudget(investigationId);
  return b.usedAiTokens + Math.max(0, estimatedTokens) <= b.maxAiTokens;
}

/** Charge actual estimated AI input tokens after a model request. */
export function consumeAiTokens(investigationId: string, tokens: number): Budget {
  const b = getBudget(investigationId);
  b.usedAiTokens += Math.max(0, tokens);
  budgets.set(investigationId, b);
  return { ...b };
}

/** Remaining AI token budget (estimated input tokens). */
export function remainingAiTokens(investigationId: string): number {
  const b = getBudget(investigationId);
  return Math.max(0, b.maxAiTokens - b.usedAiTokens);
}

// ── Runtime (monotonic clock) ─────────────────────────────────────────────

/**
 * Get remaining wall-clock runtime in ms, computed from the started-at
 * timestamp — the single source of truth. Elapsed time is never accumulated
 * into a counter (double-counting made `isExpired()` true at ~half the
 * configured budget in a previous regression).
 */
export function remainingRuntime(investigationId: string): number {
  const b = getBudget(investigationId);
  const startedAt = startedAtMs.get(investigationId);
  if (startedAt === undefined) return b.maxRuntimeMs; // not started yet
  return Math.max(0, b.maxRuntimeMs - (Date.now() - startedAt));
}

/** Started-at timestamps per investigation, set by startRuntimeClock(). */
const startedAtMs = new Map<string, number>();

/** Begin wall-clock accounting (called once when the runner starts).
 * `origin` lets tests (and future resume flows) pin the start timestamp. */
export function startRuntimeClock(investigationId: string, origin?: number): void {
  startedAtMs.set(investigationId, origin ?? Date.now());
}

export function stopRuntimeClock(investigationId: string): void {
  startedAtMs.delete(investigationId);
}

/** True when a runtime clock is already ticking for this investigation. */
export function isRuntimeClockRunning(investigationId: string): boolean {
  return startedAtMs.has(investigationId);
}

/** The wall-clock origin timestamp of the runtime clock (undefined if not running). */
export function runtimeStartedAtOf(investigationId: string): number | undefined {
  return startedAtMs.get(investigationId);
}

export function isExpired(investigationId: string): boolean {
  return remainingRuntime(investigationId) <= 0;
}

// ── Phase budgets ────────────────────────────────────────────────────────

/**
 * Wall-clock ceilings per phase (ms). Tuned so no single phase can silently
 * consume the whole investigation while later phases starve. Values are
 * conservative defaults based on observed phase durations; all are
 * proportions of the total runtime budget, re-derived at run start.
 *
 *   recon      ≤ 30%   (clone + first navigation are the slow parts)
 *   plan       ≤ 20%   (one AI call)
 *   experiment ≤ 55%   (dominant: browser actions per experiment)
 *   execute    ≤ 55%   (same window as experiment — the runner treats
 *                       experiment/execute as one work block)
 *   observe    ≤ 5%    (bookkeeping)
 *   analyze    ≤ 25%   (per-experiment AI analysis)
 *   hypothesis ≤ 15%
 *   verification ≤ 30%
 *   report     ≤ 15%   (one AI call + fallback path is local)
 */
const PHASE_BUDGET_FRACTIONS: Partial<Record<InvestigationPhase, number>> = {
  recon: 0.3,
  plan: 0.2,
  experiment: 0.55,
  execute: 0.55,
  observe: 0.05,
  analyze: 0.25,
  hypothesis: 0.15,
  verification: 0.3,
  report: 0.15,
};

/** Phase wall-clock deadline in ms for an investigation budget. */
export function phaseBudgetMs(investigationId: string, phase: InvestigationPhase): number {
  const fraction = PHASE_BUDGET_FRACTIONS[phase] ?? 0.5;
  return Math.max(5_000, Math.floor(getBudget(investigationId).maxRuntimeMs * fraction));
}

/**
 * A phase exceeds its own budget when BOTH its phase deadline and the
 * investigation deadline are past — the investigation deadline is the hard
 * authority; phase deadlines only trigger the graceful phase-exhaustion
 * transition (never a crash).
 */
export function isPhaseBudgetExhausted(
  investigationId: string,
  phase: InvestigationPhase,
  phaseStartedAt: number
): boolean {
  const elapsed = Date.now() - phaseStartedAt;
  return elapsed >= phaseBudgetMs(investigationId, phase) || isExpired(investigationId);
}

export function resetBudget(investigationId: string): void {
  budgets.delete(investigationId);
  startedAtMs.delete(investigationId);
  phaseStarts.delete(investigationId);
}

// ── Usage snapshot / hydration (checkpoint durability) ───────────────────

/**
 * Restore checkpointed usage (resume/retry). Runtime restarts from the
 * persisted monotonic origin so a resumed investigation neither gets a
 * fresh wall-clock budget nor double-counts elapsed time.
 */
export function restoreUsage(
  investigationId: string,
  usage: {
    usedExperiments: number;
    usedBrowserActions: number;
    usedSandboxCommands: number;
    usedAiCalls: number;
    usedAiTokens: number;
    usedVerificationExperiments: number;
    runtimeStartedAt: string | null;
  }
): void {
  const b = getBudget(investigationId);
  b.usedExperiments = Math.max(0, usage.usedExperiments || 0);
  b.usedBrowserActions = Math.max(0, usage.usedBrowserActions || 0);
  b.usedSandboxCommands = Math.max(0, usage.usedSandboxCommands || 0);
  b.usedAiCalls = Math.max(0, usage.usedAiCalls || 0);
  b.usedAiTokens = Math.max(0, usage.usedAiTokens || 0);
  b.usedVerificationExperiments = Math.max(0, usage.usedVerificationExperiments || 0);
  budgets.set(investigationId, b);
  if (usage.runtimeStartedAt) {
    const origin = new Date(usage.runtimeStartedAt).getTime();
    if (Number.isFinite(origin)) startRuntimeClock(investigationId, origin);
  }
}

/** Serializable budget usage for checkpoints. */
export interface BudgetUsageSnapshot {
  usedExperiments: number;
  usedBrowserActions: number;
  usedSandboxCommands: number;
  usedAiCalls: number;
  usedAiTokens: number;
  usedVerificationExperiments: number;
  runtimeStartedAt: string | null;
}

export function snapshotUsage(investigationId: string): BudgetUsageSnapshot {
  const b = getBudget(investigationId);
  const startedAt = startedAtMs.get(investigationId);
  return {
    usedExperiments: b.usedExperiments,
    usedBrowserActions: b.usedBrowserActions,
    usedSandboxCommands: b.usedSandboxCommands,
    usedAiCalls: b.usedAiCalls,
    usedAiTokens: b.usedAiTokens,
    usedVerificationExperiments: b.usedVerificationExperiments,
    runtimeStartedAt: startedAt !== undefined ? new Date(startedAt).toISOString() : null,
  };
}

/** Phase-start timestamps (for phase-budget checks). */
const phaseStarts = new Map<string, number>();

export function markPhaseStart(investigationId: string, origin?: number): void {
  phaseStarts.set(investigationId, origin ?? Date.now());
}

export function phaseStartedAt(investigationId: string): number | undefined {
  return phaseStarts.get(investigationId);
}

export function clearPhaseStart(investigationId: string): void {
  phaseStarts.delete(investigationId);
}
