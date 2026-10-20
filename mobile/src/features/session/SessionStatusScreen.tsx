import { StyleSheet, Text, View } from "react-native";

import { DesktopSessionStatus, MobileSession } from "../../api/types";
import { Card } from "../../components/Card";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";

interface SessionStatusScreenProps {
  session: MobileSession;
  /** Paired desktops in total. More than one means Settings is also a switcher. */
  desktopCount: number;
  onOpenSettings: () => void;
  onStartPairing: () => void;
  onDisconnect: () => void;
}

const statusCopy: Record<
  DesktopSessionStatus,
  {
    title: string;
    body: string;
    primaryLabel: string;
  }
> = {
  online: {
    title: "Desktop connected",
    body: "Paired over your tailnet.",
    primaryLabel: "Continue",
  },
  offline: {
    title: "Reconnect desktop",
    body: "Pair again to keep driving it from this phone.",
    primaryLabel: "Pair again",
  },
  stale: {
    title: "Reconnect desktop",
    body: "This session has expired. Pair again to refresh it.",
    primaryLabel: "Pair again",
  },
  revoked: {
    title: "Pair desktop",
    body: "The desktop revoked this phone. Pair again to continue.",
    primaryLabel: "Pair again",
  },
};

/**
 * The gate between a paired-but-unusable desktop and the tabs. It names *which*
 * desktop is unreachable and why, because a phone can hold several and only the
 * active one is broken.
 */
export function SessionStatusScreen({
  session,
  desktopCount,
  onOpenSettings,
  onStartPairing,
  onDisconnect,
}: SessionStatusScreenProps) {
  const styles = useThemedStyles(createStyles);

  const status = session.status ?? "online";
  const copy = statusCopy[status];
  const shouldPair = status !== "online";

  return (
    <Screen title={copy.title}>
      <Card variant="hero">
        <View accessibilityRole={status === "revoked" ? "alert" : "text"} style={styles.copyBlock}>
          <Text style={styles.desktopName}>{session.desktopName}</Text>
          <Text style={styles.body}>{copy.body}</Text>
        </View>
        <View style={styles.actions}>
          <PrimaryButton label={copy.primaryLabel} onPress={shouldPair ? onStartPairing : onOpenSettings} />
          <PrimaryButton
            label={desktopCount > 1 ? "Switch desktop" : "Connection details"}
            onPress={onOpenSettings}
            variant="secondary"
          />
        </View>
      </Card>
      <View style={styles.footer}>
        <PrimaryButton label="Remove pairing" onPress={onDisconnect} variant="danger" />
      </View>
    </Screen>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    copyBlock: {
      gap: space["2xs"],
    },
    desktopName: {
      ...typography.title,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.3,
      color: colors.textPrimary,
    },
    body: {
      ...typography.body,
      color: colors.textMuted,
    },
    actions: {
      gap: space.md,
      marginTop: space["3xl"],
    },
    footer: {
      alignItems: "center",
    },
  });
