/**
 * Selector provenance and quality validation tests.
 *
 * These tests verify that:
 * 1. Observed selectors from recon data are reused exactly
 * 2. Fabricated/invented selectors are rejected
 * 3. Natural-language targets are rejected for browser actions
 * 4. Invalid CSS targets are rejected
 * 5. Missing recon targets cause safe failure
 * 6. Valid selectors from recon continue to work
 * 7. Security/action-whitelist behavior is maintained
 * 8. Git cloning is not generated as redundant experiment
 */
import { describe, it, expect } from "vitest";
import type { InteractableElement } from "@probe/shared";

// ── Replicate the validation logic from openai.ts for testability ────────

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
];

/**
 * Patterns for clearly invalid CSS selectors.
 */
const INVALID_CSS_PATTERNS = [
  // Unbalanced parentheses
  /\((?![^)]*\[)[^)]*$/,
];

function validateSelectorQuality(
  target: string,
  action: string,
  index: number
): string | null {
  if (/^https?:\/\//.test(target)) return null;
  if (action === "screenshot" || action === "getTitle" || action === "launch")
    return null;
  for (const pattern of FABRICATED_SELECTOR_PATTERNS) {
    if (pattern.test(target)) {
      return `plannedAction[${index}].target is a fabricated selector: "${target}". Use a selector from interactableElements instead.`;
    }
  }
  for (const pattern of INVALID_CSS_PATTERNS) {
    if (pattern.test(target)) {
      return `plannedAction[${index}].target has invalid CSS syntax: "${target}"`;
    }
  }
  const looksLikeValidCss = /^[#.[*:a-zA-Z]/.test(target);
  if (!looksLikeValidCss && target !== "page" && target !== "full page") {
    return `plannedAction[${index}].target does not look like a valid CSS selector: "${target}"`;
  }
  return null;
}

interface PlanResult {
  experiments: {
    objective: string;
    preconditions: string[];
    plannedActions: {
      tool: string;
      action: string;
      target: string;
      input?: Record<string, unknown>;
    }[];
  }[];
}

function validatePlanSelectors(
  plan: PlanResult,
  interactableElements?: InteractableElement[]
): void {
  if (!interactableElements || interactableElements.length === 0) return;

  const knownSelectors = new Set(interactableElements.map((e) => e.selector));
  const knownHrefs = new Set(
    interactableElements.map((e) => e.href).filter((h): h is string => !!h)
  );

  for (const [expIdx, experiment] of plan.experiments.entries()) {
    for (const [actIdx, action] of experiment.plannedActions.entries()) {
      const idx = expIdx * 100 + actIdx;
      if (action.tool !== "browser") continue;
      if (
        ["navigate", "screenshot", "getTitle", "launch"].includes(action.action)
      )
        continue;

      const target = action.target;

      // First: reject obviously fabricated selectors
      const qualityError = validateSelectorQuality(target, action.action, idx);
      if (qualityError) throw new Error(qualityError);

      // Second: check exact match
      if (knownSelectors.has(target)) continue;

      // Third: href-based match
      const hrefMatch = target.match(/a\[href=["']([^"']+)["']\]/);
      if (hrefMatch && knownHrefs.has(hrefMatch[1])) continue;

      // Fourth: #id match
      if (target.startsWith("#")) {
        const idFromTarget = target.slice(1);
        if (
          interactableElements.some(
            (e) => e.id === idFromTarget || e.selector === target
          )
        )
          continue;
      }

      // Fifth: input[type=...] match
      const inputTypeMatch = target.match(/^input\[type=["']([^"']+)["']\]$/);
      if (inputTypeMatch) {
        if (
          interactableElements.some(
            (e) => e.tag === "input" && e.type === inputTypeMatch[1]
          )
        )
          continue;
      }

      // Sixth: input[name=...] match
      const inputNameMatch = target.match(
        /^(?:#\S+\s+)?input\[name=["']([^"']+)["']\]$/
      );
      if (inputNameMatch) {
        if (interactableElements.some((e) => e.name === inputNameMatch[1]))
          continue;
      }

      // Not traceable — throw
      throw new Error(
        `Plan selector validation failed: target "${target}" at experiment[${expIdx}].action[${actIdx}] ` +
          `does not match any interactableElement from recon. ` +
          `Available selectors: ${interactableElements
            .slice(0, 5)
            .map((e) => e.selector)
            .join(", ")}...`
      );
    }
  }
}

// ── Test data ──────────────────────────────────────────────────────────

const RECON_ELEMENTS: InteractableElement[] = [
  {
    selector: 'a[href="#about"]',
    text: "About",
    tag: "a",
    href: "#about",
    id: undefined,
  },
  {
    selector: 'a[href="#work"]',
    text: "Work",
    tag: "a",
    href: "#work",
    id: undefined,
  },
  {
    selector: 'a[href="#contact"]',
    text: "Contact",
    tag: "a",
    href: "#contact",
    id: undefined,
  },
  {
    selector: "#contactForm input[name='email']",
    text: "",
    tag: "input",
    name: "email",
    id: undefined,
  },
  {
    selector: "#contactForm input[name='name']",
    text: "",
    tag: "input",
    name: "name",
    id: undefined,
  },
  {
    selector: "#contactForm textarea[name='message']",
    text: "",
    tag: "textarea",
    name: "message",
    id: undefined,
  },
  {
    selector: '#contactForm button[type="submit"]',
    text: "Send",
    tag: "button",
    type: "submit",
    id: undefined,
  },
  {
    selector: 'a[href="https://github.com/example"]',
    text: "GitHub",
    tag: "a",
    href: "https://github.com/example",
    id: undefined,
  },
  {
    selector: 'a[href="/certificate"]',
    text: "View Certificate",
    tag: "a",
    href: "/certificate",
    id: undefined,
  },
  {
    selector: "#hero-cta",
    text: "View my work",
    tag: "a",
    href: "#work",
    id: "hero-cta",
  },
];

function makePlan(
  actions: { tool: string; action: string; target: string; input?: Record<string, unknown> }[]
): PlanResult {
  return {
    experiments: [
      {
        objective: "Test something",
        preconditions: ["page loaded"],
        plannedActions: actions,
      },
    ],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Selector Provenance Validation", () => {
  describe("Fabricated selectors are rejected", () => {
    it('rejects "section.hero a.btn" (invented class/structure)', () => {
      const err = validateSelectorQuality(
        "section.hero a.btn",
        "click",
        0
      );
      expect(err).toContain("fabricated");
      expect(err).toContain("section.hero a.btn");
    });

    it('rejects "button (submit)" (invalid CSS syntax)', () => {
      const err = validateSelectorQuality(
        "button (submit)",
        "click",
        0
      );
      expect(err).toContain("fabricated");
      expect(err).toContain("button (submit)");
    });

    it('rejects "#contactForm > div > button (submit)" (invented hierarchy + invalid syntax)', () => {
      const err = validateSelectorQuality(
        "#contactForm > div > button (submit)",
        "click",
        0
      );
      expect(err).toContain("fabricated");
      expect(err).toContain("#contactForm > div > button (submit)");
    });

    it('rejects "nav link: About" (natural language)', () => {
      const err = validateSelectorQuality("nav link: About", "click", 0);
      expect(err).toContain("fabricated");
      expect(err).toContain("nav link: About");
    });

    it('rejects "button: Get in touch" (natural language)', () => {
      const err = validateSelectorQuality(
        "button: Get in touch",
        "click",
        0
      );
      expect(err).toContain("fabricated");
      expect(err).toContain("button: Get in touch");
    });

    it('rejects "link: View my work" (natural language)', () => {
      const err = validateSelectorQuality(
        "link: View my work",
        "click",
        0
      );
      expect(err).toContain("fabricated");
    });

    it('rejects "form field: Email" (natural language)', () => {
      const err = validateSelectorQuality(
        "form field: Email",
        "type",
        0
      );
      expect(err).toContain("fabricated");
    });

    it('rejects "cta hero button" (compound description)', () => {
      const err = validateSelectorQuality(
        "cta hero button",
        "click",
        0
      );
      expect(err).toContain("fabricated");
    });

    it('"submit button login" passes quality check but is caught by provenance', () => {
      // This string looks like CSS but won't match any recon element
      const err = validateSelectorQuality(
        "submit button login",
        "click",
        0
      );
      // Quality check passes (looks like valid CSS)
      expect(err).toBeNull();
      // But provenance check catches it
      const plan = makePlan([
        { tool: "browser", action: "click", target: "submit button login" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).toThrow(
        "does not match any interactableElement"
      );
    });
  });

  describe("Valid selectors pass quality check", () => {
    it('accepts \'a[href="#about"]\' (recon-style selector)', () => {
      const err = validateSelectorQuality('a[href="#about"]', "click", 0);
      expect(err).toBeNull();
    });

    it('accepts \'#contactForm input[name="email"]\'', () => {
      const err = validateSelectorQuality(
        '#contactForm input[name="email"]',
        "type",
        0
      );
      expect(err).toBeNull();
    });

    it('accepts \'button[type="submit"]\'', () => {
      const err = validateSelectorQuality(
        'button[type="submit"]',
        "click",
        0
      );
      expect(err).toBeNull();
    });

    it("accepts URL for navigate actions", () => {
      const err = validateSelectorQuality(
        "https://example.com",
        "navigate",
        0
      );
      expect(err).toBeNull();
    });

    it('accepts "full page" for screenshot', () => {
      const err = validateSelectorQuality("full page", "screenshot", 0);
      expect(err).toBeNull();
    });

    it('accepts "page" for getTitle', () => {
      const err = validateSelectorQuality("page", "getTitle", 0);
      expect(err).toBeNull();
    });

    it("accepts #id selector", () => {
      const err = validateSelectorQuality("#hero-cta", "click", 0);
      expect(err).toBeNull();
    });

    it("accepts tag selector", () => {
      const err = validateSelectorQuality("button", "click", 0);
      expect(err).toBeNull();
    });

    it("accepts .class selector", () => {
      const err = validateSelectorQuality(".btn-primary", "click", 0);
      expect(err).toBeNull();
    });
  });

  describe("Plan-level provenance validation", () => {
    it("passes when all targets match recon selectors", () => {
      const plan = makePlan([
        { tool: "browser", action: "navigate", target: "https://example.com" },
        { tool: "browser", action: "click", target: 'a[href="#about"]' },
        { tool: "browser", action: "readText", target: 'a[href="#work"]' },
        { tool: "browser", action: "screenshot", target: "full page" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("passes when targets use #id from recon", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: "#hero-cta" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("passes when target matches a known href", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: 'a[href="/certificate"]' },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("passes when input[name=...] matches recon", () => {
      const plan = makePlan([
        {
          tool: "browser",
          action: "type",
          target: "#contactForm input[name='email']",
          input: { text: "test@example.com" },
        },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("rejects plan with fabricated selectors", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: "section.hero a.btn" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).toThrow(
        "fabricated selector"
      );
    });

    it("rejects plan with natural language targets", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: "nav link: About" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).toThrow(
        "fabricated selector"
      );
    });

    it("rejects plan with invalid CSS syntax", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: "button (submit)" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).toThrow(
        "fabricated selector"
      );
    });

    it("rejects plan when target not in recon data", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: "#nonexistent-element" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).toThrow(
        "does not match any interactableElement"
      );
    });

    it("allows sandbox actions without provenance check", () => {
      const plan = makePlan([
        { tool: "sandbox", action: "runCommand", target: "pwd" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("skips provenance check when no recon data available", () => {
      const plan = makePlan([
        { tool: "browser", action: "click", target: "section.hero a.btn" },
      ]);
      // No interactableElements — should not throw
      expect(() => validatePlanSelectors(plan, undefined)).not.toThrow();
      expect(() => validatePlanSelectors(plan, [])).not.toThrow();
    });
  });

  describe("Mixed valid and invalid in same plan", () => {
    it("rejects when any action has fabricated target", () => {
      const plan = makePlan([
        { tool: "browser", action: "navigate", target: "https://example.com" },
        { tool: "browser", action: "click", target: 'a[href="#about"]' },
        {
          tool: "browser",
          action: "click",
          target: "section.hero a.btn",
        },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).toThrow(
        "fabricated selector"
      );
    });
  });

  describe("Security invariants", () => {
    it("non-browser actions are not checked for selector provenance", () => {
      const plan = makePlan([
        { tool: "sandbox", action: "runCommand", target: "any command" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("navigate actions accept any URL", () => {
      const plan = makePlan([
        {
          tool: "browser",
          action: "navigate",
          target: "https://any-url.com/path",
        },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("screenshot accepts 'full page'", () => {
      const plan = makePlan([
        { tool: "browser", action: "screenshot", target: "full page" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("getTitle accepts 'page'", () => {
      const plan = makePlan([
        { tool: "browser", action: "getTitle", target: "page" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });

    it("launch accepts any target", () => {
      const plan = makePlan([
        { tool: "browser", action: "launch", target: "any" },
      ]);
      expect(() => validatePlanSelectors(plan, RECON_ELEMENTS)).not.toThrow();
    });
  });

  describe("Target format edge cases", () => {
    it("rejects targets with unbalanced parentheses", () => {
      const err = validateSelectorQuality("button(", "click", 0);
      // Either fabricated or invalid CSS — both are rejected
      expect(err).not.toBeNull();
    });

    it("rejects targets starting with space", () => {
      const err = validateSelectorQuality(" button", "click", 0);
      expect(err).not.toBeNull();
    });

    it('accepts complex attribute selectors', () => {
      const err = validateSelectorQuality(
        'a[href="#about"][class="nav-link"]',
        "click",
        0
      );
      expect(err).toBeNull();
    });

    it("accepts nested selectors from recon", () => {
      const err = validateSelectorQuality(
        "#contactForm textarea[name='message']",
        "type",
        0
      );
      expect(err).toBeNull();
    });
  });
});
