import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  createConversation,
  findLaunchedThread,
  threadFromLaunch,
  type LaunchedConversation,
} from "../../api/conversationLaunch";
import { CONVERSATION_MAX_IMAGES, type ConversationThread } from "../../api/conversationWire";
import { createTailnetConversationsApi } from "../../api/tailnetConversations";
import {
  declaresCliRuntimeCatalog,
  declaresImageDownscale,
  declaresMessageFiles,
  declaresNewChatEffort,
  declaresNewChatWorktree,
  declaresPermissionModes,
  declaresScheduledAgents,
} from "../../api/tailnetTransport";
import type { WorkspaceCheckout } from "../../api/tailnetWorkspaces";
import type { MobileSession } from "../../api/types";
import { BottomSheet } from "../../components/BottomSheet";
import { BoltIcon, ChevronIcon, FolderGlyph, iconSize, WorktreeGlyph } from "../../components/glyphs";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SheetOption } from "../../components/SheetOption";
import { useSheetHandoff } from "../../components/useSheetHandoff";
import { useSessionData } from "../../navigation/SessionDataProvider";
import { canOperateSchedules, createScheduledAgentsApi } from "../../api/scheduledAgents";
import { useToast } from "../../components/Toast";
import { ScheduleSheet, ScheduleTag } from "../scheduled/ScheduleSheet";
import { localTimeZone } from "../scheduled/scheduleEditor";
import { DEFAULT_SCHEDULE_CRON, readPickedSchedule, type PickedSchedule } from "../scheduled/schedulePick";
import { defaultSendAt } from "../scheduled/sendTime";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { projectHueColor } from "../../theme/projectHue";
import { radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import { DesktopGlyph } from "./ChatMarkViews";
import { ChatComposer } from "./ChatComposer";
import { ComposerStrip, STRIP_ITEM_HEIGHT, type ComposerStripEntry } from "./ComposerStrip";
import { STRIP_DROP_ORDER } from "./composerStripLogic";
import { useChats } from "./ChatsContext";
import {
  chatImageMaxBytes,
  composerOptions,
  PHONE_START_AS,
  type AttachSource,
  type PickedImage,
} from "./composerOptions";
import { chatLaunchAvailability, chatOpenedKey } from "./conversationListLogic";
import { pickChatImage } from "./pickChatImage";
import { pickChatFile } from "./pickChatFile";
import { rememberSentFile } from "./chatFiles";
import { launchWithPhotos, type ChatOpening, type PhotoLaunchProgress } from "./photoLaunch";
import { newChatWorktreeOffered, offeredPermissionPresets, type CliRuntime, type PermissionPreset } from "./launchLogic";
import { ModelPickerSheet } from "./ModelPickerSheet";
import { rememberSentPhoto } from "./sentPhotos";
import {
  DESKTOP_DEFAULT_LABEL,
  effortLabel,
  keptEffort,
  newChatProviders,
  pickedWindowLabel,
  pickerLabel,
  type PickerSelection,
} from "./modelPickerLogic";
import { dictatedDraft, dictationPlaceholder, joinDictation, messageWithDictation } from "../dictation/dictationLogic";
import { useDictation } from "../dictation/useDictation";

/**
 * How long the list may take to answer after a launch before the chat opens
 * on what the tool said. The listed thread carries the model catalog and the
 * capabilities; the screen reads them again on its own, so waiting longer
 * would only hold a person on a spinner for a nicer first frame.
 */
const LISTED_THREAD_WAIT_MS = 4_000;

// The access tag, drawn under the touch floor and padded out to it with
// `touchSlop`.
const TAG_BUTTON_HEIGHT = 32;

/**
 * Step two of New: the desktop's New chat composer, on a phone. The box is `ChatComposer`, the one the chat itself wears, and
 * it stands on the conversation's ground, so starting a chat does not change
 * the ground under it.
 *
 * One box, rounder than a card, holding the prompt and, on the same ground
 * with no rule between them, its controls: the "+", a tag for each choice
 * that is not the default, the model, the microphone and a small round send
 * in the accent. Every control but the send is ghost.
 *
 * Tucked under the box, one piece with it, the context strip says where the
 * chat runs: the machine in its mark (opening "Run on" where more than one
 * desktop is paired), the project in its hue, the Worktree switch where the
 * desktop can cut one (on at the door, as the desktop's New chat opens), and
 * the branch: "from main" while the chat is to have a worktree of its own,
 * else the branch the folder is on, with the worktree's mark when it is one.
 * One line always (`ComposerStrip`).
 *
 * The model is the desktop's picker (`ModelPickerSheet`): its CLIs as a rail,
 * a row per model, the context window on a model that has more than one, the
 * effort ramp where the CLI declares levels and the desktop takes one, and
 * the access. Each is sent only where the desktop advertises it.
 *
 * The "+" holds pictures, and Schedule where this pairing may operate the
 * desktop, as the desktop's "+" holds it: a switch that makes New a scheduled
 * agent. The schedule is then a tag beside the "+" (tap it for the picker,
 * × to start a chat now instead), the send wears the schedule's clock, and
 * sending makes the schedule on the desktop with `schedule.create`: the
 * words, the machine and project, the agent and model, the access and the
 * Worktree switch, all as picked here. Each run is a new chat started with
 * those words; the effort is the CLI's own, which a schedule does not carry.
 * "Start as" has one answer on the phone, which starts conversations only, so
 * it is not drawn; plan mode and a goal are not offered because the protocol
 * does not carry them. A picture cannot be
 * uploaded before the chat's session exists, so a launch that carries any
 * starts the chat bare and hands its words and pictures to the chat, which
 * sends them as its first message once it is live.
 *
 * A desktop that cannot take a chat says so in one line above the box, and
 * send stays off. One too old for `conversation.create` says the same when it
 * answers, prompt kept. Everything else defaults to the desktop's own
 * settings and is sent only when the person actually picked something:
 * presets are per-CLI, so forcing one at a CLI we did not pick is a refusal
 * with no visible cause.
 */
export function NewChatScreen({
  deviceId,
  desktopName,
  workspaceId,
  projectName,
  initialSheet,
  initialScheduled = false,
  onCancel,
  onStarted,
  onScheduled,
}: {
  deviceId: string;
  desktopName: string;
  workspaceId: string;
  projectName: string;
  /** Opens with the model sheet up, for a link that asks for it. */
  initialSheet?: "model";
  onCancel: () => void;
  onStarted: (deviceId: string, thread: ConversationThread, opening?: ChatOpening) => void;
  /** Opens as a scheduled agent, on the desktop's default repeat: New from the Scheduled list. */
  initialScheduled?: boolean;
  /** A schedule was made. Absent, the "+" offers no Schedule. */
  onScheduled?: () => void;
}) {
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { sessions } = useSessionData();
  const { apiFor, desktops, markChatOpened } = useChats();

  // Where it runs. Starts as the project the person chose; "Run on" may move
  // it to the same project on another machine.
  const [target, setTarget] = useState({ deviceId, desktopName, workspaceId, projectName });
  const api = apiFor(target.deviceId);
  const session = sessions.find((candidate) => candidate.deviceId === target.deviceId) ?? null;
  const availability = chatLaunchAvailability(session, { machineName: target.desktopName });
  const scheduleOffered = !!onScheduled && !!session && canOperateSchedules(session);
  // A one-time run is `schedule.create`'s `once`, which an older desktop refuses.
  const onceOffered = !!session && declaresScheduledAgents(session);

  const [prompt, setPrompt] = useState("");
  // The prompt is a draft until Start, so dictation can fill it; the words are
  // read and fixed before anything runs.
  const dictation = useDictation((spoken) => setPrompt((draft) => joinDictation(draft, spoken)));
  // The prompt as it is now, for a start that waited on the microphone.
  const promptNow = useRef(prompt);
  promptNow.current = prompt;
  // A start waiting for the microphone to settle its last words.
  const [finishingDictation, setFinishingDictation] = useState(false);
  // The photos and files the first message carries, in the order added; a
  // file is drawn by its name, a photo by its thumbnail.
  const [images, setImages] = useState<(PickedImage & { file?: true })[]>([]);
  const [picking, setPicking] = useState(false);
  const [runtimes, setRuntimes] = useState<CliRuntime[]>([]);
  // The CLI and model; no CLI is the desktop's own last-used one.
  const [selection, setSelection] = useState<PickerSelection>({ cli: null, model: null });
  // The effort picked on the CLI; null is Auto, the CLI's own default.
  const [effort, setEffort] = useState<string | null>(null);
  // Worktree starts on, as the desktop's New chat door opens with it pressed.
  // It is sent only where it is offered (`worktreeOffered`).
  const [worktreeOn, setWorktreeOn] = useState(true);
  const [preset, setPreset] = useState<PermissionPreset | null>(null);
  const [sheet, setSheet] = useState<"model" | "access" | "machine" | "schedule" | null>(initialSheet ?? null);
  // The schedule while New is a scheduled agent; null while it starts a chat.
  // Written in this phone's zone, which is the person's.
  const [timezone] = useState(localTimeZone);
  const [scheduled, setScheduled] = useState<PickedSchedule | null>(() =>
    initialScheduled ? { cron: DEFAULT_SCHEDULE_CRON, once: null } : null,
  );
  const toast = useToast();
  useEffect(() => {
    if (initialSheet) setSheet(initialSheet);
  }, [initialSheet]);
  // The access sheet is reached from the model sheet's Access row and from its
  // tag; closing it goes back to wherever it came from.
  const [accessReturn, setAccessReturn] = useState<"model" | null>(null);
  // One sheet opens from another only once that one has gone.
  const sheetHandoff = useSheetHandoff();
  const closeAccess = () => {
    setSheet(null);
    if (accessReturn) sheetHandoff.after(() => setSheet(accessReturn));
  };
  const [machineState, setMachineState] = useState<{ status: "idle" } | { status: "finding" } | { status: "error"; message: string }>({
    status: "idle",
  });
  const [state, setState] = useState<
    { status: "editing" } | { status: "pending" } | { status: "error"; message: string; code?: string }
  >({
    status: "editing",
  });
  // The project's hue, folder and checkout, for the strip and the Worktree
  // switch. Niceties: the strip names the project without them, New never
  // waits on them, and a checkout not yet read leaves Worktree offered.
  const [place, setPlace] = useState<{
    hue: number | null;
    folderPath: string | null;
    checkout: WorkspaceCheckout | null;
    /** Whether the folder is a git repository; null until the checkout read says. */
    git: boolean | null;
  }>({
    hue: null,
    folderPath: null,
    checkout: null,
    git: null,
  });
  // Set from the first tap until the launch settles: two taps inside one
  // frame both read the same `state`, and each would start a chat.
  const launching = useRef(false);
  // How far a launch with pictures got, so a retry after a failed upload uses
  // the chat that was started rather than starting another.
  const photoLaunch = useRef<PhotoLaunchProgress | null>(null);

  // The model list is the desktop's, never ours: `cli` and `cliModel` are blind
  // strings to the gateway, so a list kept here would be wrong the day the
  // desktop gained a model. A failure is silent — the chip simply offers no
  // models and the desktop's own default is used.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.listCliRuntimes().then((result) => {
      if (cancelled || !result.ok) return;
      setRuntimes(result.data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setPlace({ hue: null, folderPath: null, checkout: null, git: null });
    void (async () => {
      const listed = await api.listWorkspaces().catch(() => null);
      const workspace = listed?.ok ? (listed.data ?? []).find((entry) => entry.workspaceId === target.workspaceId) : undefined;
      if (cancelled) return;
      setPlace((current) => ({ ...current, hue: workspace?.projectHue ?? null, folderPath: workspace?.folderPath ?? null }));
      const checkout = await api
        .readCheckout({ workspaceId: target.workspaceId, folderPath: workspace?.folderPath ?? null })
        .catch(() => null);
      if (cancelled || !checkout?.ok) return;
      // An answer with no checkout is a folder that is no repository.
      setPlace((current) => ({ ...current, checkout: checkout.data ?? null, git: checkout.data != null }));
    })();
    return () => {
      cancelled = true;
    };
  }, [api, target.workspaceId]);

  // The picker's rail, as the desktop's own: its catalog where it lists one,
  // and effort levels only where it takes an effort.
  const catalogListed = session ? declaresCliRuntimeCatalog(session) : false;
  const effortTaken = session ? declaresNewChatEffort(session) : false;
  const providers = useMemo(
    () => newChatProviders(runtimes, { catalog: catalogListed, effort: effortTaken }),
    [runtimes, catalogListed, effortTaken],
  );
  const provider = providers.find((entry) => entry.cli === selection.cli) ?? null;
  // A level is the CLI's: one picked on another CLI is not sent.
  const pickedEffort = keptEffort(provider?.levels ?? [], effort);
  const worktreeOffered = newChatWorktreeOffered({
    advertised: session ? declaresNewChatWorktree(session) : false,
    folderPath: place.folderPath,
    git: place.git,
  });
  // The presets this machine runs, cut to the chosen CLI's own list where the
  // desktop gives one. With no CLI chosen the desktop's default CLI is not
  // known here, so every preset the machine runs is offered.
  const presetOptions = offeredPermissionPresets({
    fourPresets: session ? declaresPermissionModes(session) : false,
    listed: selection.cli ? runtimes.find((runtime) => runtime.id === selection.cli)?.permissionPresets : undefined,
    cli: selection.cli ?? undefined,
  });
  const presetMeta = presetOptions.find((entry) => entry.id === preset) ?? null;
  // A preset the chosen CLI (or another machine) does not run is dropped
  // rather than sent: the desktop would refuse it, or quietly run another.
  useEffect(() => {
    if (preset && !presetMeta) setPreset(null);
  }, [preset, presetMeta]);
  const hasWords = dictatedDraft(prompt, dictation.interim).trim().length > 0;
  const hasContent = hasWords || images.length > 0;
  // A schedule's runs start from its words alone, at a time still to come.
  const scheduleReads = scheduled ? readPickedSchedule(scheduled, timezone, Date.now()).ok : true;
  const canSend =
    availability.available &&
    (scheduled ? hasWords && images.length === 0 && scheduleReads : hasContent) &&
    state.status !== "pending" &&
    !picking;
  // The trigger names the model (the CLI's mark beside it names the CLI),
  // then the effort where one is picked.
  const modelText = pickerLabel(providers, selection, DESKTOP_DEFAULT_LABEL);
  const modelLabel = pickedEffort && provider ? `${modelText} · ${effortLabel(provider.levels, pickedEffort)}` : modelText;
  const windowLabel = pickedWindowLabel(providers, selection);
  const machines = desktops.filter((desktop) => desktop.canStart);
  const desktop = desktops.find((entry) => entry.deviceId === target.deviceId) ?? {
    deviceId: target.deviceId,
    name: target.desktopName,
    machineMark: null,
  };
  const projectInk = projectHueColor(place.hue, isDark ? "dark" : "light") ?? colors.textSubtle;
  const optionRows = composerOptions({
    startAs: { offered: PHONE_START_AS, selected: "conversation" },
    attach: {
      held: images.length,
      max: CONVERSATION_MAX_IMAGES,
      busy: picking,
      files: !!session && declaresMessageFiles(session),
    },
    schedule: scheduleOffered ? { on: scheduled !== null, busy: picking, repeats: true } : null,
  });

  // The "+"'s Schedule: on, it opens on a one-time run at the next whole hour
  // where the desktop takes one (as the desktop's does), else on its default
  // repeat, with the picker up; off, New starts a chat again.
  const toggleSchedule = () => {
    if (scheduled) {
      setScheduled(null);
      return;
    }
    setScheduled({ cron: DEFAULT_SCHEDULE_CRON, once: onceOffered ? defaultSendAt(Date.now()) : null });
    setSheet("schedule");
    if (state.status === "error") setState({ status: "editing" });
  };

  // Another machine may not take a one-time run, or let this phone schedule at all.
  useEffect(() => {
    if (!scheduled) return;
    if (!scheduleOffered) setScheduled(null);
    else if (scheduled.once !== null && !onceOffered) setScheduled({ cron: scheduled.cron, once: null });
  }, [scheduled, scheduleOffered, onceOffered]);

  const scheduleRun = async (paired: MobileSession, draft: string, picked: PickedSchedule, options: { worktree: boolean }) => {
    if (picked.once !== null && picked.once <= Date.now()) {
      setState({ status: "error", message: "That time has passed. Pick one ahead." });
      return;
    }
    const api = createScheduledAgentsApi({ baseUrl: paired.baseUrl, deviceToken: paired.deviceToken });
    const result = await api.create({
      workspaceId: target.workspaceId,
      prompt: draft,
      cron: picked.cron,
      once: picked.once,
      timezone,
      cli: selection.cli,
      model: selection.cli ? selection.model : null,
      worktree: options.worktree,
      permissionPreset: preset,
    });
    if (!result.ok) {
      // Nothing was scheduled, so the words stay where they are.
      setState({ status: "error", message: result.message ?? `${target.desktopName} did not schedule it.` });
      return;
    }
    setState({ status: "editing" });
    toast.show(`Scheduled on ${target.desktopName} · ${result.data?.scheduleWords ?? "on its schedule"}`, "success");
    onScheduled?.();
  };

  const startChat = async (paired: MobileSession, draft: string, options: { worktree: boolean }) => {
    const text = draft.trim();
    const carrying = images;
    const launchTarget = { baseUrl: paired.baseUrl, deviceToken: paired.deviceToken, machineName: target.desktopName };
    const launchInput = {
      workspaceId: target.workspaceId,
      newChat: true,
      cli: selection.cli ?? undefined,
      cliModel: selection.cli ? (selection.model ?? undefined) : undefined,
      effort: pickedEffort ?? undefined,
      worktree: options.worktree,
      permissionPreset: preset ?? undefined,
    };
    let conversation: LaunchedConversation;
    let opening: { text: string; uploads: { id: string; name: string }[] } | null = null;
    // A chat a try with pictures already started here is used again even if
    // the person has since taken every picture out: a second launch would
    // leave the first chat empty beside it.
    const resuming =
      photoLaunch.current?.conversation &&
      photoLaunch.current.target.deviceId === target.deviceId &&
      photoLaunch.current.target.workspaceId === target.workspaceId;
    if (carrying.length || resuming) {
      // With pictures the chat starts bare, the pictures go to its session
      // from here, and the chat sends them with these words once it is live.
      // Anything that fails leaves the words and every picture in New.
      const conversations = createTailnetConversationsApi({ baseUrl: paired.baseUrl, deviceToken: paired.deviceToken });
      const launched = await launchWithPhotos(
        {
          target: { deviceId: target.deviceId, workspaceId: target.workspaceId, machineName: target.desktopName },
          images: carrying,
          progress: photoLaunch.current,
        },
        {
          create: () => createConversation(launchTarget, launchInput),
          upload: async (sessionId, image) => {
            const upload = { sessionId, uri: image.uri, name: image.name, mediaType: image.mediaType };
            if (image.file) {
              const id = await conversations.uploadFile(upload);
              // The chat's first message draws it as a file by this name.
              rememberSentFile(id, image.name);
              return id;
            }
            const id = await conversations.uploadImage(upload);
            // The photo is on this phone: the chat's first message shows it from here.
            rememberSentPhoto(id, image.uri);
            return id;
          },
        },
      );
      photoLaunch.current = launched.progress;
      if (!launched.ok) {
        setState({ status: "error", message: launched.message, ...(launched.code ? { code: launched.code } : {}) });
        return;
      }
      conversation = launched.conversation;
      opening = { text, uploads: launched.uploads };
    } else {
      const result = await createConversation(launchTarget, { ...launchInput, prompt: text });
      if (!result.ok) {
        // Nothing was started, so the prompt stays where it is.
        setState({
          status: "error",
          message: [result.title, result.message].filter(Boolean).join(" "),
          ...(result.code ? { code: result.code } : {}),
        });
        return;
      }
      conversation = result.conversation;
    }
    photoLaunch.current = null;
    const thread =
      (await listedThread(paired, conversation)) ??
      threadFromLaunch(conversation, { now: Date.now(), permissionPreset: preset ?? undefined });
    // Opened as it starts, so the list does not greet the person's own new
    // chat as something that finished while they were away.
    markChatOpened(chatOpenedKey(target.deviceId, thread.agentId));
    setState({ status: "editing" });
    onStarted(target.deviceId, thread, opening ?? undefined);
  };

  // `worktree: false` is "Start without a worktree", after the desktop could
  // not make one.
  const start = async (overrides: { worktree?: boolean } = {}) => {
    if (!canSend || !session || launching.current) return;
    launching.current = true;
    setState({ status: "pending" });
    try {
      // Started while the microphone listens: the microphone stops, the start
      // waits for the words it was still hearing to settle, and they go in
      // the prompt rather than reaching the box after it.
      let draft = prompt;
      if (dictation.state !== "idle") {
        setFinishingDictation(true);
        const spoken = await dictation.finishForSend();
        setFinishingDictation(false);
        // Left while it waited: nothing starts.
        if (spoken === null) return;
        draft = messageWithDictation(promptNow.current, spoken);
        setPrompt(draft);
        if (!draft.trim() && !images.length) {
          setState({ status: "editing" });
          return;
        }
      }
      const worktreeChosen = overrides.worktree ?? (worktreeOffered && worktreeOn);
      if (scheduled) await scheduleRun(session, draft, scheduled, { worktree: worktreeChosen });
      else await startChat(session, draft, { worktree: worktreeChosen });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "The chat did not start." });
    } finally {
      launching.current = false;
    }
  };

  const attach = async (source: AttachSource) => {
    setSheet(null);
    if (picking || images.length >= CONVERSATION_MAX_IMAGES) return;
    setPicking(true);
    try {
      const image =
        source === "file"
          ? await pickChatFile().then((file) => (file ? { ...file, file: true as const } : null))
          : await pickChatImage(source === "camera", chatImageMaxBytes(!!session && declaresImageDownscale(session)));
      if (!image) return;
      setImages((current) => [...current, image].slice(0, CONVERSATION_MAX_IMAGES));
      if (state.status === "error") setState({ status: "editing" });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : source === "file" ? "The file could not be added." : "The picture could not be added.",
      });
    } finally {
      setPicking(false);
    }
  };

  const chooseMachine = async (next: { deviceId: string; name: string }) => {
    if (next.deviceId === target.deviceId) {
      setSheet(null);
      return;
    }
    setMachineState({ status: "finding" });
    // Same project, other machine: the workspace id is the desktop's own, so
    // the project's name is the only thing the two machines share. One in
    // the project's own folder over one in a worktree of it.
    const result = await apiFor(next.deviceId)?.listWorkspaces();
    const named = result?.ok ? (result.data ?? []).filter((workspace) => workspace.projectName === target.projectName) : [];
    const match = named.find((workspace) => !workspace.worktree) ?? named[0];
    if (!match) {
      setMachineState({
        status: "error",
        message: result?.ok
          ? `${target.projectName} is not open on ${next.name}. Open it in Studio there, or pick another machine.`
          : `${next.name} did not answer. Is Tailscale up on both devices?`,
      });
      return;
    }
    setTarget({ deviceId: next.deviceId, desktopName: next.name, workspaceId: match.workspaceId, projectName: match.projectName });
    // Models, efforts and presets are the other machine's to offer.
    setRuntimes([]);
    setSelection({ cli: null, model: null });
    setEffort(null);
    setMachineState({ status: "idle" });
    setSheet(null);
    if (state.status === "error") setState({ status: "editing" });
  };

  const branch = place.checkout?.branch ?? null;
  const worktree = place.checkout?.worktree ?? null;
  // With Worktree on, the branch is the one the new worktree is cut from:
  // the main checkout's, even where the project was asked about through one
  // of its worktrees.
  const cutting = worktreeOffered && worktreeOn;
  const fromBranch = cutting ? (place.checkout?.mainBranch ?? null) : null;
  const toggleWorktree = () => {
    setWorktreeOn((on) => !on);
    if (state.status === "error" && state.code === "worktree_unavailable") setState({ status: "editing" });
  };
  const pickMachine = () => {
    setMachineState({ status: "idle" });
    setSheet("machine");
  };
  // The context strip says where the chat runs: the machine in its mark
  // (opening "Run on" where more than one desktop is paired), the project in
  // its hue, Worktree where the desktop can cut one, and the branch: the one
  // the worktree is cut from while Worktree is on, else the folder's, with
  // the worktree's mark where the folder is one. One line, as the chat's
  // strip is: the branch shrinks from the front, then items leave for the "⋮".
  const stripEntries: ComposerStripEntry[] = [
    {
      id: "machine",
      drop: STRIP_DROP_ORDER.machine,
      overflowLabel: `Runs on ${target.desktopName}`,
      overflowIcon: <DesktopGlyph desktop={desktop} size={iconSize.sm} />,
      onOverflowPress: machines.length > 1 ? pickMachine : undefined,
      render: () =>
        machines.length > 1 ? (
          <Pressable
            accessibilityHint="Choose the machine it runs on."
            accessibilityLabel={`Runs on ${target.desktopName}`}
            accessibilityRole="button"
            hitSlop={touchSlop(STRIP_ITEM_HEIGHT)}
            onPress={pickMachine}
            style={({ pressed }) => [styles.stripItem, pressed ? styles.ghostPressed : null]}
          >
            <DesktopGlyph desktop={desktop} />
            <Text numberOfLines={1} style={styles.stripText}>
              {target.desktopName}
            </Text>
            <ChevronIcon direction="down" size={iconSize.xs - 2} tone="textSubtle" />
          </Pressable>
        ) : (
          <View accessible accessibilityLabel={`Runs on ${target.desktopName}`} style={styles.stripItem}>
            <DesktopGlyph desktop={desktop} />
            <Text numberOfLines={1} style={styles.stripText}>
              {target.desktopName}
            </Text>
          </View>
        ),
    },
    {
      id: "project",
      drop: STRIP_DROP_ORDER.diff,
      overflowLabel: `Project ${target.projectName}`,
      overflowIcon: <FolderGlyph ink={projectInk} size={iconSize.sm} />,
      render: () => (
        <View accessible accessibilityLabel={`Project ${target.projectName}`} style={styles.stripItem}>
          <FolderGlyph ink={projectInk} size={iconSize.xs} />
          <Text numberOfLines={1} style={styles.stripText}>
            {target.projectName}
          </Text>
        </View>
      ),
    },
    ...(worktreeOffered
      ? [
          {
            id: "worktree",
            drop: STRIP_DROP_ORDER.worktree,
            overflowLabel: worktreeOn ? "Worktree" : "No worktree",
            overflowIcon: <WorktreeGlyph size={iconSize.sm} tone="textMuted" />,
            onOverflowPress: toggleWorktree,
            // The desktop's switch, in its words: "Worktree" while the chat is
            // to run in one of its own, "No worktree" once turned off.
            render: () => (
              <Pressable
                accessibilityHint={
                  worktreeOn ? "Runs in a worktree of its own. Turn off to start in the project's folder." : "Run in a worktree of its own."
                }
                accessibilityLabel="Worktree"
                accessibilityRole="switch"
                accessibilityState={{ checked: worktreeOn }}
                hitSlop={touchSlop(STRIP_ITEM_HEIGHT)}
                onPress={toggleWorktree}
                style={({ pressed }) => [
                  styles.stripItem,
                  worktreeOn ? styles.stripItemOn : null,
                  pressed ? styles.ghostPressed : null,
                ]}
              >
                <WorktreeGlyph size={iconSize.xs} tone={worktreeOn ? "textPrimary" : "textSubtle"} />
                <Text numberOfLines={1} style={[styles.stripText, worktreeOn ? styles.stripTextOn : null]}>
                  {worktreeOn ? "Worktree" : "No worktree"}
                </Text>
              </Pressable>
            ),
          },
        ]
      : []),
    ...(cutting
      ? fromBranch
        ? [
            {
              id: "branch",
              drop: STRIP_DROP_ORDER.branch,
              branch: fromBranch,
              overflowLabel: `From ${fromBranch}`,
              render: (label: string) => (
                <View accessible accessibilityLabel={`A new worktree from ${fromBranch}`} style={styles.stripItem}>
                  <Text style={styles.stripText}>from</Text>
                  <Text ellipsizeMode="head" numberOfLines={1} style={[styles.stripText, styles.mono]}>
                    {label}
                  </Text>
                </View>
              ),
            },
          ]
        : []
      : branch
      ? [
          {
            id: "branch",
            drop: STRIP_DROP_ORDER.branch,
            branch,
            overflowLabel: worktree ? `Branch ${branch} · worktree ${worktree}` : `Branch ${branch}`,
            render: (label: string) => (
              <View
                accessible
                accessibilityLabel={worktree ? `Branch ${branch}, in worktree ${worktree}` : `Branch ${branch}`}
                style={styles.stripItem}
              >
                {worktree ? <WorktreeGlyph size={iconSize.xs} tone="textSubtle" /> : null}
                {/* Already cut to fit by the strip's layout; "head" only if a
                    measurement was a point out, so the end still shows. */}
                <Text ellipsizeMode="head" numberOfLines={1} style={[styles.stripText, styles.mono]}>
                  {label}
                </Text>
              </View>
            ),
          },
        ]
      : []),
  ];

  return (
    <View style={styles.root}>
      <ScreenHeader backLabel="Back to projects" ground="agent" onBack={onCancel} title="New" />

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.body}>
        <View style={styles.composerWrap}>
          {availability.available ? null : <Text style={styles.lede}>{availability.reason}</Text>}
          {state.status === "error" ? (
            <View style={styles.errorBlock}>
              <Text accessibilityRole="alert" style={styles.error}>
                {state.message}
              </Text>
              {/* Nothing was started; the desktop's reason says why the
                  folder cannot have a worktree, and this is the way on. */}
              {state.code === "worktree_unavailable" ? (
                <PrimaryButton
                  label="Start without a worktree"
                  onPress={() => {
                    setWorktreeOn(false);
                    void start({ worktree: false });
                  }}
                  variant="ghost"
                />
              ) : null}
            </View>
          ) : dictation.error ? (
            <Text
              accessibilityLiveRegion="polite"
              style={dictation.errorTone === "quiet" ? styles.lede : styles.error}
            >
              {dictation.error}
            </Text>
          ) : null}

          <ChatComposer
            action={{
              kind: "send",
              label: finishingDictation
                ? "Finishing dictation"
                : state.status === "pending"
                  ? scheduled
                    ? "Scheduling"
                    : "Starting the chat"
                  : scheduled
                    ? "Schedule"
                    : "Start chat",
              disabled: !canSend,
              onPress: () => void start(),
              schedule: scheduled !== null,
            }}
            attachments={images.map((image, index) => ({
              key: `${image.uri}-${index}`,
              name: image.name,
              ...(image.file ? { file: true } : { uri: image.uri }),
              onRemove: () => setImages((current) => current.filter((_, at) => at !== index)),
            }))}
            attachmentsLocked={state.status === "pending"}
            dictation={{ state: dictation.state, onToggle: dictation.toggle, disabled: state.status === "pending" }}
            fill
            input={{
              // Dictation types into the box as it hears, so there is no
              // second copy of the words above it; the box holds still while
              // the microphone does the typing.
              accessibilityLabel: `Describe a task in ${target.projectName}`,
              autoFocus: true,
              editable: state.status !== "pending" && dictation.state === "idle",
              onChangeText: (value) => {
                setPrompt(value);
                if (state.status === "error") setState({ status: "editing" });
              },
              placeholder: dictationPlaceholder(dictation.state, dictation.source) ?? `Describe a task in ${target.projectName}`,
              value: dictatedDraft(prompt, dictation.interim),
            }}
            options={{
              rows: optionRows,
              disabled: state.status === "pending" || picking,
              busy: picking,
              onAttach: (source) => void attach(source),
              onSchedule: toggleSchedule,
            }}
            picker={{
              cli: selection.cli ?? "claude-code",
              label: modelLabel,
              accessibilityLabel: [
                `Agent and model, ${provider && selection.model !== null ? `${provider.label} ${modelText}` : modelText}`,
                windowLabel ? `${windowLabel} context` : null,
                pickedEffort && provider ? `${effortLabel(provider.levels, pickedEffort)} effort` : null,
              ]
                .filter(Boolean)
                .join(", "),
              onPress: () => setSheet("model"),
            }}
            strip={<ComposerStrip entries={stripEntries} />}
            tags={
              // A tag for each choice that is not the default: the schedule,
              // and the access chosen in the model sheet. Tap one to change it.
              <>
              {scheduled ? (
                <ScheduleTag
                  onPress={() => setSheet("schedule")}
                  onRemove={() => setScheduled(null)}
                  schedule={scheduled}
                  timezone={timezone}
                />
              ) : null}
              {presetMeta ? (
                <Pressable
                  accessibilityLabel={`Access, ${presetMeta.label}`}
                  accessibilityRole="button"
                  hitSlop={touchSlop(TAG_BUTTON_HEIGHT)}
                  onPress={() => {
                    setAccessReturn(null);
                    setSheet("access");
                  }}
                  style={({ pressed }) => [styles.tagButton, pressed ? styles.ghostPressed : null]}
                >
                  <BoltIcon size={iconSize.xs} tone="textMuted" />
                  <Text numberOfLines={1} style={styles.tagText}>
                    {presetMeta.chip}
                  </Text>
                </Pressable>
              ) : null}
              </>
            }
          />
        </View>
      </KeyboardAvoidingView>


      <ModelPickerSheet
        access={{
          label: presetMeta?.label ?? "Desktop default",
          onPress: () => {
            setAccessReturn("model");
            setSheet(null);
            sheetHandoff.after(() => setSheet("access"));
          },
        }}
        effort={
          provider?.levels.length
            ? { levels: provider.levels, value: pickedEffort, defaultLevel: provider.defaultLevel, onChange: setEffort }
            : null
        }
        footer={
          <View style={styles.done}>
            <PrimaryButton label="Done" onPress={() => setSheet(null)} />
          </View>
        }
        leading={
          // The phone's one choice the desktop's picker has no row for: no
          // CLI at all, which leaves it to the desktop's last-used one.
          <SheetOption
            label={DESKTOP_DEFAULT_LABEL}
            onPress={() => {
              setSelection({ cli: null, model: null });
              setEffort(null);
            }}
            selected={selection.cli === null}
            sub="Whichever CLI and model this desktop last used"
          />
        }
        onClose={() => setSheet(null)}
        onDismiss={sheetHandoff.onDismiss}
        onSelect={(next) => {
          if (next.cli !== selection.cli) setEffort(null);
          setSelection(next);
        }}
        providers={providers}
        selection={selection}
        title="Agent and model"
        visible={sheet === "model"}
      />

      <BottomSheet onClose={closeAccess} onDismiss={sheetHandoff.onDismiss} title="Access" visible={sheet === "access"}>
        <SheetOption
          label="Desktop default"
          onPress={() => {
            setPreset(null);
            closeAccess();
          }}
          selected={preset === null}
          sub="The desktop's own setting for this CLI."
        />
        {presetOptions.map((entry) => (
          <SheetOption
            key={entry.id}
            label={entry.label}
            onPress={() => {
              setPreset(entry.id);
              closeAccess();
            }}
            selected={entry.id === preset}
            sub={entry.hint}
          />
        ))}
      </BottomSheet>

      {scheduled ? (
        <ScheduleSheet
          onChange={setScheduled}
          onClose={() => setSheet(null)}
          onceOffered={onceOffered}
          schedule={scheduled}
          timezone={timezone}
          visible={sheet === "schedule"}
        />
      ) : null}

      <BottomSheet onClose={() => setSheet(null)} title="Run on" visible={sheet === "machine"}>
        <Text style={styles.sheetLede}>The chat&apos;s agent runs on this machine.</Text>
        {machines.map((candidate) => {
          const paired = sessions.find((entry) => entry.deviceId === candidate.deviceId) ?? null;
          const offline = paired?.status === "offline" || paired?.status === "stale";
          return (
            <SheetOption
              icon={<DesktopGlyph desktop={candidate} size={iconSize.sm} />}
              key={candidate.deviceId}
              label={candidate.name}
              onPress={() => void chooseMachine({ deviceId: candidate.deviceId, name: candidate.name })}
              selected={candidate.deviceId === target.deviceId}
              sub={offline ? "Offline" : undefined}
            />
          );
        })}
        {machineState.status === "finding" ? (
          <Text style={styles.kvNote}>Looking for {target.projectName} there…</Text>
        ) : machineState.status === "error" ? (
          <Text accessibilityRole="alert" style={styles.sheetError}>
            {machineState.message}
          </Text>
        ) : null}
      </BottomSheet>
    </View>
  );
}

