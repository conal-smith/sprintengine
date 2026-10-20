import { useContext, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme, useThemedStyles } from "../theme/ThemeProvider";
import { space, type Theme } from "../theme/tokens";
import { ScreenHeader } from "./ScreenHeader";
import { StaleSnapshotBanner } from "./StaleSnapshotBanner";

interface ScreenChromeProps {
  title?: string;
  eyebrow?: string;
  count?: number;
  onBack?: () => void;
  backLabel?: string;
  trailing?: ReactNode;
  wordmark?: boolean;
  subtitle?: ReactNode;
  titleScale?: "nav" | "large";
  flush?: boolean;
  /** `agent` for the conversation and New: the conversation's ground, header included. */
  ground?: "app" | "agent";
  /** Over the top bar's row: a search grown from a trailing button. */
  overlay?: ReactNode;
}

interface ScreenProps extends ScreenChromeProps {
  /** Wire pull-to-refresh on any screen that reads the desktop snapshot. */
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
}

/**
 * Scrolling screen for documents and forms: the whole body scrolls as one.
 * Lists do not belong here — they use `ScreenFrame` with a virtualized child, so
 * a 300-row backlog never mounts 300 rows.
 */
export function Screen({ onRefresh, refreshing = false, children, ...chrome }: ScreenProps) {
  const styles = useThemedStyles(createStyles);
  const refreshControl = useRefreshControl(onRefresh, refreshing);
  const bottomInset = useScreenBottomInset();

  return (
    <ScreenFrame {...chrome}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + space["4xl"] }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}
        style={styles.scroll}
      >
        {children}
      </ScrollView>
    </ScreenFrame>
  );
}

/**
 * Fixed header, caller-owned body. The body is expected to be the scroll
 * container (a `FlatList`/`SectionList`), which is what keeps the header pinned
 * while the list scrolls under it, exactly as the mockups draw it.
 *
 * `staleMessage` is for the one case a list cannot state itself: rows are on
 * screen, so the list's own error empty-state never renders, but the read that
 * would have refreshed them failed. Pass it only when there are rows to be stale.
 */
export function ScreenFrame({
  children,
  staleMessage,
  ...chrome
}: ScreenChromeProps & { staleMessage?: string | null; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={[styles.root, chrome.ground === "agent" ? styles.agentGround : null]}>
      <ScreenHeader {...chrome} />
      {staleMessage ? <StaleSnapshotBanner message={staleMessage} /> : null}
      {/* Android resizes the window itself (`adjustResize` in the manifest), so
          only iOS needs the padding behavior; passing one on Android
          double-counts the keyboard. */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.body}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * The tab bar already reserves the home indicator; outside the tabs (the auth,
 * pairing, and session-status gate) the screen must reserve it itself.
 */
export function useScreenBottomInset(): number {
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const insets = useSafeAreaInsets();
  return tabBarHeight ?? insets.bottom;
}

/** Themed pull-to-refresh, or `undefined` when the screen has nothing to refresh. */
export function useRefreshControl(onRefresh: (() => void) | undefined, refreshing: boolean) {
  const { colors } = useTheme();

  if (!onRefresh) {
    return undefined;
  }

  return (
    <RefreshControl
      colors={[colors.textPrimary]}
      onRefresh={onRefresh}
      progressBackgroundColor={colors.bgSurface}
      refreshing={refreshing}
      tintColor={colors.textMuted}
    />
  );
}

/**
 * Content padding for a `ScreenFrame` list body, matching `Screen`'s canvas.
 * `gap` is the rhythm between rows: `space.xl` for blocks, `space.sm` for
 * dense list rows.
 */
export function useListContentStyle(gap: number = space.lg) {
  const styles = useThemedStyles(createStyles);
  const bottomInset = useScreenBottomInset();
  return [styles.content, { gap, paddingBottom: bottomInset + space["4xl"] }];
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bgApp,
    },
    agentGround: {
      backgroundColor: colors.agentSurface,
    },
    body: {
      flex: 1,
    },
    scroll: {
      backgroundColor: colors.bgApp,
    },
    // The site's page: a 20px gutter and 12px between cards.
    content: {
      gap: space.lg,
      paddingHorizontal: space["2xl"],
      paddingTop: space.xl,
    },
  });
