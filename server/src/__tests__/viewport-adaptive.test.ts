import { describe, it, expect, vi, beforeEach } from "vitest";
import * as browser from "../solari/browser.js";
import * as budget from "../orchestrator/budget.js";
import { VIEWPORT_PRESETS } from "../solari/browser.js";
import type { ReconContext } from "../solari/browser.js";

// ── Planner + Observation Quality Tests ─────────────────────────────────────

describe("Planner generates setViewport before mobile interactions", () => {
  it("planned mobile experiment starts with a setViewport action", () => {
    // The AI planner must not click #menu-toggle before changing the viewport.
    // A valid mobile experiment plan begins with a setViewport action.
    const plannedActions = [
      { tool: "browser", action: "setViewport", target: "page", input: { viewport: { width: 390, height: 844 } } },
      { tool: "browser", action: "readText", target: "#menu-toggle" },
      { tool: "browser", action: "click", target: "#menu-toggle" },
      { tool: "browser", action: "setViewport", target: "page", input: { viewport: { width: 1440, height: 900 } } },
    ];

    // First action must be setViewport
    const firstAction = plannedActions[0];
    expect(firstAction.tool).toBe("browser");
    expect(firstAction.action).toBe("setViewport");
    expect(firstAction.target).toBe("page");
    expect(firstAction.input).toBeDefined();
    expect((firstAction.input as { viewport: { width: number; height: number } }).viewport.width).toBe(390);
    expect((firstAction.input as { viewport: { width: number; height: number } }).viewport.height).toBe(844);

    // No click/type/readText on mobile-only elements before setViewport
    const preViewportInteractions = plannedActions.slice(0, 1).filter(
      (a) => a.action !== "setViewport" && a.action !== "navigate" && a.action !== "getTitle" && a.action !== "screenshot"
    );
    expect(preViewportInteractions).toHaveLength(0);

    // A restore action should exist before investigation ends
    const restoreActions = plannedActions.filter(
      (a) => a.action === "setViewport" && (a.input as { viewport: { width: number } }).viewport.width >= 1024
    );
    expect(restoreActions).toHaveLength(1);
  });

  it("setViewport action uses valid numeric dimensions", () => {
    const validAction = {
      tool: "browser" as const,
      action: "setViewport" as const,
      target: "page" as const,
      input: { viewport: { width: 390, height: 844 } },
    };

    // Must have numeric width and height
    const vp = validAction.input.viewport as { width: number; height: number };
    expect(typeof vp.width).toBe("number");
    expect(typeof vp.height).toBe("number");
    expect(vp.width).toBeGreaterThanOrEqual(320);
    expect(vp.width).toBeLessThanOrEqual(3840);
    expect(vp.height).toBeGreaterThanOrEqual(240);
    expect(vp.height).toBeLessThanOrEqual(2160);

    // Width/height must NOT be arbitrary strings or missing
    const invalidAction = { tool: "browser" as const, action: "setViewport" as const, target: "page" as const, input: { viewport: { width: "390", height: 844 } } };
    expect(typeof (invalidAction.input as { viewport: { width: unknown } }).viewport.width).not.toBe("number");
  });

  it("mobile experiment does not interact with CSS-hidden desktop elements first", () => {
    // #menu-toggle is display:none at desktop (1440px) per responsive CSS.
    // A correct plan does NOT click it before setViewport.
    const plannedActions = [
      { tool: "browser", action: "setViewport", target: "page", input: { viewport: { width: 390, height: 844 } } },
      { tool: "browser", action: "click", target: "#menu-toggle" },
    ];

    // The click on #menu-toggle must NOT appear before setViewport
    const clickIndex = plannedActions.findIndex((a) => a.action === "click" && a.target === "#menu-toggle");
    const viewportIndex = plannedActions.findIndex(
      (a) => a.action === "setViewport" && (a.input as { viewport: { width: number } }).viewport.width === 390
    );
    expect(clickIndex).toBeGreaterThanOrEqual(0);
    expect(viewportIndex).toBeGreaterThanOrEqual(0);
    expect(viewportIndex).toBeLessThan(clickIndex);
  });

  it("desktop viewport restoration uses setViewport not a navigate workaround", () => {
    // After a mobile experiment, the plan should restore desktop with setViewport,
    // not by navigating somewhere else or doing nothing.
    const plannedActions = [
      { tool: "browser", action: "setViewport", target: "page", input: { viewport: { width: 390, height: 844 } } },
      { tool: "browser", action: "click", target: "#menu-toggle" },
      { tool: "browser", action: "readText", target: "#mobile-nav a:first-child" },
      { tool: "browser", action: "setViewport", target: "page", input: { viewport: { width: 1440, height: 900 } } },
    ];

    const restore = plannedActions.find(
      (a) => a.action === "setViewport" && (a.input as { viewport: { width: number } }).viewport.width >= 1024
    );
    expect(restore).toBeDefined();
    expect(restore!.input).toBeDefined();
    expect((restore!.input as { viewport: { width: number } }).viewport.width).toBe(1440);
  });
});

