/**
 * Real-DOM unit tests for the shared interactable-element extraction script
 * (src/recon/extract-elements.ts) using jsdom.
 *
 * These tests pin the browser-side recon contract that selector safety
 * depends on: every selector the extraction emits must actually match the
 * element it was generated for in the live DOM. A selector that matches 0
 * elements poisons the whole pipeline — the planner proposes it, the browser
 * adapter cannot resolve it, and state-changing actions fail.
 *
 * Regression background: the structural-path generator appended the
 * ancestor's :nth-of-type index to the immutable tail segment, producing
 * selectors like "div > p > button:nth-of-type(2)" for Probe's own SPA —
 * which matched 0 elements and broke the "Create account" click that
 * post-action recon depends on (verified live against
 * https://probe-challenge.vercel.app/ — click failed: Element not found).
 */
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { INTERACTABLE_EXTRACTION_SCRIPT } from "../recon/extract-elements.js";
import type { InteractableElement } from "@probe/shared";

/** Evaluate the extraction script inside a jsdom window and return elements. */
function extract(html: string): InteractableElement[] {
  const dom = new JSDOM(html);
  const run = new dom.window.Function(
    "const document = this.document; const CSS = this.CSS; return (" + INTERACTABLE_EXTRACTION_SCRIPT + ");"
  );
  const result = run.call(dom.window);
  return Array.isArray(result) ? result : [];
}

/** Assert every emitted selector resolves to exactly one element in the same DOM. */
function expectSelectorsToResolve(html: string, elements: InteractableElement[]): void {
  const dom = new JSDOM(html);
  for (const el of elements) {
    const count = dom.window.document.querySelectorAll(el.selector).length;
    if (count !== 1) {
      throw new Error(
        `selector "${el.selector}" matches ${count} elements (expected 1) — text: "${el.text}"`
      );
    }
  }
}

describe("INTERACTABLE_EXTRACTION_SCRIPT (real-DOM contract)", () => {
  it("generates structural selectors whose nth-of-type segments match the real DOM", () => {
    // Mirrors Probe's deployed SPA: two paragraphs under a div; the button
    // lives in the SECOND paragraph. The old generator produced
    // "div > p > button:nth-of-type(2)" (0 matches) for this shape.
    const html = `<div id="root"><div class="app"><main><div class="card">
      <p>note text</p>
      <p>Don't have an account? <button>Create account</button></p>
    </div></main></div></div>`;
    const elements = extract(html);
    const button = elements.find((e) => e.text === "Create account");
    expect(button).toBeDefined();
    expect(button!.selector).toBe("div > p:nth-of-type(2) > button");
    expectSelectorsToResolve(html, elements);
  });

  it("prefers id selectors and emits only selectors that resolve to one element", () => {
    const html = `<div id="root">
      <form><input id="auth-email" type="email" placeholder="you@example.com"><input id="auth-password" type="password"><button type="submit">Sign in</button></form>
      <p><button>Create account</button></p>
    </div>`;
    const elements = extract(html);
    expect(elements.find((e) => e.selector === "#auth-email")).toBeDefined();
    expect(elements.find((e) => e.selector === "#auth-password")).toBeDefined();
    expect(elements.find((e) => e.text === "Create account")).toBeDefined();
    expectSelectorsToResolve(html, elements);
  });

  it("indexes ancestor segments correctly when several same-tag siblings exist", () => {
    const html = `<div id="root"><div>
      <form><div><input name="alpha"></div><div><input name="beta"></div><div><button>Submit</button></div></form>
    </div></div>`;
    const elements = extract(html);
    const submit = elements.find((e) => e.text === "Submit");
    expect(submit).toBeDefined();
    // The button sits in the 3rd div → that segment must carry :nth-of-type(3)
    expect(submit!.selector).toBe("form > div:nth-of-type(3) > button");
    expectSelectorsToResolve(html, elements);
  });

  it("extracts links with href selectors without duplicate selectors", () => {
    const html = `<div id="root">
      <nav><a href="/signup">Sign up</a><a href="/login">Log in</a></nav>
    </div>`;
    const elements = extract(html);
    const hrefs = elements
      .filter((e) => e.href)
      .map((e) => e.selector.replace(/\\([#/.\)])/g, "$1")); // unescape like the adapter's normalizeSelector
    expect(hrefs).toContain('a[href="/signup"]');
    expect(hrefs).toContain('a[href="/login"]');
    const all = elements.map((e) => e.selector);
    expect(new Set(all).size).toBe(all.length);
    expectSelectorsToResolve(html, elements);
  });

  it("caps results at 50 elements", () => {
    const buttons = Array.from(
      { length: 60 },
      (_, i) => `<button data-testid="b${i}">b${i}</button>`
    ).join("");
    const html = `<div id="root">${buttons}</div>`;
    const elements = extract(html);
    expect(elements.length).toBeLessThanOrEqual(50);
  });
});
