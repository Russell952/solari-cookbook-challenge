/**
 * Navigation-reliability regression tests.
 *
 * Root cause of the production failure (inv_1789867447390_t8ejoj — target
 * https://russell952.github.io/Image_Search_app, objective "is image fetch
 * working?" — investigation FAILED at phase "plan" with 0 experiments):
 *
 *   1. validatePlanSelectors required recon provenance for structural
 *      targets ("body") that always exist in a DOM — the executor's own
 *      gate (looksLikeCssSelector) accepts them, so the validator was
 *      stricter than the pipeline it feeds.
 *   2. The shape-based fabricated-pattern heuristic ran BEFORE recon
 *      provenance and matched genuine recon selectors ("#hero > button"
 *      matches /\b(hero)\s+/ because the recon itself names the section
 *      "hero").
 *   3. chatWithValidation classified deterministic plan-validation errors as
 *      NON-retryable (they match neither "AI response:" nor "JSON"), so a
 *      single bad model output killed the whole investigation before any
 *      experiment existed.
 *   4. The plan system prompt hardcoded another application's recon
 *      (mexi-medicals) and imperatively commanded the planner to use it.
 *
 * The validator tests drive the REAL exported validatePlanResult; the
 * lifecycle tests drive the REAL adapter (createOpenAIAdapter) with only the
 * HTTP transport stubbed, so planning → validation → bounded re-prompt →
 * recovery runs exactly as in production.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlanResult, createOpenAIAdapter } from "../ai/openai.js";
import { looksLikeCssSelector } from "../orchestrator/action-allowlist.js";
import type { InteractableElement } from "@probe/shared";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Recon exactly as produced for the Image_Search_app target (from the live failure record). */
const IMAGE_SEARCH_RECON = [
  { selector: 'a[href="Search-app\\\\search\\.html"]', text: "Search app", tag: "a" },
  { selector: "#hero > button", text: "Get started", tag: "button" },
  { selector: "#cta > button", text: "Try it", tag: "button" },
  { selector: "#hero", text: "Hero", tag: "section" },
  { selector: "#what-it-does", text: "What it does", tag: "section" },
] as InteractableElement[];

function planOf(actions: Array<Record<string, unknown>>) {
  return {
    experiments: [
      { objective: "Verify navigation and search entry point", preconditions: [], plannedActions: actions },
    ],
  };
}

// ── Root cause 1: structural targets are valid without recon provenance ─────

