/**
 * AuthGate decision-logic tests.
 *
 * The gate renders React, which the node test environment cannot mount, so
 * these cover its decision procedure directly: probeAuthState() maps API
 * outcomes (200 / 401 / network failure) to the three gate states, and the
 * token save/verify path persists through api.ts's existing localStorage
 * mechanism. React rendering is verified by typecheck + build.
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

function localStorageShim(): {
  setItem: (k: string, v: string) => void;
  getItem: (k: string) => string | null;
  removeItem: (k: string) => void;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

describe("AuthGate decision logic", () => {
  const savedEnv = { ...import.meta.env };

  afterEach(() => {
    Object.assign(import.meta.env, savedEnv);
    delete import.meta.env.VITE_PROBE_API_TOKEN;
    vi.resetModules();
  });

  it("maps a successful authenticated call to the authed state", async () => {
    const ls = localStorageShim();
    vi.stubGlobal("localStorage", ls);
    ls.store.set("probe_token", "tok_valid");
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const { probeAuthState } = await import("../AuthGate.js");
    await expect(probeAuthState()).resolves.toBe("ok");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/investigations");
  });

  it("maps a 401 (missing/invalid token) to the token-prompt state", async () => {
    const ls = localStorageShim();
    vi.stubGlobal("localStorage", ls);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Authentication required" }, 401));

    const { probeAuthState } = await import("../AuthGate.js");
    await expect(probeAuthState()).resolves.toBe("unauthorized");
  });

  it("maps a network failure to the offline/retry state — never to a token rejection", async () => {
    vi.stubGlobal("localStorage", localStorageShim());
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { probeAuthState } = await import("../AuthGate.js");
    await expect(probeAuthState()).resolves.toBe("unreachable");
  });

  it("token save → verify → clear flow persists through the api layer", async () => {
    const ls = localStorageShim();
    vi.stubGlobal("localStorage", ls);

    const { setProbeToken, probeTokenSet } = await import("../api.js");
    expect(probeTokenSet()).toBe(false);

    setProbeToken("tok_entered_by_user");
    expect(probeTokenSet()).toBe(true);
    expect(ls.store.get("probe_token")).toBe("tok_entered_by_user");

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const { probeAuthState } = await import("../AuthGate.js");
    await expect(probeAuthState()).resolves.toBe("ok");

    setProbeToken("");
    expect(probeTokenSet()).toBe(false);
  });

  it("a rejected token is reported, not silently accepted", async () => {
    const ls = localStorageShim();
    vi.stubGlobal("localStorage", ls);

    const { setProbeToken } = await import("../api.js");
    setProbeToken("tok_wrong");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Authentication required" }, 401));

    const { probeAuthState } = await import("../AuthGate.js");
    await expect(probeAuthState()).resolves.toBe("unauthorized");
  });

  it("does not send an Authorization header for the anonymous-mode probe", async () => {
    // Empty string = no build-time token configured (env values are strings;
    // an empty value is falsy in api.ts's resolution chain).
    import.meta.env.VITE_PROBE_API_TOKEN = "";
    vi.resetModules();
    vi.stubGlobal("localStorage", localStorageShim());
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const { probeAuthState } = await import("../AuthGate.js");
    await expect(probeAuthState()).resolves.toBe("ok");
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
  });
});
