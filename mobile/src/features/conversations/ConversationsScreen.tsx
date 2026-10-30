import { useFocusEffect } from "@react-navigation/native";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, BackHandler, Easing, Keyboard, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";

import { BottomSheet } from "../../components/BottomSheet";
import { CircleButton } from "../../components/CircleButton";
import { ExpandingSearch } from "../../components/ExpandingSearch";
import {
  BellIcon,
  CliLogo,
  FolderGlyph,
  GearIcon,
  iconSize,
  LifecycleGlyph,
  PlusIcon,
  RemoteMachineGlyph,
  ScheduleIcon,
  SearchIcon,
  WorktreeGlyph,
} from "../../components/glyphs";
import { motionDurations, useReducedMotion } from "../../components/motion";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { SheetOption } from "../../components/SheetOption";
import { useNow } from "../../components/useNow";
import { WorkingMark } from "../../components/WorkingMark";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, hitTargetMin, radius, space, typography, type Theme, withAlpha } from "../../theme/tokens";
import { projectHueColor } from "../../theme/projectHue";
import { useChats } from "./ChatsContext";
import { markUnreadOffered } from "./chatLifecycleLogic";
import { chatHostMark, pullRequestMark } from "./chatMarks";
import { MachineMarkLabel, openPullRequest, PullRequestMarkButton } from "./ChatMarkViews";
import {
  chatCliMark,
  chatOpenedKey,
  chatRowState,
  chatActivity,
  chatWorksInBackground,
  chatModelName,
  chatRestingAt,
  chatRowTitle,
  formatChatSettledAt,
  groupChatsByProject,
  chatSections,
  matchesChatSearch,
  type ChatListRow,
  type ChatRowState,
} from "./conversationListLogic";
import type { ConversationTarget } from "./conversationLogic";

type Section = { key: string; title: string | null; hue?: number | null; data: ChatListRow[] };
// How often the list in front reads its chats while an agent works.
const LIST_POLL_MS = 15_000;

/**
 * Home: chats across every paired desktop, in the desktop sidebar's shape
 * (design 2026-09-29-desktop-chat-parity, part five). The wordmark leads the
 * top bar, with search, the bell and Settings beside it; New floats over the
 * list. Search grows out of its button across the bar (`ExpandingSearch`),
 * so the list starts right under the bar. Grouping by project is a setting,
 * not a control here.
 *
 * One flat list rather than a section per desktop: the machine is a pill on
 * the row. Live and recent chats come first and everything that settled more
 * than a day ago sits under "Earlier", which is the one split worth making —
 * the rest is order, not grouping.
 *
 * Each row carries the CLI's mark, the title, and a trailing seat that is a
 * working mark with its timer, a warn shape with "Needs you", an error shape
 * with "Failed", or a bare time. The surface does the rest: gold for a chat
 * waiting on you, green for one that finished since anyone last looked.
 *
 * Rows are in the order the person last wrote in each, as on the desktop: a
 * state tints a row and never moves it. Where the desktop takes them, a long
 * press offers Mark unread, which shows the chat's latest finish as unseen
 * again on every device, and Settle, which moves the chat to the desktop's
 * Settled shelf and off this list.
 */
