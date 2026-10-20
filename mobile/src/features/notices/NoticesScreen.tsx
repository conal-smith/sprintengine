import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, StatusDot } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { FolderGlyph, iconSize } from "../../components/glyphs";
import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { useNow } from "../../components/useNow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";
import { formatChatSettledAt, type ChatListRow } from "../conversations/conversationListLogic";
import { buildNotices, splitNotices, type Notice, type NoticeLane } from "./noticesLogic";

/**
 * The bell.
 *
 * A big title, the desktop as its subtitle, a two-segment
 * toggle between what needs you and what can wait, then Open and Resolved.
 * Everything on it is derived from the chat list the phone already holds —
 * there is no notification store.
 *
 * Resolved is derived too: a needs-you row is resolved when its chat is no
 * longer waiting, which is exactly when it stops being produced. That is
 * why the resolved section is what the phone saw last time and no longer sees,
 * rather than a flag anybody sets.
 */
export function NoticesScreen({
  chats,
  openedAt,
  desktopName,
  readIds,
  onMarkAllRead,
  onBack,
  onOpenChat,
  onPruneRead,
}: {
  chats: readonly ChatListRow[];
  openedAt: Record<string, number>;
  desktopName: string | null;
  readIds: string[];
  onMarkAllRead: (ids: string[]) => void;
  onBack: () => void;
  onOpenChat: (target: Notice["target"]) => void;
  /** Drops read ids whose notices no longer exist, so the set cannot grow forever. */
  onPruneRead: (notices: readonly Notice[]) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const now = useNow(false);
  const [lane, setLane] = useState<NoticeLane>("needs-you");

  const notices = useMemo(() => buildNotices({ chats, openedAt, now }), [chats, now, openedAt]);
  // The read set is pruned against the notices that still exist — here rather
  // than on every poll, because this is the only screen that has the full list
  // and the only one where the cost of a stale id is visible.
  useEffect(() => {
    onPruneRead(notices);
  }, [notices, onPruneRead]);

  const lanes = splitNotices(notices, readIds);
  const rows = lane === "needs-you" ? lanes.needsYou : lanes.canWait;
  const unreadIds = new Set(lanes.unreadCanWait.map((notice) => notice.id));

  return (
    <ScreenFrame backLabel="Back to chats" flush onBack={onBack}>
      <ScrollView contentContainerStyle={contentStyle}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.h1}>
            Notices
          </Text>
          <Text style={styles.sub}>{desktopName ?? "No desktop paired"}</Text>
        </View>

        <SegmentedToggle
          onChange={setLane}
          options={[
            { value: "needs-you", label: `Needs you ${lanes.needsYou.length}` },
            { value: "can-wait", label: `Can wait ${lanes.canWait.length}` },
          ]}
          value={lane}
        />

        <View style={styles.sectionRow}>
          <Text accessibilityRole="header" style={styles.section}>
            Open
          </Text>
          {lane === "can-wait" && lanes.unreadCanWait.length > 0 ? (
            <Pressable
              accessibilityLabel="Mark all read"
              accessibilityRole="button"
              onPress={() => onMarkAllRead(lanes.canWait.map((notice) => notice.id))}
            >
              <Text style={styles.markRead}>Mark all read</Text>
            </Pressable>
          ) : null}
        </View>

        {rows.length === 0 ? (
          <Card>
            <Text style={styles.empty}>
              {lane === "needs-you" ? "Nothing is waiting on you." : "Nothing new since you last looked."}
            </Text>
          </Card>
        ) : (
          <Card variant="list">
            {rows.map((notice, index) => (
              <NoticeRow
                first={index === 0}
                key={notice.id}
                notice={notice}
                now={now}
                onOpen={() => onOpenChat(notice.target)}
                unread={unreadIds.has(notice.id)}
              />
            ))}
          </Card>
        )}
      </ScrollView>
    </ScreenFrame>
  );
}

function NoticeRow({
  notice,
  now,
  first,
  unread,
  onOpen,
}: {
  notice: Notice;
  now: number;
  first: boolean;
  unread: boolean;
  onOpen: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const waiting = notice.lane === "needs-you";

  return (
    <Pressable
      accessibilityHint={waiting ? "Opens the chat that is waiting." : "Opens it."}
      accessibilityLabel={[notice.title, notice.message, notice.context].filter(Boolean).join(", ")}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivider,
        pressed ? styles.rowPressed : null,
        // A can-wait row that has been read stays in the list, quieter. It is
        // not removed: "mark all read" is not "delete", and a person who read
        // something an hour ago may still want to find it.
        !waiting && !unread ? styles.rowRead : null,
      ]}
    >
      <View style={styles.rowDot}>
        <StatusDot tone={waiting ? "warn" : "good"} />
      </View>
      <View style={styles.rowText}>
        <Text numberOfLines={2} style={[styles.rowTitle, waiting ? styles.rowTitleWarn : null]}>
          {notice.title}
        </Text>
        {notice.message ? (
          <Text numberOfLines={2} style={styles.rowLine}>
            {notice.message}
          </Text>
        ) : null}
        {notice.context ? (
          <View style={styles.rowChips}>
            <Chip icon={<FolderGlyph size={iconSize.xs} />} label={notice.context} />
          </View>
        ) : null}
      </View>
      <Text style={styles.rowAge}>{formatChatSettledAt(notice.at, now)}</Text>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    head: {
      gap: space["3xs"],
      paddingBottom: space.sm,
    },
    h1: {
      fontSize: 30,
      lineHeight: 34,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.5,
      color: colors.textPrimary,
    },
    sub: {
      ...typography.body,
      fontSize: 16,
      color: colors.textMuted,
    },
    sectionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space["2xs"],
      paddingTop: space.sm,
    },
    section: {
      fontSize: 20,
      lineHeight: 26,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
    },
    markRead: {
      ...typography.meta,
      color: colors.accentPrimary,
      fontWeight: fontWeight.medium,
    },
    empty: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.lg,
      paddingHorizontal: space.xl,
      paddingVertical: space.lg,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
    },
    rowPressed: {
      backgroundColor: colors.bgHover,
    },
    rowRead: {
      opacity: 0.65,
    },
    rowDot: {
      paddingTop: space.xs,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
      gap: space["3xs"],
    },
    rowTitle: {
      ...typography.body,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
    },
    rowTitleWarn: {
      color: colors.toneWarn,
    },
    rowLine: {
      ...typography.meta,
      color: colors.textMuted,
    },
    rowChips: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      paddingTop: space["2xs"],
    },
    rowAge: {
      ...typography.micro,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
      paddingTop: space["2xs"],
    },
  });
