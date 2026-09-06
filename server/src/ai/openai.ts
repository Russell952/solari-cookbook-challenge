/**
 * OpenAI implementation of the AI adapter.
 *
 * Uses the OpenAI-compatible chat completions API.
 * The model and base URL are configurable via environment.
 *
 * AI output validation: every parseJSON result is validated at runtime.
 * AI output is NEVER trusted simply because it is valid JSON.
 */
import { config } from "../config/index.js";
import type {
  AIAdapter,
  AIPlanResult,
  AIHypothesisResult,
  AIVerificationResult,
  AIReportResult,
  AdaptiveDecision,
} from "./adapter.js";
import type {
  Investigation,
  RepositoryRecon,
  ApplicationRecon,
  Experiment,
  Observation,
  Hypothesis,
  Finding,
  Evidence,
} from "@probe/shared";

// ── JSON parsing ───────────────────────────────────────────────────────────

function parseJSON<T>(text: string): T {
  // Extract JSON from possible markdown code blocks
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const raw = match ? match[1] : text;
  return JSON.parse(raw.trim()) as T;
}

// ── Validation helpers ─────────────────────────────────────────────────────

// Single source of truth for AI-reachable tools/actions.
import { VALID_TOOLS, isAllowedToolAction } from "../orchestrator/action-allowlist.js";

function requireString(val: unknown, field: string): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`AI response: missing or invalid '${field}'`);
  }
  return val;
}

function requireNumber(val: unknown, field: string, min = 0, max = 1): number {
  if (typeof val !== "number" || val < min || val > max) {
    throw new Error(`AI response: '${field}' must be a number between ${min} and ${max}`);
  }
  return val;
}

function requireArray(val: unknown, field: string): unknown[] {
  if (!Array.isArray(val)) {
    throw new Error(`AI response: missing or invalid '${field}' array`);
  }
  return val;
}

/** Like requireArray but returns [] when the field is omitted (Gemini sometimes drops empty arrays). */
function optionalArray(val: unknown, field: string): unknown[] {
  if (val === undefined || val === null) return [];
  return requireArray(val, field);
}

/**
 * Patterns that indicate the AI fabricated a selector from natural language
 * instead of using one from recon data.
 */
const FABRICATED_SELECTOR_PATTERNS = [
  // Parentheses without attribute syntax — e.g. "button (submit)", "link (external)"
  /\s*\([^)]*\)\s*$/,
  // Natural language prefixes the AI adds to describe intent
  /^(link|button|nav\s*link|form\s*field|input|anchor|cta|section|page|text|button\/link|form\s*element|submit\s*button):\s*/i,
  // Compound word descriptions
  /\b(hero|header|footer|sidebar|modal|dropdown|overlay|banner|card|tile|widget)\s+(section\s+)?/i,
  // "first/second/third Nth" natural language ordinal descriptions
  /^(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+/i,
  // Descriptive phrases like "portfolio project link" or "social icon"
  /\b(project\s+link|social\s+icon|footer\s+link|navigation\s+link|cta\s+button|hero\s+section|about\s+section)/i,
  // "the X" article patterns
  /^(the|a|an)\s+\w+\s+(link|button|icon|element|field|section|area)/i,
];

/**
 * Patterns for clearly invalid CSS selectors that would cause Playwright errors.
 */
const INVALID_CSS_PATTERNS = [
  // Unbalanced parentheses
  /\((?![^)]*\[)[^)]*$/,
  // Double selectors separated by space (not > or + or ~)
  // e.g. "section.hero a.btn" — this is a descendant selector which is valid CSS,
  // but the AI typically invents these from guessed class names.
  // We don't reject all descendant selectors, just flag them for provenance check.
];

/**
 * Validate that a browser target is not an obviously fabricated selector.
 * Returns null if valid, or an error message if rejected.
 */