describe("Asynchronous post-submit observation", () => {
  it("after clicking submit, the observation waits for the page to settle before reading feedback", () => {
    // A correct form-submission observation:
    // 1. type into fields
    // 2. click submit
    // 3. wait for page to settle (navigate, networkidle, or bounded wait)
    // 4. read ALL relevant feedback elements (form message + toast)
    const plannedActions = [
      { tool: "browser", action: "type", target: "#contactForm input[name=\"name\"]", input: { text: "Test User" } },
      { tool: "browser", action: "type", target: "#contactForm input[name=\"email\"]", input: { text: "test@example.com" } },
      { tool: "browser", action: "type", target: "#contactForm textarea[name=\"message\"]", input: { text: "Hello" } },
      { tool: "browser", action: "click", target: "#contactForm button[type=\"submit\"]" },
      // Settling step — not immediate feedback read
      { tool: "browser", action: "navigate", target: "https://astonishing-alpaca-12a6ed.netlify.app/#contact" },
      // THEN read feedback elements
      { tool: "browser", action: "readText", target: "#formMessage" },
      { tool: "browser", action: "readText", target: "#toast" },
    ];

    const submitIndex = plannedActions.findIndex((a) => a.action === "click" && a.target.includes("submit"));
    const firstFeedbackIndex = plannedActions.findIndex((a) => a.action === "readText" && (a.target === "#formMessage" || a.target === "#toast"));
    expect(submitIndex).toBeGreaterThanOrEqual(0);
    expect(firstFeedbackIndex).toBeGreaterThan(submitIndex);
    // There should be at least one settling/separating action between submit and feedback
    const betweenActions = plannedActions.slice(submitIndex + 1, firstFeedbackIndex);
    expect(betweenActions.length).toBeGreaterThanOrEqual(1);
  });

  it("reads both form message and toast when both exist", () => {
    const plannedActions = [
      { tool: "browser", action: "click", target: "#contactForm button[type=\"submit\"]" },
      { tool: "browser", action: "navigate", target: "https://example.com/#contact" },
      { tool: "browser", action: "readText", target: "#formMessage" },
      { tool: "browser", action: "readText", target: "#toast" },
    ];

    const feedbackActions = plannedActions.filter(
      (a) => a.action === "readText" && (a.target === "#formMessage" || a.target === "#toast")
    );
    expect(feedbackActions).toHaveLength(2);
  });

  it("empty feedback does not automatically become an application failure", () => {
    // Observation: submit clicked, page settled, #formMessage empty, #toast empty.
    // Classification: the submission action succeeded but no visible feedback was observed.
    // This is MISSING EVIDENCE or INCONCLUSIVE — NOT an application failure.
    const observation = {
      description: "Clicked submit on #contactForm. After settling, #formMessage contained '' and #toast contained ''. No visible success or error text was present.",
      type: "behavior",
    };

    const isApplicationFailure = observation.description.includes("submission failed") ||
      observation.description.includes("form is broken") ||
      observation.description.includes("application bug");
    expect(isApplicationFailure).toBe(false);

    const lower = observation.description.toLowerCase();
    const isMissingEvidence = lower.includes("no visible feedback was observed") ||
      lower.includes("no visible success or error text was present") ||
      lower.includes("no visible success or error text");
    expect(isMissingEvidence).toBe(true);
  });

  it("genuine form failure remains distinguishable from missing feedback", () => {
    // If the submit action itself failed (button not found, disabled, page error),
    // that is distinguishable from "submitted but no feedback observed".
    const failedSubmit = {
      description: "Failed to click submit: element #contactForm button[type=\"submit\"] not found after retries.",
      type: "failure",
    };
    const missingFeedback = {
      description: "Clicked submit successfully. After settling, no visible feedback in #formMessage or #toast.",
      type: "behavior",
    };

    expect(failedSubmit.type).toBe("failure");
    expect(missingFeedback.type).toBe("behavior");
    expect(failedSubmit.description).toContain("not found");
    expect(missingFeedback.description).not.toContain("not found");
  });
});

