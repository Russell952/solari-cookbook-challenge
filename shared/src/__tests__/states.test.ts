import { describe, it, expect } from "vitest";
import type { InvestigationPhase } from "../types.js";
import {
  isValidPhaseTransition,
  isValidStatusTransition,
  transitionPhase,
  transitionStatus,
  InvalidTransitionError,
  PHASE_SEQUENCE,
  nextPhase,
  VALID_PHASE_TRANSITIONS,
  VALID_STATUS_TRANSITIONS,
} from "../states.js";

describe("Phase Transitions", () => {
  describe("isValidPhaseTransition", () => {
    it("allows created → recon", () => {
      expect(isValidPhaseTransition("created", "recon")).toBe(true);
    });

    it("allows recon → plan", () => {
      expect(isValidPhaseTransition("recon", "plan")).toBe(true);
    });

    it("allows the full happy-path sequence", () => {
      // The normal happy path: recon→plan→experiment→execute→observe→analyze→
      // hypothesis→verification→confirmed→report→complete
      // Note: verification goes to confirmed/rejected/inconclusive, not directly to report
      const happyPath: [InvestigationPhase, InvestigationPhase][] = [
        ["created", "recon"],
        ["recon", "plan"],
        ["plan", "experiment"],
        ["experiment", "execute"],
        ["execute", "observe"],
        ["observe", "analyze"],
        ["analyze", "hypothesis"],
        ["hypothesis", "verification"],
        ["verification", "confirmed"],
        ["confirmed", "report"],
        ["report", "complete"],
      ];
      for (const [from, to] of happyPath) {
        expect(isValidPhaseTransition(from, to)).toBe(true);
      }
    });

    it("allows experiment → execute (normal loop)", () => {
      expect(isValidPhaseTransition("experiment", "execute")).toBe(true);
    });

    it("allows hypothesis → experiment (re-experiment)", () => {
      expect(isValidPhaseTransition("hypothesis", "experiment")).toBe(true);
    });

    it("allows verified → report", () => {
      expect(isValidPhaseTransition("confirmed", "report")).toBe(true);
    });

    it("allows rejected → experiment (re-experiment)", () => {
      expect(isValidPhaseTransition("rejected", "experiment")).toBe(true);
    });

    it("allows inconclusive → report", () => {
      expect(isValidPhaseTransition("inconclusive", "report")).toBe(true);
    });

    it("rejects created → complete", () => {
      expect(isValidPhaseTransition("created", "complete")).toBe(false);
    });

    it("rejects complete → anything", () => {
      expect(isValidPhaseTransition("complete", "recon")).toBe(false);
      expect(isValidPhaseTransition("complete", "report")).toBe(false);
    });

    it("rejects reverse transitions", () => {
      expect(isValidPhaseTransition("recon", "created")).toBe(false);
      expect(isValidPhaseTransition("plan", "recon")).toBe(false);
      expect(isValidPhaseTransition("complete", "created")).toBe(false);
    });

    it("rejects skipping phases", () => {
      expect(isValidPhaseTransition("created", "plan")).toBe(false);
      expect(isValidPhaseTransition("created", "execute")).toBe(false);
      expect(isValidPhaseTransition("recon", "execute")).toBe(false);
    });

    it("rejects report → anything except complete", () => {
      expect(isValidPhaseTransition("report", "recon")).toBe(false);
      expect(isValidPhaseTransition("report", "plan")).toBe(false);
    });

    it("allows analyze → experiment (loop back)", () => {
      expect(isValidPhaseTransition("analyze", "experiment")).toBe(true);
    });

    it("allows analyze → report (skip hypothesis if not needed)", () => {
      expect(isValidPhaseTransition("analyze", "report")).toBe(true);
    });
  });

  describe("transitionPhase", () => {
    it("returns the target phase on valid transition", () => {
      expect(transitionPhase("created", "recon")).toBe("recon");
    });

    it("throws InvalidTransitionError on invalid transition", () => {
      expect(() => transitionPhase("created", "complete")).toThrow(
        InvalidTransitionError
      );
    });

    it("throws with correct kind, from, and to", () => {
      try {
        transitionPhase("created", "complete");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidTransitionError);
        const err = e as InvalidTransitionError;
        expect(err.kind).toBe("phase");
        expect(err.from).toBe("created");
        expect(err.to).toBe("complete");
        expect(err.message).toBe("Invalid phase transition: created → complete");
      }
    });
  });

  describe("nextPhase", () => {
    it("returns the next phase in the sequence", () => {
      expect(nextPhase("recon")).toBe("plan");
      expect(nextPhase("plan")).toBe("experiment");
      expect(nextPhase("report")).toBe("complete");
    });

    it("returns null for complete (terminal)", () => {
      expect(nextPhase("complete")).toBeNull();
    });

    it("returns null for phases not in the sequence", () => {
      // Terminal/outcome phases like confirmed/rejected/inconclusive are not in PHASE_SEQUENCE
      expect(nextPhase("confirmed")).toBeNull();
      expect(nextPhase("rejected")).toBeNull();
      expect(nextPhase("inconclusive")).toBeNull();
    });
  });

  describe("All transitions are to valid phases", () => {
    it("every target in VALID_PHASE_TRANSITIONS is a known phase", () => {
      const knownPhases = new Set(Object.keys(VALID_PHASE_TRANSITIONS));
      for (const [from, targets] of Object.entries(VALID_PHASE_TRANSITIONS)) {
        expect(knownPhases.has(from)).toBe(true);
        for (const to of targets) {
          expect(knownPhases.has(to)).toBe(true);
        }
      }
    });
  });
});