function validateSelectorQuality(target: string, action: string, index: number): string | null {
  // URLs are always valid targets for navigate actions
  if (/^https?:\/\//.test(target)) return null;

  // Non-browser actions don't need selector quality checks
  if (action === "screenshot" || action === "getTitle" || action === "launch") return null;

  // Check for fabricated natural-language patterns
  for (const pattern of FABRICATED_SELECTOR_PATTERNS) {
    if (pattern.test(target)) {
      return `plannedAction[${index}].target is a fabricated selector: "${target}". Use a selector from interactableElements instead.`;
    }
  }

  // Check for invalid CSS syntax (unbalanced parens, etc.)
  for (const pattern of INVALID_CSS_PATTERNS) {
    if (pattern.test(target)) {
      return `plannedAction[${index}].target has invalid CSS syntax: "${target}"`;
    }
  }

  // Check for CSS syntax validity — must start with valid CSS token
  const looksLikeValidCss = /^[#.[*:a-zA-Z]/.test(target);
  if (!looksLikeValidCss && target !== "page" && target !== "full page") {
    return `plannedAction[${index}].target does not look like a valid CSS selector: "${target}"`;
  }

  return null; // valid
}

/**
 * Validate that browser targets are traceable to recon data.
 * 
 * Rules:
 * 1. If interactableElements are provided, browser targets MUST match one
 *    of their selectors exactly, OR be a well-formed CSS selector that
 *    could plausibly target an element on the page.
 * 2. Fabricated natural-language selectors are always rejected.
 * 3. Navigate targets are always URLs — no provenance check needed.
 */
function validatePlanSelectors(
  plan: AIPlanResult,
  interactableElements?: Array<{ selector: string; text: string; tag: string; href?: string; id?: string; name?: string; type?: string }>
): void {
  if (!interactableElements || interactableElements.length === 0) return;

  // Build a set of known-good selectors from recon
  const knownSelectors = new Set(interactableElements.map(e => e.selector));
  // Also build a set of known-good text values for fallback
  const knownTexts = new Set(interactableElements.map(e => e.text.toLowerCase().trim()).filter(Boolean));
  // Known hrefs
  const knownHrefs = new Set(
    interactableElements
      .map(e => e.href)
      .filter((h): h is string => !!h)
  );

  for (const [expIdx, experiment] of plan.experiments.entries()) {
    for (const [actIdx, action] of experiment.plannedActions.entries()) {
      const idx = expIdx * 100 + actIdx;
      
      // Skip non-browser actions
      if (action.tool !== "browser") continue;
      // Skip navigate (URLs), screenshot, getTitle, launch, setViewport (viewport control, not element interaction)
      if (["navigate", "screenshot", "getTitle", "launch", "setViewport"].includes(action.action)) continue;

      const target = action.target;

      // First: reject obviously fabricated selectors
      const qualityError = validateSelectorQuality(target, action.action, idx);
      if (qualityError) throw new Error(qualityError);

      // Second: check if the target is an exact match from recon
      if (knownSelectors.has(target)) continue;

      // Third: check if it's a CSS selector that targets a known href
      const hrefMatch = target.match(/a\[href=["']([^"']+)["']\]/);
      if (hrefMatch && knownHrefs.has(hrefMatch[1])) continue;

      // Fourth: check if it's a simple #id selector that matches a known element
      if (target.startsWith("#")) {
        const idFromTarget = target.slice(1);
        if (interactableElements.some(e => e.id === idFromTarget || e.selector === target)) continue;
      }

      // Fifth: for input[type=...], check if there's a matching form element
      const inputTypeMatch = target.match(/^input\[type=["']([^"']+)["']\]$/);
      if (inputTypeMatch) {
        if (interactableElements.some(e => e.tag === "input" && e.type === inputTypeMatch[1])) continue;
      }

      // Sixth: for input[name=...], check if there's a matching form element
      const inputNameMatch = target.match(/^(?:#\S+\s+)?input\[name=["']([^"']+)["']\]$/);
      if (inputNameMatch) {
        if (interactableElements.some(e => e.name === inputNameMatch[1])) continue;
      }

      // Target does not match any recon data and was not caught by quality checks.
      // This is an error — the planner must use selectors from recon data.
      throw new Error(
        `Plan selector error: target "${target}" at experiment[${expIdx}].action[${actIdx}] ` +
        `cannot be traced to any interactableElement from recon data. ` +
        `Use one of the provided selectors: ${interactableElements.slice(0, 5).map(e => e.selector).join(", ")}`
      );
    }
  }
}

function validatePlannedActions(actions: unknown): AIPlanResult["experiments"][0]["plannedActions"] {
  return requireArray(actions, "plannedActions").map((a, i) => {
    if (typeof a !== "object" || a === null) {
      throw new Error(`AI response: invalid plannedAction at index ${i}`);
    }
    const obj = a as Record<string, unknown>;
    const tool = requireString(obj.tool, `plannedAction[${i}].tool`);
    if (!(VALID_TOOLS as readonly string[]).includes(tool)) {
      throw new Error(`AI response: invalid tool '${tool}' at plannedAction[${i}]`);
    }

    const action = requireString(obj.action, `plannedAction[${i}].action`);
    if (!isAllowedToolAction(tool, action)) {
      throw new Error(
        `AI response: invalid action '${action}' for tool '${tool}' at plannedAction[${i}]`
      );
    }

    return {
      tool: tool as typeof VALID_TOOLS[number],
      action,
      target: requireString(obj.target, `plannedAction[${i}].target`),
      ...(obj.input !== undefined ? { input: obj.input as Record<string, unknown> } : {}),
    };
  });
}

function validatePlanResult(data: unknown, interactableElements?: Array<{ selector: string; text: string; tag: string; href?: string; id?: string; name?: string; type?: string }>): AIPlanResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI response is not an object");
  }
  const obj = data as Record<string, unknown>;
  const experiments = requireArray(obj["experiments"], "experiments").map((exp, i) => {
    if (typeof exp !== "object" || exp === null) {
      throw new Error(`AI response: invalid experiment at index ${i}`);
    }
    const e = exp as Record<string, unknown>;
    return {
      objective: requireString(e.objective, `experiment[${i}].objective`),
      preconditions: requireArray(e.preconditions, `experiment[${i}].preconditions`) as string[],
      plannedActions: validatePlannedActions(e.plannedActions),
    };
  });
  const plan: AIPlanResult = { experiments };
  // Validate that browser selectors are traceable to recon data
  validatePlanSelectors(plan, interactableElements);
  return plan;
}

function validateHypothesisResult(data: unknown): AIHypothesisResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI response is not an object");
  }
  const obj = data as Record<string, unknown>;
  return {
    statement: requireString(obj.statement, "statement"),
    confidence: requireNumber(obj.confidence, "confidence"),
    supportingEvidenceIds: optionalArray(obj.supportingEvidenceIds, "supportingEvidenceIds") as string[],
    contradictingEvidenceIds: optionalArray(obj.contradictingEvidenceIds, "contradictingEvidenceIds") as string[],
  };
}

