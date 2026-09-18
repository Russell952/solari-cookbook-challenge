/**
 * AI_STREAMING=false opt-out regression tests.
 *
 * The streaming transport is the default; AI_STREAMING=false must restore
 * the previous non-streaming behavior exactly: no `stream` field sent, no
 * reasoning_effort field sent, and classic JSON responses parsed as before.
 *
 * The adapter snapshots config at module load, so this file sets the env
 * var FIRST and then imports the adapter modules dynamically — they cannot
 * be static imports here (imports are hoisted above the env assignment).
 */
/** @vitest-environment node */
process.env.AI_STREAMING = "false";
const { createOpenAIAdapter, setAiBudgetGuards, __resetProviderStallStateForTests } = await import("../ai/openai.js");

import { describe, it, expect, afterEach, vi } from "vitest";

const REAL_FETCH = globalThis.fetch;

function completionBody(content = "ok"): string {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

const PLAN_JSON = JSON.stringify({
  experiments: [
    {
      objective: "Verify the page loads",
      preconditions: [],
      plannedActions: [{ tool: "browser", action: "getTitle", target: "page" }],
    },
  ],
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  setAiBudgetGuards(null);
  __resetProviderStallStateForTests();
  vi.restoreAllMocks();
});

function makeGuards() {
  return {
    canAttempt: () => true,
    estimateTokens: () => 10,
    canSpendTokens: () => true,
    spendTokens: () => {},
    remainingRuntimeMs: () => 600_000,
    callTimeoutMs: () => 90_000,
  };
}

describe("AI_STREAMING=false non-streaming opt-out", () => {
  it("does not send stream or reasoning_effort and parses classic JSON responses", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(completionBody(PLAN_JSON), { status: 200 });
    }) as typeof fetch;

    setAiBudgetGuards(makeGuards());
    const adapter = createOpenAIAdapter();
    const out = await adapter.plan("objective", null, null);
    expect(out.experiments).toHaveLength(1);
    expect(out.experiments[0].objective).toBe("Verify the page loads");
    expect(capturedBody!.stream).toBeUndefined();
    expect(capturedBody!.reasoning_effort).toBeUndefined();
    expect(capturedBody!.model).toBe(process.env.AI_MODEL);
  });
});
