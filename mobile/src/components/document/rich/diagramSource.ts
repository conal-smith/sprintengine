import type { ThemeColors } from "../../../theme/tokens";

// What a ```mermaid fence must pass before it is drawn, the colours it is
// drawn in, and what is said when it is not drawn.
//
// The renderer page refuses every request, but Mermaid fetches while it lays
// a diagram out (a class's `style … fill:url(…)`, a state's `classDef`, a
// node's `img`, which it loads to measure, a sequence participant's icon), so
// a diagram that would fetch is refused before it reaches the page at all,
// and shows as source with a note saying why. The desktop's rule, read the
// same way: any `url()` but one naming an element of the diagram itself,
// `image-set()`, `@import`, CSS escapes (`\75 rl(`) decoded first, a node's
// `img:` and a participant's `icon` given as an address.

/** A diagram longer than this shows as source: Mermaid refuses past 50,000, and the phone draws less. */
export const MAX_DIAGRAM_SOURCE = 20_000;

export const LOADS_FROM_ELSEWHERE = "Diagrams in a reply do not load images or styles from elsewhere";

const REMOTE_CSS = /\burl\s*\(\s*(?!['"]?\s*#)[^)]*\)?|(?:-webkit-)?image-set\s*\([^)]*\)?|@import\b[^;]*;?/iu;
const LOADING_SYNTAX = [/@\{[^}]*\bimg\s*:/u, /["']icon["']\s*:\s*["']\s*(?!@)/u];

function decodeCssEscapes(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(.))/gisu, (_match, hex: string | undefined, char: string) => {
    if (!hex) return char;
    const point = Number.parseInt(hex, 16);
    return point && point <= 0x10ffff ? String.fromCodePoint(point) : "�";
  });
}

/** Whether drawing this source would load something from outside it. */
export function loadsFromElsewhere(source: string): boolean {
  return REMOTE_CSS.test(decodeCssEscapes(source)) || LOADING_SYNTAX.some((pattern) => pattern.test(source));
}

/** Why a ```mermaid fence is not drawn before it is tried, or null when it may be. */
export function diagramRefusal(source: string): string | null {
  if (!source.trim()) return "Shown as source: the diagram is empty";
  if (source.length > MAX_DIAGRAM_SOURCE) return "Shown as source: the diagram is too long to draw on the phone";
  if (loadsFromElsewhere(source)) return LOADS_FROM_ELSEWHERE;
  return null;
}

/** Mermaid's complaint, cut to the line that says what is wrong. */
export function diagramNote(error: string): string {
  const first = error.split("\n", 1)[0].trim().replace(/:$/u, "");
  return first ? `Shown as source: ${first}` : "Shown as source: the diagram could not be drawn";
}

/** KaTeX's complaint, cut to its first line. */
export function mathNote(error: string): string {
  const first = error.split("\n", 1)[0].replace(/^KaTeX parse error:\s*/u, "").trim();
  return first ? `Shown as source: ${first}` : "Shown as source: the formula could not be typeset";
}

/**
 * Mermaid's `base` theme derives every colour it is not given from the ones
 * it is, so these are the roles a diagram draws with, each from the token
 * with that meaning, as the desktop maps its own: a node is a raised fill on
 * the reply's ground, its line and label take the border and body ink, edges
 * the quieter ink.
 */
export function diagramTheme(colors: ThemeColors, isDark: boolean): Record<string, string | boolean> {
  return {
    darkMode: isDark,
    background: colors.agentSurface,
    mainBkg: colors.bgActive,
    primaryColor: colors.bgActive,
    primaryBorderColor: colors.borderStrong,
    primaryTextColor: colors.textDefault,
    nodeBorder: colors.borderStrong,
    nodeTextColor: colors.textDefault,
    textColor: colors.textDefault,
    titleColor: colors.textPrimary,
    lineColor: colors.textMuted,
    secondaryColor: colors.accentPrimarySoft,
    tertiaryColor: colors.bgHover,
    clusterBkg: colors.agentInset,
    clusterBorder: colors.borderDefault,
    // An edge label's box breaks its line: the colour of the well a diagram
    // is drawn in (`ReplyBlocks.tsx`), so the box reads as a gap.
    edgeLabelBackground: colors.bgHover,
    noteBkgColor: colors.toneWarnSoft,
    noteBorderColor: colors.borderDefault,
    noteTextColor: colors.textDefault,
    actorBkg: colors.bgActive,
    actorBorder: colors.borderStrong,
    actorTextColor: colors.textDefault,
    actorLineColor: colors.textMuted,
    signalColor: colors.textMuted,
    signalTextColor: colors.textDefault,
    labelBoxBkgColor: colors.bgActive,
    labelBoxBorderColor: colors.borderStrong,
    labelTextColor: colors.textDefault,
    loopTextColor: colors.textDefault,
    activationBkgColor: colors.bgHover,
    activationBorderColor: colors.borderStrong,
    sequenceNumberColor: colors.textOnAccent,
    errorBkgColor: colors.toneErrorSoft,
    errorTextColor: colors.toneError,
  };
}
