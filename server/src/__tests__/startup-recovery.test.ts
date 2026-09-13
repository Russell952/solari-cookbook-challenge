/**
 * Startup recovery tests.
 *
 * Regression background: a server restart (deploy, crash, platform reschedule)
 * leaves investigations whose runner lived in the old process stuck in
 * `running` forever — no runner will ever finalize them, and every client
 * sees a phantom Running investigation that never progresses.
 *
 * These tests pin the startup sweep:
 * - Orphaned running/paused investigations become failed with an honest
 *   interruption reason recorded in the failure checkpoint.
 * - Terminal and created investigations are untouched.
 * - Investigations owned by a live in-process runner are never touched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../store/index.js";
import { terminalizeOrphanedInvestigations } from "../orchestrator/recovery.js";

function createInvestigation(status: string) {
  const inv = store.createInvestigation({
    repositoryUrl: "https://github.com/example/repo",
    applicationUrl: "https://app.example.com/",
    objective: "Verify the signup flow",
  });
  // createInvestigation starts at created; patch to the status under test.
  return store.updateInvestigation(inv.id, {
    status: status as never,
  });
}

describe("startup orphan-investigation recovery", () => {
  beforeEach(() => {
    store.clearAll();
  });

  it("terminalizes an orphaned running investigation as failed with an honest reason", () => {
    const inv = createInvestigation("running");

    terminalizeOrphanedInvestigations(() => false);

    const after = store.getInvestigation(inv.id)!;
    expect(after.status).toBe("failed");
    expect(after.failure?.reason).toBe("error");
    expect(after.failure?.message).toMatch(/interrupted by a server restart/i);
    expect(after.failure?.phase).toBe(inv.currentPhase);
  });

  it("terminalizes an orphaned paused investigation too", () => {
    const inv = createInvestigation("paused");

    terminalizeOrphanedInvestigations(() => false);

    expect(store.getInvestigation(inv.id)!.status).toBe("failed");
  });

  it("leaves investigations owned by a live in-process runner untouched", () => {
    const inv = createInvestigation("running");

    terminalizeOrphanedInvestigations(() => true);

    expect(store.getInvestigation(inv.id)!.status).toBe("running");
  });

  it("leaves created investigations untouched (not yet started, not orphans)", () => {
    const created = createInvestigation("created");

    terminalizeOrphanedInvestigations(() => false);

    expect(store.getInvestigation(created.id)!.status).toBe("created");
  });

  it("leaves terminal investigations untouched", () => {
    const completed = createInvestigation("completed");
    const failed = createInvestigation("failed");
    const cancelled = createInvestigation("cancelled");

    terminalizeOrphanedInvestigations(() => false);

    expect(store.getInvestigation(completed.id)!.status).toBe("completed");
    expect(store.getInvestigation(failed.id)!.status).toBe("failed");
    expect(store.getInvestigation(cancelled.id)!.status).toBe("cancelled");
  });
});
