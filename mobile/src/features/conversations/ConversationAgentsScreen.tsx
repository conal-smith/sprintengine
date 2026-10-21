import { StyleSheet, Text, View } from "react-native";

import { Card } from "../../components/Card";
import { Screen } from "../../components/Screen";
import { useNow } from "../../components/useNow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, space, typography, type Theme } from "../../theme/tokens";
import { summarizeAgents, type AgentLane } from "./agentLogic";
import { AgentListRow } from "./conversationParts";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";

/**
 * Every agent a chat sent off to work: the ones still working first, then
 * the finished ones newest first, each opening onto its own thread. It reads
 * the chat's own live state, so it keeps up while the agents do.
 */
export function ConversationAgentsScreen({
  conversation,
  onBack,
  onOpenAgent,
}: {
  conversation: LiveConversationKey;
  onBack: () => void;
  onOpenAgent: (laneId: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const live = useLiveConversation(conversation);
  const lanes = live?.lanes ?? [];
  const now = useNow(lanes.some((lane) => lane.status === "running"));
  const { working, finished, footer } = summarizeAgents(lanes);
  const section = (title: string, items: AgentLane[]) =>
    items.length ? (
      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>
          <Text style={styles.headingStrong}>{title}</Text> · {items.length}
        </Text>
        <Card variant="list">
          {items.map((lane, index) => (
            <AgentListRow
              key={lane.id}
              lane={lane}
              now={now}
              first={index === 0}
              onOpen={() => onOpenAgent(lane.id)}
            />
          ))}
        </Card>
      </View>
    ) : null;
  return (
    <Screen title="Agents" subtitle={live ? <Text numberOfLines={1} style={styles.meta}>{live.effectiveThread.title}</Text> : undefined} onBack={onBack}>
      {!live ? (
        <Text style={styles.meta}>Open the chat to follow its agents.</Text>
      ) : !lanes.length ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No agents yet</Text>
          <Text style={styles.meta}>
            When this chat sends agents off to work, to search the code, plan,
            or take on part of a task, they show up here.
          </Text>
        </View>
      ) : (
        <>
          {section("Working", working)}
          {section("Finished", finished)}
          {live.page.hasMore ? (
            <Text style={styles.meta}>
              Older agents are in earlier turns; load them in the chat to see them here.
            </Text>
          ) : null}
          {footer ? <Text style={styles.footer}>{footer}</Text> : null}
        </>
      )}
    </Screen>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    section: { gap: space.xs },
    heading: { ...typography.meta, color: colors.textSubtle, marginHorizontal: space["2xs"] },
    headingStrong: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    meta: { ...typography.meta, color: colors.textMuted },
    empty: { gap: space.xs, paddingTop: space.xl },
    emptyTitle: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    footer: {
      ...typography.meta,
      fontSize: 12.5,
      color: colors.textSubtle,
      textAlign: "center",
      fontVariant: ["tabular-nums"],
    },
  });
