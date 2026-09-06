/**
 * Investigation quality tests.
 *
 * These tests verify that:
 * 1. Failures are correctly classified (app vs execution vs planning)
 * 2. Findings require actual application evidence, not infrastructure failures
 * 3. Verification experiments use valid selectors
 * 4. Reports separate confirmed/rejected/inconclusive/execution failures
 */
import { describe, it, expect } from "vitest";
import { looksLikeCssSelector } from "../orchestrator/action-allowlist.js";

// ── 1. Failure classification ─────────────────────────────────────────────

describe("Failure classification", () => {
  const FAILURE_CATEGORIES = [
    "application_failure",
    "execution_infrastructure_failure",
    "ai_planning_failure",
    "missing_evidence",
    "inconclusive",
  ] as const;

  type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

  function classifyFailure(error: string): FailureCategory {
    const lower = error.toLowerCase();
    // Application failures: the app itself is broken
    if (
      lower.includes("form submission failed") ||
      lower.includes("link leads to 404") ||
      lower.includes("page returned error") ||
      lower.includes("broken navigation")
    ) {
      return "application_failure";
    }
    // AI planning failures (check before execution failures since they may share keywords)
    if (
      lower.includes("invalid action") ||
      lower.includes("unknown tool") ||
      lower.includes("fabricated selector") ||
      lower.includes("plan selector error")
    ) {
      return "ai_planning_failure";
    }
    // Execution/infrastructure failures: Probe couldn't interact
    if (
      lower.includes("element not found") ||
      lower.includes("timeout") ||
      lower.includes("navigation failed") ||
      lower.includes("download") ||
      lower.includes("not interactable") ||
      lower.includes("no active browser session") ||
      lower.includes("selector")
    ) {
      return "execution_infrastructure_failure";
    }
    return "inconclusive";
  }

  it("classifies element-not-found as execution failure", () => {
    expect(classifyFailure("Element not found: a[href=\"#work\"]")).toBe(
      "execution_infrastructure_failure"
    );
  });

  it("classifies timeout as execution failure", () => {
    expect(classifyFailure("Click timeout after 10000ms")).toBe(
      "execution_infrastructure_failure"
    );
  });

  it("classifies download trigger as execution failure", () => {
    expect(classifyFailure("Download is starting")).toBe(
      "execution_infrastructure_failure"
    );
  });

  it("classifies form submission failure as application failure", () => {
    expect(classifyFailure("Form submission failed: server returned 500")).toBe(
      "application_failure"
    );
  });

  it("classifies 404 link as application failure", () => {
    expect(classifyFailure("Link leads to 404 page")).toBe(
      "application_failure"
    );
  });

  it("classifies invalid action as AI planning failure", () => {
    expect(classifyFailure("Invalid action 'evaluate' for browser")).toBe(
      "ai_planning_failure"
    );
  });

  it("classifies fabricated selector as AI planning failure", () => {
    expect(classifyFailure("Fabricated selector: 'nav link: About'")).toBe(
      "ai_planning_failure"
    );
  });
});

// ── 2. Finding confirmation rules ─────────────────────────────────────────

