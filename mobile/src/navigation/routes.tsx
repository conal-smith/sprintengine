import { useCallback, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PairingScreen } from "../features/pairing/PairingScreen";
import { WelcomeScreen } from "../features/pairing/WelcomeScreen";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { useThemedStyles } from "../theme/ThemeProvider";
import type { Theme } from "../theme/tokens";
import { useChats } from "../features/conversations/ChatsContext";
import { readWebTargets } from "../features/web/webTargetsLogic";
import { usePairingLink } from "./PairingLinkContext";
import { useSessionData, useSnapshot } from "./SessionDataProvider";

/**
 * The gate screens have no header, so they take the safe-area insets as padding
 * rather than letting a header carry the top one.
 */
function Bleed({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.bleed}>
      {/* The pairing screen behind this is a form. Android resizes the window
          itself (`adjustResize` in the manifest), so only iOS needs the padding
          behavior — without it the keyboard covers Pair phone and Cancel. */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.keyboardAvoider}>
        {children}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function WelcomeRoute({ onStartPairing }: { onStartPairing: () => void }) {
  return (
    <Bleed>
      <WelcomeScreen onStartPairing={onStartPairing} />
    </Bleed>
  );
}

/**
 * Pairing over the tailnet needs no account, so this route is always the
 * pairing screen — whichever stack mounted it.
 */
export function PairingRoute() {
  const { connectSession } = useSessionData();
  const navigation = useNavigation();
  const { pendingPairingLink, clearPendingPairingLink } = usePairingLink();

  // The link is released when this screen is done with it, not when it mounts.
  // A cold start resolves the stored sessions a few frames in, which flips the
  // root from gate to tabs and unmounts whichever stack the link was delivered
  // into; holding it in context until then lets `RootNavigator` re-deliver it to
  // the stack that survived instead of losing it in the swap.
  const releasePairingLink = () => {
    if (pendingPairingLink) {
      clearPendingPairingLink();
    }
  };

  const goBack = () => {
    releasePairingLink();
    if (navigation.canGoBack()) {
      navigation.goBack();
    }
  };

  return (
    <Bleed>
      <PairingScreen
        initialPairingLink={pendingPairingLink}
        onCancel={goBack}
        onConnected={(session) => {
          connectSession(session);
          goBack();
        }}
      />
    </Bleed>
  );
}

/**
 * Settings is mounted in two places — the chat list's top bar and the offline
 * gate — so the wiring lives here once. `onBack` is passed only where a stack
 * can pop.
 */
export function SettingsRoute({
  onBack,
  onOpenDesktops,
  onOpenAppearance,
  onOpenWeb,
  onOpenScheduled,
}: {
  onBack?: () => void;
  onOpenDesktops: () => void;
  onOpenAppearance: () => void;
  onOpenWeb?: () => void;
  onOpenScheduled?: () => void;
}) {
  // The web count is read from the snapshot, so it is read while this is open.
  const { sessions, snapshot, isFleetRefreshing, refreshFleet } = useSnapshot();
  const { groupByProject, setGroupByProject, followUpBehavior, setFollowUpBehavior } = useChats();

  // Fleet summaries are one gateway read per online desktop, so they are fetched
  // when this screen comes into view rather than kept warm behind the tabs.
  useFocusEffect(
    useCallback(() => {
      refreshFleet();
    }, [refreshFleet]),
  );

  return (
    <SettingsScreen
      groupChatsByProject={groupByProject}
      isFleetRefreshing={isFleetRefreshing}
      onGroupChatsByProjectChange={setGroupByProject}
      onSteerFollowUpsChange={(enabled) => setFollowUpBehavior(enabled ? "steer" : "queue")}
      onBack={onBack}
      onOpenAppearance={onOpenAppearance}
      onOpenDesktops={onOpenDesktops}
      onOpenWeb={onOpenWeb}
      onOpenScheduled={onOpenScheduled}
      onRefreshFleet={refreshFleet}
      sessions={sessions}
      steerFollowUps={followUpBehavior === "steer"}
      webTargetCount={readWebTargets(snapshot).length}
    />
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    bleed: {
      flex: 1,
      backgroundColor: colors.bgApp,
    },
    keyboardAvoider: {
      flex: 1,
    },
  });
