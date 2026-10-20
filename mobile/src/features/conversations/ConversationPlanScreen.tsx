import { useCallback } from "react";
import { StyleSheet, Text } from "react-native";

import { MarkdownDocument } from "../../components/document/MarkdownDocument";
import { Screen } from "../../components/Screen";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { typography, type Theme } from "../../theme/tokens";
import { planBody, planTitle } from "./conversationLogic";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";

const STATUS: Record<"approved" | "denied" | "cancelled", string> = {
  approved: "You approved this plan.",
  denied: "You denied this plan.",
  cancelled: "The turn ended before this plan was answered.",
};

/**
 * A plan the agent proposed, as a page: a plan is a document, with headings,
 * phases and file lists, and it reads as one rather than squeezed into the
 * dock. The decision stays in the chat's dock.
 */
export function ConversationPlanScreen({
  conversation,
  requestId,
  onBack,
}: {
  conversation: LiveConversationKey;
  requestId: string;
  onBack: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const live = useLiveConversation(conversation);
  const plan = live?.plans[requestId];
  // Held, so the plan is not parsed again for every delta the chat streams.
  const setNotice = live?.setNotice;
  const onLinkBlocked = useCallback(
    () => setNotice?.("This link cannot be opened from a conversation."),
    [setNotice],
  );
  return (
    <Screen title={(plan && planTitle(plan.plan)) || "Plan"} subtitle={live ? <Text numberOfLines={1} style={styles.meta}>{live.effectiveThread.title}</Text> : undefined} onBack={onBack}>
      {!plan ? (
        <Text style={styles.meta}>
          {live ? "This plan is in an earlier part of the chat." : "Open the chat to read its plan."}
        </Text>
      ) : (
        <>
          {plan.status !== "pending" ? <Text style={styles.meta}>{STATUS[plan.status]}</Text> : null}
          <MarkdownDocument
            body={planBody(plan.plan) || plan.plan}
            onLinkBlocked={onLinkBlocked}
          />
        </>
      )}
    </Screen>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    meta: { ...typography.meta, color: colors.textMuted },
  });