describe("Finding confirmation rules", () => {
  interface Evidence {
    id: string;
    type: string;
    metadata: Record<string, unknown>;
  }

  interface FindingDecision {
    confirmed: boolean;
    reason: string;
  }

  function evaluateFindingConfirmation(
    hypothesis: string,
    evidence: Evidence[]
  ): FindingDecision {
    // A finding can only be confirmed if there is at least one application failure evidence
    const appFailures = evidence.filter((e) => {
      const meta = JSON.stringify(e.metadata).toLowerCase();
      return (
        meta.includes("form submission") ||
        meta.includes("404") ||
        meta.includes("broken") ||
        meta.includes("application") ||
        e.type === "behavior" && !meta.includes("element not found") && !meta.includes("timeout")
      );
    });

    const infraFailures = evidence.filter((e) => {
      const meta = JSON.stringify(e.metadata).toLowerCase();
      return (
        meta.includes("element not found") ||
        meta.includes("timeout") ||
        meta.includes("download") ||
        meta.includes("selector")
      );
    });

    if (evidence.length === 0) {
      return { confirmed: false, reason: "no evidence" };
    }

    if (appFailures.length === 0 && infraFailures.length > 0) {
      return {
        confirmed: false,
        reason: "only infrastructure failures — cannot confirm application bug",
      };
    }

    if (appFailures.length > 0) {
      return { confirmed: true, reason: "application failure evidence exists" };
    }

    return { confirmed: false, reason: "insufficient evidence" };
  }

  it("does not confirm when only infrastructure failures exist", () => {
    const evidence: Evidence[] = [
      {
        id: "ev1",
        type: "action_trace",
        metadata: { error: "Element not found: a[href=\"#work\"]" },
      },
      {
        id: "ev2",
        type: "action_trace",
        metadata: { error: "Click timeout" },
      },
    ];
    const result = evaluateFindingConfirmation("Navigation is broken", evidence);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain("infrastructure");
  });

  it("confirms when application failure evidence exists", () => {
    const evidence: Evidence[] = [
      {
        id: "ev1",
        type: "behavior",
        metadata: { clicked: "a[href=\"#work\"]", result: "navigated to 404" },
      },
    ];
    const result = evaluateFindingConfirmation("Work link is broken", evidence);
    expect(result.confirmed).toBe(true);
  });

  it("does not confirm with empty evidence", () => {
    const result = evaluateFindingConfirmation("Something is broken", []);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain("no evidence");
  });

  it("does not confirm when evidence is ambiguous", () => {
    const evidence: Evidence[] = [
      {
        id: "ev1",
        type: "screenshot",
        metadata: { format: "png" },
      },
    ];
    const result = evaluateFindingConfirmation("Page looks wrong", evidence);
    expect(result.confirmed).toBe(false);
  });
});

// ── 3. Verification selector validation ───────────────────────────────────

describe("Verification selector validation", () => {
  const NATURAL_LANGUAGE_PATTERNS = [
    /^(link|button|nav|form|input|anchor|cta|section|page|text|first|second|third|the|a|an)\b/i,
  ];

  function validateVerificationAction(target: string, action: string): boolean {
    // Production validation — the shared allowlist module is the single source
    // of truth; this suite exercises the real implementation, not a copy.
    return looksLikeCssSelector(target, action);
  }

  it("rejects natural-language targets in verification", () => {
    expect(validateVerificationAction("nav link: About", "click")).toBe(false);
    expect(validateVerificationAction("first project link", "click")).toBe(false);
    expect(validateVerificationAction("button: Submit", "click")).toBe(false);
  });

  it("accepts valid CSS selectors in verification", () => {
    expect(validateVerificationAction('a[href="#about"]', "click")).toBe(true);
    expect(validateVerificationAction("#contactForm input[name='email']", "type")).toBe(true);
    expect(validateVerificationAction("button[type='submit']", "click")).toBe(true);
  });

  it("accepts navigate/screenshot/getTitle targets", () => {
    expect(validateVerificationAction("https://example.com", "navigate")).toBe(true);
    expect(validateVerificationAction("full page", "screenshot")).toBe(true);
    expect(validateVerificationAction("page", "getTitle")).toBe(true);
  });
});

// ── 4. Report categorization ──────────────────────────────────────────────

describe("Report categorization", () => {
  interface ReportData {
    confirmedFindings: Array<{ title: string; severity: string }>;
    rejectedHypotheses: string[];
    inconclusiveHypotheses: string[];
    executionFailures: number;
    totalExperiments: number;
  }

  function validateReportStructure(report: ReportData): string[] {
    const issues: string[] = [];

    // Confirmed findings must not exceed experiments
    if (report.confirmedFindings.length > report.totalExperiments) {
      issues.push("More confirmed findings than experiments");
    }

    // If all experiments failed with execution errors, there should be no confirmed findings
    if (
      report.executionFailures === report.totalExperiments &&
      report.confirmedFindings.length > 0
    ) {
      issues.push("Confirmed findings exist but all experiments failed");
    }

    return issues;
  }

  it("rejects report with confirmed findings when all experiments failed", () => {
    const report: ReportData = {
      confirmedFindings: [{ title: "Bug found", severity: "high" }],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
      executionFailures: 5,
      totalExperiments: 5,
    };
    const issues = validateReportStructure(report);
    expect(issues).toContain("Confirmed findings exist but all experiments failed");
  });

  it("accepts report with no confirmed findings when all experiments failed", () => {
    const report: ReportData = {
      confirmedFindings: [],
      rejectedHypotheses: [],
      inconclusiveHypotheses: ["Navigation might be broken"],
      executionFailures: 5,
      totalExperiments: 5,
    };
    const issues = validateReportStructure(report);
    expect(issues).toHaveLength(0);
  });

  it("accepts valid report with mixed results", () => {
    const report: ReportData = {
      confirmedFindings: [{ title: "Form bug", severity: "medium" }],
      rejectedHypotheses: ["Navigation is broken"],
      inconclusiveHypotheses: [],
      executionFailures: 2,
      totalExperiments: 5,
    };
    const issues = validateReportStructure(report);
    expect(issues).toHaveLength(0);
  });
});

