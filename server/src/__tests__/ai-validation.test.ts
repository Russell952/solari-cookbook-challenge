/**
 * AI adapter validation tests.
 *
 * These tests verify that:
 * 1. AI output is parsed from JSON correctly
 * 2. Malformed JSON is rejected
 * 3. Structurally invalid output is caught
 * 4. Unexpected fields don't silently become trusted domain objects
 * 5. The orchestrator (not the AI) is authoritative
 */
import { describe, it, expect } from "vitest";

// ── parseJSON helper (extracted from openai.ts for testability) ────────────
// We test the actual parsing logic without needing an AI API key.

function parseJSON<T>(text: string): T {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const raw = match ? match[1] : text;
  return JSON.parse(raw.trim()) as T;
}

describe("AI JSON Parsing", () => {
  describe("parseJSON", () => {
    it("parses plain JSON", () => {
      const result = parseJSON<{ value: number }>(`{"value": 42}`);
      expect(result.value).toBe(42);
    });

    it("parses JSON in markdown code blocks", () => {
      const result = parseJSON<{ value: number }>(
        '```json\n{"value": 42}\n```'
      );
      expect(result.value).toBe(42);
    });

    it("parses JSON in bare code blocks", () => {
      const result = parseJSON<{ value: number }>(
        '```\n{"value": 42}\n```'
      );
      expect(result.value).toBe(42);
    });

    it("parses JSON with surrounding text", () => {
      const result = parseJSON<{ value: number }>(
        'Here is the result:\n```json\n{"value": 42}\n```\nDone.'
      );
      expect(result.value).toBe(42);
    });

    it("rejects non-JSON text", () => {
      expect(() => parseJSON("not json at all")).toThrow();
    });

    it("rejects truncated JSON", () => {
      expect(() => parseJSON('{"value": 42')).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => parseJSON("")).toThrow();
    });

    it("rejects empty code block", () => {
      expect(() => parseJSON("```\n```")).toThrow();
    });
  });
});

