/**
 * Real Solari integration tests.
 *
 * Environment-dependent by design: they exercise the actual browser and
 * sandbox adapters against the real Solari API.
 *
 * Classification:
 *  - No SOLARI_API_KEY        → suite skipped (credentials unavailable).
 *  - Key set, Solari reachable → tests run for real and assert real behavior.
 *  - Key set, Solari unreachable → the individual test skips itself with an
 *    explicit environment-dependent reason. Only connection-class failures
 *    (DNS/connection refused/unreachable) classify as environmental — API
 *    errors, policy rejections, and assertion failures still fail the run,
 *    so a genuine regression can never hide behind the skip.
 *
 * Run with: SOLARI_API_KEY=slr_live_... bun test integration
 */
import { describe, it, expect, beforeAll } from "vitest";
import { store } from "../store/index.js";

const SOLARI_API_KEY = process.env.SOLARI_API_KEY || "";

const maybeDescribe = SOLARI_API_KEY ? describe : describe.skip;

/**
 * True when the error is a connection-class failure — the environment
 * cannot reach Solari at all (no egress, DNS failure, refused connection).
 * Deliberately narrow: auth errors, policy errors, and timeouts from live
 * behavior are NOT classified as environmental and still fail the run.
 */
function isConnectivityError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /\b(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|getaddrinfo/i.test(msg);
}

/**
 * Runs the live test body and, when the failure is connection-class,
 * skips with an explicit environment-dependent reason instead of a red
 * error. Any other error is rethrown untouched.
 */
async function liveTest(ctx: { skip: (condition: boolean, message?: string) => void }, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (isConnectivityError(err)) {
      const detail = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      ctx.skip(true, `Environment-dependent: Solari is not reachable from this environment (${detail})`);
      return;
    }
    throw err;
  }
}

// ── Browser Integration ────────────────────────────────────────────────────

maybeDescribe("Real Solari Browser", () => {
  let browserMod: typeof import("../solari/browser.js");

  beforeAll(async () => {
    browserMod = await import("../solari/browser.js");
  });

  it("creates a session, navigates, reads text, takes screenshot, and closes", async (ctx) => {
    await liveTest(ctx, async () => {
      // The canonical-target navigation policy (a deliberate production
      // control) reads the verified application URL from the investigation
      // that owns the browser session. Bind the session to a REAL
      // investigation whose applicationUrl is the target below — exactly
      // how production binds sessions — so navigation is legitimately
      // verified rather than exempted from the policy.
      const investigation = store.createInvestigation({
        repositoryUrl: "",
        applicationUrl: "https://example.com",
        objective: "Solari browser adapter integration check",
      });
      const session = await browserMod.createBrowserSession(investigation.id, {
        recording: false, // skip recording for faster test
      });

      try {
        // Navigate to a stable public page
        const nav = await browserMod.navigate(session, "https://example.com");
        expect(nav.title).toBe("Example Domain");
        expect(nav.url).toContain("example.com");

        // Read the page title
        const title = await browserMod.getTitle(session);
        expect(title).toBe("Example Domain");

        // Take a screenshot
        const screenshot = await browserMod.screenshot(session);
        expect(screenshot).toBeInstanceOf(Buffer);
        expect(screenshot.length).toBeGreaterThan(0);

        // Get DOM content
        const html = await browserMod.getDomContent(session);
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("Example Domain");

        // Read text from a selector
        const text = await browserMod.readText(session, "h1");
        expect(text).toBe("Example Domain");
      } finally {
        await browserMod.closeBrowserSession(session);
      }
    });
  });
});

// ── Sandbox Integration ────────────────────────────────────────────────────

maybeDescribe("Real Solari Sandbox", () => {
  let sandboxMod: typeof import("../solari/sandbox.js");

  beforeAll(async () => {
    sandboxMod = await import("../solari/sandbox.js");
  });

  it("creates a sandbox, runs commands, writes/reads files, and kills", async (ctx) => {
    await liveTest(ctx, async () => {
      const session = await sandboxMod.createSandboxSession("integration-test");

      try {
        // Run a simple command
        const lsResult = await sandboxMod.runCommand(session, "ls", ["/"]);
        expect(lsResult.exitCode).toBe(0);
        expect(lsResult.stdout).toBeTruthy();

        // Run an allowlisted read-only command (replaces the old sh -c pipe test).
        // `wc -c FILE` prints "<count> <file>" — assert the leading numeric count.
        const echoResult = await sandboxMod.runReadOnlyCommand(session, "wc", ["-c", "/etc/hostname"]);
        expect(echoResult.exitCode).toBe(0);
        expect(echoResult.stdout.trim()).toMatch(/^\d+(?:\s|$)/); // leading numeric count

        // Write a file
        await sandboxMod.writeFile(session, "/tmp/test.txt", "hello from probe");

        // Read it back
        const content = await sandboxMod.readFile(session, "/tmp/test.txt");
        expect(content).toBe("hello from probe");

        // List a directory
        const files = await sandboxMod.listDirectory(session, "/tmp");
        expect(files).toContain("test.txt");

        // Non-zero exit code
        const failResult = await sandboxMod.runCommand(session, "false");
        expect(failResult.exitCode).not.toBe(0);
      } finally {
        await sandboxMod.destroySandbox(session);
      }
    });
  });
});
