/**
 * Recon-after-action (post-action recon) regression tests.
 *
 * Live background: multi-step SPA flows were impossible because recon only
 * ran once (recon phase). Clicking "Create account" renders a signup form
 * that initial recon never saw, so no planner could ever reference those
 * controls — selector validation would (correctly) reject them.
 *
 * These tests pin the recon-after-action loop:
 *  - a state-changing action (click/navigate) triggers exactly ONE page
 *    snapshot per action, and a fresh recon is committed ONLY when the
 *    snapshot shows a state change (URL/title/selector set);
 *  - committed recon flows into RunState so the NEXT planner call (adaptive
 *    loop) receives the newly verified interactables;
 *  - a same-URL DOM change also commits recon (SPA pushState/dynamic UI);
 *  - unchanged pages do NOT trigger recon commits (no duplicate passes);
 *  - the per-experiment commit budget bounds the number of commits;
 *  - snapshot failures never break the experiment (no commits, no throw);
 *  - evidence is captured for committed recon, tied to the experiment.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
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

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex"
);

/** Scripted page states: each click/navigate moves to the NEXT state. */
let pageStates: Array<{ url: string; title: string; selectors: string[] }>;
/** Which structured extraction result to return (index into pageStates). */
let extractionStateIndex = 0;

vi.mock("../solari/browser.js", () => ({
  createBrowserSession: vi.fn(async () => ({
    probeSessionId: "bsess_postaction",
    session: { close: vi.fn(async () => {}) },
    solariSessionId: "solari-postaction-1",
    recordingEnabled: true,
  })),
  closeBrowserSession: vi.fn(async () => {}),
  navigate: vi.fn(async (_s: unknown, url: string) => ({
    title: "Page",
    url,
  })),
  screenshot: vi.fn(async () => PNG_BYTES),
  setViewport: vi.fn(async (_s: unknown, vp: { width: number; height: number }) => vp),
  verifyPage: vi.fn(async () => ({ matched: true, details: "ok" })),
  getTitle: vi.fn(async () => pageStates[extractionStateIndex].title),
  click: vi.fn(async () => {}),
  type: vi.fn(async () => {}),
  readText: vi.fn(async () => "text"),
  evaluate: vi.fn(async (_s: unknown, fn: string) => {
    if (fn.includes("location.href") && fn.includes("selectors")) {
      // Page state snapshot script
      const st = pageStates[extractionStateIndex];
      return { url: st.url, title: st.title, selectors: st.selectors };
    }
    if (fn.includes("location.href")) {
      return { url: pageStates[extractionStateIndex].url };
    }
    if (fn.includes("getSelector")) {
      // Full extraction script — return elements for the CURRENT state.
      const st = pageStates[extractionStateIndex];
      return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
    }
    return [];
  }),
  getReplay: vi.fn(async () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
}));

vi.mock("../solari/sandbox.js", () => ({
  createSandboxSession: vi.fn(async () => ({ probeSessionId: "ssess_pa", sandbox: {}, investigationId: "x" })),
  destroySandbox: vi.fn(async () => {}),
  cloneRepository: vi.fn(async () => ({ exitCode: 0, output: "cloned" })),
  readFile: vi.fn(async () => "# Demo App"),
  listDirectory: vi.fn(async () => ["src"]),
  runReadOnlyCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

// Shared adaptive planner mock — captures the recon handed to decideNextStep.
const aiMocks = vi.hoisted(() => ({
  plan: vi.fn(
    async () => ({ experiments: [] as Array<{ objective: string; preconditions: string[]; plannedActions: Array<{ tool: string; action: string; target: string }> }> })
  ),
  decideNextStep: vi.fn(
    async (
      _objective?: string,
      _experiments?: unknown,
      _evidence?: unknown,
      _analysis?: string,
      _primary?: number,
      _actions?: number,
      _appRecon?: unknown
    ) => ({ shouldContinue: false, reason: "no continuation needed" })
  ),
}));

/** Scripted primary experiments (set per test before runInvestigation). */
let scriptedExperiments: Array<{
  objective: string;
  preconditions: string[];
  plannedActions: Array<{ tool: string; action: string; target: string }>;
}> = [];

vi.mock("../ai/index.js", () => ({
  createOpenAIAdapter: vi.fn(() => ({
    plan: aiMocks.plan,
    decideNextStep: aiMocks.decideNextStep,
    analyzeRepository: vi.fn(async () => "repo analysis"),
    analyzeObservation: vi.fn(async () => "observation analysis"),
    generateHypothesis: vi.fn(async () => ({
      statement: "hypothesis",
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

import { store } from "../store/index.js";
import { buildApp } from "../app.js";
import { registerTokenForTesting } from "../security/auth.js";
import { runInvestigation, __clearRunStatesForTests } from "../orchestrator/runner.js";

const TEST_TOKEN = "post-action-recon-token";

let server: Server;
let baseUrl: string;
let evidenceDir: string;

beforeAll(() => {
  registerTokenForTesting(TEST_TOKEN);
});

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "probe-post-action-"));
  process.env.PROBE_EVIDENCE_DIR = evidenceDir;
  store.clearAll();
  __clearRunStatesForTests();
  vi.clearAllMocks();
  scriptedExperiments = [];
  aiMocks.plan.mockImplementation(async () => ({ experiments: scriptedExperiments }));
  aiMocks.decideNextStep.mockImplementation(
    async () => ({ shouldContinue: false, reason: "no continuation needed" })
  );
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.PROBE_EVIDENCE_DIR;
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await rm(evidenceDir, { recursive: true, force: true });
});

const PLANNER_EXPERIMENTS: Array<{
  objective: string;
  preconditions: string[];
  plannedActions: Array<{ tool: string; action: string; target: string }>;
}> = [];

async function setup(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({
      repositoryUrl: "",
      applicationUrl: "https://app.test/",
      objective: "Can a user reach the signup form?",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("recon after state-changing actions", () => {
  it("initial recon only: no commits when page state never changes", async () => {
    pageStates = [{ url: "https://app.test/", title: "Home", selectors: ["#hero", "a[href='/']"] }];
    extractionStateIndex = 0;

    const browserMod = await import("../solari/browser.js");
    const evaluateMock = vi.mocked(browserMod.evaluate);
    let snapshotCalls = 0;
    evaluateMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn.includes("location.href") && fn.includes("selectors")) {
        snapshotCalls++;
        const st = pageStates[extractionStateIndex];
        return { url: st.url, title: st.title, selectors: st.selectors };
      }
      if (fn.includes("location.href")) return { url: pageStates[extractionStateIndex].url };
      if (fn.includes("getSelector")) {
        const st = pageStates[extractionStateIndex];
        return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
      }
      return [];
    });

    scriptedExperiments = [
        {
          objective: "Read the hero text",
          preconditions: [],
          plannedActions: [{ tool: "browser", action: "readText", target: "#hero" }],
        },
      ];
    const id = await setup();
    await runInvestigation(id);

    const exp = store.listExperiments(id)[0];
    expect(exp.status).toBe("completed");
    // No state-changing action → the only snapshot is the per-experiment
    // baseline taken right after the session launches (readText never
    // triggers a snapshot). One baseline, zero post-action snapshots.
    expect(snapshotCalls).toBe(1);
    const commits = store
      .listEvidence(id)
      .filter((e) => (e.metadata as { type?: string } | null)?.type === "post_action_recon");
    expect(commits.length).toBe(0);
    evaluateMock.mockRestore();
  }, 30000);

  it("a click that changes the DOM commits fresh recon with the NEW elements", async () => {
    // State 0 (initial): landing page with Create account button.
    // State 1 (after click): signup form rendered — email input appears.
    pageStates = [
      { url: "https://app.test/", title: "Home", selectors: ["a[href='/']", "button.auth"] },
      { url: "https://app.test/", title: "Sign up", selectors: ["input[type='email']", "button[type='submit']"] },
    ];
    extractionStateIndex = 0;

    const browserMod = await import("../solari/browser.js");
    const evaluateMock = vi.mocked(browserMod.evaluate);
    evaluateMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn.includes("location.href") && fn.includes("selectors")) {
        const st = pageStates[extractionStateIndex];
        return { url: st.url, title: st.title, selectors: st.selectors };
      }
      if (fn.includes("location.href")) return { url: pageStates[extractionStateIndex].url };
      if (fn.includes("getSelector")) {
        const st = pageStates[extractionStateIndex];
        return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
      }
      return [];
    });

    // The click advances the SPA state.
    const clickMock = vi.mocked(browserMod.click);
    clickMock.mockImplementation(async () => {
      extractionStateIndex = 1;
    });

    let capturedRecon: { source?: string; afterAction?: string; elements?: Array<{ selector: string }> } | null = null;
    aiMocks.decideNextStep.mockImplementation(async (...args: unknown[]) => {
      const appRecon = args[6] as
        | { source?: string; afterAction?: string; interactableElements?: Array<{ selector: string }> }
        | null;
      capturedRecon = appRecon
        ? {
            source: appRecon.source,
            afterAction: appRecon.afterAction,
            elements: appRecon.interactableElements,
          }
        : null;
      return { shouldContinue: false, reason: "stop" };
    });

    scriptedExperiments = [
        {
          objective: "Open the signup form",
          preconditions: [],
          plannedActions: [{ tool: "browser", action: "click", target: "button.auth" }],
        },
      ];
    const id = await setup();
    await runInvestigation(id);

    // The adaptive planner must have received POST-ACTION recon containing
    // the newly rendered controls — this is the core capability contract.
    expect(capturedRecon).not.toBeNull();
    expect(capturedRecon!.source).toBe("post-action");
    expect(capturedRecon!.afterAction).toBe("click");
    const selectors = (capturedRecon!.elements ?? []).map((e) => e.selector);
    expect(selectors).toContain("input[type='email']");
    evaluateMock.mockRestore();
    clickMock.mockRestore();
  }, 30000);

  it("a click with NO state change commits nothing (no duplicate recon)", async () => {
    pageStates = [{ url: "https://app.test/", title: "Home", selectors: ["#hero"] }];
    extractionStateIndex = 0;

    const browserMod = await import("../solari/browser.js");
    const evaluateMock = vi.mocked(browserMod.evaluate);
    let snapshotCalls = 0;
    evaluateMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn.includes("location.href") && fn.includes("selectors")) {
        snapshotCalls++;
        const st = pageStates[extractionStateIndex];
        return { url: st.url, title: st.title, selectors: st.selectors };
      }
      if (fn.includes("location.href")) return { url: pageStates[extractionStateIndex].url };
      if (fn.includes("getSelector")) {
        const st = pageStates[extractionStateIndex];
        return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
      }
      return [];
    });

    let decideCalls = 0;
    aiMocks.decideNextStep.mockImplementation(async () => {
      decideCalls++;
      return { shouldContinue: false, reason: "stop" };
    });

    scriptedExperiments = [
        {
          objective: "Click a non-navigating button",
          preconditions: [],
          plannedActions: [{ tool: "browser", action: "click", target: "#hero" }],
        },
      ];
    const id = await setup();
    await runInvestigation(id);

    // Baseline + one post-click snapshot, but no commit → decideNextStep
    // still gets the INITIAL recon (source "initial"), not a post-action one.
    expect(snapshotCalls).toBe(2);
    const firstCall = aiMocks.decideNextStep.mock.calls[0] as unknown[] | undefined;
    const firstArg = (firstCall?.[6] ?? null) as { source?: string } | null;
    expect(firstArg?.source ?? "initial").toBe("initial");
    expect(decideCalls).toBe(1);
    evaluateMock.mockRestore();
  }, 30000);

  it("per-experiment commit budget: at most 2 post-action recon commits", async () => {
    // 4 distinct states reached by 4 clicks; commits cap at 2.
    pageStates = [
      { url: "https://app.test/", title: "S0", selectors: ["#s0"] },
      { url: "https://app.test/1", title: "S1", selectors: ["#s1"] },
      { url: "https://app.test/2", title: "S2", selectors: ["#s2"] },
      { url: "https://app.test/3", title: "S3", selectors: ["#s3"] },
      { url: "https://app.test/4", title: "S4", selectors: ["#s4"] },
    ];
    extractionStateIndex = 0;

    const browserMod = await import("../solari/browser.js");
    const evaluateMock = vi.mocked(browserMod.evaluate);
    evaluateMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn.includes("location.href") && fn.includes("selectors")) {
        const st = pageStates[extractionStateIndex];
        return { url: st.url, title: st.title, selectors: st.selectors };
      }
      if (fn.includes("location.href")) return { url: pageStates[extractionStateIndex].url };
      if (fn.includes("getSelector")) {
        const st = pageStates[extractionStateIndex];
        return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
      }
      return [];
    });
    const clickMock = vi.mocked(browserMod.click);
    clickMock.mockImplementation(async () => {
      extractionStateIndex = Math.min(extractionStateIndex + 1, pageStates.length - 1);
    });

    scriptedExperiments = [
      {
        objective: "Walk four steps",
        preconditions: [],
        plannedActions: [
          { tool: "browser", action: "click", target: "#s0" },
          { tool: "browser", action: "click", target: "#s1" },
          { tool: "browser", action: "click", target: "#s2" },
          { tool: "browser", action: "click", target: "#s3" },
        ],
      },
    ];

    const id = await setup();
    await runInvestigation(id);

    const commits = store
      .listEvidence(id)
      .filter((e) => (e.metadata as { type?: string } | null)?.type === "post_action_recon");
    expect(commits.length).toBe(2);
    evaluateMock.mockRestore();
    clickMock.mockRestore();
  }, 30000);

  it("a broken page snapshot never fails the experiment", async () => {
    pageStates = [{ url: "https://app.test/", title: "Home", selectors: ["#hero"] }];
    extractionStateIndex = 0;

    const browserMod = await import("../solari/browser.js");
    const evaluateMock = vi.mocked(browserMod.evaluate);
    evaluateMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn.includes("location.href") && fn.includes("selectors")) {
        throw new Error("Execution context was destroyed");
      }
      if (fn.includes("location.href")) return { url: pageStates[extractionStateIndex].url };
      if (fn.includes("getSelector")) {
        const st = pageStates[extractionStateIndex];
        return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
      }
      return [];
    });

    scriptedExperiments = [
        {
          objective: "Click through a crashing page",
          preconditions: [],
          plannedActions: [{ tool: "browser", action: "click", target: "#hero" }],
        },
      ];
    const id = await setup();
    await runInvestigation(id);

    const exp = store.listExperiments(id)[0];
    expect(exp.status).toBe("completed");
    const commits = store
      .listEvidence(id)
      .filter((e) => (e.metadata as { type?: string } | null)?.type === "post_action_recon");
    expect(commits.length).toBe(0);
    evaluateMock.mockRestore();
  }, 30000);

  it("a navigate action also triggers state-change detection (full-page nav)", async () => {
    pageStates = [
      { url: "https://app.test/", title: "Home", selectors: ["a[href='/signup']"] },
      { url: "https://app.test/signup", title: "Sign up", selectors: ["input[type='email']", "button[type='submit']"] },
    ];
    extractionStateIndex = 0;

    const browserMod = await import("../solari/browser.js");
    const evaluateMock = vi.mocked(browserMod.evaluate);
    evaluateMock.mockImplementation(async (_s: unknown, fn: string) => {
      if (fn.includes("location.href") && fn.includes("selectors")) {
        const st = pageStates[extractionStateIndex];
        return { url: st.url, title: st.title, selectors: st.selectors };
      }
      if (fn.includes("location.href")) return { url: pageStates[extractionStateIndex].url };
      if (fn.includes("getSelector")) {
        const st = pageStates[extractionStateIndex];
        return st.selectors.map((sel) => ({ selector: sel, text: "", tag: "input" }));
      }
      return [];
    });
    const navMock = vi.mocked(browserMod.navigate);
    let navCalls = 0;
    navMock.mockImplementation(async (_s: unknown, url: string) => {
      // Call 1 = recon-phase navigation of the landing page (state 0).
      // Call 2 = the experiment's navigate action (state 1). Advancing on
      // the experiment call only is what models a multi-step SPA flow.
      navCalls += 1;
      if (navCalls >= 2) extractionStateIndex = 1;
      return { title: pageStates[extractionStateIndex].title, url };
    });

    scriptedExperiments = [
      {
        objective: "Navigate to signup",
        preconditions: [],
        plannedActions: [{ tool: "browser", action: "navigate", target: "https://app.test/signup" }],
      },
    ];

    let capturedRecon: { source?: string; elements?: Array<{ selector: string }> } | null = null;
    aiMocks.decideNextStep.mockImplementation(async (...args: unknown[]) => {
      const appRecon = args[6] as
        | { source?: string; interactableElements?: Array<{ selector: string }> }
        | null;
      capturedRecon = appRecon ? { source: appRecon.source, elements: appRecon.interactableElements } : null;
      return { shouldContinue: false, reason: "stop" };
    });

    const id = await setup();
    await runInvestigation(id);

    const recon = capturedRecon as { source?: string; elements?: Array<{ selector: string }> } | null;
    expect(recon?.source).toBe("post-action");
    const selectors = (recon?.elements ?? []).map((e) => e.selector);
    expect(selectors).toContain("input[type='email']");
    evaluateMock.mockRestore();
    navMock.mockRestore();
  }, 30000);
});
