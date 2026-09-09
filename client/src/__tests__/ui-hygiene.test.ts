/**
 * UI hygiene regression tests for the production deployment.
 *
 * These are source-level scans (no DOM infrastructure in this workspace) that
 * guard two launch requirements:
 *
 * 1. No emoji characters used as UI icons — icons must be inline SVG or CSS.
 * 2. No user-facing "backend offline" wording — the header badge must say
 *    "Server offline" (consistent "server" terminology).
 */
/** @vitest-environment node */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const UI_SOURCE_FILES = [
  "src/App.tsx",
  "src/InvestigationView.tsx",
  "src/NewInvestigation.tsx",
  "src/api.ts",
  "src/main.tsx",
  "src/progress.ts",
  "src/InvestigationProgress.tsx",
  "src/icons.tsx",
  "index.html",
];

// Emoji + pictograph blocks (incl. VS16), arrows/dingbats, geometric shapes.
// Covers emoji-as-icon usage across BMP and supplementary planes.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]/gu;

describe("UI hygiene: no emoji used as interface icons", () => {
  for (const file of UI_SOURCE_FILES) {
    it(`has no emoji icons in ${file}`, () => {
      const text = readFileSync(join(clientRoot, file), "utf8");
      const matches = text.match(EMOJI_RE) ?? [];
      expect(matches, `emoji found in ${file}: ${[...new Set(matches)].join(" ")}`).toEqual([]);
    });
  }

  it("renders icons as inline SVG components, not text glyphs", async () => {
    const appSource = readFileSync(join(clientRoot, "src/App.tsx"), "utf8");
    const viewSource = readFileSync(join(clientRoot, "src/InvestigationView.tsx"), "utf8");
    const iconsSource = readFileSync(join(clientRoot, "src/icons.tsx"), "utf8");
    expect(appSource).toContain('from "./icons"');
    expect(viewSource).toContain('from "./icons"');
    expect(iconsSource).toContain("export function SearchIcon");
    expect(iconsSource).toContain("export function ArrowLeftIcon");
    expect(iconsSource).toContain("export function CheckIcon");
  });
});

describe("UI hygiene: server terminology (not backend)", () => {
  it('uses "Server offline" for the connection badge and never "backend offline"', () => {
    const appSource = readFileSync(join(clientRoot, "src/App.tsx"), "utf8");
    expect(appSource).toContain("Server offline");
    expect(/backend\s+offline/i.test(appSource)).toBe(false);
  });

  it('has no user-facing "backend offline" wording in any UI source file', () => {
    for (const file of UI_SOURCE_FILES) {
      const text = readFileSync(join(clientRoot, file), "utf8");
      expect(
        /backend(\s+is)?\s+offline/i.test(text),
        `"backend offline" wording found in ${file}`
      ).toBe(false);
    }
  });
});
