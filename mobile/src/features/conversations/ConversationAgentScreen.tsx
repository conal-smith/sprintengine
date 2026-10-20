import { Fragment, useCallback, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { AgentGlyph } from "../../components/glyphs/AgentGlyph";
import { MarkdownDocument } from "../../components/document/MarkdownDocument";
import { Screen } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useNow, useSecondsClock } from "../../components/useNow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, radius, space, typography, type Theme } from "../../theme/tokens";
import {
  agentTypeDescription,
  formatDuration,
  formatElapsed,
  formatTokens,
  laneGlyphState,
  laneLabel,
  laneNow,
  laneStatus,
  laneStepCount,
  placeAgentMessages,
} from "./agentLogic";
import { ToolStepRow, type StepDetailSource } from "./conversationParts";
import { toolDetailChat } from "./toolOutput";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";

/**
 * One agent's own thread: what it was sent to do, how it is doing, what it is
 * doing now, the steps it took with what it said between them, and the report
 * it came back with.
 */
export function ConversationAgentScreen({
  conversation,
  laneId,
  onBack,
}: {
  conversation: LiveConversationKey;
  laneId: string;
  onBack: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const live = useLiveConversation(conversation);
  const lane = live?.lanes.find((candidate) => candidate.id === laneId);
  const running = lane?.status === "running";
  // The seconds count in their own text (RunningFor); the page itself only
  // needs the quieter clock, so it is not drawn again every second.
  const now = useNow(false);
  // Held, so what the agent said is not parsed again for each tick or delta.
  const setNotice = live?.setNotice;
  const onLinkBlocked = useCallback(
    () => setNotice?.("This link cannot be opened from a conversation."),
    [setNotice],
  );
  const request = live?.request;
  const state = live?.state;
  const images = live?.images ?? null;
  const stepChat = toolDetailChat(conversation.deviceId, conversation.workspaceId, conversation.agentId);
  const source = useMemo<StepDetailSource | null>(
    () =>
      request && setNotice
        ? { request, live: state === "live", onNotice: setNotice, images, chat: stepChat }
        : null,
    [request, state, setNotice, images, stepChat],
  );
  if (!live || !lane || !source)
    return (
      <Screen title="Agent" onBack={onBack} backLabel="All agents">
        <Text style={styles.meta}>
          {live ? "This agent is in an earlier part of the chat." : "Open the chat to follow its agents."}
        </Text>
      </Screen>
    );
  const status = laneStatus(lane, now);
  const description = agentTypeDescription(lane.subagentType, live.agentTypes);
  const current = laneNow(lane);
  const steps = laneStepCount(lane);
  const tokens = lane.agent?.usage?.totalTokens;
  const took =
    !running && lane.completedAt !== undefined ? formatDuration(lane.completedAt - lane.startedAt) : "";
  const { beforeSteps, afterSteps } = placeAgentMessages(lane);
  const said = (text: string, key: string | number) => (
    <View key={key} style={styles.said}>
      <MarkdownDocument body={text} variant="chat" reply streaming={running} onLinkBlocked={onLinkBlocked} />
    </View>
  );
  return (
    <Screen title={laneLabel(lane)} onBack={onBack} backLabel="All agents">
      <View style={styles.hero}>
        <AgentGlyph agentId={lane.id} state={laneGlyphState(lane)} size={44} />
        <View style={styles.heroText}>
          <Text style={[styles.who, status.tone === "failed" ? styles.errorInk : null]}>
            {laneLabel(lane)} · {running ? "Working" : status.text}
          </Text>
          <Text style={styles.task}>{lane.task || "Agent"}</Text>
        </View>
      </View>
      {running || took || steps || tokens ? (
        <View style={styles.facts}>
          {running ? (
            <RunningFor since={lane.startedAt} />
          ) : took ? (
            <Text style={styles.fact}>
              <Text style={styles.factValue}>{took}</Text>
            </Text>
          ) : null}
          {steps ? (
            <Text style={styles.fact}>
              <Text style={styles.factValue}>{steps}</Text> {steps === 1 ? "step" : "steps"}
            </Text>
          ) : null}
          {tokens ? (
            <Text style={styles.fact}>
              <Text style={styles.factValue}>{formatTokens(tokens).replace(/ tokens$/, "")}</Text> tokens
            </Text>
          ) : null}
        </View>
      ) : null}
      {description ? <Text style={styles.meta}>{description}</Text> : null}
      {running && current ? (
        <View style={styles.nowBox}>
          <WorkingMark seed={lane.id} label="Agent working" />
          <Text style={styles.nowText}>
            <Text style={styles.nowLabel}>Now </Text>
            {current}
          </Text>
        </View>
      ) : null}
      {!running && lane.agent?.error ? (
        <Text style={[styles.meta, status.tone === "failed" ? styles.errorInk : null]}>{lane.agent.error}</Text>
      ) : null}
      <Text accessibilityRole="header" style={styles.group}>
        Steps
      </Text>
      {lane.steps.length ? (
        <View>
          {lane.steps.map((step) => (
            <Fragment key={step.id}>
              {beforeSteps
                .filter((message) => message.beforeToolUseId === step.id)
                .map((message, index) => said(message.text, `${step.id}:${index}`))}
              <ToolStepRow tool={step} source={source} />
            </Fragment>
          ))}
        </View>
      ) : afterSteps.length ? null : (
        <Text style={styles.meta}>
          {running ? "No steps yet; it is still getting started." : "It took no steps of its own."}
        </Text>
      )}
      {afterSteps.map((text, index) => said(text, index))}
      {!running ? (
        <>
          <Text accessibilityRole="header" style={styles.group}>
            Report
          </Text>
          <View style={styles.report}>
            {lane.report?.trim() ? (
              <MarkdownDocument body={lane.report} variant="chat" reply onLinkBlocked={onLinkBlocked} />
            ) : (
              <Text style={styles.meta}>
                {lane.agent?.state === "unknown"
                  ? "It ran in the background, and its report was not recorded."
                  : "It came back with nothing to report."}
              </Text>
            )}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

/** "1m 4s so far" while the agent runs, ticking on its own. */
function RunningFor({ since }: { since: number }) {
  const styles = useThemedStyles(createStyles);
  const now = useSecondsClock(true);
  return (
    <Text style={styles.fact}>
      <Text style={styles.factValue}>{formatElapsed(now - since)}</Text> so far
    </Text>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    meta: { ...typography.meta, color: colors.textMuted },
    errorInk: { color: colors.toneError },
    hero: { flexDirection: "row", alignItems: "center", gap: space.lg },
    heroText: { flex: 1, gap: space["3xs"] },
    who: { ...typography.meta, color: colors.textSubtle },
    task: { ...typography.title, fontSize: 18, lineHeight: 24, color: colors.textPrimary },
    facts: { flexDirection: "row", flexWrap: "wrap", gap: space.xl },
    fact: { ...typography.meta, color: colors.textMuted, fontVariant: ["tabular-nums"] },
    factValue: { fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    nowBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingVertical: space.sm,
      paddingHorizontal: space.lg,
      borderRadius: radius.overlay,
      backgroundColor: colors.accentPrimarySoft,
    },
    nowText: { ...typography.meta, fontSize: 13.5, color: colors.textDefault, flexShrink: 1 },
    nowLabel: { fontWeight: fontWeight.emphasis, color: colors.accentPrimary },
    group: { ...typography.meta, fontWeight: fontWeight.medium, color: colors.textSubtle, marginTop: space.sm },
    said: {
      borderLeftWidth: 2,
      borderLeftColor: colors.borderDefault,
      paddingLeft: space.lg,
      marginLeft: space.xs,
      marginVertical: space.xs,
    },
    report: {
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurface,
    },
  });
