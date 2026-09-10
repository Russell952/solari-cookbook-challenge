/**
 * AI context budget tests.
 *
 * Probes the guarantees that prevent the original production failure
 * (`The request is 274966 tokens long and exceeds this model's context
 * length of 262144 tokens`):
 *
 *  1. A normal, under-budget prompt is sent to the provider unchanged.
 *  2. An oversized prompt is compacted before the provider call.
 *  3. Whatever the input, the request body that reaches the provider is
 *     within the configured budget.
 *  4. Base64-heavy evidence (the actual overflow source) cannot produce an
 *     oversized request.
 *  5. The current objective / experiment / observation survive compaction.
 *  6. Compaction only affects prompt text — caller data and the evidence
 *     store are never mutated.
 *  7. The historical ~275K-token prompt shape now stays within budget.
 *
 * The provider boundary is stubbed with `fetch` so the exact request bodies
 * are inspected — this tests the real adapter, not a mock of it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  AI_CONTEXT_BUDGET_TOKENS,
  estimatePromptTokens,
  enforceContextBudget,
  compactEvidenceForPrompt,
  summarizeExperimentHistory,
  createOpenAIAdapter,
} from "../ai/openai.js";
import type { Observation, RepositoryRecon, ApplicationRecon, Evidence } from "@probe/shared";

const REAL_FETCH = globalThis.fetch;

interface CapturedRequest {
  body: { messages: Array<{ role: string; content: string }> };
}

/**
 * Default provider response: dispatches on the user-prompt shape so each
 * adapter method receives a structurally valid AI response.
 */
function defaultProviderResponse(body: CapturedRequest["body"]): string {
  const user = body.messages.find((m) => m.role === "user")?.content ?? "";
  if (user.includes("Evidence references (compact metadata")) {
    return '{"statement":"h","confidence":0.5,"supportingEvidenceIds":[],"contradictingEvidenceIds":[]}';
  }
  if (user.includes("New evidence (compact metadata")) {
    return '{"confidence":0.7,"status":"inconclusive"}';
  }
  if (user.includes("Existing evidence (compact metadata")) {
    return '{"shouldVerify":false,"verificationExperiment":null}';
  }
  if (user.includes("Findings:")) {
    return '{"summary":"s","confirmedFindings":[],"rejectedHypotheses":[],"inconclusiveHypotheses":[]}';
  }
  return '{"experiments":[{"objective":"o","preconditions":[],"plannedActions":[{"tool":"browser","action":"navigate","target":"https://example.com/"}]}]}';
}

