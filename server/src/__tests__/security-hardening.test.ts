/**
 * P0 pre-hosting security regression tests.
 *
 * Covers: SSRF validation, bearer-token authentication, per-owner
 * authorization, sandbox read-only allowlist trimming, HTTP hardening
 * (Helmet headers, JSON 404/500), and artifact storage caps.
 *
 * External Solari/AI boundaries are mocked; everything asserted here is
 * production code under real HTTP.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn(),
  getBrowserSolari: vi.fn(),
  closeAllClients: vi.fn(async () => {}),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
  activeBrowserSessionCount: vi.fn().mockReturnValue(0),
}));

const { navigateSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(async () => ({ title: "T", url: "https://example.com/" })),
}));

vi.mock("../solari/browser.js", () => ({
  createBrowserSession: vi.fn(async () => {
    // The production adapter installs a context-level network policy right
    // after launch; the mock must present the same surface (contexts + on).
    const fakeContext = { route: vi.fn(async () => {}) };
    return {
      probeSessionId: "bsess_t",
      session: { close: vi.fn(async () => {}) },
      contexts: vi.fn(() => [fakeContext]),
      on: vi.fn(),
      solariSessionId: "s-1",
      recordingEnabled: false,
    };
  }),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: navigateSpy,
  screenshot: vi.fn(async () => Buffer.from("png")),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => "T"),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () => "text"),
  evaluate: vi.fn(async () => []),
  getReplay: vi.fn(async () => null),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => ({
    probeSessionId: "ssess_t",
    sandbox: {},
    investigationId: "inv_t",
  })),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async () => "x"),
  listDirectory: vi.fn(async () => []),
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// AI that plans an experiment whose navigate target is an SSRF attempt —
// the malicious URL must be blocked before reaching browser.navigate().
const SSRF_TARGET = "http://169.254.169.254/latest/meta-data/";
vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: vi.fn(async () => ({
      experiments: [
        {
          objective: "Exfil via metadata service",
          preconditions: [],
          plannedActions: [
            { tool: "browser", action: "navigate", target: SSRF_TARGET },
          ],
        },
      ],
    })),
    decideNextStep: vi.fn(async () => ({ shouldContinue: false, reason: "done" })),
    analyzeRepository: vi.fn(async () => "repo"),
    analyzeObservation: vi.fn(async () => "analysis"),
    generateHypothesis: vi.fn(async () => ({
      statement: "no hypothesis",
      confidence: 0.5,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    })),
    designVerification: vi.fn(async () => ({ shouldVerify: false, verificationExperiment: null })),
    evaluateEvidence: vi.fn(async () => ({ confidence: 0.5, status: "inconclusive" })),
    generateReport: vi.fn(async () => ({
      summary: "report",
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
    })),
  })),
}));

import { buildApp } from "../app.js";
import { store } from "../store/index.js";
import { registerTokenForTesting } from "../security/auth.js";
import {
  resetRateLimits,
  resetConcurrency,
  resetSse,
  tryAcquireSlot,
  releaseSlot,
} from "../security/rate-limit.js";
import { validateApplicationUrl } from "../security/url-validation.js";

const TOKEN_A = "test-token-user-a";
const TOKEN_B = "test-token-user-b";
beforeAll(() => {
  registerTokenForTesting(TOKEN_A);
  registerTokenForTesting(TOKEN_B);
});

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  store.clearAll();
  resetRateLimits();
  resetConcurrency();
  resetSse();
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function auth(token: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function createInvestigation(
  token = TOKEN_A,
  body: Record<string, unknown> = { applicationUrl: "https://example.com", objective: "test" }
): Promise<{ status: number; id?: string; error?: string }> {
  const res = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  return { status: res.status, id: json.id, error: json.error };
}

// ── Authentication ──────────────────────────────────────────────────────────

describe("authentication", () => {
  it("rejects missing auth with 401", async () => {
    const res = await fetch(`${baseUrl}/api/investigations`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/authentication required/i);
  });

  it("rejects invalid tokens with 401", async () => {
    const res = await fetch(`${baseUrl}/api/investigations`, {
      headers: auth("wrong-token-xyz"),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid token", async () => {
    const res = await fetch(`${baseUrl}/api/investigations`, { headers: auth(TOKEN_A) });
    expect(res.status).toBe(200);
  });

  it("keeps /health unauthenticated (uptime probe surface, no sensitive data)", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  it("returns 401 for SSE without a token", async () => {
    const { id } = (await createInvestigation()) as { id: string };
    const res = await fetch(`${baseUrl}/api/investigations/${id}/events`);
    expect(res.status).toBe(401);
  });
});

// ── Authorization / ownership ───────────────────────────────────────────────

describe("authorization (per-owner isolation)", () => {
  it("user A cannot access user B's investigation — indistinguishable 404", async () => {
    const { id } = (await createInvestigation()) as { id: string };
    const res = await fetch(`${baseUrl}/api/investigations/${id}`, { headers: auth(TOKEN_B) });
    expect(res.status).toBe(404);
  });

  it("the owner can access their investigation", async () => {
    const { id } = (await createInvestigation()) as { id: string };
    const res = await fetch(`${baseUrl}/api/investigations/${id}`, { headers: auth(TOKEN_A) });
    expect(res.status).toBe(200);
  });

  it("list only returns the caller's investigations", async () => {
    await createInvestigation(TOKEN_A);
    await createInvestigation(TOKEN_B);
    const listA = (await (
      await fetch(`${baseUrl}/api/investigations`, { headers: auth(TOKEN_A) })
    ).json()) as Array<{ id: string }>;
    const listB = (await (
      await fetch(`${baseUrl}/api/investigations`, { headers: auth(TOKEN_B) })
    ).json()) as Array<{ id: string }>;
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0].id).not.toBe(listB[0].id);
  });

  it("user B cannot read user A's evidence metadata, content, findings, or experiments", async () => {
    const { id } = (await createInvestigation()) as { id: string };
    const summary = (await (
      await fetch(`${baseUrl}/api/investigations/${id}/summary`, { headers: auth(TOKEN_A) })
    ).json()) as { evidence: Array<{ id: string }>; findings: Array<{ id: string }>; experiments: Array<{ id: string }> };
    // (Summary may be empty pre-run; fabricate a resource when needed.)
    const evId = summary.evidence[0]?.id ?? "ev_foreign";
    const fndId = summary.findings[0]?.id ?? "fnd_foreign";
    const expId = summary.experiments[0]?.id ?? "exp_foreign";

    for (const path of [
      `/api/investigations/${id}/evidence/${evId}`,
      `/api/investigations/${id}/evidence/${evId}/content`,
      `/api/investigations/${id}/findings/${fndId}`,
      `/api/investigations/${id}/experiments/${expId}`,
    ]) {
      const resB = await fetch(`${baseUrl}${path}`, { headers: auth(TOKEN_B) });
      expect(resB.status).toBe(404); // foreign → same 404 as missing (no enumeration)
    }
    // And A's list endpoints work for A:
    const resA = await fetch(`${baseUrl}/api/investigations/${id}/evidence`, { headers: auth(TOKEN_A) });
    expect(resA.status).toBe(200);
  });

  it("B cannot start, pause, or cancel A's investigation", async () => {
    const { id } = (await createInvestigation()) as { id: string };
    for (const action of ["start", "pause", "cancel"]) {
      const res = await fetch(`${baseUrl}/api/investigations/${id}/${action}`, {
        method: "POST",
        headers: auth(TOKEN_B),
      });
      expect(res.status).toBe(404);
    }
  });

  it("foreign resource ids do not leak existence (global lookup blocked)", async () => {
    // A creates an investigation; B asks for a fabricated-but-plausible id
    // scoped under A's investigation — must be 404, not a leak.
    const { id } = (await createInvestigation()) as { id: string };
    const res = await fetch(`${baseUrl}/api/investigations/${id}/findings/fnd_doesnotexist`, {
      headers: auth(TOKEN_B),
    });
    expect(res.status).toBe(404);
  });
});

// ── SSRF protection ─────────────────────────────────────────────────────────

describe("SSRF validation (validateApplicationUrl)", () => {
  const blocked: Array<[string, string]> = [
    ["file:///etc/passwd", "file scheme"],
    ["data:text/html,hello", "data scheme"],
    ["javascript:alert(1)", "javascript scheme"],
    ["about:blank", "about scheme"],
    ["blob:https://example.com/uuid", "blob scheme"],
    ["http://localhost/", "localhost"],
    ["http://localhost:3001/", "localhost with port"],
    ["http://127.0.0.1/", "loopback"],
    ["http://127.1/", "short loopback"],
    ["http://0.0.0.0/", "unspecified"],
    ["http://10.0.0.5/", "rfc1918 10/8"],
    ["http://172.16.0.9/", "rfc1918 172.16/12"],
    ["http://192.168.1.10/", "rfc1918 192.168/16"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://[::1]/", "ipv6 loopback"],
    ["http://[fe80::1]/", "ipv6 link-local"],
    ["http://[::ffff:127.0.0.1]/", "ipv4-mapped ipv6 loopback"],
    ["http://2130706433/", "decimal-encoded loopback"],
    ["http://0x7f000001/", "hex-encoded loopback"],
    ["http://0177.0.0.1/", "octal-encoded loopback"],
    ["http://metadata.google.internal/", "gcp metadata hostname"],
    ["http://db.internal/", "internal hostname"],
    ["http://my-service/", "docker-style single-label host"],
    ["https://user:pass@example.com/", "credentials in URL"],
    ["https://example.com:22/", "blocked port"],
    ["not a url at all", "malformed"],
    ["", "empty"],
  ];

  for (const [url, label] of blocked) {
    it(`blocks ${label}`, () => {
      expect(() => validateApplicationUrl(url)).toThrow();
    });
  }

  const allowed = [
    "http://example.com",
    "https://example.com",
    "https://astonishing-alpaca-12a6ed.netlify.app",
    "https://example.com:8443/app",
    "https://example.com:8080/app",
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(() => validateApplicationUrl(url)).not.toThrow();
    });
  }

  it("rejects applicationUrl at investigation creation with 400", async () => {
    const { status, error } = await createInvestigation(TOKEN_A, {
      applicationUrl: "file:///etc/passwd",
      objective: "test",
    });
    expect(status).toBe(400);
    expect(error).toMatch(/only http and https/i);
  });

  it("rejects metadata-service targets at creation with 400", async () => {
    const { status } = await createInvestigation(TOKEN_A, {
      applicationUrl: "http://169.254.169.254/latest/meta-data/",
      objective: "test",
    });
    expect(status).toBe(400);
  });
});

describe("SSRF at the navigate dispatch boundary (AI-planned targets)", () => {
  it("a malicious AI-planned navigate never reaches browser.navigate()", async () => {
    const { id } = (await createInvestigation()) as { id: string };
    await fetch(`${baseUrl}/api/investigations/${id}/start`, {
      method: "POST",
      headers: auth(TOKEN_A),
    });

    // Wait for the run to reach a terminal state
    const deadline = Date.now() + 15_000;
    let status = "running";
    while (Date.now() < deadline) {
      const inv = (await (
        await fetch(`${baseUrl}/api/investigations/${id}`, { headers: auth(TOKEN_A) })
      ).json()) as { status: string };
      status = inv.status;
      if (["completed", "failed", "cancelled"].includes(status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // The blocked navigate fails its experiment, but the run itself completes.
    expect(status).toBe("completed");
    // Recon navigation to the (safe) application URL is legitimate; the
    // SSRF target must never reach the browser in ANY call.
    for (const call of navigateSpy.mock.calls as unknown as unknown[][]) {
      expect(String(call[0] ?? "")).not.toContain("169.254.169.254");
      expect(JSON.stringify(call[1] ?? "")).not.toContain("169.254.169.254");
    }
    expect(navigateSpy).toHaveBeenCalledTimes(1);

    // The experiment records the security block, not a browser error.
    const summary = (await (
      await fetch(`${baseUrl}/api/investigations/${id}/summary`, { headers: auth(TOKEN_A) })
    ).json()) as { experiments: Array<{ error: string | null }> };
    const blockedExp = summary.experiments.find((e) => e.error);
    expect(blockedExp?.error).toMatch(/URL security policy/i);
  });
});

// ── Sandbox allowlist trimming ──────────────────────────────────────────────

describe("sandbox read-only allowlist (no arbitrary execution)", () => {
  it("no longer contains interpreters, package managers, or git", async () => {
    const { SANDBOX_READ_ONLY_COMMANDS, isReadOnlySandboxCommand } = await import(
      "../orchestrator/action-allowlist.js"
    );
    for (const cmd of ["node", "python3", "npm", "git", "python", "npx", "sh", "bash"]) {
      expect(SANDBOX_READ_ONLY_COMMANDS).not.toContain(cmd);
      expect(isReadOnlySandboxCommand(cmd)).toBe(false);
    }
  });

  it("still allows genuinely read-oriented commands", async () => {
    const { isReadOnlySandboxCommand } = await import("../orchestrator/action-allowlist.js");
    for (const cmd of ["cat", "ls", "head", "tail", "grep", "find", "wc", "file"]) {
      expect(isReadOnlySandboxCommand(cmd)).toBe(true);
    }
  });

  it("rejects execution-enabling arguments (find -exec, -execdir, -ok)", async () => {
    const { isSafeReadOnlyArg } = await import("../orchestrator/action-allowlist.js");
    expect(isSafeReadOnlyArg("-exec")).toBe(false);
    expect(isSafeReadOnlyArg("-execdir")).toBe(false);
    expect(isSafeReadOnlyArg("-ok")).toBe(false);
    expect(isSafeReadOnlyArg("-okdir")).toBe(false);
    expect(isSafeReadOnlyArg("-n")).toBe(true);
    expect(isSafeReadOnlyArg("pattern")).toBe(true);
  });
});

// ── HTTP hardening ──────────────────────────────────────────────────────────

describe("HTTP security hardening", () => {
  it("sets nosniff on API responses", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("hides X-Powered-By", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("sets frame-deny and no-referrer", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("unknown API routes return JSON 404", async () => {
    const res = await fetch(`${baseUrl}/api/definitely-not-a-route`, { headers: auth(TOKEN_A) });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
  });

  it("malformed JSON returns JSON 400 (not an HTML error page)", async () => {
    const res = await fetch(`${baseUrl}/api/investigations`, {
      method: "POST",
      headers: auth(TOKEN_A),
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("sets a restrictive CSP", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe("input length validation", () => {
  it("rejects oversized objective with 400", async () => {
    const { status } = await createInvestigation(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "x".repeat(3000),
    });
    expect(status).toBe(400);
  });

  it("rejects oversized URLs with 400", async () => {
    const { status } = await createInvestigation(TOKEN_A, {
      applicationUrl: `https://example.com/${"a".repeat(3000)}`,
      objective: "test",
    });
    expect(status).toBe(400);
  });

  it("rejects empty objective with 400", async () => {
    const { status } = await createInvestigation(TOKEN_A, {
      applicationUrl: "https://example.com",
      objective: "   ",
    });
    expect(status).toBe(400);
  });

  it("rejects non-GitHub repositoryUrl with 400", async () => {
    const { status } = await createInvestigation(TOKEN_A, {
      repositoryUrl: "https://gitlab.com/user/repo",
      objective: "test",
    });
    expect(status).toBe(400);
  });
});

// ── Concurrency cap ─────────────────────────────────────────────────────────

describe("concurrency protection", () => {
  it("releases the slot when the caller releases it", () => {
    expect(tryAcquireSlot()).toBe(true);
    releaseSlot();
    // After release, another acquisition must succeed (counter returned to 0).
    expect(tryAcquireSlot()).toBe(true);
    releaseSlot();
  });

  it("slot accounting balances across acquire/release cycles", () => {
    const acquires: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      acquires.push(tryAcquireSlot());
      releaseSlot();
    }
    // Every cycle should be able to acquire again after a balanced release.
    expect(acquires.every(Boolean)).toBe(true);
  });
});

// ── Fresh SSRF bypass audit (encodings, normalization, edge forms) ─────────

describe("SSRF bypass audit (parser/encoding edge cases)", () => {
  const bypassAttempts: Array<[string, string]> = [
    ["http://[::ffff:7f00:1]/", "ipv4-mapped ipv6 in hex-group form"],
    ["http://[::ffff:a00:1]/", "ipv4-mapped ipv6 hex 10.0.0.1"],
    ["http://[::ffff:0:127.0.0.1]/", "translated mapped loopback"],
    ["http://[2002:7f00:1::]/", "6to4 embedding loopback"],
    ["http://[2002:a00:1::]/", "6to4 embedding 10.0.0.1"],
    ["http://localhost../", "double-trailing-dot localhost"],
    ["http://LOCALHOST./", "uppercase trailing-dot localhost"],
    ["http://127.0.0.1./", "trailing-dot loopback literal"],
    ["http://0177.00.00.01/", "zero-padded octal loopback"],
    ["http://1.2.3.4.5/", "five-octet packed form"],
    ["http://a9fe:a9fe/", "hex-packed link-local (numeric host)"],
    ["http://example.com.:22/", "blocked port behind trailing dot"],
    ["http://example.com%2f@127.0.0.1/", "encoded credential slip"],
    ["http://169.254.169.254:80/", "metadata endpoint explicit port"],
    ["http://metadata/", "bare metadata hostname"],
    ["http://instance-data.ec2.internal/", "EC2 instance-data hostname"],
    ["http://[fe80::1%25eth0]/", "ipv6 link-local with zone id"],
  ];

  for (const [url, label] of bypassAttempts) {
    it(`rejects ${label}`, () => {
      // Malformed-vs-rejected doesn't matter: neither may reach the browser.
      expect(() => validateApplicationUrl(url)).toThrow();
    });
  }

  // The prior validator wrongly blocked every dotted-quad literal. Canonical
  // PUBLIC IPv4 literals must remain usable investigation targets.
  it("still allows canonical public IPv4 literals (over-blocking regression)", () => {
    expect(() => validateApplicationUrl("http://93.184.216.34/")).not.toThrow();
    expect(() => validateApplicationUrl("http://1.1.1.1/")).not.toThrow();
  });

  it("allows FQDNs with trailing dots (public, canonical form)", () => {
    expect(() => validateApplicationUrl("https://example.com./")).not.toThrow();
  });
});

// ── Connection-time DNS/IP enforcement (DNS-rebinding) ────────────────────

describe("connection-time network policy (DNS rebinding)", () => {
  it("isPubliclyRoutableHost rejects hostnames that resolve to private addresses", async () => {
    const { isPubliclyRoutableHost } = await import("../security/url-validation.js");
    // This test depends on real DNS: localhost always resolves to loopback.
    const verdict = await isPubliclyRoutableHost("localhost");
    expect(verdict.ok).toBe(false);
  });

  it("isPubliclyRoutableHost accepts real public hostnames and returns addresses", async () => {
    const { isPubliclyRoutableHost } = await import("../security/url-validation.js");
    const verdict = await isPubliclyRoutableHost("example.com");
    // If DNS is unavailable in the test environment, verdict.ok is false with
    // no addresses — that is fail-closed behavior, not a test failure.
    if (verdict.addresses.length > 0) {
      expect(verdict.ok).toBe(true);
      expect(verdict.addresses.every((a) => !a.startsWith("127.") && !a.startsWith("10.") && !a.startsWith("169.254."))).toBe(true);
    }
  });

  it("isPubliclyRoutableHost fails closed for unresolvable hostnames", async () => {
    const { isPubliclyRoutableHost } = await import("../security/url-validation.js");
    const verdict = await isPubliclyRoutableHost("this-domain-does-not-exist-probe-test.invalid");
    expect(verdict.ok).toBe(false);
    expect(verdict.addresses).toEqual([]);
  });

  // Policy installation on real session objects is verified in browser.test.ts
  // (which loads the real adapter); see "connection-time network policy".
});

// ── Trust proxy / client-IP spoofing ────────────────────────────────────────

describe("trust proxy and client-IP integrity", () => {
  it("defaults to trust proxy disabled (direct exposure)", async () => {
    const app = buildApp();
    expect(app.get("trust proxy")).toBe(false);
  });

  it("req.ip reflects the socket peer, ignoring X-Forwarded-For, when trust proxy is off", async () => {
    let server2: Server | null = null;
    try {
      const app2 = buildApp();
      app2.get("/whoami", (req, res) => {
        res.json({ ip: req.ip });
      });
      server2 = app2.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server2!.once("listening", () => r()));
      const port = (server2.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
        headers: { "X-Forwarded-For": "8.8.8.8" },
      });
      const body = (await res.json()) as { ip: string };
      expect(body.ip).toBe("127.0.0.1"); // spoofed header ignored
    } finally {
      await new Promise<void>((r) => (server2 ? server2.close(() => r()) : r()));
    }
  });

  it("rejects PROBE_TRUST_PROXY=true at startup validation", async () => {
    const cfgMod = await import("../config/index.js");
    // Directly exercise the validation rule with the env vars set.
    const prevProxy = process.env.PROBE_TRUST_PROXY;
    const prevKey = process.env.SOLARI_API_KEY;
    process.env.PROBE_TRUST_PROXY = "true";
    process.env.SOLARI_API_KEY = "test-key-for-validation";
    try {
      expect(() => cfgMod.validateConfig()).toThrow(/PROBE_TRUST_PROXY=true is not allowed/);
    } finally {
      if (prevProxy === undefined) delete process.env.PROBE_TRUST_PROXY;
      else process.env.PROBE_TRUST_PROXY = prevProxy;
      if (prevKey === undefined) delete process.env.SOLARI_API_KEY;
      else process.env.SOLARI_API_KEY = prevKey;
    }
  });
});
