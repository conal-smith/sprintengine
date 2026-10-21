import { Text, type TextStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { fontWeight, tracking, typography } from "../theme/tokens";

/** `header` is the site's 17px nav wordmark; `display` its 36px hero wordmark; `title` the phone's title step. */
export type WordmarkSize = "header" | "title" | "display";

const WORDMARK_SIZE: Record<WordmarkSize, { fontSize: number; lineHeight: number; letterSpacing: number }> = {
  header: { fontSize: 17, lineHeight: 22, letterSpacing: tracking.tight },
  title: { fontSize: typography.title.fontSize, lineHeight: typography.title.lineHeight, letterSpacing: tracking.tight },
  // The site's hero: `text-[44px] tracking-[-0.03em]`, scaled to the phone.
  display: { fontSize: 36, lineHeight: 40, letterSpacing: -1 },
};

/**
 * The product wordmark. The RN counterpart of the desktop's
 * `SprintEngineWordmark` (../multicode/src/renderer/src/components/brand/), which
 * the marketing site also renders, so all three set the name the same way:
 * lowercase, one word, semibold, tight tracking, "engine" in the accent.
 *
 * Three properties are load-bearing and are ported deliberately:
 *
 * - **Live text, never an image.** The desktop's previous wordmark was SVG text
 *   and so scaled by viewBox rather than by the type ramp, "which put it outside
 *   every type rule in the system". As text it takes a ramp step and a theme
 *   colour, and it scales with the OS font-size setting like everything else.
 * - **The accent is ink, never a fill.** That is what keeps the wordmark inside
 *   the one-accent-per-view budget: it colours letterforms and nothing else.
 * - **No mark glyph.** The mark is the application icon and nothing else,
 *   so no UI is coupled to it. The welcome screen shows
 *   the icon itself, as an image cut from the icon's master, never a mark
 *   redrawn beside the name.
 *
 * It appears where the site shows it: at display size on the welcome screen and
 * at nav size in the header of the tab roots that carry the brand. Its green
 * "engine" is the only green text in the app.
 */
export function SprintEngineWordmark({ style, size = "title" }: { style?: TextStyle; size?: WordmarkSize }) {
  const { colors } = useTheme();

  return (
    <Text
      // One accessible name, so the screen reader says the product's name rather
      // than spelling out two adjacent runs of text.
      accessibilityRole="header"
      accessibilityLabel="Sprint Engine"
      style={[
        {
          ...WORDMARK_SIZE[size],
          fontWeight: fontWeight.emphasis,
          color: colors.textPrimary,
        },
        style,
      ]}
    >
      sprint
      <Text style={{ color: colors.accentPrimary }}>engine</Text>
    </Text>
  );
}
