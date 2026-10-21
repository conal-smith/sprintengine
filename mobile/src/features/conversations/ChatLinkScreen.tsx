import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, CardRow } from "../../components/Card";
import { iconSize, RemoteMachineGlyph } from "../../components/glyphs";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { SkeletonRows } from "../../components/Skeleton";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { useChats } from "./ChatsContext";
import { chatOpenedKey, chatRowTitle, resolveChatLink, type ChatListRow } from "./conversationListLogic";
import type { ChatLink, ConversationTarget } from "./conversationLogic";

/**
 * A desktop's chat link opened on the phone (`sprintengine://chat/<id>`,
 * which "Copy link to chat" writes there). The link names a workspace and no
 * desktop, so the phone reads every paired desktop's chats afresh and looks
 * for it: on one desktop it opens at once, in place of this screen; on
 * several the person picks; on none it says so. Like the desktop, it only
 * ever navigates.
 */
export function ChatLinkScreen({
  link,
  onBack,
  onOpen,
}: {
  link: ChatLink;
  onBack: () => void;
  /** Opens the chat in this screen's place. */
  onOpen: (target: ConversationTarget) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const { chats, failures, markChatOpened, refresh, streamingDesktops } = useChats();
  // The list as it is now, not as it was last read: a chat linked from the
  // desktop is often one opened there a moment ago. Read through a ref: the
  // read is rebuilt whenever a pairing is re-read, and that is not a reason
  // to look again.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [read, setRead] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRead(false);
    void refreshRef
      .current()
      .catch(() => undefined)
      .finally(() => {
        if (live) setRead(true);
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  const target = useMemo(() => (read ? resolveChatLink(link, chats) : null), [read, link, chats]);
  const open = (row: ChatListRow) => {
    markChatOpened(chatOpenedKey(row.deviceId, row.thread.agentId));
    onOpen({ deviceId: row.deviceId, thread: row.thread });
  };
  const opened = useRef(false);
  useEffect(() => {
    if (target?.kind !== "one" || opened.current) return;
    opened.current = true;
    open(target.row);
    // Once, the moment the one desktop is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <ScreenFrame onBack={onBack} title="Open chat">
      <ScrollView contentContainerStyle={contentStyle}>
        {!target || target.kind === "one" ? (
          <SkeletonRows count={2} label="Looking for the chat on your desktops" />
        ) : target.kind === "several" ? (
          <View style={styles.group}>
            <Text style={styles.lead}>That chat is on more than one of your desktops. Open it on:</Text>
            <Card variant="list">
              {target.rows.map((row, index) => (
                <CardRow
                  accessibilityLabel={`${chatRowTitle(row).title} on ${row.desktopName}`}
                  chevron
                  first={index === 0}
                  key={row.deviceId}
                  leading={<RemoteMachineGlyph size={iconSize.sm} />}
                  meta={chatRowTitle(row).title}
                  onPress={() => open(row)}
                  title={row.desktopName}
                />
              ))}
            </Card>
          </View>
        ) : (
          <Card>
            <View style={styles.none}>
              <Text accessibilityRole="alert" style={styles.noneTitle}>
                {"That chat isn't on a desktop you're paired with."}
              </Text>
              <Text style={styles.notice}>
                {streamingDesktops === 0
                  ? "None of your paired desktops lists its chats with this phone. Update SprintEngine Studio there, or pair again with chat access."
                  : failures.length
                    ? `${failures.join(", ")} didn't answer, so it may be there.`
                    : "It may have been settled, or it is on a desktop this phone has not paired with."}
              </Text>
              <PrimaryButton label="Try again" onPress={() => setAttempt((value) => value + 1)} variant="secondary" />
            </View>
          </Card>
        )}
      </ScrollView>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    group: {
      gap: space.sm,
    },
    lead: {
      ...typography.meta,
      color: colors.textMuted,
      paddingHorizontal: space["2xs"],
    },
    none: {
      gap: space.md,
      paddingVertical: space.sm,
    },
    noneTitle: {
      ...typography.body,
      color: colors.textPrimary,
    },
    notice: {
      ...typography.meta,
      color: colors.textMuted,
    },
  });
