/**
 * Regression tests for the 128-minute verifier-hang fixes.
 *
 * Live background: a real verification phase hung for ~128 minutes because
 * a single awaited provider `res.json()` never settled — the request-level
 * AbortController only covered reaching response HEADERS, not reading the
 * BODY. These tests pin:
 *
 *  1. The AI body-read deadline — a fetch whose headers arrive but whose
 *     body never completes must be aborted with a bounded error (never an
 *     immortal await).
 *  2. Probe-limitation classification — bounded interaction timeouts and
 *     navigation-policy rejections are classified honestly as Probe
 *     limitations, not presented as application evidence.
 */
/** @vitest-environment node */
import { describe, it, expect, vi, afterEach } from "vitest";

// Keep the body-read deadline inside test time (config default is 90s).
vi.hoisted(() => {
  process.env.PROBE_AI_CALL_TIMEOUT_MS = "2000";
});
import { isProbeLimitationError, classifyActionError } from "../security/error-classification.js";
import { assertNavigationAllowed, NavigationPolicyError } from "../security/navigation-policy.js";
import { createOpenAIAdapter, chatInternal, setAiBudgetGuards, estimatePromptTokens } from "../ai/openai.js";
import * as budget from "../orchestrator/budget.js";

// ── Error classification ──────────────────────────────────────────────────

describe("probe-limitation error classification", () => {
  it("classifies Playwright locator timeouts waiting for an unresolved target as a Probe limitation", () => {
    const raw =
      "Timeout 30000ms exceeded. Call log: waiting for locator('page')";
    expect(isProbeLimitationError(raw)).toBe(true);
    const classified = classifyActionError(raw);
    expect(classified).toMatch(/Probe limitation \(target not resolved\)/);
    // The raw Playwright detail is preserved for diagnosability.
    expect(classified).toContain("waiting for locator('page')");
  });

  it("classifies navigation-policy rejections as a Probe limitation naming the boundary", () => {
    const raw =
      "Navigation to https://rayern.com/ is outside this investigation's verified target (https://app.rayern.com.ng). The AI may only navigate within the application under investigation.";
    expect(isProbeLimitationError(raw)).toBe(true);
    const classified = classifyActionError(raw);
    expect(classified).toMatch(/Probe limitation \(navigation policy\)/);
    expect(classified).toContain("https://rayern.com/");
  });

  it("does NOT classify genuine application failures as Probe limitations", () => {
    const appFailures = [
      "page.goto: net::ERR_ABORTED at https://app.rayern.com.ng/signup",
      "Selector button[type=submit] matched 3 elements, refusing ambiguous click",
      "expect(recon.text).toBe('Account created') — observed 'Error 500'",
    ];
    for (const msg of appFailures) {
      expect(isProbeLimitationError(msg)).toBe(false);
      expect(classifyActionError(msg)).toBe(msg);
    }
  });

  it("the navigation policy itself rejects an unrelated host and fails closed without a canonical URL", () => {
    expect(() =>
      assertNavigationAllowed("https://rayern.com/", "https://app.rayern.com.ng/")
    ).toThrow(NavigationPolicyError);
    // Fail closed: no verified target → no navigation at all.
    expect(() => assertNavigationAllowed("https://app.rayern.com.ng/")).toThrow(
      NavigationPolicyError
    );
  });
});

// ── AI provider body-read deadline ────────────────────────────────────────

describe("AI adapter body-read deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setAiBudgetGuards(null);
    budget.resetBudget("inv_bodytest");
    budget.stopRuntimeClock("inv_bodytest");
  });

  it("aborts with a bounded error when the provider response body never completes", async () => {
    // Provider that sends response HEADERS immediately but whose BODY
    // stream never finishes — the exact shape that left a real run
    // awaiting res.json() forever. Like real undici fetch, the stub must
    // tie the request signal to the body stream so an abort rejects the
    // in-flight json() read (that coupling IS the production behavior the
    // fix relies on).
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL, init?: RequestInit) => {
        const signal = init?.signal;
        // Headers arrive; the body is a stream that never delivers bytes.
        // Mirroring undici: when the request signal aborts, the in-flight
        // body read REJECTS (that coupling is the production behavior the
        // fix relies on).
        const { writable, readable } = new TransformStream<Uint8Array, Uint8Array>();
        const response = new Response(readable, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        signal?.addEventListener(
          "abort",
          () => {
            void writable.abort(new Error("The operation was aborted")).catch(() => {});
          },
          { once: true }
        );
        return Promise.resolve(response);
      }),
    );

    // Minimal real budget guards so the deadline branch is active.
    budget.initBudget("inv_bodytest");
    budget.startRuntimeClock("inv_bodytest");
    setAiBudgetGuards({
      canAttempt: () => true,
      estimateTokens: (text) => estimatePromptTokens(text),
      canSpendTokens: () => true,
      spendTokens: () => {},
      remainingRuntimeMs: () => budget.remainingRuntime("inv_bodytest"),
      callTimeoutMs: () => 2_000, // 2s deadline → test finishes fast
    });

    const started = Date.now();
    // The body read must terminate with a bounded, budget-aware error. The
    // exact message depends on whether the investigation clock expired
    // first (AiBudgetExhaustedError) or only the per-call deadline did —
    // both are bounded terminal outcomes, never an immortal await.
    await expect(chatInternal("system", "user prompt")).rejects.toThrow(
      /AI API response read timeout|runtime expired during AI response read|The operation was aborted|abort/i
    );
    const elapsed = Date.now() - started;
    // Bounded: well under Playwright-default-scale timeouts.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("succeeds normally when the body completes promptly (no false timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    budget.initBudget("inv_bodytest");
    budget.startRuntimeClock("inv_bodytest");
    setAiBudgetGuards({
      canAttempt: () => true,
      estimateTokens: (text) => estimatePromptTokens(text),
      canSpendTokens: () => true,
      spendTokens: () => {},
      remainingRuntimeMs: () => budget.remainingRuntime("inv_bodytest"),
      callTimeoutMs: () => 5_000,
    });

    const content = await chatInternal("system", "user prompt");
    expect(content).toBe("ok");
  }, 20_000);
});
