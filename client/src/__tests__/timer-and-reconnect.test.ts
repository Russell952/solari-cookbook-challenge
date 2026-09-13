/**
 * Elapsed-timer and SSE-liveness regression tests.
 *
 * Live background: the runtime metric only re-rendered when an SSE event
 * happened to trigger a summary refresh, so the timer jumped 01:12 → 03:07
 * → 05:41 instead of counting every second; and a silently-ended SSE stream
 * left the view showing Running with no recovery path.
 *
 * The client test environment is node — React components are not mounted —
 * so these pin the source-level guarantees: the timer derives from
 * `now - startedAt` driven by a 1s interval, never accumulates, and the SSE
 * subscription reconnects with bounded backoff instead of dying silently.
 */
/** @vitest-environment node */
import { describe, it, expect, vi } from "vitest";
import { buildProgressModel } from "../progress";
import { subscribeToEvents } from "../api";
import type { InvestigationSummary } from "../api";

function runningSummary(startedAt: string): InvestigationSummary {
  return {
    investigation: {
      id: "inv_1",
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "Verify the signup flow",
      status: "running",
      currentPhase: "execute",
      createdAt: startedAt,
      updatedAt: startedAt,
    },
    experiments: [],
    experimentCounts: { total: 0, completed: 0 },
    evidence: [],
    evidenceCount: 0,
    hypotheses: [],
    hypothesesCount: 0,
    findings: [],
    findingsCount: 0,
    probeFailures: [],
    budget: {
      maxRuntimeMs: 600_000,
      maxExperiments: 4,
      maxBrowserActions: 40,
      maxSandboxCommands: 10,
      maxAiCalls: 60,
      maxAiTokens: 300_000,
      usedRuntimeMs: 0,
      usedExperiments: 0,
      usedBrowserActions: 0,
      usedSandboxCommands: 0,
      usedAiCalls: 0,
      usedAiTokens: 0,
    },
    runtime: { startedAt, completedAt: null, durationMs: null },
    report: null,
    incomplete: true,
  } as unknown as InvestigationSummary;
}

describe("elapsed timer (regression: jumped with SSE-driven renders)", () => {
  it("computes runtime from the passed instant, not a captured Date.now()", () => {
    const startedAt = "2026-09-12T00:00:00.000Z";
    const summary = runningSummary(startedAt);
    const startMs = new Date(startedAt).getTime();

    // 72s after start → 01:12; then one second later → 01:13.
    const at72s = buildProgressModel(summary, startMs + 72_000);
    const at73s = buildProgressModel(summary, startMs + 73_000);

    const runtime72 = at72s.metrics.find((m) => m.label === "Runtime")!.value;
    const runtime73 = at73s.metrics.find((m) => m.label === "Runtime")!.value;
    expect(runtime72).toBe("01:12");
    expect(runtime73).toBe("01:13");
  });

  it("does not drift: runtime is recomputed from startedAt each derivation", () => {
    const startedAt = "2026-09-12T00:00:00.000Z";
    const summary = runningSummary(startedAt);
    const startMs = new Date(startedAt).getTime();

    // Ten sequential ticks 1s apart must advance 10 seconds total.
    for (let tick = 1; tick <= 10; tick++) {
      const model = buildProgressModel(summary, startMs + (341 + tick) * 1000);
      const expected = `05:${String(41 + tick).padStart(2, "0")}`;
      const runtime = model.metrics.find((m) => m.label === "Runtime")!.value;
      expect(runtime).toBe(expected);
    }
  });

  it("the progress component owns a 1s interval while running (source guarantee)", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../InvestigationProgress.tsx", import.meta.url), "utf-8");
    expect(src).toMatch(/setInterval\(\s*\(\)\s*=>\s*setNow\(Date\.now\(\)\),\s*1000\)/);
    expect(src).toMatch(/useNowTick\(/);
  });
});

describe("SSE reconnection (regression: silent stream death stranded the UI)", () => {
  it("reconnects with bounded backoff instead of returning after the first failure", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../api.ts", import.meta.url), "utf-8");
    // The loop + backoff structure exists and is bounded.
    expect(src).toMatch(/while \(!stopped\)/);
    expect(src).toMatch(/Math\.min\(1000 \* 2 \*\* attempt, 10_000\)/);
    expect(src).toMatch(/onConnectionChange/);
  });

  it("reports connection liveness transitions to the caller", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      // First connection: a healthy SSE stream that ends immediately.
      const reader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("data: {\"type\":\"connected\"}\n\n") })
          .mockResolvedValue({ done: true, value: undefined }),
      };
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => reader } });
      // Subsequent reconnect attempts hang (never resolve).
      fetchMock.mockReturnValue(new Promise(() => {}));

      const onEvent = vi.fn();
      const onConnectionChange = vi.fn();
      const stop = subscribeToEvents("inv_1", onEvent, onConnectionChange);

      await new Promise((r) => setTimeout(r, 30));
      // Connected after the stream opened, disconnected when it ended.
      expect(onConnectionChange).toHaveBeenNthCalledWith(1, true);
      expect(onConnectionChange).toHaveBeenNthCalledWith(2, false);
      expect(onEvent).toHaveBeenCalledTimes(1);

      // Cleanup stops the reconnect loop: no more callbacks afterwards.
      const calls = onConnectionChange.mock.calls.length;
      stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(onConnectionChange.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
