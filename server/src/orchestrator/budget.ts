/**
 * Budget manager.
 *
 * Enforces resource limits with a verification reserve.
 * The AI cannot override these.
 * If budget is exhausted, the investigation goes INCONCLUSIVE.
 *
 * Budget architecture:
 *   total experiments = primary experiments + verification reserve
 *   primary experiments <= maxExperiments - verificationReserve
 *   verification experiments <= verificationReserve
 *   total actions = global (shared by primary and verification)
 */
import type { Budget } from "@probe/shared";

const DEFAULT_BUDGET: Budget = {
  maxExperiments: 7,
  maxBrowserActions: 40,
  maxSandboxCommands: 20,
  maxRuntimeMs: 10 * 60 * 1000, // 10 minutes
  maxAiCalls: 20,
  verificationReserve: 2,
  usedExperiments: 0,
  usedBrowserActions: 0,
  usedSandboxCommands: 0,
  usedRuntime: 0,
  usedAiCalls: 0,
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

export function canConsume(
  investigationId: string,
  resource: "experiments" | "browserActions" | "sandboxCommands" | "aiCalls"
): boolean {
  const b = getBudget(investigationId);
  switch (resource) {
    case "experiments":
      // For backward compat: check total budget
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

export function consume(
  investigationId: string,
  resource: "experiments" | "browserActions" | "sandboxCommands" | "aiCalls"
): Budget {
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

/**
 * Get remaining wall-clock runtime in ms, computed from the started-at
 * timestamp — the single source of truth. Elapsed time is never accumulated
 * into a counter (double-counting made `isExpired()` true at ~half the
 * configured budget: a 1s interval ticked elapsed time while a runner finally
 * block ALSO added Date.now() - startTime).
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

export function isExpired(investigationId: string): boolean {
  return remainingRuntime(investigationId) <= 0;
}

export function resetBudget(investigationId: string): void {
  budgets.delete(investigationId);
  startedAtMs.delete(investigationId);
}
