/**
 * Solari browser adapter.
 *
 * Wraps Playwright-compatible browser operations through Solari.
 * Handles session lifecycle, recording, and cleanup.
 *
 * Critical lifecycle rules:
 * - browserSession.close() releases the session and the browser
 * - solari.close() is required on process exit or the loopback proxy hangs
 * - recording must be enabled at session creation
 * - timeoutMs is a rolling idle window, not a hard deadline
 *
 * The Solari SDK's BrowserSession class wraps the patchright Browser.
 * We store the SDK session and access the underlying browser via .raw.
 * A default page is opened immediately for convenience.
 */
import { BrowserSession as SolariBrowserSession } from "@solarisdk/browser";
import { getBrowserSolari, trackBrowserSession, untrackBrowserSession } from "./client.js";
import { store } from "../store/index.js";
import { isPubliclyRoutableHost } from "../security/url-validation.js";

// ── Connection-time network policy (DNS-rebinding / SSRF enforcement) ──────

/**
 * Install a request-level network policy on a browser context.
 *
 * URL-string validation at the dispatch boundary (runner → validateApplicationUrl)
 * cannot stop DNS rebinding: a hostname can resolve to a public IP during
 * validation and to a private/internal IP when the browser actually connects.
 * It also cannot see redirects, iframe navigations, or page-initiated
 * subresource requests.
 *
 * This route runs INSIDE the browser for EVERY request the page makes —
 * navigations, redirects (each redirect hop re-issues a request), iframes,
 * and subresources — and resolves the request's host through the same
 * resolver the browser would use. Any request whose resolved address is
 * non-public is aborted before a connection is attempted.
 *
 * Non-HTTP schemes (data:, blob:, about:) bypass DNS entirely and are
 * allowed through here; scheme policy is enforced at the navigate dispatch.
 */
const networkPolicyErrorHandler = (err: unknown): void => {
  console.error("[network-policy] resolver failure:", err instanceof Error ? err.message : err);
};