export function ConversationsScreen({
  onOpen,
  onNew,
  onOpenNotices,
  onOpenScheduled,
  onOpenSettings,
  noticeCount,
}: {
  onOpen: (target: ConversationTarget) => void;
  /** Step one of New; the button is drawn only where some desktop may start a chat. */
  onNew: () => void;
  onOpenNotices: () => void;
  /** The scheduled agents on every paired desktop; absent, no button. */
  onOpenScheduled?: () => void;
  onOpenSettings: () => void;
  /** Drives the bell's dot; the count itself lives on the notices screen. */
  noticeCount: number;
}) {
  const {
    chats: rows,
    failures,
    loaded,
    refreshing,
    refresh,
    revalidate,
    openedAt,
    markChatOpened,
    settleChat,
    markUnreadChat,
    streamingDesktops,
    canStart,
    groupByProject,
  } = useChats();
  const styles = useThemedStyles(createStyles);
  const content = useListContentStyle(space["2xs"]);
  const [query, setQuery] = useState("");
  // The list filters on a deferred copy, so a keystroke paints in the field
  // before the list redraws for it.
  const deferredQuery = useDeferredValue(query);
  const search = useExpandingSearch(() => setQuery(""));
  // The chat a long press asked about: its sheet offers Mark unread and Settle.
  const [menuRow, setMenuRow] = useState<ChatListRow | null>(null);
  // The chat the person went into, so coming back marks it seen at the moment
  // they left it: a turn that ended while it was open was watched, not missed.
  const openedChat = useRef<string | null>(null);

  // On every return to the list, not only the first: a chat opened from here
  // has moved on by the time the person comes back. The chats are read
  // afresh; the workspaces that name them only when one is new.
  useFocusEffect(
    useCallback(() => {
      if (openedChat.current) {
        markChatOpened(openedChat.current);
        openedChat.current = null;
      }
      void revalidate();
    }, [markChatOpened, revalidate]),
  );
  const refreshControl = useRefreshControl(() => void refresh(), refreshing);

  const anyWorking = rows.some(
    (row) => row.thread.phase === "running" || row.thread.phase === "starting" || chatWorksInBackground(row.thread),
  );
  const now = useNow(anyWorking);
  // Kept current while in front, not only when navigated back to: coming
  // back to the app, which focus does not announce, reads the chats, and so
  // does every 15s while an agent works, so a row's "Working" and the bell's
  // notices built from the list do not stay as they were left. A list read
  // only on navigation is a list of how things were when the person last
  // looked, which on a phone can be hours.
  useFocusEffect(
    useCallback(() => {
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") void revalidate();
      });
      const poll = anyWorking
        ? setInterval(() => {
            if (AppState.currentState === "active") void revalidate();
          }, LIST_POLL_MS)
        : undefined;
      return () => {
        subscription.remove();
        if (poll) clearInterval(poll);
      };
    }, [anyWorking, revalidate]),
  );
  const showDesktop = streamingDesktops > 1;
  const view = groupByProject ? "project" : "recent";
  const sections = useMemo<Section[]>(() => {
    const matching = rows.filter((row) => matchesChatSearch(row, deferredQuery));
    if (view === "project") {
      return groupChatsByProject(matching, now).map((group) => ({
        key: group.key,
        title: group.projectName,
        hue: group.projectHue,
        data: group.rows,
      }));
    }
    const { recent, earlier } = chatSections(matching, now);
    return [
      ...(recent.length ? [{ key: "recent", title: null, data: recent }] : []),
      ...(earlier.length ? [{ key: "earlier", title: "Earlier", data: earlier }] : []),
    ];
  }, [now, deferredQuery, rows, view]);

  const open = useCallback(
    (row: ChatListRow) => {
      const key = chatOpenedKey(row.deviceId, row.thread.agentId);
      markChatOpened(key);
      openedChat.current = key;
      onOpen({ deviceId: row.deviceId, thread: row.thread });
    },
    [markChatOpened, onOpen],
  );

  // The row goes at once; a refusal brings it back with a toast saying why.
  const settle = useCallback(
    (row: ChatListRow) => {
      setMenuRow(null);
      void settleChat(row);
    },
    [settleChat],
  );
  // The row goes green the moment the desktop answers; a refusal says why.
  const markUnread = useCallback(
    (row: ChatListRow) => {
      setMenuRow(null);
      void markUnreadChat(row);
    },
    [markUnreadChat],
  );
  const offersMarkUnread = (row: ChatListRow) =>
    markUnreadOffered(row, { now, openedAt: openedAt[chatOpenedKey(row.deviceId, row.thread.agentId)] ?? null });

  const trimmed = deferredQuery.trim();
  return (
    <ScreenFrame
      overlay={
        <ExpandingSearch
          accessibilityLabel="Search chats by title, project or machine"
          onChangeText={setQuery}
          onClose={search.close}
          open={search.open}
          origin={search.origin}
          placeholder="Search chats"
          progress={search.progress}
          ref={search.inputRef}
          value={query}
        />
      }
      trailing={
        <Animated.View
          importantForAccessibility={search.open ? "no-hide-descendants" : "auto"}
          onLayout={search.onTrailingLayout}
          pointerEvents={search.open ? "none" : "auto"}
          style={[styles.trailing, { opacity: search.buttonsOpacity }]}
        >
          <CircleButton
            active={search.open}
            icon={<SearchIcon size={iconSize.md} tone="textPrimary" />}
            label="Search chats"
            onPress={search.show}
          />
          {onOpenScheduled ? (
            <CircleButton
              icon={<ScheduleIcon size={iconSize.md} tone="textPrimary" />}
              label="Scheduled agents"
              onPress={onOpenScheduled}
            />
          ) : null}
          <CircleButton
            badge={noticeCount > 0}
            icon={<BellIcon size={iconSize.md} tone="textPrimary" />}
            label={noticeCount > 0 ? `Notices, ${noticeCount} open` : "Notices"}
            onPress={onOpenNotices}
          />
          <CircleButton icon={<GearIcon size={iconSize.md} tone="textPrimary" />} label="Settings" onPress={onOpenSettings} />
        </Animated.View>
      }
      wordmark
    >
      <SectionList<ChatListRow, Section>
        contentContainerStyle={content}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => JSON.stringify([item.deviceId, item.thread.workspaceId, item.thread.agentId])}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {!streamingDesktops
              ? "Update Studio and pair over your tailnet with conversation access to read chats here."
              : !loaded
                ? "Loading chats…"
                : trimmed
                  ? `No chats match “${trimmed}”.`
                  : failures.length
                    ? null
                    : canStart
                      ? "No chats yet. Start one with New."
                      : "No chats yet. Start one in Studio and it appears here."}
          </Text>
        }
        ListHeaderComponent={
          failures.length ? (
            <Text accessibilityRole="alert" style={styles.failure}>
              {failures.length === 1 ? `${failures[0]} is` : `${failures.join(", ")} are`} unavailable. Check the
              tailnet connection, then refresh.
            </Text>
          ) : null
        }
        refreshControl={refreshControl}
        // The clock reaches a row only as the words it draws from it, so a
        // tick that moves no row's time or surface leaves every row as drawn.
        renderItem={({ item, section }) => {
          const unreadable = offersMarkUnread(item);
          return (
            <ChatRow
              onMarkUnread={unreadable ? markUnread : undefined}
              onMenu={item.settleable || unreadable ? setMenuRow : undefined}
              onOpen={open}
              onSettle={item.settleable ? settle : undefined}
              row={item}
              settled={section.key === "earlier"}
              showDesktop={showDesktop}
              showProject={view === "recent"}
              state={chatRowState(item.thread, {
                now,
                openedAt: openedAt[chatOpenedKey(item.deviceId, item.thread.agentId)] ?? null,
                lifecycle: item.lifecycle,
              })}
              time={formatChatSettledAt(chatRestingAt(item.thread), now)}
            />
          );
        }}
        renderSectionHeader={({ section }) =>
          view === "project" ? (
            <ProjectHeader count={section.data.length} hue={section.hue ?? null} name={section.title ?? "Other"} />
          ) : section.title ? (
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {section.title}
            </Text>
          ) : null
        }
        sections={sections}
        stickySectionHeadersEnabled={false}
        style={styles.list}
      />
      {canStart ? (
        <View pointerEvents="box-none" style={styles.fab}>
          <CircleButton
            icon={<PlusIcon size={iconSize.lg} tone="buttonInk" />}
            label="New"
            onPress={onNew}
            size={60}
            variant="inverse"
          />
        </View>
      ) : null}
      <BottomSheet
        onClose={() => setMenuRow(null)}
        title={menuRow ? chatRowTitle(menuRow).title : "Chat"}
        visible={menuRow !== null}
      >
        {menuRow && offersMarkUnread(menuRow) ? (
          <SheetOption
            label="Mark unread"
            onPress={() => markUnread(menuRow)}
            sub={`Shows its latest reply as new again, here and on ${menuRow.desktopName}.`}
          />
        ) : null}
        {menuRow?.settleable ? (
          <SheetOption
            label="Settle"
            onPress={() => settle(menuRow)}
            sub={`Moves it to Settled on ${menuRow.desktopName}, and off this list.`}
          />
        ) : null}
      </BottomSheet>
    </ScreenFrame>
  );
}

