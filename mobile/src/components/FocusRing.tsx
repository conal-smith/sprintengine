import { useCallback, useState } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { focusRing } from "../theme/tokens";

/**
 * The product's ONE focus indicator, as `principles.md` defines it: a 2px
 * `border.focus` **outline at `focus.ring-offset`**, on focus-visible only.
 *
 * ## Why an overlay and not a border or a wrapper
 *
 * RN has no `outline`, and the two obvious substitutes are both wrong:
 *
 * - A **border on the control** is inside its box, so it either shifts the
 *   content or has to be reserved at rest — and it sits tight against the fill,
 *   which is the exact failure the offset exists to prevent (`border.focus` and
 *   `accent.primary` are the same value, so a ring drawn on an accent-filled
 *   button has nothing to contrast with and focused renders identically to
 *   unfocused).
 * - A **wrapping View with padding** reflows the row the moment focus lands, and
 *   the system forbids a focus treatment that resizes its control.
 *
 * An absolutely-positioned sibling inset by `-offset` is a real outline: it is
 * outside the control's box, it costs no layout, and the gap is **transparent**,
 * so it shows whatever surface is actually behind. That last property is why the
 * system specifies an outline rather than an offset ring with a ring-offset
 * colour — a colour has to be told the background and gets it wrong the moment
 * the control moves to a different surface.
 *
 * ## Focus-visible, not focus
 *
 * RN fires `onFocus` only for genuine focus traversal — an external keyboard, iOS
 * Full Keyboard Access, Android Switch Access. A touch does not focus a
 * `Pressable`, so this is already focus-visible semantics rather than `:focus`,
 * and a tap never draws the ring.
 */
export function useFocusRing() {
  const [focused, setFocused] = useState(false);

  return {
    focused,
    /** Spread onto the Pressable. */
    focusProps: {
      onFocus: useCallback(() => setFocused(true), []),
      onBlur: useCallback(() => setFocused(false), []),
    },
  };
}

/**
 * The ring itself. Render as the last child of a control with
 * `position: "relative"`, and only while focused.
 *
 * `radius` should be the control's own radius; the ring adds the offset so its
 * corners stay concentric with the control's rather than looking pinched.
 */
export function FocusRing({ radius, style }: { radius: number; style?: ViewStyle }) {
  const { colors } = useTheme();

  return (
    <View
      // Decoration: it must never intercept a press, and a screen reader has the
      // control's own focus state already.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFillObject,
        {
          top: -focusRing.offset - focusRing.width,
          left: -focusRing.offset - focusRing.width,
          right: -focusRing.offset - focusRing.width,
          bottom: -focusRing.offset - focusRing.width,
          borderWidth: focusRing.width,
          borderColor: colors.borderFocus,
          borderRadius: radius + focusRing.offset + focusRing.width,
        },
        style,
      ]}
    />
  );
}
