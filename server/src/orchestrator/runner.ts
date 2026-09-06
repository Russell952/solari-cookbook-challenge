/**
 * Investigation runner.
 *
 * Executes the full lifecycle of an investigation:
 * recon → plan → experiment → execute → observe → analyze → hypothesis → verification → report
 *
 * The orchestrator is the boss. The AI proposes actions.
 * The orchestrator validates and executes them.
 */
import type {
  Investigation,
  Experiment,
  Observation,
  RepositoryRecon,
  ApplicationRecon,
  InvestigationPhase,
  Hypothesis,
  Finding,
  Evidence,
} from "@probe/shared";
import { transitionPhase, transitionStatus } from "@probe/shared";
import type { ProbeBrowserSession } from "../solari/browser.js";
import { store } from "../store/index.js";
import { createOpenAIAdapter, type AIAdapter } from "../ai/index.js";
import * as browser from "../solari/browser.js";
import type { ReconContext } from "../solari/browser.js";
import * as sandbox from "../solari/sandbox.js";
import { resolveFindingEvidenceIds } from "./finding-evidence.js";
import { VALID_ACTIONS_BY_TOOL as VALID_ACTIONS, looksLikeCssSelector } from "./action-allowlist.js";
import {
  captureScreenshot,
  captureUrlEvidence,
  captureActionTrace,
  captureRepositoryEvidence,
  captureReplay,
} from "../evidence/index.js";
import * as budget from "./budget.js";
import { emit } from "../api/events.js";
import { setAiRequestRecorder } from "../ai/openai.js";

let ai: AIAdapter | null = null;

function getAI(): AIAdapter {
  if (!ai) ai = createOpenAIAdapter();
  return ai;
}

/**
 * Thrown when an investigation is cancelled or its runtime budget expires
 * mid-run. Propagates out of phase functions to the main run loop, which
 * finalizes the investigation with the correct terminal status while
 * preserving cleanup guarantees.
 */
class InvestigationStoppedError extends Error {
  constructor(
    public readonly reason: "cancelled" | "runtime_expired",
    public readonly investigationId: string
  ) {
    super(
      reason === "cancelled"
        ? `Investigation ${investigationId} was cancelled`
        : `Investigation ${investigationId} exceeded its runtime budget`
    );
    this.name = "InvestigationStoppedError";
  }
}

/**
 * Check whether the investigation should stop at a safe boundary.
 *
 * Called between phases, before starting an experiment, between browser
 * actions, and before expensive AI calls. Cancellation is authoritative —
 * the status is re-read from the store so an API-initiated cancel takes
 * effect immediately. Runtime expiry also raises here.
 *
 * A terminal investigation (cancelled/failed/completed) can never be
 * resumed, and cancelled/expired investigations never fall through to the
 * completed path.
 */
function assertNotStopped(investigationId: string): void {
  const inv = store.getInvestigation(investigationId);
  if (!inv) {
    throw new InvestigationStoppedError("cancelled", investigationId);
  }
  if (inv.status === "cancelled") {
    throw new InvestigationStoppedError("cancelled", investigationId);
  }
  if (budget.isExpired(investigationId)) {
    throw new InvestigationStoppedError("runtime_expired", investigationId);
  }
}

/**
 * Pause-aware variant: like assertNotStopped, but a paused investigation
 * does NOT throw — it suppresses the current continuation. Used by the API
 * layer contract: pause must stop *new* work from starting without killing
 * the runner (resume re-enters runInvestigation from the current phase).
 */
function isPaused(investigationId: string): boolean {
  const inv = store.getInvestigation(investigationId);
  return inv?.status === "paused";
}

/**
 * Transition the investigation to a new phase.
 * Validates the transition is allowed, then updates the store and emits an event.
 * Throws InvalidTransitionError if the transition is not allowed.
 */
function advancePhase(investigation: Investigation, to: InvestigationPhase): Investigation {
  transitionPhase(investigation.currentPhase, to);
  const updated = store.updateInvestigation(investigation.id, { currentPhase: to });
  emit("phase_change", investigation.id, { phase: to });
  return updated;
}

// ── Recon Phase ────────────────────────────────────────────────────────────

async function runRecon(investigation: Investigation): Promise<Investigation> {
  investigation = advancePhase(investigation, "recon");

  // 1. Repository recon via sandbox
  let repoRecon: RepositoryRecon | null = null;
  if (investigation.repositoryUrl) {
    repoRecon = await performRepositoryRecon(investigation);
  }

  // 2. Application recon via browser
  let appRecon: ApplicationRecon | null = null;
  if (investigation.applicationUrl) {
    appRecon = await performApplicationRecon(investigation);
  }

  // Store recon results as evidence
  if (repoRecon) {
    const hasError = !!repoRecon.error;
    await captureRepositoryEvidence(
      investigation.id,
      hasError ? "recon/repository-error" : "recon/repository",
      JSON.stringify(repoRecon, null, 2),
      { type: hasError ? "repository_recon_error" : "repository_recon", ...(hasError ? { error: repoRecon.error, errorSource: repoRecon.errorSource } : {}) }
    );
  }
  if (appRecon) {
    await captureScreenshot(
      investigation.id,
      "recon",
      Buffer.from(appRecon.screenshot, "base64"),
      { type: "application_recon" }
    );
    await captureUrlEvidence(investigation.id, "recon", appRecon.initialUrl, appRecon.pageTitle);
  }

  // Store recon results for later phases
  (investigation as Investigation & { _repoRecon?: RepositoryRecon; _appRecon?: ApplicationRecon })._repoRecon = repoRecon ?? undefined;
  (investigation as Investigation & { _repoRecon?: RepositoryRecon; _appRecon?: ApplicationRecon })._appRecon = appRecon ?? undefined;

  return investigation;
}

