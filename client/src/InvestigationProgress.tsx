/**
 * InvestigationProgress — live progress UI for a running (or terminal)
 * investigation.
 *
 * Everything rendered is derived from the real backend summary via
 * buildProgressModel(): a phase-mapped stage stepper, truthful activity line,
 * real counters, actual evidence-type breakdown, and the real experiment
 * checklist. No percentages, no invented activity, no emoji icons.
 */
import { CheckIcon, CrossIcon, DotIcon, CircleIcon, BanIcon, AlertIcon } from "./icons";
import {
  buildProgressModel,
  formatEventType,
  type StageViewState,
  type ProgressModel,
} from "./progress";
import type { InvestigationSummary, SSEEvent } from "./api";

interface Props {
  summary: InvestigationSummary;
  /** Live events from the existing SSE subscription (display only). */
  events: SSEEvent[];
}

export function InvestigationProgress({ summary, events }: Props) {
  const model = buildProgressModel(summary);
  return (
    <div className="progress-grid">
      <div className="card progress-stages" aria-label="Investigation progress">
        <div className="progress-stages-header">
          <h2>Progress</h2>
          {model.isRunning && (
            <span className="progress-live" role="status">
              <span className="conn-dot conn-dot-ok progress-live-dot" aria-hidden="true" />
              Live
            </span>
          )}
        </div>
        <ol className="stage-list">
          {model.stages.map((stage) => (
            <StageRow key={stage.phase} stage={stage} />
          ))}
        </ol>
      </div>

      <div className="progress-side">
        <div className="card progress-activity">
          <h2>{model.stageLabel}</h2>
          <p className="progress-activity-line">{model.activity}</p>

          {model.hasCurrentExperiment && !model.terminal && (
            <p className="progress-current-exp">
              {model.currentExperimentPosition && (
                <span className="progress-exp-position">
                  Experiment {model.currentExperimentPosition}
                </span>
              )}
              <span className="progress-exp-objective">{model.currentExperimentObjective}</span>
            </p>
          )}

          {model.reportContext.length > 0 && (
            <ul className="progress-report-context">
              {model.reportContext.map((line) => (
                <li key={line}>
                  <CheckIcon aria-hidden="true" /> {line}
                </li>
              ))}
            </ul>
          )}

          <div className="progress-metrics">
            {model.metrics.map((m) => (
              <div key={m.label} className="progress-metric">
                <span className="progress-metric-value">{m.value}</span>
                <span className="progress-metric-label">{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        {model.evidenceBreakdown.length > 0 && (
          <div className="card progress-evidence">
            <h2>Evidence collected</h2>
            <ul className="progress-evidence-list">
              {model.evidenceBreakdown.map((e) => (
                <li key={e.type}>
                  <span className="evidence-type">{e.type}</span>
                  <span className="progress-evidence-count">{e.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {model.experimentList.length > 0 && (
          <div className="card progress-experiments">
            <h2>Experiments</h2>
            <ol className="progress-exp-list">
              {model.experimentList.map((e) => (
                <li key={e.sequence} className={`progress-exp progress-exp-${e.state}`}>
                  <span className="progress-exp-marker" aria-hidden="true">
                    {e.state === "completed" && <CheckIcon size={11} />}
                    {e.state === "running" && <DotIcon size={9} className="progress-pulse" />}
                    {e.state === "failed" && <CrossIcon size={11} />}
                    {e.state === "inconclusive" && <CircleIcon size={9} />}
                    {e.state === "pending" && <CircleIcon size={9} />}
                  </span>
                  <span className="progress-exp-seq">#{e.sequence}</span>
                  <span className="progress-exp-objective" title={e.objective}>
                    {e.objective}
                  </span>
                  {e.state === "failed" && (
                    <span className="progress-exp-note">Probe limitation</span>
                  )}
                  {e.state === "inconclusive" && (
                    <span className="progress-exp-note">Inconclusive result</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {events.length > 0 && (
          <div className="card progress-events">
            <h2>Recent activity</h2>
            <ul className="progress-event-list">
              {events.slice(-6).map((evt, i) => (
                <li key={`${evt.timestamp}-${i}`}>
                  <span className="progress-event-type">{formatEventType(evt.type)}</span>
                  {evt.data.error != null && (
                    <span className="progress-event-error">{String(evt.data.error)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function StageRow({ stage }: { stage: StageViewState }) {
  return (
    <li className={`stage-row stage-${stage.state}`}>
      <span className="stage-marker" aria-hidden="true">
        {stage.state === "completed" && <CheckIcon size={13} />}
        {stage.state === "current" && <DotIcon size={11} className="progress-pulse" />}
        {stage.state === "pending" && <CircleIcon size={10} />}
        {stage.state === "failed" && <CrossIcon size={13} />}
        {stage.state === "cancelled" && <BanIcon size={12} />}
      </span>
      <span className="stage-label">{stage.label}</span>
      <span className="stage-visually-hidden">
        {stage.state === "current"
          ? "(current stage)"
          : stage.state === "completed"
            ? "(completed)"
            : stage.state === "failed"
              ? "(failed)"
              : stage.state === "cancelled"
                ? "(cancelled)"
                : ""}
      </span>
    </li>
  );
}

/**
 * Compact terminal banner for failed/cancelled — factual, visually distinct
 * from application findings, and never presented as success.
 */
export function TerminalBanner({ model }: { model: ProgressModel }) {
  if (model.terminal !== "failed" && model.terminal !== "cancelled") return null;
  return (
    <div
      className={`card progress-terminal progress-terminal-${model.terminal}`}
      role="status"
    >
      <h3>
        {model.terminal === "failed" ? (
          <>
            <AlertIcon aria-hidden="true" /> Investigation failed
          </>
        ) : (
          <>
            <BanIcon aria-hidden="true" /> Investigation cancelled
          </>
        )}
      </h3>
      <p>
        {model.terminal === "failed"
          ? "The investigation ended with an execution error before a report could be produced. This is a Probe infrastructure failure, not an application finding."
          : "This investigation was cancelled before completion. Partial data below is not a confirmed result — no report exists."}
      </p>
    </div>
  );
}
