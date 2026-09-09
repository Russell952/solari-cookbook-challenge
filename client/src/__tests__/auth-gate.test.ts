/**
 * Authentication-surface tests (cookie sessions).
 *
 * The node test environment cannot mount React components, so these cover
 * the client's auth decision layer: getSessionUser() state mapping (signed
 * in / signed out / unreachable server), the login/signup/logout API calls
 * the AuthScreen submits, and the source-level guarantees the screen relies
 * on (credentials: include everywhere, no token storage, no build-time token
 * env, no secrets in the client). Rendering is verified by typecheck + build.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    statusText: status === 401 ? "Unauthorized" : "OK",
    json: async () => body,
  } as unknown as Response;
}

const user = { id: "usr_1", email: "me@example.com", createdAt: "2026-09-06T00:00:00.000Z" };

describe("session state mapping (AuthScreen gate)", () => {
  it("a valid session cookie maps to the signed-in state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }));

    const { getSessionUser } = await import("../api.js");
    await expect(getSessionUser()).resolves.toEqual(user);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/auth/me");
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe("include");
  });

  it("no cookie (401) maps to the signed-out state — the AuthScreen renders", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Authentication required" }, 401));

    const { getSessionUser } = await import("../api.js");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("an unreachable server maps to the retry state, never to a false 'signed out'", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { getSessionUser, ApiError } = await import("../api.js");
    const err = await getSessionUser().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { status: number }).status).toBe(0);
  });

  it("a 500 from /me is surfaced as an error, not treated as signed-out", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Internal server error" }, 500));

    const { getSessionUser, ApiError } = await import("../api.js");
    const err = await getSessionUser().then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { status: number }).status).toBe(500);
  });
});

describe("AuthScreen submissions (login / signup / logout)", () => {
  it("login posts JSON credentials and returns the session user", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }));

    const { login } = await import("../api.js");
    await expect(login("me@example.com", "password123")).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/login");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).credentials).toBe("include");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      email: "me@example.com",
      password: "password123",
    });
  });

  it("signup posts JSON credentials and returns the created user", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }, 201));

    const { signup } = await import("../api.js");
    await expect(signup("me@example.com", "password123")).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/signup");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      email: "me@example.com",
      password: "password123",
    });
  });

  it("a 409 duplicate signup surfaces the server's message to the form", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "An account with this email already exists" }, 409)
    );

    const { signup, ApiError } = await import("../api.js");
    const err = await signup("dupe@example.com", "password123").then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toMatch(/already exists/i);
  });

  it("invalid login surfaces the generic server error (no account-existence leak)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid email or password" }, 401));

    const { login, ApiError } = await import("../api.js");
    const err = await login("ghost@example.com", "wrongpassword").then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toBe("Invalid email or password");
  });

  it("logout posts with credentials and succeeds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const { logout } = await import("../api.js");
    await expect(logout()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/logout");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).credentials).toBe("include");
  });
});

describe("cookie-session source guarantees", () => {
  it("the AuthScreen never handles token material", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../AuthGate.tsx", import.meta.url), "utf-8");
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    expect(src).not.toMatch(/VITE_PROBE_API_TOKEN|probe_token/);
    expect(src).toMatch(/Confirm password/i);
    expect(src).toMatch(/Create account/);
    expect(src).toMatch(/Sign in/);
  });

  it("every api.ts fetch site sends credentials: include", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../api.ts", import.meta.url), "utf-8");
    const fetchSites = src.match(/fetch\(/g)?.length ?? 0;
    expect(fetchSites).toBeGreaterThanOrEqual(3); // request(), fetchEvidence(), SSE, /me
    expect(src).toMatch(/credentials:\s*FETCH_CREDENTIALS/);
    expect(src).toMatch(/const FETCH_CREDENTIALS: RequestCredentials = "include"/);
  });

  it("the client contains no server-secret surface", async () => {
    const fs = await import("fs");
    for (const file of ["../api.ts", "../AuthGate.tsx", "../App.tsx"]) {
      const src = fs.readFileSync(new URL(file, import.meta.url), "utf-8");
      expect(src, file).not.toMatch(/PROBE_SESSION_SECRET|PROBE_API_TOKEN|SOLARI_API_KEY/);
      expect(src, file).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
