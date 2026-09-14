/**
 * Investigation summary endpoint.
 *
 * GET /api/investigations/:id/summary
 *
 * Returns a consolidated view of an investigation including experiments,
 * evidence, findings, hypotheses, and report in a single response.
 */
import { Router, type Request, type Response } from "express";
import { store } from "../store/index.js";
import { param } from "./helpers.js";
import { getBudget } from "../orchestrator/budget.js";

export const summaryRouter = Router({ mergeParams: true });

/** The authenticated caller's owner id (set by requireAuth). */
function ownerIdOf(req: Request): string {
  return (req as Request & { ownerId?: string }).ownerId ?? "";
}

/**
 * Provenance class of an evidence item — how it was actually produced:
 *  - "recon":       reconnaissance capture (no experimentId — repository
 *                   source, recon screenshot/URL). Legitimate context
 *                   evidence, but NOT behavioral proof.
 *  - "verification": produced by an experiment that tested a hypothesis
 *                   (verification experiments carry a hypothesisId).
 *  - "experiment":  produced by a normal experiment.
 */
type EvidenceProvenance = "recon" | "experiment" | "verification";

function evidenceProvenance(
  ev: { experimentId: string | null },
  experimentsById: Map<string, { hypothesisId: string | null }>
): EvidenceProvenance {
  if (ev.experimentId === null) return "recon";
  const exp = experimentsById.get(ev.experimentId);
  if (!exp) return "recon"; // sentinel/unknown ids — treat as recon, not proof
  return exp.hypothesisId ? "verification" : "experiment";
}

interface SummaryResponse {
  investigation: {
    id: string;
    repositoryUrl: string;
    applicationUrl: string;
    objective: string;
    status: string;
    currentPhase: string;
    createdAt: string;
    updatedAt: string;
  };
  experiments: Array<{
    id: string;
    sequence: number;
    objective: string;
    status: string;
    result: string | null;
    error: string | null;
  }>;
  experimentCounts: {
    total: number;
    completed: number;
    failed: number;
    planned: number;
    running: number;
    inconclusive: number;
    cancelled: number;
  };
  evidence: Array<{
    id: string;
    type: string;
    investigationId: string;
    experimentId: string | null;
    observationId: string | null;
    uri: string | null;
    contentHash: string | null;
    /** How the evidence was produced: recon | experiment | verification. */
    provenance: EvidenceProvenance;
    /** Whether persisted artifact bytes exist (absent = legacy record). */
    artifactAvailable?: boolean;
    mimeType?: string;
    byteSize?: number;
    createdAt: string;
  }>;
  evidenceCount: number;
  findings: Array<{
    id: string;
    title: string;
    severity: string;
    description: string;
    status: string;
    confidence: number;
    rootCause: string | null;
    recommendation: string | null;
    reproductionSteps: string[];
    evidenceIds: string[];
    createdAt: string;
  }>;
  findingsCount: number;
  hypotheses: Array<{
    id: string;
    statement: string;
    status: string;
    confidence: number;
    createdAt: string;
  }>;
  hypothesesCount: number;
  report: {
    id: string;
    summary: string;
    confirmedFindings: Array<{
      id: string;
      title: string;
      severity: string;
      description: string;
      recommendation: string | null;
    }>;
    rejectedHypotheses: string[];
    inconclusiveHypotheses: string[];
    totalExperiments: number;
    totalEvidence: number;
    createdAt: string;
  } | null;
  budget: {
    usedExperiments: number;
    usedBrowserActions: number;
    usedSandboxCommands: number;
    usedAiCalls: number;
    usedVerificationExperiments: number;
    maxExperiments: number;
    maxBrowserActions: number;
    maxSandboxCommands: number;
    maxAiCalls: number;
    verificationReserve: number;
  };
  probeFailures: Array<{
    experimentId: string;
    experimentObjective: string;
    actionId: string | null;
    actionTool: string | null;
    actionAction: string | null;
    error: string;
  }>;
  runtime: {
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
  } | null;
  incomplete: boolean;
  /** Structured stop reason when the run ended without completing cleanly. */
  failure: {
    reason: string;
    message: string;
    phase: string | null;
    at: string;
  } | null;
}

