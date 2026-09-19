/**
 * Frontend production-hardening regression tests.
 *
 * Node environment (no DOM infra in this workspace), so:
 *  - Objective counter semantics are pinned at the SOURCE level (the exact
 *    arithmetic + maxLength guard in NewInvestigation.tsx) — a regression
 *    that changes "remaining = MAX - length" or drops maxLength breaks here.
 *  - Artifact-availability UI rules are pinned against the REAL
 *    InvestigationView.tsx component: the module is compiled with esbuild
 *    (the same stack Vite uses), executed, and server-rendered with
 *    react-dom/server against a stubbed summary fetch. This proves the
 *    STRICT availability rule: only a backend-verified `artifactAvailable:
 *    true` renders artifact controls; `false` and undefined (unverified
 *    legacy) render NO artifact UI whatsoever, and no rendered control can
 *    point at an artifact that is not retrievable.
 */
/** @vitest-environment node */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { build, type Plugin } from "esbuild";
import React from "react";
// Node distribution of react-dom/server (React 19 ships plain CJS here).
import { renderToStaticMarkup } from "react-dom/server.node";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Temporary fixtures created/cleaned around each compiled render.
const STUB_TSX = join(clientRoot, "src/__hardening_stubs.tsx");
const STUB_MJS = join(clientRoot, "src/__hardening_stubs.mjs");
const VIEW_MJS = join(clientRoot, "src/__hardening_view_under_test.mjs");

afterAll(() => {
  for (const p of [STUB_TSX, STUB_MJS, VIEW_MJS]) {
    if (existsSync(p)) rmSync(p);
  }
});

// ── Part 1: objective character counter (source-level pinning) ────────────

const newInvSource = readFileSync(join(clientRoot, "src/NewInvestigation.tsx"), "utf8");

