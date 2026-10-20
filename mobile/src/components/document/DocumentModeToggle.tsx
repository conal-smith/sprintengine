import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../../theme/ThemeProvider";
import { radius, type Theme, typography, space, fontWeight } from "../../theme/tokens";

/** `document` reads the source; `preview` renders it in the sandbox. */
export type DocumentViewMode = "document" | "preview";

interface DocumentModeToggleProps {
  value: DocumentViewMode;
  onChange: (mode: DocumentViewMode) => void;
}

const modes: { mode: DocumentViewMode; label: string }[] = [
  { mode: "document", label: "Document" },
  { mode: "preview", label: "HTML preview" },
];

export function DocumentModeToggle({ value, onChange }: DocumentModeToggleProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <View accessibilityRole="tablist" style={styles.track}>
      {modes.map(({ mode, label }) => {
        const selected = mode === value;

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={mode}
            onPress={() => onChange(mode)}
            style={[styles.segment, selected ? styles.segmentSelected : null]}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : null]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // The site's segmented control: a neutral well, the chosen segment lifted
    // as a small card.
    track: {
      backgroundColor: colors.bgHover,
      borderRadius: 8,
      flexDirection: "row",
      gap: space["3xs"],
      padding: space["2xs"],
    },
    segment: {
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: "transparent",
      flex: 1,
      minHeight: 36,
    },
    // Translucent accent over the track's own opaque fill — the one accent this
    // surface spends, shared with the screen's primary action.
    segmentSelected: {
      // Selection is neutral. The design system's segmented-control spec is
      // explicit — "No accent variant… an accent-filled segment would spend the
      // one solid accent on a state display" — and this used to paint
      // accentPrimarySoft with an accent border. `bgSelected` plus the label's
      // ink lift carries it, and survives greyscale.
      backgroundColor: colors.bgSurface,
      borderColor: colors.cardRing,
    },
    label: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    labelSelected: {
      color: colors.textPrimary,
    },
  });
