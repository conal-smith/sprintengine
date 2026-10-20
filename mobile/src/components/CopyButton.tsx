import * as Haptics from "expo-haptics";
import { memo, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text } from "react-native";

import { writeClipboard } from "./clipboard";
import { CheckIcon, CopyIcon, iconSize } from "./glyphs";
import { useToast } from "./Toast";
import { useThemedStyles } from "../theme/ThemeProvider";
import { radius, space, touchSlop, typography, type Theme } from "../theme/tokens";

/**
 * How long the check and "Copied" hold before the copy glyph comes back: long
 * enough to be seen once the eye lands on it, short enough that it is plainly
 * a copy button again by the time anyone reaches for it twice.
 */
export const COPY_CONFIRM_MS = 1_500;

/** The glyph's drawn box; its touch area pads out to the floor. */
const COPY_BOX = 24;

/**
 * The one copy affordance, the desktop's: a glyph, not the word, named for
 * what it copies ("Copy code", "Copy reply"). A copy that lands swaps the
 * glyph for a check and "Copied" for a moment, with a tap of haptics and the
 * same word to a screen reader, so the confirmation arrives where the finger
 * already is rather than in a toast. One that fails says why in a toast, and
 * never shows the check.
 *
 * `text` may be a function, read only on the press, so working out a whole
 * reply costs nothing until someone copies it.
 */
export const CopyButton = memo(function CopyButton({
  text,
  label,
}: {
  text: string | (() => string);
  /** The accessible name. It never changes; the confirmation is announced. */
  label: string;
}) {
  const styles = useThemedStyles(createStyles);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    // A second press while the check is up is not a second write: the
    // clipboard already holds this, and the check would only be held longer.
    if (copied) return;
    const outcome = await writeClipboard(typeof text === "function" ? text() : text);
    if (outcome !== "copied") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      toast.show(
        outcome === "unavailable" ? "Copying needs the latest build of the app." : "Could not copy to the clipboard.",
        "error",
      );
      return;
    }
    // Haptics are unsupported on web; a rejected promise there is not a failed copy.
    void Haptics.selectionAsync().catch(() => undefined);
    AccessibilityInfo.announceForAccessibility("Copied");
    if (!mounted.current) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) setCopied(false);
    }, COPY_CONFIRM_MS);
  };
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={touchSlop(COPY_BOX, COPY_BOX)}
      onPress={() => void copy()}
      style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
    >
      {copied ? <CheckIcon size={iconSize.xs} tone="toneGood" /> : <CopyIcon size={iconSize.xs} tone="textSubtle" />}
      {copied ? <Text style={styles.copied}>Copied</Text> : null}
    </Pressable>
  );
});

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: space["2xs"],
      minWidth: COPY_BOX,
      height: COPY_BOX,
      paddingHorizontal: space["2xs"],
      borderRadius: radius.control,
    },
    pressed: { backgroundColor: colors.bgHover },
    copied: { ...typography.micro, color: colors.textMuted },
  });
