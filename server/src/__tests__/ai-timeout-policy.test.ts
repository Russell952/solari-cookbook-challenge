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
import {
  createOpenAIAdapter,
  setAiBudgetGuards,
  AiBudgetExhaustedError,
  __resetProviderStallStateForTests,
} from "../ai/openai.js";

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

/** A Response whose headers arrive after `headerMs` and whose byte body
 * emits one chunk then never completes — the streaming-transport shape of a
 * stalled body. The abort signal is the only way out. */
function stalledByteBodyResponse(headerMs: number, signal: AbortSignal): Promise<Response> {
  return (async () => {
    await new Promise((r) => setTimeout(r, headerMs));
    let sentFirst = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sentFirst) {
            sentFirst = true;
            controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
            return;
          }
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true }
            );
          });
        },
      }),
      { status: 200 }
    );
  })();
}

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  setAiBudgetGuards(null);
  __resetProviderStallStateForTests();
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
      return stalledByteBodyResponse(400, signal);
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 1_200));
    const adapter = createOpenAIAdapter();
    const t0 = Date.now();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(
      /AI API response read timeout after \d+ms \(bounded by the configured per-call AI timeout\)/
    );
    // A byte-producing body (": keep-alive" SSE comment) must NOT arm the
    // provider-stall breaker — only a truly dead (zero-byte) connection may.
    // The next call goes out and succeeds.
    globalThis.fetch = (async () => new Response(completionBody(PLAN_JSON), { status: 200 })) as typeof fetch;
    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
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

  it("arms a provider-stall fail-fast gate after a dead (zero-byte) body read, and the next call fails fast without consuming an AI call", async () => {
    let fetchAttempts = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      fetchAttempts += 1;
      const signal = init?.signal as AbortSignal;
      // Real Response with native json and a byte stream that never produces
      // a chunk: the production shape of a dead gateway connection (headers
      // fast, body never routed). Like real undici, the stream reacts to the
      // fetch abort signal — a rejected pull errors the stream and rejects
      // the pending reader.read(), letting the armed deadline land.
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new DOMException("The operation was aborted.", "AbortError")),
                { once: true }
              );
            });
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    setAiBudgetGuards({
      ...makeGuards(600_000, 1_200),
      estimateTokens: () => 1,
    });
    const adapter = createOpenAIAdapter();

    // First call: body never arrives → read timeout, breaker arms.
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(/AI API response read timeout/);
    expect(fetchAttempts).toBe(1);

    // Second call within the backoff window: fails fast — no second HTTP
    // request is ever sent (the top-of-call budget pre-check still runs —
    // it is read-only and consumes nothing — and the breaker throws before
    // any attempt loop, so recordAiRequest never fires either).
    setAiBudgetGuards(makeGuards(600_000, 90_000));
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(/AI provider stalled and did not recover/);
    expect(fetchAttempts).toBe(1);
  });

  it("a stubbed (non-instrumented) body read timeout does NOT arm the stall gate", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      // A Response with NO byte stream (body === null) forces the res.json()
      // fallback path — the non-instrumented shape this test exists for.
      const res = new Response(null, { status: 200 });
      (res as unknown as { json: () => Promise<unknown> }).json = () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      return res;
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 1_200));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(/AI API response read timeout/);

    // The gate must not be armed: the next call goes out normally (and here
    // succeeds — real fetch restored via closure? no: stub returns 200).
    globalThis.fetch = (async () => new Response(completionBody(PLAN_JSON), { status: 200 })) as typeof fetch;
    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
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

  it("a 402 (provider out of credits) fails fast with a typed budget error and never retries", async () => {
    // Live production evidence: after a 402 the adapter re-sent the identical
    // doomed request, which then stalled ~90s in the body-read — burning the
    // plan phase's runtime on a request that could never succeed. A 402 is a
    // payment/account failure; the balance cannot recover mid-investigation.
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "This request requires more credits, or fewer max_tokens.",
            code: 402,
          },
        }),
        { status: 402 }
      );
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    // One plan() call: the typed budget error propagates out of chat() through
    // chatWithValidation (never validation-retried) — exactly ONE HTTP request.
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(
      /HTTP 402: out of credits/
    );
    expect(attempts).toBe(1);

    // A second plan() call must surface the SAME typed error class (the
    // orchestrator's graceful AiBudgetExhaustedError handler depends on it).
    await expect(adapter.plan("objective", null, null)).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(attempts).toBe(2); // one per call — never retried within a call
  });

  it("a 402 delivered inside an HTTP 200 body (gateway envelope) also fails fast without retry", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(
        JSON.stringify({
          error: { message: "out of credits", code: 402 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toThrow(AiBudgetExhaustedError);
    expect(attempts).toBe(1);
  });

  it("a Gemini 200-body UNAVAILABLE error still retries (transient), preserving the existing 503-equivalent policy", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify([{ error: { status: "UNAVAILABLE", message: "overloaded" } }]),
          { status: 200 }
        );
      }
      return new Response(completionBody(PLAN_JSON), { status: 200 });
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
    // First attempt hit the transient body error; second succeeded.
    expect(attempts).toBe(2);
  });
});

describe("AI streaming transport (default)", () => {
  /** Build an SSE response whose body is a sequence of `data:` frames. */
  function sseResponse(frames: unknown[], status = 200): Response {
    const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
  }

  function planFrames(json: string): unknown[] {
    // Split the JSON across content deltas like a real stream, interleaved
    // with reasoning deltas (which must be discarded, never parsed).
    const mid = Math.floor(json.length / 2);
    return [
      { choices: [{ delta: { reasoning: "thinking about the target..." } }] },
      { choices: [{ delta: { content: json.slice(0, mid) } }] },
      { choices: [{ delta: { reasoning: "more reasoning" } }] },
      { choices: [{ delta: { content: json.slice(mid) } }] },
      { choices: [{ delta: {} }] },
    ];
  }

  it("requests stream:true by default and aggregates content deltas (reasoning discarded)", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return sseResponse(planFrames(PLAN_JSON));
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
    expect(out.experiments[0].objective).toBe("Verify the page loads");
    expect(capturedBody!.stream).toBe(true);
    if (process.env.AI_REASONING_EFFORT) {
      expect(capturedBody!.reasoning_effort).toBe(process.env.AI_REASONING_EFFORT);
    } else {
      expect(capturedBody!.reasoning_effort).toBeUndefined();
    }
  });

  it("a 402 JSON body returned to a streaming request fails fast with the typed budget error", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      // Error envelopes are plain JSON, NOT SSE — even when stream:true was
      // requested. The adapter must classify them exactly as before.
      return new Response(
        JSON.stringify({ error: { message: "out of credits", code: 402 } }),
        { status: 402 }
      );
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(attempts).toBe(1);
  });

  it("an in-stream HTTP-200 SSE error frame with code 402 fails fast without retry", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return sseResponse([{ error: { message: "out of credits", code: 402 } }]);
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    await expect(adapter.plan("objective", null, null)).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(attempts).toBe(1);
  });

  it("an in-stream UNAVAILABLE error frame retries, then a healthy stream succeeds", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return sseResponse([{ error: { status: "UNAVAILABLE", message: "overloaded" } }]);
      }
      return sseResponse(planFrames(PLAN_JSON));
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("a classic (non-streamed) JSON 200 body is still accepted when the gateway ignores stream:true", async () => {
    globalThis.fetch = (async () => new Response(completionBody(PLAN_JSON), { status: 200 })) as typeof fetch;

    setAiBudgetGuards(makeGuards(600_000, 90_000));
    const adapter = createOpenAIAdapter();
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
  });
});
