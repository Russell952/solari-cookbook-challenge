/**
 * Probe API client.
 *
 * Single source of truth for the API base URL:
 *   - VITE_API_URL (e.g. https://api-probe.onrender.com) in production builds
 *   - relative "/api" otherwise — the Vite dev proxy forwards to localhost:3001
 *
 * Every request (investigations, summary, evidence, SSE, health) goes through
 * this module, so one constant drives all backend traffic.
 */

// Vite statically replaces `import.meta.env.VITE_*` at build time. Accessing
// env through a cast alias (e.g. `(import.meta as X).env`) would defeat that
// replacement and silently fall back to relative URLs in production, so the
// env object is referenced directly here.
const viteEnv = import.meta.env;

/**
 * Production fail-safe: if a production build ships without VITE_API_URL
 * (e.g. the deploy platform env var was not set), fall back to the known
 * deployed backend instead of relative /api paths — a static host has no
 * /api routes, so relative URLs would 404 there. VITE_API_URL always wins
 * when set. Local development is unaffected: `vite` runs in development
 * mode, where the relative base and the dev proxy apply.
 */
const PROD_DEFAULT_API_ORIGIN = "https://api-probe.onrender.com";

const rawBase =
  (viteEnv.VITE_API_URL as string | undefined)?.trim() ||
  (viteEnv.PROD ? PROD_DEFAULT_API_ORIGIN : "");
// Normalizes "https://host" to "https://host/" and strips a trailing /api so
// path construction below can stay `${API_BASE}/api/...` regardless of how the
// deploy platform variable was written.
const API_BASE = rawBase.replace(/\/+$/, "").replace(/\/api$/, "");

/** Absolute API origin ("") for same-origin deployments. */
export const apiOrigin = API_BASE;

/** Base for all Probe API paths. */
const BASE = `${API_BASE}/api`;

// ── Auth token ─────────────────────────────────────────────────────────────
// The API requires a bearer token. The token reaches the client through the
// existing mechanisms, in priority order:
//   1. VITE_PROBE_API_TOKEN — baked in at build time for single-operator
//      deployments where the operator controls the pipeline (never a secret
//      from the server; it is a deployment-time decision).
//   2. localStorage["probe_token"] — entered by the operator in the UI's
//      token prompt (AuthGate) for production use; survives page reloads.
//   3. localStorage["probe_token"] can be replaced at runtime via
//      setProbeToken() — used by the auth gate's save/clear actions.
// The token is a caller identity, not a server-side secret; it never grants
// access to anything beyond that identity's own investigations.
function getAuthToken(): string {
  try {
    return (
      (viteEnv.VITE_PROBE_API_TOKEN as string | undefined) ||
      localStorage.getItem("probe_token") ||
      ""
    );
  } catch {
    return (viteEnv.VITE_PROBE_API_TOKEN as string | undefined) || "";
  }
}

/** Whether an API token is configured (build-time env or stored locally). */
export function probeTokenSet(): boolean {
  return getAuthToken().length > 0;
}

/**
 * Store the API token entered in the UI (localStorage["probe_token"]).
 * Call with an empty string to clear the stored token. Has no effect when
 * VITE_PROBE_API_TOKEN was baked into the build — that identity wins.
 */
export function setProbeToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) localStorage.setItem("probe_token", trimmed);
    else localStorage.removeItem("probe_token");
  } catch {
    // localStorage unavailable (storage disabled) — auth will fail at the API.
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Health endpoint of the configured backend (used by the header indicator). */
export const healthUrl = `${BASE}/health`;

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
      throw new ApiError(
        401,
        "Authentication required — enter your Probe API token to use this deployment"
      );
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
