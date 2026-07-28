/**
 * Font stack resolution for the xterm.js terminal.
 *
 * xterm.js renders every cell through a single CSS font stack. Shell prompts
 * such as starship and powerlevel10k emit Nerd Font code points (Private Use
 * Area glyphs for git branches, folders, powerline separators), so a stack
 * built only from plain monospace faces renders those glyphs as tofu boxes
 * even when the machine has a patched font installed.
 *
 * No web API lists installed fonts without a permission prompt, so installed
 * families are probed with the canvas measurement trick: a family that is not
 * installed falls back to the generic family it is listed against and measures
 * identically to it. Detected Nerd Fonts are prepended to the stack, and the
 * user can pin an exact family in Settings when several are installed.
 */

/** Glyph mix chosen so two different faces are very unlikely to measure equal. */
const PROBE_TEXT = "mmmmmmmmmmlliWW@0Oo";
/** Large enough that sub-pixel metric differences exceed float noise. */
const PROBE_FONT_SIZE_PX = 72;
/** Every probe runs against all three so a face matching one generic still resolves. */
const BASELINE_FAMILIES = ["monospace", "serif", "sans-serif"] as const;

/**
 * Family names Nerd Font patched builds install under, most likely first.
 *
 * Nerd Fonts ship three variants per face: `… Nerd Font` (variable width
 * symbols), `… Nerd Font Mono` (single-width symbols) and `… Nerd Font Propo`.
 * The `Mono` variant is the one that keeps terminal cells aligned, so it is
 * always preferred over its siblings.
 */
export const NERD_FONT_CANDIDATES: readonly string[] = [
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGS Nerd Font Mono",
  "MesloLGM Nerd Font Mono",
  "Hack Nerd Font Mono",
  "FiraCode Nerd Font Mono",
  "FiraMono Nerd Font Mono",
  "SauceCodePro Nerd Font Mono",
  "CaskaydiaCove Nerd Font Mono",
  "CaskaydiaMono Nerd Font Mono",
  "Iosevka Nerd Font Mono",
  "IosevkaTerm Nerd Font Mono",
  "GeistMono Nerd Font Mono",
  "BlexMono Nerd Font Mono",
  "UbuntuMono Nerd Font Mono",
  "RobotoMono Nerd Font Mono",
  "DejaVuSansMono Nerd Font Mono",
  "Terminess Nerd Font Mono",
  "JetBrainsMono Nerd Font",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
];

/**
 * Symbol-only Nerd Font packages. They carry no letters, so they are appended
 * after the text faces: CSS font fallback is per glyph, and these only ever win
 * for code points nothing earlier in the stack covers.
 */
export const NERD_FONT_SYMBOL_FALLBACKS: readonly string[] = [
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
];

/** The stack shipped before font detection existed; kept as the tail fallback. */
export const BASE_TERMINAL_FONT_FAMILIES: readonly string[] = [
  "SF Mono",
  "SFMono-Regular",
  "JetBrains Mono",
  "Consolas",
  "Liberation Mono",
  "Menlo",
  "monospace",
];

const GENERIC_FONT_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fangsong",
  "fantasy",
  "math",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

/** Unquoted CSS family names may only be a dash-separated run of identifiers. */
const UNQUOTED_FAMILY_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/** Measures the advance width of the probe text for a CSS `font` shorthand. */
export type FontWidthMeasure = (fontShorthand: string) => number;

/** Quotes a family name unless it is a generic keyword or a bare identifier. */
export function quoteFontFamily(family: string): string {
  const trimmed = family.trim();
  if (trimmed.length === 0) return "";
  if (GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())) return trimmed.toLowerCase();
  if (UNQUOTED_FAMILY_PATTERN.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/["\\]/g, "")}"`;
}

/**
 * Splits a user-entered font stack into family names.
 *
 * Accepts both a bare family (`JetBrainsMono Nerd Font Mono`) and a full CSS
 * list (`"MesloLGS NF", Menlo`), because the settings field takes either.
 */
export function parseFontFamilyList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter((entry) => entry.length > 0);
}

function dedupeFamilies(families: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const family of families) {
    const trimmed = family.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Reports whether a family is installed by comparing its metrics against the
 * generic families it is listed with. Identical metrics against all three
 * generics mean the browser never resolved the family and fell back.
 */
export function isFontFamilyAvailable(family: string, measure: FontWidthMeasure): boolean {
  const quoted = quoteFontFamily(family);
  if (quoted.length === 0) return false;
  return BASELINE_FAMILIES.some((baseline) => {
    const baselineWidth = measure(`${PROBE_FONT_SIZE_PX}px ${baseline}`);
    const candidateWidth = measure(`${PROBE_FONT_SIZE_PX}px ${quoted}, ${baseline}`);
    return baselineWidth > 0 && candidateWidth !== baselineWidth;
  });
}

/** Returns the subset of `candidates` installed on this machine, in input order. */
export function detectAvailableFontFamilies(
  candidates: readonly string[],
  measure: FontWidthMeasure,
): string[] {
  return candidates.filter((candidate) => isFontFamilyAvailable(candidate, measure));
}

/**
 * Builds the terminal font stack.
 *
 * The user override is prepended rather than replacing the stack so a typo in
 * the family name degrades to the previous behaviour instead of an unreadable
 * terminal.
 */
export function resolveTerminalFontFamily(input: {
  readonly overrideFamilies?: readonly string[] | undefined;
  readonly detectedFamilies?: readonly string[] | undefined;
}): string {
  return dedupeFamilies([
    ...(input.overrideFamilies ?? []),
    ...(input.detectedFamilies ?? []),
    ...NERD_FONT_SYMBOL_FALLBACKS,
    ...BASE_TERMINAL_FONT_FAMILIES,
  ])
    .map(quoteFontFamily)
    .filter((family) => family.length > 0)
    .join(", ");
}

/** Canvas-backed measure, or `null` when no 2D context is reachable. */
export function createFontWidthMeasure(): FontWidthMeasure | null {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  return (fontShorthand: string) => {
    context.font = fontShorthand;
    return context.measureText(PROBE_TEXT).width;
  };
}

let detectedNerdFontFamiliesCache: readonly string[] | null = null;

/**
 * Detected Nerd Font families, probed once per page.
 *
 * Locally installed fonts are available synchronously and cannot change while
 * the page lives, so the probe (one canvas measurement per candidate) runs a
 * single time and every terminal pane reuses the result.
 */
export function detectInstalledNerdFontFamilies(): readonly string[] {
  if (detectedNerdFontFamiliesCache !== null) return detectedNerdFontFamiliesCache;
  const measure = createFontWidthMeasure();
  detectedNerdFontFamiliesCache = measure
    ? detectAvailableFontFamilies(NERD_FONT_CANDIDATES, measure)
    : [];
  return detectedNerdFontFamiliesCache;
}

/** Resets the probe cache so tests can exercise detection more than once. */
export function __resetNerdFontDetectionCacheForTests(): void {
  detectedNerdFontFamiliesCache = null;
}

/** Terminal font stack for a configured override (empty string means auto). */
export function terminalFontFamilyForOverride(override: string | null | undefined): string {
  return resolveTerminalFontFamily({
    overrideFamilies: parseFontFamilyList(override),
    detectedFamilies: detectInstalledNerdFontFamilies(),
  });
}
