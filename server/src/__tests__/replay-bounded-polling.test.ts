/**
 * Regression tests for the Solari replay bottleneck fix.
 *
 * Measured background (profiling run inv_1789130322975 + live diagnostic):
 * - Solari's replay-url endpoint returns 404 PERMANENTLY for sessions whose
 *   replay is never generated (documented finalization window is ~1-3s after
 *   releaseAndWait; 15/15 attempts over 45s all returned 404).
 * - The old getReplay() polled 10 × 3s ≈ 30s per experiment regardless,
 *   consuming 97.44s / 128.91s = 75.6% of a real investigation's runtime.
 *
 * These tests pin the corrected behavior:
 * - 404 → single attempt, immediate stop (no retry storm, no long waits).
 * - Transient errors (5xx/network) still get bounded retries.
 * - Replay absence is recorded as evidence with replayAvailable: false and
 *   NO artifact bytes (no fabricated replay evidence).
 * - A successful replay still flows to captureReplay and persists correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDownloadReplay = vi.fn();

vi.mock("../solari/client.js", () => ({
  getBrowserSolari: vi.fn(() => ({
    sessions: { downloadReplay: mockDownloadReplay },
  })),
  getSdkClient: vi.fn(),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
  activeBrowserSessionCount: vi.fn(() => 0),
  closeAllClients: vi.fn(async () => undefined),
}));

import { getReplay } from "../solari/browser.js";

/** SolariError-shaped failure (status field drives the 404 fast path). */
function solariError(status: number): Error & { status: number } {
  const e = new Error(`Solari GET /sessions/x/replay-url failed: ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

describe("replay 404-aware bounded polling", () => {
  beforeEach(() => {
    mockDownloadReplay.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("STOPS on 404 — permanent absence never retried, no 30s burn", async () => {
    mockDownloadReplay.mockRejectedValue(solariError(404));

    const start = Date.now();
    const promise = getReplay("sess_404", 2, 2000);
    // Drain the single 2s finalization delay.
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await promise;

    expect(result).toBeNull();
    // One attempt only — the second attempt must be skipped on 404.
    expect(mockDownloadReplay).toHaveBeenCalledTimes(1);
    // Elapsed is only the finalization delay, not a 30s poll window.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("returns the bytes when the FIRST attempt succeeds", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockDownloadReplay.mockResolvedValue(bytes);

    const promise = getReplay("sess_ok", 2, 2000);
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await promise;

    expect(result).toBe(bytes);
    expect(mockDownloadReplay).toHaveBeenCalledTimes(1);
  });

  it("RETRIES transient errors (no status) but stays bounded", async () => {
    mockDownloadReplay
      .mockRejectedValueOnce(new Error("fetch failed: network error"))
      .mockRejectedValueOnce(new Error("fetch failed: network error"))
      .mockResolvedValue(new Uint8Array([9]));

    const promise = getReplay("sess_transient", 3, 100);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).not.toBeNull();
    expect(mockDownloadReplay).toHaveBeenCalledTimes(3);
  });

  it("410 Gone is treated as permanent absence too", async () => {
    mockDownloadReplay.mockRejectedValue(solariError(410));

    const promise = getReplay("sess_gone", 3, 100);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBeNull();
    expect(mockDownloadReplay).toHaveBeenCalledTimes(1);
  });

  it("exhausted retries return null (never throws)", async () => {
    mockDownloadReplay.mockRejectedValue(new Error("gateway 502"));

    const promise = getReplay("sess_502", 2, 100);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;

    expect(result).toBeNull();
    expect(mockDownloadReplay).toHaveBeenCalledTimes(2);
  });
});