/**
 * The top bar's search: whether it is open, and the one 0→1 value its growth
 * and the bar buttons' fade both run on. Opening focuses the field as it
 * starts to grow, so the keyboard rises with the field rather than after it; closing (the close
 * mark or Android's back) drops the keyboard, empties the query and shrinks
 * it back into the button. Reduced motion jumps instead of growing.
 */
function useExpandingSearch(onClosed: () => void) {
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const inputRef = useRef<TextInput>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const buttonsOpacity = useMemo(
    () => progress.interpolate({ inputRange: [0, 0.35], outputRange: [1, 0], extrapolate: "clamp" }),
    [progress],
  );

  // Android raises the keyboard on a focus request whether or not the field
  // took the focus, and a field asked in the tick it opens does not take it:
  // the keyboard came up attached to nothing. So the field is asked on the
  // next frame, and again once grown if it still is not focused.
  const focusField = useCallback(() => {
    const input = inputRef.current;
    if (input && !input.isFocused()) input.focus();
  }, []);
  const run = useCallback(
    (toValue: 0 | 1, done?: () => void) => {
      progress.stopAnimation();
      if (reducedMotion) {
        progress.setValue(toValue);
        done?.();
        return;
      }
      Animated.timing(progress, {
        toValue,
        duration: motionDurations.base,
        easing: toValue ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) done?.();
      });
    },
    [progress, reducedMotion],
  );
  const show = useCallback(() => {
    setOpen(true);
    run(1, focusField);
  }, [focusField, run]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(focusField);
    return () => cancelAnimationFrame(frame);
  }, [focusField, open]);
  const close = useCallback(() => {
    inputRef.current?.blur();
    Keyboard.dismiss();
    setOpen(false);
    run(0);
    onClosedRef.current();
  }, [run]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close, open]);

  // The search button leads the trailing buttons, so its disc starts the
  // trailing row's width (less the touch padding around the disc) from the
  // bar's right content edge.
  const onTrailingLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) => setOrigin(event.nativeEvent.layout.width - (hitTargetMin - 40) / 2),
    [],
  );

  return { open, show, close, progress, buttonsOpacity, origin, inputRef, onTrailingLayout };
}

