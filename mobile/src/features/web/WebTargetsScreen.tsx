import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, CardRow } from "../../components/Card";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { shortMachineName, type WebTarget } from "./webTargetsLogic";

/**
 * Web pages on the desktops this phone is paired with.
 *
 * What is listed is a dev server the desktop published on its tailnet
 * (`tailscale serve`), not the desktop's browser pane: the pane holds a
 * `localhost` URL, and localhost on a phone is the phone. Publishing is what
 * turns a loopback port into an origin a phone can actually reach.
 *
 * Tapping hands the URL to the system browser rather than an in-app WebView. A
 * dev server is a real application — it wants JavaScript, storage and cookies —
 * and the app's only WebView is deliberately the opposite of that (JS off,
 * incognito, for untrusted document HTML). The browser is also where a person
 * would want a preview: their own session, their own devtools.
 *
 * Every URL has already passed `isOpenableTailnetUrl`; the check runs again at
 * the tap because the list may have been polled since it was drawn.
 */
export function WebTargetsScreen({
  targets,
  isRefreshing,
  onRefresh,
  onBack,
  onOpen,
}: {
  targets: WebTarget[];
  isRefreshing: boolean;
  onRefresh: () => void;
  onBack: () => void;
  onOpen: (target: WebTarget) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const refreshControl = useRefreshControl(onRefresh, isRefreshing);

  return (
    <ScreenFrame backLabel="Back to settings" count={targets.length} onBack={onBack} title="Web">
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        {targets.length === 0 ? (
          <Card>
            <Text style={styles.notice}>
              No web pages are shared yet. On a paired desktop, open a browser tab in the workspace pane and share a
              running dev server on your tailnet — it will be listed here.
            </Text>
          </Card>
        ) : (
          <Card variant="list">
            {targets.map((target, index) => (
              <CardRow
                accessibilityLabel={`Open ${target.label} on ${shortMachineName(target.machine)} in your browser`}
                chevron
                first={index === 0}
                key={target.id}
                meta={shortMachineName(target.machine)}
                onPress={() => onOpen(target)}
                title={target.label}
              />
            ))}
          </Card>
        )}
        <View style={styles.footer}>
          <Text style={styles.footnote}>
            These open in your browser. They work only while this phone is on the same tailnet as the desktop sharing
            them.
          </Text>
        </View>
      </ScrollView>
    </ScreenFrame>
  );
}

/** Hands a validated target to the system browser. Exported so the route can reuse it. */
export async function openWebTarget(target: WebTarget): Promise<boolean> {
  try {
    await Linking.openURL(target.url);
    return true;
  } catch {
    return false;
  }
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    footer: {
      paddingTop: space.sm,
    },
    footnote: {
      ...typography.meta,
      color: colors.textSubtle,
      textAlign: "center",
    },
  });
