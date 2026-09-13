/**
 * Startup recovery for interrupted investigations.
 *
 * An investigation only ever becomes terminal inside the process that runs
 * it — when the server crashes/restarts mid-run, the durable record stays
 * `running` forever and every client sees a phantom Running investigation
 * (regression observed live: the UI stayed on Running with no events while
 * nothing was executing). At startup, before the server accepts requests,
 * any investigation whose status is running/paused and whose run state is
 * not owned by a live in-process runner has definitively lost its runner.
 *
 * `failed` is the correct destination: the shared state machine keeps
 * failed → running legal (resume), unlike cancelled which is terminal.
 */
import { store } from "../store/index.js";
import { hasActiveRunner } from "./runner.js";

/**
 * Terminalize investigations left running/paused by a previous process.
 *
 * @param isLiveRunner predicate answering "does an in-process runner own this
 *        investigation right now?" — defaults to the orchestrator's run-state
 *        registry; injectable for tests.
 */
export function terminalizeOrphanedInvestigations(
  isLiveRunner: (investigationId: string) => boolean = hasActiveRunner
): void {
  for (const inv of store.listInvestigations()) {
    if (inv.status !== "running" && inv.status !== "paused") continue;
    if (isLiveRunner(inv.id)) continue;
    console.warn(
      `[startup] Investigation ${inv.id} was left ${inv.status} by a previous process — marking failed`
    );
    store.updateInvestigation(inv.id, {
      status: "failed",
      failure: {
        reason: "error",
        message:
          "Investigation was interrupted by a server restart before reaching a terminal state.",
        phase: inv.currentPhase,
        at: new Date().toISOString(),
      },
    });
  }
}
