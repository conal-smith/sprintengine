import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { AgentGlyph } from "../../components/glyphs/AgentGlyph";
import { useSecondsClock } from "../../components/useNow";
import { MarkdownDocument } from "../../components/document/MarkdownDocument";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, iconSize, radius, space, typography, type Theme } from "../../theme/tokens";
import {
  laneDetail,
  laneGlyphState,
  laneLabel,
  laneStatus,
  type AgentLane,
} from "./agentLogic";
import {
  describeToolGroup,
  reasoningPreview,
  recordValue,
  stringValue,
  toolStep,
  type FoldPart,
  type MobileTool,
} from "./conversationLogic";
import { createToolDetailCache, readToolDetail, type ToolDetail } from "./toolOutput";
import { ToolOutputPanel, type ToolDetailState } from "./ToolOutputPanel";
import { ConversationPicture, type ChatImages, type SentImages } from "./ConversationImage";
import { toolPicture } from "./conversationImageLogic";
import { DisclosureGlyph, ThoughtGlyph, ToolKindGlyph } from "./toolGlyphs";
import type { usePhoneConversation } from "./usePhoneConversation";

// The pieces the chat and its agent screens draw alike: a quiet tool step, a
// run of steps that rests collapsed once settled, an agent's lane card and its
// row on the Agents screen.

export type RequestDetail = ReturnType<typeof usePhoneConversation>["request"];
/** What a step needs to open onto its detail: the desktop, when it is there to ask. */
export type StepDetailSource = {
  request: RequestDetail;
  live: boolean;
  onNotice: (message: string) => void;
  /** The chat's pictures; null when the desktop does not serve them. */
  images: ChatImages | null;
  /** The pictures the person sent, as the desktop serves them; null or absent when it does not. */
  sentImages?: SentImages | null;
  /** The chat the steps are in (`toolDetailChat`): a step's id is unique only within it. */
  chat: string;
};

// Fetched details outlive the rows that asked: a row scrolled out of the
// chat's list unmounts, and scrolling back reads the detail from here rather
// than asking the desktop again (`createToolDetailCache`), kept by chat and
// step. Only a finished step's detail is fetched at all: a running step shows
// its output as the transcript brings it.
const toolDetails = createToolDetailCache();

/**
 * One step: its kind's glyph, a verb, the thing it acted on in mono, and how
 * it went wrong at the end, when it did. Tapping opens what it produced, read
 * the way its kind reads (`ToolOutputPanel`): a command's terminal text and
 * exit status, a read's file, an edit's change, a search's matches. The
 * transcript's preview shows at once and the whole detail, fetched from the
 * desktop the first time, replaces it; a step that was still running when it
 * was fetched is fetched again once it finishes. An image the agent read
 * opens onto the picture itself, and a picture Codex generated shows under
 * its step without the step being opened. Memoised: an agent's page and an
 * open fold draw many, and a step that has not changed stays as drawn.
 */
export const ToolStepRow = memo(function ToolStepRow({ tool, source }: { tool: MobileTool; source: StepDetailSource }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const { request, live, chat } = source;
  const cacheKey = `${chat}\0${tool.id}`;
  const [detail, setDetail] = useState<ToolDetail | null>(() => toolDetails.get(cacheKey) ?? null);
  const [fetchState, setFetchState] = useState<ToolDetailState>({ kind: "ready" });
  const step = toolStep(tool);
  const picture = source.images ? toolPicture(tool) : null;
  const expandsToPicture = picture?.placement === "expanded";
  const running = tool.status === "running";
  useEffect(() => {
    if (!open || expandsToPicture || detail) return;
    if (running) {
      setFetchState({ kind: "running" });
      return;
    }
    if (!live) {
      setFetchState({ kind: "offline" });
      return;
    }
    let current = true;
    setFetchState({ kind: "loading" });
    void request({ type: "getToolDetail", toolUseId: tool.id })
      .then((value) => {
        const read = readToolDetail(value);
        if (!read) throw new Error(stringValue(recordValue(value).message) || "Tool detail unavailable.");
        if (!current) return;
        toolDetails.set(cacheKey, read);
        setDetail(read);
        setFetchState({ kind: "ready" });
      })
      .catch((error: Error) => {
        if (current) setFetchState({ kind: "failed", message: error.message });
      });
    return () => {
      current = false;
    };
  }, [open, expandsToPicture, detail, running, live, request, tool.id, cacheKey]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[step.label, step.detail].filter(Boolean).join(" ") + (step.end ? `, ${step.end}` : "")}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <ToolKindGlyph kind={step.kind} color={step.live ? colors.accentPrimary : colors.textSubtle} />
        <Text style={[styles.stepLabel, step.live ? styles.stepLabelLive : null]}>{step.label}</Text>
        <Text numberOfLines={1} style={styles.stepPath}>
          {step.detail}
        </Text>
        {step.end ? (
          <Text style={[styles.stepEnd, step.failed ? styles.errorInk : null]}>{step.end}</Text>
        ) : null}
      </Pressable>
      {picture?.placement === "inline" && source.images ? (
        <ConversationPicture images={source.images} picture={picture} toolUseId={tool.id} />
      ) : null}
      {open && expandsToPicture && picture && source.images ? (
        <ConversationPicture images={source.images} picture={picture} toolUseId={tool.id} />
      ) : open ? (
        <ToolOutputPanel tool={tool} detail={detail} state={fetchState} />
      ) : null}
    </View>
  );
});

