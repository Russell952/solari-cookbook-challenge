/**
 * Finding → evidence resolution.
 *
 * A finding must reference only evidence that exists, belongs to the same
 * investigation, and is genuinely available to the finding/verification flow.
 * Arbitrary or dangling AI-provided IDs are dropped — there is no generic
 * `evidence.map(e => e.id)` fallback.
 */
import type { Hypothesis, Experiment, Evidence } from "@probe/shared";

/**
 * Resolve the evidence that actually supports a finding.
 *
 * Resolution order:
 *  1. evidence from the verification experiment that independently tested
 *     the finding's hypothesis (strongest — observed, not asserted),
 *  2. evidence referenced by the hypothesis itself,
 *  3. evidence from experiments whose objective the finding text explicitly
 *     cross-references,
 *  4. the investigation's experiment-generated evidence otherwise (never
 *     recon-only evidence, never IDs from other investigations).
 */
export function resolveFindingEvidenceIds(
  findingData: { title?: string; description?: string; rootCause?: string | null },
  ctx: {
    investigationId: string;
    hypothesis?: Hypothesis | null;
    /** Verification experiment that tested ctx.hypothesis, if any. */
    verificationExperimentId?: string | null;
    experiments: Experiment[];
    evidence: Evidence[];
  }
): string[] {
  // Provenance gate: only experiment-generated evidence may support a
  // finding. Recon artifacts (repository_source, recon screenshots/URLs)
  // carry no experimentId — they describe the target, they are not observed
  // behavior. Verified evidence: experimentId must reference an experiment
  // that actually exists in this investigation (the "recon" sentinel id used
  // historically does not, and null means recon by definition).
  const experimentIds = new Set(ctx.experiments.map((e) => e.id));
  const isExperimentEvidence = (e: Evidence): boolean =>
    e.investigationId === ctx.investigationId &&
    e.experimentId !== null &&
    experimentIds.has(e.experimentId);

  const inInvestigation = new Set(
    ctx.evidence.filter((e) => e.investigationId === ctx.investigationId).map((e) => e.id)
  );
  const byId = new Map(ctx.evidence.map((e) => [e.id, e]));

  // Candidate IDs from the most specific available linkage first.
  const candidates: string[] = [];

  // 1. Verification evidence: bytes observed by the independent experiment
  //    that actually tested this hypothesis — not AI assertion.
  if (ctx.verificationExperimentId) {
    candidates.push(
      ...ctx.evidence.filter((e) => e.experimentId === ctx.verificationExperimentId).map((e) => e.id)
    );
  }

  // 2. Evidence the hypothesis itself cites — accepted only when it is
  //    experiment-generated (see the provenance gate above). Recon evidence
  //    may inform analysis, but a finding's behavioral proof must come from
  //    an experiment that observed the application.
  if (ctx.hypothesis) {
    candidates.push(...ctx.hypothesis.supportingEvidenceIds, ...ctx.hypothesis.contradictingEvidenceIds);
  }

  // Evidence from experiments the finding text explicitly cross-references.
  const text = `${findingData.title ?? ""} ${findingData.description ?? ""} ${findingData.rootCause ?? ""}`.toLowerCase();
  if (text) {
    for (const exp of ctx.experiments) {
      const objectiveWords = exp.objective.toLowerCase().split(/\s+/).filter((w) => w.length > 6);
      if (objectiveWords.length > 0 && objectiveWords.some((w) => text.includes(w))) {
        candidates.push(...ctx.evidence.filter((e) => e.experimentId === exp.id).map((e) => e.id));
      }
    }
  }

  // Fall back to the experiment-generated evidence set for this investigation.
  if (candidates.length === 0) {
    candidates.push(
      ...ctx.evidence.filter((e) => isExperimentEvidence(e)).map((e) => e.id)
    );
  }

  // Validate: exists, belongs to this investigation, is experiment-generated
  // (provenance gate — applies to every path, including hypothesis citations),
  // dedupe, keep order.
  const validated: string[] = [];
  for (const id of candidates) {
    const ev = byId.get(id);
    if (!ev || !inInvestigation.has(id) || !isExperimentEvidence(ev)) continue;
    if (!validated.includes(id)) validated.push(id);
  }
  return validated;
}