function validateVerificationResult(data: unknown): AIVerificationResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI response is not an object");
  }
  const obj = data as Record<string, unknown>;
  const shouldVerify = typeof obj.shouldVerify === "boolean" ? obj.shouldVerify : false;
  let verificationExperiment: AIVerificationResult["verificationExperiment"] = null;

  if (shouldVerify && obj.verificationExperiment) {
    if (typeof obj.verificationExperiment !== "object" || obj.verificationExperiment === null) {
      throw new Error("AI response: invalid verificationExperiment");
    }
    const ve = obj.verificationExperiment as Record<string, unknown>;
    verificationExperiment = {
      objective: requireString(ve.objective, "verificationExperiment.objective"),
      plannedActions: validatePlannedActions(ve.plannedActions),
    };
  }

  return { shouldVerify, verificationExperiment };
}

function validateEvaluationResult(data: unknown): { confidence: number; status: Hypothesis["status"] } {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI response is not an object");
  }
  const obj = data as Record<string, unknown>;
  const confidence = requireNumber(obj.confidence, "confidence");
  const status = requireString(obj.status, "status") as Hypothesis["status"];
  const validStatuses: string[] = ["proposed", "investigating", "confirmed", "rejected", "inconclusive"];
  if (!validStatuses.includes(status)) {
    throw new Error(`AI response: invalid hypothesis status '${status}'`);
  }
  return { confidence, status };
}

function validateReportResult(data: unknown): AIReportResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI response is not an object");
  }
  const obj = data as Record<string, unknown>;
  const validSeverities = ["critical", "high", "medium", "low", "info"];

  return {
    summary: requireString(obj.summary, "summary"),
    confirmedFindings: requireArray(obj["confirmedFindings"], "confirmedFindings").map((f, i) => {
      if (typeof f !== "object" || f === null) {
        throw new Error(`AI response: invalid finding at index ${i}`);
      }
      const finding = f as Record<string, unknown>;
      const severity = requireString(finding.severity, `finding[${i}].severity`);
      if (!validSeverities.includes(severity)) {
        throw new Error(`AI response: invalid severity '${severity}' at finding[${i}]`);
      }
      // Note: investigationId and evidenceIds are injected by the orchestrator,
      // not from AI output. We include empty defaults so the type matches.
      return {
        title: requireString(finding.title, `finding[${i}].title`),
        severity: severity as Finding["severity"],
        description: requireString(finding.description, `finding[${i}].description`),
        status: "confirmed" as Finding["status"],
        confidence: requireNumber(finding.confidence, `finding[${i}].confidence`),
        rootCause: (finding.rootCause as string) ?? null,
        reproductionSteps: requireArray(finding.reproductionSteps, `finding[${i}].reproductionSteps`) as string[],
        recommendation: (finding.recommendation as string) ?? null,
        investigationId: "", // injected by orchestrator
        evidenceIds: [], // injected by orchestrator
      } as Omit<Finding, "id" | "createdAt" | "updatedAt">;
    }),
    rejectedHypotheses: requireArray(obj["rejectedHypotheses"], "rejectedHypotheses") as string[],
    inconclusiveHypotheses: requireArray(obj["inconclusiveHypotheses"], "inconclusiveHypotheses") as string[],
  };
}

