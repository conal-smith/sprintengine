import { ScrollView, StyleSheet, Text, View } from "react-native";

import { transportStanding } from "../../api/tailnetTransport";
import type { MobileSession } from "../../api/types";
import { Card, CardRow, StatusDot } from "../../components/Card";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { orderSessionsForFleet, sessionDisplayStatus, sessionStatusLabel } from "../fleet/fleetLogic";

/**
 * The paired desktops, one tap under Settings.
 *
 * A dot, a name, and how it was reached. Everything that used to sit on the
 * Settings root per desktop — endpoint, device id, protocol, last seen, and the
 * three revoke controls — is one more tap in, on the desktop it belongs to.
 */
export function DesktopsScreen({
  sessions,
  activeDeviceId,
  isFleetRefreshing,
  onRefreshFleet,
  onBack,
  onOpenDesktop,
  onStartPairing,
}: {
  sessions: MobileSession[];
  activeDeviceId: string | null;
  isFleetRefreshing: boolean;
  onRefreshFleet: () => void;
  onBack: () => void;
  onOpenDesktop: (deviceId: string) => void;
  onStartPairing: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const refreshControl = useRefreshControl(onRefreshFleet, isFleetRefreshing);
  const ordered = orderSessionsForFleet(sessions);

  return (
    <ScreenFrame backLabel="Back to settings" count={sessions.length} onBack={onBack} title="Paired desktops">
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        {ordered.length === 0 ? (
          <Card>
            <Text style={styles.notice}>No desktops are paired with this phone.</Text>
          </Card>
        ) : (
          <Card variant="list">
            {ordered.map((item, index) => {
              const status = sessionDisplayStatus(item);
              const standing = transportStanding(item);
              // Which side is behind, in two words; the detail screen says the sentence.
              const standingWord = standing === "studio-older" ? " · Studio older" : standing === "app-older" ? " · app older" : "";
              return (
                <CardRow
                  accessibilityLabel={`${item.desktopName}, ${sessionStatusLabel[status]}`}
                  chevron
                  first={index === 0}
                  key={item.deviceId}
                  leading={<StatusDot tone={status === "online" ? "good" : status === "revoked" ? "danger" : "neutral"} />}
                  meta={`${sessionStatusLabel[status]}${standingWord}`}
                  onPress={() => onOpenDesktop(item.deviceId)}
                  selected={item.deviceId === activeDeviceId}
                  title={item.desktopName}
                />
              );
            })}
          </Card>
        )}
        <View style={styles.action}>
          <PrimaryButton
            label={sessions.length > 0 ? "Pair another desktop" : "Pair a desktop"}
            onPress={onStartPairing}
            variant="secondary"
          />
        </View>
      </ScrollView>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    action: {
      paddingTop: space.sm,
    },
  });
