import { StyleSheet, TextInput, View } from "react-native";

import { iconSize, SearchIcon } from "./glyphs";
import { useTheme, useThemedStyles } from "../theme/ThemeProvider";
import { radius, space, typography, type Theme } from "../theme/tokens";

/**
 * The thread list's search field: a raised rounded slab with the search mark
 * and nothing else. No cancel button and no "filters" affordance — the one
 * filter this screen has is the desktop, and it lives in the top bar.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.field}>
      <SearchIcon size={iconSize.md} tone="textSubtle" />
      <TextInput
        accessibilityLabel={accessibilityLabel ?? placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSubtle}
        returnKeyType="search"
        style={styles.input}
        value={value}
      />
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    field: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      height: 48,
      paddingHorizontal: space.xl,
      borderRadius: radius.shell,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
    },
    input: {
      ...typography.body,
      flex: 1,
      minWidth: 0,
      color: colors.textPrimary,
      // Android's TextInput carries its own vertical padding, which pushes the
      // 15pt line off the 48pt field's centre.
      paddingVertical: 0,
    },
  });