function validateAdaptiveDecision(data: unknown, interactableElements?: Array<{ selector: string; text: string; tag: string; href?: string; id?: string; name?: string; type?: string }>): AdaptiveDecision {
  if (typeof data !== "object" || data === null) {
    throw new Error("AI response is not an object");
  }
  const obj = data as Record<string, unknown>;
  const shouldContinue = typeof obj.shouldContinue === "boolean" ? obj.shouldContinue : false;
  const reason = requireString(obj.reason, "reason");

  if (!shouldContinue) {
    return { shouldContinue: false, reason };
  }

  if (!obj.nextExperiment || typeof obj.nextExperiment !== "object") {
    return { shouldContinue: false, reason: "shouldContinue was true but nextExperiment is missing" };
  }

  const ne = obj.nextExperiment as Record<string, unknown>;
  const experiment = {
    objective: requireString(ne.objective, "nextExperiment.objective"),
    preconditions: requireArray(ne.preconditions, "nextExperiment.preconditions") as string[],
    plannedActions: validatePlannedActions(ne.plannedActions),
  };

  // Validate selectors against recon data
  validatePlanSelectors({ experiments: [experiment] }, interactableElements);

  return { shouldContinue: true, reason, nextExperiment: experiment };
}

// ── Chat helper ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = [2000, 5000, 10000];

/**
 * Budget accounting hook. Set by the orchestrator so that every actual
 * upstream model request — including retries on 503/429 and
 * validation-retry loops — is counted individually against the AI budget.
 */
let recordAiRequest: ((count?: number) => void) | null = null;

/** Called by the orchestrator to bind AI request accounting to a budget. */
export function setAiRequestRecorder(fn: ((count?: number) => void) | null): void {
  recordAiRequest = fn;
}

async function chat(systemPrompt: string, userPrompt: string): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Count this actual upstream model request before sending it. Retries
    // are real model requests and are billed as such.
    recordAiRequest?.(1);
    const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: JSON.stringify({
        model: config.aiModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });

    const rawBody = await res.json();

    // Gemini sometimes returns HTTP 200 with an error object/array in the body.
    // Detect and treat as retryable alongside HTTP 503.
    const bodyStr = JSON.stringify(rawBody);
    const isBodyError = (
      Array.isArray(rawBody) && rawBody[0]?.error?.status === "UNAVAILABLE"
    ) || (
      typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody) && (rawBody as Record<string,unknown>).error
    );

    if (res.ok && !isBodyError) {
      const data = rawBody as { choices: { message: { content: string } }[] };
      return data.choices[0].message.content;
    }

    // Determine the effective error status: body-level errors override HTTP 200
    const errorStatus = isBodyError ? 503 : res.status;
    // Retry on 503 (unavailable) or 429 (rate-limited) — both are transient
    const isRetryable = errorStatus === 503 || errorStatus === 429;
    if (isRetryable && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS[attempt] ?? 10000;
      console.warn(`AI API ${errorStatus}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      lastError = new Error(`AI API error: ${res.status} ${bodyStr.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`AI API error: ${res.status} ${bodyStr.slice(0, 200)}`);
  }
  throw lastError ?? new Error("AI API: all retries exhausted");
}

// ── Chat + validate retry helper ─────────────────────────────────────────

