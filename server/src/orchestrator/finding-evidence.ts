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

  // 2. Evidence the hypothesis itself cites (validated below against the
  //    investigation's evidence set).
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
      ...ctx.evidence
        .filter((e) => e.experimentId !== null && e.investigationId === ctx.investigationId)
        .map((e) => e.id)
    );
  }

  // Validate: exists, belongs to this investigation, dedupe, keep order.
  const validated: string[] = [];
  for (const id of candidates) {
    if (!inInvestigation.has(id)) continue;
    if (!byId.has(id)) continue;
    if (!validated.includes(id)) validated.push(id);
  }
  return validated;
}