summaryRouter.get("/", (req: Request, res: Response) => {
  const id = param(req, "id");
  const investigation = store.getInvestigation(id);

  if (!investigation || store.getOwner(id) !== ownerIdOf(req)) {
    res.status(404).json({ error: "Investigation not found" });
    return;
  }

  const experiments = store.listExperiments(id);
  const evidence = store.listEvidence(id);
  const findings = store.listFindings(id);
  const hypotheses = store.listHypotheses(id);
  const report = store.getReport(id);
  const budgetData = getBudget(id);

  const experimentsById = new Map(
    experiments.map((e) => [e.id, { hypothesisId: e.hypothesisId }])
  );
  const provenanceOf = (ev: { experimentId: string | null }): EvidenceProvenance =>
    evidenceProvenance(ev, experimentsById);

  const experimentCounts = {
    total: experiments.length,
    completed: experiments.filter((e) => e.status === "completed").length,
    failed: experiments.filter((e) => e.status === "failed").length,
    planned: experiments.filter((e) => e.status === "planned").length,
    running: experiments.filter((e) => e.status === "running").length,
    inconclusive: experiments.filter((e) => e.status === "inconclusive").length,
    cancelled: experiments.filter((e) => e.status === "cancelled").length,
  };

  // Collect probe/execution failures from experiments (deduped by
  // experiment + error, so a repeated poll can't double-report).
  const seenErrors = new Set<string>();
  const uniqueProbeFailures: SummaryResponse["probeFailures"] = [];
  for (const exp of experiments) {
    if (!exp.error) continue;
    const key = `${exp.id}:${exp.error}`;
    if (seenErrors.has(key)) continue;
    seenErrors.add(key);
    uniqueProbeFailures.push({
      experimentId: exp.id,
      experimentObjective: exp.objective,
      actionId: null,
      actionTool: null,
      actionAction: null,
      error: exp.error,
    });
  }

  const reportData = report
    ? {
        id: report.id,
        summary: report.summary,
        confirmedFindings: report.confirmedFindings.map((f) => ({
          id: f.id,
          title: f.title,
          severity: f.severity,
          description: f.description,
          recommendation: f.recommendation,
        })),
        rejectedHypotheses: report.rejectedHypotheses,
        inconclusiveHypotheses: report.inconclusiveHypotheses,
        totalExperiments: report.totalExperiments,
        totalEvidence: report.totalEvidence,
        createdAt: report.createdAt,
      }
    : null;

  // Compute runtime info. durationMs is ONLY meaningful once the run is
  // terminal: while running, updatedAt keeps advancing (phase checkpoints),
  // and the client prefers durationMs over its own live now−startedAt tick,
  // so a non-null duration here froze the UI timer at the last fetch
  // (live regression: 01:54 for a 114s run that kept ticking only on
  // refetch). While running, duration is null and the client derives
  // runtime from startedAt each second.
  const startTs = investigation.createdAt ? new Date(investigation.createdAt).getTime() : null;
  const isTerminal =
    investigation.status === "completed" ||
    investigation.status === "failed" ||
    investigation.status === "cancelled";
  const endTs = isTerminal && investigation.updatedAt ? new Date(investigation.updatedAt).getTime() : null;
  const durationMs = startTs && endTs ? endTs - startTs : null;

  const response: SummaryResponse = {
    investigation: {
      id: investigation.id,
      repositoryUrl: investigation.repositoryUrl,
      applicationUrl: investigation.applicationUrl,
      objective: investigation.objective,
      status: investigation.status,
      currentPhase: investigation.currentPhase,
      createdAt: investigation.createdAt,
      updatedAt: investigation.updatedAt,
    },
    experiments: experiments.map((e) => ({
      id: e.id,
      sequence: e.sequence,
      objective: e.objective,
      status: e.status,
      result: e.result,
      error: e.error,
      hypothesisId: e.hypothesisId ?? null,
    })),
    experimentCounts,
    evidence: evidence.map((e) => ({
      id: e.id,
      type: e.type,
      investigationId: e.investigationId,
      experimentId: e.experimentId,
      observationId: e.observationId,
      uri: e.uri,
      contentHash: e.contentHash,
      provenance: provenanceOf(e),
      // Truthful artifact availability from the collector's capture-time
      // record (metadata.artifactAvailable). Passed through as-is: absent for
      // legacy records, false for replay-unavailable/url evidence — the UI
      // must never offer a download for bytes that were never stored.
      artifactAvailable: e.metadata?.artifactAvailable as boolean | undefined,
      mimeType: e.metadata?.mimeType as string | undefined,
      byteSize: e.metadata?.byteSize as number | undefined,
      createdAt: e.createdAt,
    })),
    evidenceCount: evidence.length,
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      description: f.description,
      status: f.status,
      confidence: f.confidence,
      rootCause: f.rootCause,
      recommendation: f.recommendation,
      reproductionSteps: f.reproductionSteps,
      evidenceIds: f.evidenceIds,
      createdAt: f.createdAt,
    })),
    findingsCount: findings.length,
    hypotheses: hypotheses.map((h) => ({
      id: h.id,
      statement: h.statement,
      status: h.status,
      confidence: h.confidence,
      createdAt: h.createdAt,
    })),
    hypothesesCount: hypotheses.length,
    report: reportData,
    budget: {
      usedExperiments: budgetData.usedExperiments,
      usedBrowserActions: budgetData.usedBrowserActions,
      usedSandboxCommands: budgetData.usedSandboxCommands,
      usedAiCalls: budgetData.usedAiCalls,
      usedVerificationExperiments: budgetData.usedVerificationExperiments,
      maxExperiments: budgetData.maxExperiments,
      maxBrowserActions: budgetData.maxBrowserActions,
      maxSandboxCommands: budgetData.maxSandboxCommands,
      maxAiCalls: budgetData.maxAiCalls,
      verificationReserve: budgetData.verificationReserve,
    },
    probeFailures: uniqueProbeFailures,
    runtime: startTs !== null
      ? {
          startedAt: investigation.createdAt,
          completedAt: isTerminal ? investigation.updatedAt : null,
          // null while running: the client derives live runtime from
          // startedAt each second (a fetch-time duration froze the timer).
          durationMs,
        }
      : null,
    incomplete: investigation.status !== "completed" && investigation.status !== "failed",
    failure: investigation.failure
      ? {
          reason: investigation.failure.reason,
          message: investigation.failure.message,
          phase: investigation.failure.phase ?? null,
          at: investigation.failure.at,
        }
      : null,
  };

  res.json(response);
});
