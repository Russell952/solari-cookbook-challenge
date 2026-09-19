/**
 * Rate limiting + resource-protection primitives.
 *
 * Probe's per-investigation budgets (budget.ts) bound the cost of ONE run;
 * this module bounds how many runs and requests the HTTP surface can create:
 *
 *  - general API rate limit (all /api requests)
 *  - stricter limits on investigation creation and start
 *  - a global cap on concurrently RUNNING investigations (Solari sessions
 *    and AI calls are the expensive resources)
 *  - SSE connection caps (globally and per investigation)
 *
 * Concurrency slots are accounted by the runner via tryAcquire/releaseSlot —
 * the release sits in a `finally` so cancelled/failed/expired/errored runs can
 * never leak a slot and wedge the deployment.
 */
import type { NextFunction, Request, Response } from "express";
import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { MemoryStore } from "express-rate-limit";
import { config } from "../config/index.js";

/**
 * Per-limiter MemoryStore instances. Production behavior is identical to the
 * library default (which also creates a MemoryStore internally), but holding
 * the references ourselves lets resetRateLimits() actually reach the stores —
 * express-rate-limit v8 closes over the store, so the middleware object
 * itself exposes no reset surface.
 */
const limiterStores: Store[] = [];
function newStore(): Store {
  const store = new MemoryStore();
  limiterStores.push(store);
  return store;
}

// ── HTTP rate limits ────────────────────────────────────────────────────────

const json429 = (_req: Request, res: Response): void => {
  res.status(429).json({ error: "Too many requests. Slow down and retry later." });
};

/** General API limiter — applied to every /api request after auth. */
export const generalLimiter = rateLimit({
  windowMs: config.rateLimit.general.windowMs,
  max: config.rateLimit.general.max,
  store: newStore(),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: json429,
  // Authenticated callers are already identified; keying by the (authed) IP
  // is fine for a single-tenant deployment and avoids trusting spoofable
  // forwarded headers in production. ipKeyGenerator normalizes IPv6 so a
  // /64 can't bypass the bucket with address rotation.
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
});

/** Strict limiter for investigation creation. */
export const createInvestigationLimiter = rateLimit({
  windowMs: config.rateLimit.createInvestigation.windowMs,
  max: config.rateLimit.createInvestigation.max,
  store: newStore(),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: json429,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
});

/** Strict limiter for investigation start (the expensive trigger). */
export const startInvestigationLimiter = rateLimit({
  windowMs: config.rateLimit.startInvestigation.windowMs,
  max: config.rateLimit.startInvestigation.max,
  store: newStore(),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: json429,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
});

/**
 * Signup + login limiter — one shared bucket so password guessing cannot
 * hide inside separate signup/login budgets.
 */
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  store: newStore(),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: json429,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
});

/** Test helper: reset all in-memory rate-limit buckets. */
export function resetRateLimits(): void {
  for (const store of limiterStores) {
    void store.resetAll?.();
  }
  resetInvestigationQuotas();
}

// ── Per-user investigation quotas ───────────────────────────────────────
//
// Free-tier protection: a single account must not be able to continuously
// create investigations and audit arbitrary websites. The per-IP window
// limiters above bound request-rate; these quotas bound RESOURCE CREATION
// per identity (rolling window counts), independently of IP.
//
// Enforced server-side on POST /investigations — direct API calls with a
// valid token go through exactly the same path as the UI, so there is no
// bypass. The existing generic API limiter is untouched.

/** One identity's rolling-window counters + timestamps. */
interface UserQuotaState {
  hourly: number[];
  daily: number[];
}

const userQuotas = new Map<string, UserQuotaState>();

function pruneOlderThan(timestamps: number[], windowMs: number, nowMs: number): number[] {
  const cutoff = nowMs - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;
  return i === 0 ? timestamps : timestamps.slice(i);
}

/** Check + consume one creation slot for `ownerId`. Returns the denial kind, or null. */
export function tryConsumeInvestigationQuota(ownerId: string): "hourly" | "daily" | null {
  const nowMs = Date.now();
  const state = userQuotas.get(ownerId) ?? { hourly: [], daily: [] };
  state.hourly = pruneOlderThan(state.hourly, 60 * 60_000, nowMs);
  state.daily = pruneOlderThan(state.daily, 24 * 60 * 60_000, nowMs);
  if (state.hourly.length >= config.rateLimit.createInvestigationPerUser.hourly) {
    return "hourly";
  }
  if (state.daily.length >= config.rateLimit.createInvestigationPerUser.daily) {
    return "daily";
  }
  state.hourly.push(nowMs);
  state.daily.push(nowMs);
  userQuotas.set(ownerId, state);
  return null;
}

