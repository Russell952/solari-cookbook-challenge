/**
 * Probe API client.
 * All calls go through the Vite proxy to /api.
 */

const BASE = "/api";

// ── Auth token ─────────────────────────────────────────────────────────────
// The API requires a bearer token. Development convenience: read it from
// Vite env (VITE_PROBE_API_TOKEN, set in .env.local / dev shell) or the
// `probe_token` localStorage key. Production deployments should serve the
// app behind the same origin and inject the token per deployment policy.
interface ProbeViteEnv {
  env?: Record<string, string | undefined>;
}
const viteEnv: ProbeViteEnv =
  typeof import.meta !== "undefined" ? (import.meta as unknown as ProbeViteEnv) : { env: undefined };

function getAuthToken(): string {
  try {
    return (
      viteEnv.env?.VITE_PROBE_API_TOKEN ||
      localStorage.getItem("probe_token") ||
      ""
    );
  } catch {
    return viteEnv.env?.VITE_PROBE_API_TOKEN || "";
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeaders((options?.headers as Record<string, string>) || undefined),
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError(401, "Unauthorized — set your API token (probe_token in localStorage or VITE_PROBE_API_TOKEN)");
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Authorized fetch for evidence artifacts (returns the raw Response). */
export async function fetchEvidence(path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  return res;
}

// ── Types (mirror shared/src/types.ts) ────────────────────────────────────

export type InvestigationStatus =
  | "created" | "running" | "paused" | "cancelled" | "completed" | "failed";

export type InvestigationPhase =
  | "created" | "recon" | "plan" | "experiment" | "execute"
  | "observe" | "analyze" | "hypothesis" | "verification"
  | "confirmed" | "rejected" | "inconclusive" | "report" | "complete";

export interface Investigation {
  id: string;
  repositoryUrl: string;
  applicationUrl: string;
  objective: string;
  status: InvestigationStatus;
  currentPhase: InvestigationPhase;
  createdAt: string;
  updatedAt: string;
}

export interface Experiment {
  id: string;
  investigationId: string;
  sequence: number;
  objective: string;
  hypothesisId: string | null;
  status: string;
  preconditions: string[];
  plannedActions: unknown[];
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Finding {
  id: string;
  investigationId: string;
  title: string;
  severity: string;
  description: string;
  status: string;
  confidence: number;
  rootCause: string | null;
  reproductionSteps: string[];
  recommendation: string | null;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  investigationId: string;
  experimentId: string | null;
  observationId: string | null;
  type: string;
  uri: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SSEEvent {
  type: string;
  investigationId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface CreateInvestigationInput {
  repositoryUrl: string;
  applicationUrl: string;
  objective: string;
}

/**
 * Consolidated investigation summary — mirrors the backend's
 * GET /api/investigations/:id/summary response shape.
 */
export interface ExperimentFailure {
  experimentId: string;
  experimentObjective: string;
  actionId: string | null;
  actionTool: string | null;
  actionAction: string | null;
  error: string;
}

export interface InvestigationSummary {
  investigation: Investigation;
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
  evidence: Array<
    Evidence & { artifactAvailable?: boolean; mimeType?: string; byteSize?: number }
  >;
  evidenceCount: number;
  findings: Finding[];
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
    confirmedFindings: Finding[];
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
  probeFailures: ExperimentFailure[];
  runtime: {
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
  } | null;
  incomplete: boolean;
}

// ── API Functions ──────────────────────────────────────────────────────────

export function createInvestigation(input: CreateInvestigationInput): Promise<Investigation> {
  return request("/investigations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listInvestigations(): Promise<Investigation[]> {
  return request("/investigations");
}

export function getInvestigation(id: string): Promise<Investigation> {
  return request(`/investigations/${id}`);
}

export function startInvestigation(id: string): Promise<{ message: string; id: string }> {
  return request(`/investigations/${id}/start`, { method: "POST" });
}

export function pauseInvestigation(id: string): Promise<{ message: string }> {
  return request(`/investigations/${id}/pause`, { method: "POST" });
}

export function resumeInvestigation(id: string): Promise<{ message: string }> {
  return request(`/investigations/${id}/resume`, { method: "POST" });
}

export function cancelInvestigation(id: string): Promise<{ message: string }> {
  return request(`/investigations/${id}/cancel`, { method: "POST" });
}

/**
 * Primary source for the investigation detail view: one request returning
 * investigation, experiments, evidence, findings, hypotheses, report,
 * budget, probe failures, and runtime.
 */
export function getSummary(investigationId: string): Promise<InvestigationSummary> {
  return request(`/investigations/${investigationId}/summary`);
}

/**
 * URL of the persisted artifact bytes for an evidence item.
 * NOTE: an <img src> cannot carry Authorization headers — evidence viewers
 * must fetch via fetchEvidence() and render blobs, not raw URLs.
 */
export function evidenceContentUrl(evidenceId: string): string {
  return `${BASE}/evidence/${evidenceId}/content`;
}

export function listExperiments(investigationId: string): Promise<Experiment[]> {
  return request(`/investigations/${investigationId}/experiments`);
}

export function listFindings(investigationId: string): Promise<Finding[]> {
  return request(`/investigations/${investigationId}/findings`);
}

export function listEvidence(investigationId: string): Promise<Evidence[]> {
  return request(`/investigations/${investigationId}/evidence`);
}

/**
 * Subscribe to SSE events for an investigation via fetch-streaming —
 * EventSource cannot send an Authorization header, and the events endpoint
 * is authenticated. Returns a cleanup function.
 */
export function subscribeToEvents(
  investigationId: string,
  onEvent: (event: SSEEvent) => void
): () => void {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/investigations/${investigationId}/events`, {
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            onEvent(JSON.parse(line.slice(6)) as SSEEvent);
          } catch {
            // ignore malformed events
          }
        }
      }
    } catch {
      // aborted or network failure — cleanup handles the rest
    }
  })();

  return () => controller.abort();
}

// ── Phase display helpers ──────────────────────────────────────────────────

export const PHASE_ORDER: InvestigationPhase[] = [
  "recon", "plan", "experiment", "execute", "observe",
  "analyze", "hypothesis", "verification", "report", "complete",
];

export function phaseIndex(phase: InvestigationPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export function phaseLabel(phase: InvestigationPhase): string {
  const labels: Record<string, string> = {
    created: "Created",
    recon: "Reconnaissance",
    plan: "Planning",
    experiment: "Experiments",
    execute: "Execute",
    observe: "Observe",
    analyze: "Analysis",
    hypothesis: "Hypothesis",
    verification: "Verification",
    confirmed: "Confirmed",
    rejected: "Rejected",
    inconclusive: "Inconclusive",
    report: "Report",
    complete: "Complete",
  };
  return labels[phase] || phase;
}

export function statusLabel(status: InvestigationStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