describe("plan validation accepts structural DOM targets", () => {
  it.each(["body", "html", "head", "main"])("readText on '%s' validates without recon provenance", (target) => {
    const plan = planOf([
      { tool: "browser", action: "navigate", target: "https://russell952.github.io/Image_Search_app/" },
      { tool: "browser", action: "readText", target },
    ]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).not.toThrow();
  });

  it("the production failure shape (navigate + readText #hero + readText body) now validates", () => {
    const plan = planOf([
      { tool: "browser", action: "navigate", target: "https://russell952.github.io/Image_Search_app/" },
      { tool: "browser", action: "readText", target: "#hero" },
      { tool: "browser", action: "readText", target: "body" },
    ]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).not.toThrow();
  });

  it("the executor's gate and the planner validator now agree on 'body'", () => {
    expect(looksLikeCssSelector("body", "readText")).toBe(true);
    const plan = planOf([{ tool: "browser", action: "readText", target: "body" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).not.toThrow();
  });
});

// ── Root cause 2: recon provenance beats the shape heuristic ────────────────

describe("plan validation checks provenance before the fabricated heuristic", () => {
  it("a recon selector containing element words ('#hero > button') validates", () => {
    const plan = planOf([{ tool: "browser", action: "click", target: "#hero > button" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).not.toThrow();
  });

  it("a compound anchored on a recon selector but not itself in recon validates ('#hero button')", () => {
    const plan = planOf([{ tool: "browser", action: "click", target: "#hero button" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).not.toThrow();
  });

  it("natural language that merely references a recon word is still rejected", () => {
    const plan = planOf([{ tool: "browser", action: "click", target: "hero section button" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).toThrow(/Plan selector error|fabricated/);
  });

  it("an ordinal natural-language target is still rejected", () => {
    const plan = planOf([{ tool: "browser", action: "click", target: "first button" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).toThrow(/Plan selector error|fabricated/);
  });

  it("a label-prefixed target is still rejected", () => {
    const plan = planOf([{ tool: "browser", action: "click", target: "button: Submit" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).toThrow(/fabricated/);
  });

  it("a completely invented selector with no recon anchor is still rejected", () => {
    const plan = planOf([{ tool: "browser", action: "click", target: ".invented-class-from-training-data" }]);
    expect(() => validatePlanResult(plan, IMAGE_SEARCH_RECON)).toThrow(/Plan selector error/);
  });

  it("a bare-tag recon selector cannot be borrowed as a natural-language prefix", () => {
    // If recon recorded "a" (bare tag), "a link to the store" must NOT pass.
    const recon = [{ selector: "a", text: "links", tag: "a" }] as InteractableElement[];
    const plan = planOf([{ tool: "browser", action: "click", target: "a link to the store" }]);
    expect(() => validatePlanResult(plan, recon)).toThrow(/Plan selector error|fabricated/);
  });
});

// ── Root cause 3: validation errors are retryable (real adapter, stubbed transport) ──

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds a valid plan response for the Image_Search recon. */
function validPlanResponse(): string {
  return JSON.stringify({
    experiments: [
      {
        objective: "Verify the search page loads",
        preconditions: [],
        plannedActions: [
          { tool: "browser", action: "navigate", target: "https://russell952.github.io/Image_Search_app/" },
          { tool: "browser", action: "readText", target: "body" },
          { tool: "browser", action: "click", target: "#hero > button" },
        ],
      },
    ],
  });
}

describe("plan() recovers from validator rejections via bounded re-prompts", () => {
  it("a first invalid plan followed by a valid one succeeds on the real adapter", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages: Array<{ role: string; content: string }>;
        };
        const user = body.messages.find((m) => m.role === "user")?.content ?? "";
        // Only the planner prompt asks for experiments; other adapter calls
        // (none expected here) would get a generic shape.
        void user;
        const content = calls === 1 ? JSON.stringify({ experiments: [{ objective: "o", preconditions: [], plannedActions: [{ tool: "browser", action: "readText", target: "body" }, { tool: "browser", action: "click", target: "first button" }] }] }) : validPlanResponse();
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const adapter = createOpenAIAdapter();
    const plan = await adapter.plan("is image fetch working?", makeRepoRecon(), {
      pageTitle: "Image Search",
      initialUrl: "https://russell952.github.io/Image_Search_app/",
      navigation: [],
      forms: [],
      buttons: [],
      links: [],
      screenshot: "",
      primaryWorkflow: null,
      interactableElements: IMAGE_SEARCH_RECON,
    });

    expect(calls).toBe(2); // one rejection + one bounded re-prompt
    expect(plan.experiments).toHaveLength(1);
    expect(plan.experiments[0].plannedActions.some((a) => a.action === "navigate")).toBe(true);
  });

  it("a plan that is valid against recon but untraceable to it still retries, then fails with the real error", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        calls++;
        void init;
        const content = JSON.stringify({
          experiments: [
            {
              objective: "o",
              preconditions: [],
              plannedActions: [{ tool: "browser", action: "click", target: ".invented-class-from-training-data" }],
            },
          ],
        });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const adapter = createOpenAIAdapter();
    await expect(
      adapter.plan("is image fetch working?", makeRepoRecon(), {
        pageTitle: "Image Search",
        initialUrl: "https://russell952.github.io/Image_Search_app/",
        navigation: [],
        forms: [],
        buttons: [],
        links: [],
        screenshot: "",
        primaryWorkflow: null,
        interactableElements: IMAGE_SEARCH_RECON,
      }),
    ).rejects.toThrow(/Plan selector error/);
    expect(calls).toBe(3); // initial + 2 bounded retries — never unbounded
  });
});

function makeRepoRecon() {
  return {
    readme: "# Image Search",
    packageManager: "npm",
    language: "JavaScript",
    framework: "React",
    testScripts: ["test"],
    devScripts: ["dev"],
    startScripts: ["start"],
    sourceDirectories: ["src"],
    configFiles: ["package.json"],
    packageJson: { name: "image-search", scripts: { dev: "vite" } },
  };
}

// ── Root cause 4: the plan prompt must not command planning against other targets ──

describe("plan prompt is target-agnostic", () => {
  it("contains no hardcoded selectors/URLs from any specific application", () => {
    const src = readFileSync(join(process.cwd(), "src/ai/openai.ts"), "utf-8");
    expect(src.includes("mexi-medicals")).toBe(false);
    expect(/Plan a mobile experiment that tests #menu-toggle/.test(src)).toBe(false);
  });

  it("keeps the explicit target rule instructing recon-only selectors", () => {
    const src = readFileSync(join(process.cwd(), "src/ai/openai.ts"), "utf-8");
    expect(src.includes("TARGET RULE: use ONLY selectors and URLs that appear in THIS investigation's Application Recon")).toBe(true);
  });
});

// ── Navigation security: the policy layer is untouched and still enforced ───

describe("navigation policy remains enforced (guards against overfix)", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:3001/api",
    "http://127.0.0.1/x",
    "ftp://russell952.github.io/file",
    "javascript:alert(1)",
  ])("SSRF validation still rejects %s", (url) => {
    expect(() => validateApplicationUrlGuard(url)).toThrow();
  });
});

// Imported late on purpose: keeps the security boundary explicit in this suite.
import { validateApplicationUrl as validateApplicationUrlGuard } from "../security/url-validation.js";
import { assertNavigationAllowed, NavigationPolicyError } from "../security/navigation-policy.js";

describe("canonical-target policy remains enforced (guards against overfix)", () => {
  const canonical = "https://russell952.github.io/Image_Search_app/";

  it("allows same-host routes, queries, and fragments", () => {
    expect(() => assertNavigationAllowed("https://russell952.github.io/Image_Search_app/search.html", canonical)).not.toThrow();
    expect(() => assertNavigationAllowed("https://russell952.github.io/Image_Search_app/search.html?q=image+fetch", canonical)).not.toThrow();
    expect(() => assertNavigationAllowed("https://russell952.github.io/Image_Search_app/#results", canonical)).not.toThrow();
  });

  it("rejects unrelated hosts", () => {
    expect(() => assertNavigationAllowed("https://astonishing-alpaca-12a6ed.netlify.app/", canonical)).toThrow(NavigationPolicyError);
  });

  it("fails closed without a canonical URL", () => {
    expect(() => assertNavigationAllowed("https://russell952.github.io/", undefined)).toThrow(NavigationPolicyError);
  });
});