describe("AI Output Structure Validation", () => {
  // Simulate validation that the orchestrator should perform on AI output.
  // This is the pipeline: AI response → parse → validate → trusted object.

  interface AIPlanResult {
    experiments: {
      objective: string;
      preconditions: string[];
      plannedActions: {
        tool: string;
        action: string;
        target: string;
        input?: Record<string, unknown>;
      }[];
    }[];
  }

  function validatePlanResult(data: unknown): AIPlanResult {
    if (typeof data !== "object" || data === null) {
      throw new Error("AI response is not an object");
    }
    const obj = data as Record<string, unknown>;

    if (!Array.isArray(obj.experiments)) {
      throw new Error("Missing or invalid 'experiments' array");
    }

    for (const exp of obj.experiments) {
      if (typeof exp !== "object" || exp === null) {
        throw new Error("Invalid experiment entry");
      }
      const e = exp as Record<string, unknown>;
      if (typeof e.objective !== "string") {
        throw new Error("Experiment missing string 'objective'");
      }
      if (!Array.isArray(e.preconditions)) {
        throw new Error("Experiment missing 'preconditions' array");
      }
      if (!Array.isArray(e.plannedActions)) {
        throw new Error("Experiment missing 'plannedActions' array");
      }

      for (const action of e.plannedActions) {
        if (typeof action !== "object" || action === null) {
          throw new Error("Invalid plannedAction entry");
        }
        const a = action as Record<string, unknown>;
        if (!["browser", "sandbox", "git"].includes(a.tool as string)) {
          throw new Error(`Invalid tool: ${a.tool}`);
        }
        if (typeof a.action !== "string") {
          throw new Error("Action missing 'action' string");
        }
        // Validate action is valid for the tool
        const validActionsByTool: Record<string, string[]> = {
          browser: ["launch", "navigate", "click", "type", "readText", "screenshot", "getTitle"],
          sandbox: ["runCommand"],
          git: ["cloneRepo"],
        };
        if (validActionsByTool[a.tool as string] && !validActionsByTool[a.tool as string].includes(a.action as string)) {
          throw new Error(`Action '${a.action}' is not valid for tool '${a.tool}'`);
        }
        if (typeof a.target !== "string") {
          throw new Error("Action missing 'target' string");
        }
      }
    }

    // Strip unknown fields — only return what we validated
    return {
      experiments: obj.experiments.map((exp: Record<string, unknown>) => ({
        objective: exp.objective,
        preconditions: exp.preconditions,
        plannedActions: (exp.plannedActions as Record<string, unknown>[]).map((a: Record<string, unknown>) => ({
          tool: a.tool,
          action: a.action,
          target: a.target,
          ...(a.input !== undefined ? { input: a.input } : {}),
        })),
      })),
    } as AIPlanResult;
  }

  it("accepts valid plan output", () => {
    const input = {
      experiments: [
        {
          objective: "Test login flow",
          preconditions: ["App is running"],
          plannedActions: [
            { tool: "browser", action: "navigate", target: "http://example.com" },
          ],
        },
      ],
    };
    const result = validatePlanResult(input);
    expect(result.experiments).toHaveLength(1);
    expect(result.experiments[0].objective).toBe("Test login flow");
  });

  it("rejects non-object response", () => {
    expect(() => validatePlanResult(null)).toThrow("not an object");
    expect(() => validatePlanResult("string")).toThrow("not an object");
    expect(() => validatePlanResult(42)).toThrow("not an object");
  });

  it("rejects missing experiments array", () => {
    expect(() => validatePlanResult({})).toThrow("Missing or invalid");
    expect(() => validatePlanResult({ experiments: "not array" })).toThrow(
      "Missing or invalid"
    );
  });

  it("rejects experiment with non-string objective", () => {
    const input = {
      experiments: [
        {
          objective: 123,
          preconditions: [],
          plannedActions: [],
        },
      ],
    };
    expect(() => validatePlanResult(input)).toThrow("missing string 'objective'");
  });

  it("rejects invalid tool value", () => {
    const input = {
      experiments: [
        {
          objective: "test",
          preconditions: [],
          plannedActions: [
            { tool: "terminal", action: "run", target: "rm -rf /" },
          ],
        },
      ],
    };
    expect(() => validatePlanResult(input)).toThrow("Invalid tool: terminal");
  });

  it("rejects missing action string", () => {
    const input = {
      experiments: [
        {
          objective: "test",
          preconditions: [],
          plannedActions: [
            { tool: "browser", target: "http://example.com" },
          ],
        },
      ],
    };
    expect(() => validatePlanResult(input)).toThrow("missing 'action'");
  });

  it("ignores extra fields silently (does not trust them)", () => {
    const input = {
      experiments: [],
      // AI might hallucinate extra fields
      investigationId: "injected-value",
      status: "confirmed",
      budget: { maxExperiments: 999 },
    };
    const result = validatePlanResult(input);
    // The validation only extracts what we expect
    expect(result).not.toHaveProperty("investigationId");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("budget");
  });
});

describe("AI Hypothesis Validation", () => {
  interface HypothesisResult {
    statement: string;
    confidence: number;
    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
  }

  function validateHypothesis(data: unknown): HypothesisResult {
    if (typeof data !== "object" || data === null) {
      throw new Error("AI response is not an object");
    }
    const obj = data as Record<string, unknown>;

    if (typeof obj.statement !== "string" || obj.statement.length === 0) {
      throw new Error("Missing or empty 'statement'");
    }
    if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
      throw new Error("'confidence' must be a number between 0 and 1");
    }
    if (!Array.isArray(obj.supportingEvidenceIds)) {
      throw new Error("Missing 'supportingEvidenceIds' array");
    }
    if (!Array.isArray(obj.contradictingEvidenceIds)) {
      throw new Error("Missing 'contradictingEvidenceIds' array");
    }

    return {
      statement: obj.statement,
      confidence: obj.confidence,
      supportingEvidenceIds: obj.supportingEvidenceIds as string[],
      contradictingEvidenceIds: obj.contradictingEvidenceIds as string[],
    };
  }

  it("accepts valid hypothesis", () => {
    const result = validateHypothesis({
      statement: "The login form validates email",
      confidence: 0.85,
      supportingEvidenceIds: ["ev_1", "ev_2"],
      contradictingEvidenceIds: [],
    });
    expect(result.confidence).toBe(0.85);
  });

  it("rejects out-of-range confidence", () => {
    expect(() =>
      validateHypothesis({
        statement: "test",
        confidence: 1.5,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      })
    ).toThrow("between 0 and 1");

    expect(() =>
      validateHypothesis({
        statement: "test",
        confidence: -0.1,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      })
    ).toThrow("between 0 and 1");
  });

  it("rejects empty statement", () => {
    expect(() =>
      validateHypothesis({
        statement: "",
        confidence: 0.5,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      })
    ).toThrow("empty 'statement'");
  });

  it("rejects non-array evidence IDs", () => {
    expect(() =>
      validateHypothesis({
        statement: "test",
        confidence: 0.5,
        supportingEvidenceIds: "not-array",
        contradictingEvidenceIds: [],
      })
    ).toThrow("Missing 'supportingEvidenceIds'");
  });

  it("does not trust AI-returned 'status' or 'id' fields", () => {
    const result = validateHypothesis({
      statement: "test",
      confidence: 0.5,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      // AI hallucinations
      id: "injected",
      status: "confirmed",
      investigationId: "injected",
    });
    // The validated result has no id or status — only the orchestrator sets those
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("status");
  });
});

