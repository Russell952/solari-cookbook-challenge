import { describe, it, expect, beforeEach } from "vitest";
import * as budget from "../orchestrator/budget.js";

describe("Budget Manager", () => {
  beforeEach(() => {
    budget.resetBudget("test-inv");
  });

  describe("initBudget", () => {
    it("creates a budget with defaults", () => {
      const b = budget.initBudget("test-inv");
      expect(b.maxExperiments).toBe(7);
      expect(b.maxBrowserActions).toBe(40);
      expect(b.maxSandboxCommands).toBe(20);
      expect(b.maxRuntimeMs).toBe(10 * 60 * 1000);
      expect(b.maxAiCalls).toBe(20);
      expect(b.verificationReserve).toBe(2);
      expect(b.usedExperiments).toBe(0);
      expect(b.usedBrowserActions).toBe(0);
      expect(b.usedSandboxCommands).toBe(0);
      expect(b.usedRuntime).toBe(0);
      expect(b.usedAiCalls).toBe(0);
      expect(b.usedVerificationExperiments).toBe(0);
    });

    it("applies overrides", () => {
      const b = budget.initBudget("test-inv", {
        maxExperiments: 4,
        maxAiCalls: 5,
        verificationReserve: 1,
      });
      expect(b.maxExperiments).toBe(4);
      expect(b.maxAiCalls).toBe(5);
      expect(b.verificationReserve).toBe(1);
      // Others unchanged
      expect(b.maxBrowserActions).toBe(40);
    });
  });

  describe("canConsume", () => {
    it("returns true when budget is available", () => {
      budget.initBudget("test-inv");
      expect(budget.canConsume("test-inv", "experiments")).toBe(true);
      expect(budget.canConsume("test-inv", "browserActions")).toBe(true);
      expect(budget.canConsume("test-inv", "sandboxCommands")).toBe(true);
      expect(budget.canConsume("test-inv", "aiCalls")).toBe(true);
    });

    it("returns false when budget is exhausted", () => {
      budget.initBudget("test-inv", { maxExperiments: 1 });
      budget.consume("test-inv", "experiments");
      expect(budget.canConsume("test-inv", "experiments")).toBe(false);
    });

    it("returns true for unconsumed resources when others are exhausted", () => {
      budget.initBudget("test-inv", { maxExperiments: 1 });
      budget.consume("test-inv", "experiments");
      expect(budget.canConsume("test-inv", "browserActions")).toBe(true);
      expect(budget.canConsume("test-inv", "aiCalls")).toBe(true);
    });
  });

  describe("consume", () => {
    it("increments usage count", () => {
      budget.initBudget("test-inv");
      budget.consume("test-inv", "experiments");
      const b = budget.getBudget("test-inv");
      expect(b.usedExperiments).toBe(1);
    });

    it("increments multiple resources independently", () => {
      budget.initBudget("test-inv");
      budget.consume("test-inv", "browserActions");
      budget.consume("test-inv", "browserActions");
      budget.consume("test-inv", "aiCalls");

      const b = budget.getBudget("test-inv");
      expect(b.usedBrowserActions).toBe(2);
      expect(b.usedAiCalls).toBe(1);
      expect(b.usedExperiments).toBe(0);
    });

    it("returns a copy, not a reference", () => {
      budget.initBudget("test-inv");
      const before = budget.getBudget("test-inv");
      budget.consume("test-inv", "experiments");
      const after = budget.getBudget("test-inv");
      // before is a snapshot, not mutated
      expect(before.usedExperiments).toBe(0);
      expect(after.usedExperiments).toBe(1);
    });

    it("tracks budget exhaustion per dimension", () => {
      budget.initBudget("test-inv", {
        maxExperiments: 2,
        maxBrowserActions: 3,
        maxAiCalls: 1,
      });

      budget.consume("test-inv", "experiments");
      expect(budget.canConsume("test-inv", "experiments")).toBe(true);

      budget.consume("test-inv", "experiments");
      expect(budget.canConsume("test-inv", "experiments")).toBe(false);
      // Other dimensions unaffected
      expect(budget.canConsume("test-inv", "browserActions")).toBe(true);
      expect(budget.canConsume("test-inv", "aiCalls")).toBe(true);
    });
  });

  describe("isExpired", () => {
    it("returns false when runtime is under limit", () => {
      budget.initBudget("test-inv");
      expect(budget.isExpired("test-inv")).toBe(false);
    });

    it("returns true when runtime exceeds limit", () => {
      budget.initBudget("test-inv", { maxRuntimeMs: 100 });
      budget.recordRuntime("test-inv", 150);
      expect(budget.isExpired("test-inv")).toBe(true);
    });
  });

  describe("getBudget (defaults)", () => {
    it("returns default budget for unknown investigation", () => {
      const b = budget.getBudget("nonexistent");
      expect(b.maxExperiments).toBe(7);
      expect(b.usedExperiments).toBe(0);
      expect(b.verificationReserve).toBe(2);
    });
  });

  describe("resetBudget", () => {
    it("clears the budget so next getBudget returns defaults", () => {
      budget.initBudget("test-inv");
      budget.consume("test-inv", "experiments");
      budget.resetBudget("test-inv");
      const b = budget.getBudget("test-inv");
      expect(b.usedExperiments).toBe(0);
    });
  });

  describe("Verification Reserve", () => {
    it("getPrimaryExperimentBudget returns max - reserve", () => {
      budget.initBudget("test-inv", { maxExperiments: 7, verificationReserve: 2 });
      expect(budget.getPrimaryExperimentBudget("test-inv")).toBe(5);
    });

    it("getPrimaryExperimentBudget returns 0 when reserve >= max", () => {
      budget.initBudget("test-inv", { maxExperiments: 2, verificationReserve: 3 });
      expect(budget.getPrimaryExperimentBudget("test-inv")).toBe(0);
    });

    it("getVerificationBudget returns remaining reserve", () => {
      budget.initBudget("test-inv", { verificationReserve: 2 });
      expect(budget.getVerificationBudget("test-inv")).toBe(2);
      budget.consumeVerification("test-inv");
      expect(budget.getVerificationBudget("test-inv")).toBe(1);
      budget.consumeVerification("test-inv");
      expect(budget.getVerificationBudget("test-inv")).toBe(0);
    });

    it("canConsumePrimary blocks when primary budget is exhausted", () => {
      budget.initBudget("test-inv", { maxExperiments: 5, verificationReserve: 2 });
      // Primary budget = 3
      budget.consumePrimary("test-inv");
      budget.consumePrimary("test-inv");
      budget.consumePrimary("test-inv");
      expect(budget.canConsumePrimary("test-inv")).toBe(false);
      // But verification still available
      expect(budget.canConsumeVerification("test-inv")).toBe(true);
    });

    it("canConsumeVerification blocks when reserve is exhausted", () => {
      budget.initBudget("test-inv", { verificationReserve: 1 });
      budget.consumeVerification("test-inv");
      expect(budget.canConsumeVerification("test-inv")).toBe(false);
    });

    it("primary experiments cannot consume verification reserve", () => {
      budget.initBudget("test-inv", { maxExperiments: 3, verificationReserve: 2 });
      // Primary budget = 1
      budget.consumePrimary("test-inv");
      expect(budget.canConsumePrimary("test-inv")).toBe(false);
      // Total used = 1, but verification still has 2 slots
      expect(budget.getVerificationBudget("test-inv")).toBe(2);
    });

    it("consumeVerification increments both usedExperiments and usedVerificationExperiments", () => {
      budget.initBudget("test-inv");
      budget.consumeVerification("test-inv");
      const b = budget.getBudget("test-inv");
      expect(b.usedExperiments).toBe(1);
      expect(b.usedVerificationExperiments).toBe(1);
    });

    it("consumePrimary only increments usedExperiments", () => {
      budget.initBudget("test-inv");
      budget.consumePrimary("test-inv");
      const b = budget.getBudget("test-inv");
      expect(b.usedExperiments).toBe(1);
      expect(b.usedVerificationExperiments).toBe(0);
    });

    it("unused verification reserve is not automatically consumed", () => {
      budget.initBudget("test-inv", { maxExperiments: 5, verificationReserve: 2 });
      // Use 3 primary experiments
      budget.consumePrimary("test-inv");
      budget.consumePrimary("test-inv");
      budget.consumePrimary("test-inv");
      // Verification reserve should still be available
      expect(budget.getVerificationBudget("test-inv")).toBe(2);
      // But primary is exhausted
      expect(budget.canConsumePrimary("test-inv")).toBe(false);
    });

    it("total experiment count never exceeds max", () => {
      budget.initBudget("test-inv", { maxExperiments: 3, verificationReserve: 1 });
      // Primary = 2, verification = 1, total = 3
      budget.consumePrimary("test-inv");
      budget.consumePrimary("test-inv");
      budget.consumeVerification("test-inv");
      // Total = 3 = maxExperiments
      expect(budget.getBudget("test-inv").usedExperiments).toBe(3);
      // Neither primary nor verification should be available
      expect(budget.canConsumePrimary("test-inv")).toBe(false);
      expect(budget.canConsumeVerification("test-inv")).toBe(false);
    });
  });
});
