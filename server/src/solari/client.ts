/**
 * Solari client wrapper.
 *
 * Probe never calls Solari SDK directly from business logic.
 * All Solari interactions go through this adapter layer.
 *
 * Lifecycle rules (TypeScript Solari):
 * - browserSession.close() is idempotent and releases both the browser
 *   and the Solari session slot (calls releaseAndWait internally).
 * - solari.close() shuts down the loopback proxy. In a long-running
 *   server this is only needed on process exit (SIGTERM/SIGINT).
 * - A single Solari client can safely launch multiple concurrent
 *   browser sessions. There is no need for per-investigation clients.
 * - The loopback proxy must be shut down on exit or the process hangs.
 */
import { Solari } from "@solarisdk/browser";
import { SolariClient } from "@solarisdk/sdk";
import { config } from "../config/index.js";

let browserSolari: Solari | null = null;
let sdkClient: SolariClient | null = null;

/** Active browser session IDs — used for leak detection on shutdown. */
const activeBrowserSessions = new Set<string>();

export function getBrowserSolari(): Solari {
  if (!browserSolari) {
    browserSolari = new Solari({ apiKey: config.solariApiKey });
  }
  return browserSolari;
}

export function getSdkClient(): SolariClient {
  if (!sdkClient) {
    sdkClient = new SolariClient({ apiKey: config.solariApiKey });
  }
  return sdkClient;
}

/**
 * Register an active browser session for tracking.
 */
export function trackBrowserSession(probeSessionId: string): void {
  activeBrowserSessions.add(probeSessionId);
}

/**
 * Unregister a browser session when it is closed.
 */
export function untrackBrowserSession(probeSessionId: string): void {
  activeBrowserSessions.delete(probeSessionId);
}

/**
 * Get the count of active browser sessions.
 */
export function activeBrowserSessionCount(): number {
  return activeBrowserSessions.size;
}

/**
 * Shut down all Solari clients.
 * Must be called on process exit to prevent hangs from the loopback proxy.
 *
 * Logs a warning if there are still active browser sessions — those should
 * have been cleaned up by their owning investigation, but we cannot wait
 * for them on SIGTERM.
 */
export async function closeAllClients(): Promise<void> {
  if (activeBrowserSessions.size > 0) {
    console.warn(
      `⚠️  Closing Solari clients with ${activeBrowserSessions.size} active browser session(s) still tracked.`,
      `These sessions may not have been properly released.`
    );
  }

  const errors: Error[] = [];

  if (browserSolari) {
    try {
      await browserSolari.close();
    } catch (e) {
      errors.push(e as Error);
    }
    browserSolari = null;
  }

  // SolariClient (@solarisdk/sdk) does not expose a close method
  sdkClient = null;
  activeBrowserSessions.clear();

  if (errors.length > 0) {
    console.error("Errors closing Solari clients:", errors);
  }
}
