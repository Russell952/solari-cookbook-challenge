/**
 * Canonical-target navigation policy tests.
 *
 * Live background: a real investigation against https://app.rayern.com.ng/
 * had an AI-planned action navigate to https://rayern.com/ — a DIFFERENT
 * host that passes every SSRF check (public, https, allowed port). SSRF
 * validation only proves a host is publicly routable; it cannot tell that
 * the navigation left the verified investigation context.
 *
 * These tests pin the canonical-target boundary:
 * - Same host → allowed (any port/path, so in-app navigation works).
 * - Sibling hosts on the same registrable domain → allowed.
 * - A different registrable domain → rejected, naming both origins.
 * - Missing canonical URL → fails closed.
 */
import { describe, it, expect } from "vitest";
import {
  assertNavigationAllowed,
  NavigationPolicyError,
} from "../security/navigation-policy.js";

describe("canonical-target navigation policy", () => {
  it("allows navigation to the exact verified target", () => {
    expect(() =>
      assertNavigationAllowed("https://app.rayern.com.ng/signup", "https://app.rayern.com.ng/")
    ).not.toThrow();
  });

  it("allows same-host navigation on any path", () => {
    expect(() =>
      assertNavigationAllowed(
        "https://app.rayern.com.ng/auth/login?next=/dashboard",
        "https://app.rayern.com.ng/"
      )
    ).not.toThrow();
  });

  it("allows sibling hosts on the same registrable domain", () => {
    expect(() =>
      assertNavigationAllowed("https://rayern.com.ng/pricing", "https://app.rayern.com.ng/")
    ).not.toThrow();
  });

  it("rejects a different registrable domain (the live rayern.com incident)", () => {
    expect(() =>
      assertNavigationAllowed("https://rayern.com/", "https://app.rayern.com.ng/")
    ).toThrow(NavigationPolicyError);
  });

  it("the rejection error names both origins without leaking secrets", () => {
    try {
      assertNavigationAllowed("https://rayern.com/", "https://app.rayern.com.ng/");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NavigationPolicyError);
      const msg = (err as Error).message;
      expect(msg).toContain("https://rayern.com");
      expect(msg).toContain("app.rayern.com.ng");
      expect(msg).toMatch(/outside this investigation/i);
    }
  });

  it("rejects localhost even though SSRF validation would reject it anyway (defense in depth)", () => {
    expect(() =>
      assertNavigationAllowed("http://localhost:8080/admin", "https://app.rayern.com.ng/")
    ).toThrow(NavigationPolicyError);
  });

  it("fails closed when no canonical URL is known", () => {
    expect(() => assertNavigationAllowed("https://app.rayern.com.ng/")).toThrow(
      NavigationPolicyError
    );
  });

  it("fails closed on unparseable targets", () => {
    expect(() => assertNavigationAllowed("not a url", "https://app.rayern.com.ng/")).toThrow(
      NavigationPolicyError
    );
  });

  it("is host-anchored, not scheme- or path-anchored (http target on the verified host is the app's choice)", () => {
    // The SSRF layer separately constrains scheme; the canonical layer only
    // answers "is this the same application context".
    expect(() =>
      assertNavigationAllowed("http://app.rayern.com.ng/status", "https://app.rayern.com.ng/")
    ).not.toThrow();
  });
});