describe("AI Report Validation", () => {
  interface ReportResult {
    summary: string;
    confirmedFindings: {
      title: string;
      severity: string;
      description: string;
    }[];
    rejectedHypotheses: string[];
    inconclusiveHypotheses: string[];
  }

  function validateReport(data: unknown): ReportResult {
    if (typeof data !== "object" || data === null) {
      throw new Error("AI response is not an object");
    }
    const obj = data as Record<string, unknown>;

    if (typeof obj.summary !== "string") {
      throw new Error("Missing 'summary' string");
    }
    if (!Array.isArray(obj.confirmedFindings)) {
      throw new Error("Missing 'confirmedFindings' array");
    }
    if (!Array.isArray(obj.rejectedHypotheses)) {
      throw new Error("Missing 'rejectedHypotheses' array");
    }
    if (!Array.isArray(obj.inconclusiveHypotheses)) {
      throw new Error("Missing 'inconclusiveHypotheses' array");
    }

    // Validate each finding
    for (const f of obj.confirmedFindings) {
      if (typeof f !== "object" || f === null) throw new Error("Invalid finding");
      const finding = f as Record<string, unknown>;
      if (typeof finding.title !== "string") throw new Error("Finding missing 'title'");
      if (!["critical", "high", "medium", "low", "info"].includes(finding.severity as string)) {
        throw new Error(`Invalid severity: ${finding.severity}`);
      }
      if (typeof finding.description !== "string") throw new Error("Finding missing 'description'");
    }

    // Strip unknown fields — only return what we validated
    return {
      summary: obj.summary,
      confirmedFindings: (obj.confirmedFindings as Record<string, unknown>[]).map((f) => ({
        title: f.title,
        severity: f.severity,
        description: f.description,
      })),
      rejectedHypotheses: obj.rejectedHypotheses,
      inconclusiveHypotheses: obj.inconclusiveHypotheses,
    } as ReportResult;
  }

  it("accepts valid report", () => {
    const result = validateReport({
      summary: "Investigation found 1 critical issue",
      confirmedFindings: [
        { title: "XSS vulnerability", severity: "critical", description: "..." },
      ],
      rejectedHypotheses: [],
      inconclusiveHypotheses: ["Feature X works as expected"],
    });
    expect(result.confirmedFindings).toHaveLength(1);
  });

  it("rejects invalid severity", () => {
    expect(() =>
      validateReport({
        summary: "test",
        confirmedFindings: [
          { title: "X", severity: "P0", description: "..." },
        ],
        rejectedHypotheses: [],
        inconclusiveHypotheses: [],
      })
    ).toThrow("Invalid severity");
  });

  it("rejects AI-injected fields on findings", () => {
    const result = validateReport({
      summary: "test",
      confirmedFindings: [
        {
          title: "X",
          severity: "high",
          description: "...",
          id: "injected",
          investigationId: "injected",
          createdAt: "injected",
          recommendation: "accepted", // not in our validated schema
        },
      ],
      rejectedHypotheses: [],
      inconclusiveHypotheses: [],
    });
    // The validated structure only includes what we expect
    const finding = result.confirmedFindings[0];
    expect(finding).not.toHaveProperty("id");
    expect(finding).not.toHaveProperty("investigationId");
  });
});
