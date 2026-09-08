/**
 * Browser adapter tests.
 *
 * Uses mocked Solari SDK to test session lifecycle, cleanup, and tracking
 * without requiring a real SOLARI_API_KEY.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store } from "../store/index.js";

// ── Mock setup ─────────────────────────────────────────────────────────────

// Track close calls for verification
const closeCalls: string[] = [];

const downloadListeners: Array<(dl: any) => void> = [];

const mockLocator = {
  count: vi.fn().mockResolvedValue(1),
  first: vi.fn().mockReturnThis(),
  innerText: vi.fn().mockResolvedValue("text"),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
};

const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  title: vi.fn().mockResolvedValue("Test Page"),
  url: vi.fn().mockReturnValue("http://localhost"),
  content: vi.fn().mockResolvedValue("<html></html>"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
  evaluate: vi.fn().mockResolvedValue("result"),
  locator: vi.fn().mockReturnValue(mockLocator),
  waitForSelector: vi.fn().mockResolvedValue(null),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  getByText: vi.fn().mockReturnValue(mockLocator),
  getByLabel: vi.fn().mockReturnValue(mockLocator),
  getByRole: vi.fn().mockReturnValue(mockLocator),
  on: vi.fn((event: string, handler: any) => {
    if (event === "download") downloadListeners.push(handler);
  }),
  removeListener: vi.fn(),
};

const mockContext = {
  pages: vi.fn().mockReturnValue([mockPage]),
  route: vi.fn(async () => {}),
};

const mockBrowserHandle = {
  contexts: vi.fn().mockReturnValue([mockContext]),
  on: vi.fn(),
};

const mockBrowserSession = {
  id: "solari-session-123",
  ...mockBrowserHandle,
  contexts: vi.fn().mockReturnValue([mockContext]),
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockImplementation(async () => {
    closeCalls.push("browserSession.close");
  }),
};

const mockSolari = {
  launch: vi.fn().mockResolvedValue(mockBrowserSession),
  close: vi.fn().mockImplementation(async () => {
    closeCalls.push("solari.close");
  }),
  sessions: {
    downloadReplay: vi.fn().mockResolvedValue(null),
  },
};

// Mock the client module
vi.mock("../solari/client.js", () => ({
  getBrowserSolari: vi.fn().mockReturnValue(mockSolari),
  getSdkClient: vi.fn().mockReturnValue({ sandboxes: { create: vi.fn() } }),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
  activeBrowserSessionCount: vi.fn().mockReturnValue(0),
}));

// Now import the module under test
const browser = await import("../solari/browser.js");

describe("Browser Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeCalls.length = 0;
    downloadListeners.length = 0;
    store.clearAll();
  });

  describe("createBrowserSession", () => {
    it("creates a session with recording enabled by default", async () => {
      const session = await browser.createBrowserSession("inv_1");

      expect(mockSolari.launch).toHaveBeenCalledWith(
        expect.objectContaining({ recording: true })
      );
      expect(session.probeSessionId).toMatch(/^bsess_/);
      expect(session.solariSessionId).toBe("solari-session-123");
      expect(session.recordingEnabled).toBe(true);
    });

    it("creates a session with recording disabled when opted out", async () => {
      await browser.createBrowserSession("inv_1", { recording: false });

      expect(mockSolari.launch).toHaveBeenCalledWith(
        expect.objectContaining({ recording: false })
      );
    });

    it("creates a session in the store", async () => {
      const session = await browser.createBrowserSession("inv_1");
      const stored = store.listSessions("inv_1");

      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(session.probeSessionId);
      expect(stored[0].type).toBe("browser");
      expect(stored[0].status).toBe("active");
    });
  });

  describe("navigate", () => {
    it("navigates and returns title/url", async () => {
      const session = await browser.createBrowserSession("inv_1");
      const result = await browser.navigate(session, "http://example.com");

      expect(mockPage.goto).toHaveBeenCalledWith(
        "http://example.com",
        expect.objectContaining({ waitUntil: "domcontentloaded" })
      );
      expect(result.title).toBe("Test Page");
      expect(result.url).toBe("http://localhost");
    });
  });

  describe("readText", () => {
    it("reads text from a selector", async () => {
      const session = await browser.createBrowserSession("inv_1");
      const text = await browser.readText(session, "h1");
      expect(text).toBe("text");
    });
  });

  describe("click", () => {
    it("clicks an element", async () => {
      const session = await browser.createBrowserSession("inv_1");
      await browser.click(session, "button#submit");
      const locator = mockPage.locator("button#submit");
      expect(locator.click).toHaveBeenCalled();
    });
  });

  describe("type", () => {
    it("types into an element", async () => {
      const session = await browser.createBrowserSession("inv_1");
      await browser.type(session, "input#email", "test@example.com");
      const locator = mockPage.locator("input#email");
      expect(locator.fill).toHaveBeenCalledWith("test@example.com");
    });
  });

  describe("screenshot", () => {
    it("captures a screenshot", async () => {
      const session = await browser.createBrowserSession("inv_1");
      const buf = await browser.screenshot(session);
      expect(buf).toBeInstanceOf(Buffer);
      expect(mockPage.screenshot).toHaveBeenCalledWith({ type: "png" });
    });
  });

  describe("getDomContent", () => {
    it("returns HTML content", async () => {
      const session = await browser.createBrowserSession("inv_1");
      const html = await browser.getDomContent(session);
      expect(html).toBe("<html></html>");
    });
  });

  describe("evaluate", () => {
    it("evaluates JavaScript in the page", async () => {
      const session = await browser.createBrowserSession("inv_1");
      const result = await browser.evaluate(session, "() => 42");
      expect(result).toBe("result");
      expect(mockPage.evaluate).toHaveBeenCalledWith("() => 42");
    });
  });

  describe("closeBrowserSession", () => {
    it("closes the session and updates store", async () => {
      const session = await browser.createBrowserSession("inv_1");

      await browser.closeBrowserSession(session);

      expect(mockBrowserSession.close).toHaveBeenCalled();
      expect(closeCalls).toContain("browserSession.close");

      const stored = store.listSessions("inv_1");
      expect(stored[0].status).toBe("released");
      expect(stored[0].releasedAt).not.toBeNull();
    });

    it("updates store even if close throws", async () => {
      const session = await browser.createBrowserSession("inv_1");
      mockBrowserSession.close.mockRejectedValueOnce(new Error("close failed"));

      // Should not throw
      await browser.closeBrowserSession(session);

      // Store should still be updated in finally block
      const stored = store.listSessions("inv_1");
      expect(stored[0].status).toBe("released");
      expect(stored[0].releasedAt).not.toBeNull();
    });

    it("no tracked sessions remain after close", async () => {
      const session = await browser.createBrowserSession("inv_1");
      await browser.closeBrowserSession(session);

      // Track/untrack are called correctly
      const clientMod = await import("../solari/client.js");
      expect(clientMod.trackBrowserSession).toHaveBeenCalledWith(
        session.probeSessionId
      );
      expect(clientMod.untrackBrowserSession).toHaveBeenCalledWith(
        session.probeSessionId
      );
    });
  });

  describe("getReplay", () => {
    it("returns null if replay not available", async () => {
      mockSolari.sessions.downloadReplay.mockRejectedValue(new Error("404"));
      const result = await browser.getReplay("solari-session-123", 2, 10);
      expect(result).toBeNull();
    });
  });

  // ── Regression: live-Solari run exposed these failure modes ───────────────
  describe("selector timing regressions (live-run defects)", () => {
    it("compound CSS selectors resolve directly instead of falling to text matching", async () => {
      // Live run: `#contactForm > div > button` contains spaces, so the old
      // whitespace-only heuristic routed it through text resolution and every
      // click logged resolvedWith: "recon-fallback". It must use the direct
      // CSS path (locator with the original selector, no recon fallback).
      const session = await browser.createBrowserSession("inv_reg");
      await browser.click(session, "#contactForm > div > button");
      const locator = mockPage.locator("#contactForm > div > button");
      expect(locator.click).toHaveBeenCalled();
    });

    it("waitForElement only treats timeouts as not-found; other errors propagate", async () => {
      // Live run: waitForSelector failures (connection resets, closed targets)
      // were swallowed into "Element not found", hiding the real cause after
      // ~18s of retries. A non-timeout error must surface with its real message.
      const session = await browser.createBrowserSession("inv_reg2");
      mockLocator.count.mockResolvedValue(0); // force resolveTarget past direct CSS
      (mockPage.waitForSelector as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Target page, context or browser has been closed")
      );
      await expect(browser.click(session, "#regression-target")).rejects.toThrow(
        /Target page, context or browser has been closed/
      );
      // restore defaults for later tests
      mockLocator.count.mockResolvedValue(1);
      (mockPage.waitForSelector as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it("waitForSelector timeout still yields the not-found retry path", async () => {
      // The fix must not turn genuine timeouts into crashes. The retry ladder
      // is ~6.3s of real delays, so fake timers drive it instantly.
      vi.useFakeTimers();
      try {
        const session = await browser.createBrowserSession("inv_reg3");
        mockLocator.count.mockResolvedValue(0);
        (mockPage.waitForSelector as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("Timeout 10000ms exceeded waiting for selector")
        );
        const clickPromise = browser.click(session, "#regression-timeout").catch((e) => e);
        await vi.advanceTimersByTimeAsync(10_000);
        const err = (await clickPromise) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/Element not found/);
      } finally {
        vi.useRealTimers();
        mockLocator.count.mockResolvedValue(1);
        (mockPage.waitForSelector as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      }
    });
  });

  // ── Connection-time network policy (DNS-rebinding enforcement) ────────────
  describe("connection-time network policy", () => {
    it("installs a route handler on every existing context at session creation", async () => {
      mockContext.route.mockClear();
      mockBrowserHandle.on.mockClear();
      await browser.createBrowserSession("inv_policy");
      expect(mockContext.route).toHaveBeenCalledTimes(1);
      expect(mockContext.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    });

    it("subscribes to future contexts so new pages cannot bypass the policy", async () => {
      mockBrowserHandle.on.mockClear();
      await browser.createBrowserSession("inv_policy2");
      expect(mockBrowserHandle.on).toHaveBeenCalledWith("context", expect.any(Function));
    });

    it("aborts requests whose host resolves to a private address (rebinding)", async () => {
      let routeHandler: ((route: unknown, request: unknown) => Promise<void>) | null = null;
      mockContext.route.mockImplementation((async (_pattern: string, handler: unknown) => {
        routeHandler = handler as typeof routeHandler;
      }) as () => Promise<void>);
      try {
        await browser.createBrowserSession("inv_policy3");
        expect(routeHandler).not.toBeNull();

        // Simulate a page request to a hostname that (re)resolves to loopback.
        const abort = vi.fn(async () => {});
        const cont = vi.fn(async () => {});
        const realIsPubliclyRoutable = await import("../security/url-validation.js");
        // Point the policy at a hostname we control the verdict for by testing
        // against localhost (always resolves to loopback in every environment).
        await (routeHandler as unknown as (r: unknown, q: unknown) => Promise<void>)(
          { abort, continue: cont },
          { url: () => "http://localhost/steal" }
        );
        expect(abort).toHaveBeenCalled();
        expect(cont).not.toHaveBeenCalled();
        void realIsPubliclyRoutable;
      } finally {
        mockContext.route.mockImplementation(async () => {});
      }
    });

    it("allows requests to genuinely public hosts through the policy", async () => {
      let routeHandler2: ((route: unknown, request: unknown) => Promise<void>) | null = null;
      mockContext.route.mockImplementation((async (_pattern: string, handler: unknown) => {
        routeHandler2 = handler as typeof routeHandler2;
      }) as () => Promise<void>);
      try {
        await browser.createBrowserSession("inv_policy4");
        const abort2 = vi.fn(async () => {});
        const cont2 = vi.fn(async () => {});
        // example.com is a real public host; the policy must let it continue.
        await (routeHandler2 as unknown as (r: unknown, q: unknown) => Promise<void>)(
          { abort: abort2, continue: cont2 },
          { url: () => "https://example.com/" }
        );
        expect(cont2).toHaveBeenCalled();
        expect(abort2).not.toHaveBeenCalled();
      } finally {
        mockContext.route.mockImplementation(async () => {});
      }
    });

    it("fails closed for unresolvable hosts inside the policy handler", async () => {
      // isPubliclyRoutableHost converts resolver failures into a fail-closed
      // verdict, so an unresolvable hostname must abort — never continue.
      let handler3: ((route: unknown, request: unknown) => Promise<void>) | null = null;
      mockContext.route.mockImplementation((async (_pattern: string, handler: unknown) => {
        handler3 = handler as typeof handler3;
      }) as () => Promise<void>);
      try {
        await browser.createBrowserSession("inv_policy5");
        const abort3 = vi.fn(async () => {});
        const cont3 = vi.fn(async () => {});
        await (handler3 as unknown as (r: unknown, q: unknown) => Promise<void>)(
          { abort: abort3, continue: cont3 },
          { url: () => "https://no-such-host-probe-test.invalid/" }
        );
        expect(abort3).toHaveBeenCalled(); // fail closed, never fail open
        expect(cont3).not.toHaveBeenCalled();
      } finally {
        mockContext.route.mockImplementation(async () => {});
      }
    });

    it("passes non-http(s) scheme requests through untouched (scheme policy lives at dispatch)", async () => {
      let handler4: ((route: unknown, request: unknown) => Promise<void>) | null = null;
      mockContext.route.mockImplementation((async (_pattern: string, handler: unknown) => {
        handler4 = handler as typeof handler4;
      }) as () => Promise<void>);
      try {
        await browser.createBrowserSession("inv_policy6");
        const abort4 = vi.fn(async () => {});
        const cont4 = vi.fn(async () => {});
        await (handler4 as unknown as (r: unknown, q: unknown) => Promise<void>)(
          { abort: abort4, continue: cont4 },
          { url: () => "data:text/html,hi" }
        );
        expect(cont4).toHaveBeenCalled();
        expect(abort4).not.toHaveBeenCalled();
      } finally {
        mockContext.route.mockImplementation(async () => {});
      }
    });
  });
});