/**
 * A run of steps. Settled steps rest behind one summary line ("Read 4 files ·
 * 1 search"), closed until tapped, with any failures in error ink so they are
 * never folded out of sight. Live work stays outside the fold, and so do the
 * pictures Codex generated: they are what their steps were for.
 */
export function ToolGroup({ tools, source }: { tools: MobileTool[]; source: StepDetailSource }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const settled = tools.filter((tool) => tool.status !== "running");
  const running = tools.filter((tool) => tool.status === "running");
  const group = describeToolGroup(settled);
  const summary = [group.head, ...group.rest].join(" · ");
  return (
    <View style={styles.steps}>
      {settled.length > 1 ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={group.failed ? `${summary}, ${group.failed} failed` : summary}
            accessibilityState={{ expanded: open }}
            hitSlop={space.xs}
            onPress={() => setOpen(!open)}
            style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
          >
            <ToolKindGlyph kind={group.kind} color={group.failed ? colors.toneError : colors.textSubtle} />
            <Text numberOfLines={1} style={styles.groupHead}>
              {group.head}
              {group.rest.length ? <Text style={styles.groupRest}> · {group.rest.join(" · ")}</Text> : null}
              {group.failed ? <Text style={styles.errorInk}> · {group.failed} failed</Text> : null}
            </Text>
            <View style={styles.end}>
              <DisclosureGlyph open={open} color={colors.textDisabled} />
            </View>
          </Pressable>
          {open ? (
            <View style={styles.rail}>
              {settled.map((tool) => (
                <ToolStepRow key={tool.id} tool={tool} source={source} />
              ))}
            </View>
          ) : source.images ? (
            settled.map((tool) => {
              const picture = toolPicture(tool);
              return picture?.placement === "inline" && source.images ? (
                <ConversationPicture key={tool.id} images={source.images} picture={picture} toolUseId={tool.id} />
              ) : null;
            })
          ) : null}
        </>
      ) : (
        settled.map((tool) => <ToolStepRow key={tool.id} tool={tool} source={source} />)
      )}
      {running.map((tool) => (
        <ToolStepRow key={tool.id} tool={tool} source={source} />
      ))}
    </View>
  );
}

/**
 * What the model thought on its way to a reply, where in the turn it thought
 * it. Closed is its resting state, reasoning being how the answer was reached
 * rather than the answer: "Thinking" and the first line of it, quiet, or
 * "Thinking…" while it is still arriving. Open, it reads as Markdown in the
 * muted ink on the steps' rail, so its lists and code read as themselves
 * without competing with the reply. Closed, a delta costs its first line;
 * its Markdown is drawn only while it is open.
 */
