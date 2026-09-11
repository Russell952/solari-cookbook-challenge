/**
 * Investigation pipeline profiler.
 *
 * PROFILING ONLY — this module changes no behavior. Every public method is a
 * no-op unless PROBE_PROFILE=1 is set in the environment, so production and
 * test runs are unaffected. When enabled it records timing spans for every
 * significant operation in the investigation pipeline:
 *
 *   phase      — orchestrator phases (recon/plan/experiment/analyze/…)
 *   experiment — per-experiment lifecycle (setup/actions/cleanup)
 *   action     — per planned browser/sandbox action
 *   ai         — every model request (op, tokens, retries, compaction)
 *   browser    — Solari browser operations (launch, navigate, click, …)
 *   sandbox    — Solari sandbox operations (create, clone, read, …)
 *   evidence   — evidence capture and artifact storage (local/B2, sha256)
 *   db         — MongoDB/persistence operations (write-through, hydrate, …)
 *
 * plus structured retry records, runtime-budget snapshots, and AI context
 * compaction metrics. `buildReport()` aggregates spans into the tables used
 * by the profiling report (per-phase, per-op, per-experiment, per-evidence).
 *
 * Spans record a monotonically increasing clock (Date.now()); attribution to
 * the enclosing phase/experiment comes from a context stack set by the
 * orchestrator instrumentation.
 */

export type SpanKind =
  | "phase"
  | "experiment"
  | "action"
  | "ai"
  | "browser"
  | "sandbox"
  | "evidence"
  | "db";

export interface Span {
  kind: SpanKind;
  op: string;
  investigationId?: string;
  phase?: string;
  experimentId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  ok?: boolean;
  timeout?: boolean;
  attrs?: Record<string, unknown>;
}

export interface RetryRecord {
  category: "ai" | "ai-validation" | "browser" | "sandbox" | "solari" | "network" | "experiment" | "db" | "b2" | "other";
  op: string;
  why: string;
  attempt: number;
  delayMs: number;
  at: number;
  phase?: string;
  experimentId?: string;
  investigationId?: string;
}

export interface BudgetSnapshot {
  phase: string | null;
  at: number;
  investigationId?: string;
  configuredRuntimeMs: number;
  runtimeStartedAt: string | null;
  elapsedMs: number;
  remainingMs: number;
  clockRunning: boolean;
  usedExperiments: number;
  usedBrowserActions: number;
  usedSandboxCommands: number;
  usedAiCalls: number;
  usedAiTokens: number;
  usedVerificationExperiments: number;
}

export interface CompactionRecord {
  op: string;
  at: number;
  bytesBefore: number;
  bytesAfter: number;
  estTokensBefore: number;
  estTokensAfter: number;
  durationMs: number;
  phase?: string;
  experimentId?: string;
}

interface ProfilerContext {
  investigationId?: string;
  phase?: string;
  experimentId?: string;
}

export function isProfilingEnabled(): boolean {
  return process.env.PROBE_PROFILE === "1";
}

class Profiler {
  private enabled = isProfilingEnabled();
  private spans: Span[] = [];
  private retries: RetryRecord[] = [];
  private budgets: BudgetSnapshot[] = [];
  private compactions: CompactionRecord[] = [];
  private context: ProfilerContext = {};
  private contextStack: ProfilerContext[] = [];
  /** Span currently open for an AI call (compaction metrics attach here). */
  private currentAiSpan: Span | null = null;
  /** Phase span kept open until the next phase begins / run ends. */
  private openPhaseSpan: Span | null = null;
  private t0 = Date.now();

  enabled$(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.enabled = isProfilingEnabled();
    this.spans = [];
    this.retries = [];
    this.budgets = [];
    this.compactions = [];
    this.context = {};
    this.contextStack = [];
    this.currentAiSpan = null;
    this.openPhaseSpan = null;
    this.t0 = Date.now();
  }

  // ── Context stack (phase/experiment attribution) ─────────────────────────

  pushContext(patch: Partial<ProfilerContext>): void {
    if (!this.enabled) return;
    this.contextStack.push({ ...this.context });
    this.context = { ...this.context, ...patch };
  }

  popContext(): void {
    if (!this.enabled || this.contextStack.length === 0) return;
    this.context = this.contextStack.pop()!;
  }