/**
 * The listed thread for a chat that has just started, or null when the list
 * is slow or failed. Never throws: the tool's own answer is enough to open on.
 */
async function listedThread(
  session: MobileSession,
  conversation: LaunchedConversation,
): Promise<ConversationThread | null> {
  const api = createTailnetConversationsApi({ baseUrl: session.baseUrl, deviceToken: session.deviceToken });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LISTED_THREAD_WAIT_MS);
  });
  try {
    return await Promise.race([
      api.list().then((threads) => findLaunchedThread(threads, conversation)),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.agentSurface,
    },
    body: {
      flex: 1,
    },
    composerWrap: {
      flex: 1,
      minHeight: 0,
      paddingHorizontal: space.xl,
      paddingTop: space.xl,
      paddingBottom: space.xl,
      gap: space.lg,
    },
    lede: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingHorizontal: space["2xs"],
    },
    // Tall from the start: the prompt is the only thing on this screen, so the
    // box takes the space rather than growing into it. No floor on its height:
    // a floor taller than what the keyboard leaves pushed the box past its
    // wrap, and the controls were drawn over the last lines. Above the strip,
    // which runs up under its lower edge.
    tagText: {
      ...typography.meta,
      color: colors.textDefault,
      flexShrink: 1,
    },
    // Ghost: no edge and no ground until pressed. The send is the one fill.
    ghostPressed: {
      backgroundColor: colors.bgHover,
    },
    tagButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      height: TAG_BUTTON_HEIGHT,
      paddingHorizontal: space.sm,
      borderRadius: radius.chip,
      flexShrink: 1,
      minWidth: 0,
    },
    stripItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      minHeight: STRIP_ITEM_HEIGHT,
      paddingHorizontal: space.sm,
      borderRadius: radius.control,
    },
    stripText: {
      ...typography.meta,
      color: colors.textMuted,
      flexShrink: 1,
    },
    // Worktree on: a pressed switch, raised on the strip's ground.
    stripItemOn: {
      backgroundColor: colors.bgActive,
    },
    stripTextOn: {
      color: colors.textPrimary,
    },
    mono: {
      fontFamily: monoFontFamily,
    },
    error: {
      ...typography.meta,
      color: colors.toneError,
      textAlign: "center",
    },
    errorBlock: {
      gap: space.xs,
      alignItems: "center",
    },
    sheetLede: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingHorizontal: space.xs,
      paddingBottom: space.sm,
    },
    sheetError: {
      ...typography.meta,
      color: colors.toneError,
      paddingHorizontal: space.xs,
      paddingTop: space.sm,
    },
    kvNote: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingHorizontal: space.xs,
      paddingTop: space["2xs"],
    },
    done: {
      paddingTop: space.xl,
    },
  });
