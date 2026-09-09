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
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";

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
      provenance: "experiment",
      createdAt: "2026-09-06T00:00:10.000Z",
    },
    {
      id: "ev_2", investigationId: "inv_1", experimentId: "exp_1", observationId: null,
      type: "url", uri: "https://example.com/login", contentHash: null, metadata: {},
      provenance: "experiment",
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
        id: "fnd_1", title: "Login renders as documented",
        severity: "info", description: "d", recommendation: null,
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
    expect(summary.findings[0].evidenceIds).toEqual(["ev_1"]);
    expect(summary.report?.confirmedFindings[0].title).toBe("Login renders as documented");
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

describe("client data flow: API base URL resolution (production deployment)", () => {
  const savedEnv = { ...import.meta.env };

  afterEach(() => {
    Object.assign(import.meta.env, savedEnv);
    delete import.meta.env.VITE_API_URL;
    // Vite's `PROD` is typed non-optional; restore rather than delete.
    import.meta.env.PROD = savedEnv.PROD;
    vi.resetModules();
  });

  it("prefixes every API path with VITE_API_URL when set (production backend)", async () => {
    import.meta.env.VITE_API_URL = "https://api-probe.onrender.com";
    vi.resetModules();

    const { healthUrl, evidenceContentUrl, apiOrigin } = await import("../api.js");
    expect(apiOrigin).toBe("https://api-probe.onrender.com");
    expect(healthUrl).toBe("https://api-probe.onrender.com/api/health");
    expect(evidenceContentUrl("ev_1")).toBe(
      "https://api-probe.onrender.com/api/evidence/ev_1/content"
    );
  });

  it("normalizes a trailing slash and redundant /api suffix in VITE_API_URL", async () => {
    import.meta.env.VITE_API_URL = "https://api-probe.onrender.com/api/";
    vi.resetModules();

    const { healthUrl } = await import("../api.js");
    expect(healthUrl).toBe("https://api-probe.onrender.com/api/health");
  });

  it("falls back to the relative /api base (Vite dev proxy) in development when VITE_API_URL is unset", async () => {
    delete import.meta.env.VITE_API_URL;
    import.meta.env.PROD = false;
    vi.resetModules();

    const { healthUrl, apiOrigin } = await import("../api.js");
    expect(apiOrigin).toBe("");
    expect(healthUrl).toBe("/api/health");
  });

  it("uses the fail-safe production backend when a production build ships without VITE_API_URL", async () => {
    // Regression guard for the deployed-404 incident: a Vercel build that
    // never received the env var must still reach the Render backend, never
    // the static host's own (nonexistent) /api routes.
    delete import.meta.env.VITE_API_URL;
    import.meta.env.PROD = true;
    vi.resetModules();

    const { healthUrl, apiOrigin } = await import("../api.js");
    expect(apiOrigin).toBe("https://api-probe.onrender.com");
    expect(healthUrl).toBe("https://api-probe.onrender.com/api/health");
  });

  it("routes getSummary through the configured production base", async () => {
    import.meta.env.VITE_API_URL = "https://api-probe.onrender.com";
    vi.resetModules();
    fetchMock.mockResolvedValueOnce(jsonResponse(summaryFixture));

    const { getSummary } = await import("../api.js");
    await getSummary("inv_1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-probe.onrender.com/api/investigations/inv_1/summary",
      expect.anything()
    );
  });
});

describe("client authentication: cookie session flow", () => {
  it("sends credentials: include on data requests so the session cookie rides along", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summaryFixture));

    const { listInvestigations, getSummary } = await import("../api.js");
    await listInvestigations();
    await getSummary("inv_1");

    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe("include");
      // Cookie-based auth: no credential material in headers, ever.
      expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
    }
  });

  it("sends credentials: include on evidence and SSE requests too", async () => {
    const { fetchEvidence, subscribeToEvents } = await import("../api.js");

    fetchMock.mockResolvedValueOnce(new Response("x"));
    await fetchEvidence("evidence/ev_1/content");
    const evidenceCall = fetchMock.mock.calls[0];
    expect((evidenceCall[1] as RequestInit).credentials).toBe("include");
    expect((evidenceCall[1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined();

    // SSE stream fetch (cancel immediately)
    const sseResponse = {
      ok: true,
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(sseResponse);
    const unsub = subscribeToEvents("inv_1", () => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    const sseCall = fetchMock.mock.calls[1];
    expect(sseCall[0]).toContain("/api/investigations/inv_1/events");
    expect((sseCall[1] as RequestInit).credentials).toBe("include");
  });

  it("logs in with a POST of JSON credentials to /api/auth/login", async () => {
    const user = { id: "usr_1", email: "user@example.com", createdAt: "2026-09-06T00:00:00.000Z" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }));

    const { login } = await import("../api.js");
    await expect(login("user@example.com", "password123")).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/login");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      email: "user@example.com",
      password: "password123",
    });
    expect((init as RequestInit).credentials).toBe("include");
  });

  it("signs up with a POST of JSON credentials to /api/auth/signup", async () => {
    const user = { id: "usr_2", email: "new@example.com", createdAt: "2026-09-06T00:00:00.000Z" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }, 201));

    const { signup } = await import("../api.js");
    await expect(signup("new@example.com", "password123")).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/signup");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      email: "new@example.com",
      password: "password123",
    });
  });

  it("logs out with a POST to /api/auth/logout", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const { logout } = await import("../api.js");
    await expect(logout()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/logout");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).credentials).toBe("include");
  });

  it("getSessionUser returns the session user when the cookie is valid", async () => {
    const user = { id: "usr_3", email: "me@example.com", createdAt: "2026-09-06T00:00:00.000Z" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }));

    const { getSessionUser } = await import("../api.js");
    await expect(getSessionUser()).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/me");
    expect((init as RequestInit).credentials).toBe("include");
  });

  it("getSessionUser returns null (not an error) when unauthenticated", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Authentication required" }, 401));

    const { getSessionUser } = await import("../api.js");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("getSessionUser reports an unreachable server instead of silently signing out", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { getSessionUser, ApiError } = await import("../api.js");
    const err = await getSessionUser().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { status: number }).status).toBe(0);
    expect((err as Error).message).toMatch(/could not be reached/i);
  });

  it("surfaces a 401 on protected APIs as an actionable sign-in error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Authentication required" }, 401));

    const { listInvestigations, ApiError } = await import("../api.js");
    const err = await listInvestigations().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { status: number }).status).toBe(401);
    expect((err as Error).message).toMatch(/sign in/i);
  });

  it("propagates auth endpoint errors (duplicate email, validation) with server messages", async () => {
    const { signup, login, ApiError } = await import("../api.js");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "An account with this email already exists" }, 409)
    );
    const dup = await signup("dupe@example.com", "password123").then(
      () => null,
      (e) => e
    );
    expect(dup).toBeInstanceOf(ApiError);
    expect((dup as { status: number }).status).toBe(409);
    expect((dup as Error).message).toMatch(/already exists/i);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid email or password" }, 401));
    const bad = await login("who@example.com", "wrongpassword").then(
      () => null,
      (e) => e
    );
    expect(bad).toBeInstanceOf(ApiError);
    expect((bad as { status: number }).status).toBe(401);
    expect((bad as Error).message).toMatch(/invalid email or password/i);
  });

  it("stores no credential material anywhere in the client source", async () => {
    // Regression guard for the milestone requirement: the session lives only
    // in the HttpOnly cookie — never localStorage/sessionStorage/state/URL.
    const fs = await import("fs");
    for (const file of ["../api.ts", "../AuthGate.tsx", "../App.tsx"]) {
      const src = fs.readFileSync(new URL(file, import.meta.url), "utf-8");
      expect(src, `${file} must not touch web storage`).not.toMatch(/localStorage|sessionStorage/);
      expect(src, `${file} must not read build-time token env`).not.toMatch(/VITE_PROBE_API_TOKEN/);
      expect(src, `${file} must not put tokens in URLs`).not.toMatch(/probe_token=/);
    }
  });
});