/** Read-only current denial kind without consuming (diagnostics/tests). */
export function investigationQuotaDenial(ownerId: string): "hourly" | "daily" | null {
  const nowMs = Date.now();
  const state = userQuotas.get(ownerId);
  if (!state) return null;
  if (pruneOlderThan(state.hourly, 60 * 60_000, nowMs).length >=
      config.rateLimit.createInvestigationPerUser.hourly) return "hourly";
  if (pruneOlderThan(state.daily, 24 * 60 * 60_000, nowMs).length >=
      config.rateLimit.createInvestigationPerUser.daily) return "daily";
  return null;
}

/** ISO timestamp when the given quota window frees one slot (Retry-After hint). */
export function investigationQuotaRetryAt(ownerId: string, kind: "hourly" | "daily"): string {
  const nowMs = Date.now();
  const state = userQuotas.get(ownerId);
  const windowMs = kind === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
  const stamps = state ? pruneOlderThan(state[kind], windowMs, nowMs) : [];
  // The oldest still-counted hit is the first to fall out of the window.
  const oldest = stamps.length > 0 ? stamps[0] : nowMs;
  return new Date(oldest + windowMs).toISOString();
}

/** Test helper: clear per-user quota counters. */
export function resetInvestigationQuotas(): void {
  userQuotas.clear();
}

// ── Per-user concurrent investigation cap ────────────────────────────────

const runningPerUser = new Map<string, number>();

/**
 * Try to acquire one of `ownerId`'s concurrent investigation slots.
 * Call tryAcquireSlot() FIRST (deployment-wide is the coarser bound) and
 * this second; on per-user failure the global slot must be released.
 */
export function tryAcquireUserSlot(ownerId: string): boolean {
  const current = runningPerUser.get(ownerId) ?? 0;
  if (current >= config.maxConcurrentInvestigationsPerUser) return false;
  runningPerUser.set(ownerId, current + 1);
  return true;
}

/** Release a per-user slot. Must be called exactly once per acquired slot. */
export function releaseUserSlot(ownerId: string): void {
  const current = runningPerUser.get(ownerId) ?? 0;
  if (current <= 1) runningPerUser.delete(ownerId);
  else runningPerUser.set(ownerId, current - 1);
}

/** Test helper. */
export function resetUserConcurrency(): void {
  runningPerUser.clear();
}

// ── Concurrent investigation cap ────────────────────────────────────────────

let runningInvestigations = 0;

/**
 * Try to acquire a concurrency slot for a new running investigation.
 * Returns false when the deployment is at its configured cap.
 */
export function tryAcquireSlot(): boolean {
  if (runningInvestigations >= config.maxConcurrentInvestigations) return false;
  runningInvestigations++;
  return true;
}

/** Release a concurrency slot. Safe to call multiple times idempotently via slot token. */
export function releaseSlot(): void {
  if (runningInvestigations > 0) runningInvestigations--;
}

/** Current number of running investigations (diagnostics/tests). */
export function runningCount(): number {
  return runningInvestigations;
}

/** Test helper: reset the counter (each slot should already have been released). */
export function resetConcurrency(): void {
  runningInvestigations = 0;
}

// ── SSE connection caps ─────────────────────────────────────────────────────

let globalSseConnections = 0;
const ssePerInvestigation = new Map<string, number>();

/** Reserve an SSE slot; returns false when over a cap. */
export function tryAcquireSse(investigationId: string): boolean {
  const per = ssePerInvestigation.get(investigationId) ?? 0;
  if (globalSseConnections >= config.maxSseConnections) return false;
  if (per >= config.maxSsePerInvestigation) return false;
  globalSseConnections++;
  ssePerInvestigation.set(investigationId, per + 1);
  return true;
}

/** Release an SSE slot. Call exactly once per successful tryAcquireSse. */
export function releaseSse(investigationId: string): void {
  if (globalSseConnections > 0) globalSseConnections--;
  const per = ssePerInvestigation.get(investigationId) ?? 0;
  if (per <= 1) ssePerInvestigation.delete(investigationId);
  else ssePerInvestigation.set(investigationId, per - 1);
}

/** Test helper. */
export function resetSse(): void {
  globalSseConnections = 0;
  ssePerInvestigation.clear();
}