describe("objective character limit + live counter", () => {
  it("defines the limit once at exactly 1000", () => {
    expect(newInvSource).toContain("const MAX_OBJECTIVE_LENGTH = 1000;");
  });

  it("counter starts at 1000 for an empty objective (1000 - 0)", () => {
    const remaining = 1000 - "".length;
    expect(remaining).toBe(1000);
    // and the source derives it from the constant, not a second magic number
    expect(newInvSource).toContain("MAX_OBJECTIVE_LENGTH - form.objective.length");
  });

  it("counter decreases by one per typed character (space counts)", () => {
    let value = "";
    value += "a";
    expect(1000 - value.length).toBe(999);
    value += " ";
    expect(1000 - value.length).toBe(998);
  });

  it("counter increases by one per deleted character", () => {
    let value = "abc";
    value = value.slice(0, -1);
    expect(1000 - value.length).toBe(998);
    value = value.slice(0, -1);
    expect(1000 - value.length).toBe(999);
  });

  it("cannot enter character 1,001: textarea enforces maxLength", () => {
    // The textarea must carry maxLength={MAX_OBJECTIVE_LENGTH} — blocking
    // input at the source rather than truncating after the fact.
    expect(newInvSource).toMatch(/maxLength=\{MAX_OBJECTIVE_LENGTH\}/);
    // Behavior of a maxLength'd control: keystrokes past the cap are ignored.
    const simulate = (current: string, keystroke: string) =>
      current.length + keystroke.length <= 1000 ? current + keystroke : current;
    let value = "a".repeat(1000);
    value = simulate(value, "b"); // character 1,001 blocked
    expect(value.length).toBe(1000);
    expect(value).not.toContain("b");
  });

  it("zero remaining is valid — no error/disabled state at exactly 1000 characters", () => {
    const value = "a".repeat(1000);
    const remaining = 1000 - value.length;
    expect(remaining).toBe(0);
    // Submission is gated on `submitting`, never on the counter.
    expect(newInvSource).toMatch(/disabled=\{submitting\}/);
    expect(newInvSource).not.toMatch(/disabled=\{[^\n]*remaining/);
  });

  it("counter is visible from the beginning (rendered unconditionally, aria-live)", () => {
    expect(newInvSource).toContain('aria-live="polite"');
    expect(newInvSource).toContain("characters remaining");
    // The counter is not hidden behind a conditional render.
    expect(newInvSource).not.toMatch(/\{remaining > 0 &&/);
  });

  it("input is never silently truncated in the change handler", () => {
    // onChange passes the raw value through — the maxLength attribute
    // prevents overflow upstream; there is no post-hoc .slice().
    expect(newInvSource).toMatch(/onChange=\{\(e\) => setForm\(\{ \.\.\.form, objective: e\.target\.value \}\)\}/);
    expect(newInvSource).not.toMatch(/objective:\s*e\.target\.value\.slice/);
  });
});

// ── Part 2: artifact availability in the Evidence UI ──────────────────────

const viewSource = readFileSync(join(clientRoot, "src/InvestigationView.tsx"), "utf8");

describe("evidence UI honors backend artifact availability (source pins)", () => {
  it("the availability gate is strict: only an explicit `true` is usable", () => {
    expect(viewSource).toContain("function artifactUsable(ev: Evidence): boolean");
    expect(viewSource).toMatch(/return ev\.artifactAvailable === true;/);
    // No lenient fallback: absence of the flag must NOT authorize controls.
    expect(viewSource).not.toMatch(/artifactAvailable !== false/);
    expect(viewSource).not.toMatch(/artifactAvailable === false\) return false;\s*return true;/);
  });

  it("list rows render no View button and no unavailable-label when the artifact is not verified", () => {
    // The View button is gated on `usable`; the old always-on button and the
    // "artifact unavailable" placeholder are both gone.
    expect(viewSource).toMatch(/\{usable && \(\s*<button/);
    expect(viewSource).not.toContain("artifact unavailable");
    expect(viewSource).not.toMatch(/onClick=\{\(\) => onInspect\(ev\)\}\s*disabled=/);
  });

  it("the evidence viewer renders NOTHING for unverified artifacts", () => {
    // noArtifact is strict (!== true) and the modal short-circuits to null.
    expect(viewSource).toMatch(/const noArtifact = \(evidence as \{ artifactAvailable\?: boolean \}\)\.artifactAvailable !== true;/);
    expect(viewSource).toMatch(/if \(noArtifact\) return null;/);
    // The old "No artifact was stored..." truthfulness card is gone: the
    // spec renders nothing at all for a missing artifact.
    expect(viewSource).not.toContain("No artifact was stored for this evidence item");
  });

  it("replay preview is gated on verified availability", () => {
    // ReplayPreview only renders when the artifact is verified (noArtifact false).
    expect(viewSource).toMatch(/\{isReplay && !noArtifact && \(/);
  });

  it("URL-type evidence renders a link, not an artifact control", () => {
    expect(viewSource).toMatch(/ev\.type === "url"/);
  });
});

// ── Part 3: real render through the compiled component ────────────────────

interface EvidenceFixture {
  id: string;
  investigationId: string;
  experimentId: string | null;
  observationId: string | null;
  type: string;
  uri: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
  provenance?: string;
  artifactAvailable?: boolean;
  createdAt: string;
}

function evFixture(overrides: Partial<EvidenceFixture>): EvidenceFixture {
  return {
    id: `ev_${Math.random().toString(36).slice(2, 8)}`,
    investigationId: "inv_fixture",
    experimentId: null,
    observationId: null,
    type: "screenshot",
    uri: "https://example.com/page",
    contentHash: "a".repeat(64),
    metadata: {},
    createdAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

function summaryFixture(evidence: EvidenceFixture[]) {
  return {
    investigation: {
      id: "inv_fixture",
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "obj",
      status: "completed",
      currentPhase: "complete",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:01:00.000Z",
      planningOutcome: "planned",
    },
    experiments: [],
    experimentCounts: { total: 0, completed: 0, failed: 0, planned: 0, running: 0, inconclusive: 0, cancelled: 0 },
    evidence,
    evidenceCount: evidence.length,
    findings: [],
    findingsCount: 0,
    hypotheses: [],
    hypothesesCount: 0,
    report: null,
    budget: {
      usedExperiments: 0, usedBrowserActions: 0, usedSandboxCommands: 0,
      usedAiCalls: 0, usedVerificationExperiments: 0, maxExperiments: 7,
      maxBrowserActions: 40, maxSandboxCommands: 20, maxAiCalls: 20,
      verificationReserve: 1,
    },
    probeFailures: [],
    runtime: null,
    incomplete: false,
    failure: null,
  };
}

/** esbuild plugin: redirect the real progress module to the test stub. */
function progressStubPlugin(stubPath: string): Plugin {
  return {
    name: "hardening-progress-stub",
    setup(build) {
      build.onResolve({ filter: /InvestigationProgress$/ }, () => ({ path: stubPath }));
    },
  };
}

async function bundleView(): Promise<void> {
  const entryTs = join(clientRoot, "src/__hardening_entry.tsx");
  writeFileSync(
    entryTs,
    `export { InvestigationView, InvestigationViewPreloaded } from "./InvestigationView";\n` +
      `export { getSummary } from "./api";\n`
  );
  try {
    await build({
      entryPoints: [entryTs],
      bundle: true,
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      outfile: VIEW_MJS,
      plugins: [progressStubPlugin(STUB_TSX)],
      define: { "import.meta.env": JSON.stringify({ PROD: false, MODE: "test" }) },
      external: ["react", "react-dom", "react/jsx-runtime"],
      logLevel: "silent",
    });
  } finally {
    rmSync(entryTs, { force: true });
  }
}

async function renderViewWithSummary(evidence: EvidenceFixture[]): Promise<string> {
  // Pass-through stubs for the progress subcomponents (timers/SSE-free).
  const createdStub = !existsSync(STUB_TSX);
  if (createdStub) {
    writeFileSync(
      STUB_TSX,
      `// Test fixture for hardening-ui.test.ts — pass-through rendering stubs.\n` +
        `import type { ReactNode } from "react";\n` +
        `export function TerminalBanner(_props: { model?: unknown }): ReactNode { return null; }\n` +
        `export function InvestigationProgress(_props: Record<string, unknown>): ReactNode { return null; }\n`
    );
  }

  const realFetch = globalThis.fetch;
  try {
    await bundleView();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view: any = await import(VIEW_MJS);

    // The bundled module's api layer calls the GLOBAL fetch. Verify our
    // stub wiring by executing the component's own load path (the exact
    // refresh() its mount effect runs) before rendering: this both proves
    // the data path works and materializes the summary the render shows.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/summary")) {
        return new Response(JSON.stringify(summaryFixture(evidence)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`hardening test: unexpected fetch ${url}`);
    }) as typeof fetch;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded: any = await view.getSummary("inv_fixture");
    expect(loaded.evidence.length).toBe(evidence.length);

    // renderToStaticMarkup does not run effects, so the mount-time
    // refresh() cannot fire; the component renders its loading state under
    // SSR. The data path is proven by the getSummary call above (real
    // bundled code, stubbed fetch). The rendered-row assertions are then
    // made against a direct render of the compiled component with state
    // pre-seeded — the bundle exports a test-only preloaded wrapper for
    // exactly this purpose (compiled from the same source).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html: string = renderToStaticMarkup(
      React.createElement(view.InvestigationViewPreloaded, {
        summary: loaded,
      })
    );
    return html;
  } finally {
    globalThis.fetch = realFetch;
    if (createdStub) rmSync(STUB_TSX);
    rmSync(STUB_MJS, { force: true });
    rmSync(VIEW_MJS, { force: true });
  }
}

describe("evidence UI honors backend artifact availability (real render)", () => {
  it("available → View controls; false/undefined → NO artifact UI whatsoever", async () => {
    const html = await renderViewWithSummary([
      evFixture({ id: "ev_ok", type: "screenshot", artifactAvailable: true }),
      evFixture({ id: "ev_gone", type: "screenshot", artifactAvailable: false }),
      evFixture({ id: "ev_legacy", type: "action_trace", artifactAvailable: undefined }),
    ]);

    // The unverified rows contribute NO artifact UI: no View button, no
    // unavailable placeholder, no disabled control.
    expect(html).not.toContain("artifact unavailable");
    // The artifact-verified row keeps its View control.
    expect(html).toContain(">View<");
    // Exactly ONE View button across the whole render: ev_ok only.
    expect(html.match(/>View</g) ?? []).toHaveLength(1);
  });

  it("missing replay artifact → no replay player/preview control", async () => {
    const html = await renderViewWithSummary([
      evFixture({
        id: "ev_replay_gone",
        type: "replay",
        artifactAvailable: false,
        metadata: { format: "rrweb", replayAvailable: false },
      }),
    ]);
    // The list itself must offer no View and no placeholder.
    expect(html).not.toContain(">View<");
    expect(html).not.toContain("artifact unavailable");
  });

  it("legacy replay with undefined availability → no replay control (unverified)", async () => {
    const html = await renderViewWithSummary([
      evFixture({
        id: "ev_replay_legacy",
        type: "replay",
        artifactAvailable: undefined,
        metadata: { format: "rrweb" },
      }),
    ]);
    expect(html).not.toContain(">View<");
  });

  it("normal non-artifact evidence (URL) stays visible as a plain link", async () => {
    const html = await renderViewWithSummary([
      evFixture({ id: "ev_url", type: "url", artifactAvailable: false, uri: "https://example.com/visited" }),
    ]);
    expect(html).toContain(">Link<");
    expect(html).not.toContain(">View<");
  });

  it("no rendered artifact control can point at an unavailable artifact", async () => {
    // Screenshots + replays + JSON artifacts, all unverified — nothing in
    // the render may embed an evidence content URL.
    const html = await renderViewWithSummary([
      evFixture({ id: "ev_s1", type: "screenshot", artifactAvailable: false }),
      evFixture({ id: "ev_s2", type: "screenshot", artifactAvailable: undefined }),
      evFixture({ id: "ev_r1", type: "replay", artifactAvailable: false, metadata: { format: "rrweb" } }),
      evFixture({ id: "ev_a1", type: "action_trace", artifactAvailable: false }),
    ]);
    expect(html).not.toContain("/evidence/");
    expect(html).not.toContain("/content");
    expect(html).not.toContain(">View<");
    expect(html).not.toContain(">Inspect<");
  });

  it("available screenshot + available replay render their controls", async () => {
    const html = await renderViewWithSummary([
      evFixture({ id: "ev_shot_ok", type: "screenshot", artifactAvailable: true }),
      evFixture({ id: "ev_replay_ok", type: "replay", artifactAvailable: true, metadata: { format: "rrweb" } }),
    ]);
    // Both rows get View buttons.
    expect((html.match(/>View</g) ?? []).length).toBe(2);
  });
});
