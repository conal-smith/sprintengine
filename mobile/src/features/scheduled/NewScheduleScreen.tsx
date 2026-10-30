import { useEffect, useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { useToast } from "../../components/Toast";
import { useTheme } from "../../theme/ThemeProvider";
import type { MobileSession } from "../../api/types";
import { createScheduledAgentsApi, oncePresets, SCHEDULE_PRESETS } from "../../api/scheduledAgents";
import { declaresScheduledAgents } from "../../api/tailnetTransport";
import type { CliRuntime } from "../conversations/launchLogic";
import { useChats } from "../conversations/ChatsContext";
import { OptionRow, useCreateFormStyles } from "../backlog/createFormShared";

/** The zone the schedule's times are read in: this phone's, which is the person's. */
function phoneTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** What New chat's Schedule carries over: the words and the choices made there. */
export interface ScheduleFromNewChat {
  prompt: string;
  /** The CLI picked in New chat; null left it to the desktop. */
  cli: string | null;
  model: string | null;
  worktree: boolean;
  permissionPreset: string | null;
}

/**
 * Step two of a new scheduled agent: what each run is asked, and when, in the
 * project chosen on step one. The desktop runs it: each time the schedule
 * comes round it starts a chat with this prompt, on its CLI's default model,
 * whether or not this phone is awake. The repeats offered are the common ones;
 * anything finer is the desktop's editor's. Where the desktop takes one, a
 * one-time run is offered too ("Once, in an hour"): a message to start a chat
 * with later.
 *
 * Reached from New chat's "+" as well, with `fromNewChat`: the prompt, the
 * agent, the model, the Worktree switch and the access picked there, and a
 * one-time run first where there is one, since that is what scheduling a
 * message usually means.
 */
export function NewScheduleScreen({
  session,
  workspaceId,
  projectName,
  desktopName,
  fromNewChat,
  onCancel,
  onScheduled,
}: {
  session: MobileSession | null;
  workspaceId: string;
  projectName: string;
  desktopName: string;
  fromNewChat?: ScheduleFromNewChat;
  onCancel: () => void;
  onScheduled: () => void;
}) {
  const { colors } = useTheme();
  const formStyles = useCreateFormStyles();
  const toast = useToast();
  const { apiFor } = useChats();
  const workspaces = session ? apiFor(session.deviceId) : null;
  const api = useMemo(
    () => (session ? createScheduledAgentsApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken }) : null),
    [session],
  );
  const onceOffered = !!session && declaresScheduledAgents(session);
  // Read when the screen opens; the instant itself is worked out on Schedule.
  const [onceOptions] = useState(() => (onceOffered ? oncePresets(new Date()) : []));
  const [prompt, setPrompt] = useState(fromNewChat?.prompt ?? "");
  const [presetId, setPresetId] = useState((fromNewChat ? onceOptions[0]?.id : undefined) ?? SCHEDULE_PRESETS[0]!.id);
  const [runtimes, setRuntimes] = useState<CliRuntime[]>([]);
  const [cli, setCli] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Two taps inside one frame both read the same `pending`.
  const sending = useRef(false);

  // The CLIs are the desktop's, never a list kept here; the first it can start
  // as a chat is picked until the person picks another.
  useEffect(() => {
    if (!workspaces) return;
    let cancelled = false;
    void workspaces.listCliRuntimes().then((result) => {
      if (cancelled || !result.ok) return;
      const chats = (result.data ?? []).filter((runtime) => runtime.catalog?.conversational !== false);
      setRuntimes(chats);
      // New chat's pick, where this desktop still offers it.
      const carried = fromNewChat?.cli && chats.some((runtime) => runtime.id === fromNewChat.cli) ? fromNewChat.cli : undefined;
      setCli((current) => current ?? carried ?? chats[0]?.id);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces, fromNewChat]);

  const preset = SCHEDULE_PRESETS.find((candidate) => candidate.id === presetId) ?? SCHEDULE_PRESETS[0]!;
  const oncePicked = onceOptions.find((candidate) => candidate.id === presetId) ?? null;
  const whenLabel = (id: string) =>
    onceOptions.find((candidate) => candidate.id === id)?.label ?? SCHEDULE_PRESETS.find((candidate) => candidate.id === id)?.label ?? id;

  const submit = () => {
    if (sending.current || !api) return;
    if (!prompt.trim()) {
      setError("Say what each run should do: it starts from this prompt alone.");
      return;
    }
    if (!cli) {
      setError(`${desktopName} has no agent CLI that starts a chat.`);
      return;
    }
    const once = oncePicked ? oncePicked.at(new Date()) : null;
    if (once && once.getTime() <= Date.now()) {
      setError("That time has already passed. Pick another.");
      return;
    }
    sending.current = true;
    setPending(true);
    setError(null);
    void api
      .create({
        workspaceId,
        prompt,
        cron: preset.cron,
        timezone: phoneTimeZone(),
        cli,
        // The model was picked for New chat's CLI; on another it is not sent.
        model: fromNewChat && cli === fromNewChat.cli ? fromNewChat.model : null,
        once,
        worktree: fromNewChat?.worktree ?? false,
        permissionPreset: fromNewChat?.permissionPreset ?? null,
      })
      .then((result) => {
        if (!result.ok) {
          setError(result.message ?? "The desktop did not schedule it.");
          return;
        }
        toast.show(`Scheduled on ${desktopName} · ${result.data?.scheduleWords ?? whenLabel(presetId)}`, "success");
        onScheduled();
      })
      .finally(() => {
        sending.current = false;
        setPending(false);
      });
  };

  return (
    <Screen
      backLabel={fromNewChat ? "Back" : "Cancel"}
      onBack={onCancel}
      subtitle={`${projectName} · ${desktopName}`}
      title={fromNewChat ? "Schedule" : "New scheduled agent"}
    >
      <View style={formStyles.panel}>
        <View style={formStyles.field}>
          <Text style={formStyles.fieldLabel}>Prompt</Text>
          <TextInput
            accessibilityLabel="What each run is asked"
            autoCapitalize="sentences"
            editable={!pending}
            multiline
            onChangeText={setPrompt}
            placeholder="What should each run do?"
            placeholderTextColor={colors.textSubtle}
            style={[formStyles.input, formStyles.multilineInput]}
            textAlignVertical="top"
            value={prompt}
          />
          <Text style={formStyles.fieldHint}>
            {oncePicked ? "It starts a new chat" : "Each run is a new chat"} in {projectName}
            {fromNewChat?.worktree ? ", in a worktree of its own" : ""}, started with this.
          </Text>
        </View>

        <OptionRow
          disabled={pending}
          format={whenLabel}
          label="When"
          onSelect={setPresetId}
          options={[...onceOptions.map((candidate) => candidate.id), ...SCHEDULE_PRESETS.map((candidate) => candidate.id)]}
          selected={presetId}
        />

        {runtimes.length > 1 ? (
          <OptionRow
            disabled={pending}
            format={(id) => runtimes.find((runtime) => runtime.id === id)?.displayName ?? id}
            label="Agent"
            onSelect={setCli}
            options={runtimes.map((runtime) => runtime.id)}
            selected={cli}
          />
        ) : null}

        {error ? (
          <View accessibilityRole="alert" style={[formStyles.message, formStyles.errorMessage]}>
            <Text style={formStyles.messageText}>{error}</Text>
          </View>
        ) : null}

        <PrimaryButton disabled={pending || !api} label={pending ? "Scheduling…" : "Schedule"} onPress={submit} />
        <PrimaryButton disabled={pending} label="Cancel" onPress={onCancel} variant="secondary" />
      </View>
    </Screen>
  );
}
