/**
 * RECON→PLAN boundary experiment (read-only browser probe).
 *
 * Investigation: why does recon yield 0 interactable elements on client-rendered
 * SPAs (probe-challenge.vercel.app) even though the page visibly loads?
 *
 * Competing hypotheses tested with the REAL Solari adapter:
 *  H1 hydration-timing: elements appear only after extra wait beyond
 *     navigate()'s networkidle best-effort.
 *  H2 swallowed evaluate failure: page.evaluate throws / returns unusable data
 *     and the recon catch swallows it silently.
 *  H3 extraction-logic gap: the recon extraction script itself fails to match
 *     elements that exist in a hydrated DOM.
 *
 * Run: npx tsx scripts/recon-boundary-probe.mts <url> [--wait <ms>]
 * Never prints credentials. Uses the same env loading as the server.
 */
import "../src/loadEnv.js";
import { createDurableBackend } from "../src/persistence/index.js";
import { useDurableBackend, hydrate } from "../src/store/index.js";
import * as browser from "../src/solari/browser.js";

const url = process.argv[2] ?? "https://probe-challenge.vercel.app/";
const investigationId = process.env.RECON_PROBE_INV ?? "recon-probe-manual";
const waitMs = process.argv.includes("--wait")
  ? Number(process.argv[process.argv.indexOf("--wait") + 1])
  : 0;

const EXTRACTION = `
(() => {
  const results = [];
  const els = document.querySelectorAll('a[href], button, [role="button"], input, select, textarea');
  for (const el of els) {
    results.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
      href: el.getAttribute('href') || undefined,
    });
  }
  return {
    readyState: document.readyState,
    rootHTMLChars: (document.getElementById('root')?.innerHTML || '').length,
    bodyChars: (document.body?.innerHTML || '').length,
    interactiveCount: els.length,
    sample: results.slice(0, 12),
  };
})()`;

// Verbatim copy of the runner's interactableElements extraction (runner.ts
// lines ~517-657) to test whether the production extraction script itself
// works on a hydrated SPA DOM.
const RECON_EXTRACTION_VERBATIM = `
(() => {
  const results = [];
  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.getAttribute('href')) {
      const href = el.getAttribute('href');
      if (href && (href.startsWith('#') || href.startsWith('/'))) {
        return 'a[href="' + CSS.escape(href) + '"]';
      }
      if (href && !href.startsWith('javascript:')) {
        return 'a[href="' + CSS.escape(href) + '"]';
      }
    }
    if (['input','select','textarea'].includes(tag) && el.name) {
      const nameCount = document.querySelectorAll(tag + '[name="' + CSS.escape(el.name) + '"]').length;
      if (nameCount === 1) return tag + '[name="' + CSS.escape(el.name) + '"]';
      const form = el.closest('form');
      if (form && form.id) return '#' + CSS.escape(form.id) + ' ' + tag + '[name="' + CSS.escape(el.name) + '"]';
      return tag + '[name="' + CSS.escape(el.name) + '"]';
    }
    if (tag === 'input' && el.type) {
      return 'input[type="' + CSS.escape(el.type) + '"]';
    }
    if (el.getAttribute('data-testid')) return '[data-testid="' + CSS.escape(el.getAttribute('data-testid')) + '"]';
    if (el.getAttribute('data-cy')) return '[data-cy="' + CSS.escape(el.getAttribute('data-cy')) + '"]';
    if (el.getAttribute('aria-label')) {
      const label = el.getAttribute('aria-label');
      const labelCount = document.querySelectorAll('[aria-label="' + CSS.escape(label) + '"]').length;
      if (labelCount === 1) return '[aria-label="' + CSS.escape(label) + '"]';
    }
    const role = el.getAttribute('role');
    if (role) {
      const accessibleName = el.textContent?.trim().slice(0, 50) || '';
      if (accessibleName) return '[role="' + role + '"][aria-label="' + CSS.escape(accessibleName) + '"]';
    }
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
      if (path.split(' > ').length >= 3) break;
    }
    return path;
  }
  function getInfo(el) {
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const classes = Array.from(el.classList || []).slice(0, 3);
    const info = { selector: getSelector(el), text, tag: el.tagName.toLowerCase() };
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
  document.querySelectorAll('nav a, [role="navigation"] a').forEach(a => results.push(getInfo(a)));
  document.querySelectorAll('a[href]').forEach(a => {
    const text = (a.textContent || '').trim();
    if (text && text.length > 0 && text.length < 80) {
      const sel = getSelector(a);
      if (!results.some(r => r.selector === sel)) results.push(getInfo(a));
    }
  });
  document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(b => results.push(getInfo(b)));
  document.querySelectorAll('form input, form select, form textarea, input[name], textarea[name]').forEach(inp => results.push(getInfo(inp)));
  document.querySelectorAll('[id]').forEach(el => {
    if (el.tagName !== 'HTML' && el.tagName !== 'BODY' && el.id) {
      results.push({ selector: '#' + CSS.escape(el.id), text: (el.textContent || '').trim().slice(0, 40), tag: el.tagName.toLowerCase(), id: el.id });
    }
  });
  return results.slice(0, 50);
})()`;

async function run() {
  // Bind durable backend + hydrate so navigation policy can see the
  // investigation's verified applicationUrl (same as server startup).
  try {
    const backend = await createDurableBackend();
    useDurableBackend(backend);
    await hydrate();
  } catch (err) {
    console.error("persistence init failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const useRecording = !process.argv.includes("--no-recording");
  const session = await browser.createBrowserSession(investigationId, { recording: useRecording });
  try {
    const nav = await browser.navigate(session, url);
    console.log("navigate() returned:", JSON.stringify(nav));

    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const immediate = (await browser.evaluate(session, EXTRACTION)) as Record<string, unknown>;
    console.log(`[wait=${waitMs}ms]`, JSON.stringify(immediate, null, 2));

    // Production extraction script, verbatim — would it succeed here?
    try {
      const verbatim = await browser.evaluate(session, RECON_EXTRACTION_VERBATIM);
      const arr = Array.isArray(verbatim) ? verbatim : [];
      console.log(`[verbatim recon extraction] returned ${arr.length} elements`);
      if (arr.length > 0) console.log("sample:", JSON.stringify(arr.slice(0, 6), null, 1));
    } catch (err) {
      console.log("[verbatim recon extraction] THREW:", err instanceof Error ? err.message : String(err));
    }

    if (waitMs > 0) {
      const later = (await browser.evaluate(session, EXTRACTION)) as Record<string, unknown>;
      console.log(`[wait+2s]`, JSON.stringify(later, null, 2));
    }
    if (process.argv.includes("--hrefs")) {
      const hrefs = (await browser.evaluate(session, `Array.from(document.querySelectorAll('a[href]')).map(a=>({href:a.getAttribute('href'),text:(a.textContent||'').trim().slice(0,40)})).slice(0,30)`)) as Array<{ href: string; text: string }>;
      console.log("HREFS:", JSON.stringify(hrefs, null, 1));
    }
  } finally {
    await browser.closeBrowserSession(session);
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("PROBE FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
