import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import { BottomSheet } from "../../components/BottomSheet";
import { Card, CardRow } from "../../components/Card";
import { CircleButton } from "../../components/CircleButton";
import { iconSize, PlusIcon, RemoteMachineGlyph } from "../../components/glyphs";
import { ScreenFrame, useListContentStyle, useRefreshControl } from "../../components/Screen";
import { SheetOption } from "../../components/SheetOption";
import { SkeletonRows } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useNow } from "../../components/useNow";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, space, typography, type Theme } from "../../theme/tokens";
import type { MobileSession } from "../../api/types";
import {
  canOperateSchedules,
  createScheduledAgentsApi,
  nextRunWords,
  scheduleStatusLine,
  type PhoneScheduledAgent,
  type PhoneScheduledAgents,
  type ScheduledAgentAction,
  type ScheduledAgentsApi,
} from "../../api/scheduledAgents";
import { canReadWorkspaces } from "../conversations/conversationListLogic";

type DesktopSchedules = {
  session: MobileSession;
  api: ScheduledAgentsApi;
  read: PhoneScheduledAgents | null;
  error: string | null;
};

const ACTION_DONE: Record<ScheduledAgentAction, string> = {
  run: "Started — its chat is in your list.",
  pause: "Paused. A run already going carries on.",
  resume: "Resumed. It runs at its next time.",
  delete: "Closed. It will not run again.",
};

/**
 * The scheduled agents on every paired desktop: each a prompt and a schedule,
 * run by that desktop whether or not this phone is awake. A run is a chat,
 * listed with the others. Tapping a schedule offers what the desktop's own row
 * does — Run now, Pause or Resume, and Close — where this phone may operate
 * the desktop; New schedules one in a project there.
 */
export function ScheduledAgentsScreen({
  sessions,
  onBack,
  onNew,
}: {
  sessions: MobileSession[];
  onBack: () => void;
  onNew: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const toast = useToast();
  const now = useNow(false);
  const readable = useMemo(() => sessions.filter(canReadWorkspaces), [sessions]);
  const apis = useMemo(
    () =>
      readable.map((session) => ({
        session,
        api: createScheduledAgentsApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }),
      })),
    [readable],
  );
  const [reads, setReads] = useState<Record<string, { read: PhoneScheduledAgents | null; error: string | null }>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [picked, setPicked] = useState<{ desktop: DesktopSchedules; agent: PhoneScheduledAgent } | null>(null);

  const load = useCallback(async () => {
    const answers = await Promise.all(apis.map(async ({ session, api }) => ({ session, result: await api.list() })));
    setReads((current) => {
      const next = { ...current };
      for (const { session, result } of answers) {
        next[session.deviceId] = result.ok
          ? { read: result.data ?? { agents: [], pausedAll: null }, error: null }
          : { read: current[session.deviceId]?.read ?? null, error: result.message ?? "The desktop did not answer." };
      }
      return next;
    });
  }, [apis]);

  // Read each time it comes into view, so one made on New is listed on the way back.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void load().finally(() => {
        if (live) setLoading(false);
      });
      return () => {
        live = false;
      };
    }, [load]),
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);
  const refreshControl = useRefreshControl(refresh, refreshing);

  const desktops: DesktopSchedules[] = apis.map(({ session, api }) => ({
    session,
    api,
    read: reads[session.deviceId]?.read ?? null,
    error: reads[session.deviceId]?.error ?? null,
  }));
  const withAgents = desktops.filter((desktop) => (desktop.read?.agents.length ?? 0) > 0);
  const count = withAgents.reduce((total, desktop) => total + (desktop.read?.agents.length ?? 0), 0);
  const oneDesktop = readable.length <= 1;
  const unanswered = desktops.filter((desktop) => desktop.error && !desktop.read);

  const act = (action: ScheduledAgentAction) => {
    const target = picked;
    setPicked(null);
    if (!target) return;
    void target.desktop.api.act(target.agent.id, action).then((result) => {
      toast.show(result.ok ? ACTION_DONE[action] : (result.message ?? "The desktop refused it."), result.ok ? "success" : "error");
      void load();
    });
  };

  return (
    <ScreenFrame
      backLabel="Back to settings"
      count={count}
      onBack={onBack}
      title="Scheduled"
      trailing={
        readable.some(canOperateSchedules) ? (
          <CircleButton icon={<PlusIcon size={iconSize.md} />} label="New scheduled agent" onPress={onNew} />
        ) : undefined
      }
    >
      <ScrollView contentContainerStyle={contentStyle} refreshControl={refreshControl}>
        {loading ? (
          <SkeletonRows label="Reading the desktops' scheduled agents" />
        ) : withAgents.length === 0 ? (
          <Card>
            <Text style={styles.notice}>
              No scheduled agents yet. A scheduled agent starts a chat with its prompt each time its schedule comes
              round, on the desktop, whether or not this phone is awake.
            </Text>
          </Card>
        ) : (
          withAgents.map((desktop) => (
            <View key={desktop.session.deviceId} style={styles.group}>
              {oneDesktop ? null : (
                <View style={styles.groupHead}>
                  <RemoteMachineGlyph size={iconSize.sm} />
                  <Text accessibilityRole="header" style={styles.groupName}>
                    {desktop.session.desktopName}
                  </Text>
                </View>
              )}
              <Card variant="list">
                {desktop.read!.agents.map((agent, index) => {
                  const pausedAll = desktop.read!.pausedAll !== null;
                  const next = agent.paused || pausedAll ? "Paused" : nextRunWords(agent.nextRunAt, now);
                  const operable = canOperateSchedules(desktop.session);
                  return (
                    <CardRow
                      accessibilityHint={operable ? "Run now, pause, resume or close it." : undefined}
                      accessibilityLabel={`${agent.title}, in ${agent.projectName}. ${scheduleStatusLine(agent, pausedAll)}.`}
                      first={index === 0}
                      key={agent.id}
                      meta={`${agent.projectName} · ${scheduleStatusLine(agent, pausedAll)}`}
                      onPress={operable ? () => setPicked({ desktop, agent }) : undefined}
                      title={agent.title}
                      trailing={next ?? undefined}
                    />
                  );
                })}
              </Card>
            </View>
          ))
        )}
        {unanswered.map((desktop) => (
          <Text key={desktop.session.deviceId} style={styles.footnote}>
            {desktop.session.desktopName}: {desktop.error}
          </Text>
        ))}
      </ScrollView>
      <BottomSheet onClose={() => setPicked(null)} title={picked?.agent.title ?? "Scheduled agent"} visible={picked !== null}>
        {picked ? (
          <View style={styles.sheet}>
            <SheetOption label="Run now" onPress={() => act("run")} sub="Starts its chat now, paused or not." />
            {picked.agent.paused ? (
              <SheetOption label="Resume schedule" onPress={() => act("resume")} sub="It runs again at its next time." />
            ) : (
              <SheetOption label="Pause schedule" onPress={() => act("pause")} sub="No runs at its times until resumed." />
            )}
            <SheetOption label="Close schedule" onPress={() => act("delete")} sub="Stops it for good. Its chats stay." />
          </View>
        ) : null}
      </BottomSheet>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    group: {
      gap: space.sm,
    },
    groupHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space["2xs"],
      paddingTop: space.sm,
    },
    groupName: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    footnote: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingTop: space.sm,
      textAlign: "center",
    },
    sheet: {
      gap: space.xs,
    },
  });
