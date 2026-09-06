/**
 * Real Solari integration tests.
 *
 * These tests require SOLARI_API_KEY to be set.
 * They test the actual browser and sandbox adapters against the real Solari API.
 *
 * Run with: SOLARI_API_KEY=slr_live_... bun test integration
 * Skip if no key: bun test --reporter=basic (they skip themselves)
 */
import { describe, it, expect, beforeAll } from "vitest";

const SOLARI_API_KEY = process.env.SOLARI_API_KEY || "";

const maybeDescribe = SOLARI_API_KEY ? describe : describe.skip;

// ── Browser Integration ────────────────────────────────────────────────────

maybeDescribe("Real Solari Browser", () => {
  let browserMod: typeof import("../solari/browser.js");

  beforeAll(async () => {
    browserMod = await import("../solari/browser.js");
  });

  it("creates a session, navigates, reads text, takes screenshot, and closes", async () => {
    const session = await browserMod.createBrowserSession("integration-test", {
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

// ── Sandbox Integration ────────────────────────────────────────────────────

maybeDescribe("Real Solari Sandbox", () => {
  let sandboxMod: typeof import("../solari/sandbox.js");

  beforeAll(async () => {
    sandboxMod = await import("../solari/sandbox.js");
  });

  it("creates a sandbox, runs commands, writes/reads files, and kills", async () => {
    const session = await sandboxMod.createSandboxSession("integration-test");

    try {
      // Run a simple command
      const lsResult = await sandboxMod.runCommand(session, "ls", ["/"]);
      expect(lsResult.exitCode).toBe(0);
      expect(lsResult.stdout).toBeTruthy();

      // Run an allowlisted read-only command (replaces the old sh -c pipe test)
      const echoResult = await sandboxMod.runReadOnlyCommand(session, "wc", ["-c", "/etc/hostname"]);
      expect(echoResult.exitCode).toBe(0);
      expect(echoResult.stdout.trim()).toMatch(/^\d+$/); // should be a number

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