/**
 * One chat as the desktop sidebar draws it. In the recent view, three lines:
 * the project in its hue with the time, the title summary (with the agent's
 * name beside it only where a workspace holds several chats), then the CLI's
 * mark and what the chat is doing. The project view drops the first line,
 * since the header above has already named the project.
 *
 * Memoised: the list draws every row whenever the screen renders (a refresh,
 * a search keystroke, the clock), and a row whose chat has not moved is the
 * row it was.
 */
const ChatRow = memo(function ChatRow({
  row,
  state,
  time,
  settled,
  showDesktop,
  showProject,
  onOpen,
  onMenu,
  onSettle,
  onMarkUnread,
}: {
  row: ChatListRow;
  /** `chatRowState` for this chat now. */
  state: ChatRowState;
  /** When it last moved, as the seat says it (`formatChatSettledAt`). */
  time: string;
  /** Under "Earlier": the title drops to the resting ink, as a read mail does. */
  settled: boolean;
  showDesktop: boolean;
  showProject: boolean;
  onOpen: (row: ChatListRow) => void;
  /** The row's long press: a sheet of what can be done to the chat. Absent where nothing can. */
  onMenu?: (row: ChatListRow) => void;
  /** Settle, as the screen reader's action on the row; absent where the desktop does not take it. */
  onSettle?: (row: ChatListRow) => void;
  /** Mark unread, as the screen reader's action on the row; absent where it is not offered. */
  onMarkUnread?: (row: ChatListRow) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors, isDark } = useTheme();
  const { thread } = row;
  const activity = chatActivity(thread);
  const mark = chatCliMark(thread);
  const { title, agent } = chatRowTitle(row);
  const working = activity.tone === "working";
  const projectInk = projectHueColor(row.projectHue, isDark ? "dark" : "light") ?? colors.textSubtle;
  const desktop = showDesktop ? row.desktopName : null;
  const project = showProject ? row.projectName : null;
  // Where the chat runs when that is not the desktop itself (a WSL
  // distribution, an SSH machine), and its pull request: both as the desktop
  // lists them, and absent from a desktop that does not.
  const machine = chatHostMark(thread.host);
  const pr = pullRequestMark(thread.pullRequests, { includeClosed: false });
  // The time, or the working mark while it works: at the end of the project
  // line in the recent view, of the title line in the project view.
  const seat = working ? (
    <WorkingMark color={colors.accentPrimary} seed={thread.agentId} size={12} />
  ) : (
    <Text style={styles.time}>{time}</Text>
  );
  // The row speaks as one element, so what is inside it, or behind its long
  // press, is offered as its actions.
  const actions = [
    ...(pr ? [{ name: "openPullRequest", label: `Open pull request ${pr.text}` }] : []),
    ...(onMarkUnread ? [{ name: "markUnread", label: "Mark unread" }] : []),
    ...(onSettle ? [{ name: "settle", label: "Settle" }] : []),
  ];
  return (
    <Pressable
      accessibilityHint={ACCESSIBILITY_HINT[state]}
      accessibilityLabel={[
        title,
        agent,
        `${mark.label} chat`,
        chatModelName(thread),
        activity.text,
        project,
        project && row.worktree ? "in a worktree" : null,
        desktop,
        machine ? `on ${machine.label}` : null,
        pr ? pr.spokenInRow : null,
        working ? null : time,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityActions={actions.length ? actions : undefined}
      onAccessibilityAction={(event) => {
        if (pr && event.nativeEvent.actionName === "openPullRequest") openPullRequest(pr);
        if (event.nativeEvent.actionName === "markUnread") onMarkUnread?.(row);
        if (event.nativeEvent.actionName === "settle") onSettle?.(row);
      }}
      accessibilityRole="button"
      onLongPress={onMenu ? () => onMenu(row) : undefined}
      onPress={() => onOpen(row)}
      style={({ pressed }) => [
        styles.row,
        state === "needs-input" ? styles.needsInput : null,
        state === "finished" ? styles.finished : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {project || desktop || machine ? (
        <View style={styles.line}>
          {project ? (
            <View style={styles.project}>
              <FolderGlyph ink={projectInk} size={iconSize.xs} />
              <Text numberOfLines={1} style={styles.projectText}>
                {project}
              </Text>
              {/* A chat in one of the project's worktrees wears the
                  project's name and the worktree's mark, as the desktop's
                  sidebar files it, not the worktree's folder ("pool-02"). */}
              {row.worktree ? <WorktreeGlyph size={iconSize.xs} tone="textSubtle" /> : null}
            </View>
          ) : null}
          {desktop ? (
            <View style={styles.project}>
              <RemoteMachineGlyph size={iconSize.xs} />
              <Text numberOfLines={1} style={styles.projectText}>
                {desktop}
              </Text>
            </View>
          ) : null}
          {machine ? <MachineMarkLabel mark={machine} textStyle={styles.projectText} /> : null}
          <View style={styles.grow} />
          {seat}
        </View>
      ) : null}
      <View style={styles.line}>
        <Text
          numberOfLines={1}
          style={[
            styles.title,
            settled ? styles.titleSettled : null,
            state === "needs-input" ? styles.titleWarn : null,
          ]}
        >
          {title}
          {agent ? <Text style={styles.agent}>{`  ${agent}`}</Text> : null}
        </Text>
        {project || desktop || machine ? null : seat}
      </View>
      <View style={styles.detail}>
        <View style={styles.markTile}>
          <CliLogo cli={mark.kind === "chat" ? null : mark.cli} label={mark.label} size={iconSize.xs} />
        </View>
        <View style={styles.modelPill}>
          <Text numberOfLines={1} style={styles.modelPillText}>
            {chatModelName(thread)}
          </Text>
        </View>
        {activity.tone === "warn" ? <LifecycleGlyph size={iconSize.xs} state="needs_input" /> : null}
        {activity.tone === "failed" ? <LifecycleGlyph size={iconSize.xs} state="failed" /> : null}
        {activity.text ? (
          <Text
            numberOfLines={1}
            style={[
              styles.activity,
              working ? styles.activityWorking : null,
              activity.tone === "warn" ? styles.activityWarn : null,
              activity.tone === "failed" ? styles.activityFailed : null,
            ]}
          >
            {activity.text}
          </Text>
        ) : null}
        {pr ? (
          <>
            <View style={styles.grow} />
            <PullRequestMarkButton mark={pr} />
          </>
        ) : null}
      </View>
    </Pressable>
  );
});

/** A project in the project view: its folder in its hue, its name, and how many chats. */
function ProjectHeader({ name, hue, count }: { name: string; hue: number | null; count: number }) {
  const styles = useThemedStyles(createStyles);
  const { colors, isDark } = useTheme();
  const ink = projectHueColor(hue, isDark ? "dark" : "light") ?? colors.textMuted;
  return (
    <View accessibilityLabel={`${name}, ${count} ${count === 1 ? "chat" : "chats"}`} accessibilityRole="header" style={styles.projectHeader}>
      <FolderGlyph ink={ink} size={iconSize.sm} />
      <Text numberOfLines={1} style={[styles.projectHeaderText, { color: ink }]}>
        {name}
      </Text>
      <Text style={styles.projectCount}>{count}</Text>
    </View>
  );
}

// The surface reaches no screen reader; the hint is where it is spoken.
const ACCESSIBILITY_HINT: Record<ChatRowState, string> = {
  "needs-input": "Waiting for your answer.",
  finished: "Finished while you were away.",
  failed: "This chat's last turn failed.",
  working: "Working now.",
  idle: "Opens the chat.",
};

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    list: {
      flex: 1,
    },
    trailing: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
    },
    row: {
      gap: space["2xs"],
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: "transparent",
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    // The attention surface, ring and all.
    needsInput: {
      backgroundColor: colors.toneWarnSoft,
      borderColor: colors.toneWarn,
    },
    // The finished surface: one notch under the gold by construction.
    finished: {
      backgroundColor: withAlpha(colors.toneGood, 0.1),
      borderColor: withAlpha(colors.toneGood, 0.55),
    },
    line: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      minWidth: 0,
    },
    title: {
      flex: 1,
      minWidth: 0,
      fontSize: 16,
      lineHeight: 21,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.2,
      color: colors.textPrimary,
    },
    titleSettled: {
      color: colors.textDefault,
      fontWeight: fontWeight.regular,
    },
    titleWarn: {
      color: colors.toneWarn,
    },
    // The agent beside the title, where several chats share a workspace.
    agent: {
      ...typography.meta,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
    },
    time: {
      ...typography.meta,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    detail: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minWidth: 0,
    },
    modelPill: {
      height: 20,
      paddingHorizontal: space.sm,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      justifyContent: "center",
      flexShrink: 1,
      minWidth: 0,
    },
    modelPillText: {
      ...typography.micro,
      color: colors.textMuted,
    },
    activity: {
      ...typography.meta,
      flexShrink: 1,
      color: colors.textSubtle,
    },
    activityWorking: {
      color: colors.accentPrimary,
    },
    activityWarn: {
      color: colors.toneWarn,
      fontWeight: fontWeight.medium,
    },
    activityFailed: {
      color: colors.toneError,
    },
    project: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      flexShrink: 1,
      minWidth: 0,
    },
    grow: {
      flex: 1,
    },
    // The CLI's mark on a small round tile, as the sidebar sets it.
    markTile: {
      width: 20,
      height: 20,
      borderRadius: radius.chip,
      backgroundColor: colors.bgSurfaceRaised,
      borderWidth: 1,
      borderColor: colors.cardRing,
      alignItems: "center",
      justifyContent: "center",
    },
    projectText: {
      ...typography.meta,
      flexShrink: 1,
      color: colors.textSubtle,
    },
    projectHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space.lg,
      paddingTop: space.xl,
      paddingBottom: space.xs,
    },
    projectHeaderText: {
      ...typography.heading,
      flexShrink: 1,
    },
    projectCount: {
      ...typography.meta,
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    sectionTitle: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textSubtle,
      paddingHorizontal: space.lg,
      paddingTop: space.xl,
      paddingBottom: space.xs,
    },
    failure: {
      ...typography.meta,
      color: colors.toneError,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
    },
    empty: {
      ...typography.meta,
      color: colors.textMuted,
      paddingHorizontal: space.lg,
      paddingVertical: space.lg,
    },
    fab: {
      position: "absolute",
      right: space.xl,
      bottom: space["2xl"],
    },
  });