  /** Run fn with a patched context (restored afterwards). */
  async withContext<T>(patch: Partial<ProfilerContext>, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    this.pushContext(patch);
    try {
      return await fn();
    } finally {
      this.popContext();
    }
  }

  // ── Spans ─────────────────────────────────────────────────────────────────

  /**
   * Open a phase span that stays open until the NEXT phase span begins (or
   * the run ends). Phase durations come from the delta between consecutive
   * phase starts, so no phase — including the last — is ever left dangling
   * at 0.00s in the report.
   */
  beginPhase(op: string, attrs?: Record<string, unknown>): void {
    if (!this.enabled) return;
    // Close the previous phase span at this instant.
    if (this.openPhaseSpan) {
      this.openPhaseSpan.endedAt = Date.now();
      this.openPhaseSpan.durationMs = this.openPhaseSpan.endedAt - this.openPhaseSpan.startedAt;
      this.openPhaseSpan.ok = true;
    }
    const span: Span = {
      kind: "phase",
      op,
      investigationId: this.context.investigationId,
      phase: this.context.phase,
      startedAt: Date.now(),
      attrs: attrs ? { ...attrs } : undefined,
    };
    this.openPhaseSpan = span;
    this.spans.push(span);
  }

  /** Close the currently open phase span (run end). */
  endPhase(): void {
    if (this.openPhaseSpan) {
      this.openPhaseSpan.endedAt = Date.now();
      this.openPhaseSpan.durationMs = this.openPhaseSpan.endedAt - this.openPhaseSpan.startedAt;
      this.openPhaseSpan.ok = true;
      this.openPhaseSpan = null;
    }
  }

