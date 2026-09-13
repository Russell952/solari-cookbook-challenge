/**
 * Failure classification: Probe limitation vs. application evidence.
 *
 * Evidence integrity rule: an investigation must never present a Probe-side
 * limitation as a finding about the application under test. When a browser
 * interaction times out on a target that was never proven to exist, or a
 * navigation is rejected by the canonical-target policy, the failure says
 * exactly what happened and where the limitation lies.
 *
 * Raw Playwright/HTTP error text is preserved verbatim elsewhere (action
 * error field keeps the classified message only when it is a probe
 * limitation; everything else passes through unmodified).
 */

/** Detects failures caused by Probe's own bounds/policy — not app behavior. */
export function isProbeLimitationError(message: string): boolean {
  // Navigation-policy rejections (canonical-target boundary). The policy
  // error text is "Navigation to <origin> is outside this investigation's
  // verified target (...)".
  if (message.includes("is outside this investigation's verified target")) return true;
  if (message.includes("No verified application URL is associated")) return true;

  // Bounded interaction timeouts on an unresolvable target: Playwright's
  // message contains "waiting for locator('...')". A target that never
  // resolved is not proven broken — it was never found. Raw text is
  // preserved in the classified detail.
  if (/Timeout \d+ms exceeded/.test(message) && message.includes("waiting for locator(")) {
    return true;
  }

  return false;
}

/** Human-readable, honest classification for probe-limitation failures. */
export function classifyActionError(rawMessage: string): string {
  const raw = rawMessage.slice(0, 300);

  if (
    rawMessage.includes("is outside this investigation's verified target") ||
    rawMessage.includes("No verified application URL is associated")
  ) {
    return `Probe limitation (navigation policy): the AI planned a navigation outside the verified investigation target. ${raw}`;
  }

  if (rawMessage.includes("waiting for locator(")) {
    return `Probe limitation (target not resolved): the planned target never resolved to an element within Probe's bounded interaction timeout, so no conclusion can be drawn about the application. ${raw}`;
  }

  return rawMessage;
}
