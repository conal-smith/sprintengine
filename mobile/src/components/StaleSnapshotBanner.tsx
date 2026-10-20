import { StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../theme/tokens";

/**
 * A read failed while rows from the last good read are still on screen. Those rows
 * are real — the desktop reported them — but they are no longer current, and the
 * only refresh affordance is a pull, which the user has to know to attempt. So the
 * failure is stated over the stale data rather than replacing it: blanking the
 * board on a dropped Wi-Fi packet would strand the user with an empty panel and no
 * way back to what they were reading.
 *
 * Status is calibrated text here, as everywhere else in this app — no dot, no pill.
 */
export function StaleSnapshotBanner({ message }: { message: string }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Text style={styles.label}>Showing the last update</Text>
      <Text numberOfLines={2} style={styles.message}>
        {message}
      </Text>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    banner: {
      gap: space["2xs"],
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space["3xl"],
      paddingVertical: space.lg,
    },
    label: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.toneWarn,
    },
    message: {
      ...typography.meta,
      color: colors.textMuted,
    },
  });
