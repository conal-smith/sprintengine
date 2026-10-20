import { useEffect, useState } from "react";
import { AccessibilityInfo, type ColorValue } from "react-native";
import Svg, { type SvgProps } from "react-native-svg";

// Shared frame for every glyph in this pack. It fixes the three things each
// glyph would otherwise re-decide: the rendered box, the ink source, and how a
// glyph announces itself.
//
// Two coordinate grids, both rendered into the same square box:
//   16x16 — the house grid. Lifecycle, backlog type, criticality, and chrome.
//   24x24 — role glyphs only. Their path data is copied verbatim from the
//           desktop AppIcons sprite sheet, which draws on 24. Rescaling those
//           coordinates by hand would be a shape edit dressed up as a port, and
//           shape fidelity is the whole point of the role vocabulary. A viewBox
//           is a coordinate system, not a size: a 24-grid path rendered at
//           size={16} is pixel-identical to the desktop's 16px render.
//
// Ink: every path uses `currentColor`, and `color` is set once here from a
// theme token by the calling glyph. Nothing below this file names a hex.

/**
 * Rendered box, in points. The desktop ramp (12/14/16) shifted one step up:
 * the same glyph on a phone sits under a thumb, not a mouse cursor.
 */
export const iconSize = {
  /** Inline with meta/micro copy. */
  xs: 14,
  /** Default list-row and toolbar glyph. */
  sm: 16,
  /** Panel-header chrome and button pairs. */
  md: 18,
  /** Tab-bar icons. */
  lg: 22,
} as const;

export type GlyphSizeName = keyof typeof iconSize;

export interface GlyphProps {
  /** Rendered box in points. Defaults to `iconSize.sm` (16). */
  size?: number;
  /**
   * Accessible name. Omit when adjacent text already names the thing — the
   * glyph then hides from the screen reader instead of announcing twice.
   */
  label?: string;
}

interface GlyphFrameProps extends GlyphProps {
  viewBox: "0 0 16 16" | "0 0 24 24";
  color: ColorValue;
  children: SvgProps["children"];
}

export function GlyphFrame({ viewBox, color, size = iconSize.sm, label, children }: GlyphFrameProps) {
  // `accessibilityElementsHidden` is the iOS switch, `importantForAccessibility`
  // the Android one; RN honours one per platform, so both are set.
  const a11y = label
    ? ({ accessibilityRole: "image", accessibilityLabel: label } as const)
    : ({
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      } as const);

  return (
    <Svg width={size} height={size} viewBox={viewBox} fill="none" color={color} {...a11y}>
      {children}
    </Svg>
  );
}

/**
 * Mirrors the desktop's `@media (prefers-reduced-motion: reduce)` guard on
 * `.lifecycle-spin`. The initial value arrives asynchronously, so the spinner
 * starts still and settles within a frame rather than flashing a rotation at a
 * user who asked for none.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    let isMounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (isMounted) setReduced(enabled);
    });

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