async function installNetworkPolicy(context: {
  route: (pattern: string, handler: (route: { abort: () => Promise<void>; continue: () => Promise<void> }, request: { url: () => string }) => Promise<void>) => Promise<void>;
}): Promise<void> {
  try {
    await context.route("**/*", async (route, request) => {
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        await route.abort(); // unparseable request URL — never let it through
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        await route.continue(); // non-network scheme; dispatch-level policy covers these
        return;
      }
      try {
        const verdict = await isPubliclyRoutableHost(url.hostname);
        if (!verdict.ok) {
          console.warn(`[network-policy] blocked request to non-public host: ${url.hostname}`);
          await route.abort();
          return;
        }
        await route.continue();
      } catch (err) {
        // Resolver failure must fail CLOSED, not open.
        networkPolicyErrorHandler(err);
        await route.abort();
      }
    });
  } catch (err) {
    // If route installation itself fails, refuse to hand back an unprotected session.
    throw new Error(`Failed to install browser network policy: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Probe's representation of an active browser session.
 * Wraps the Solari SDK's BrowserSession with Probe-specific tracking.
 */
export interface ProbeBrowserSession {
  /** Probe's internal session ID for tracking. */
  probeSessionId: string;
  /** The Solari SDK session. All browser ops go through this. */
  session: SolariBrowserSession;
  /** The Solari-assigned session ID (same as session.id). */
  solariSessionId: string;
  /** Whether recording was enabled at creation. */
  recordingEnabled: boolean;
}

/**
 * Upper bound on one browser-session launch attempt. The SDK's HTTP layer
 * already retries transient request failures internally (2 attempts × 90s
 * worst case); without an outer bound, a degraded gateway could consume an
 * entire investigation runtime across the per-experiment launch sequence
 * before a single action executed (observed as investigations failing with
 * "Runtime budget expired" while still in Preparing experiments, 0/4 run).
 */
const LAUNCH_TIMEOUT_MS = 45_000;

/** Launch with retries and a probe — bounded, so failures surface fast. */
async function launchBounded(
  solari: ReturnType<typeof getBrowserSolari>,
  opts?: { recording?: boolean; stealth?: boolean; proxy?: string }
) {
  const launch = solari.launch({
    recording: opts?.recording ?? true,
    stealth: opts?.stealth,
    proxy: opts?.proxy,
    retries: 1, // one re-launch attempt after the first failure (SDK default 0)
    probe: true,
    probeTimeoutMs: 5_000,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Solari browser session launch exceeded ${LAUNCH_TIMEOUT_MS}ms`)), LAUNCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([launch, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a new browser session with recording enabled.
 *
 * Opens a default page immediately so the caller can start navigating.
 */
export async function createBrowserSession(
  investigationId: string,
  opts?: { recording?: boolean; stealth?: boolean; proxy?: string }
): Promise<ProbeBrowserSession> {
  const solari = getBrowserSolari();

  const session = await launchBounded(solari, opts);

  const probeSessionId = `bsess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ── Connection-time SSRF/DNS-rebinding enforcement ──────────────────────
  // Install on every existing context AND make every future context install
  // it too, so no network path can bypass the policy.
  //
  // SDK interface (verified against @solarisdk/browser 0.1.x .d.ts):
  //   - BrowserSession facade exposes contexts(): BrowserContext[] — the
  //     contexts that exist right now (sessions ship with a default context).
  //   - The facade does NOT expose an event emitter. Future contexts (e.g.
  //     from newPage(), which opens a fresh context) are covered through the
  //     documented escape hatch session.raw — the underlying patchright
  //     Browser, which emits "context" events.
  //   - Older/raw sessions expose contexts()+on() on the session object
  //     itself; that shape is still accepted for compatibility.
  // Runtime guards keep this fail-closed: if neither interface is available,
  // session creation FAILS — it never returns an unprotected browser.
  type PolicyContext = { route: Parameters<typeof installNetworkPolicy>[0]["route"] };
  type ContextEmitter = {
    on(event: string, handler: (ctx: PolicyContext) => void): void;
  };

  const rawShape = session as unknown as {
    raw?: unknown;
    session?: unknown;
  };

  // Contexts collection: facade first, then legacy raw-session shape.
  const contextsSource: (() => PolicyContext[]) | null =
    typeof session.contexts === "function"
      ? () => session.contexts() as unknown as PolicyContext[]
      : rawShape.session !== null && typeof rawShape.session === "object" &&
          typeof (rawShape.session as { contexts?: unknown }).contexts === "function"
        ? () => (rawShape.session as { contexts(): PolicyContext[] }).contexts()
        : null;

  // Future-context emitter: prefer the documented raw browser; fall back to
  // a legacy session object that emits context events itself.
  const emitter: ContextEmitter | null =
    rawShape.raw !== null && typeof rawShape.raw === "object" &&
      typeof (rawShape.raw as { on?: unknown }).on === "function"
      ? (rawShape.raw as ContextEmitter)
      : rawShape.session !== null && typeof rawShape.session === "object" &&
          typeof (rawShape.session as { on?: unknown }).on === "function"
        ? (rawShape.session as ContextEmitter)
        : null;

  if (contextsSource === null || emitter === null) {
    // Fail closed: refuse to hand back a browser the policy cannot cover —
    // both for the contexts that exist now and for any created later.
    throw new Error(
      "Solari browser session does not expose the interfaces required to install the " +
      "mandatory network policy (contexts()/raw context events). Refusing to run with " +
      "an unprotected browser — check the @solarisdk/browser version against Probe's " +
      "supported interface."
    );
  }

  for (const ctx of contextsSource()) {
    await installNetworkPolicy(ctx);
  }
  emitter.on("context", (ctx) => {
    void installNetworkPolicy(ctx).catch(networkPolicyErrorHandler);
  });

  // Track in store and leak-detection set
  trackBrowserSession(probeSessionId);
  store.createSession({
    id: probeSessionId,
    investigationId,
    type: "browser",
    externalSessionId: session.id,
    status: "active",
    createdAt: new Date().toISOString(),
    releasedAt: null,
  });

  return {
    probeSessionId,
    session,
    solariSessionId: session.id,
    recordingEnabled: opts?.recording ?? true,
  };
}

/**
 * Get the default page from the browser session.
 * The SDK creates a default context on launch; we grab its first page.
 * If no page exists yet, open one.
 */
async function getDefaultPage(session: ProbeBrowserSession): Promise<ReturnType<SolariBrowserSession["newPage"]>> {
  const contexts = session.session.contexts();
  if (contexts.length > 0 && contexts[0].pages().length > 0) {
    return contexts[0].pages()[0];
  }
  return session.session.newPage();
}

/**
 * Navigate to a URL.
 * Detects downloads and returns them as a distinct result.
 */
export async function navigate(
  session: ProbeBrowserSession,
  url: string
): Promise<{ title: string; url: string; downloaded?: boolean; downloadUrl?: string }> {
  const page = await getDefaultPage(session);

  // Listen for download events
  let downloadTriggered = false;
  let downloadUrl = "";
  const downloadHandler = (download: { url: () => string }) => {
    downloadTriggered = true;
    downloadUrl = download.url();
  };
  page.on("download", downloadHandler);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // If a download was triggered, that's not a navigation failure
    if (downloadTriggered) {
      return { title: "", url, downloaded: true, downloadUrl };
    }
    // Re-throw if it's a real navigation failure
    throw error;
  } finally {
    page.removeListener("download", downloadHandler);
  }

  // Check if download was triggered during/after navigation
  if (downloadTriggered) {
    return { title: "", url, downloaded: true, downloadUrl };
  }

  // Wait for SPA content to settle after navigation
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  } catch { /* best effort — not all pages reach networkidle */ }

  return {
    title: await page.title(),
    url: page.url(),
  };
}

/**
 * Verify that a page matches expected identity signals.
 * Does NOT depend on h1/h2/h3 existence.
 *
 * Checks (in order of reliability):
 * 1. URL contains expected path fragment
 * 2. Page title matches
 * 3. Visible text matches
 * 4. Any of the provided CSS selectors match elements on the page
 *
 * Returns true if at least one check passes.
 */
export async function verifyPage(
  session: ProbeBrowserSession,
  expected: {
    urlContains?: string;
    titleContains?: string;
    textContains?: string;
    selectorExists?: string;
  }
): Promise<{ matched: boolean; details: string }> {
  const page = await getDefaultPage(session);
  const checks: string[] = [];

  if (expected.urlContains) {
    const currentUrl = page.url();
    const match = currentUrl.includes(expected.urlContains);
    checks.push(`URL contains "${expected.urlContains}": ${match ? "YES" : "NO"} (actual: ${currentUrl})`);
    if (match) return { matched: true, details: checks.join("; ") };
  }

  if (expected.titleContains) {
    const title = await page.title();
    const match = title.toLowerCase().includes(expected.titleContains.toLowerCase());
    checks.push(`Title contains "${expected.titleContains}": ${match ? "YES" : "NO"} (actual: ${title})`);
    if (match) return { matched: true, details: checks.join("; ") };
  }

  if (expected.textContains) {
    try {
      const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
      const match = bodyText.toLowerCase().includes(expected.textContains.toLowerCase());
      checks.push(`Text contains "${expected.textContains}": ${match ? "YES" : "NO"}`);
      if (match) return { matched: true, details: checks.join("; ") };
    } catch {
      checks.push(`Text check failed (timeout)`);
    }
  }

  if (expected.selectorExists) {
    try {
      const count = await page.locator(expected.selectorExists).count();
      const match = count > 0;
      checks.push(`Selector "${expected.selectorExists}" exists: ${match ? "YES" : "NO"} (count: ${count})`);
      if (match) return { matched: true, details: checks.join("; ") };
    } catch {
      checks.push(`Selector check failed (invalid selector)`);
    }
  }

  return { matched: false, details: checks.join("; ") || "No checks performed" };
}

/**
 * Get the page title.
 */
export async function getTitle(session: ProbeBrowserSession): Promise<string> {
  const page = await getDefaultPage(session);
  return page.title();
}

/**
 * Viewport preset configuration.
 */
export type ViewportPreset = "desktop" | "mobile";

export interface Viewport {
  preset?: ViewportPreset;
  width: number;
  height: number;
}

/** Well-known viewport presets */
export const VIEWPORT_PRESETS: Record<ViewportPreset, Viewport> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/** Current viewport state per session */
const viewportStates = new Map<string, Viewport>();

/** Reasonable viewport dimension bounds. */
const VIEWPORT_MIN_WIDTH = 320;
const VIEWPORT_MAX_WIDTH = 3840;
const VIEWPORT_MIN_HEIGHT = 240;
const VIEWPORT_MAX_HEIGHT = 2160;

/**
 * Set the browser viewport size.
 * Applies to all existing and new pages in the session.
 * Verifies the viewport was actually applied.
 *
 * @returns The viewport that was actually applied.
 * @throws If dimensions are outside reasonable bounds.
 */
export async function setViewport(
  session: ProbeBrowserSession,
  viewport: Viewport
): Promise<Viewport> {
  // Resolve presets to concrete dimensions
  const resolved = viewport.preset
    ? { ...VIEWPORT_PRESETS[viewport.preset], preset: viewport.preset }
    : viewport;

  // Validate dimensions are within reasonable bounds
  if (
    resolved.width < VIEWPORT_MIN_WIDTH ||
    resolved.width > VIEWPORT_MAX_WIDTH ||
    resolved.height < VIEWPORT_MIN_HEIGHT ||
    resolved.height > VIEWPORT_MAX_HEIGHT
  ) {
    throw new Error(
      `Viewport dimensions out of bounds: ${resolved.width}x${resolved.height}. ` +
      `Must be ${VIEWPORT_MIN_WIDTH}-${VIEWPORT_MAX_WIDTH} x ${VIEWPORT_MIN_HEIGHT}-${VIEWPORT_MAX_HEIGHT}.`
    );
  }

  const page = await getDefaultPage(session);

  // Apply to all existing pages
  const contexts = session.session.contexts();
  for (const context of contexts) {
    for (const p of context.pages()) {
      await p.setViewportSize({ width: resolved.width, height: resolved.height });
    }
  }

  // Wait briefly for CSS media queries and layout to recompute
  await new Promise((r) => setTimeout(r, 200));

  // Verify the viewport was applied
  const actualSize = page.viewportSize();
  const verified: Viewport = {
    ...resolved,
    width: actualSize?.width ?? resolved.width,
    height: actualSize?.height ?? resolved.height,
  };

  viewportStates.set(session.probeSessionId, verified);
  return verified;
}

/**
 * Get the current viewport for a session.
 * Returns null if no viewport has been set.
 */
export function getCurrentViewport(session: ProbeBrowserSession): Viewport | null {
  return viewportStates.get(session.probeSessionId) ?? null;
}

/**
 * Clean up viewport state when a session is closed.
 */
export function clearViewportState(probeSessionId: string): void {
  viewportStates.delete(probeSessionId);
}

/**
 * Read text content from a selector.
 * When a reconContext is provided, uses it for SPA fallback resolution.
 */
export async function readText(
  session: ProbeBrowserSession,
  selector: string,
  reconContext?: ReconContext
): Promise<string> {
  const page = await getDefaultPage(session);
  const resolved = await resolveTarget(page, selector, reconContext);
  return page.locator(resolved).innerText();
}

/**
 * Resolve a target string to a usable CSS selector.
 *
 * Resolution strategy:
 * 1. If target looks like a CSS selector (starts with #, ., [ , tag, or has CSS syntax), use it directly
 * 2. If target is a URL, use it for navigation (not here)
 * 3. Otherwise, try to find an element by text content in the page
 * 4. Require exactly one match before acting
 *
 * This prevents AI-generated natural-language targets from being passed to Playwright
 * as CSS selectors (which causes parse errors).
 */
/**
 * Recon element context for fallback resolution.
 * When the original CSS selector no longer matches the DOM after SPA
 * rendering, we can re-resolve using the element's recorded attributes.
 */
export interface ReconContext {
  /** The original CSS selector from recon. */
  selector: string;
  /** Element's visible text content from recon. */
  text?: string;
  /** Element's href attribute from recon. */
  href?: string;
  /** Element's id attribute from recon. */
  id?: string;
  /** Element's name attribute from recon (form inputs). */
  name?: string;
  /** Element's aria-label attribute from recon. */
  ariaLabel?: string;
  /** Element's data-testid from recon. */
  testId?: string;
  /** Element's tag name from recon. */
  tag?: string;
  /** Element's type attribute from recon (inputs/buttons). */
  type?: string;
  /** CSS classes that may identify the element. */
  classes?: string[];
}

/**
 * Normalize CSS selectors by removing unnecessary backslash escapes.
 * AI models often produce selectors like `a[href="\#about"]` when the
 * correct form is `a[href="#about"]`. Inside quoted attribute values,
 * characters like #, /, . do NOT need escaping.
 */
function normalizeSelector(target: string): string {
  // Replace \X inside quoted attribute values with just X
  // Pattern: inside [attr="..."], remove backslashes before # / . )
  return target.replace(/\[([^\]]*?)"([^"\]]*?)"\]/g, (match, beforeQuote, value) => {
    const cleaned = value.replace(/\\([#/.\)])/g, "$1");
    return `[${beforeQuote}"${cleaned}"]`;
  });
}

/**
 * When a CSS selector matches 0 elements in an SPA, the DOM may have
 * changed since recon. Extract attribute anchors (href, name, id, aria-label)
 * from the selector and search for them independently. This is safe because
 * we only use Playwright locator methods — no arbitrary JS injection.
 */
async function resolveByAttribute(
  page: Awaited<ReturnType<typeof getDefaultPage>>,
  selector: string
): Promise<string | null> {
  // Extract a[href="..."] — most common for navigation links
  const hrefMatch = selector.match(/a\[href=["']([^"']+)["']\]/);
  if (hrefMatch) {
    const href = hrefMatch[1];
    try {
      const count = await page.locator(`a[href="${href}"]`).count();
      if (count === 1) return `a[href="${href}"]`;
      if (count > 1) {
        // Try with tag prefix if the plain selector was embedded in a larger selector
        return `a[href="${href}"]`;
      }
    } catch { /* continue */ }
  }

  // Extract input/select/textarea[name="..."]
  const nameMatch = selector.match(/(?:input|select|textarea)\[name=["']([^"']+)["']\]/);
  if (nameMatch) {
    const name = nameMatch[1];
    for (const tag of ["input", "select", "textarea"]) {
      try {
        const count = await page.locator(`${tag}[name="${name}"]`).count();
        if (count === 1) return `${tag}[name="${name}"]`;
      } catch { /* continue */ }
    }
  }

  // Extract #id selectors
  const idMatch = selector.match(/^#([a-zA-Z][\w-]*)$/);
  if (idMatch) {
    const id = idMatch[1];
    try {
      const count = await page.locator(`#${id}`).count();
      if (count === 1) return `#${id}`;
    } catch { /* continue */ }
  }

  // Extract [aria-label="..."]
  const ariaMatch = selector.match(/\[aria-label=["']([^"']+)["']\]/);
  if (ariaMatch) {
    const label = ariaMatch[1];
    try {
      const count = await page.locator(`[aria-label="${label}"]`).count();
      if (count === 1) return `[aria-label="${label}"]`;
    } catch { /* continue */ }
  }

  // Extract button[type="submit"]
  const submitMatch = selector.match(/button\[type=["']submit["']\]/);
  if (submitMatch) {
    try {
      const count = await page.locator(`button[type="submit"]`).count();
      if (count >= 1) return `button[type="submit"]`;
    } catch { /* continue */ }
  }

  return null; // could not resolve by attribute
}

/**
 * Attempt to re-resolve an element using recon metadata when the original
 * CSS selector fails. Uses only Playwright locator methods — no arbitrary JS.
 *
 * Priority:
 * 1. href (most specific for links)
 * 2. data-testid (designed for reliable identification)
 * 3. aria-label (accessibility-based, reliable)
 * 4. id (if present in recon but not the original selector)
 * 5. name + tag (form inputs)
 * 6. Exact text content (last resort — must be unique)
 *
 * Returns null if no unique match is found (ambiguous = rejected).
 */
async function reconResolve(
  page: Awaited<ReturnType<typeof getDefaultPage>>,
  recon: ReconContext
): Promise<string | null> {
  // 1. href — highest specificity for navigation links
  if (recon.href) {
    try {
      const locator = recon.tag
        ? page.locator(`${recon.tag}[href="${recon.href}"]`)
        : page.locator(`a[href="${recon.href}"]`);
      const count = await locator.count();
      if (count === 1) return recon.tag
        ? `${recon.tag}[href="${recon.href}"]`
        : `a[href="${recon.href}"]`;
    } catch { /* continue */ }
  }

  // 2. data-testid — designed for reliable identification
  if (recon.testId) {
    try {
      const count = await page.locator(`[data-testid="${recon.testId}"]`).count();
      if (count === 1) return `[data-testid="${recon.testId}"]`;
    } catch { /* continue */ }
  }

  // 3. aria-label — accessibility-based, reliable
  if (recon.ariaLabel) {
    try {
      const count = await page.locator(`[aria-label="${recon.ariaLabel}"]`).count();
      if (count === 1) return `[aria-label="${recon.ariaLabel}"]`;
    } catch { /* continue */ }
  }

  // 4. id (if the element had an id from recon)
  if (recon.id && !recon.selector.startsWith('#')) {
    try {
      const count = await page.locator(`#${recon.id}`).count();
      if (count === 1) return `#${recon.id}`;
    } catch { /* continue */ }
  }

  // 5. name + tag — form inputs
  if (recon.name && recon.tag && ['input', 'select', 'textarea'].includes(recon.tag)) {
    try {
      const count = await page.locator(`${recon.tag}[name="${recon.name}"]`).count();
      if (count === 1) return `${recon.tag}[name="${recon.name}"]`;
    } catch { /* continue */ }
  }

  // 6. Exact text content — last resort, must be unique
  if (recon.text && recon.text.length > 0 && recon.text.length < 60) {
    try {
      const count = await page.getByText(recon.text, { exact: true }).count();      if (count === 1) {
        // Build a stable selector from the matched element's attributes
        const locator = page.getByText(recon.text, { exact: true });
        const resolved = await locator.first().evaluate((el: HTMLElement) => {
          if (el.id) return '#' + el.id;
          const tag = el.tagName.toLowerCase();
          if (tag === 'a' && el.getAttribute('href')) {
            return 'a[href="' + el.getAttribute('href') + '"]';
          }
          if ((tag === 'input' || tag === 'select' || tag === 'textarea') && (el as HTMLInputElement).name) {
            return tag + '[name="' + (el as HTMLInputElement).name + '"]';
          }
          return null;
        });
        if (resolved) return resolved;
        // Fallback: use getByText directly (not a CSS selector, but Playwright handles it)
        return `text="${recon.text}"`;
      }
      // count > 1: ambiguous, reject
    } catch { /* continue */ }
  }

  return null; // could not resolve — ambiguous or no match
}

/**
 * Detect whether an element is hidden at the current viewport.
 * Checks CSS visibility, display, and opacity — not scroll position.
 * This distinguishes "hidden by CSS" from "off-screen but visible".
 */
async function isHidden(
  locator: { evaluate: (fn: (el: HTMLElement) => boolean) => Promise<boolean> }
): Promise<boolean> {
  try {
    return await locator.evaluate((el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      // Hidden by CSS rules
      if (style.display === 'none') return true;
      if (style.visibility === 'hidden') return true;
      if (style.opacity === '0') return true;
      // Hidden by container (parent chain)
      let parent: HTMLElement | null = el.parentElement;
      while (parent && parent !== document.documentElement) {
        const pStyle = window.getComputedStyle(parent);
        if (pStyle.display === 'none') return true;
        if (pStyle.visibility === 'hidden') return true;
        parent = parent.parentElement;
      }
      return false;
    });
  } catch {
    return false; // if we can't check, assume visible (safe default)
  }
}

async function resolveTarget(
  page: Awaited<ReturnType<typeof getDefaultPage>>,
  target: string,
  reconContext?: ReconContext
): Promise<string> {
  // Normalize backslash escapes in quoted attribute values
  const normalized = normalizeSelector(target);

  // If it looks like a CSS selector already, try it directly
  // CSS selectors start with: # . [ tag-name : > ~ + etc. A selector that
  // contains CSS combinators/attribute syntax is still CSS even with spaces —
  // treating every space as natural language pushed compound selectors like
  // `#contactForm > div > button` through pointless text-resolution fallbacks
  // instead of resolving them directly.
  const looksLikeSelector =
    (/^[#.\[a-zA-Z]/.test(normalized) && !/\s/.test(normalized)) ||
    (/^[#.\[a-zA-Z]/.test(normalized) && /[>~+]|\[[^\]]+\]/.test(normalized));
  if (looksLikeSelector) {
    try {
      const count = await page.locator(normalized).count();
      if (count === 1) return normalized;
      if (count > 1) {
        console.warn(`Selector "${normalized}" matches ${count} elements, using first match`);
        return normalized;
      }
      // count === 0: selector found but no match — try attribute fallbacks for SPAs
    } catch {
      // Invalid selector syntax, fall through to attribute/text resolution
    }

    // SPA fallback 1: extract attributes from the selector and search by them
    const attrFallback = await resolveByAttribute(page, normalized);
    if (attrFallback) return attrFallback;

    // SPA fallback 2: use recon element metadata to re-resolve from current DOM
    if (reconContext) {
      const reconFallback = await reconResolve(page, reconContext);
      if (reconFallback) return reconFallback;
    }
  }

  // Try to resolve by visible text content
  // Strip common prefixes AI models add: "link: ", "button: ", "nav: ", etc.
  const cleanText = target.replace(/^(link|button|nav|form|input|anchor|cta|section|page):\s*/i, '').trim();
  
  if (cleanText.length === 0) return target; // nothing to resolve

  // Try exact text match
  try {
    const count = await page.getByText(cleanText, { exact: true }).count();
    if (count === 1) {
      const locator = page.getByText(cleanText, { exact: true });
      // Generate a stable selector from the matched element
      const resolved = await locator.evaluate((el: HTMLElement) => {
        if (el.id) return '#' + el.id;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && el.getAttribute('href')) {
          const href = el.getAttribute('href');
          if (href && href.startsWith('#')) return 'a[href="' + href + '"]';
          if (href) return 'a[href="' + href + '"]';
        }
        if ((tag === 'input' || tag === 'select' || tag === 'textarea') && (el as HTMLInputElement).name) {
          return tag + '[name="' + (el as HTMLInputElement).name + '"]';
        }
        // Fallback: tag with exact text (Playwright supports this)
        return tag + ':has-text("' + el.textContent.trim().replace(/"/g, '\\"') + '")';
      });
      return resolved;
    }
    if (count > 1) {
      console.warn(`Text "${cleanText}" matches ${count} elements, using first match`);
      // Still use getByText — Playwright will use first match
      return `text="${cleanText}"`;
    }
  } catch {
    // getByText failed, continue
  }

  // Try partial text match
  try {
    const count = await page.getByText(cleanText).count();
    if (count === 1) {
      const locator = page.getByText(cleanText);
      const resolved = await locator.evaluate((el: HTMLElement) => {
        if (el.id) return '#' + el.id;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && el.getAttribute('href')) {
          const href = el.getAttribute('href');
          if (href && href.startsWith('#')) return 'a[href="' + href + '"]';
          if (href) return 'a[href="' + href + '"]';
        }
        return tag + ':has-text("' + el.textContent.trim().slice(0, 50).replace(/"/g, '\\"') + '")';
      });
      return resolved;
    }
  } catch {
    // continued
  }

  // Try aria-label match
  try {
    const count = await page.getByLabel(cleanText).count();
    if (count === 1) return `aria-label="${cleanText}"`;
  } catch {
    // continued
  }

  // Try role + name match
  try {
    const count = await page.getByRole('link', { name: cleanText }).count();
    if (count === 1) return `role=link[name="${cleanText}"]`;
  } catch {
    // continued
  }

  try {
    const count = await page.getByRole('button', { name: cleanText }).count();
    if (count === 1) return `role=button[name="${cleanText}"]`;
  } catch {
    // continued
  }

  // Could not resolve — return original target and let it fail with a clear error
  return target;
}

/**
 * Maximum retries for transient element-not-found errors.
 * These can occur due to SPA rendering timing, page transitions,
 * or lazy-loaded content.
 */
const CLICK_MAX_RETRIES = 3;
const CLICK_RETRY_DELAYS_MS = [800, 2000, 3500];
const TYPE_MAX_RETRIES = 2;
const TYPE_RETRY_DELAYS_MS = [800, 2000];

/**
 * Wait for an element to appear in the DOM with a reasonable timeout.
 * Uses Playwright's built-in waitForSelector which is more reliable
 * than polling count() for SPA-rendered content.
 *
 * Only a TIMEOUT counts as "not found". Any other failure (connection
 * reset, target closed, protocol error) is re-thrown: swallowing it into
 * `false` made every such failure look like "Element not found", which
 * hid the real cause and sent the AI planning from false evidence.
 */
async function waitForElement(
  page: Awaited<ReturnType<typeof getDefaultPage>>,
  selector: string,
  timeoutMs = 10_000
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: "attached", timeout: timeoutMs });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Timeout") || msg.includes("timed out")) {
      return false; // genuinely did not appear in time
    }
    throw error; // not a timeout — surface the real failure
  }
}

/**
 * Check if an element is a fixed/sticky positioned control.
 * These elements don't need scroll-into-view and may fail if we try.
 */
async function isFixedOrSticky(locator: { evaluate: (fn: (el: HTMLElement) => string) => Promise<string> }): Promise<boolean> {
  try {
    const position = await locator.evaluate((el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      return style.position;
    });
    return position === "fixed" || position === "sticky";
  } catch {
    return false;
  }
}

/**
 * Wait for the page DOM to settle after a click that may trigger
 * navigation or SPA route change. Handles hash navigation, SPA
 * transitions, and lazy-loaded content rendering.
 */
async function waitForPostClickSettling(
  page: Awaited<ReturnType<typeof getDefaultPage>>,
  previousUrl: string
): Promise<void> {
  const currentUrl = page.url();
  const urlChanged = currentUrl !== previousUrl;

  // After any URL change, wait for the page to load
  if (urlChanged) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    } catch { /* best effort */ }
    try {
      await page.waitForLoadState("networkidle", { timeout: 3_000 });
    } catch { /* best effort — not all pages reach networkidle */ }
    // Give React/SPA frameworks a moment to render new content
    await new Promise((r) => setTimeout(r, 300));
  } else {
    // Same URL (hash navigation or in-page scroll) — brief settle
    try {
      await page.waitForLoadState("networkidle", { timeout: 2_000 });
    } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Click an element with robust handling for SPA timing, mobile controls,
 * and transient failures.
 *
 * Strategy:
 * 1. Wait for page stability (networkidle)
 * 2. Try to find element with retries for SPA timing
 * 3. Re-resolve the target on each retry (DOM may have changed)
 * 4. For fixed/sticky elements, skip scroll-into-view
 * 5. For CSS-hidden elements, skip scroll and fail early
 * 6. For normal elements, scroll into view before clicking
 * 7. Retry on transient click failures (intercept, not visible, etc.)
 * 8. After click, wait for SPA DOM settling before returning
 *
 * When a reconContext is provided, uses it for SPA fallback resolution
 * after the original CSS selector fails.
 */
export async function click(
  session: ProbeBrowserSession,
  selector: string,
  reconContext?: ReconContext
): Promise<void> {
  const page = await getDefaultPage(session);

  // Wait briefly for the page to settle (SPA rendering, lazy content)
  try {
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  } catch { /* best effort */ }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= CLICK_MAX_RETRIES; attempt++) {
    // Re-resolve the target on every attempt — DOM may have changed
    // Pass reconContext for SPA fallback resolution
    const resolved = await resolveTarget(page, selector, reconContext);

    // Use waitForSelector for reliable element detection
    // This handles SPA rendering timing better than polling count()
    const found = await waitForElement(page, resolved, attempt === 0 ? 10_000 : 4_000);
    if (!found) {
      lastError = new Error(`Element not found: ${selector} (resolved: ${resolved})`);
      if (attempt < CLICK_MAX_RETRIES) {
        // Brief wait before retry — SPA may still be rendering
        await new Promise((r) => setTimeout(r, CLICK_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    // Re-acquire a fresh locator (previous one may be stale after DOM changes)
    const locator = page.locator(resolved);
    const count = await locator.count();
    if (count > 1) {
      console.warn(`Selector matches ${count} elements, clicking first: ${selector}`);
    }

    // Check if element is fixed/sticky (mobile nav, modals, etc.)
    const fixed = await isFixedOrSticky(locator.first());

    // Check if element is CSS-hidden (display:none, visibility:hidden, opacity:0)
    const hidden = await isHidden(locator.first());
    if (hidden) {
      // Element is CSS-hidden — this is likely a viewport/responsive issue
      // Do NOT scroll it into view (that won't help a hidden element)
      // On retry, reconResolve may find the element in a different state
      lastError = new Error(`Element is CSS-hidden at current viewport: ${selector} (resolved: ${resolved})`);
      if (attempt < CLICK_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, CLICK_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    if (!fixed) {
      // Scroll into view for normal elements
      try {
        await locator.first().scrollIntoViewIfNeeded({ timeout: 3_000 });
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        // Scroll failed — element may be off-screen or hidden
        // Try clicking anyway — Playwright can sometimes handle it
      }
    }

    // Try to click — if it fails with "not interactable", retry
    try {
      // Capture URL before click to detect SPA navigation
      const urlBefore = page.url();
      await locator.first().click({ timeout: 10_000 });
      // Wait for DOM to settle after click (SPA transition, hash navigation)
      await waitForPostClickSettling(page, urlBefore);
      return; // success
    } catch (clickErr) {
      const clickMsg = clickErr instanceof Error ? clickErr.message : String(clickErr);
      const isTransient = clickMsg.includes("intercept") || clickMsg.includes("not visible") ||
                          clickMsg.includes("not enabled") || clickMsg.includes("not interactable") ||
                          clickMsg.includes("timeout") || clickMsg.includes("detached") ||
                          clickMsg.includes("stale");
      if (isTransient && attempt < CLICK_MAX_RETRIES) {
        // Wait before retry — element may be transitioning or detached
        await new Promise((r) => setTimeout(r, CLICK_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw clickErr;
    }
  }

  // Should never reach here, but just in case
  throw lastError ?? new Error(`Click failed for: ${selector}`);
}

/**
 * Type text into an element with retry for transient failures.
 * Handles fixed/sticky elements, SPA timing, CSS-hidden elements, and DOM reacquisition.
 *
 * When a reconContext is provided, uses it for SPA fallback resolution.
 */
export async function type(
  session: ProbeBrowserSession,
  selector: string,
  text: string,
  reconContext?: ReconContext
): Promise<void> {
  const page = await getDefaultPage(session);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= TYPE_MAX_RETRIES; attempt++) {
    // Re-resolve on each attempt, with recon fallback
    const resolved = await resolveTarget(page, selector, reconContext);

    // Wait for element to exist with reliable detection
    const found = await waitForElement(page, resolved, attempt === 0 ? 10_000 : 4_000);
    if (!found) {
      lastError = new Error(`Element not found for typing: ${selector} (resolved: ${resolved})`);
      if (attempt < TYPE_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, TYPE_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    // Fresh locator on each attempt
    const locator = page.locator(resolved);

    // Check if element is fixed/sticky
    const fixed = await isFixedOrSticky(locator.first());

    // Check if element is CSS-hidden
    const hidden = await isHidden(locator.first());
    if (hidden) {
      lastError = new Error(`Element is CSS-hidden at current viewport: ${selector} (resolved: ${resolved})`);
      if (attempt < TYPE_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, TYPE_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    if (!fixed) {
      try {
        await locator.first().scrollIntoViewIfNeeded({ timeout: 3_000 });
      } catch { /* scroll failed, try anyway */ }
    }

    try {
      // Focus the element first to ensure it's interactable
      try { await locator.first().focus({ timeout: 2_000 }); } catch { /* best effort */ }
      await locator.first().fill(text);
      return; // success
    } catch (typeErr) {
      const msg = typeErr instanceof Error ? typeErr.message : String(typeErr);
      const isTransient = msg.includes("detached") || msg.includes("stale") ||
                          msg.includes("not visible") || msg.includes("not interactable") ||
                          msg.includes("not enabled") || msg.includes("timeout");
      if (isTransient && attempt < TYPE_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, TYPE_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw typeErr;
    }
  }

  throw lastError ?? new Error(`Type failed for: ${selector}`);
}



/**
 * Take a screenshot. Returns PNG buffer.
 */
export async function screenshot(
  session: ProbeBrowserSession
): Promise<Buffer> {
  const page = await getDefaultPage(session);
  const buffer = await page.screenshot({ type: "png" });
  return buffer;
}

/**
 * Get the page's DOM content.
 */
export async function getDomContent(
  session: ProbeBrowserSession
): Promise<string> {
  const page = await getDefaultPage(session);
  return page.content();
}

/**
 * Evaluate JavaScript in the page context.
 */
export async function evaluate(
  session: ProbeBrowserSession,
  fn: string
): Promise<unknown> {
  const page = await getDefaultPage(session);
  return page.evaluate(fn);
}

/**
 * Close a browser session and release the Solari slot.
 *
 * Calls session.close() which closes the browser AND releases the
 * Solari session in one operation. The process still needs solari.close()
 * on exit to shut down the loopback proxy — that happens in closeAllClients().
 */
export async function closeBrowserSession(
  session: ProbeBrowserSession
): Promise<void> {
  // Bound the close: the SDK close path includes a release acknowledgment;
  // a wedged gateway must not stall the experiment loop (the release is
  // also retried/cleaned up at investigation level, so a timeout here only
  // means we stop waiting, not that the browser leaks indefinitely).
  try {
    await Promise.race([
      session.session.close(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  } catch (e) {
    console.error(
      `Error closing browser for session ${session.probeSessionId}:`,
      e
    );
  } finally {
    clearViewportState(session.probeSessionId);
    untrackBrowserSession(session.probeSessionId);
    store.updateSession(session.probeSessionId, {
      status: "released",
      releasedAt: new Date().toISOString(),
    });
  }
}

/**
 * Get recording replay data (async upload after release).
 * Polls for up to 30 seconds.
 */
export async function getReplay(
  solariSessionId: string,
  maxAttempts = 10,
  delayMs = 3000
): Promise<Uint8Array | null> {
  const solari = getBrowserSolari();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const blob = await solari.sessions.downloadReplay(solariSessionId);
      return blob;
    } catch {
      // 404 = not uploaded yet, keep trying
      continue;
    }
  }
  return null;
}
