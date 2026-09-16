/**
 * Real-browser UI verification for the investigation page fixes.
 *
 * Drives three REAL investigations created under the local verify account:
 *  A) inv_1789547493664_p2bbvy — completed, report persisted, 31 evidence vs
 *     4 experiments (the classic "Evidence stretches Experiments" case).
 *     → no terminal banner; Report section rendered; layout checks at
 *       desktop + mobile; grouped/scrollable/collapsible evidence.
 *  B) inv_1789547038441_pksla8 — failed / runtime_expired; the budget
 *     expired during the report phase, so no report exists.
 *     → banner says budget limit; NOT "execution error"; NOT the false
 *       "before a report could be produced" claim (none exists, truthfully).
 *  C) inv_1789547793192_o7msps — failed / AI provider 402 error.
 *     → banner must NOT say budget limit (it isn't one); generic
 *       infrastructure-failure copy is truthful here; no report card.
 *
 * NOTE on page.evaluate: tsx/esbuild (keepNames) rewrites named arrow
 * functions into `__name(fn, "label")` wrappers — that helper doesn't exist
 * in the browser. All evaluate calls here pass plain JS STRINGS.
 */
import { chromium } from "patchright-core";

const BASE = "http://localhost:5173";
const API = "http://localhost:3001";
const EMAIL = "probe-budget@example.com";
const PASSWORD = "probe-budget-pass-123";

const COMPLETED_INV = "inv_1789547493664_p2bbvy";
const BUDGET_INV = "inv_1789547038441_pksla8";
const AI_ERR_INV = "inv_1789547793192_o7msps";

const LAYOUT_SNIPPET = `(() => {
  const q = (sel) => document.querySelector(sel);
  const progress = q('.progress-grid') ? q('.progress-grid').getBoundingClientRect() : null;
  const twoCol = q('.two-col') ? q('.two-col').getBoundingClientRect() : null;
  const cards = q('.two-col') ? q('.two-col').querySelectorAll(':scope > .card') : [];
  const expCard = cards[0] || null;
  const evCard = q('.evidence-card');
  const expH = expCard ? expCard.getBoundingClientRect().height : 0;
  const evH = evCard ? evCard.getBoundingClientRect().height : 0;
  return {
    gap: twoCol && progress ? twoCol.top - progress.bottom : -1,
    expH, evH,
    heightRatio: evH > 0 ? expH / evH : 0,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    groups: document.querySelectorAll('.evidence-group').length,
    toggles: document.querySelectorAll('.evidence-group-toggle').length,
    listScrolls: (function(){ const list = q('.evidence-card .evidence-list'); return !!list && list.scrollHeight > list.clientHeight; })(),
    stacked: expCard && evCard ? evCard.getBoundingClientRect().top >= expCard.getBoundingClientRect().bottom - 2 : false,
  };
})()`;

