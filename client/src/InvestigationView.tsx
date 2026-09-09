import { useState, useEffect, useCallback } from "react";
import {
  getSummary, subscribeToEvents, cancelInvestigation,
  evidenceContentUrl, fetchEvidence,
  type InvestigationSummary, type Finding, type Evidence,
  type SSEEvent, type ExperimentFailure, statusLabel,
} from "./api";
import { InvestigationProgress, TerminalBanner } from "./InvestigationProgress";
import { buildProgressModel } from "./progress";
import { ArrowLeftIcon, CheckIcon } from "./icons";

interface Props {
  investigationId: string;
  onBack: () => void;
}

export function InvestigationView({ investigationId, onBack }: Props) {
  const [summary, setSummary] = useState<InvestigationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingEvidence, setViewingEvidence] = useState<Evidence | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getSummary(investigationId);
      setSummary(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load investigation");
    }
  }, [investigationId]);

  // Load initial data — one consolidated request
  useEffect(() => {
    let mounted = true;
    (async () => {
      await refresh();
      if (mounted) setLoading(false);
    })();
    return () => { mounted = false; };
  }, [investigationId, refresh]);

  // Subscribe to SSE events; every relevant event re-pulls the summary so
  // progress always reflects actual backend state (no fake progress bar).
  useEffect(() => {
    const unsub = subscribeToEvents(investigationId, (event) => {
      setEvents((prev) => [...prev.slice(-199), event]);
      if (
        event.type === "phase_change" ||
        event.type === "experiment_started" ||
        event.type === "experiment_completed" ||
        event.type === "action_completed" ||
        event.type === "hypothesis_proposed" ||
        event.type === "hypothesis_updated" ||
        event.type === "finding_created" ||
        event.type === "evidence_captured" ||
        event.type === "error" ||
        event.type === "complete"
      ) {
        refresh().catch(() => {});
      }
    });
    return unsub;
  }, [investigationId, refresh]);

  if (loading) {
    return (
      <div className="card">
        <div className="loading">Loading investigation...</div>
      </div>
    );
  }

  if (loadError && !summary) {
    return (
      <div className="card">
        <p style={{ color: "var(--danger)" }}>Investigation not found: {loadError}</p>
        <button className="btn btn-secondary" onClick={onBack} style={{ marginTop: "1rem" }}>
          Back
        </button>
      </div>
    );
  }

  if (!summary) return null;

  const inv = summary.investigation;
  const isTerminal = inv.status === "completed" || inv.status === "failed" || inv.status === "cancelled";
  const evidenceById = new Map(summary.evidence.map((e) => [e.id, e]));
  const experimentById = new Map(summary.experiments.map((e) => [e.id, e]));
  const reportFindings = summary.report?.confirmedFindings ?? [];
  const reportFindingIds = new Set(reportFindings.map((f) => f.id));
  const progressModel = buildProgressModel(summary);

  return (
    <div>
      {/* Back + title */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
        <button className="btn btn-secondary" onClick={onBack} style={{ padding: "0.4rem 0.75rem" }}>
          <ArrowLeftIcon aria-hidden="true" /> Back
        </button>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Investigation</h2>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
            {inv.objective}
          </p>
          {inv.applicationUrl && (
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>
              Target: {inv.applicationUrl}
            </p>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className={`status-${inv.status}`} style={{ fontWeight: 500 }}>
            {statusLabel(inv.status as Parameters<typeof statusLabel>[0])}
          </span>
          {inv.status === "running" && (
            <button
              className="btn btn-danger"
              onClick={() => cancelInvestigation(investigationId).catch(() => {})}
              style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem" }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Live progress experience — real phases, counters, and events */}
      <TerminalBanner model={progressModel} />
      <InvestigationProgress summary={summary} events={events} />

      {/* Findings — with evidence provenance */}
      <FindingsSection
        findings={summary.findings}
        evidenceById={evidenceById}
        experimentById={experimentById}
        reportFindingIds={reportFindingIds}
        onInspectEvidence={setViewingEvidence}
      />

      {/* Report — the real generated report */}
      {inv.status === "completed" && summary.report && (
        <ReportSection summary={summary} />
      )}

      {/* Two-column: Experiments + Evidence */}
      <div className="two-col">
        <ExperimentsSection experiments={summary.experiments} probeFailures={summary.probeFailures} />
        <EvidenceSection evidence={summary.evidence} onInspect={setViewingEvidence} />
      </div>

      {viewingEvidence && (
        <EvidenceViewer
          evidence={viewingEvidence}
          onClose={() => setViewingEvidence(null)}
        />
      )}
    </div>
  );
}

// ── Findings with provenance ────────────────────────────────────────────────

function FindingsSection({
  findings,
  evidenceById,
  experimentById,
  reportFindingIds,
  onInspectEvidence,
}: {
  findings: Finding[];
  evidenceById: Map<string, Evidence>;
  experimentById: Map<string, { id: string; sequence: number; objective: string; status: string }>;
  reportFindingIds: Set<string>;
  onInspectEvidence: (ev: Evidence) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="card">
      <div className="card-header">
        <h2>Findings</h2>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {findings.length} · evidence-backed conclusions
        </span>
      </div>
      {findings.map((f) => (
        <div key={f.id} className="finding-card">
          <h3>
            <span className={`severity-${f.severity}`} style={{ marginRight: "0.5rem" }}>
              {f.severity.toUpperCase()}
            </span>
            {f.title}
            {reportFindingIds.has(f.id) && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.7rem", color: "var(--success)", marginLeft: "0.5rem", fontWeight: 400 }}>
                <CheckIcon aria-hidden="true" /> in report
              </span>
            )}
          </h3>
          <div className="finding-meta">
            <span className={`status-${f.status === "draft" ? "created" : f.status}`}>
              {f.status}
            </span>
            <span>Confidence: {Math.round(f.confidence * 100)}%</span>
            <span>{f.evidenceIds.length} supporting evidence</span>
          </div>
          <p>{f.description}</p>
          {f.rootCause && <p style={{ fontStyle: "italic" }}>Root cause: {f.rootCause}</p>}
          {f.recommendation && <p style={{ color: "var(--info)" }}>Recommendation: {f.recommendation}</p>}
          {f.reproductionSteps.length > 0 && (
            <div className="repro-steps">
              <strong>Reproduction:</strong>
              <ol>
                {f.reproductionSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          )}

          {/* Evidence provenance: finding -> evidence -> experiment */}
          <div style={{ marginTop: "0.75rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
            <p style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 0.5rem 0" }}>
              Supporting evidence
            </p>
            {f.evidenceIds.length === 0 ? (
              <p style={{ fontSize: "0.8rem", color: "var(--warning)" }}>
                No evidence referenced for this finding.
              </p>
            ) : (
              f.evidenceIds.map((evId) => {
                const ev = evidenceById.get(evId);
                if (!ev) {
                  // Never substitute another artifact — say it's missing.
                  return (
                    <div key={evId} className="evidence-item" style={{ color: "var(--warning)" }}>
                      <span className="evidence-type">?</span>
                      <span style={{ flex: 1, fontSize: "0.8rem" }}>
                        Evidence {evId.slice(0, 12)}… unavailable (not in this investigation)
                      </span>
                    </div>
                  );
                }
                const exp = ev.experimentId ? experimentById.get(ev.experimentId) : null;
                return (
                  <div key={evId} className="evidence-item">
                    <span className="evidence-type">{ev.type}</span>
                    <span style={{ flex: 1, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                      {exp ? (
                        <>Experiment #{exp.sequence}: {exp.objective}</>
                      ) : (
                        ev.uri || "Reconnaissance"
                      )}
                    </span>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: "0.2rem 0.6rem", fontSize: "0.7rem" }}
                      onClick={() => onInspectEvidence(ev)}
                    >
                      Inspect
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

function ReportSection({ summary }: { summary: InvestigationSummary }) {
  const report = summary.report!;
  const findingTitles = new Set(report.confirmedFindings.map((f) => f.title));

  return (
    <div className="card">
      <div className="card-header">
        <h2>Report</h2>
        <span style={{ fontSize: "0.75rem", color: "var(--success)" }}>
          Generated {new Date(report.createdAt).toLocaleString()}
        </span>
      </div>

      <div className="report-section">
        <h3>Executive Summary</h3>
        <p style={{ fontSize: "0.875rem", lineHeight: 1.5, color: "var(--text-primary)" }}>
          {report.summary}
        </p>
      </div>

      {report.confirmedFindings.length > 0 && (
        <div className="report-section">
          <h3>Application Findings ({report.confirmedFindings.length})</h3>
          {report.confirmedFindings.map((f, i) => (
            <div key={f.id ?? i} className="finding-card" style={{ background: "var(--bg-primary)" }}>
              <h3>
                <span className={`severity-${f.severity}`} style={{ marginRight: "0.5rem" }}>
                  {f.severity.toUpperCase()}
                </span>
                {f.title}
              </h3>
              <p>{f.description}</p>
              {f.recommendation && <p style={{ color: "var(--info)" }}>Recommendation: {f.recommendation}</p>}
            </div>
          ))}
        </div>
      )}

      {report.rejectedHypotheses.length > 0 && (
        <div className="report-section">
          <h3>Rejected Hypotheses ({report.rejectedHypotheses.length})</h3>
          <ul style={{ fontSize: "0.85rem", color: "var(--text-secondary)", paddingLeft: "1.25rem" }}>
            {report.rejectedHypotheses.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}

      {report.inconclusiveHypotheses.length > 0 && (
        <div className="report-section">
          <h3>Inconclusive ({report.inconclusiveHypotheses.length})</h3>
          <ul style={{ fontSize: "0.85rem", color: "var(--text-secondary)", paddingLeft: "1.25rem" }}>
            {report.inconclusiveHypotheses.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}

      {/* Probe/execution limitations — visually distinct from app findings */}
      {summary.probeFailures.length > 0 && (
        <div className="report-section" style={{ borderLeft: "3px solid var(--warning)", paddingLeft: "0.75rem" }}>
          <h3 style={{ color: "var(--warning)" }}>
            Probe / Execution Limitations ({summary.probeFailures.length})
          </h3>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0 0 0.5rem 0" }}>
            These are investigation-infrastructure issues, <strong>not application findings</strong>.
          </p>
          {summary.probeFailures.map((pf, i) => (
            <div key={i} style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.35rem" }}>
              <strong>Experiment #{experimentSeq(summary, pf)}:</strong> {pf.experimentObjective}
              {pf.actionTool && <> — {pf.actionTool}{pf.actionAction ? `/${pf.actionAction}` : ""}</>}
              <span style={{ color: "var(--danger)" }}> — {pf.error}</span>
            </div>
          ))}
        </div>
      )}

      <div className="report-section" style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
        Based on {report.totalExperiments} experiment{report.totalExperiments === 1 ? "" : "s"} and{" "}
        {report.totalEvidence} evidence item{report.totalEvidence === 1 ? "" : "s"}.
        {findingTitles.size === 0 && " No confirmed application findings were produced."}
      </div>
    </div>
  );
}

function experimentSeq(summary: InvestigationSummary, pf: ExperimentFailure): string {
  const exp = summary.experiments.find((e) => e.id === pf.experimentId);
  return exp ? String(exp.sequence) : "?";
}

// ── Experiments ─────────────────────────────────────────────────────────────

function ExperimentsSection({
  experiments,
  probeFailures,
}: {
  experiments: InvestigationSummary["experiments"];
  probeFailures: ExperimentFailure[];
}) {
  const failedExps = new Set(probeFailures.map((pf) => pf.experimentId));
  return (
    <div className="card">
      <div className="card-header">
        <h2>Experiments</h2>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {experiments.length}
        </span>
      </div>
      {experiments.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No experiments yet.</p>
      ) : (
        experiments.map((exp) => (
          <div key={exp.id} className="experiment-item">
            <div className="exp-header">
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                #{exp.sequence}
              </span>
              <span className={`status-${exp.status}`} style={{ fontSize: "0.75rem" }}>
                {exp.status}
                {failedExps.has(exp.id) && " (Probe limitation)"}
              </span>
            </div>
            <p className="exp-objective">{exp.objective}</p>
            {exp.error && (
              <p style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: "0.25rem" }}>
                {exp.error}
              </p>
            )}
            {exp.result && (
              <p style={{ color: "var(--success)", fontSize: "0.8rem", marginTop: "0.25rem" }}>
                {exp.result}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ── Evidence ────────────────────────────────────────────────────────────────

function EvidenceSection({
  evidence,
  onInspect,
}: {
  evidence: InvestigationSummary["evidence"];
  onInspect: (ev: Evidence) => void;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>Evidence</h2>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {evidence.length}
        </span>
      </div>
      {evidence.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No evidence yet.</p>
      ) : (
        evidence.map((ev) => {
          const unavailable = ev.artifactAvailable === false && ev.type !== "url";
          return (
            <div key={ev.id} className="evidence-item">
              <span className="evidence-type">{ev.type}</span>
              <span style={{ flex: 1, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                {ev.uri || (ev.metadata?.pageTitle as string | undefined) || ev.id.slice(0, 12)}
              </span>
              {unavailable && (
                <span style={{ fontSize: "0.7rem", color: "var(--warning)" }}>artifact missing</span>
              )}
              <button
                className="btn btn-secondary"
                style={{ padding: "0.2rem 0.6rem", fontSize: "0.7rem" }}
                onClick={() => onInspect(ev)}
                disabled={ev.type === "url"}
                title={ev.type === "url" ? ev.uri ?? undefined : "View artifact"}
              >
                {ev.type === "url" ? "Link" : "View"}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Evidence viewer modal ───────────────────────────────────────────────────

function EvidenceViewer({ evidence, onClose }: { evidence: Evidence; onClose: () => void }) {
  const url = evidenceContentUrl(evidence.id);
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isImage = evidence.type === "screenshot";
  const isJson = evidence.type === "action_trace" || evidence.type === "repository_source";
  // Solari replays are rrweb NDJSON event streams, not video — render the
  // first events readably and offer the raw artifact, never a <video> player.
  const isReplay = evidence.type === "replay";
  const isNdjsonReplay = isReplay && evidence.metadata?.format === "rrweb";

  // All artifact fetches go through fetchEvidence so the Authorization
  // header is attached; screenshots render from a blob URL (an <img src>
  // cannot authenticate).
  useEffect(() => {
    let mounted = true;
    let blobUrl: string | null = null;
    if (isImage) {
      fetchEvidence(`evidence/${evidence.id}/content`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => {
          if (!mounted) return;
          blobUrl = URL.createObjectURL(b);
          setImageUrl(blobUrl);
        })
        .catch((e) => { if (mounted) setError(e.message); });
    } else if (isJson) {
      fetchEvidence(`evidence/${evidence.id}/content`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((d) => { if (mounted) setText(JSON.stringify(d, null, 2)); })
        .catch((e) => { if (mounted) setError(e.message); });
    }
    return () => {
      mounted = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [evidence.id, isImage, isJson]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: "min(900px, 92vw)", maxHeight: "85vh", overflowY: "auto", width: "100%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <h2>
            <span className="evidence-type" style={{ marginRight: "0.5rem" }}>{evidence.type}</span>
            Evidence
          </h2>
          <button className="btn btn-secondary" style={{ padding: "0.25rem 0.6rem" }} onClick={onClose}>
            Close
          </button>
        </div>

        <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0 0 0.75rem 0" }}>
          {evidence.metadata?.pageTitle ? `${evidence.metadata.pageTitle} · ` : ""}
          {evidence.uri ? `${evidence.uri} · ` : ""}
          SHA-256 {String(evidence.contentHash ?? "").slice(0, 16)}…
        </p>

        {isImage && imageUrl && (
          <img
            src={imageUrl}
            alt={`Evidence screenshot ${evidence.id}`}
            style={{ maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 4 }}
          />
        )}

        {isJson && text && (
          <pre style={{
            background: "var(--bg-primary)", padding: "0.75rem", borderRadius: 4,
            fontSize: "0.75rem", overflowX: "auto", maxHeight: "50vh", overflowY: "auto",
          }}>
            {text}
          </pre>
        )}

        {isReplay && (
          <div>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0 0 0.5rem 0" }}>
              {isNdjsonReplay
                ? "rrweb session recording (NDJSON event stream — DOM-level, not video). First events shown; download for the full recording."
                : "Session recording (NDJSON event stream). First events shown; download for the full recording."}
            </p>
            <ReplayPreview evidenceId={evidence.id} />
          </div>
        )}

        {!isImage && !isJson && !isReplay && (
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            This evidence type ({evidence.type}) has no inline viewer.
            <a href={url} download style={{ color: "var(--info)", marginLeft: "0.5rem" }}>
              Download artifact
            </a>
          </p>
        )}

        {error && (
          <p style={{ fontSize: "0.85rem", color: "var(--danger)" }}>
            Artifact could not be loaded: {error}
          </p>
        )}

        <div style={{ marginTop: "0.75rem", fontSize: "0.75rem" }}>
          <a href={url} download style={{ color: "var(--info)" }}>
            Download artifact
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetches an rrweb NDJSON replay and renders its first events as readable
 * JSON — DOM-level recordings are event streams, not playable video.
 *
 * Takes the evidence id and fetches through the API layer's authenticated
 * path — never by string-rewriting a URL (a `.replace("/api", …)` would
 * corrupt an absolute production base like https://api-probe.onrender.com).
 */
function ReplayPreview({ evidenceId }: { evidenceId: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Authenticated fetch through the API layer (Authorization header attached).
    const req = fetchEvidence(`evidence/${evidenceId}/content`);
    req
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((body) => {
        if (!alive) return;
        const lines = body.split("\n").filter((l) => l.trim().length > 0);
        setEventCount(lines.length);
        const head = lines.slice(0, 5).map((l, idx) => {
          try {
            const ev = JSON.parse(l) as { type?: number; timestamp?: number; data?: { source?: number } };
            const typeNames: Record<number, string> = { 0: "DomContentLoaded", 1: "Load", 2: "FullSnapshot", 3: "IncrementalSnapshot", 4: "Meta", 5: "Custom" };
            const typ = ev.type ?? -1;
            return `#${idx} ${typeNames[typ] ?? `type:${typ}`}${ev.data?.source != null ? ` (source ${ev.data.source})` : ""} @ ${ev.timestamp ?? "?"}`;
          } catch {
            return l.slice(0, 60);
          }
        });
        setPreview(head.join("\n"));
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [evidenceId]);

  if (err) return <p style={{ fontSize: "0.85rem", color: "var(--danger)" }}>Replay could not be loaded: {err}</p>;
  if (preview === null) return <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>Loading replay…</p>;
  return (
    <div>
      <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "0 0 0.25rem 0" }}>
        {eventCount ?? "?"} rrweb events captured
      </p>
      <pre style={{
        background: "var(--bg-primary)", padding: "0.75rem", borderRadius: 4,
        fontSize: "0.75rem", overflowX: "auto", whiteSpace: "pre-wrap",
      }}>
        {preview}
      </pre>
    </div>
  );
}