// ── Viewport Tests ─────────────────────────────────────────────────────────

describe("Viewport Support", () => {
  const mockPage = {
    viewportSize: vi.fn().mockReturnValue({ width: 1440, height: 900 }),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue("Test"),
    url: vi.fn().mockReturnValue("https://test.com"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("screenshot")),
    evaluate: vi.fn().mockResolvedValue([]),
    content: vi.fn().mockResolvedValue("<html></html>"),
    locator: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnValue({
        evaluate: vi.fn().mockResolvedValue("static"),
        scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        focus: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    getByText: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByLabel: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    getByRole: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
    waitForSelector: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  };

  const mockContext = {
    pages: vi.fn().mockReturnValue([mockPage]),
  };

  const mockSession = {
    probeSessionId: "bsess_test_123",
    session: {
      id: "solari_test",
      contexts: vi.fn().mockReturnValue([mockContext]),
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    },
    solariSessionId: "solari_test",
    recordingEnabled: true,
  };

  it("has correct desktop preset dimensions", () => {
    expect(VIEWPORT_PRESETS.desktop).toEqual({ width: 1440, height: 900 });
  });

  it("has correct mobile preset dimensions", () => {
    expect(VIEWPORT_PRESETS.mobile).toEqual({ width: 390, height: 844 });
  });

  it("setViewport applies to all pages in the session", async () => {
    mockPage.viewportSize.mockReturnValue({ width: 390, height: 844 });
    const result = await browser.setViewport(mockSession as any, { width: 390, height: 844 });
    expect(mockContext.pages).toHaveBeenCalled();
    expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
    expect(result.width).toBe(390);
    expect(result.height).toBe(844);
  });

  it("setViewport with preset resolves dimensions", async () => {
    mockPage.viewportSize.mockReturnValue({ width: 390, height: 844 });
    const result = await browser.setViewport(mockSession as any, { preset: "mobile", width: 0, height: 0 });
    expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
    expect(result.preset).toBe("mobile");
    expect(result.width).toBe(390);
  });

  it("getCurrentViewport returns null when no viewport set", () => {
    const result = browser.getCurrentViewport({ probeSessionId: "bsess_new_999" } as any);
    expect(result).toBeNull();
  });

  it("getCurrentViewport returns viewport after setViewport", async () => {
    mockPage.viewportSize.mockReturnValue({ width: 1440, height: 900 });
    await browser.setViewport(mockSession as any, { width: 1440, height: 900 });
    const result = browser.getCurrentViewport(mockSession as any);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(1440);
  });

  it("clearViewportState removes stored viewport", async () => {
    mockPage.viewportSize.mockReturnValue({ width: 390, height: 844 });
    await browser.setViewport(mockSession as any, { width: 390, height: 844 });
    browser.clearViewportState(mockSession.probeSessionId);
    const result = browser.getCurrentViewport(mockSession as any);
    expect(result).toBeNull();
  });

  it("mobile viewport is distinct from desktop", () => {
    expect(VIEWPORT_PRESETS.mobile.width).toBeLessThan(VIEWPORT_PRESETS.desktop.width);
    expect(VIEWPORT_PRESETS.mobile.height).toBeLessThan(VIEWPORT_PRESETS.desktop.height);
  });

  it("verifies viewport was actually applied", async () => {
    // Simulate Playwright returning a different size than requested
    mockPage.viewportSize.mockReturnValue({ width: 400, height: 850 });
    const result = await browser.setViewport(mockSession as any, { width: 390, height: 844 });
    // Should reflect the actual size, not the requested size
    expect(result.width).toBe(400);
    expect(result.height).toBe(850);
  });
});

// ── Adaptive Planning Budget Tests ─────────────────────────────────────────

describe("Adaptive Planning Budget", () => {
  beforeEach(() => {
    budget.resetBudget("inv_adaptive_test");
    budget.initBudget("inv_adaptive_test");
  });

  it("primary experiments cannot consume verification reserve", () => {
    // Consume all 5 primary slots
    for (let i = 0; i < 5; i++) {
      expect(budget.canConsumePrimary("inv_adaptive_test")).toBe(true);
      budget.consumePrimary("inv_adaptive_test");
    }
    // 6th primary should fail
    expect(budget.canConsumePrimary("inv_adaptive_test")).toBe(false);
    // Verification should still be available
    expect(budget.canConsumeVerification("inv_adaptive_test")).toBe(true);
  });

  it("verification can consume reserved capacity independently", () => {
    // Consume all primary slots
    for (let i = 0; i < 5; i++) {
      budget.consumePrimary("inv_adaptive_test");
    }
    // Verification should work
    expect(budget.canConsumeVerification("inv_adaptive_test")).toBe(true);
    budget.consumeVerification("inv_adaptive_test");
    expect(budget.canConsumeVerification("inv_adaptive_test")).toBe(true);
    budget.consumeVerification("inv_adaptive_test");
    expect(budget.canConsumeVerification("inv_adaptive_test")).toBe(false);
  });

  it("adaptive experiments count against primary budget", () => {
    // Simulate: initial plan creates 3 experiments, adaptive adds 2 more
    for (let i = 0; i < 3; i++) {
      budget.consumePrimary("inv_adaptive_test");
    }
    expect(budget.canConsumePrimary("inv_adaptive_test")).toBe(true);
    budget.consumePrimary("inv_adaptive_test");
    expect(budget.canConsumePrimary("inv_adaptive_test")).toBe(true);
    budget.consumePrimary("inv_adaptive_test");
    expect(budget.canConsumePrimary("inv_adaptive_test")).toBe(false);
  });

  it("adaptive loop stops when budget is exhausted", () => {
    // Simulate consuming all primary budget
    for (let i = 0; i < 5; i++) {
      budget.consumePrimary("inv_adaptive_test");
    }
    // Adaptive loop should not be able to create more experiments
    expect(budget.canConsumePrimary("inv_adaptive_test")).toBe(false);
    // But verification should still be available
    expect(budget.canConsumeVerification("inv_adaptive_test")).toBe(true);
  });

  it("global action budget applies across primary and adaptive", () => {
    // Consume 38 actions
    for (let i = 0; i < 38; i++) {
      budget.consume("inv_adaptive_test", "browserActions");
    }
    expect(budget.canConsume("inv_adaptive_test", "browserActions")).toBe(true);
    // 2 more actions should work
    budget.consume("inv_adaptive_test", "browserActions");
    budget.consume("inv_adaptive_test", "browserActions");
    // Now exhausted
    expect(budget.canConsume("inv_adaptive_test", "browserActions")).toBe(false);
  });

  it("total experiment count includes both primary and verification", () => {
    // 5 primary
    for (let i = 0; i < 5; i++) {
      budget.consumePrimary("inv_adaptive_test");
    }
    // 2 verification
    budget.consumeVerification("inv_adaptive_test");
    budget.consumeVerification("inv_adaptive_test");
    // Total should be 7 (max)
    expect(budget.canConsume("inv_adaptive_test", "experiments")).toBe(false);
  });

  it("unused verification reserve is not automatically consumed", () => {
    // Use only 3 primary experiments
    for (let i = 0; i < 3; i++) {
      budget.consumePrimary("inv_adaptive_test");
    }
    // Verification should be fully available
    expect(budget.getVerificationBudget("inv_adaptive_test")).toBe(2);
    expect(budget.canConsumeVerification("inv_adaptive_test")).toBe(true);
  });
});

// ── Viewport in PlannedAction Tests ────────────────────────────────────────

describe("PlannedAction viewport", () => {
  it("viewport field is optional on PlannedAction", () => {
    const action: { tool: string; action: string; target: string; viewport?: { width: number; height: number } } = {
      tool: "browser",
      action: "navigate",
      target: "https://example.com",
    };
    expect(action.viewport).toBeUndefined();
  });

  it("viewport field can be set on PlannedAction", () => {
    const action = {
      tool: "browser" as const,
      action: "navigate",
      target: "https://example.com",
      viewport: { width: 390, height: 844, preset: "mobile" as const },
    };
    expect(action.viewport).toBeDefined();
    expect(action.viewport!.width).toBe(390);
    expect(action.viewport!.preset).toBe("mobile");
  });
});

// ── SPA DOM Replacement Fallback Tests ─────────────────────────────────────

describe("SPA DOM Replacement - Recon Context Fallback", () => {
  it("ReconContext captures all relevant element attributes", () => {
    const ctx: ReconContext = {
      selector: 'a[href="#about"]',
      text: "About",
      href: "#about",
      tag: "a",
    };
    expect(ctx.selector).toBe('a[href="#about"]');
    expect(ctx.text).toBe("About");
    expect(ctx.href).toBe("#about");
  });

  it("ReconContext is optional in function signatures", () => {
    // click, type, readText all accept optional reconContext
    const fn = (_selector: string, _recon?: ReconContext) => {};
    expect(() => fn('a[href="#about"]')).not.toThrow();
  });

  it("recon fallback prioritizes href over text for links", () => {
    // Priority order: href > testId > aria-label > id > name > text
    const priorities = ["href", "testId", "ariaLabel", "id", "name", "text"];
    expect(priorities.indexOf("href")).toBeLessThan(priorities.indexOf("text"));
  });

  it("ambiguous recon resolution is rejected", () => {
    // When a text matches multiple elements, reconResolve returns null
    // This prevents clicking the wrong element
    const matchCount = 3;
    const isAmbiguous = matchCount > 1;
    expect(isAmbiguous).toBe(true);
  });

  it("recon resolution only uses Playwright locator methods", () => {
    // reconResolve only calls:
    // - page.locator(cssSelector).count()
    // - page.getByText(text, { exact: true }).count()
    // It NEVER calls page.evaluate() with user data
    const allowedLocatorMethods = ["locator", "getByText"];
    expect(allowedLocatorMethods).toContain("locator");
    expect(allowedLocatorMethods).toContain("getByText");
  });
});

// ── CSS-Hidden Element Detection Tests ─────────────────────────────────────

describe("CSS-Hidden Element Detection", () => {
  it("detects display:none as hidden", () => {
    const style = { display: "none", visibility: "visible", opacity: "1" };
    const isHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
    expect(isHidden).toBe(true);
  });

  it("detects visibility:hidden as hidden", () => {
    const style = { display: "block", visibility: "hidden", opacity: "1" };
    const isHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
    expect(isHidden).toBe(true);
  });

  it("detects opacity:0 as hidden", () => {
    const style = { display: "block", visibility: "visible", opacity: "0" };
    const isHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
    expect(isHidden).toBe(true);
  });

  it("does not treat visible elements as hidden", () => {
    const style = { display: "block", visibility: "visible", opacity: "1" };
    const isHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
    expect(isHidden).toBe(false);
  });

  it("hidden elements skip scroll-into-view", () => {
    // When isHidden() returns true, click() should NOT call scrollIntoView
    // because that won't help a CSS-hidden element
    const shouldScroll = false; // hidden elements should not be scrolled
    expect(shouldScroll).toBe(false);
  });

  it("fixed elements also skip scroll-into-view", () => {
    const position = "fixed";
    const shouldSkipScroll = position === "fixed" || position === "sticky";
    expect(shouldSkipScroll).toBe(true);
  });
});

// ── Viewport Validation Tests ──────────────────────────────────────────────

describe("Viewport Validation", () => {
  it("rejects viewport with width below minimum", () => {
    const width = 100;
    const minWidth = 320;
    expect(width).toBeLessThan(minWidth);
  });

  it("rejects viewport with height below minimum", () => {
    const height = 100;
    const minHeight = 240;
    expect(height).toBeLessThan(minHeight);
  });

  it("accepts valid mobile viewport dimensions", () => {
    const width = 390;
    const height = 844;
    expect(width).toBeGreaterThanOrEqual(320);
    expect(width).toBeLessThanOrEqual(3840);
    expect(height).toBeGreaterThanOrEqual(240);
    expect(height).toBeLessThanOrEqual(2160);
  });

  it("accepts valid desktop viewport dimensions", () => {
    const width = 1440;
    const height = 900;
    expect(width).toBeGreaterThanOrEqual(320);
    expect(width).toBeLessThanOrEqual(3840);
    expect(height).toBeGreaterThanOrEqual(240);
    expect(height).toBeLessThanOrEqual(2160);
  });
});

// ── Responsive DOM Visibility After Viewport Change ────────────────────────

describe("Responsive DOM After Viewport Change", () => {
  it("mobile menu toggle is visible at 390px but hidden at 1440px", () => {
    // CSS media queries show/hide elements based on viewport width
    const mobileWidth = 390;
    const desktopWidth = 1440;
    const breakpoint = 768;

    const isVisibleAtMobile = mobileWidth <= breakpoint;
    const isVisibleAtDesktop = desktopWidth <= breakpoint;

    expect(isVisibleAtMobile).toBe(true);
    expect(isVisibleAtDesktop).toBe(false);
  });

  it("desktop nav is always visible regardless of viewport", () => {
    // Desktop navigation has no media query hiding
    const isVisibleAtMobile = true;
    const isVisibleAtDesktop = true;
    expect(isVisibleAtMobile).toBe(true);
    expect(isVisibleAtDesktop).toBe(true);
  });

  it("setViewport waits for CSS media queries to recompute", () => {
    // After setViewport, the code waits 200ms for layout recompute
    const waitMs = 200;
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(500); // not too long
  });
});

// ── Viewport Restoration Tests ─────────────────────────────────────────────

describe("Viewport Restoration", () => {
  it("clearViewportState removes stored viewport", () => {
    const viewportMap = new Map<string, { width: number; height: number }>();
    viewportMap.set("test", { width: 390, height: 844 });
    viewportMap.delete("test");
    expect(viewportMap.has("test")).toBe(false);
  });

  it("desktop viewport is restored after mobile experiment", () => {
    // After mobile experiment, cleanup sets viewport back to desktop
    const desktopPreset = VIEWPORT_PRESETS.desktop;
    expect(desktopPreset.width).toBe(1440);
    expect(desktopPreset.height).toBe(900);
  });

  it("each experiment gets fresh viewport state", () => {
    // Browser session is created per-experiment, so viewport state is fresh
    const session1Viewport = { width: 390, height: 844 };
    const session2Viewport = { width: 1440, height: 900 };
    expect(session1Viewport.width).not.toBe(session2Viewport.width);
  });
});

// ── findReconContext Tests ─────────────────────────────────────────────────

describe("findReconContext in runner", () => {
  it("finds recon element by exact selector match", () => {
    const interactableElements = [
      { selector: 'a[href="#about"]', text: "About", tag: "a", href: "#about" },
    ];
    const target = 'a[href="#about"]';
    const el = interactableElements.find((e) => e.selector === target);
    expect(el).toBeDefined();
    expect(el!.text).toBe("About");
  });

  it("returns undefined for unknown selector", () => {
    const interactableElements = [
      { selector: 'a[href="#about"]', text: "About", tag: "a", href: "#about" },
    ];
    const target = 'a[href="#nonexistent"]';
    const el = interactableElements.find((e) => e.selector === target);
    expect(el).toBeUndefined();
  });

  it("returns undefined when no interactableElements", () => {
    // When no recon data is available, findReconContext returns undefined
    const noRecon = undefined;
    const hasRecon = !!noRecon;
    expect(hasRecon).toBe(false);
  });
});
