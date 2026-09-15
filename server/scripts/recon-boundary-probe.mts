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
    // Fixed nth-of-type: each segment describes its own position among
    // same-tag siblings (old version appended the ancestor index to the
    // immutable tail, producing selectors matching 0 elements).
    function nthSegment(elm) {
      const segTag = elm.tagName.toLowerCase();
      const segParent = elm.parentElement;
      if (!segParent || segParent === document.body) return segTag;
      const sameTag = Array.from(segParent.children).filter(c => c.tagName === elm.tagName);
      if (sameTag.length <= 1) return segTag;
      return segTag + ':nth-of-type(' + (sameTag.indexOf(elm) + 1) + ')';
    }
    let current = el;
    let path = nthSegment(el);
    while (current.parentElement && current.parentElement !== document.body) {
      const parent = current.parentElement;
      if (parent.id) {
        return '#' + CSS.escape(parent.id) + ' > ' + path;
      }
      path = nthSegment(parent) + ' > ' + path;
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

    if (process.argv.includes("--structure")) {
      // Dump each button's ancestry chain + test the generated selector.
      const struct = (await browser.evaluate(
        session,
        `(() => {
          const out = [];
          document.querySelectorAll('button').forEach(b => {
            const chain = [];
            let cur = b;
            while (cur && cur !== document.body) {
              chain.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : ''));
              cur = cur.parentElement;
            }
            out.push({ text: (b.textContent || '').trim().slice(0, 30), chain: chain.reverse() });
          });
          return out;
        })()`
      )) as Array<{ text: string; chain: string[] }>;
      console.log("BUTTON STRUCTURE:", JSON.stringify(struct, null, 1));
      // Direct in-page test of the generated structural selector:
      const probe = (await browser.evaluate(
        session,
        `(() => {
          const sel = 'div > p > button:nth-of-type(2)';
          const direct = document.querySelectorAll(sel).length;
          const p = document.querySelector('div#root p');
          const pButtons = p ? p.querySelectorAll(':scope > button') : [];
          return {
            directMatch: direct,
            pExists: !!p,
            pParentTag: p?.parentElement?.tagName.toLowerCase() ?? null,
            pButtonCount: pButtons.length,
            pButton2Text: (pButtons[1]?.textContent || '').trim(),
          };
        })()`
      )) as Record<string, unknown>;
      console.log("SELECTOR PROBE:", JSON.stringify(probe));
      const rootHTML = (await browser.evaluate(session, `document.getElementById('root')?.innerHTML.slice(0, 1600)`)) as string;
      console.log("ROOT HTML:\n" + rootHTML);
    }

    if (process.argv.includes("--flow")) {
      // Multi-step flow probe with the VERBATIM recon extraction:
      //   extract -> click <selector> -> extract -> diff selectors.
      // Proves on a REAL deployed SPA that a state-changing click reveals
      // interactables that only post-action recon can discover.
      const flowSel = process.argv[process.argv.indexOf("--flow") + 1];
      const extractSel = async (label: string) => {
        const arr = (await browser.evaluate(session, RECON_EXTRACTION_VERBATIM)) as Array<{ selector: string; text?: string; tag?: string }>;
        const list = Array.isArray(arr) ? arr : [];
        console.log(`[${label}] ${list.length} elements:`);
        for (const el of list) console.log(`   ${el.selector}  (${el.tag}${el.text ? ` "${el.text.slice(0, 40)}"` : ""})`);
        return new Set(list.map((e) => e.selector));
      };
      const before = await extractSel("before");
      // Does the generated selector actually match in-page DOM right now?
      // Distinguishes "stale structural path" from "DOM churned since extract".
      const domCount = (await browser.evaluate(
        session,
        `document.querySelectorAll(${JSON.stringify(flowSel)}).length`
      )) as number;
      console.log(`DOM querySelectorAll match count for '${flowSel}': ${domCount}`);
      console.log(`clicking: ${flowSel}`);
      await browser.click(session, flowSel);
      await new Promise((r) => setTimeout(r, 1500));
      const after = await extractSel("after");
      const added = [...after].filter((s) => !before.has(s));
      const removed = [...before].filter((s) => !after.has(s));
      console.log("NEW selectors after click (post-action recon territory):", JSON.stringify(added, null, 1));
      console.log("REMOVED selectors after click:", JSON.stringify(removed, null, 1));
      const loc = (await browser.evaluate(session, "location.href")) as string;
      console.log("URL after click:", loc);
    }

    if (process.argv.includes("--click-create-account")) {
      // Multi-step flow probe: click "Create account", then re-extract.
      // Proves (against the REAL deployed SPA) that the signup form controls
      // only exist after a state-changing click — the exact case post-action
      // recon was built for.
      await browser.click(session, 'div > p > button:nth-of-type(2)');
      await new Promise((r) => setTimeout(r, 1200));
      const after = (await browser.evaluate(session, EXTRACTION)) as Record<string, unknown>;
      console.log("AFTER CLICK:", JSON.stringify(after, null, 2));
      const url = (await browser.evaluate(session, "location.href")) as string;
      console.log("URL after click:", url);
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