async function captureProviderRequests(
  handler?: (body: CapturedRequest["body"]) => unknown,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"];
      captured.push({ body });
      const content = handler ? handler(body) : defaultProviderResponse(body);
      // OpenAI-compatible completion envelope.
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Fixture data ────────────────────────────────────────────────────────────

/** A single full-page screenshot worth of base64 (~1.4MB ≈ 350k+ tokens raw). */
const HUGE_BASE64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(1_400_000) + "==";

function makeRecon(screenshot: string): ApplicationRecon {
  return {
    pageTitle: "Demo App",
    initialUrl: "https://example.com/",
    navigation: ["Home", "About"],
    forms: ["#login-form"],
    buttons: ["button[type=submit]"],
    links: ["a[href='#about']"],
    screenshot,
    primaryWorkflow: null,
    interactableElements: [
      { selector: "a[href='#about']", text: "About", tag: "a" },
      { selector: "button[type=submit]", text: "Sign in", tag: "button" },
    ],
  };
}

function makeRepoRecon(readme: string): RepositoryRecon {
  return {
    readme,
    packageManager: "npm",
    language: "TypeScript",
    framework: "React",
    testScripts: ["test"],
    devScripts: ["dev"],
    startScripts: ["start"],
    sourceDirectories: ["src"],
    configFiles: ["package.json"],
    packageJson: { name: "demo", scripts: { dev: "vite" } },
  };
}

function makeEvidence(
  n: number,
  opts: { bigMetadata?: boolean; fromExperiment?: string } = {},
): Evidence[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev_${String(i).padStart(3, "0")}`,
    investigationId: "inv_test",
    experimentId: opts.fromExperiment ?? (i === 0 ? null : "exp_1"),
    type: i % 2 === 0 ? "action_trace" : "observed_result",
    uri: null,
    content: Buffer.from("full artifact payload — never belongs in a prompt"),
    metadata: opts.bigMetadata
      ? { trace: Array.from({ length: 400 }, (_, j) => `step ${j}: clicked element ${j} and read text back`).join("; ") }
      : { note: "small" },
    createdAt: new Date().toISOString(),
  })) as unknown as Evidence[];
}

function makeObservations(n: number, experimentId: string): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `obs_${String(i).padStart(3, "0")}`,
    experimentId,
    actionId: `act_${i}`,
    expected: "Submit button navigates to /dashboard",
    actual:
      `Observation ${i}: clicked submit, page showed the dashboard heading and the ` +
      "session banner; navigation matched the documented behavior. ".repeat(8),
    type: "behavior" as const,
    description: `Observed outcome ${i} for the current experiment step`,
    timestamp: new Date().toISOString(),
  }));
}

// ── Estimator ───────────────────────────────────────────────────────────────

describe("estimatePromptTokens", () => {
  it("counts prose conservatively", () => {
    // 3500 chars ≈ 1000+ estimated tokens (3.5 chars/token, ×1.05 safety)
    expect(estimatePromptTokens("a".repeat(3500))).toBeGreaterThanOrEqual(1000);
  });

  it("counts base64 far denser than prose", () => {
    const b64 = "A".repeat(70_000); // 70k base64 chars
    expect(estimatePromptTokens(b64)).toBeGreaterThanOrEqual(35_000);
  });

  it("the historical oversized prompt estimates over the provider limit", () => {
    const historical = makeRecon(HUGE_BASE64);
    const prompt =
      "Objective: investigate login flow\n\nApplication Recon: " +
      JSON.stringify(historical, null, 2);
    expect(estimatePromptTokens(prompt)).toBeGreaterThan(262_144);
  });
});

// ── enforceContextBudget ────────────────────────────────────────────────────

describe("enforceContextBudget", () => {
  it("returns under-budget text unchanged", () => {
    const text = "Objective: current\nExperiment: step\nObservation: result\n";
    expect(enforceContextBudget(text, "test", 100_000)).toBe(text);
  });

  it("compacts an oversized prompt below the limit", () => {
    const text = "Objective: keep me\n" + ("detail line with content ".repeat(8) + "\n").repeat(30_000);
    const out = enforceContextBudget(text, "test", 50_000);
    expect(estimatePromptTokens(out)).toBeLessThanOrEqual(50_000);
  });

  it("keeps head content (current objective/experiment) through hard truncation", () => {
    const head = "Objective: THE CURRENT OBJECTIVE\nExperiment: THE CURRENT EXPERIMENT\n";
    const text = head + "x".repeat(2_000_000);
    const out = enforceContextBudget(text, "test", 20_000);
    expect(out.startsWith(head)).toBe(true);
    expect(estimatePromptTokens(out)).toBeLessThanOrEqual(20_000);
    expect(out).toContain("truncated");
  });

  it("guarantees budget for a base64-dominated prompt", () => {
    const text = "Recon: " + HUGE_BASE64;
    const out = enforceContextBudget(text, "test", 30_000);
    expect(estimatePromptTokens(out)).toBeLessThanOrEqual(30_000);
  });
});

// ── Evidence compaction ─────────────────────────────────────────────────────

describe("compactEvidenceForPrompt", () => {
  it("references evidence by id/type instead of full metadata payloads", () => {
    const out = compactEvidenceForPrompt(makeEvidence(20, { bigMetadata: true }));
    expect(out).toContain("ev_000");
    expect(out.length).toBeLessThan(20 * 1200); // capped per item
    expect(out).toContain("retained in evidence store");
  });

  it("does not mutate the evidence objects it compacts", () => {
    const evidence = makeEvidence(3, { bigMetadata: true });
    const traceLen = (e: Evidence) => ((e.metadata as { trace?: string } | null)?.trace ?? "").length;
    const before = JSON.stringify(evidence.map(traceLen));
    compactEvidenceForPrompt(evidence);
    const after = JSON.stringify(evidence.map(traceLen));
    expect(after).toBe(before);
  });
});

describe("summarizeExperimentHistory", () => {
  it("keeps only the most recent experiments and marks omissions explicitly", () => {
    const experiments = Array.from({ length: 50 }, (_, i) => ({
      sequence: i,
      objective: `experiment ${i}`,
      status: "completed",
      result: "ok",
      error: null,
    }));
    const out = summarizeExperimentHistory(experiments, 5);
    expect(out).toContain("earlier experiments omitted");
    expect(out).toContain("experiment 49");
    expect(out).not.toContain("experiment 40\n");
  });
});

// ── End-to-end: adapter requests to the provider ────────────────────────────

describe("adapter requests never exceed the context budget", () => {
  it("sends an under-budget plan request unchanged", async () => {
    const captured = await captureProviderRequests(
      () => '{"experiments":[{"objective":"check login","preconditions":[],"plannedActions":[{"tool":"browser","action":"navigate","target":"https://example.com/login"}]}]}',
    );
    const adapter = createOpenAIAdapter();
    await adapter.plan("Investigate the login flow", makeRepoRecon("# Small readme"), makeRecon(HUGE_BASE64));

    expect(captured).toHaveLength(1);
    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    // Base64 screenshot stripped at the source, prompt sent verbatim (no truncation marker).
    expect(userContent).not.toContain("A".repeat(200));
    expect(userContent).not.toContain("truncated");
    expect(userContent).toContain("Investigate the login flow");
    expect(userContent).toContain("a[href='#about']");
  });

  it("plan(): the historical base64-screenshot recon produces an in-budget request", async () => {
    const captured = await captureProviderRequests(
      () => '{"experiments":[{"objective":"check login","preconditions":[],"plannedActions":[{"tool":"browser","action":"navigate","target":"https://example.com/login"}]}]}',
    );
    const adapter = createOpenAIAdapter();
    await adapter.plan("Investigate", makeRepoRecon("# Readme"), makeRecon(HUGE_BASE64));

    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    expect(userContent).toContain("persisted as recon evidence");
  });

  it("analyzeObservation(): current-experiment observations survive; request stays in budget", async () => {
    const captured = await captureProviderRequests(() => "Analysis of the current experiment.");
    const adapter = createOpenAIAdapter();
    const currentObs = makeObservations(6, "exp_current");
    const olderObs = makeObservations(60, "exp_old");
    await adapter.analyzeObservation(
      [...olderObs, ...currentObs],
      { id: "exp_current", objective: "Verify submit button behavior", status: "completed", investigationId: "inv", sequence: 2, hypothesisId: null, preconditions: [], plannedActions: [], result: null, error: null, createdAt: "", updatedAt: "" },
      "Current investigation objective",
    );

    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    // Current experiment context survives verbatim.
    expect(userContent).toContain("Verify submit button behavior");
    expect(userContent).toContain("Current investigation objective");
    expect(userContent).toContain("Observed outcome 5 for the current experiment step");
    // Older experiments are summarized, not dumped.
    expect(userContent).toContain("earlier experiments summarized");
  });

  it("generateHypothesis(): 275K-token-shaped evidence input stays within budget", async () => {
    const captured = await captureProviderRequests(
      () => '{"statement":"h","confidence":0.5,"supportingEvidenceIds":[],"contradictingEvidenceIds":[]}',
    );
    const adapter = createOpenAIAdapter();
    // ~1000 items × ~9KB metadata ≈ the historical 275K-token shape.
    const evidence = makeEvidence(1000, { bigMetadata: true });
    const bigAnalysis = "Analysis text. ".repeat(20_000); // also oversized
    await adapter.generateHypothesis(bigAnalysis, evidence, "Find login bugs");

    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    // Priority order: the objective/analysis head survives compaction.
    expect(userContent).toContain("Find login bugs");
    expect(userContent).toContain("Analysis text.");
  });

  it("generateReport(): every experiment + evidence still yields an in-budget request", async () => {
    const captured = await captureProviderRequests(
      () => '{"summary":"s","confirmedFindings":[],"rejectedHypotheses":[],"inconclusiveHypotheses":[]}',
    );
    const adapter = createOpenAIAdapter();
    const experiments = Array.from({ length: 120 }, (_, i) => ({
      sequence: i,
      objective: `Experiment ${i}: probe the application behavior around module ${i}`,
      status: "completed",
      result: "The application behaved as documented",
      error: null,
    }));
    await adapter.generateReport(
      { objective: "Full investigation of the demo app", repositoryUrl: "https://github.com/example/demo", applicationUrl: "https://example.com" } as Parameters<typeof adapter.generateReport>[0],
      [],
      [],
      experiments as Parameters<typeof adapter.generateReport>[3],
      makeEvidence(1500, { bigMetadata: true }),
    );

    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    expect(userContent).toContain("Full investigation of the demo app");
  });

  it("designVerification() and evaluateEvidence() stay in budget with huge evidence", async () => {
    const captured = await captureProviderRequests();
    const adapter = createOpenAIAdapter();
    const evidence = makeEvidence(500, { bigMetadata: true });
    await adapter.designVerification({ statement: "Login is broken", confidence: 0.6, status: "investigating", investigationId: "inv", id: "hyp_1", createdAt: "", updatedAt: "" } as Parameters<typeof adapter.designVerification>[0], evidence);
    await adapter.evaluateEvidence({ statement: "Login is broken", confidence: 0.6, status: "investigating", investigationId: "inv", id: "hyp_1", createdAt: "", updatedAt: "" } as Parameters<typeof adapter.evaluateEvidence>[0], evidence);

    for (const req of captured) {
      const userContent = req.body.messages.find((m) => m.role === "user")!.content;
      expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    }
  });

  it("decideNextStep(): adaptive loop with big recon + history stays in budget", async () => {
    const captured = await captureProviderRequests(() => '{"shouldContinue":false,"reason":"enough"}');
    const adapter = createOpenAIAdapter();
    await adapter.decideNextStep(
      "Investigate mobile navigation",
      Array.from({ length: 80 }, (_, i) => ({ sequence: i, objective: `experiment ${i}`, status: "completed", result: "ok", error: null })) as Parameters<typeof adapter.decideNextStep>[1],
      makeEvidence(800, { bigMetadata: true }),
      "Analysis. ".repeat(30_000),
      2,
      30,
      makeRecon(HUGE_BASE64),
    );

    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    expect(userContent).toContain("Investigate mobile navigation");
  });

  it("every provider request body — system + user combined — is within the configured budget", async () => {
    const captured = await captureProviderRequests();
    const adapter = createOpenAIAdapter();
    await adapter.plan("Objective", makeRepoRecon("# R"), makeRecon(HUGE_BASE64));
    await adapter.generateHypothesis("Analysis. ".repeat(40_000), makeEvidence(1200, { bigMetadata: true }), "Objective");

    for (const req of captured) {
      const total = req.body.messages.reduce((sum, m) => sum + estimatePromptTokens(m.content), 0);
      // The wire format (roles + model + serialization) adds negligible
      // tokens; total must stay below the configured application budget.
      expect(total).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS);
    }
  });
});

// ── Data integrity ──────────────────────────────────────────────────────────

describe("compaction never mutates caller data", () => {
  it("recon/evidence/observation inputs are unchanged after adapter calls", async () => {
    await captureProviderRequests();
    const adapter = createOpenAIAdapter();

    const recon = makeRecon(HUGE_BASE64);
    const evidence = makeEvidence(10, { bigMetadata: true });
    const observations = makeObservations(5, "exp_1");
    const reconBefore = recon.screenshot.length;
    const evidenceBefore = JSON.stringify(evidence.map((e) => e.metadata).map((m) => (m?.trace as string | undefined)?.length));
    const obsBefore = JSON.stringify(observations.map((o) => o.actual.length));

    await adapter.plan("Objective", makeRepoRecon("# R"), recon);
    await adapter.generateHypothesis("analysis", evidence, "Objective");
    await adapter.analyzeObservation(
      observations,
      { id: "exp_1", objective: "o", status: "completed", investigationId: "inv", sequence: 1, hypothesisId: null, preconditions: [], plannedActions: [], result: null, error: null, createdAt: "", updatedAt: "" },
      "Objective",
    );

    expect(recon.screenshot.length).toBe(reconBefore);
    expect(JSON.stringify(evidence.map((e) => e.metadata).map((m) => (m?.trace as string | undefined)?.length))).toBe(evidenceBefore);
    expect(JSON.stringify(observations.map((o) => o.actual.length))).toBe(obsBefore);
  });
});

// ── Evidence capture integrity ────────────────────────────────────────────

describe("evidence capture integrity alongside budget enforcement", () => {
  it("prompts reference evidence metadata, never embedded artifacts, and capture interface is untouched", async () => {
    const captured = await captureProviderRequests(
      () => '{"statement":"h","confidence":0.5,"supportingEvidenceIds":[],"contradictingEvidenceIds":[]}',
    );
    const adapter = createOpenAIAdapter();
    const evidence = makeEvidence(50, { bigMetadata: true });
    await adapter.generateHypothesis("analysis", evidence, "Objective");

    // The captured prompt must reference, not embed: no full artifact text.
    const userContent = captured[0].body.messages.find((m) => m.role === "user")!.content;
    expect(userContent).not.toContain("full artifact payload");
    expect(estimatePromptTokens(userContent)).toBeLessThanOrEqual(AI_CONTEXT_BUDGET_TOKENS - 256);
    // Evidence capture interface untouched by this change.
    const { captureEvidence } = await import("../evidence/collector.js");
    expect(typeof captureEvidence).toBe("function");
  });
});
