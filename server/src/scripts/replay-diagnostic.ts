/**
 * Replay lifecycle diagnostic — launches a REAL Solari session, does trivial
 * work, closes it, then polls the replay endpoint and reports every status.
 *
 * Determines empirically: is the replay 404 temporary (eventually available)
 * or permanent (never arrives)? No secrets are printed.
 */
export {};

const { getBrowserSolari, closeAllClients } = await import("../solari/client.js");

const solari = getBrowserSolari();
console.log("=== launching session (recording: true) ===");
const session = await solari.launch({ recording: true, probe: true, probeTimeoutMs: 5_000 });
const id = session.id;
console.log(`session id: ${id}`);

const page = (await session.contexts())[0]?.pages()[0] ?? (await session.newPage());
try {
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 20_000 });
  console.log(`navigated: ${page.url()}`);
} catch (e) {
  console.log(`navigate failed: ${e instanceof Error ? e.message : e}`);
}

console.log("=== closing session (releaseAndWait via close()) ===");
const tClose = Date.now();
await session.close();
console.log(`close() completed in ${Date.now() - tClose}ms`);

console.log("=== polling replay for up to 45s ===");
let gotIt: Uint8Array | null = null;
for (let i = 1; i <= 15; i++) {
  const t0 = Date.now();
  try {
    const blob = await solari.sessions.downloadReplay(id);
    gotIt = blob;
    console.log(`attempt ${i}: SUCCESS bytes=${blob.length} in ${Date.now() - t0}ms`);
    break;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    console.log(`attempt ${i}: FAIL ${status ?? "?"} at +${Date.now() - tClose}ms — ${msg.slice(0, 140)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

if (gotIt) {
  const head = new TextDecoder().decode(gotIt.slice(0, 120));
  console.log(`REPLAY EVENTUALLY AVAILABLE (bytes=${gotIt.length}) head: ${head.replace(/\n/g, " ")}`);
} else {
  console.log("REPLAY NEVER BECAME AVAILABLE within 45s after close.");
}
await closeAllClients();
process.exit(0);
