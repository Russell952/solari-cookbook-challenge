/**
 * Frontend data-flow tests.
 *
 * The client has no DOM test infrastructure (no jsdom/testing-library in the
 * workspace), so these exercise the production data layer that the
 * investigation view consumes: getSummary() against a stubbed fetch, the
 * evidence content URL used for screenshots/traces/replays, and error
 * propagation for terminal/failing states.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Minimal InvestigationSummary fixture mirroring the backend response
const summaryFixture = {
  investigation: {
    id: "inv_1",
    repositoryUrl: "",
    applicationUrl: "https://example.com",
    objective: "Verify the login flow",
    status: "completed",
    currentPhase: "complete",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:01:00.000Z",
  },
  experiments: [
    { id: "exp_1", sequence: 1, objective: "Login flow", status: "completed", result: "ok", error: null },
    { id: "exp_2", sequence: 2, objective: "Verify: login flow", status: "completed", result: "ok", error: null },
  ],
  experimentCounts: { total: 2, completed: 2, failed: 0, planned: 0, running: 0, inconclusive: 0, cancelled: 0 },
  evidence: [
    {
      id: "ev_1", investigationId: "inv_1", experimentId: "exp_1", observationId: null,
      type: "screenshot", uri: null, contentHash: "abc123", metadata: { artifactAvailable: true },
      createdAt: "2026-09-06T00:00:10.000Z",
    },
    {
      id: "ev_2", investigationId: "inv_1", experimentId: "exp_1", observationId: null,
      type: "url", uri: "https://example.com/login", contentHash: null, metadata: {},
      createdAt: "2026-09-06T00:00:11.000Z",
    },
  ],
  evidenceCount: 2,
  findings: [
    {
      id: "fnd_1", investigationId: "inv_1", title: "Login renders as documented",
      severity: "info", description: "d", status: "confirmed", confidence: 0.95,
      rootCause: null, reproductionSteps: [], recommendation: null,
      evidenceIds: ["ev_1"], createdAt: "2026-09-06T00:00:50.000Z", updatedAt: "2026-09-06T00:00:50.000Z",
    },
  ],
  findingsCount: 1,
  hypotheses: [
    { id: "hyp_1", statement: "Login renders as documented", status: "confirmed", confidence: 0.95, createdAt: "2026-09-06T00:00:40.000Z" },
  ],
  hypothesesCount: 1,
  report: {
    id: "rpt_1",
    summary: "Executive summary text",
    confirmedFindings: [
      {
        id: "fnd_1", investigationId: "inv_1", title: "Login renders as documented",
        severity: "info", description: "d", status: "confirmed", confidence: 0.95,
        rootCause: null, reproductionSteps: [], recommendation: null,
        evidenceIds: ["ev_1"], createdAt: "2026-09-06T00:00:50.000Z", updatedAt: "2026-09-06T00:00:50.000Z",
      },
    ],
    rejectedHypotheses: [],
    inconclusiveHypotheses: [],
    totalExperiments: 2,
    totalEvidence: 2,
    createdAt: "2026-09-06T00:01:00.000Z",
  },
  budget: {
    usedExperiments: 2, usedBrowserActions: 4, usedSandboxCommands: 0, usedAiCalls: 6,
    usedVerificationExperiments: 1, maxExperiments: 7, maxBrowserActions: 40,
    maxSandboxCommands: 20, maxAiCalls: 20, verificationReserve: 2,
  },
  probeFailures: [],
  runtime: { startedAt: "2026-09-06T00:00:00.000Z", completedAt: "2026-09-06T00:01:00.000Z", durationMs: 60000 },
  incomplete: false,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    json: async () => body,
  } as unknown as Response;
}

describe("client data flow: getSummary", () => {
  it("fetches the consolidated summary from /summary and returns typed data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(summaryFixture));

    const { getSummary } = await import("../api.js");
    const summary = await getSummary("inv_1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/investigations/inv_1/summary",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) })
    );

    // Data the UI relies on is present and coherent
    expect(summary.investigation.status).toBe("completed");
    expect(summary.findingsCount).toBe(1);
    expect(summary.report?.confirmedFindings[0].evidenceIds).toEqual(["ev_1"]);
    expect(summary.evidenceCount).toBe(summary.evidence.length);
    expect(summary.incomplete).toBe(false);
  });

  it("propagates 404 errors for a missing investigation (client must not infer success)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Investigation not found" }, 404));

    const { getSummary } = await import("../api.js");
    await expect(getSummary("inv_missing")).rejects.toThrow("Investigation not found");
  });

  it("cancelled investigations still return a summary flagged incomplete with no report", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...summaryFixture,
        investigation: { ...summaryFixture.investigation, status: "cancelled", currentPhase: "hypothesis" },
        report: null,
        findings: [],
        findingsCount: 0,
        hypothesesCount: 0,
        incomplete: true,
      })
    );

    const { getSummary } = await import("../api.js");
    const summary = await getSummary("inv_1");

    expect(summary.investigation.status).toBe("cancelled");
    expect(summary.report).toBeNull();
    expect(summary.incomplete).toBe(true);
  });
});

describe("client data flow: evidence content URL", () => {
  it("builds the content endpoint URL used for screenshots, traces, and replays", async () => {
    const { evidenceContentUrl } = await import("../api.js");
    expect(evidenceContentUrl("ev_1")).toBe("/api/evidence/ev_1/content");
    expect(evidenceContentUrl("ev-with-uuid")).toBe("/api/evidence/ev-with-uuid/content");
  });
});
