/**
 * Bounded browser interaction tests.
 *
 * Live background: a real experiment failed with
 * `locator.innerText: Timeout 30000ms exceeded. Call log: waiting for locator('page')`
 * — a model-generated bare-word target ("page") passed the CSS-selector
 * check, every resolution fallback failed, and readText() called innerText()
 * with NO timeout, so Playwright applied its 30s default wait. One bad
 * target cost a third of an experiment's action budget.
 *
 * These tests pin:
 * - innerText waits are explicitly bounded (no 30s default).
 * - fill waits are explicitly bounded.
 * - A bare word target is never handed to locator() as CSS — it fails fast
 *   through the text-resolution path instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLocator = {
  count: vi.fn().mockResolvedValue(0),
  first: vi.fn().mockReturnThis(),
  innerText: vi.fn().mockResolvedValue("text"),
  evaluate: vi.fn().mockResolvedValue(null),
  fill: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn().mockResolvedValue(undefined),
  scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
};

const mockPage = {
  url: vi.fn().mockReturnValue("https://app.example.com/"),
  title: vi.fn().mockResolvedValue("Example"),
  goto: vi.fn().mockResolvedValue(undefined),
  locator: vi.fn().mockReturnValue(mockLocator),
  getByText: vi.fn().mockReturnValue(mockLocator),
  getByLabel: vi.fn().mockReturnValue(mockLocator),
  getByRole: vi.fn().mockReturnValue(mockLocator),
  waitForSelector: vi.fn().mockResolvedValue(null),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
  on: vi.fn(),
  removeListener: vi.fn(),
};

const mockContext = {
  pages: vi.fn().mockReturnValue([]),
  route: vi.fn(async () => {}),
};

const mockBrowserSession = {
  id: "solari-session-123",
  contexts: vi.fn().mockReturnValue([mockContext]),
  newPage: vi.fn().mockResolvedValue(mockPage),
  raw: { on: vi.fn() },
  close: vi.fn().mockResolvedValue(undefined),
};

const mockSolari = {
  launch: vi.fn().mockResolvedValue(mockBrowserSession),
  close: vi.fn().mockResolvedValue(undefined),
  sessions: { downloadReplay: vi.fn().mockResolvedValue(null) },
};

vi.mock("../solari/client.js", () => ({
  getBrowserSolari: vi.fn().mockReturnValue(mockSolari),
  getSdkClient: vi.fn(),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
  activeBrowserSessionCount: vi.fn(() => 0),
  closeAllClients: vi.fn(async () => undefined),
}));
vi.mock("../profiler/index.js", () => ({
  profiler: {
    span: vi.fn((_k: string, _n: string, _m: unknown, fn: () => unknown) => fn()),
    recordRetry: vi.fn(),
  },
  isProfilingEnabled: vi.fn(() => false),
}));

import type { ProbeBrowserSession } from "../solari/browser.js";
import { store } from "../store/index.js";

// Import after the hoisted vi.mock factories have their variables ready.
const browserMod = await import("../solari/browser.js");
const { createBrowserSession, readText, INTERACTION_TIMEOUT_MS } = browserMod;

describe("bounded browser interactions", () => {
  let session: ProbeBrowserSession;

  beforeEach(async () => {
    vi.clearAllMocks();
    store.clearAll();
    mockSolari.launch.mockResolvedValue(mockBrowserSession);
    session = await createBrowserSession("inv_test", { recording: false });
  });

  it("exports an interaction timeout far below Playwright's 30s default", () => {
    expect(INTERACTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(INTERACTION_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("readText applies an explicit timeout to innerText (no 30s default wait)", async () => {
    mockLocator.count.mockResolvedValue(1);
    await readText(session, "#status");
    expect(mockLocator.innerText).toHaveBeenCalledWith({ timeout: INTERACTION_TIMEOUT_MS });
  });

  it("readText never passes a bare word target to locator() as CSS", async () => {
    // "page" matches no element; the resolution path must end in text
    // resolution (getByText), not a raw CSS locator('page') wait.
    await readText(session, "page");
    const locatorTargets = mockPage.locator.mock.calls.map((c) => String(c[0]));
    expect(locatorTargets).not.toContain("page");
    // The failure path resolves through text matching and reports honestly.
    expect(mockPage.getByText).toHaveBeenCalledWith("page", expect.anything());
  });

  it("fill applies an explicit timeout (no 30s default wait)", async () => {
    mockLocator.count.mockResolvedValue(1);
    await browserMod.type(session, "#email", "user@example.com");
    expect(mockLocator.fill).toHaveBeenCalledWith(
      "user@example.com",
      { timeout: INTERACTION_TIMEOUT_MS }
    );
  });

  it("click applies an explicit timeout to both the click and its bounded retries", async () => {
    mockLocator.count.mockResolvedValue(1);
    await browserMod.click(session, "button[type=submit]");
    expect(mockLocator.click).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it("screenshot applies an explicit timeout (no 30s default wait)", async () => {
    mockPage.screenshot = vi.fn().mockResolvedValue(Buffer.from("png"));
    await browserMod.screenshot(session);
    expect(mockPage.screenshot).toHaveBeenCalledWith({
      type: "png",
      timeout: INTERACTION_TIMEOUT_MS,
    });
  });

  it("navigation to an unrelated host is rejected inside the browser adapter (fail closed)", async () => {
    // Fail closed first: no canonical target at all → navigation refused.
    await expect(
      browserMod.navigate(session, "https://app.example.com/signup")
    ).rejects.toThrow(/No verified application URL/);
    expect(mockPage.goto).not.toHaveBeenCalled();

    // Then establish the verified target and confirm the unrelated host is
    // rejected while the canonical target is allowed.
    const inv = store.createInvestigation({
      repositoryUrl: "",
      applicationUrl: "https://app.example.com/",
      objective: "verify canonical-target enforcement at the adapter",
    });
    store.setOwner(inv.id, "tester");
    const ownedSession = await createBrowserSession(inv.id, { recording: false });
    await expect(
      browserMod.navigate(ownedSession, "https://rayern.com/")
    ).rejects.toThrow(/outside this investigation's verified target/);
    // Rejected before reaching the page: no goto happened.
    expect(mockPage.goto).not.toHaveBeenCalled();
  });

  it("navigation to the verified canonical target is allowed", async () => {
    const inv = store.listInvestigations().find(
      (i) => i.applicationUrl === "https://app.example.com/"
    ) ?? store.createInvestigation({
      repositoryUrl: "",
      applicationUrl: "https://app.example.com/",
      objective: "canonical allowed path",
    });
    store.setOwner(inv.id, "tester");
    const ownedSession = await createBrowserSession(inv.id, { recording: false });
    mockPage.goto = vi.fn().mockResolvedValue(undefined);
    await expect(
      browserMod.navigate(ownedSession, "https://app.example.com/signup")
    ).resolves.toMatchObject({ url: expect.any(String) });
    expect(mockPage.goto).toHaveBeenCalled();
  });
});