async function main() {
  // Log in through the API to obtain the session cookie, then inject it into
  // the browser context (the client is cookie-authenticated).
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    console.log("LOGIN FAILED:", loginRes.status);
    process.exit(1);
  }
  const cookiePair = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookiePair) {
    console.log("NO SESSION COOKIE");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = cookiePair.split("=");
  await context.addCookies([{ name, value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));

  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) failures.push(label);
  };
  const open = async (invId: string) => {
    // SSE subscriptions stay open forever — networkidle never fires on an
    // authenticated investigation page. Wait for load + a settle window.
    await page.goto(`${BASE}/#/investigation/${invId}`, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(6000);
  };
  const bannerText = async () =>
    String((await page.evaluate(`(document.querySelector('.progress-terminal')||{}).textContent || ''`)) ?? "");
  const reportText = async (): Promise<string> => {
    // The summary arrives via a separate fetch after module load — poll for it.
    for (let i = 0; i < 30; i++) {
      const t = String(
        (await page.evaluate(
          `(() => { const cards = Array.from(document.querySelectorAll('.card')); const c = cards.find(x => { const h = x.querySelector('h2'); return h && h.textContent.trim().toLowerCase() === 'report'; }); return c ? c.textContent.slice(0, 500) : ''; })()`
        )) ?? ""
      );
      if (t.length > 0) return t;
      await page.waitForTimeout(500);
    }
    return "";
  };

  // ── A) Completed investigation: layout + evidence UX ─────────────────
  await open(COMPLETED_INV);
  {
    const banner = await bannerText();
    ok(!/budget limit|execution error/i.test(banner), "A: completed run shows no failure banner");
    const rep = await reportText();
    ok(rep.length > 40, "A: Report section rendered for the completed run");

    const m = (await page.evaluate(LAYOUT_SNIPPET)) as Record<string, number | boolean>;
    ok(Number(m.gap) > 8, `A: Progress→Experiments breathing room (${Math.round(Number(m.gap))}px)`);
    ok(
      Number(m.heightRatio) < 0.98,
      `A: Experiments not stretched to Evidence height (ratio ${Number(m.heightRatio).toFixed(2)}; exp ${Math.round(Number(m.expH))}px vs ev ${Math.round(Number(m.evH))}px)`
    );
    ok(!m.overflowX, "A: no horizontal overflow at 1280px");
    ok(
      Number(m.groups) >= 2 && Number(m.toggles) >= 2,
      `A: evidence grouped & collapsible (${m.groups} groups, ${m.toggles} toggles)`
    );
    ok(m.listScrolls === true, "A: evidence list scrolls internally (31 artifacts)");

    const collapsed = (await page.evaluate(
      `(() => { const t = document.querySelector('.evidence-group-toggle'); if (!t) return null; t.click(); return new Promise(r => setTimeout(() => { const g = t.closest('.evidence-group'); r({ textLen: g ? g.innerText.length : -1 }); }, 150)); })()`
    )) as { textLen: number } | null;
    ok(collapsed !== null && collapsed.textLen < 1500, "A: collapsing a group hides its items");

    await page.screenshot({ path: "/tmp/ui-verify-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(400);
    const mm = (await page.evaluate(LAYOUT_SNIPPET)) as Record<string, number | boolean>;
    ok(!mm.overflowX, "A-mobile: no horizontal overflow at 375px");
    ok(Number(mm.gap) > 8, `A-mobile: Progress→Experiments spacing (${Math.round(Number(mm.gap))}px)`);
    ok(mm.stacked === true, "A-mobile: sections stack naturally");
    ok(
      Math.abs(Number(mm.expH) - Number(mm.evH)) > 24,
      `A-mobile: independent card heights (exp ${Math.round(Number(mm.expH))}px / ev ${Math.round(Number(mm.evH))}px)`
    );
    await page.screenshot({ path: "/tmp/ui-verify-mobile.png", fullPage: false });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
  }

  // ── B) Budget-stop, no report: honest banner ─────────────────────────
  await open(BUDGET_INV);
  {
    const banner = await bannerText();
    ok(/budget limit/i.test(banner), "B: banner presents a budget stop");
    ok(!/execution error/i.test(banner), "B: banner does NOT claim an execution error");
    ok(!/before a report could be produced/i.test(banner), "B: no false no-report claim (none exists truthfully)");
    ok((await reportText()).length === 0, "B: no report card (report phase never completed)");
  }

  // ── C) AI provider failure: NOT presented as budget stop ─────────────
  await open(AI_ERR_INV);
  {
    const banner = await bannerText();
    ok(!/budget limit/i.test(banner), "C: AI-provider failure is NOT presented as a budget stop");
    ok(/infrastructure|stopped early|unexpected/i.test(banner), "C: banner uses truthful infrastructure-failure copy");
    ok((await reportText()).length === 0, "C: no report card for this failure");
  }

  await browser.close();
  console.log(failures.length === 0 ? "\nALL UI CHECKS PASSED" : `\n${failures.length} UI CHECK(S) FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().then(
  () => undefined,
  (err) => {
    console.error("UI verification crashed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