async function performRepositoryRecon(investigation: Investigation): Promise<RepositoryRecon> {
  let session: Awaited<ReturnType<typeof sandbox.createSandboxSession>> | null = null;

  try {
    session = await sandbox.createSandboxSession(investigation.id, { timeoutMs: 3 * 60_000 });

    // Clone the repository
    const cloneResult = await sandbox.cloneRepository(session, investigation.repositoryUrl);
    if (cloneResult.exitCode !== 0) {
      const errorMsg = `Repository clone failed (exit ${cloneResult.exitCode}): ${cloneResult.output.slice(0, 500)}`;
      console.error(`[${investigation.id}] ${errorMsg}`);
      emit("error", investigation.id, { phase: "recon", source: "sandbox/git", error: errorMsg });
      await captureRepositoryEvidence(
        investigation.id, "recon/repository-error",
        JSON.stringify({ error: errorMsg, source: "git", exitCode: cloneResult.exitCode, output: cloneResult.output.slice(0, 1000) }, null, 2),
        { type: "repository_recon_error", source: "git" }
      );
      // Return minimal recon with error indication
      return {
        readme: null, packageManager: null, language: null, framework: null,
        testScripts: [], devScripts: [], startScripts: [], sourceDirectories: [],
        configFiles: [], packageJson: null,
        error: errorMsg, errorSource: "git",
      };
    }

    // Read key files
    let readme: string | null = null;
    try { readme = await sandbox.readFile(session, "/workspace/repo/README.md"); } catch { /* no readme */ }

    let packageJson: Record<string, unknown> | null = null;
    try {
      const raw = await sandbox.readFile(session, "/workspace/repo/package.json");
      packageJson = JSON.parse(raw);
    } catch { /* no package.json */ }

    // Detect language and framework
    let language: string | null = null;
    let framework: string | null = null;
    let packageManager: string | null = null;

    if (packageJson) {
      const deps = { ...(packageJson.dependencies as Record<string, string>), ...(packageJson.devDependencies as Record<string, string>) };
      if (deps.react || deps["next"] || deps.vue || deps.svelte) framework = "js/ts";
      if (deps.next) framework = "next.js";
      if (deps.nuxt) framework = "nuxt";
      if (deps.svelte || deps["@sveltejs/kit"]) framework = "sveltekit";
      if (deps.astro) framework = "astro";
      if (deps.express || deps.fastify || deps.koa) framework = "node.js";
      packageManager = "npm";
    }

    // Detect Python
    try {
      await sandbox.readFile(session, "/workspace/repo/requirements.txt");
      language = "python";
      packageManager = "pip";
    } catch { /* not python */ }

    try {
      await sandbox.readFile(session, "/workspace/repo/pyproject.toml");
      language = "python";
      packageManager = "uv";
    } catch { /* not python with pyproject */ }

    // List source directories
    const rootFiles = await sandbox.listDirectory(session, "/workspace/repo");
    const sourceDirectories = rootFiles.filter((f) =>
      ["src", "lib", "app", "pages", "components", "server", "client", "api"].includes(f)
    );

    // Detect test scripts
    const scripts = (packageJson?.scripts as Record<string, string>) ?? {};
    const testScripts = Object.entries(scripts)
      .filter(([k]) => k.includes("test") || k.includes("spec"))
      .map(([k, v]) => `${k}: ${v}`);
    const devScripts = Object.entries(scripts)
      .filter(([k]) => k.includes("dev") || k.includes("start"))
      .map(([k, v]) => `${k}: ${v}`);
    const startScripts = Object.entries(scripts)
      .filter(([k]) => k === "start" || k === "serve")
      .map(([k, v]) => `${k}: ${v}`);

    // Config files
    const configFiles = rootFiles.filter((f) =>
      f.endsWith(".config.") || f.startsWith(".") || f.includes("config")
    ).slice(0, 20);

    return {
      readme,
      packageManager,
      language,
      framework,
      testScripts,
      devScripts,
      startScripts,
      sourceDirectories,
      configFiles,
      packageJson,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${investigation.id}] Repository recon failed: ${errorMsg}`);
    emit("error", investigation.id, { phase: "recon", source: "sandbox", error: errorMsg });
    await captureRepositoryEvidence(
      investigation.id, "recon/repository-error",
      JSON.stringify({ error: errorMsg, source: "sandbox", stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined }, null, 2),
      { type: "repository_recon_error", source: "sandbox" }
    );
    return {
      readme: null, packageManager: null, language: null, framework: null,
      testScripts: [], devScripts: [], startScripts: [], sourceDirectories: [],
      configFiles: [], packageJson: null,
      error: errorMsg, errorSource: "sandbox",
    };
  } finally {
    if (session) {
      await sandbox.destroySandbox(session);
    }
  }
}

async function performApplicationRecon(investigation: Investigation): Promise<ApplicationRecon> {
  const session = await browser.createBrowserSession(investigation.id, { recording: true });

  try {
    const nav = await browser.navigate(session, investigation.applicationUrl);

    // Take screenshot
    const screenshotBuffer = await browser.screenshot(session);
    const screenshotBase64 = screenshotBuffer.toString("base64");

    // Extract visible elements
    let navigation: string[] = [];
    let forms: string[] = [];
    let buttons: string[] = [];
    let links: string[] = [];

    try {
      navigation = await browser.evaluate(session, `
        Array.from(document.querySelectorAll('nav a, [role="navigation"] a'))
          .map(a => a.textContent?.trim()).filter(Boolean)
      `) as string[];
    } catch { /* no nav */ }

    try {
      forms = await browser.evaluate(session, `
        Array.from(document.querySelectorAll('form'))
          .map(f => f.action || f.id || 'form')
      `) as string[];
    } catch { /* no forms */ }

    try {
      buttons = await browser.evaluate(session, `
        Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .map(b => b.textContent?.trim() || b.getAttribute('aria-label') || 'button')
          .filter(Boolean).slice(0, 20)
      `) as string[];
    } catch { /* no buttons */ }

    try {
      links = await browser.evaluate(session, `
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.textContent?.trim())
          .filter(Boolean).slice(0, 20)
      `) as string[];
    } catch { /* no links */ }

    // Extract structured interactable elements with CSS selectors
    let interactableElements: ApplicationRecon["interactableElements"] = [];
    try {
      interactableElements = await browser.evaluate(session, `
        (() => {
          const results = [];

          // Helper: build a unique CSS selector for an element
          function getSelector(el) {
            if (el.id) return '#' + CSS.escape(el.id);
            const tag = el.tagName.toLowerCase();

            // Try href-based selector for links (most specific for links)
            if (tag === 'a' && el.getAttribute('href')) {
              const href = el.getAttribute('href');
              if (href && (href.startsWith('#') || href.startsWith('/'))) {
                return 'a[href="' + CSS.escape(href) + '"]';
              }
              if (href && !href.startsWith('javascript:')) {
                return 'a[href="' + CSS.escape(href) + '"]';
              }
            }

            // Try name attribute for form inputs (unique per form)
            if (['input','select','textarea'].includes(tag) && el.name) {
              // Check if name is unique in the document
              const nameCount = document.querySelectorAll(tag + '[name="' + CSS.escape(el.name) + '"]').length;
              if (nameCount === 1) return tag + '[name="' + CSS.escape(el.name) + '"]';
              // Not unique — prefix with parent form id or class
              const form = el.closest('form');
              if (form && form.id) return '#' + CSS.escape(form.id) + ' ' + tag + '[name="' + CSS.escape(el.name) + '"]';
              return tag + '[name="' + CSS.escape(el.name) + '"]';
            }

            // Try type for submit buttons
            if (tag === 'input' && el.type) {
              return 'input[type="' + CSS.escape(el.type) + '"]';
            }

            // Try data-testid or data-cy (test IDs are designed to be unique)
            if (el.getAttribute('data-testid')) return '[data-testid="' + CSS.escape(el.getAttribute('data-testid')) + '"]';
            if (el.getAttribute('data-cy')) return '[data-cy="' + CSS.escape(el.getAttribute('data-cy')) + '"]';

            // Try aria-label (often unique)
            if (el.getAttribute('aria-label')) {
              const label = el.getAttribute('aria-label');
              const labelCount = document.querySelectorAll('[aria-label="' + CSS.escape(label) + '"]').length;
              if (labelCount === 1) return '[aria-label="' + CSS.escape(label) + '"]';
            }

            // Try role + accessible name (Playwright-compatible)
            const role = el.getAttribute('role');
            if (role) {
              const accessibleName = el.textContent?.trim().slice(0, 50) || '';
              if (accessibleName) return '[role="' + role + '"][aria-label="' + CSS.escape(accessibleName) + '"]';
            }

            // Build a path from the element up to a unique ancestor
            let current = el;
            let path = tag;
            while (current.parentElement && current.parentElement !== document.body) {
              const parent = current.parentElement;
              const parentTag = parent.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
              const idx = siblings.indexOf(current);

              if (parent.id) {
                return '#' + CSS.escape(parent.id) + ' > ' + path;
              }

              if (siblings.length === 1) {
                path = parentTag + ' > ' + path;
              } else {
                path = parentTag + ' > ' + path + ':nth-of-type(' + (idx + 1) + ')';
              }

              current = parent;

              // Stop if path is already specific enough
              if (path.split(' > ').length >= 3) break;
            }

            return path;
          }

          function getInfo(el) {
            const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
            const classes = Array.from(el.classList || []).slice(0, 3);
            const info = {
              selector: getSelector(el),
              text,
              tag: el.tagName.toLowerCase(),
            };
            if (el.href) info.href = el.getAttribute('href');
            if (el.name) info.name = el.name;
            if (el.type) info.type = el.type;
            if (el.placeholder) info.placeholder = el.placeholder;
            if (el.id) info.id = el.id;
            if (el.getAttribute('role')) info.role = el.getAttribute('role');
            if (el.getAttribute('aria-label')) info.ariaLabel = el.getAttribute('aria-label');
            if (classes.length > 0) info.classes = classes;
            return info;
          }

          // Navigation links
          document.querySelectorAll('nav a, [role="navigation"] a').forEach(a => {
            results.push(getInfo(a));
          });

          // All visible links with href
          document.querySelectorAll('a[href]').forEach(a => {
            const text = (a.textContent || '').trim();
            if (text && text.length > 0 && text.length < 80) {
              const sel = getSelector(a);
              if (!results.some(r => r.selector === sel)) {
                results.push(getInfo(a));
              }
            }
          });

          // Buttons
          document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(b => {
            results.push(getInfo(b));
          });

          // Form inputs
          document.querySelectorAll('form input, form select, form textarea, input[name], textarea[name]').forEach(inp => {
            results.push(getInfo(inp));
          });

          // Sections with IDs (anchor targets)
          document.querySelectorAll('[id]').forEach(el => {
            if (el.tagName !== 'HTML' && el.tagName !== 'BODY' && el.id) {
              results.push({
                selector: '#' + CSS.escape(el.id),
                text: (el.textContent || '').trim().slice(0, 40),
                tag: el.tagName.toLowerCase(),
                id: el.id,
              });
            }
          });

          return results.slice(0, 50);
        })()
      `) as ApplicationRecon["interactableElements"];
    } catch { /* no interactable elements */ }

    return {
      pageTitle: nav.title,
      initialUrl: nav.url,
      navigation,
      forms,
      buttons,
      links,
      screenshot: screenshotBase64,
      primaryWorkflow: null,
      interactableElements,
    };
  } finally {
    await browser.closeBrowserSession(session);
  }
}

// ── Plan Phase ─────────────────────────────────────────────────────────────

async function runPlan(investigation: Investigation): Promise<Investigation> {
  investigation = advancePhase(investigation, "plan");

  const repoRecon = (investigation as Investigation & { _repoRecon?: RepositoryRecon })._repoRecon ?? null;
  const appRecon = (investigation as Investigation & { _appRecon?: ApplicationRecon })._appRecon ?? null;

  // Expensive AI call: stop at this boundary if cancelled/expired.
  assertNotStopped(investigation.id);
  const planResult = await getAI().plan(investigation.objective, repoRecon, appRecon);

  // Create experiments from the plan — these are primary experiments
  for (const expPlan of planResult.experiments) {
    if (!budget.canConsumePrimary(investigation.id)) {
      console.warn(`Primary experiment budget exhausted, skipping remaining ${planResult.experiments.length - planResult.experiments.indexOf(expPlan)} experiments`);
      break;
    }
    budget.consumePrimary(investigation.id);
    store.createExperiment({
      investigationId: investigation.id,
      objective: expPlan.objective,
      preconditions: expPlan.preconditions,
      plannedActions: expPlan.plannedActions,
    });
  }

  return investigation;
}

// ── Execute Phase ──────────────────────────────────────────────────────────

async function runExperiments(investigation: Investigation): Promise<void> {
  const experiments = store.listExperiments(investigation.id);

  for (const experiment of experiments) {
    assertNotStopped(investigation.id);
    if (isPaused(investigation.id)) return;
    if (experiment.status !== "planned") continue;
    if (!budget.canConsume(investigation.id, "browserActions")) {
      store.updateExperiment(experiment.id, { status: "inconclusive", result: "Budget exhausted" });
      continue;
    }

    await runExperiment(investigation, experiment);
  }
}

async function runExperiment(investigation: Investigation, experiment: Experiment): Promise<void> {
  assertNotStopped(investigation.id);
  if (isPaused(investigation.id)) return;

  emit("experiment_started", investigation.id, { experimentId: experiment.id, objective: experiment.objective });
  store.updateExperiment(experiment.id, { status: "running" });

  // Extract appRecon from investigation for SPA fallback resolution
  const appRecon = (investigation as Investigation & { _appRecon?: ApplicationRecon })._appRecon ?? null;

  let browserSession: ProbeBrowserSession | null = null;

  try {
    // Auto-launch browser session if any browser action is planned
    const needsBrowser = experiment.plannedActions.some(a => a.tool === "browser" && a.action !== "launch");
    if (needsBrowser) {
      browserSession = await browser.createBrowserSession(investigation.id, { recording: true });
    }

    // Apply viewport from the first action that specifies one
    if (browserSession) {
      const vpAction = experiment.plannedActions.find(a => a.viewport);
      if (vpAction?.viewport) {
        await browser.setViewport(browserSession, vpAction.viewport);
      }
    }

    let sequence = 0;

    for (const planned of experiment.plannedActions) {
      // Skip launch actions if session already auto-created
      if (planned.action === "launch" && browserSession) continue;

      // Safe boundary between browser/sandbox actions: cancellation is
      // authoritative, runtime expiry stops the experiment.
      assertNotStopped(investigation.id);
      if (isPaused(investigation.id)) break;

      // Charge the correct resource pool for this action's tool.
      const budgetResource =
        planned.tool === "sandbox" ? "sandboxCommands" : "browserActions";
      if (!budget.canConsume(investigation.id, budgetResource)) {
        throw new Error(`Budget exhausted: ${budgetResource}`);
      }

      sequence++;
      const action = store.createAction({
        experimentId: experiment.id,
        sequence,
        tool: planned.tool,
        action: planned.action,
        target: planned.target,
        input: (planned.input as Record<string, unknown>) ?? {},
        status: "running",
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      emit("action_started", investigation.id, { actionId: action.id, action: planned.action });

      try {
        const result = await executeAction(planned, browserSession, investigation.id, appRecon);

        // If this was a browser launch, track the session
        if (planned.action === "launch" && result.session) {
          browserSession = result.session;
        }

        store.updateAction(action.id, {
          status: "success",
          result: result.data ?? null,
          completedAt: new Date().toISOString(),
        });

        budget.consume(investigation.id, budgetResource);
        emit("action_completed", investigation.id, { actionId: action.id, status: "success" });

        // Generate observation
        const observation = store.createObservation({
          experimentId: experiment.id,
          actionId: action.id,
          expected: (planned.input?.expected as string) ?? null,
          actual: JSON.stringify(result.data ?? result),
          type: "behavior",
          description: `${planned.action} on ${planned.target}`,
        });

        emit("observation_recorded", investigation.id, { observationId: observation.id });

        // Capture evidence
        if (result.screenshot) {
          await captureScreenshot(investigation.id, experiment.id, result.screenshot);
        }
        await captureActionTrace(investigation.id, experiment.id, {
          action: planned.action,
          target: planned.target,
          result: result.data,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        store.updateAction(action.id, {
          status: "non_retryable_failure",
          error: errorMsg,
          completedAt: new Date().toISOString(),
        });
        emit("action_completed", investigation.id, { actionId: action.id, status: "failed", error: errorMsg });
        throw error;
      }
    }

    store.updateExperiment(experiment.id, {
      status: "completed",
      result: "All actions completed successfully",
    });
    emit("experiment_completed", investigation.id, { experimentId: experiment.id, status: "completed" });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    store.updateExperiment(experiment.id, { status: "failed", error: errorMsg });
    emit("experiment_completed", investigation.id, { experimentId: experiment.id, status: "failed", error: errorMsg });
  } finally {
    if (browserSession) {
      // Persist the session replay as evidence. Solari uploads the recording
      // asynchronously after release; getReplay() polls briefly for it. The
      // session must be closed first — replay retrieval does not require the
      // session to still exist, only the session ID.
      const solariSessionId = browserSession.solariSessionId;
      const recordingEnabled = browserSession.recordingEnabled;
      await browser.closeBrowserSession(browserSession);
      browserSession = null;

      if (recordingEnabled) {
        try {
          // Use getReplay()'s documented default poll window (10 × 3s ≈ 30s):
          // Solari uploads the recording asynchronously after release, and a
          // shorter window loses replays on every live run.
          const replay = await browser.getReplay(solariSessionId);
          if (replay && replay.byteLength > 0) {
            await captureReplay(investigation.id, experiment.id, replay, {
              solariSessionId,
            });
          } else if (!replay) {
            console.warn(
              `[${investigation.id}] Replay not available for session ${solariSessionId} (not yet uploaded or recording unavailable)`
            );
          }
        } catch (replayError) {
          // Replay is best-effort evidence; never fail an experiment over it.
          console.error(
            `[${investigation.id}] Replay capture failed:`,
            replayError instanceof Error ? replayError.message : replayError
          );
        }
      }
    }
  }
}

interface ActionResult {
  data?: Record<string, unknown>;
  screenshot?: Buffer;
  session?: ProbeBrowserSession;
}

/**
 * Security: Valid actions per tool. AI-generated actions are checked against
 * these lists before execution. Unknown tools/actions are rejected, not
 * forwarded to any execution backend.
 *
 * VALID_ACTIONS is imported from the central allowlist module — the single
 * source of truth shared with AI output validation and the sandbox adapter.
 */

/**
 * Look up a recon element's context from the appRecon interactableElements.
 * Used to provide SPA fallback resolution data to browser interactions.
 */
function findReconContext(
  target: string,
  appRecon: ApplicationRecon | null | undefined
): ReconContext | undefined {
  if (!appRecon?.interactableElements) return undefined;

  const el = appRecon.interactableElements.find((e) => e.selector === target);
  if (!el) return undefined;

  return {
    selector: el.selector,
    text: el.text,
    href: el.href,
    id: el.id,
    name: el.name,
    ariaLabel: el.ariaLabel,
    testId: undefined, // not in InteractableElement type
    tag: el.tag,
    type: el.type,
    classes: el.classes,
  };
}

async function executeAction(
  planned: { tool: string; action: string; target: string; input?: Record<string, unknown>; viewport?: { width: number; height: number; preset?: string } },
  currentSession: ProbeBrowserSession | null,
  investigationId: string,
  appRecon?: ApplicationRecon | null
): Promise<ActionResult> {
  // ── Security: validate tool and action before dispatching ────────────
  // The AI must not introduce new tools or actions that the orchestrator
  // does not explicitly support. This is the last line of defense.
  const validActions = (VALID_ACTIONS as Record<string, readonly string[]>)[planned.tool];
  if (!validActions) {
    throw new Error(`Security: unknown tool '${planned.tool}' rejected`);
  }
  if (!validActions.includes(planned.action)) {
    throw new Error(`Security: unknown action '${planned.action}' for tool '${planned.tool}' rejected`);
  }

  if (planned.tool === "browser") {
    switch (planned.action) {
      case "launch": {
        const session = await browser.createBrowserSession(investigationId, {
          recording: true,
          stealth: (planned.input?.stealth as boolean) ?? false,
        });
        return { data: { sessionId: session.probeSessionId }, session };
      }
      case "setViewport": {
        if (!currentSession) throw new Error("No active browser session");
        const vp = (planned.viewport ?? (planned.input?.viewport as { width: number; height: number } | undefined)) ?? { width: 1440, height: 900 };
        const applied = await browser.setViewport(currentSession, vp);
        return { data: { viewport: { width: applied.width, height: applied.height, preset: applied.preset } } };
      }
      case "navigate": {
        if (!currentSession) throw new Error("No active browser session");
        const result = await browser.navigate(currentSession, planned.target);
        const screenshot = result.downloaded ? null : await browser.screenshot(currentSession);
        const data: Record<string, unknown> = {
          title: result.title,
          url: result.url,
          ...(result.downloaded ? { downloaded: true, downloadUrl: result.downloadUrl } : {}),
        };
        // If a download was triggered, verify the page identity post-navigation
        if (!result.downloaded && result.title) {
          try {
            const verification = await browser.verifyPage(currentSession, {
              urlContains: new URL(result.url).pathname,
              titleContains: result.title,
            });
            data.pageVerified = verification.matched;
            data.verificationDetails = verification.details;
          } catch {
            // Page verification is best-effort
          }
        }
        return { data, screenshot: screenshot ?? undefined };
      }
      case "click": {
        if (!currentSession) throw new Error("No active browser session");
        const clickRecon = findReconContext(planned.target, appRecon);
        await browser.click(currentSession, planned.target, clickRecon);
        const screenshot = await browser.screenshot(currentSession);
        return { data: { clicked: planned.target, resolvedWith: clickRecon ? "recon-fallback" : "direct-selector" }, screenshot };
      }
      case "type": {
        if (!currentSession) throw new Error("No active browser session");
        const text = (planned.input?.text as string) ?? "";
        const typeRecon = findReconContext(planned.target, appRecon);
        await browser.type(currentSession, planned.target, text, typeRecon);
        return { data: { typed: text, into: planned.target } };
      }
      case "readText": {
        if (!currentSession) throw new Error("No active browser session");
        const readRecon = findReconContext(planned.target, appRecon);
        const text = await browser.readText(currentSession, planned.target, readRecon);
        return { data: { text } };
      }
      case "screenshot": {
        if (!currentSession) throw new Error("No active browser session");
        const screenshot = await browser.screenshot(currentSession);
        return { data: { size: screenshot.length }, screenshot };
      }
      case "getTitle": {
        if (!currentSession) throw new Error("No active browser session");
        const title = await browser.getTitle(currentSession);
        return { data: { title } };
      }
      default:
        throw new Error(`Unknown browser action: ${planned.action}`);
    }
  }

  if (planned.tool === "sandbox") {
    switch (planned.action) {
      case "readFile": {
        const session = await sandbox.createSandboxSession(investigationId);
        try {
          const content = await sandbox.readFile(session, planned.target);
          return { data: { path: planned.target, content } };
        } finally {
          await sandbox.destroySandbox(session);
        }
      }
      case "listDirectory": {
        const session = await sandbox.createSandboxSession(investigationId);
        try {
          const entries = await sandbox.listDirectory(session, planned.target);
          return { data: { path: planned.target, entries } };
        } finally {
          await sandbox.destroySandbox(session);
        }
      }
      case "runReadOnlyCommand": {
        // ── Security: sandbox commands execute in the Solari sandbox VM ──
        // They NEVER execute on the Probe host. The command binary must be
        // on the read-only allowlist; args are discrete argv entries, so
        // shell syntax and pipelines are impossible.
        const session = await sandbox.createSandboxSession(investigationId);
        try {
          const cmd = planned.target;
          const args = (planned.input?.args as string[]) ?? [];
          const result = await sandbox.runReadOnlyCommand(session, cmd, args);
          return { data: result as unknown as Record<string, unknown> };
        } finally {
          await sandbox.destroySandbox(session);
        }
      }
      default:
        throw new Error(`Unknown sandbox action: ${planned.action}`);
    }
  }

  throw new Error(`Unknown tool: ${planned.tool}`);
}

// ── Analyze Phase ──────────────────────────────────────────────────────────

async function runAnalysis(investigation: Investigation): Promise<{ investigation: Investigation; analysis: string }> {
  // Idempotent: if already in analyze phase (e.g. from adaptive loop re-analysis),
  // do not attempt to transition again.
  if (investigation.currentPhase !== "analyze") {
    investigation = advancePhase(investigation, "analyze");
  }

  const experiments = store.listExperiments(investigation.id);
  const allObservations: Observation[] = [];
  for (const exp of experiments) {
    allObservations.push(...store.listObservations(exp.id));
  }

  assertNotStopped(investigation.id);
  const analysis = await getAI().analyzeObservation(
    allObservations,
    experiments[experiments.length - 1] ?? ({} as Experiment),
    investigation.objective
  );

  // NOTE: per-request AI accounting is done inside the AI adapter (each
  // upstream model request, including retries, is counted). The legacy
  // per-helper consumption was removed to avoid double charging.
  return { investigation, analysis };
}

// ── Hypothesis Phase ───────────────────────────────────────────────────────

async function runHypothesis(investigation: Investigation, analysis: string): Promise<Investigation> {
  // Idempotent: if already in hypothesis phase, skip transition
  if (investigation.currentPhase !== "hypothesis") {
    investigation = advancePhase(investigation, "hypothesis");
  }

  const evidence = store.listEvidence(investigation.id);
  assertNotStopped(investigation.id);
  const result = await getAI().generateHypothesis(analysis, evidence, investigation.objective);

  store.createHypothesis({
    investigationId: investigation.id,
    statement: result.statement,
    status: "investigating",
    confidence: result.confidence,
    supportingEvidenceIds: result.supportingEvidenceIds,
    contradictingEvidenceIds: result.contradictingEvidenceIds,
  });

  emit("hypothesis_proposed", investigation.id, {
    statement: result.statement,
    confidence: result.confidence,
  });

  return investigation;
}

// ── Verification Phase ─────────────────────────────────────────────────────

async function runVerification(
  investigation: Investigation,
  verificationByHypothesis: Map<string, string> = new Map()
): Promise<Investigation> {
  // Idempotent: if already in verification phase, skip transition
  if (investigation.currentPhase !== "verification") {
    investigation = advancePhase(investigation, "verification");
  }

  const hypotheses = store.listHypotheses(investigation.id);

  for (const hypothesis of hypotheses) {
    if (hypothesis.status !== "investigating") continue;

    const evidence = store.listEvidence(investigation.id);
    assertNotStopped(investigation.id);
    const verification = await getAI().designVerification(hypothesis, evidence);

    if (verification.shouldVerify && verification.verificationExperiment) {
      // Validate verification experiment actions — the shared selector
      // validator rejects unambiguous natural-language targets while accepting
      // real CSS (including element selectors like button[type=submit]).
      const verificationActions = verification.verificationExperiment.plannedActions;
      const invalidActions = verificationActions.filter(
        (a) => a.tool === "browser" && !looksLikeCssSelector(a.target, a.action)
      );
      if (invalidActions.length > 0) {
        console.warn(`Verification experiment has ${invalidActions.length} invalid actions, marking hypothesis inconclusive`);
        store.updateHypothesis(hypothesis.id, { status: "inconclusive" });
        continue;
      }

      // Check verification reserve capacity
      if (!budget.canConsumeVerification(investigation.id)) {
        console.warn(`Verification budget exhausted, marking hypothesis inconclusive`);
        store.updateHypothesis(hypothesis.id, { status: "inconclusive" });
        continue;
      }

      // Consume verification experiment slot
      budget.consumeVerification(investigation.id);

      // Create and run a verification experiment
      const exp = store.createExperiment({
        investigationId: investigation.id,
        objective: `Verify: ${hypothesis.statement}`,
        hypothesisId: hypothesis.id,
        preconditions: ["hypothesis exists"],
        plannedActions: verificationActions,
      });

      await runExperiment(investigation, exp);

      // Evaluate new evidence
      const newEvidence = store.listEvidence(investigation.id).filter(
        (e) => e.experimentId === exp.id
      );

      const evaluation = await getAI().evaluateEvidence(hypothesis, newEvidence);

      store.updateHypothesis(hypothesis.id, {
        confidence: evaluation.confidence,
        status: evaluation.status,
      });

      // Record which verification experiment tested this hypothesis, so the
      // report phase can tie findings to independent verification evidence.
      verificationByHypothesis.set(hypothesis.id, exp.id);

      emit("hypothesis_updated", investigation.id, {
        hypothesisId: hypothesis.id,
        status: evaluation.status,
        confidence: evaluation.confidence,
      });
    } else {
      // Cannot verify further, mark as inconclusive
      store.updateHypothesis(hypothesis.id, { status: "inconclusive" });
    }
  }

  return investigation;
}

// ── Report Phase ───────────────────────────────────────────────────────────

/**
 * Match a report-created finding back to the hypothesis it stems from.
 * The AI does not return hypothesis IDs, so the match is textual: the finding
 * title/description against the hypothesis statement. Returns null when no
 * hypothesis plausibly produced this finding — the finding then resolves
 * evidence without hypothesis/verification linkage rather than guessing.
 */
function hypothesisForFinding(
  findingData: { title?: string; description?: string; rootCause?: string | null },
  hypotheses: Hypothesis[]
): Hypothesis | null {
  const text = `${findingData.title ?? ""} ${findingData.description ?? ""}`.toLowerCase();
  if (!text) return null;

  let best: { hypothesis: Hypothesis; score: number } | null = null;
  for (const h of hypotheses) {
    const words = h.statement.toLowerCase().split(/\s+/).filter((w) => w.length > 5);
    if (words.length === 0) continue;
    const hits = words.filter((w) => text.includes(w)).length;
    const score = hits / words.length;
    if (score >= 0.3 && (!best || score > best.score)) {
      best = { hypothesis: h, score };
    }
  }
  return best?.hypothesis ?? null;
}

async function runReport(
  investigation: Investigation,
  verificationByHypothesis: Map<string, string> = new Map()
): Promise<void> {
  investigation = advancePhase(investigation, "report");

  const findings = store.listFindings(investigation.id);
  const hypotheses = store.listHypotheses(investigation.id);
  const experiments = store.listExperiments(investigation.id);
  const evidence = store.listEvidence(investigation.id);

  let reportResult;
  try {
    assertNotStopped(investigation.id);
    reportResult = await getAI().generateReport(
      investigation,
      findings,
      hypotheses,
      experiments,
      evidence
    );
  } catch (reportError) {
    // Cancellation/expiry must propagate — a stopped investigation must not
    // receive a fallback report.
    if (reportError instanceof InvestigationStoppedError) throw reportError;
    // AI report generation failed — create a fallback report so the investigation still completes
    console.error(`AI report generation failed, creating fallback report:`, reportError);
    const confirmedHypotheses = hypotheses.filter(h => h.status === "confirmed");
    const rejectedHypotheses = hypotheses.filter(h => h.status === "rejected");
    const inconclusiveHypotheses = hypotheses.filter(h => h.status === "inconclusive");
    const completedExperiments = experiments.filter(e => e.status === "completed");
    const failedExperiments = experiments.filter(e => e.status === "failed");

    reportResult = {
      summary: `Investigation completed with ${experiments.length} experiments (${completedExperiments.length} completed, ${failedExperiments.length} failed), ${evidence.length} evidence items, and ${hypotheses.length} hypotheses (${confirmedHypotheses.length} confirmed, ${rejectedHypotheses.length} rejected, ${inconclusiveHypotheses.length} inconclusive). AI report generation encountered an error, so this is a structured fallback summary.`,
      confirmedFindings: findings.map(f => ({
        title: f.title,
        description: f.description,
        severity: f.severity,
        confidence: f.confidence,
        status: f.status,
        rootCause: f.rootCause,
        recommendation: f.recommendation,
        reproductionSteps: f.reproductionSteps,
      })),
    };
  }

  // Create confirmed findings from report
  for (const findingData of reportResult.confirmedFindings) {
    const finding = store.createFinding({
      ...findingData,
      investigationId: investigation.id,
      evidenceIds: resolveFindingEvidenceIds(findingData, {
        investigationId: investigation.id,
        hypothesis: hypothesisForFinding(findingData, hypotheses),
        verificationExperimentId: hypothesisForFinding(findingData, hypotheses)
          ? verificationByHypothesis.get(hypothesisForFinding(findingData, hypotheses)!.id)
          : undefined,
        experiments,
        evidence,
      }),
    });

    emit("finding_created", investigation.id, { findingId: finding.id, title: finding.title });
  }

  // Re-read findings so the report contains exactly what was persisted.
  const persistedFindings = store.listFindings(investigation.id);

  store.createReport({
    investigationId: investigation.id,
    summary: reportResult.summary,
    confirmedFindings: persistedFindings,
    rejectedHypotheses: hypotheses
      .filter((h) => h.status === "rejected")
      .map((h) => h.statement),
    inconclusiveHypotheses: hypotheses
      .filter((h) => h.status === "inconclusive")
      .map((h) => h.statement),
    totalExperiments: experiments.length,
    totalEvidence: evidence.length,
  });
}

// ── Main Run Loop ──────────────────────────────────────────────────────────

export async function runInvestigation(investigationId: string): Promise<void> {
  let investigation = store.getInvestigation(investigationId);
  if (!investigation) throw new Error(`Investigation ${investigationId} not found`);

  const startTime = Date.now();
  budget.initBudget(investigationId);

  // Every actual upstream model request (including retries) is charged
  // against this investigation's AI budget by the adapter.
  setAiRequestRecorder((count = 1) => {
    for (let i = 0; i < count; i++) {
      budget.consume(investigationId, "aiCalls");
    }
  });

  transitionStatus(investigation.status, "running");
  store.updateInvestigation(investigationId, { status: "running" });

  // Runtime-expiry accounting: record elapsed time continuously so
  // budget.isExpired() reflects real execution time.
  const runtimeTimer = setInterval(() => {
    budget.recordRuntime(investigationId, 1000);
  }, 1000);
  runtimeTimer.unref?.();

  try {
    // Resume from current phase — do not restart completed phases.
    const phase = investigation.currentPhase;

    if (phase === "created" || phase === "recon") {
      investigation = await runRecon(investigation);
      investigation = await runPlan(investigation);
      investigation = advancePhase(investigation, "experiment");
      await runExperiments(investigation);
      // Advance through execute → observe after experiments are done
      investigation = store.getInvestigation(investigationId)!;
      if (investigation.currentPhase === "experiment") {
        investigation = advancePhase(investigation, "execute");
      }
      if (investigation.currentPhase === "execute") {
        investigation = advancePhase(investigation, "observe");
      }
    } else if (phase === "plan") {
      investigation = await runPlan(investigation);
      investigation = advancePhase(investigation, "experiment");
      await runExperiments(investigation);
      // Advance through execute → observe after experiments are done
      investigation = store.getInvestigation(investigationId)!;
      if (investigation.currentPhase === "experiment") {
        investigation = advancePhase(investigation, "execute");
      }
      if (investigation.currentPhase === "execute") {
        investigation = advancePhase(investigation, "observe");
      }
    } else if (phase === "experiment" || phase === "execute") {
      investigation = advancePhase(investigation, "execute");
      await runExperiments(investigation);
      // Advance to observe after experiments are done
      investigation = store.getInvestigation(investigationId)!;
      if (investigation.currentPhase === "execute") {
        investigation = advancePhase(investigation, "observe");
      }
    }

    // From here on, re-read investigation to get current phase
    investigation = store.getInvestigation(investigationId)!;

    // ── Adaptive Planning Loop ────────────────────────────────────────────
    // After initial experiments, analyze and decide whether to continue
    // with evidence-driven follow-up experiments.
    const MAX_ADAPTIVE_ROUNDS = 3; // safety limit to prevent infinite loops
    let adaptiveRound = 0;

    try {
      if (investigation.currentPhase === "execute" || investigation.currentPhase === "observe") {
        // Run initial analysis
        let analysisResult = await runAnalysis(investigation);
        investigation = analysisResult.investigation;

        // Adaptive loop: decide whether more investigation is warranted.
        // Runtime expiry and cancellation stop the loop — retries and
        // adaptive rounds cannot bypass the runtime limit.
        while (adaptiveRound < MAX_ADAPTIVE_ROUNDS) {
          assertNotStopped(investigationId);
          if (isPaused(investigationId)) break;
          const appRecon = (investigation as Investigation & { _appRecon?: ApplicationRecon })._appRecon ?? null;
          const allExperiments = store.listExperiments(investigation.id);
          const allEvidence = store.listEvidence(investigation.id);
          const primaryBudget = budget.getPrimaryExperimentBudget(investigation.id);
          const b = budget.getBudget(investigation.id);
          const remainingActions = b.maxBrowserActions - b.usedBrowserActions;

          // Don't continue if budget is exhausted
          if (primaryBudget <= 0 || remainingActions <= 0) {
            break;
          }

          assertNotStopped(investigationId);
          const decision = await getAI().decideNextStep(
            investigation.objective,
            allExperiments,
            allEvidence,
            analysisResult.analysis,
            primaryBudget,
            remainingActions,
            appRecon
          );

          if (!decision.shouldContinue || !decision.nextExperiment) {
            console.log(`[${investigationId}] Adaptive loop: stopping — ${decision.reason}`);
            break;
          }

          // Validate selectors before creating the experiment
          const nextActions = decision.nextExperiment.plannedActions;
          const invalidAdaptive = nextActions.filter(
            (a) => a.tool === "browser" && !(["navigate", "screenshot", "getTitle", "launch", "setViewport"].includes(a.action)) &&
            !/^[#.\[:a-zA-Z]/.test(a.target)
          );
          if (invalidAdaptive.length > 0) {
            console.warn(`[${investigationId}] Adaptive experiment has invalid actions, stopping adaptive loop`);
            break;
          }

          console.log(`[${investigationId}] Adaptive round ${adaptiveRound + 1}: creating experiment — ${decision.nextExperiment.objective}`);

          // Consume primary budget and create experiment
          if (!budget.canConsumePrimary(investigation.id)) {
            break;
          }
          budget.consumePrimary(investigation.id);

          const adaptiveExp = store.createExperiment({
            investigationId: investigation.id,
            objective: decision.nextExperiment.objective,
            preconditions: decision.nextExperiment.preconditions,
            plannedActions: nextActions,
          });

          // Execute the adaptive experiment
          await runExperiment(investigation, adaptiveExp);

          // Re-analyze with updated evidence
          analysisResult = await runAnalysis(investigation);
          investigation = analysisResult.investigation;

          adaptiveRound++;
        }

        // Proceed to hypothesis
        investigation = await runHypothesis(investigation, analysisResult.analysis);
      } else if (investigation.currentPhase === "hypothesis") {
        // Resuming at hypothesis — re-read analysis from evidence
        const result = await runAnalysis(investigation);
        investigation = result.investigation;
        investigation = await runHypothesis(investigation, result.analysis);
      }
    } catch (analysisError) {
      // Cancellation/expiry must propagate to the run-loop finalizer.
      if (analysisError instanceof InvestigationStoppedError) throw analysisError;
      console.error(`Analysis/hypothesis phase failed:`, analysisError);
      // Continue to report phase — the investigation still has useful data
    }

    investigation = store.getInvestigation(investigationId)!;

    // hypothesisId → verification experiment ID that tested it; threaded
    // into the report phase so findings link to independent verification
    // evidence rather than AI assertion.
    const verificationByHypothesis = new Map<string, string>();

    try {
      if (investigation.currentPhase === "hypothesis" || investigation.currentPhase === "verification") {
        investigation = await runVerification(investigation, verificationByHypothesis);
      }
    } catch (verificationError) {
      // Cancellation/expiry must propagate to the run-loop finalizer.
      if (verificationError instanceof InvestigationStoppedError) throw verificationError;
      console.error(`Verification phase failed:`, verificationError);
      // Continue to report phase
    }

    investigation = store.getInvestigation(investigationId)!;

    // Advance through intermediate phase states required by the state machine
    investigation = store.getInvestigation(investigationId)!;
    if (investigation.currentPhase === "verification") {
      // Determine outcome based on hypothesis statuses
      const hypotheses = store.listHypotheses(investigation.id);
      const hasConfirmed = hypotheses.some(h => h.status === "confirmed");
      const hasRejected = hypotheses.some(h => h.status === "rejected");
      if (hasConfirmed && !hasRejected) {
        investigation = advancePhase(investigation, "confirmed");
      } else if (hasRejected && !hasConfirmed) {
        investigation = advancePhase(investigation, "rejected");
      } else {
        investigation = advancePhase(investigation, "inconclusive");
      }
    }
    if (investigation.currentPhase !== "report" && investigation.currentPhase !== "complete") {
      await runReport(investigation, verificationByHypothesis);
    }

    // Done
    investigation = store.getInvestigation(investigationId)!;
    if (investigation.currentPhase !== "complete") {
      advancePhase(investigation, "complete");
    }
    // Terminal status via the state machine — never overwrites cancelled
    // or failed (transitionStatus throws on invalid transitions).
    const finished = store.getInvestigation(investigationId)!;
    transitionStatus(finished.status, "completed");
    store.updateInvestigation(investigationId, { status: "completed" });
    emit("complete", investigationId, { message: "Investigation complete" });
  } catch (error) {
    if (error instanceof InvestigationStoppedError) {
      if (error.reason === "cancelled") {
        // The API layer already transitioned the status; re-read so the
        // runner never overwrites a terminal cancelled status.
        const inv = store.getInvestigation(investigationId);
        console.log(`[${investigationId}] Investigation cancelled at a safe boundary`);
        if (inv && inv.status !== "cancelled") {
          transitionStatus(inv.status, "cancelled");
          store.updateInvestigation(investigationId, { status: "cancelled" });
        }
        emit("error", investigationId, { error: "Investigation cancelled" });
      } else {
        // Runtime budget exhausted: mark failed (not completed) through the
        // state machine. running → failed is a valid transition.
        const inv = store.getInvestigation(investigationId);
        console.warn(`[${investigationId}] Runtime budget expired — stopping investigation`);
        if (inv && (inv.status === "running" || inv.status === "paused")) {
          transitionStatus(inv.status, "failed");
          store.updateInvestigation(investigationId, { status: "failed" });
        }
        emit("error", investigationId, { error: "Runtime budget expired" });
      }
    } else {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Investigation ${investigationId} failed:`, errorMsg);
      const inv = store.getInvestigation(investigationId);
      // Never overwrite a terminal status (e.g. a concurrent cancel).
      if (inv && (inv.status === "running" || inv.status === "paused")) {
        transitionStatus(inv.status, "failed");
        store.updateInvestigation(investigationId, { status: "failed" });
      }
      emit("error", investigationId, { error: errorMsg });
    }
  } finally {
    clearInterval(runtimeTimer);
    budget.recordRuntime(investigationId, Date.now() - startTime);

    // Cleanup any active Solari sessions
    const activeSessions = store.getActiveSessions(investigationId);
    for (const session of activeSessions) {
      try {
        if (session.type === "browser") {
          // Browser sessions are cleaned up per-experiment
        } else if (session.type === "sandbox") {
          // Sandbox sessions are cleaned up per-recon
        }
      } catch (e) {
        console.error(`Error cleaning up session ${session.id}:`, e);
      }
    }

    // Unbind the AI request recorder so a finished investigation's budget
    // is never charged by later adapter usage.
    setAiRequestRecorder(null);
  }
}
