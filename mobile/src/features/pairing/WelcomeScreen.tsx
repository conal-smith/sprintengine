import { Image, StyleSheet, Text, View } from "react-native";

import seMark from "../../assets/brand/se-mark.png";
import { SprintEngineWordmark } from "../../components/SprintEngineWordmark";
import { PrimaryButton } from "../../components/PrimaryButton";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, type Theme, typography } from "../../theme/tokens";

/**
 * The first screen a phone with no paired desktop sees: the mark centred in the
 * space, and one door at the bottom where a thumb is.
 *
 * One door, because there is one way in. The phone pairs with a desktop over
 * the tailnet, and that needs no account — possession of Studio's one-time
 * link is the credential. There is no sign-in on this path.
 */
export function WelcomeScreen({ onStartPairing }: { onStartPairing: () => void }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.root}>
      <View style={styles.centre}>
        {/* The one place the app draws a mark, and it is the app icon itself:
            the se card SprintEngine Studio wears on the Mac, cut from the same
            master by scripts/generate-brand-icons.mjs. It is the same dark
            card in both themes, as the icon is. The wordmark under it is the
            name, live text as everywhere else. */}
        <View accessibilityLabel="Sprint Engine" accessible style={styles.markGroup}>
          <Image source={seMark} style={styles.mark} accessibilityIgnoresInvertColors />
          <View style={styles.wordmarkRow}>
            <SprintEngineWordmark size="header" />
          </View>
        </View>
      </View>

      <View style={styles.actions}>
        <Text style={styles.lead}>Pair with Sprint Engine Studio on a desktop in your tailnet.</Text>
        <PrimaryButton label="Pair with a desktop" onPress={onStartPairing} />
      </View>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      paddingHorizontal: space["3xl"],
      backgroundColor: colors.bgApp,
    },
    centre: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    markGroup: {
      alignItems: "center",
      gap: space.xl,
    },
    mark: {
      width: 128,
      height: 128,
    },
    wordmarkRow: {
      alignItems: "center",
    },
    actions: {
      gap: space.md,
      paddingBottom: space["4xl"] * 2,
    },
    lead: {
      ...typography.meta,
      color: colors.textMuted,
      textAlign: "center",
    },
  });
