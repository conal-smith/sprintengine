import { useEffect, useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { useToast } from "../../components/Toast";
import { useTheme } from "../../theme/ThemeProvider";
import type { MobileSession } from "../../api/types";
import { createScheduledAgentsApi, SCHEDULE_PRESETS } from "../../api/scheduledAgents";
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

/**
 * Step two of a new scheduled agent: what each run is asked, and when, in the
 * project chosen on step one. The desktop runs it: each time the schedule
 * comes round it starts a chat with this prompt, on its CLI's default model,
 * whether or not this phone is awake. The repeats offered are the common ones;
 * anything finer is the desktop's editor's.
 */
export function NewScheduleScreen({
  session,
  workspaceId,
  projectName,
  desktopName,
  onCancel,
  onScheduled,
}: {
  session: MobileSession | null;
  workspaceId: string;
  projectName: string;
  desktopName: string;
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
  const [prompt, setPrompt] = useState("");
  const [presetId, setPresetId] = useState(SCHEDULE_PRESETS[0]!.id);
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
      setCli((current) => current ?? chats[0]?.id);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  const preset = SCHEDULE_PRESETS.find((candidate) => candidate.id === presetId) ?? SCHEDULE_PRESETS[0]!;

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
    sending.current = true;
    setPending(true);
    setError(null);
    void api
      .create({ workspaceId, prompt, cron: preset.cron, timezone: phoneTimeZone(), cli })
      .then((result) => {
        if (!result.ok) {
          setError(result.message ?? "The desktop did not schedule it.");
          return;
        }
        toast.show(`Scheduled on ${desktopName} · ${result.data?.scheduleWords ?? preset.label}`, "success");
        onScheduled();
      })
      .finally(() => {
        sending.current = false;
        setPending(false);
      });
  };

  return (
    <Screen backLabel="Cancel" onBack={onCancel} subtitle={`${projectName} · ${desktopName}`} title="New scheduled agent">
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
          <Text style={formStyles.fieldHint}>Each run is a new chat in {projectName}, started with this.</Text>
        </View>

        <OptionRow
          disabled={pending}
          format={(id) => SCHEDULE_PRESETS.find((candidate) => candidate.id === id)?.label ?? id}
          label="When"
          onSelect={setPresetId}
          options={SCHEDULE_PRESETS.map((candidate) => candidate.id)}
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