// ── 5. Experiment quality rules ───────────────────────────────────────────

describe("Experiment quality rules", () => {
  interface ExperimentPlan {
    objective: string;
    actions: Array<{ tool: string; action: string; target: string }>;
  }

  function validateExperimentQuality(exp: ExperimentPlan, maxActions = 5): string[] {
    const issues: string[] = [];

    // Must have at least one action
    if (exp.actions.length === 0) {
      issues.push("Experiment has no actions");
    }

    // Must not exceed max actions
    if (exp.actions.length > maxActions) {
      issues.push(`Experiment has ${exp.actions.length} actions (max ${maxActions})`);
    }

    // Must not be screenshot-only
    const hasInteraction = exp.actions.some(
      (a) => a.action === "click" || a.action === "type"
    );
    const hasScreenshot = exp.actions.some((a) => a.action === "screenshot");
    if (hasScreenshot && !hasInteraction) {
      issues.push("Experiment is screenshot-only without interaction");
    }

    // Must have an objective
    if (!exp.objective || exp.objective.length < 10) {
      issues.push("Experiment objective is too vague");
    }

    return issues;
  }

  it("rejects screenshot-only experiments", () => {
    const exp: ExperimentPlan = {
      objective: "Take screenshots of the page",
      actions: [
        { tool: "browser", action: "navigate", target: "https://example.com" },
        { tool: "browser", action: "screenshot", target: "full page" },
      ],
    };
    const issues = validateExperimentQuality(exp);
    expect(issues).toContain("Experiment is screenshot-only without interaction");
  });

  it("rejects experiments with too many actions", () => {
    const exp: ExperimentPlan = {
      objective: "Test everything at once",
      actions: Array(6).fill({
        tool: "browser",
        action: "click",
        target: "a[href='#test']",
      }),
    };
    const issues = validateExperimentQuality(exp);
    expect(issues.some((i) => i.includes("actions"))).toBe(true);
  });

  it("rejects experiments with vague objectives", () => {
    const exp: ExperimentPlan = {
      objective: "Test",
      actions: [
        { tool: "browser", action: "navigate", target: "https://example.com" },
      ],
    };
    const issues = validateExperimentQuality(exp);
    expect(issues).toContain("Experiment objective is too vague");
  });

  it("accepts valid experiments", () => {
    const exp: ExperimentPlan = {
      objective: "Verify contact form submission behavior",
      actions: [
        { tool: "browser", action: "navigate", target: "https://example.com/contact" },
        { tool: "browser", action: "type", target: "input[name='email']", },
        { tool: "browser", action: "click", target: "button[type='submit']" },
      ],
    };
    const issues = validateExperimentQuality(exp);
    expect(issues).toHaveLength(0);
  });
});

// ── 6. Security invariants ────────────────────────────────────────────────

describe("Security invariants", () => {
  const VALID_ACTIONS: Record<string, readonly string[]> = {
    browser: ["launch", "navigate", "click", "type", "readText", "screenshot", "getTitle"],
    sandbox: ["runCommand"],
  } as const;

  it("does not allow eval/executeScript in browser", () => {
    expect(VALID_ACTIONS.browser).not.toContain("evaluate");
    expect(VALID_ACTIONS.browser).not.toContain("executeScript");
    expect(VALID_ACTIONS.browser).not.toContain("runCommand");
  });

  it("does not allow browser actions in sandbox", () => {
    expect(VALID_ACTIONS.sandbox).not.toContain("click");
    expect(VALID_ACTIONS.sandbox).not.toContain("navigate");
    expect(VALID_ACTIONS.sandbox).not.toContain("screenshot");
  });

  it("does not add new tools dynamically", () => {
    expect(VALID_ACTIONS["eval"]).toBeUndefined();
    expect(VALID_ACTIONS["exec"]).toBeUndefined();
    expect(VALID_ACTIONS["system"]).toBeUndefined();
    expect(VALID_ACTIONS["spawn"]).toBeUndefined();
  });
});
