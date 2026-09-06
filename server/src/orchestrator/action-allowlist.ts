/**
 * Authoritative action/tool allowlists.
 *
 * Single source of truth consumed by every validation and execution layer:
 *   - AI output validation (ai/openai.ts)
 *   - orchestrator dispatch validation (orchestrator/runner.ts)
 *   - sandbox adapter exports (solari/sandbox.ts)
 *
 * Security invariants encoded here:
 *   - Tools are exactly "browser" and "sandbox". There is no "git" tool —
 *     repository cloning is orchestrator-owned recon, not an AI action.
 *   - The sandbox tool exposes only read-only operations. Arbitrary command
 *     execution (runCommand / runShellCommand) is NOT AI-reachable; the AI
 *     cannot execute binaries, shell syntax, or pipelines.
 *   - setViewport is a first-class browser action.
 *   - Consumers may extend this list ONLY via the exported constants — never
 *     by maintaining a divergent copy.
 */

/** Tools the AI may plan actions for. Orchestrator-owned execution only. */
export const VALID_TOOLS = ["browser", "sandbox"] as const;

export type ValidTool = (typeof VALID_TOOLS)[number];

/** Browser actions the AI may plan. Dispatched to the remote Solari browser. */
export const VALID_BROWSER_ACTIONS = [
  "launch",
  "navigate",
  "click",
  "type",
  "readText",
  "screenshot",
  "getTitle",
  "setViewport",
] as const;

/**
 * Sandbox actions the AI may plan.
 *
 * Read-only observation only: read a file, list a directory, run a command
 * from the read-only command allowlist. Every dispatch is validated again in
 * solari/sandbox.ts — the AI can never reach arbitrary binaries, shell
 * syntax, or pipelines.
 */
export const VALID_SANDBOX_ACTIONS = ["readFile", "listDirectory", "runReadOnlyCommand"] as const;

/** Read-only commands the AI may execute in the sandbox, with arg validation. */
export const SANDBOX_READ_ONLY_COMMANDS = [
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "file",
  "node",
  "python3",
  "npm",
  "git",
] as const;

export type ValidAction = ValidTool extends never
  ? never
  : (typeof VALID_BROWSER_ACTIONS | typeof VALID_SANDBOX_ACTIONS)[number];

/** Full allowlist by tool: the shape every consumer uses. */
export const VALID_ACTIONS_BY_TOOL: Record<ValidTool, readonly string[]> = {
  browser: VALID_BROWSER_ACTIONS,
  sandbox: VALID_SANDBOX_ACTIONS,
};

/** Is this tool/action pair allowed for AI planning? */
export function isAllowedToolAction(tool: string, action: string): boolean {
  if (!(VALID_TOOLS as readonly string[]).includes(tool)) return false;
  const actions = VALID_ACTIONS_BY_TOOL[tool as ValidTool];
  return actions.includes(action);
}

/**
 * Interaction actions whose targets are expected to be CSS selectors.
 *
 * Non-interaction actions (navigate/screenshot/getTitle/launch) use page-level
 * targets and are exempt from selector validation.
 */
const SELECTOR_TARGET_ACTIONS: readonly string[] = ["click", "type", "readText", "setViewport"];

/**
 * Validate that a planned action's target looks like a CSS selector, not
 * natural language the browser adapter cannot reliably resolve.
 *
 * Rejects only unambiguous natural-language shapes:
 *   - "nav link: About" / "button: Submit"  (label: prefix)
 *   - "first project link" / "2nd row"       (ordinal prefix)
 *   - "the login form" (plain-English phrases — spaces with no CSS
 *     combinators and no attribute syntax)
 *
 * Accepts anything that plausibly is CSS, including the common element
 * selectors that start with "input", "button", "a", "nav", "form":
 *   - "button[type=submit]", "input[name=email]", "#contactForm input",
 *     "main > p", "a[href='#about']"
 *
 * Single source of truth: consumed by verification validation in the runner
 * (and mirrored by selector-resolution tests), replacing the earlier heuristic
 * that false-positived valid CSS beginning with element names.
 */
export function looksLikeCssSelector(target: string, action: string): boolean {
  if (!SELECTOR_TARGET_ACTIONS.includes(action)) return true; // page-level targets exempt
  if (typeof target !== "string" || target.length === 0) return false;

  // Label-prefixed natural language: "button: Submit", "nav link: About"
  if (/(?:^|\s)(link|button|nav|form|input|anchor|cta|section|page|text)\s*:/i.test(target)) return false;
  // Colon-space or parentheses anywhere = descriptive prose
  if (target.includes(": ") || target.includes("(")) return false;
  // Ordinal prefixes: "first project link", "2nd row"
  if (/^(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/i.test(target)) return false;
  // Plain-English phrase: spaces but no CSS combinator and no attribute syntax
  if (/\s/.test(target) && !target.includes(">") && !target.includes("[")) return false;

  return true;
}

/** Is this command on the sandbox read-only allowlist? */
export function isReadOnlySandboxCommand(command: string): boolean {
  return (SANDBOX_READ_ONLY_COMMANDS as readonly string[]).includes(command);
}