export const ThinkingRow = memo(function ThinkingRow({
  text,
  live,
  onNotice,
}: {
  text: string;
  /** The model is thinking this now. */
  live: boolean;
  onNotice: (message: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => (open ? "" : reasoningPreview(text)), [open, text]);
  // Held, so an open thought is not parsed again for a new handler.
  const onLinkBlocked = useCallback(() => onNotice("This link cannot be opened from a conversation."), [onNotice]);
  const label = live ? "Thinking\u2026" : "Thinking";
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={preview ? `${label} ${preview}` : label}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <ThoughtGlyph color={live ? colors.accentPrimary : colors.textSubtle} />
        <Text style={styles.groupHead}>{label}</Text>
        {preview ? (
          <Text numberOfLines={1} style={styles.thoughtPreview}>
            {preview}
          </Text>
        ) : null}
        <View style={styles.end}>
          <DisclosureGlyph open={open} color={colors.textDisabled} />
        </View>
      </Pressable>
      {open ? (
        <View style={[styles.rail, styles.thought]}>
          <MarkdownDocument body={text} variant="chat" tone="muted" onLinkBlocked={onLinkBlocked} />
        </View>
      ) : null}
    </View>
  );
});

/**
 * A turn's work behind one line: "Worked for 2m 14s · 12 steps", with how
 * many steps went wrong in error ink, closed until tapped. Open, it is the
 * turn as it happened: each run of steps, and what the agent said between
 * them. Closed, the pictures the agent generated still show under the line,
 * and so does the step running now, so a working turn is never a blank line.
 */
export function TurnFold({
  label,
  failed,
  parts,
  source,
  live = false,
}: {
  label: string;
  failed: number;
  parts: FoldPart[];
  source: StepDetailSource;
  /** The turn is still running: what it said may still be arriving. */
  live?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  // Held, so an open turn's prose is not parsed again each time its fold
  // takes another step.
  const { onNotice } = source;
  const onLinkBlocked = useCallback(() => onNotice("This link cannot be opened from a conversation."), [onNotice]);
  const steps = parts.flatMap((part) => (part.kind === "tools" ? part.tools : []));
  const group = describeToolGroup(steps);
  const running = steps.filter((tool) => tool.status === "running");
  return (
    <View style={styles.steps}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={failed ? `${label}, ${failed} failed` : label}
        accessibilityState={{ expanded: open }}
        hitSlop={space.xs}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
      >
        <ToolKindGlyph kind={group.kind} color={failed ? colors.toneError : colors.textSubtle} />
        <Text numberOfLines={1} style={styles.groupHead}>
          {label}
          {failed ? <Text style={styles.errorInk}> · {failed} failed</Text> : null}
        </Text>
        <View style={styles.end}>
          <DisclosureGlyph open={open} color={colors.textDisabled} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.rail}>
          {parts.map((part) =>
            part.kind === "tools" ? (
              <ToolGroup key={part.id} tools={part.tools} source={source} />
            ) : part.kind === "reasoning" ? (
              // Thinking folded with the work it led to: a step came after it,
              // so it is never still arriving.
              <ThinkingRow key={part.id} text={part.text} live={false} onNotice={onNotice} />
            ) : (
              <View key={part.id} style={styles.prose}>
                <MarkdownDocument body={part.text} variant="chat" reply streaming={live} onLinkBlocked={onLinkBlocked} />
              </View>
            ),
          )}
        </View>
      ) : (
        <>
          {source.images
            ? steps.map((tool) => {
                const picture = toolPicture(tool);
                return picture?.placement === "inline" && source.images ? (
                  <ConversationPicture key={tool.id} images={source.images} picture={picture} toolUseId={tool.id} />
                ) : null;
              })
            : null}
          {running.map((tool) => (
            <ToolStepRow key={tool.id} tool={tool} source={source} />
          ))}
        </>
      )}
    </View>
  );
}

function StatusText({ lane, now, style }: { lane: AgentLane; now: number; style?: object }) {
  const styles = useThemedStyles(createStyles);
  const tick = useSecondsClock(lane.status === "running");
  const status = laneStatus(lane, Math.max(now, tick));
  return (
    <Text
      numberOfLines={1}
      style={[
        styles.status,
        style,
        status.tone === "working" ? styles.statusWorking : status.tone === "failed" ? styles.errorInk : null,
      ]}
    >
      {status.text}
    </Text>
  );
}

/**
 * An agent in the transcript: its character, "Explore agent", how it is
 * doing, what it was sent to do, and what it is doing now while it runs.
 * Tapping opens its own thread.
 */
