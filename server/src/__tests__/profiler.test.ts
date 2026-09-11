/**
 * Profiler unit tests — validate the instrumentation core itself.
 * These do NOT run a real investigation (no network, no AI, no Solari).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { profiler } from "../profiler/index.js";

function setProfileEnv(on: boolean): void {
  if (on) process.env.PROBE_PROFILE = "1";
  else delete process.env.PROBE_PROFILE;
  profiler.reset();
}

describe("profiler", () => {
  beforeEach(() => {
    setProfileEnv(true);
  });

  it("is disabled when PROBE_PROFILE is unset (spans are no-ops)", async () => {
    setProfileEnv(false);
    const result = await profiler.span("db", "noop.op", undefined, async () => 42);
    expect(result).toBe(42);
    expect(profiler.getSpans()).toHaveLength(0);
  });

  it("records duration and success for a passing span", async () => {
    await profiler.span("db", "test.op", { collection: "t" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const spans = profiler.getSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s.kind).toBe("db");
    expect(s.op).toBe("test.op");
    expect(s.ok).toBe(true);
    expect(s.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.attrs?.collection).toBe("t");
  });

  it("records failure (and timeout detection) for a throwing span, rethrowing unchanged", async () => {
    await expect(
      profiler.span("browser", "test.timeout", undefined, async () => {
        throw new Error("Navigation timeout of 30000 ms exceeded");
      })
    ).rejects.toThrow("Navigation timeout");
    const s = profiler.getSpans()[0];
    expect(s.ok).toBe(false);
    expect(s.timeout).toBe(true);
    expect(s.attrs?.error).toContain("timeout");
  });

  it("attributes nested spans to the enclosing phase/experiment context", async () => {
    profiler.pushContext({ investigationId: "inv1", phase: "recon" });
    await profiler.span("browser", "outer.op", undefined, async () => {
      await profiler.span("browser", "inner.op", undefined, async () => {});
    });
    profiler.popContext();
    const spans = profiler.getSpans();
    expect(spans.map((s) => s.op)).toEqual(["outer.op", "inner.op"]);
    for (const s of spans) {
      expect(s.investigationId).toBe("inv1");
      expect(s.phase).toBe("recon");
    }
  });

  it("withContext patches and restores context", async () => {
    profiler.pushContext({ phase: "recon" });
    await profiler.withContext({ experimentId: "exp9" }, async () => {
      await profiler.span("action", "click.op", undefined, async () => {});
    });
    await profiler.span("browser", "after.op", undefined, async () => {});
    profiler.popContext();
    const spans = profiler.getSpans();
    expect(spans[0].experimentId).toBe("exp9");
    expect(spans[0].phase).toBe("recon");
    expect(spans[1].experimentId).toBeUndefined();
  });

  it("records retry entries with attribution", () => {
    profiler.pushContext({ phase: "execute", experimentId: "exp1" });
    profiler.recordRetry("ai", "ai.request", "HTTP 503", 2500, 1);
    profiler.popContext();
    const retries = profiler.getRetries();
    expect(retries).toHaveLength(1);
    expect(retries[0].category).toBe("ai");
    expect(retries[0].delayMs).toBe(2500);
    expect(retries[0].phase).toBe("execute");
    expect(retries[0].experimentId).toBe("exp1");
  });

  it("records budget snapshots and exposes them in the report", () => {
    profiler.recordBudget({
      phase: "phase→plan",
      investigationId: "inv1",
      configuredRuntimeMs: 600000,
      runtimeStartedAt: new Date().toISOString(),
      elapsedMs: 1234,
      remainingMs: 598766,
      clockRunning: true,
      usedExperiments: 1,
      usedBrowserActions: 3,
      usedSandboxCommands: 0,
      usedAiCalls: 2,
      usedAiTokens: 45000,
      usedVerificationExperiments: 0,
    });
    const b = profiler.getBudgets();
    expect(b).toHaveLength(1);
    expect(b[0].remainingMs).toBe(598766);
    const report = profiler.buildReport();
    expect(report.budgets).toHaveLength(1);
  });

  it("records compaction metrics and attaches them to the open AI span", () => {
    const handle = profiler.begin("ai", "ai.plan", { model: "test" });
    profiler.recordCompaction({
      op: "AI request",
      bytesBefore: 100_000,
      bytesAfter: 40_000,
      estTokensBefore: 25_000,
      estTokensAfter: 10_000,
      durationMs: 12,
    });
    handle.end(true, { estInputTokens: 10_000 });

    const spans = profiler.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attrs?.contextBytesBefore).toBe(100_000);
    expect(spans[0].attrs?.contextBytesAfter).toBe(40_000);
    expect(profiler.getCompactions()).toHaveLength(1);
  });

  it("aggregates per-op AI stats in the report", async () => {
    const h1 = profiler.begin("ai", "ai.plan", {});
    h1.end(true, { estInputTokens: 100, estOutputTokens: 50, retries: 1 });
    const h2 = profiler.begin("ai", "ai.plan", {});
    h2.end(true, { estInputTokens: 200, estOutputTokens: 80, retries: 0 });
    const h3 = profiler.begin("ai", "ai.analyzeObservation", {});
    h3.end(true, { estInputTokens: 500, estOutputTokens: 300, retries: 0 });

    const report = profiler.buildReport();
    const plan = report.aiOps.find((o) => o.op === "ai.plan");
    expect(plan).toBeDefined();
    expect(plan!.calls).toBe(2);
    expect(plan!.estInputTokens).toBe(300);
    expect(plan!.retries).toBe(1);
    const obs = report.aiOps.find((o) => o.op === "ai.analyzeObservation");
    expect(obs!.calls).toBe(1);
  });

  it("flags spans that ended after the runtime deadline as anomalies", () => {
    const started = Date.now() - 60_000;
    profiler.recordBudget({
      phase: "run-end",
      configuredRuntimeMs: 30_000,
      runtimeStartedAt: new Date(started).toISOString(),
      elapsedMs: 60_000,
      remainingMs: 0,
      clockRunning: false,
      usedExperiments: 2,
      usedBrowserActions: 5,
      usedSandboxCommands: 0,
      usedAiCalls: 4,
      usedAiTokens: 90_000,
      usedVerificationExperiments: 0,
    });
    const report = profiler.buildReport();
    expect(report.anomalies.some((a) => a.includes("EXHAUSTED"))).toBe(true);
  });

  it("formatReport produces a text summary containing the main sections", async () => {
    profiler.pushContext({ phase: "recon" });
    await profiler.span("browser", "navigate", { url: "https://example.com" }, async () => {});
    profiler.popContext();
    const text = profiler.formatReport();
    expect(text).toContain("PROFILING REPORT");
    expect(text).toContain("Phases");
    expect(text).toContain("AI ops");
    expect(text).toContain("Browser ops");
    expect(text).toContain("Budget snapshots");
  });

  it("reset() clears all recorded state", () => {
    profiler.begin("ai", "x", {}).end(true);
    profiler.recordRetry("ai", "x", "why", 10, 1);
    profiler.reset();
    expect(profiler.getSpans()).toHaveLength(0);
    expect(profiler.getRetries()).toHaveLength(0);
    expect(profiler.getBudgets()).toHaveLength(0);
    expect(profiler.getCompactions()).toHaveLength(0);
  });
});
