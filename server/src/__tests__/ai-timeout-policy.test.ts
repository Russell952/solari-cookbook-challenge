/**
 * AI timeout policy regression tests.
 *
 * The recurring production failure "AI API response read timeout after
 * 90000ms (bounded by investigation deadline)" had two real problems:
 *
 *  1. MISCLASSIFICATION — the configured per-call ceiling
 *     (PROBE_AI_CALL_TIMEOUT_MS, default 90s) produced that message even
 *     when the investigation had many minutes of runtime left. The "(bounded
 *     by investigation deadline)" suffix was a guess, not a fact.
 *  2. DOUBLE-DIP — the header phase and the body-read phase each armed the
 *     full per-call ceiling independently, so one call could spend 2× the
 *     ceiling (headers 90s + body 90s) inside a single attempt.
 *
 * The policy under test:
 *   effective per-call budget = min(configured ceiling, remaining runtime −
 *   terminalization headroom), shared by headers and body; the body budget
 *   deducts the time already spent reaching headers; timeouts report the
 *   actually-binding bound; budgets are never bypassed by retries.
 *
 * The provider boundary is stubbed with `fetch` — the real adapter runs.
 */
/** @vitest-environment node */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createOpenAIAdapter, setAiBudgetGuards, AiBudgetExhaustedError } from "../ai/openai.js";

const REAL_FETCH = globalThis.fetch;

function completionBody(content = "ok"): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

/** Structurally valid plan JSON — the adapter validates responses, so a
 * successful path needs a real plan payload. */
const PLAN_JSON = JSON.stringify({
  experiments: [
    {
      objective: "Verify the page loads",
      preconditions: [],
      plannedActions: [{ tool: "browser", action: "getTitle", target: "page" }],
    },
  ],
});

/** A Response whose headers arrive after `headerMs` but whose body
 * (res.json()) never completes — the exact stall the body-read deadline
 * exists for. The abort signal is the only way out. */
async function stalledBodyResponse(headerMs: number, signal: AbortSignal): Promise<Response> {
  await new Promise((r) => setTimeout(r, headerMs));
  const res = new Response(completionBody(PLAN_JSON), { status: 200 });
  (res as { json: () => Promise<unknown> }).json = () =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true }
      );
    });
  return res;
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  setAiBudgetGuards(null);
  vi.restoreAllMocks();
});

function makeGuards(remainingRuntimeMs: number, callTimeoutMs: number) {
  return {
    canAttempt: () => true,
    estimateTokens: () => 10,
    canSpendTokens: () => true,
    spendTokens: () => {},
    remainingRuntimeMs: () => remainingRuntimeMs,
    callTimeoutMs: () => callTimeoutMs,
  };
}

describe("AI effective deadline policy", () => {
  it("a slow but valid response within the effective deadline succeeds", async () => {
    const t0 = Date.now();
    globalThis.fetch = (async () => {
      // Slow provider (300ms) but well within the effective budget.
      await new Promise((r) => setTimeout(r, 300));
      return new Response(completionBody(PLAN_JSON), { status: 200 });
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(60_000, 90_000));
    const adapter = createOpenAIAdapter();
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it("the body-read phase cannot exceed the per-call ceiling even after slow headers", async () => {
    // Headers arrive at ~400ms; the body then stalls forever. The per-call
    // ceiling is 1200ms, so the body budget is min(1200 − 400, runtime) ≈
    // 800ms — NOT a fresh full ceiling. Total elapsed must stay under the
    // single 1200ms budget plus slack.
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return stalledBodyResponse(400, signal);
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 1_200));
    const adapter = createOpenAIAdapter();
    const t0 = Date.now();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(
      /AI API response read timeout after \d+ms \(bounded by the configured per-call AI timeout\)/
    );
    const elapsed = Date.now() - t0;
    // 400ms headers + ~800ms body budget ≈ 1200ms. If the body got a FRESH
    // 1200ms budget this would be ≈1600ms — the shared budget forbids that.
    expect(elapsed).toBeLessThan(1_500);
  });

  it("a stalled body terminates within the effective deadline (never hangs)", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      }) as unknown as Response;
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 1_000));
    const adapter = createOpenAIAdapter();
    const t0 = Date.now();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(/AI API timeout after/i);
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("fails fast (without a request) when the remaining runtime cannot cover the terminalization headroom", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(completionBody(), { status: 200 });
    }) as typeof fetch;

    // 5s remaining < 10s headroom → no request may even start.
    setAiBudgetGuards(makeGuards(5_000, 90_000));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(fetchCalled).toBe(false);
  });

  it("an investigation-deadline-bounded timeout is classified accurately", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      }) as unknown as Response;
    }) as typeof fetch;

    // Remaining runtime (14s) − headroom (10s) < configured ceiling (90s):
    // the binding bound is the REMAINING RUNTIME (4s effective call budget,
    // fired well before the ceiling) and the message must say so.
    setAiBudgetGuards(makeGuards(14_000, 90_000));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(
      /AI API timeout after \d+ms \(bounded by the investigation's remaining runtime\)/
    );
  }, 15_000);

  it("a per-call-ceiling timeout does NOT claim the investigation deadline caused it", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      }) as unknown as Response;
    }) as typeof fetch;

    // Plenty of runtime (10min), small configured ceiling: the ceiling binds.
    setAiBudgetGuards(makeGuards(600_000, 1_000));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(
      /bounded by the configured per-call AI timeout/
    );
  });

  it("timeouts do not retry: one timed-out attempt consumes exactly one AI call and fails cleanly", async () => {
    let attempts = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      attempts += 1;
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      }) as unknown as Response;
    }) as typeof fetch;

    let charged = 0;
    setAiBudgetGuards({
      ...makeGuards(600_000, 1_000),
      spendTokens: () => {
        charged += 1;
      },
    });
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(/AI API timeout/i);
    // Abort during fetch = the request never completed; retries are for
    // retryable HTTP statuses only — a timeout must not re-send the same
    // doomed request.
    expect(attempts).toBe(1);
    // Token accounting happens only after a response was received.
    expect(charged).toBe(0);
  });
});