describe("Status Transitions", () => {
  describe("isValidStatusTransition", () => {
    it("allows created → running", () => {
      expect(isValidStatusTransition("created", "running")).toBe(true);
    });

    it("allows created → cancelled", () => {
      expect(isValidStatusTransition("created", "cancelled")).toBe(true);
    });

    it("allows running → paused", () => {
      expect(isValidStatusTransition("running", "paused")).toBe(true);
    });

    it("allows running → completed", () => {
      expect(isValidStatusTransition("running", "completed")).toBe(true);
    });

    it("allows running → failed", () => {
      expect(isValidStatusTransition("running", "failed")).toBe(true);
    });

    it("allows running → cancelled", () => {
      expect(isValidStatusTransition("running", "cancelled")).toBe(true);
    });

    it("allows paused → running (resume)", () => {
      expect(isValidStatusTransition("paused", "running")).toBe(true);
    });

    it("allows paused → cancelled", () => {
      expect(isValidStatusTransition("paused", "cancelled")).toBe(true);
    });

    it("allows failed → running (retry)", () => {
      expect(isValidStatusTransition("failed", "running")).toBe(true);
    });

    it("rejects created → paused (must run first)", () => {
      expect(isValidStatusTransition("created", "paused")).toBe(false);
    });

    it("rejects cancelled → anything (terminal)", () => {
      expect(isValidStatusTransition("cancelled", "running")).toBe(false);
      expect(isValidStatusTransition("cancelled", "paused")).toBe(false);
    });

    it("rejects completed → anything (terminal)", () => {
      expect(isValidStatusTransition("completed", "running")).toBe(false);
      expect(isValidStatusTransition("completed", "paused")).toBe(false);
    });

    it("rejects paused → completed (must resume first)", () => {
      expect(isValidStatusTransition("paused", "completed")).toBe(false);
    });

    it("rejects paused → failed (must resume first)", () => {
      expect(isValidStatusTransition("paused", "failed")).toBe(false);
    });
  });

  describe("transitionStatus", () => {
    it("returns the target status on valid transition", () => {
      expect(transitionStatus("created", "running")).toBe("running");
    });

    it("throws InvalidTransitionError on invalid transition", () => {
      expect(() => transitionStatus("created", "paused")).toThrow(
        InvalidTransitionError
      );
    });

    it("throws with correct kind", () => {
      try {
        transitionStatus("created", "paused");
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidTransitionError);
        const err = e as InvalidTransitionError;
        expect(err.kind).toBe("status");
      }
    });
  });

  describe("Terminal states", () => {
    it("cancelled has no outgoing transitions", () => {
      expect(VALID_STATUS_TRANSITIONS.cancelled).toHaveLength(0);
    });

    it("completed has no outgoing transitions", () => {
      expect(VALID_STATUS_TRANSITIONS.completed).toHaveLength(0);
    });
  });
});
