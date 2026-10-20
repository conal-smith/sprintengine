import Svg, { Circle } from "react-native-svg";

import { useTheme } from "../theme/ThemeProvider";

// How much of a model's context window a chat has spent, as a 14pt circle
// filled clockwise from twelve: the desktop's ContextRing
// (design-system/components/context-ring), drawn the same way.
//
// A display of one proportion, never a control and never a progress
// indicator: nothing is loading, and the value falls as well as rises (a
// compaction gives context back). The caller omits it when it holds no
// reading; a ring at 0% for a chat that reports nothing would be a lie.

/** The drawn ring, in points. */
export const CONTEXT_RING_SIZE = 14;
// Geometry in the drawing's own 16-unit box, the desktop's.
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextRing({ percentage, high }: { percentage: number; high: boolean }) {
  const { colors } = useTheme();
  const value = Math.max(0, Math.min(100, Math.round(percentage)));
  // The dash is the spent arc, the gap the whole circumference.
  const sweep = (CIRCUMFERENCE * value) / 100;
  return (
    <Svg height={CONTEXT_RING_SIZE} viewBox="0 0 16 16" width={CONTEXT_RING_SIZE}>
      {/* The unspent remainder, in the strong border rather than a tone: a
          coloured track would read as a second value. */}
      <Circle cx={8} cy={8} fill="none" r={RADIUS} stroke={colors.borderStrong} strokeWidth={2} />
      {/* The spent sweep, from twelve. Butt caps: a round cap at 2 overhangs
          by a degree and draws a dot at 0%. */}
      <Circle
        cx={8}
        cy={8}
        fill="none"
        origin="8, 8"
        r={RADIUS}
        rotation={-90}
        stroke={high ? colors.toneWarn : colors.accentPrimary}
        strokeDasharray={`${sweep.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
        strokeLinecap="butt"
        strokeWidth={2}
      />
    </Svg>
  );
}