export function AgentLaneCard({ lane, now, onOpen }: { lane: AgentLane; now: number; onOpen?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const detail = laneDetail(lane);
  return (
    <Pressable
      accessibilityRole={onOpen ? "button" : undefined}
      accessibilityLabel={`${laneLabel(lane)}, ${laneStatus(lane, now).text}${lane.task ? `, ${lane.task}` : ""}`}
      disabled={!onOpen}
      onPress={onOpen}
      style={({ pressed }) => [styles.lane, pressed ? styles.pressed : null]}
    >
      <AgentGlyph agentId={lane.id} state={laneGlyphState(lane)} size={26} />
      <View style={styles.laneBody}>
        <View style={styles.laneTop}>
          <Text numberOfLines={1} style={styles.who}>
            {laneLabel(lane)}
          </Text>
          <StatusText lane={lane} now={now} />
        </View>
        {lane.task ? (
          <Text numberOfLines={1} style={styles.what}>
            {lane.task}
          </Text>
        ) : null}
        {lane.status === "running" && detail.text ? (
          <Text numberOfLines={1} style={styles.now}>
            {detail.text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** An agent on the Agents screen: who, how it is doing, its task, and a detail line. */
export function AgentListRow({
  lane,
  now,
  onOpen,
  first,
}: {
  lane: AgentLane;
  now: number;
  onOpen: () => void;
  first: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const detail = laneDetail(lane);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${laneLabel(lane)}: ${lane.task || "agent"}, ${laneStatus(lane, now).text}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.agentRow, first ? null : styles.agentRowRule, pressed ? styles.pressed : null]}
    >
      <View style={styles.agentGlyph}>
        <AgentGlyph agentId={lane.id} state={laneGlyphState(lane)} size={26} />
      </View>
      <View style={styles.laneBody}>
        <View style={styles.laneTop}>
          <Text numberOfLines={1} style={styles.rowWho}>
            {laneLabel(lane)}
          </Text>
          <StatusText lane={lane} now={now} />
        </View>
        {lane.task ? <Text style={styles.rowWhat}>{lane.task}</Text> : null}
        {detail.text ? (
          <Text numberOfLines={1} style={[styles.now, detail.error ? styles.errorInk : null]}>
            {detail.text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    pressed: { opacity: 0.6 },
    steps: { gap: 0 },
    step: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: 32,
    },
    stepLabel: { ...typography.body, fontSize: 14, color: colors.textDefault },
    stepLabelLive: { color: colors.textPrimary },
    stepPath: {
      flexShrink: 1,
      fontFamily: monoFontFamily,
      fontSize: 12.5,
      color: colors.textSubtle,
    },
    stepEnd: { ...typography.meta, marginLeft: "auto", paddingLeft: space.sm, color: colors.textDisabled },
    groupHead: { ...typography.body, fontSize: 14, color: colors.textMuted, flexShrink: 1 },
    groupRest: { color: colors.textSubtle },
    end: { marginLeft: "auto", paddingLeft: space.sm },
    rail: {
      marginLeft: space.xs,
      paddingLeft: space.md,
      borderLeftWidth: 1,
      borderLeftColor: colors.borderSubtle,
    },
    errorInk: { color: colors.toneError },
    prose: { paddingVertical: space.xs },
    thoughtPreview: { ...typography.body, fontSize: 14, color: colors.textSubtle, flexShrink: 1 },
    thought: { paddingTop: space["2xs"] },
    lane: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      paddingVertical: space.md,
      paddingHorizontal: space.lg,
      borderRadius: radius.overlay,
      backgroundColor: colors.bgSurfaceRaised,
      borderWidth: 1,
      borderColor: colors.cardRing,
    },
    laneBody: { flex: 1, minWidth: 0, gap: space["3xs"] },
    laneTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
    who: {
      ...typography.body,
      fontSize: 14,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    status: {
      ...typography.meta,
      fontSize: 12.5,
      marginLeft: "auto",
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    statusWorking: { color: colors.accentPrimary, fontWeight: fontWeight.medium },
    what: { ...typography.meta, fontSize: 13.5, color: colors.textMuted },
    now: { ...typography.meta, fontSize: 12.5, color: colors.textSubtle },
    agentRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.lg,
      padding: space.lg,
    },
    agentRowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
    agentGlyph: { width: iconSize.lg + space.sm, paddingTop: space["3xs"] },
    rowWho: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary, flexShrink: 1 },
    rowWhat: { ...typography.body, fontSize: 14, color: colors.textDefault },
  });
