/**
 * AI adapter abstraction.
 *
 * Probe must NOT be hard-coded to one AI provider.
 * This interface can be implemented for OpenAI, Anthropic, local models, etc.
 */
import type {
  Investigation,
  RepositoryRecon,
  ApplicationRecon,
  Experiment,
  Observation,
  Hypothesis,
  Finding,
  Evidence,
  PlannedAction,
} from "@probe/shared";

export interface AIPlanResult {
  experiments: {
    objective: string;
    preconditions: string[];
    plannedActions: PlannedAction[];
  }[];
}

export interface AIHypothesisResult {
  statement: string;
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export interface AIVerificationResult {
  shouldVerify: boolean;
  verificationExperiment: {
    objective: string;
    plannedActions: PlannedAction[];
  } | null;
}

export interface AIReportResult {
  summary: string;
  confirmedFindings: Omit<Finding, "id" | "createdAt" | "updatedAt">[];
  rejectedHypotheses: string[];
  inconclusiveHypotheses: string[];
}

export interface AdaptiveDecision {
  /** Whether more investigation is warranted */
  shouldContinue: boolean;
  /** Reason for the decision */
  reason: string;
  /** The next experiment to run, if shouldContinue is true */
  nextExperiment?: {
    objective: string;
    preconditions: string[];
    plannedActions: PlannedAction[];
  };
}

export interface AIAdapter {
  /**
   * Plan initial experiments based on investigation objective and recon data.
   */
  plan(
    objective: string,
    repoRecon: RepositoryRecon | null,
    appRecon: ApplicationRecon | null
  ): Promise<AIPlanResult>;

  /**
   * Decide whether additional investigation is warranted based on collected evidence.
   * Called after each experiment completes and observations are analyzed.
   */
  decideNextStep(
    objective: string,
    experiments: Experiment[],
    evidence: Evidence[],
    analysis: string,
    remainingPrimaryBudget: number,
    remainingActions: number,
    appRecon: ApplicationRecon | null
  ): Promise<AdaptiveDecision>;

  /**
   * Analyze repository recon data to extract insights.
   */
  analyzeRepository(
    repoRecon: RepositoryRecon,
    objective: string
  ): Promise<string>;

  /**
   * Analyze observations from an experiment.
   */
  analyzeObservation(
    observations: Observation[],
    experiment: Experiment,
    objective: string
  ): Promise<string>;

  /**
   * Generate a hypothesis based on analysis.
   */
  generateHypothesis(
    analysis: string,
    evidence: Evidence[],
    objective: string
  ): Promise<AIHypothesisResult>;

  /**
   * Design a verification experiment for a hypothesis.
   */
  designVerification(
    hypothesis: Hypothesis,
    evidence: Evidence[]
  ): Promise<AIVerificationResult>;

  /**
   * Evaluate evidence against a hypothesis.
   */
  evaluateEvidence(
    hypothesis: Hypothesis,
    newEvidence: Evidence[]
  ): Promise<{ confidence: number; status: Hypothesis["status"] }>;

  /**
   * Generate the final investigation report.
   */
  generateReport(
    investigation: Investigation,
    findings: Finding[],
    hypotheses: Hypothesis[],
    experiments: Experiment[],
    evidence: Evidence[]
  ): Promise<AIReportResult>;
}