/** Retry chat + parse + validate on transient model failures (malformed JSON, missing fields). */
async function chatWithValidation<T>(
  systemPrompt: string,
  userPrompt: string,
  parse: (response: string) => T,
  retries = 2,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await chat(systemPrompt, userPrompt);
      return parse(response);
    } catch (err: any) {
      lastErr = err;
      const isRetryable = err.message?.startsWith("AI response:") || err.message?.includes("JSON");
      if (isRetryable && i < retries) {
        console.warn(`Validation failed (attempt ${i + 1}/${retries + 1}), retrying: ${err.message.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr!;
}

// ── Adapter implementation ─────────────────────────────────────────────────

export function createOpenAIAdapter(): AIAdapter {
  return {
    async plan(objective, repoRecon, appRecon): Promise<AIPlanResult> {
      const systemPrompt = `You are a software investigation planner. Given an investigation objective and reconnaissance data, plan experiments to test the software's real behavior.

═══════════════════════════════════════════════════════════════════════
BUDGET: You have MAXIMUM 5 PRIMARY experiments and 40 browser actions.
2 additional experiments are RESERVED for hypothesis verification.
Plan 3-4 high-value primary experiments. Quality > quantity.
Each experiment: 2-5 actions.
═══════════════════════════════════════════════════════════════════════

Return JSON:
{
  "experiments": [
    {
      "objective": "what this experiment tests",
      "preconditions": ["what must be true"],
      "plannedActions": [
        { "tool": "browser", "action": "navigate", "target": "URL" },
        { "tool": "browser", "action": "click", "target": "CSS_SELECTOR_FROM_RECON" },
        { "tool": "browser", "action": "type", "target": "CSS_SELECTOR_FROM_RECON", "input": {"text": "value"} },
        { "tool": "browser", "action": "readText", "target": "CSS_SELECTOR_FROM_RECON" },
        { "tool": "browser", "action": "screenshot", "target": "full page" },
        { "tool": "browser", "action": "getTitle", "target": "page" }
      ]
    }
  ]
}

═══════════════════════════════════════════════════════════════════════
SELECTOR RULES (VIOLATIONS = EXPERIMENT FAILURE)
═══════════════════════════════════════════════════════════════════════

The Application Recon data contains "interactableElements" with:
- "selector": the EXACT CSS selector (e.g. a[href="#about"], input[name="email"])
- "text": visible text, "tag": HTML tag, "href", "name", "type", "id"

RULE 1: For click/type/readText, target MUST be a selector FROM interactableElements.
  ✓ "a[href=\"#about\"]"  (if recon has { selector: "a[href=\"#about\"]" })
  ✗ "section.hero a.btn"  (invented — NOT in recon)
  ✗ "nav link: About"     (natural language — NOT CSS)
  ✗ "button (submit)"     (invalid CSS syntax)
  ✗ "first project link"  (ordinal — NOT in recon)

RULE 2: For navigate, use actual URLs.
RULE 3: For screenshot/getTitle, use "full page"/"page".
RULE 4: If no recon element exists for what you need, SKIP that experiment.
RULE 5: NEVER generate git/cloneRepo actions.
RULE 6: NEVER generate sandbox runCommand actions.
RULE 7: For download links, use navigate with the URL.
RULE 8: For page verification, use getTitle.
RULE 9: For experiments whose objective explicitly involves mobile/responsive behavior, the FIRST planned action MUST be a setViewport action:
  { "tool": "browser", "action": "setViewport", "target": "page", "input": {"viewport": {"width": 390, "height": 844}} }
  Do NOT interact with mobile-only elements before setting the mobile viewport.
  Do NOT attempt to click CSS-hidden desktop elements and call it a mobile test.
  An element being hidden at desktop (1440x900) does NOT indicate an application bug when you are explicitly testing mobile behavior.
  After setViewport, allow the page to settle (navigation or a brief wait) before interacting.

RULE 9b: For desktop experiments (default), optionally use:
  { "tool": "browser", "action": "setViewport", "target": "page", "input": {"viewport": {"width": 1440, "height": 900}} }
  to reset the viewport after a mobile experiment or at startup.

RULE 9c: Mobile viewport default is 390x844. Only use other valid mobile sizes if recon/evidence gives a reason.
  Valid mobile bounds are 320-480 width, 480-900 height. Valid desktop bounds are 1024-1920 width, 640-1200 height.
  The setViewport action validates bounds and will reject out-of-range values.

RULE 9d: If the recon data includes a mobile menu toggle (id "menu-toggle", aria-label containing "menu", or a hamburger button), and the investigation objective mentions mobile or navigation, plan a mobile experiment that:
  1. sets viewport to 390x844 via a setViewport action
  2. verifies the menu toggle is visible (readText on the toggle, or screenshot)
  3. clicks the toggle
  4. verifies the mobile menu opened (readText on a nav link, or screenshot)
  5. restores the desktop viewport with a second setViewport action (1440x900)
  Do NOT skip step 1. A mobile experiment that clicks #menu-toggle at desktop viewport is a planning failure.
  The recon data for this target includes #menu-toggle (button, aria-label "Open navigation menu") and a[href="https://mexi-medicals.vercel.app"] (Live demo project link).
  Plan a mobile experiment that tests #menu-toggle at viewport 390x844, and a project-link experiment that tests the external link.

ACTION SCHEMA: The only valid browser actions are: launch, navigate, click, type, readText, screenshot, getTitle, setViewport. Do NOT invent wait/sleep/hover/scroll/drag actions. For settling the page after a click, use navigate to the same URL, screenshot, or getTitle.

PRIORITIZE: Homepage → Navigation → Key CTAs → Forms → Mobile behavior → External links
AVOID: Duplicates, screenshot-only experiments.
  If the application has a mobile menu (#menu-toggle or equivalent), prioritize a mobile experiment high enough that it actually runs within the primary budget.
  Mobile experiments are NOT optional extras — they are a core part of testing a responsive portfolio site.`;

      const userPrompt = `Objective: ${objective}\n\nRepository Recon: ${JSON.stringify(repoRecon, null, 2)}\n\nApplication Recon: ${JSON.stringify(appRecon, null, 2)}`;

      return chatWithValidation(systemPrompt, userPrompt, (r) =>
        validatePlanResult(parseJSON(r), appRecon?.interactableElements)
      );
    },

    async analyzeRepository(repoRecon, objective): Promise<string> {
      const systemPrompt = `You are a software analyst. Analyze the repository data and provide insights relevant to the investigation objective. Be specific and evidence-based.`;
      const userPrompt = `Objective: ${objective}\n\nRepository data: ${JSON.stringify(repoRecon, null, 2)}`;
      return chat(systemPrompt, userPrompt);
    },

    async analyzeObservation(observations, experiment, objective): Promise<string> {
      const systemPrompt = `You are a software behavior analyst. Analyze the observations from this experiment and provide insights.

IMPORTANT: You MUST distinguish between these categories:

1. APPLICATION FAILURE: The web application itself has a bug. Evidence: the element exists and is interactable but behaves incorrectly (wrong navigation, missing functionality, broken form submission, error messages that should not appear, etc.).

2. EXECUTION/INFRASTRUCTURE FAILURE: Probe could not interact with the application due to timing, selector mismatch, browser issues, or network problems. Evidence: "Element not found", "timeout", "navigation failed", "download triggered" errors. These are NOT application bugs.

3. AI PLANNING FAILURE: The experiment plan was invalid or poorly designed. Evidence: actions that don't make sense, redundant experiments, or missing preconditions.

4. MISSING EVIDENCE: Not enough data to draw a conclusion. The experiment ran but didn't capture the right information.

5. INCONCLUSIVE: The experiment ran correctly but the result is ambiguous.

For each observation, classify it as one of these categories. Only observations classified as APPLICATION FAILURE can support a finding.

Compare expected vs actual behavior. Be specific about what went right and what went wrong.

FORM SUBMISSION OBSERVATION RULES:
- After clicking a submit button, DO NOT immediately read a single feedback element and treat an empty result as "submission failed".
- To let the page settle after the submit click, use one of these VALID actions: navigate to the same URL again (e.g. navigate to the current URL or the anchor URL), take a screenshot, or read a stable element. Do NOT invent a "wait" or "sleep" action — those are not in the action schema.
- Then read ALL relevant feedback elements (e.g. the form message container AND the toast/notification area) in the same observation.
- If multiple feedback elements exist, read each one and report what each contained.
- If the UI shows a success message, capture it as evidence.
- If the UI shows an error message, capture it as evidence.
- If no visible text feedback exists in any relevant element after settling, report: "submission action succeeded (button clicked, no blocking error), but no visible success/error feedback was observed in the inspected elements." Classify this as MISSING EVIDENCE or INCONCLUSIVE, NOT as an application failure.
- Do NOT manufacture a finding from missing immediate feedback. A form that submits without obvious inline feedback is not necessarily broken; it may use toast notifications, console logging, email delivery, or a different success path.
- If the submit action itself failed (button not found, button disabled, page error), that is an EXECUTION or APPLICATION failure depending on root cause.

ACTION SCHEMA: The only valid browser actions are: launch, navigate, click, type, readText, screenshot, getTitle, setViewport. Do NOT invent other actions (wait, sleep, hover, scroll, drag, etc.). For settling after a click, use navigate (to same URL or anchor), screenshot, or getTitle.`;
      const userPrompt = `Objective: ${objective}\n\nExperiment: ${experiment.objective}\n\nExperiment status: ${experiment.status}${experiment.error ? `\nExperiment error: ${experiment.error}` : ""}\n\nObservations: ${JSON.stringify(observations, null, 2)}`;
      return chat(systemPrompt, userPrompt);
    },

    async generateHypothesis(analysis, evidence, objective): Promise<AIHypothesisResult> {
      const systemPrompt = `You are a software investigator. Based on analysis and evidence, generate a hypothesis about the software's behavior.

CRITICAL RULES:
1. Only generate hypotheses about APPLICATION BUGS — actual user-facing problems in the target software.
2. Do NOT generate hypotheses about Probe infrastructure, Solari browser/sandbox issues, selector mismatches, timeouts, or AI planning failures. These are NOT application bugs.
3. Do NOT generate a hypothesis merely because an expected outcome was not observed. Lack of observation is not evidence of a bug.
4. A hypothesis requires supporting evidence that demonstrates an actual application defect.
5. If all evidence points to execution/infrastructure failures, state that no application hypothesis can be formed.

Return JSON:
{
  "statement": "clear hypothesis about an APPLICATION BUG (or 'No application bug identified' if infrastructure failures only)",
  "confidence": 0.0-1.0,
  "supportingEvidenceIds": ["ev_id1"],
  "contradictingEvidenceIds": ["ev_id2"]
}`;

      const userPrompt = `Objective: ${objective}\n\nAnalysis: ${analysis}\n\nEvidence IDs: ${evidence.map((e) => `${e.id} (${e.type}): ${JSON.stringify(e.metadata)}`).join("\n")}`;

      return chatWithValidation(systemPrompt, userPrompt, (r) => validateHypothesisResult(parseJSON(r)));
    },

    async designVerification(hypothesis, evidence): Promise<AIVerificationResult> {
      const systemPrompt = `You are a verification designer. Determine if a hypothesis can be verified with an experiment, and design that experiment.

═══════════════════════════════════════════════════════════════════════
SELECTOR RULES (STRICTLY ENFORCED — same rules as the main planner)
═══════════════════════════════════════════════════════════════════════

For browser click/type/readText actions, the target MUST be a CSS selector that could plausibly exist on the target page. DO NOT invent selectors from natural language.

Correct: "a[href=\"#about\"]", "#contactForm input[name=\"email\"]", "button[type=\"submit\"]"
Wrong: "nav link: About", "button (submit)", "section.hero a.btn", "first project link"

RULES:
- For navigate actions, use actual URLs.
- For screenshot/getTitle, use "full page"/"page".
- NEVER generate git/cloneRepo actions.
- NEVER generate sandbox runCommand actions.
- If you cannot construct valid selectors, set shouldVerify to false.

Return JSON:
{
  "shouldVerify": true/false,
  "verificationExperiment": {
    "objective": "what this verification tests",
    "plannedActions": [
      { "tool": "browser", "action": "navigate|click|type|screenshot", "target": "..." }
    ]
  }
}`;

      const userPrompt = `Hypothesis: ${hypothesis.statement}\nCurrent confidence: ${hypothesis.confidence}\n\nExisting evidence: ${evidence.map((e) => `${e.id}: ${JSON.stringify(e.metadata)}`).join("\n")}`;

      return chatWithValidation(systemPrompt, userPrompt, (r) => validateVerificationResult(parseJSON(r)));
    },

    async evaluateEvidence(hypothesis, newEvidence): Promise<{ confidence: number; status: Hypothesis["status"] }> {
      const systemPrompt = `You are an evidence evaluator. Given a hypothesis and new evidence, evaluate whether the hypothesis is confirmed, rejected, or still inconclusive.

CRITICAL RULES:
1. CONFIRMED only when evidence DEMONSTRATES an actual application bug.
2. Do NOT confirm based on: element not found, timeouts, navigation failures, download triggers, or other Probe/infrastructure issues.
3. Do NOT confirm based on absence of evidence ("nothing was observed" is not proof of a bug).
4. If all new evidence is about execution/infrastructure failures, mark as INCONCLUSIVE.
5. REJECTED when evidence actively contradicts the hypothesis.

Return JSON:
{
  "confidence": 0.0-1.0,
  "status": "confirmed|rejected|inconclusive"
}`;

      const userPrompt = `Hypothesis: ${hypothesis.statement}\nCurrent confidence: ${hypothesis.confidence}\nCurrent status: ${hypothesis.status}\n\nNew evidence: ${newEvidence.map((e) => `${e.id} (${e.type}): ${JSON.stringify(e.metadata)}`).join("\n")}`;

      return chatWithValidation(systemPrompt, userPrompt, (r) => validateEvaluationResult(parseJSON(r)));
    },

    async decideNextStep(objective, experiments, evidence, analysis, remainingPrimaryBudget, remainingActions, appRecon): Promise<AdaptiveDecision> {
      const completedExperiments = experiments.filter(e => e.status === "completed");
      const failedExperiments = experiments.filter(e => e.status === "failed");
      const executedActions = evidence.filter(e => e.type === "action_trace").length;

      // If no budget remains, stop
      if (remainingPrimaryBudget <= 0 || remainingActions <= 0) {
        return { shouldContinue: false, reason: "Budget exhausted" };
      }

      const systemPrompt = `You are an investigation planner deciding whether to continue testing.

You have completed some experiments against the target application. Based on the evidence collected so far, decide if ONE more experiment would materially increase confidence in the findings.

RULES:
1. Only request continuation if evidence is ambiguous or an important user journey remains untested.
2. If evidence clearly shows the application works correctly, stop.
3. If evidence clearly confirms a bug, stop.
4. Do NOT generate redundant experiments that test the same behavior.
5. The next experiment must use ONLY selectors from the Application Recon interactableElements.
6. For mobile experiments, the first browser action MUST be: { "tool": "browser", "action": "setViewport", "target": "page", "input": {"viewport": {"width": 390, "height": 844}} }. Do NOT attach viewport to a navigate action as a workaround — use the dedicated setViewport action.
7. For desktop experiments, optionally use: { "tool": "browser", "action": "setViewport", "target": "page", "input": {"viewport": {"width": 1440, "height": 900}} } on the first browser action to restore desktop.
8. The only valid browser actions are: launch, navigate, click, type, readText, screenshot, getTitle, setViewport. Do NOT invent wait/sleep/hover/scroll actions.

Available budget: ${remainingPrimaryBudget} primary experiments, ${remainingActions} actions.

Return JSON:
{
  "shouldContinue": true/false,
  "reason": "brief explanation",
  "nextExperiment": {
    "objective": "what this tests",
    "preconditions": ["preconditions"],
    "plannedActions": [
      { "tool": "browser", "action": "navigate", "target": "URL" },
      { "tool": "browser", "action": "setViewport", "target": "page", "input": {"viewport": {"width": 390, "height": 844}} },
      { "tool": "browser", "action": "click", "target": "CSS_SELECTOR_FROM_RECON" }
    ]
  }
}

IMPORTANT: For mobile/responsive experiments, use a dedicated setViewport action as a separate planned action, NOT as an extra field on a navigate/click action. The runner only applies viewport from setViewport actions.

If shouldContinue is false, omit nextExperiment.`;

      const userPrompt = `Objective: ${objective}\n\nExperiments completed: ${completedExperiments.length}\nExperiments failed: ${failedExperiments.length}\nActions executed: ${executedActions}\n\nAnalysis: ${analysis}\n\nEvidence summary: ${evidence.map(e => `${e.type}: ${JSON.stringify(e.metadata).slice(0, 200)}`).join("\n")}\n\nApplication Recon: ${JSON.stringify(appRecon, null, 2)}`;

      return chatWithValidation(systemPrompt, userPrompt, (r) => validateAdaptiveDecision(parseJSON(r), appRecon?.interactableElements));
    },

    async generateReport(investigation, findings, hypotheses, experiments, evidence): Promise<AIReportResult> {
      const systemPrompt = `You are a software investigation report generator. Produce a comprehensive evidence-backed report.

CRITICAL CLASSIFICATION RULES:

1. CONFIRMED FINDINGS: Only include findings that demonstrate an ACTUAL USER-FACING APPLICATION BUG. Evidence must show the application itself is defective, not that Probe failed to interact with it.

2. REJECTED HYPOTHESES: Hypotheses where evidence contradicts the claimed bug.

3. INCONCLUSIVE: Investigations where evidence is insufficient to confirm or reject. This includes cases where:
   - Probe execution failures prevented testing (element not found, timeout, navigation issues)
   - The AI planner generated invalid experiments
   - Insufficient observations were captured
   - The result is genuinely ambiguous

4. PROBE/EXECUTION FAILURES: Do NOT include these as confirmed findings. Note them in the summary as limitations.

Return JSON:
{
  "summary": "executive summary: confirmed findings, rejected hypotheses, inconclusive areas, and probe limitations",
  "confirmedFindings": [
    {
      "title": "finding title",
      "severity": "critical|high|medium|low|info",
      "description": "detailed description with evidence",
      "status": "confirmed",
      "confidence": 0.0-1.0,
      "rootCause": "what causes this",
      "reproductionSteps": ["step1", "step2"],
      "recommendation": "how to fix"
    }
  ],
  "rejectedHypotheses": ["hypothesis statement"],
  "inconclusiveHypotheses": ["hypothesis statement"]
}

If there are no confirmed application findings, confirmedFindings should be an empty array and the summary should explain why (e.g., "All experiment failures were due to Probe execution issues, not application bugs").`;

      // The report must be grounded in the ACTUAL recorded experiment outcomes.
      // Passing only counts lets the model invent outcomes (e.g. claiming
      // "execution failures" when the store records every experiment completed).
      const evidenceTypeCounts = evidence.reduce<Record<string, number>>((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {});
      const experimentLines = experiments
        .map(
          (e) =>
            `- #${e.sequence} [${e.status}] ${e.objective.slice(0, 160)}` +
            (e.result ? ` | result: ${e.result}` : "") +
            (e.error ? ` | error: ${e.error.slice(0, 200)}` : "")
        )
        .join("\n");
      const userPrompt = `Investigation: ${investigation.objective}\nTarget: ${investigation.repositoryUrl} / ${investigation.applicationUrl}\n\nFindings: ${JSON.stringify(findings, null, 2)}\n\nHypotheses: ${JSON.stringify(hypotheses, null, 2)}\n\nExperiments run (${experiments.length}) — ACTUAL recorded outcomes; do not assume outcomes not listed here:\n${experimentLines}\n\nEvidence collected: ${evidence.length} items by type: ${JSON.stringify(evidenceTypeCounts)}`;

      return chatWithValidation(systemPrompt, userPrompt, (r) => validateReportResult(parseJSON(r)));
    },
  };
}
