/**
 * Canonical-target navigation policy.
 *
 * SSRF validation (url-validation.ts) proves a URL points at a publicly
 * routable host — it does NOT prove the navigation belongs to the current
 * investigation. Because the AI plans navigate targets, a plausible-looking
 * host from training memory (observed live: verified target
 * https://app.rayern.com.ng, model navigated to https://rayern.com/) lets an
 * experiment silently leave the verified investigation context.
 *
 * Policy (same-site scope, host-anchored, fail closed):
 *   - The investigation's applicationUrl is the root of the allowed space.
 *     Any URL on its exact host — any port, any path — is allowed, so in-app
 *     navigation (marketing → app, /login → /signup) works.
 *   - Sibling hosts under the SAME registrable domain are allowed: the
 *     registrable domain is derived with a small multi-part-suffix list so
 *     e.g. app.rayern.com.ng and rayern.com share the site rayern.com.ng
 *     (a ccTLD like .com.ng is a public suffix — the naive last-two-labels
 *     heuristic would wrongly compare app.rayern.com.ng as com.ng). This
 *     matches the live model behavior of hopping between the marketing
 *     root and the app subdomain of the SAME product site.
 *   - A different registrable domain (rayern.com ≠ rayern.com.ng) is
 *     rejected, naming both origins in the error so the experiment record
 *     shows WHY the navigation was refused.
 *
 * This module is deliberately separate from url-validation.ts: that file
 * stays the pure SSRF/transport policy used for user-supplied input, while
 * this one encodes the per-investigation investigation-context binding that
 * only exists once a canonical target has been verified.
 */

export class NavigationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigationPolicyError";
  }
}

/**
 * Extract a comparable registrable host.
 *
 * The classic public-suffix list is deliberately not pulled in: Probe's
 * targets are user-verified application URLs, and the heuristic below is
 * only used to keep multi-level hosts on the SAME site navigable
 * (a.example.com → b.example.com).
 *
 * Heuristic: treat the last TWO labels as registrable, but additionally
 * strip known multi-part public suffixes (co.uk, com.ng, com.au, …) so
 * that e.g. app.rayern.com.ng compares as rayern.com.ng. The suffix list
 * below is a small, explicit allowlist — never a source of permissiveness
 * beyond the intended same-site rule; anything unknown keeps the strict
 * last-two-labels behavior, and the canonical host is ALWAYS allowed.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.nz", "co.za",
  "com.au", "com.br", "com.ng", "com.gh", "com.ke", "com.eg",
  "com.ar", "com.mx", "com.tr", "com.cn", "com.hk", "com.sg",
  "com.my", "com.ph", "com.pk", "com.bd", "co.in", "co.il",
]);

function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** Normalize a URL string for comparison; returns null when unparseable. */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Assert that a navigation target stays within the investigation's verified
 * application scope. Throws NavigationPolicyError when it does not.
 *
 * @param target       the navigation target the AI planned
 * @param canonicalUrl the investigation's verified applicationUrl; when
 *                     absent (never expected in a real run) the check
 *                     fails closed
 */
export function assertNavigationAllowed(target: string, canonicalUrl?: string): void {
  if (!canonicalUrl) {
    throw new NavigationPolicyError(
      "No verified application URL is associated with this investigation — navigation outside the verified target is not allowed"
    );
  }

  const targetUrl = parseUrl(target);
  const canonical = parseUrl(canonicalUrl);
  if (!targetUrl || !canonical) {
    throw new NavigationPolicyError("Navigation target is not a valid URL");
  }

  const targetHost = targetUrl.hostname.toLowerCase();
  const canonicalHost = canonical.hostname.toLowerCase();

  const sameHost = targetHost === canonicalHost;
  const sameSite =
    !sameHost && registrableDomain(targetHost) === registrableDomain(canonicalHost);

  if (sameHost || sameSite) return;

  throw new NavigationPolicyError(
    `Navigation to ${targetUrl.origin} is outside this investigation's verified target (${canonical.protocol}//${canonical.host}). ` +
      `The AI may only navigate within the application under investigation.`
  );
}
