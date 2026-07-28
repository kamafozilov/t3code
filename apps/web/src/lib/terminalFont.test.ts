import { describe, expect, it } from "vite-plus/test";

import {
  BASE_TERMINAL_FONT_FAMILIES,
  detectAvailableFontFamilies,
  isFontFamilyAvailable,
  NERD_FONT_SYMBOL_FALLBACKS,
  parseFontFamilyList,
  quoteFontFamily,
  resolveTerminalFontFamily,
  type FontWidthMeasure,
} from "./terminalFont";

/**
 * Emulates a browser where only `installed` resolves: any other family falls
 * through to the generic it is listed against and measures identically to it.
 */
function makeMeasure(installed: readonly string[]): FontWidthMeasure {
  const genericWidths: Record<string, number> = {
    monospace: 100,
    serif: 110,
    "sans-serif": 120,
  };
  const installedKeys = new Set(installed.map((family) => family.toLowerCase()));
  return (fontShorthand) => {
    const families = fontShorthand.replace(/^\d+px\s+/, "").split(",");
    for (const family of families) {
      const name = family.trim().replace(/^"|"$/g, "");
      if (installedKeys.has(name.toLowerCase())) return 137;
      const generic = genericWidths[name.toLowerCase()];
      if (generic !== undefined) return generic;
    }
    return genericWidths.monospace ?? 0;
  };
}

describe("quoteFontFamily", () => {
  it("quotes family names containing spaces", () => {
    expect(quoteFontFamily("JetBrainsMono Nerd Font Mono")).toBe('"JetBrainsMono Nerd Font Mono"');
  });

  it("leaves bare identifiers unquoted", () => {
    expect(quoteFontFamily("Menlo")).toBe("Menlo");
    expect(quoteFontFamily("Liberation-Mono")).toBe("Liberation-Mono");
  });

  it("keeps generic keywords unquoted and lowercased", () => {
    expect(quoteFontFamily("monospace")).toBe("monospace");
    expect(quoteFontFamily("Monospace")).toBe("monospace");
  });

  it("strips quotes and backslashes that would break the stack", () => {
    expect(quoteFontFamily('Broken" Font')).toBe('"Broken Font"');
  });

  it("returns an empty string for blank input", () => {
    expect(quoteFontFamily("   ")).toBe("");
  });
});

describe("parseFontFamilyList", () => {
  it("accepts a single bare family", () => {
    expect(parseFontFamilyList("JetBrainsMono Nerd Font Mono")).toEqual([
      "JetBrainsMono Nerd Font Mono",
    ]);
  });

  it("accepts a full CSS stack with quotes", () => {
    expect(parseFontFamilyList('"MesloLGS NF", Menlo , monospace')).toEqual([
      "MesloLGS NF",
      "Menlo",
      "monospace",
    ]);
  });

  it("drops empty entries and nullish input", () => {
    expect(parseFontFamilyList(", ,")).toEqual([]);
    expect(parseFontFamilyList(null)).toEqual([]);
    expect(parseFontFamilyList(undefined)).toEqual([]);
  });
});

describe("isFontFamilyAvailable", () => {
  it("detects an installed family", () => {
    expect(isFontFamilyAvailable("Hack Nerd Font Mono", makeMeasure(["Hack Nerd Font Mono"]))).toBe(
      true,
    );
  });

  it("rejects a family that is not installed", () => {
    expect(isFontFamilyAvailable("Hack Nerd Font Mono", makeMeasure([]))).toBe(false);
  });

  it("rejects blank input without measuring", () => {
    expect(
      isFontFamilyAvailable("  ", () => {
        throw new Error("should not measure");
      }),
    ).toBe(false);
  });
});

describe("detectAvailableFontFamilies", () => {
  it("keeps candidate order and filters out missing families", () => {
    const measure = makeMeasure(["MesloLGS NF", "Hack Nerd Font Mono"]);
    expect(
      detectAvailableFontFamilies(
        ["JetBrainsMono Nerd Font Mono", "MesloLGS NF", "Hack Nerd Font Mono"],
        measure,
      ),
    ).toEqual(["MesloLGS NF", "Hack Nerd Font Mono"]);
  });
});

describe("resolveTerminalFontFamily", () => {
  it("falls back to the shipped stack when nothing is detected", () => {
    const stack = resolveTerminalFontFamily({});
    expect(stack.startsWith('"Symbols Nerd Font Mono"')).toBe(true);
    expect(stack.endsWith("monospace")).toBe(true);
  });

  it("puts the override first, then detected fonts", () => {
    const stack = resolveTerminalFontFamily({
      overrideFamilies: ["MesloLGS NF"],
      detectedFamilies: ["JetBrainsMono Nerd Font Mono"],
    });
    expect(stack.indexOf('"MesloLGS NF"')).toBe(0);
    expect(stack.indexOf('"MesloLGS NF"')).toBeLessThan(
      stack.indexOf('"JetBrainsMono Nerd Font Mono"'),
    );
  });

  it("keeps symbol fallbacks after text faces but before the generic tail", () => {
    const stack = resolveTerminalFontFamily({
      detectedFamilies: ["JetBrainsMono Nerd Font Mono"],
    });
    const detectedIndex = stack.indexOf('"JetBrainsMono Nerd Font Mono"');
    const symbolsIndex = stack.indexOf('"Symbols Nerd Font Mono"');
    const genericIndex = stack.indexOf("monospace");
    expect(detectedIndex).toBeLessThan(symbolsIndex);
    expect(symbolsIndex).toBeLessThan(genericIndex);
  });

  it("never repeats a family, ignoring case", () => {
    const stack = resolveTerminalFontFamily({
      overrideFamilies: ["menlo", "Menlo"],
      detectedFamilies: ["MENLO"],
    });
    expect(stack.match(/menlo/gi)).toHaveLength(1);
  });

  it("always preserves the shipped stack as the tail", () => {
    const stack = resolveTerminalFontFamily({ overrideFamilies: ["MesloLGS NF"] });
    for (const family of [...NERD_FONT_SYMBOL_FALLBACKS, ...BASE_TERMINAL_FONT_FAMILIES]) {
      expect(stack.toLowerCase()).toContain(family.toLowerCase());
    }
  });
});