  /**
   * Time an async operation. Records a span with ok=false (and timeout=true
   * when the error looks like a timeout) if fn throws; rethrows unchanged.
   */
  async span<T>(
    kind: SpanKind,
    op: string,
    attrs: Record<string, unknown> | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!this.enabled) return fn();
    const handle = this.begin(kind, op, attrs);
    try {
      const result = await fn();
      handle.end(true);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|timed out|abort/i.test(msg);
      handle.end(false, { error: msg.slice(0, 300), ...(timedOut ? { timedOut: true } : {}) });
      throw err;
    }
  }

  /** Manual span for cases needing incremental annotation (AI calls). */
  begin(kind: SpanKind, op: string, attrs?: Record<string, unknown>): {
    end(ok: boolean, extra?: Record<string, unknown>): void;
    annotate(extra: Record<string, unknown>): void;
  } {
    if (!this.enabled) {
      return {
        end: () => undefined,
        annotate: () => undefined,
      };
    }
    const span: Span = {
      kind,
      op,
      investigationId: this.context.investigationId,
      phase: this.context.phase,
      experimentId: this.context.experimentId,
      startedAt: Date.now(),
      attrs: attrs ? { ...attrs } : undefined,
    };
    if (kind === "ai") this.currentAiSpan = span;
    this.spans.push(span);
    return {
      annotate: (extra) => {
        span.attrs = { ...(span.attrs ?? {}), ...extra };
      },
      end: (ok, extra) => {
        span.endedAt = Date.now();
        span.durationMs = span.endedAt - span.startedAt;
        span.ok = ok;
        if (extra) span.attrs = { ...(span.attrs ?? {}), ...extra };
        if (extra?.timedOut === true) span.timeout = true;
        if (kind === "ai" && this.currentAiSpan === span) this.currentAiSpan = null;
      },
    };
  }

  /** Attach AI context-compaction metrics to the currently open AI span. */
  recordCompaction(rec: Omit<CompactionRecord, "at" | "phase" | "experimentId">): void {
    if (!this.enabled) return;
    const full: CompactionRecord = {
      ...rec,
      at: Date.now(),
      phase: this.context.phase,
      experimentId: this.context.experimentId,
    };
    this.compactions.push(full);
    if (this.currentAiSpan) {
      this.currentAiSpan.attrs = {
        ...(this.currentAiSpan.attrs ?? {}),
        contextBytesBefore: rec.bytesBefore,
        contextBytesAfter: rec.bytesAfter,
        estTokensBefore: rec.estTokensBefore,
        estTokensAfter: rec.estTokensAfter,
        compactionMs: rec.durationMs,
      };
    }
  }

  // ── Retries / budget ──────────────────────────────────────────────────────

  recordRetry(
    category: RetryRecord["category"],
    op: string,
    why: string,
    delayMs: number,
    attempt: number
  ): void {
    if (!this.enabled) return;
    this.retries.push({
      category,
      op,
      why: why.slice(0, 200),
      attempt,
      delayMs,
      at: Date.now(),
      phase: this.context.phase,
      experimentId: this.context.experimentId,
      investigationId: this.context.investigationId,
    });
  }

  recordBudget(s: Omit<BudgetSnapshot, "at">): void {
    if (!this.enabled) return;
    this.budgets.push({ ...s, at: Date.now() });
  }

  // ── Aggregation ───────────────────────────────────────────────────────────

  getSpans(): readonly Span[] {
    return this.spans;
  }

  getRetries(): readonly RetryRecord[] {
    return this.retries;
  }

  getBudgets(): readonly BudgetSnapshot[] {
    return this.budgets;
  }

  getCompactions(): readonly CompactionRecord[] {
    return this.compactions;
  }

  elapsedTotalMs(): number {
    return Date.now() - this.t0;
  }

  private sumBy<T>(items: T[], f: (x: T) => number): number {
    return items.reduce((s, x) => s + f(x), 0);
  }

  private groupSpans(kind: SpanKind, keyFn: (s: Span) => string): Map<string, Span[]> {
    const groups = new Map<string, Span[]>();
    for (const s of this.spans) {
      if (s.kind !== kind) continue;
      const k = keyFn(s);
      const arr = groups.get(k);
      if (arr) arr.push(s);
      else groups.set(k, [s]);
    }
    return groups;
  }

  /** Total time spent in spans of a kind within a given phase. */
  kindTimeInPhase(kind: SpanKind, phase: string | undefined): number {
    return this.sumBy(
      this.spans.filter((s) => s.kind === kind && s.phase === phase),
      (s) => s.durationMs ?? 0
    );
  }

  kindTimeInExperiment(kind: SpanKind, experimentId: string): number {
    return this.sumBy(
      this.spans.filter((s) => s.kind === kind && s.experimentId === experimentId),
      (s) => s.durationMs ?? 0
    );
  }

  buildReport() {
    const totalRunMs = this.elapsedTotalMs();
    const phaseSpans = this.spans.filter((s) => s.kind === "phase");
    const aiSpans = this.spans.filter((s) => s.kind === "ai");
    const browserSpans = this.spans.filter((s) => s.kind === "browser");
    const sandboxSpans = this.spans.filter((s) => s.kind === "sandbox");
    const evidenceSpans = this.spans.filter((s) => s.kind === "evidence");
    const dbSpans = this.spans.filter((s) => s.kind === "db");
    const actionSpans = this.spans.filter((s) => s.kind === "action");
    const experimentSpans = this.spans.filter((s) => s.kind === "experiment");

    // ── Per-phase table ────────────────────────────────────────────────────
    const phases = phaseSpans.map((p) => {
      const dur = p.durationMs ?? 0;
      return {
        phase: p.op,
        durationMs: dur,
        percentOfRuntime: totalRunMs > 0 ? +((dur / totalRunMs) * 100).toFixed(1) : 0,
        ok: p.ok ?? null,
        aiCalls: this.spans.filter((s) => s.kind === "ai" && s.phase === p.op).length,
        aiTimeMs: this.kindTimeInPhase("ai", p.op),
        browserTimeMs: this.kindTimeInPhase("browser", p.op) + this.kindTimeInPhase("sandbox", p.op),
        evidenceTimeMs: this.kindTimeInPhase("evidence", p.op),
        dbTimeMs: this.kindTimeInPhase("db", p.op),
        retries: this.retries.filter((r) => r.phase === p.op).length,
        attrs: p.attrs,
      };
    });

    // ── Per-AI-op table ───────────────────────────────────────────────────
    const aiOps = Array.from(this.groupSpans("ai", (s) => s.op).entries()).map(([op, spans]) => {
      const n = spans.length;
      const total = this.sumBy(spans, (s) => s.durationMs ?? 0);
      const num = (key: string) =>
        this.sumBy(spans, (s) => typeof s.attrs?.[key] === "number" ? (s.attrs[key] as number) : 0);
      return {
        op,
        calls: n,
        totalMs: total,
        avgMs: n > 0 ? Math.round(total / n) : 0,
        estInputTokens: num("estInputTokens"),
        estOutputTokens: num("estOutputTokens"),
        usagePromptTokens: num("usagePromptTokens") || null,
        usageCompletionTokens: num("usageCompletionTokens") || null,
        requestBytes: num("requestBytes"),
        contextBytesBefore: num("contextBytesBefore"),
        contextBytesAfter: num("contextBytesAfter"),
        compactionMs: num("compactionMs"),
        retries: this.sumBy(spans, (s) => typeof s.attrs?.retries === "number" ? (s.attrs.retries as number) : 0),
        timeouts: spans.filter((s) => s.timeout).length,
        failures: spans.filter((s) => s.ok === false).length,
      };
    }).sort((a, b) => b.totalMs - a.totalMs);

    // ── Per-browser/Solari-op table ───────────────────────────────────────
    const browserOps = Array.from(this.groupSpans("browser", (s) => s.op).entries()).map(([op, spans]) => {
      const n = spans.length;
      const total = this.sumBy(spans, (s) => s.durationMs ?? 0);
      return {
        op,
        calls: n,
        totalMs: total,
        avgMs: n > 0 ? Math.round(total / n) : 0,
        maxMs: spans.reduce((m, s) => Math.max(m, s.durationMs ?? 0), 0),
        retries: this.retries.filter((r) => r.category === "browser" && r.op === op).length,
        timeouts: spans.filter((s) => s.timeout).length,
        failures: spans.filter((s) => s.ok === false).length,
      };
    }).sort((a, b) => b.totalMs - a.totalMs);

    const sandboxOps = Array.from(this.groupSpans("sandbox", (s) => s.op).entries()).map(([op, spans]) => {
      const n = spans.length;
      const total = this.sumBy(spans, (s) => s.durationMs ?? 0);
      return {
        op,
        calls: n,
        totalMs: total,
        avgMs: n > 0 ? Math.round(total / n) : 0,
        maxMs: spans.reduce((m, s) => Math.max(m, s.durationMs ?? 0), 0),
        failures: spans.filter((s) => s.ok === false).length,
      };
    }).sort((a, b) => b.totalMs - a.totalMs);

    // ── Per-experiment table ──────────────────────────────────────────────
    const experiments = experimentSpans.map((e) => {
      const id = e.experimentId ?? e.attrs?.experimentId ?? "?";
      const dur = e.durationMs ?? 0;
      const actions = actionSpans.filter((a) => a.experimentId === e.experimentId);
      return {
        experimentId: id,
        sequence: e.attrs?.sequence,
        objective: String(e.attrs?.objective ?? "").slice(0, 120),
        status: e.attrs?.status,
        durationMs: dur,
        setupMs: this.kindTimeInExperiment("browser", String(id)) > 0
          ? (e.attrs?.setupMs as number | undefined) ?? null
          : null,
        actionsCount: actions.length,
        actionsMs: this.sumBy(actions, (a) => a.durationMs ?? 0),
        browserTimeMs: this.kindTimeInExperiment("browser", String(id)),
        aiTimeMs: this.kindTimeInExperiment("ai", String(id)),
        evidenceTimeMs: this.kindTimeInExperiment("evidence", String(id)),
        dbTimeMs: this.kindTimeInExperiment("db", String(id)),
        retries: this.retries.filter((r) => r.experimentId === e.experimentId).length,
        attrs: e.attrs,
      };
    });

    // ── Per-action detail (top 50 by duration) ────────────────────────────
    const actions = actionSpans
      .map((a) => ({
        op: a.op,
        experimentId: a.experimentId,
        durationMs: a.durationMs ?? 0,
        ok: a.ok,
        target: String(a.attrs?.target ?? "").slice(0, 80),
        error: a.attrs?.error ? String(a.attrs.error).slice(0, 160) : undefined,
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 50);

    // ── Evidence table ────────────────────────────────────────────────────
    const evidenceByType = Array.from(this.groupSpans("evidence", (s) => String(s.attrs?.type ?? s.op)).entries()).map(
      ([type, spans]) => {
        const n = spans.length;
        const total = this.sumBy(spans, (s) => s.durationMs ?? 0);
        const artifactSaves = this.spans.filter(
          (s) => s.kind === "evidence" && (s.op === "artifact.save.local" || s.op === "artifact.save.b2") &&
            s.experimentId !== undefined
        );
        void artifactSaves;
        return {
          type,
          count: n,
          captureTotalMs: total,
          captureAvgMs: n > 0 ? Math.round(total / n) : 0,
          storageMs: numSum(spans, "storageMs"),
          shaMs: numSum(spans, "shaMs"),
          bytes: numSum(spans, "bytes"),
        };
      }
    );
    const artifactOps = Array.from(
      this.groupSpans("evidence", (s) => s.op).entries()
    ).map(([op, spans]) => ({
      op,
      calls: spans.length,
      totalMs: this.sumBy(spans, (s) => s.durationMs ?? 0),
      avgMs: spans.length > 0 ? Math.round(this.sumBy(spans, (s) => s.durationMs ?? 0) / spans.length) : 0,
      maxMs: spans.reduce((m, s) => Math.max(m, s.durationMs ?? 0), 0),
      bytes: numSum(spans, "bytes"),
      failures: spans.filter((s) => s.ok === false).length,
    }));

    // ── DB table ──────────────────────────────────────────────────────────
    const dbOps = Array.from(
      this.groupSpans("db", (s) => `${s.op}${s.attrs?.collection ? `:${s.attrs.collection}` : ""}`).entries()
    ).map(([op, spans]) => ({
      op,
      calls: spans.length,
      totalMs: this.sumBy(spans, (s) => s.durationMs ?? 0),
      avgMs: spans.length > 0 ? Math.round(this.sumBy(spans, (s) => s.durationMs ?? 0) / spans.length) : 0,
      maxMs: spans.reduce((m, s) => Math.max(m, s.durationMs ?? 0), 0),
      payloadBytes: numSum(spans, "payloadBytes"),
      failures: spans.filter((s) => s.ok === false).length,
    })).sort((a, b) => b.totalMs - a.totalMs);

    // ── AI totals ─────────────────────────────────────────────────────────
    const ai = {
      calls: aiSpans.length,
      totalMs: this.sumBy(aiSpans, (s) => s.durationMs ?? 0),
      retries: this.sumBy(aiSpans, (s) => typeof s.attrs?.retries === "number" ? (s.attrs.retries as number) : 0),
      timeouts: aiSpans.filter((s) => s.timeout).length,
      failures: aiSpans.filter((s) => s.ok === false).length,
      estInputTokens: this.sumBy(aiSpans, (s) => typeof s.attrs?.estInputTokens === "number" ? (s.attrs.estInputTokens as number) : 0),
      estOutputTokens: this.sumBy(aiSpans, (s) => typeof s.attrs?.estOutputTokens === "number" ? (s.attrs.estOutputTokens as number) : 0),
      usagePromptTokens: this.sumBy(aiSpans, (s) => typeof s.attrs?.usagePromptTokens === "number" ? (s.attrs.usagePromptTokens as number) : 0),
      usageCompletionTokens: this.sumBy(aiSpans, (s) => typeof s.attrs?.usageCompletionTokens === "number" ? (s.attrs.usageCompletionTokens as number) : 0),
    };

    const totals = {
      totalRunMs,
      spansRecorded: this.spans.length,
      aiCalls: ai.calls,
      aiTotalMs: ai.totalMs,
      browserCalls: browserSpans.length,
      browserTotalMs: this.sumBy(browserSpans, (s) => s.durationMs ?? 0),
      sandboxCalls: sandboxSpans.length,
      sandboxTotalMs: this.sumBy(sandboxSpans, (s) => s.durationMs ?? 0),
      evidenceCaptures: evidenceSpans.filter((s) => s.op === "capture").length,
      evidenceTotalMs: this.sumBy(evidenceSpans, (s) => s.durationMs ?? 0),
      dbOps: dbSpans.length,
      dbTotalMs: this.sumBy(dbSpans, (s) => s.durationMs ?? 0),
      totalRetries: this.retries.length,
      compactions: this.compactions.length,
    };

    // ── Runtime anomalies ─────────────────────────────────────────────────
    const anomalies: string[] = [];
    for (const s of this.spans) {
      if (s.timeout) anomalies.push(`TIMEOUT: ${s.kind}.${s.op} (${s.durationMs}ms)${s.attrs?.error ? ` — ${String(s.attrs.error).slice(0, 120)}` : ""}`);
    }
    for (const b of browserOps) if (b.timeouts > 0) anomalies.push(`Browser op ${b.op}: ${b.timeouts} timeout(s)`);
    if (ai.timeouts > 0) anomalies.push(`AI timeouts: ${ai.timeouts}`);
    if (ai.retries > 0) anomalies.push(`AI retries: ${ai.retries} (total retry delay tracked in retries table)`);
    // Budget: last snapshot remaining vs elapsed
    const lastBudget = this.budgets[this.budgets.length - 1];
    if (lastBudget) {
      anomalies.push(
        `Last budget snapshot: phase=${lastBudget.phase ?? "?"} elapsed=${lastBudget.elapsedMs}ms remaining=${lastBudget.remainingMs}ms usedAiCalls=${lastBudget.usedAiCalls} usedBrowserActions=${lastBudget.usedBrowserActions}`
      );
      if (lastBudget.remainingMs <= 0) {
        anomalies.push(`Runtime budget was EXHAUSTED at/ before the final snapshot.`);
      }
    }
    // Spans that ended after the deadline (if we have a start and configured budget)
    if (lastBudget && lastBudget.runtimeStartedAt) {
      const deadline = new Date(lastBudget.runtimeStartedAt).getTime() + lastBudget.configuredRuntimeMs;
      const late = this.spans.filter((s) => (s.endedAt ?? 0) > deadline);
      if (late.length > 0) {
        anomalies.push(
          `${late.length} span(s) ended AFTER the runtime deadline (${late
            .slice(0, 10)
            .map((s) => `${s.kind}.${s.op} ${s.durationMs}ms`)
            .join(", ")}…)`
        );
      }
    }
    for (const c of this.compactions) {
      if (c.bytesBefore > c.bytesAfter * 1.2) {
        anomalies.push(
          `Compaction for ${c.op}: ${c.bytesBefore} → ${c.bytesAfter} bytes (${c.durationMs}ms)`
        );
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      totals,
      ai,
      phases,
      aiOps,
      browserOps,
      sandboxOps,
      experiments,
      actions,
      evidenceByType,
      artifactOps,
      dbOps,
      retries: this.retries,
      budgets: this.budgets,
      compactions: this.compactions,
      anomalies,
    };
  }

  /** Human-readable summary matching the profiling report tables. */
  formatReport(): string {
    const r = this.buildReport();
    const lines: string[] = [];
    const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

    lines.push("=== PROFILING REPORT ===");
    lines.push(`Total run: ${fmt(r.totals.totalRunMs)}`);
    lines.push(`AI: ${r.ai.calls} calls, ${fmt(r.ai.totalMs)} total, ${r.ai.estInputTokens} est input tokens, ${r.ai.usagePromptTokens || "-"} provider prompt tokens, ${r.ai.retries} retries, ${r.ai.timeouts} timeouts`);
    lines.push("");
    lines.push("--- Phases ---");
    for (const p of r.phases) {
      lines.push(
        `${p.phase.padEnd(22)} ${fmt(p.durationMs).padStart(8)}  ${String(p.percentOfRuntime).padStart(5)}%  ai=${p.aiCalls}/${fmt(p.aiTimeMs)}  browser=${fmt(p.browserTimeMs)}  evidence=${fmt(p.evidenceTimeMs)}  db=${fmt(p.dbTimeMs)}  retries=${p.retries}${p.ok === false ? "  [FAILED]" : ""}`
      );
    }
    lines.push("");
    lines.push("--- AI ops ---");
    for (const a of r.aiOps) {
      lines.push(
        `${a.op.padEnd(22)} n=${a.calls}  total=${fmt(a.totalMs)}  avg=${fmt(a.avgMs)}  in=${a.estInputTokens}tok  out=${a.estOutputTokens}tok  retries=${a.retries}  ctx=${a.contextBytesBefore}→${a.contextBytesAfter}B  compact=${fmt(a.compactionMs)}`
      );
    }
    lines.push("");
    lines.push("--- Browser ops ---");
    for (const b of r.browserOps) {
      lines.push(`${b.op.padEnd(22)} n=${b.calls}  total=${fmt(b.totalMs)}  avg=${fmt(b.avgMs)}  max=${fmt(b.maxMs)}  retries=${b.retries}  timeouts=${b.timeouts}  fail=${b.failures}`);
    }
    lines.push("");
    lines.push("--- Sandbox ops ---");
    for (const b of r.sandboxOps) {
      lines.push(`${b.op.padEnd(22)} n=${b.calls}  total=${fmt(b.totalMs)}  avg=${fmt(b.avgMs)}  max=${fmt(b.maxMs)}  fail=${b.failures}`);
    }
    lines.push("");
    lines.push("--- Experiments ---");
    for (const e of r.experiments) {
      lines.push(
        `#${e.sequence ?? "?"} ${String(e.objective).slice(0, 60).padEnd(60)} ${fmt(e.durationMs)}  actions=${e.actionsCount}/${fmt(e.actionsMs)}  browser=${fmt(e.browserTimeMs)}  ai=${fmt(e.aiTimeMs)}  evidence=${fmt(e.evidenceTimeMs)}  db=${fmt(e.dbTimeMs)}  retries=${e.retries}  status=${e.status}`
      );
    }
    lines.push("");
    lines.push("--- Top actions (by duration) ---");
    for (const a of r.actions.slice(0, 15)) {
      lines.push(`${a.op.padEnd(22)} ${fmt(a.durationMs).padStart(8)}  ok=${a.ok}  ${a.target}${a.error ? `  ERR: ${a.error}` : ""}`);
    }
    lines.push("");
    lines.push("--- Evidence ---");
    for (const e of r.evidenceByType) {
      lines.push(`${e.type.padEnd(18)} n=${e.count}  capture=${fmt(e.captureTotalMs)}  storage=${fmt(e.storageMs)}  sha=${fmt(e.shaMs)}  bytes=${e.bytes}`);
    }
    lines.push("");
    lines.push("--- Artifact store ops ---");
    for (const a of r.artifactOps) {
      lines.push(`${a.op.padEnd(22)} n=${a.calls}  total=${fmt(a.totalMs)}  avg=${fmt(a.avgMs)}  max=${fmt(a.maxMs)}  bytes=${a.bytes}  fail=${a.failures}`);
    }
    lines.push("");
    lines.push("--- DB ops ---");
    for (const d of r.dbOps) {
      lines.push(`${d.op.padEnd(30)} n=${d.calls}  total=${fmt(d.totalMs)}  avg=${d.avgMs}ms  max=${d.maxMs}ms  payload=${d.payloadBytes}B  fail=${d.failures}`);
    }
    lines.push("");
    lines.push("--- Retries ---");
    if (r.retries.length === 0) lines.push("(none)");
    for (const x of r.retries) {
      lines.push(`[${x.category}] ${x.op} attempt=${x.attempt} delay=${x.delayMs}ms — ${x.why}`);
    }
    lines.push("");
    lines.push("--- Budget snapshots (phase transitions) ---");
    for (const b of r.budgets) {
      lines.push(
        `t=${new Date(b.at).toISOString()} phase=${b.phase} elapsed=${fmt(b.elapsedMs)} remaining=${fmt(b.remainingMs)} exp=${b.usedExperiments} actions=${b.usedBrowserActions} aiCalls=${b.usedAiCalls} aiTok=${b.usedAiTokens}`
      );
    }
    lines.push("");
    lines.push("--- Anomalies ---");
    for (const a of r.anomalies) lines.push(`• ${a}`);
    return lines.join("\n");
  }
}

function numSum(spans: Span[], key: string): number {
  return spans.reduce((s, x) => {
    const v = x.attrs?.[key];
    return s + (typeof v === "number" ? v : 0);
  }, 0);
}

export const profiler = new Profiler();
