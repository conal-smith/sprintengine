import { parseMachinePath } from '../../../../../shared/machine-paths'
import React from 'react'
import type { AgentCli, CliPermissionPreset, WorkspaceSkill } from '../../../../../shared/electron-api'
import type { MeshBrowse, MeshConnection, MeshNewChatWorktree } from '../../../../../shared/tailnet-mesh'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import { sameRepository, type RepositoryIdentity } from '../../../../../shared/repository-identity'
import { folderIdentityKey, useFolderRepositoryIdentities } from '../useFolderRepositoryIdentities'
import { ExtensionsGlyph, GitBranchGlyph } from '../../AppIcons'
import {
  distroOfHostId,
  hostIdToRecord,
  isWslHostId,
  LOCAL_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostSummary,
} from '../../../../../shared/execution-host'
import { distroOfUncPath, isWindowsPath, toWslPath } from '../../../../../shared/host-paths'
import type { AgentCliAvailabilityMap } from '../../../../../shared/electron-api'
import { useExecutionHosts } from '../../../hooks/useExecutionHosts'
import { useFileDropTarget } from '../../../hooks/useFileDropTarget'
import { useSshMachines } from '../../settings/SshMachinesSection'
import { FolderIdentityIcon } from '../FolderIdentityIcon'
import { useProjectColor } from '../../../hooks/useProjectColors'
import { projectColorKey } from '../../../utils/projectColor'
import { resolveSkillMentionPrefix } from '../../../../../shared/skill-invocation'
import { isProjectlessChatsRoot, PROJECTLESS_CHATS_LABEL } from '../../../../../shared/projectless-chats'
import { composerTokenAt } from '../../../../../shared/conversation/composerTrigger'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  dataTransferHasDroppableFiles,
  filesFromDataTransfer,
  pastedImagePaths,
  pathsForPathlessFiles,
  quotePromptPath as quotePath,
  readFileAsBase64,
  readPastedImagePaths,
  sortDroppedFiles,
  sortFiles,
  type DroppedFiles,
} from '../../../utils/imageFileTransfer'
import { workspaceRunsHere } from '../../../utils/attachedFiles'
import { ComposerAttachmentStrip } from '../../panels/ComposerAttachmentStrip'
import { ComposerDropOverlay } from '../../panels/agentChat/ComposerDropOverlay'
import { attachmentRejection, MAX_ATTACHMENTS_PER_TURN } from '../../panels/agentChat/imageAttachments'
import {
  ComposerField,
  isImeKey,
  type ComposerFieldHandle,
  type ComposerKeyEvent,
} from '../../panels/agentChat/ComposerField'
import { basename, pathJoin } from '../../../utils/paths'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import {
  CloseIconButton,
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_WITHIN_EDITOR_CLASS,
  HiddenFileInput,
  Input,
  EmptyState,
  GhostButton,
  InlineSkillPicker,
  LinkButton,
  SendButton,
  SendGlyph,
  StarGlyph,
  Tooltip,
  useCliPermissionMode,
  useCliPermissionPreset,
  type InlineSkillPickerHandle,
} from '../../ui'
import { AttachmentChip } from '../../ui/AttachmentChip'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import { CliInstallCta } from '../cliInstallRoute'
import { SpawnPermissionFooter } from './spawnFooter'
import { EnginePickerChip } from './enginePicker'
import { ProjectScopePicker } from './ProjectScopePicker'
import { remoteProjectOfWorkspace, remoteProjectsOf } from './remoteProjects'
import { type ProjectCloneRequest, type ProjectCloneResult } from './ProjectSourceMenu'
import { mergeDraftConnectors, readNewChatDraft, writeNewChatDraft, type NewChatDraftImage } from './newChatDraft'
import {
  bootComposerRect,
  bootComposerSeed,
  captureBootComposerSnapshot,
  claimBootComposer,
  dropBootComposerSnapshot,
} from './bootComposer'
import { showToast } from '../../../store/toastStore'
import { launchCommandLineKey, launchPreviewRequest, type LaunchCommandLineState } from './launchCommandLine'
import { drawSuggestions, newSuggestionSeed } from './suggestionBank'
import { WorktreeChip } from './WorktreeChip'
import { ScheduleFailureTray, ScheduleTag } from './schedule/SchedulePicker'
import { StartAsGlyph, startAsLabel, type StartAs } from './ComposerOptionsMenu'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { MachineScopePicker } from './MachineScopePicker'
import { ExtensionIdeaCard, SuggestionCard } from './NewChatCards'
import {
  browseOf,
  defaultNewChatHostId,
  hostRefusesFolder,
  lastSshFolders,
  machineAvailabilityOf,
  machineBrowseStale,
  machineCopyOf,
  rememberedMachine,
  sortMachines,
  type MachineBrowseEntry,
} from './newChatMachines'
import { RemoteProjectPicker, RemoteWorktreePicker, type RemoteTargetState } from './RemoteProjectPicker'
import { ComposerStrip } from './ComposerStrip'
import { FrontTruncatedText } from '../../ui/FrontTruncatedText'
import { ScheduledRuns } from './schedule/ScheduledRuns'
import type { ScheduledRunEntry } from '../../../utils/scheduledAgentRuns'
import { ExtensionFolderChip, ExtensionNameChip } from './ExtensionNameChip'
import { EXTENSION_IDEAS, EXTENSION_IDEAS_FIRST, type ExtensionIdea } from './extensionIdeas'
import {
  EXTENSION_BUILDER_SKILL_ID,
  extensionIdFromName,
  extensionIdProblem,
  type ExtensionScaffoldTargetState,
} from '../../../../../shared/extension-scaffold'
import { ScheduleSlashPicker, type ScheduleSlashPickerHandle } from './schedule/ScheduleSlashPicker'
import { localTimeZone } from './schedule/scheduleEditor'
import { defaultSendAt, sendTimeWords } from './schedule/sendTime'
import { rememberSchedule } from './schedule/recentSchedules'
import { selectModuleEnabled } from '../../../modules'
import {
  DEFAULT_SCHEDULED_AGENT_CRON,
  type ScheduledAgentDraft,
  type ScheduledAgentView,
} from '../../../../../shared/scheduled-agents'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationProviderForCli } from '../../../../../shared/conversation-harness'
import {
  rowMatchesSelection,
  useAgentComposer,
  type AgentComposerConfirm,
  type AgentComposerConnector,
  type AgentComposerSelection,
} from './useAgentComposer'
import { clientSupports } from '../../../clientCapabilities'
import { keydownMatchesKeybindings } from '../../../commands/commandDispatcher'
import { getEffectiveKeybindings, platformKeybindingsFromApiPlatform } from '../../../commands/effectiveKeybindings'
import { renderKeybinding } from '../../../commands/keybindings'

export type NewAgentLaunch = AgentComposerConfirm & {
  /** The agent's startup prompt. Empty means "start with nothing typed". */
  prompt: string
  /**
   * A chat's staged images, as the files on this computer that hold them: its
   * first message carries them as images. A terminal agent has none here — its
   * images are typed into `prompt` as paths.
   */
  images?: string[]
  /**
   * A chat's files attached by path, as their paths on this computer: its
   * first message carries them as its `files`. Only for a chat on this
   * computer; anywhere else they are typed into `prompt`.
   */
  files?: string[]
  /**
   * The machine on this computer the new chat runs on (the door's dropdown):
   * absent where the surface offers no choice (the tab strip's "+", which
   * spawns into a workspace whose machine is already fixed).
   */
  hostId?: ExecutionHostId
  /**
   * Extension mode: the extension's name, and the folder the person picked
   * for it. The host makes the extension from the SDK's template first — in
   * that folder, or a new `<extensions home>/<id>` without one — and the chat
   * starts there rather than in the project.
   */
  extension?: { id: string; folder?: string }
  /**
   * A chat on an SSH machine (phase 8): its label, and the folder on it the
   * chat runs in, as that machine spells it. A chat only: the machine's server
   * runs no terminals.
   */
  environment?: { kind: 'ssh'; id: string; label: string; folder: string }
  /**
   * Start it and stay on New chat (⌘⏎, `chat.new.launchInBackground`): the
   * host starts the chat ⏎ would start, out of sight, and leaves the door up;
   * the panel empties for the next one. Only sent where `launchesInBackground`.
   */
  stay?: true
}

/**
 * A chat on one side of the Windows ↔ WSL line in a folder on the other:
 * supported, never blocked (decisions R73 and R88), but every file its agents
 * touch crosses the line, which is much slower than either side's own disk.
 * One short line saying so, and which machine is fast, and nothing else.
 *
 *   - a WSL machine on a Windows drive: "On C: — slow from Ubuntu. Run on
 *     This PC for full speed." Shown only where the distribution's chats run
 *     on its Studio server (phase 7), so a machine whose switch is off sees
 *     New chat as it was;
 *   - This PC in a folder inside a distribution: "In Ubuntu — slow from
 *     Windows. Run on WSL: Ubuntu for full speed."
 */
export function slowFolderHint(
  hostId: ExecutionHostId,
  folder: string | null | undefined,
  chatServerOn: boolean,
): string | null {
  if (!folder) return null
  const distro = distroOfHostId(hostId)
  const drive = /^([A-Za-z]):[\\/]/u.exec(folder)
  if (distro && drive) {
    return chatServerOn ? `On ${drive[1].toUpperCase()}: — slow from ${distro}. Run on This PC for full speed.` : null
  }
  const folderDistro = hostId === LOCAL_HOST_ID ? distroOfUncPath(folder) : null
  if (folderDistro) return `In ${folderDistro} — slow from Windows. Run on WSL: ${folderDistro} for full speed.`
  return null
}

// The machine helpers moved to ./newChatMachines; these stay importable from
// the panel for the tests that reach them through it.
export {
  defaultNewChatHostId,
  hostRefusesFolder,
  resetRememberedMachineForTests,
  sortMachines,
} from './newChatMachines'

/** One choosable project scope: a folder some open workspace lives in. */
export type NewAgentProjectOption = {
  path: string
  label: string
  /** When a chat in it was last written to, so the picker can lead with the one used last. */
  lastUsedAt?: number
}

export type NewAgentPanelProps = {
  workspaceId: string
  /** Development gate for the chat agent runtime. */
  conversationModeEnabled?: boolean
  /** False where the workspace cannot host a chat agent (a module's workspace type). */
  conversationWorkspaceSupported?: boolean
  forceSelection?: AgentComposerSelection | null
  /**
   * Where this launch lands when it is NOT the active workspace's own folder —
   * the New chat door, which creates a solo workspace in a project you pick. The
   * scope line becomes the picker when `projectOptions` come with it.
   */
  folderPath?: string | null
  projectOptions?: NewAgentProjectOption[]
  onSelectProject?: (path: string) => void
  /**
   * Scope the door to "No project": the chat runs in a folder of its own
   * (shared/projectless-chats.ts). Absent, nothing offers it.
   */
  onStartWithoutProject?: () => void
  /** Browse for a folder; `hostId` is the machine the dropdown stands on, so a WSL one opens in its home. */
  onBrowseProject?: (hostId?: ExecutionHostId) => void
  initialSelection: AgentComposerSelection
  /** The app-wide default a model row nobody has set still resolves to; the
   *  picker's footer writes per-row, so this is a fallback, never what it edits. */
  permissionPreset: CliPermissionPreset
  /**
   * Host performs the spawn and retypes this tab into the agent's terminal.
   * For a `stay` launch it may answer whether anything started: `false` hands
   * the prompt back to the emptied box.
   */
  onLaunch: (launch: NewAgentLaunch) => void | Promise<boolean>
  /**
   * Door-only: ⌘⏎ starts the chat and keeps this surface up, emptied and
   * focused, with the project and engine as they were. The tab strip's host
   * has nowhere to stay: its tab becomes the agent's.
   */
  launchesInBackground?: boolean
  /** MCP servers picked before the panel opened (a connector's own "New chat"); still removable. */
  initialMcpServers?: AgentComposerConnector[] | null
  /** Cancel. Nothing was created, so there is nothing else to undo. */
  onClose: () => void
  /**
   * Draw a close control on the surface itself. The tab host does not need one
   * — its tab has an `×` — but the New chat door has no tab, and without this
   * the surface has no way out at all.
   */
  showCloseButton?: boolean
  /**
   * Door-only (remote-sessions-ux / new-chat-on-a-remote-machine): start a
   * chat agent on a paired machine instead of this one. Present = the panel
   * offers the machine dropdown (This device first, paired machines after —
   * one dropdown, no separate Local/Remote switch; owner ruling 2026-09-03) and
   * routes a remote launch here instead of `onLaunch`.
   */
  onLaunchRemote?: (launch: RemoteNewChatLaunch) => Promise<void>
  /**
   * Door-only: clone a repository for the project selector's Import-from-Git
   * source. The HOST runs the clone so a finish after the selector closed
   * still adopts the project; absent, the panel clones for itself.
   */
  onCloneProject?: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
  /**
   * Door-only (new-chat-survives-back-and-forward): the window's parked-draft
   * key. Present, the surface seeds its prompt, images, engine row, skills and
   * MCP picks from the draft parked under it and writes every change back, so
   * stepping off the door and back (Back/Forward, a sidebar click) loses
   * nothing. The HOST clears the draft when the chat starts or the panel is
   * closed on purpose; this surface only ever writes. The tab-strip host
   * passes none and keeps its per-tab state.
   */
  draftKey?: string
  /**
   * Door-only: open switched to Scheduled agent (the clock beside New chat).
   * The switch itself is offered wherever the door is and the Scheduled
   * agents module is on.
   */
  initialMode?: NewAgentPanelMode
  /**
   * Door-only: the scheduled agent this panel edits, opened from its row in
   * the sidebar's Scheduled section. The panel opens on its prompt, schedule, machine, engine, skills,
   * MCP servers and worktree, and its primary action saves rather than
   * creates. Absent, the panel creates.
   */
  editingScheduledAgent?: ScheduledAgentView | null
  /** Told once a scheduled agent was created or saved, with the record main returned. */
  onScheduled?: (agent: ScheduledAgentView) => void
  /** The edited scheduled agent's recent runs, newest first: the chats its runs started. */
  scheduledRuns?: readonly ScheduledRunEntry[]
  /** Open one of those runs' chats. */
  onOpenScheduledRun?: (workspaceId: string) => void
  /**
   * Door-only, in a window with no chats: the panel the window opens on next
   * launch. It takes over the static New chat box the window booted with
   * (public/boot-composer.js), and records itself, while untouched, as the box
   * the next launch draws.
   */
  bootComposer?: boolean
}

/**
 * What the door starts: a chat now, a scheduled agent that starts one each
 * time its schedule comes round, or an extension — a new project made inside
 * the chosen one, and a chat in it with the extension-builder skill.
 */
export type NewAgentPanelMode = 'chat' | 'scheduled' | 'extension'

/**
 * What a remote launch carries: the target, and the launch identity. It is
 * always a chat agent, which runs in that machine's conversation runtime and is
 * followed from here; terminals do not cross the tailnet.
 */
export type RemoteNewChatLaunch = {
  connectionId: string
  machineName: string
  remoteWorkspaceId: string
  remoteWorkspaceName: string
  /** The project's folder on that machine, as the gateway disclosed it. */
  remoteWorkspaceRoot: string | null
  prompt: string
  cli?: AgentCli
  cliModel?: string | null
  permissionPreset: CliPermissionPreset
  /**
   * The effort level picked, for a machine that keeps one (`new-chat-effort`).
   * Absent for one that does not: the panel offered no level there.
   */
  effort?: string
  /**
   * The branch the chat starts on over there, as the panel read it before the
   * create: the checkout's, or the picked worktree's. A new worktree's branch
   * is the machine's to name, and its answer replaces this one.
   */
  branch: string | null
  /**
   * Where in the project the chat runs, when not its own checkout: a worktree
   * cut for it there, or one the project already has. Absent, the checkout.
   */
  worktree?: MeshNewChatWorktree
  /** Which repository the remote workspace is, as its machine served it (one-project-across-machines). */
  remoteRepository: RepositoryIdentity | null
  /** That machine's skill ids, attached as the chat's chips and installed over there. */
  skills?: string[]
  /**
   * The images staged with the prompt, as their bytes: the files that hold
   * them here name nothing on that machine, so the bytes go up its upload
   * route and the first message names them there.
   */
  images?: ConversationImageAttachment[]
}

// A staged image as it crosses to a paired machine: the attachment alone,
// without the path of the file that holds it here.
function remoteImage({ id, mediaType, dataBase64, name, byteLength }: NewChatDraftImage): ConversationImageAttachment {
  return { id, mediaType, dataBase64, byteLength, ...(name ? { name } : {}) }
}

// A scheduled agent keeps its skills by id and name; the composer's chips
// want the skill as the inventory lists it, and the id and name are what they
// show and what the run attaches.
function scheduledSkill(skill: { id: string; name: string }): WorkspaceSkill {
  return { id: skill.id, name: skill.name, source: 'custom', harnesses: [], installState: 'installed' }
}

// The skill an extension's chat opens with, as its chip shows it. Removing the
// chip is how the door goes back to a plain New chat.
const NO_SCHEDULED_RUNS: readonly ScheduledRunEntry[] = []

/** ⌘⏎ in the prompt: start the chat and stay on New chat (see the registry). */
const LAUNCH_IN_BACKGROUND_COMMAND = 'chat.new.launchInBackground'

const EXTENSION_BUILDER_CHIP = scheduledSkill({ id: EXTENSION_BUILDER_SKILL_ID, name: 'extension-builder' })

// `/schedule` at the end of the prompt, and whatever follows it on that line.
const SCHEDULE_COMMAND = /(?:^|\s)\/schedule(?:[ \t]+([^\n]*))?$/u

/**
 * The launch surface: New chat, and the tab strip's "+".
 *
 * One composer, and nothing above it (owner ruling 2026-10-04): no mark, no
 * greeting, no switch between a chat and a scheduled agent. The box holds the
 * prompt and one row of quiet controls — the "+" that opens how the launch
 * starts and what it starts with, a tag beside it for each choice that is not
 * the default, the model, and a small round send. Tucked under the box, one
 * piece with it, is the context strip: the machine, the project, and the
 * worktree and branch, which say where the launch runs.
 *
 * Nothing here creates anything: `onLaunch` hands the host a confirm plus the
 * prompt, and the host retypes this tab into the agent's terminal.
 */
export default function NewAgentPanel({
  workspaceId,
  conversationModeEnabled = true,
  conversationWorkspaceSupported = true,
  forceSelection,
  folderPath,
  projectOptions,
  onSelectProject,
  onStartWithoutProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  onLaunch,
  launchesInBackground = false,
  initialMcpServers,
  onClose,
  showCloseButton = false,
  onLaunchRemote,
  onCloneProject,
  draftKey,
  initialMode = 'chat',
  editingScheduledAgent = null,
  onScheduled,
  scheduledRuns = NO_SCHEDULED_RUNS,
  onOpenScheduledRun,
  bootComposer = false,
}: NewAgentPanelProps) {
  // The parked draft, read once at mount: what the door held when the person
  // last stepped off it. An explicit connector attachment leads the draft's
  // own picks (a connector "New chat" over a parked draft adds, never doubles).
  const [draft] = React.useState(() => (draftKey ? readNewChatDraft(draftKey) : null))
  // A scheduled agent being edited opens on everything it was made with, and
  // stays a scheduled agent: there is no switching it to a chat.
  const editing = editingScheduledAgent
  const [mode, setMode] = React.useState<NewAgentPanelMode>(editing ? 'scheduled' : initialMode)
  const extensionMode = mode === 'extension'
  const [cron, setCron] = React.useState(() => editing?.schedule.cron ?? DEFAULT_SCHEDULED_AGENT_CRON)
  // A one-time schedule's moment, or null for the cron's repeats. Scheduling
  // from the "+" starts here, at the next whole hour: the prompt, sent later.
  const [once, setOnce] = React.useState<number | null>(() => editing?.schedule.once ?? null)
  // Written in this computer's zone: the scheduler runs here, on its clock.
  const [scheduleTimezone] = React.useState(() => editing?.schedule.timezone ?? localTimeZone())
  const scheduledAgentsEnabled = useWorkspaceStore((s) =>
    selectModuleEnabled(s.appSettings.modules, 'scheduled-agents'),
  )
  // The machines on THIS computer (this one, and the WSL distributions turned
  // on in Settings ▸ Machines). Offered only where a launch creates its
  // workspace — the door — because a workspace's machine is fixed once it
  // exists. One entry on macOS and Linux, which draws exactly what it drew.
  const hostChoosable = Boolean(onBrowseProject || onSelectProject)
  const { listing: hostListing } = useExecutionHosts()
  const localHosts: ExecutionHostSummary[] = hostChoosable ? (hostListing?.hosts ?? []) : []
  const [pickedHostId, setPickedHostId] = React.useState<ExecutionHostId | null>(() =>
    editing ? editing.hostId : rememberedMachine.hostId,
  )
  const scopeFolder = folderPath !== undefined ? folderPath : null
  // The machine chosen in this door, and the folder it was chosen for. It
  // wins over the folder's own default (a folder inside Ubuntu on This PC, a
  // `C:\` folder on WSL) until the folder changes; a scheduled agent being
  // edited opens on the machine it was saved with.
  const [chosenHost, setChosenHost] = React.useState<{ hostId: ExecutionHostId; folder: string | null } | null>(() =>
    editing?.hostId ? { hostId: editing.hostId, folder: folderPath ?? null } : null,
  )
  // A remembered pick counts only while that machine is still offered: one
  // turned off in Settings, or gone from WSL, falls back to this machine
  // rather than launching somewhere the dropdown no longer shows.
  const stillOffered = (id: ExecutionHostId | null): boolean =>
    id === LOCAL_HOST_ID || (id !== null && localHosts.some((host) => host.id === id && host.state !== 'unavailable'))
  const chosenForFolder =
    chosenHost && chosenHost.folder === scopeFolder && stillOffered(chosenHost.hostId) ? chosenHost.hostId : null
  const hostId: ExecutionHostId = hostChoosable
    ? defaultNewChatHostId(scopeFolder, stillOffered(pickedHostId) ? pickedHostId : null, chosenForFolder)
    : LOCAL_HOST_ID
  const pickLocalHost = (next: ExecutionHostId): void => {
    const remembered = next === LOCAL_HOST_ID ? null : next
    rememberedMachine.hostId = remembered
    setPickedHostId(remembered)
    setChosenHost({ hostId: next, folder: scopeFolder })
    pickSsh(null)
  }
  // SSH machines (phase 8): offered where a launch creates its workspace, as
  // the machines on this computer are. A chat there runs in a folder on that
  // machine, typed here; nothing on this computer is browsed for it.
  const { machines: sshMachinesAll } = useSshMachines(
    hostChoosable && window.api?.sshMachinesEnabled ? window.api : null,
  )
  const sshMachines = hostChoosable && !editing ? sshMachinesAll : []
  const [pickedSshId, setPickedSshId] = React.useState<string | null>(() => (editing ? null : rememberedMachine.sshId))
  const pickedSsh = sshMachines.find((machine) => machine.id === pickedSshId) ?? null
  const [sshFolder, setSshFolder] = React.useState(() => (pickedSshId ? (lastSshFolders.get(pickedSshId) ?? '') : ''))
  const pickSsh = (id: string | null): void => {
    rememberedMachine.sshId = id
    setPickedSshId(id)
    setSshFolder(id ? (lastSshFolders.get(id) ?? '') : '')
  }
  const sshFolderProblem =
    pickedSsh && !/^\/[^\0\n]*$/u.test(sshFolder.trim())
      ? `Type the folder's full path on ${pickedSsh.label}, such as /home/dev/repo.`
      : null
  // Which agent CLIs the chosen WSL machine has: its own probe, one process
  // for the lot, asked when the machine is picked — never on focus. This
  // machine's answer stays the store's, exactly as before.
  const hostSettings = useWorkspaceStore((s) => s.appSettings.hosts)
  const catalogIds = useWorkspaceStore((s) => s.pluginCatalogEntries.map((entry) => entry.id).join('\u0000'))
  const [hostAvailability, setHostAvailability] = React.useState<{
    hostId: ExecutionHostId
    map: AgentCliAvailabilityMap
    status: 'loading' | 'ready' | 'error'
  } | null>(null)
  React.useEffect(() => {
    if (!isWslHostId(hostId) || typeof window.api.pluginsDetectAvailability !== 'function') {
      setHostAvailability(null)
      return
    }
    let cancelled = false
    setHostAvailability({ hostId, map: {}, status: 'loading' })
    const commands = hostSettings?.[hostId]?.cliCommands ?? {}
    const cliRuntimes = Object.fromEntries(
      catalogIds
        .split('\u0000')
        .filter(Boolean)
        .map((cli) => [cli, { command: commands[cli] ?? '', hostId }]),
    )
    void window.api
      .pluginsDetectAvailability({ cliRuntimes })
      .then((result) => {
        if (cancelled) return
        setHostAvailability(
          result.ok ? { hostId, map: result.availability, status: 'ready' } : { hostId, map: {}, status: 'error' },
        )
      })
      .catch(() => {
        if (!cancelled) setHostAvailability({ hostId, map: {}, status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [hostId, hostSettings, catalogIds])
  const composer = useAgentComposer({
    ...(hostAvailability && hostAvailability.hostId === hostId
      ? { availability: { map: hostAvailability.map, status: hostAvailability.status } }
      : {}),
    showTerminal: true,
    conversationAvailable: conversationModeEnabled,
    // A scheduled agent's runs are chats: a terminal needs someone at it. An
    // extension is built in a chat too, with its skill attached.
    initialSelection:
      editing || initialMode === 'scheduled' || initialMode === 'extension'
        ? { kind: 'conversation' }
        : (forceSelection ?? draft?.selection ?? initialSelection),
    initialMcpServers: editing
      ? editing.mcpServers
      : draft
        ? mergeDraftConnectors(initialMcpServers, draft.mcpServers)
        : initialMcpServers,
    initialSkills: editing
      ? editing.skills.map(scheduledSkill)
      : initialMode === 'extension'
        ? [EXTENSION_BUILDER_CHIP]
        : draft?.skills,
    // A New chat starts in a worktree of its own unless the person turns the
    // chip off: a chat that edits the checkout everyone else is standing on
    // is the exception, not the rule. The door only (the one with a parked
    // draft); a scheduled agent or an extension opens with it off, and the
    // pane's "+" spawns beside a workspace that already has its folder.
    // A parked draft opens the chip as the person left it, name and all.
    initialWorktreeName: editing
      ? (editing.worktree?.name ?? null)
      : draftKey && initialMode !== 'scheduled' && initialMode !== 'extension'
        ? draft?.worktreeName !== undefined
          ? draft.worktreeName
          : ''
        : null,
    // The engine a parked draft was made on, when whoever made it stored none —
    // a card's `Go` picker, which must not move this door's remembered engine
    // on its way past (item 2473). The panel opens standing on that row and
    // launches it; the first row picked here retires it.
    initialEngine: editing ? { cli: editing.cli, model: editing.cliModel, reasoning: null } : (draft?.engine ?? null),
  })
  const { selection } = composer
  const setLastNewChatAgent = useWorkspaceStore((s) => s.setLastNewChatAgent)
  const isChatLaunch = selection.kind === 'conversation'

  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  // An explicit scope wins: skills, the worktree probe and the scope line all
  // have to describe the folder the agent will actually run in.
  const workspaceRoot = folderPath !== undefined ? folderPath : activeWorkspaceRoot
  const driveAdvisory = slowFolderHint(
    hostId,
    workspaceRoot,
    hostListing?.hosts.some((host) => host.id === hostId && host.chatServer?.on === true) ?? false,
  )
  // Picks were installed and synced into ONE project; a change of project
  // after picking would launch the agent somewhere they are not.
  const pickedForRoot = React.useRef(workspaceRoot)
  React.useEffect(() => {
    if (pickedForRoot.current === workspaceRoot) return
    pickedForRoot.current = workspaceRoot
    // The builder skill is not a pick: the scaffold puts it in the new
    // project, wherever that is, so it stays with the extension.
    composer.setSkills(extensionMode ? [EXTENSION_BUILDER_CHIP] : [])
    composer.setMcpServers([])
  }, [composer, extensionMode, workspaceRoot])
  // Removing the builder chip is leaving extension mode: the door is a plain
  // New chat again, with the project it was on.
  const builderAttached = composer.skills.some((skill) => skill.id === EXTENSION_BUILDER_SKILL_ID)
  React.useEffect(() => {
    if (extensionMode && !builderAttached) setMode('chat')
  }, [builderAttached, extensionMode])
  // The PROJECT, not the workspace: a solo-chat workspace is called things like
  // "new chat panel", which says nothing about where the agent will run. The
  // folder it opens in is the fact worth showing, so a wrong-project spawn is
  // visible before it happens.
  const projectless = isProjectlessChatsRoot(workspaceRoot)
  const projectLabel = React.useMemo(() => {
    const folder = workspaceRoot?.trim()
    if (!folder) return null
    if (isProjectlessChatsRoot(folder)) return PROJECTLESS_CHATS_LABEL
    return projectOptions?.find((option) => option.path === folder)?.label ?? basename(folder) ?? folder
  }, [projectOptions, workspaceRoot])
  // Can this surface change where the agent runs? True when the host gave us
  // any way to — a folder browser, or projects to switch between. Deliberately
  // NOT a function of whether a project is currently chosen: see the scope line
  // below for why that inversion is the bug this replaces.
  const canChooseProject =
    Boolean(onBrowseProject) || Boolean(onSelectProject && projectOptions && projectOptions.length > 0)
  // The machine dimension (remote-sessions-ux / new-chat-on-a-remote-machine).
  // One dropdown: This device is the default entry, paired machines follow. A
  // remote target swaps the project choice for the machine's own workspaces
  // (fetched over the audited mesh client) and routes the launch remotely.
  // What runs there is always a chat agent, in that machine's own conversation
  // runtime, followed from here: terminals do not cross the tailnet, so a
  // terminal agent or a bare terminal is this machine's only. Picking a machine
  // turns the launch into a chat; picking Agent or Terminal after that returns
  // it to This device rather than lying about where it would run.
  const [remoteMachines, setRemoteMachines] = React.useState<MeshConnection[]>([])
  const [remoteTarget, setRemoteTarget] = React.useState<RemoteTargetState | null>(null)
  // What each paired machine holds, read once per machine per door open
  // (one-project-across-machines): the machine dropdown says which machines
  // have the project in hand, and a pick that keeps the project reads its
  // workspace off this rather than asking the machine again.
  const [machineBrowses, setMachineBrowses] = React.useState<Map<string, MachineBrowseEntry>>(() => new Map())
  const browseMachine = React.useCallback((connection: MeshConnection): Promise<MeshBrowse> => {
    setMachineBrowses((current) => {
      const existing = current.get(connection.id)
      return existing && existing !== 'loading' ? current : new Map(current).set(connection.id, 'loading')
    })
    return window.api
      .meshBrowse(connection.id)
      .then((browse) => {
        setMachineBrowses((current) => new Map(current).set(connection.id, { browse, at: Date.now() }))
        return browse
      })
      .catch((error: unknown) => {
        const failed: MeshBrowse = {
          connectionId: connection.id,
          reachable: false,
          unreachableReason: error instanceof Error ? error.message : String(error),
          unauthorized: false,
          scopes: connection.scopes,
          workspaces: [],
          gaps: [],
        }
        setMachineBrowses((current) => new Map(current).set(connection.id, { browse: failed, at: Date.now() }))
        return failed
      })
  }, [])
  // The identity in hand, readable at the moment a browse RESOLVES rather
  // than when the pick was made: the remembered machine is picked as soon as
  // the machine list arrives, usually before the local folder's identity has
  // been read, and a `keep` captured then would be null.
  const activeIdentityRef = React.useRef<RepositoryIdentity | null>(null)
  // One launch at a time: the remote create waits on a real CLI starting on
  // another machine, and a second Enter during that window must read as
  // "starting", never as a second agent.
  const [remoteLaunching, setRemoteLaunching] = React.useState(false)
  const remoteCapable = Boolean(onLaunchRemote)
  // The remembered machine is applied once, when the list first arrives.
  const rememberedApplied = React.useRef(false)
  React.useEffect(() => {
    if (!remoteCapable) return
    let cancelled = false
    const load = (): void => {
      void window.api
        .meshListConnections()
        .then((connections) => {
          if (cancelled) return
          const sorted = sortMachines(connections)
          setRemoteMachines(sorted)
          if (!rememberedApplied.current) {
            rememberedApplied.current = true
            const remembered = rememberedMachine.machineId
              ? sorted.find((machine) => machine.id === rememberedMachine.machineId)
              : null
            if (remembered) pickRemoteMachineRef.current(remembered)
          }
        })
        .catch(() => {})
    }
    load()
    // A machine paired or forgotten while the door is open shows up live.
    const unsubscribe =
      typeof window.api.onMeshEvent === 'function'
        ? window.api.onMeshEvent((event) => {
            if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') load()
          })
        : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [remoteCapable])
  // Chat agent is offered only where the workspace can host one; without it
  // there is nothing a paired machine could run for this launch.
  const chatAvailable =
    conversationWorkspaceSupported && composer.visibleRows.some((row) => row.kind === 'conversation')
  const remoteSelectable = remoteCapable && chatAvailable && selection.kind !== 'terminal'
  // Scheduling is the door's, and needs a chat to start: a run happens with
  // nobody at it, which a terminal cannot do.
  const scheduleOffered = hostChoosable && scheduledAgentsEnabled && chatAvailable && !extensionMode
  const scheduled = mode === 'scheduled' && (scheduleOffered || editing !== null)
  // Both run as a chat: a scheduled agent's runs have nobody at them, and an
  // extension is built with its skill in a conversation.
  const chatOnly = scheduled || extensionMode
  React.useEffect(() => {
    if (chatOnly && composer.selection.kind !== 'conversation') composer.setSelection({ kind: 'conversation' })
  }, [composer, chatOnly])
  // An extension is made on this computer: the scaffold writes to its disk.
  const remoteChosenAway = !remoteSelectable || selection.kind !== 'conversation' || chatOnly
  React.useEffect(() => {
    if (remoteChosenAway) setRemoteTarget(null)
  }, [remoteChosenAway])
  // A scheduled agent runs on this computer, and an extension is scaffolded on
  // its disk, so the machine list drops the SSH machines for both; one picked
  // before must go with them, or the strip would keep asking for a folder on
  // that machine — and the press would start a plain chat there, with no
  // agent saved or extension made in the project here.
  const sshPickedWhileChatOnly = chatOnly && pickedSshId !== null
  React.useEffect(() => {
    if (sshPickedWhileChatOnly) pickSsh(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshPickedWhileChatOnly])
  // The project in hand, as an identity the next machine can be searched for:
  // the local folder's repository, or the remote project's as its machine
  // served it. Null when nothing is chosen or the folder has no remote.
  const localIdentities = useFolderRepositoryIdentities(
    React.useMemo(
      () => [workspaceRoot, ...(projectOptions ?? []).map((option) => option.path)],
      [projectOptions, workspaceRoot],
    ),
  )
  const localIdentity = workspaceRoot ? (localIdentities.get(folderIdentityKey(workspaceRoot)) ?? null) : null
  const activeIdentity: RepositoryIdentity | null = remoteTarget
    ? (remoteTarget.picked?.repository ?? null)
    : localIdentity
  activeIdentityRef.current = activeIdentity
  // The colour the scope line wears (owner ruling 2026-09-09, backlog item
  // `one-colour-per-project-on-the-folder-glyph`, decision 7). The owner's
  // words were "I keep opening up a new chat and forgetting to pick the
  // project", so the point of the hue here is not decoration: it is that a
  // chosen project and no project stop looking alike.
  //
  // The key is the project's, not the folder's or the machine's — decision 3, a
  // project is a repository. So the local scope resolves through the folder's
  // repository identity and a picked remote project through the one its machine
  // served, and the same repository on two machines therefore lands on ONE key
  // and one hue. The machine is a glyph on this line, never a second colour.
  //
  // A remote project with NO identity has no key at all, and deliberately does
  // not fall back to its path the way a local folder does. That path is a path
  // on ANOTHER machine's disk and says nothing about which repository it holds,
  // so a colour derived from it could disagree with this disk's clone of the
  // same repository — one project in two colours, the exact failure decision 3
  // exists to prevent. An older peer that does not report identities and a
  // folder that is not a repository both arrive here with `repository: null`,
  // and both get the plain glyph instead.
  const remotePicked = remoteTarget?.picked ?? null
  // A paired machine keeps a New chat's effort only where it said so
  // (`new-chat-effort`); elsewhere the picker offers no level, since one sent
  // to an older build would be skipped and the chat run at its own default.
  const remoteTakesEffort = remoteTarget?.capabilities?.includes('new-chat-effort') ?? false
  const effortOffered = !remoteTarget || remoteTakesEffort
  const scopeProjectKey = remoteTarget
    ? remotePicked?.repository
      ? projectColorKey({ folderPath: null, repository: remotePicked.repository })
      : null
    : projectColorKey({ folderPath: workspaceRoot, repository: localIdentity })
  // The hue waits for the folder's identity to be READ. A folder with a remote
  // keys as `repo:…` and one without as `folder:…`, and the hue is hashed from
  // the key, so painting while the read is in flight would show the folder's
  // hue and then the repository's. The identities hook says "not asked yet" by
  // absence and "asked, and no remote" by a stored null, so absence is
  // precisely the thing to wait on. Until then the glyph is plain, which is
  // what an unknown project should look like anyway.
  //
  // A remote target needs no such wait: its key is a repository key or nothing,
  // and both are settled the moment the machine answered.
  const localIdentityRead = !workspaceRoot?.trim() || localIdentities.has(folderIdentityKey(workspaceRoot))
  const scopeProjectColor = useProjectColor(remoteTarget || localIdentityRead ? scopeProjectKey : null)
  const pickRemoteMachine = (
    connection: MeshConnection | null,
    keep: RepositoryIdentity | null = activeIdentity,
  ): void => {
    rememberedMachine.machineId = connection?.id ?? null
    if (!connection) {
      // Back to This device with a project in hand: keep it when a local clone
      // of the same repository is open here (changing the machine keeps the
      // project when it exists there); otherwise the line returns
      // to the folder it was scoped to before, as it always did. The folder
      // the door is already scoped to wins when it is that repository.
      const scopedIsTwin = Boolean(
        keep && workspaceRoot && sameRepository(localIdentities.get(folderIdentityKey(workspaceRoot)), keep),
      )
      const twin =
        keep && !scopedIsTwin
          ? (projectOptions ?? []).find((option) =>
              sameRepository(localIdentities.get(folderIdentityKey(option.path)), keep),
            )
          : null
      if (twin && onSelectProject && twin.path !== workspaceRoot) onSelectProject(twin.path)
      setRemoteTarget(null)
      return
    }
    // A paired machine runs chat agents only, so choosing one is choosing a
    // chat — and where no chat can be hosted, there is nothing to choose.
    if (!chatAvailable) return
    if (composer.selection.kind !== 'conversation') composer.setSelection({ kind: 'conversation' })
    setRemoteTarget({
      connection,
      workspaces: null,
      projects: null,
      error: null,
      picked: null,
      checkout: null,
      capabilities: null,
    })
    void browseMachine(connection).then((browse) => {
      setRemoteTarget((current) => {
        if (current?.connection.id !== connection.id) return current
        if (!browse.reachable) {
          return {
            ...current,
            workspaces: [],
            projects: [],
            error: browse.unreachableReason ?? 'That machine is not answering.',
          }
        }
        if (browse.unauthorized) {
          return {
            ...current,
            workspaces: [],
            projects: [],
            error: 'That machine refused this pairing — re-pair from Settings → Remote.',
          }
        }
        // A gap is a DIFFERENT statement from an empty list: a pairing
        // without workspace:read genuinely cannot list workspaces, and
        // "no workspaces on that machine" would be false (the MeshGap
        // contract). Say the real reason instead.
        const workspaceGap = browse.gaps.find((gap) => gap.part === 'workspaces')
        if (browse.workspaces.length === 0 && workspaceGap) {
          return { ...current, workspaces: [], projects: [], error: workspaceGap.message }
        }
        // The machine's chats folded into the folders they stand in
        // (`remoteProjects`). What `workspace.list` serves is one entry per
        // open CONVERSATION over there, and this chip is choosing a project
        // — so three chats in one checkout are one row, not three.
        const projects = remoteProjectsOf(browse.workspaces)
        // An explicit choice, not the first row: a project picked by list
        // order is a launch into the wrong repo waiting to happen. Two
        // exceptions: a machine with exactly one project, where there is
        // nothing to choose, and the machine's copy of the project already
        // in hand (one-project-across-machines) — switching the machine
        // keeps the project.
        const copy = machineCopyOf(browse, keep ?? activeIdentityRef.current)
        const kept = copy ? remoteProjectOfWorkspace(projects, browse.workspaces, copy.id) : null
        return {
          ...current,
          capabilities: browse.capabilities ?? null,
          workspaces: browse.workspaces,
          projects,
          // A choice already made meanwhile is never overwritten by a late answer.
          picked: current.picked ?? kept ?? (projects.length === 1 ? projects[0]! : null),
        }
      })
    })
  }
  const pickRemoteMachineRef = React.useRef(pickRemoteMachine)
  pickRemoteMachineRef.current = pickRemoteMachine
  // The picked project's checkout facts (checkout-and-branch-on-remote-create),
  // read over `workspace.checkout` the moment a project is chosen — keyed on
  // the machine and the project, so a re-pick re-reads and a browse settling
  // does not. A refusal (a read-only pairing, a machine gone quiet) leaves the
  // branch unnamed rather than guessed.
  const remoteConnectionId = remoteTarget?.connection.id ?? null
  // `workspace.checkout` is keyed by workspace id, and a project's seat is one
  // of the chats standing in it — every chat in a folder answers for the folder.
  const remotePickedId = remoteTarget?.picked?.workspaceId ?? null
  React.useEffect(() => {
    if (!remoteConnectionId || !remotePickedId) return
    let cancelled = false
    void window.api
      .meshWorkspaceCheckout(remoteConnectionId, remotePickedId)
      .then((result) => {
        if (cancelled) return
        setRemoteTarget((current) => {
          if (current?.connection.id !== remoteConnectionId || current.picked?.workspaceId !== remotePickedId)
            return current
          return { ...current, checkout: result.ok ? result.checkout : null }
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [remoteConnectionId, remotePickedId])
  // A worktree the picked remote project already has, picked to start the
  // chat in. It belongs to the machine and project it was picked on, so
  // another pick reads as the project's own checkout again, and it counts
  // only while the checkout that machine served still lists it.
  const [remoteWorktreePick, setRemoteWorktreePick] = React.useState<{
    connectionId: string
    workspaceId: string
    path: string
  } | null>(null)
  const remoteExistingWorktree =
    remoteWorktreePick &&
    remoteWorktreePick.connectionId === remoteConnectionId &&
    remoteWorktreePick.workspaceId === remotePickedId
      ? (remoteTarget?.checkout?.worktrees.find(
          (worktree) => !worktree.isMain && worktree.path === remoteWorktreePick.path,
        ) ?? null)
      : null
  const activeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.branch ?? null) : null
  })
  // A branch belongs to the workspace's own checkout; a chat scoped to another
  // project is not on it, and printing it there would be a lie.
  const branch = folderPath !== undefined && folderPath !== activeWorkspaceRoot ? null : activeBranch
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)

  const [prompt, setPrompt] = React.useState(() => editing?.prompt ?? draft?.prompt ?? '')
  // Where the caret is, as the field last said, with the draft it said it of.
  // A draft set from here (a card, a pick) puts the field's caret at its end,
  // which is where a caret for a draft the field has not spoken of is taken to
  // be. A pick that wants it elsewhere asks through `pendingCaretRef`.
  const [promptCaretAt, setPromptCaretAt] = React.useState<{ value: string; caret: number } | null>(null)
  const promptCaret = promptCaretAt?.value === prompt ? promptCaretAt.caret : prompt.length
  const pendingCaretRef = React.useRef<number | null>(null)
  const [enginePopoverOpen, setEnginePopoverOpen] = React.useState(false)
  // The hidden file input the "+" menu's Attach files row clicks. The menu
  // and the skills picker it opens over the same "+" are `ComposerPlusMenu`.
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = React.useState(false)
  // Replacing the static box, the panel draws the cards the box was drawn
  // with: different cards under the same composer would be a visible swap.
  const [seed] = React.useState(() => (bootComposer ? bootComposerSeed() : null) ?? newSuggestionSeed())
  const promptRef = React.useRef<ComposerFieldHandle>(null)

  // ── Images pasted or dropped into the prompt box ──────────────────────────
  // Each image is held as a file on this computer. A chat's first message
  // carries it as an image, read from that file the way a later message's
  // pasted path is; a CLI agent's prompt is text retyped into its terminal, so
  // there the path joins the prompt, the same shape as a drop onto a running
  // terminal. A file dropped from the OS already has a path; a pasted
  // screenshot (or an image dragged out of a browser) exists only as bytes and
  // is saved to a temp file first. Either way the box shows the image, not the
  // path: the thumbnail is the attachment.
  const [attachNote, setAttachNote] = React.useState<string | null>(null)
  const [images, setImages] = React.useState<PromptImage[]>(() => draft?.images ?? [])
  // Files attached by path: cards in the box. A chat on this computer sends
  // them as its first message's `files`, beside the words; anywhere else they
  // are typed after the words as their paths when it starts (`typedFiles`).
  const [files, setFiles] = React.useState<string[]>(() => draft?.files ?? [])
  // Where a drop makes a card at all: a chat or agent starting on this
  // computer, in a window that reads a file's path. One starting on an SSH
  // machine, a paired machine or a WSL distribution — or from the tab strip
  // into a workspace that runs on one — reads no file off this disk by its
  // path, so there a file is typed as its path, as it always was, and main is
  // not told about it.
  const tabWorkspaceRunsHere = useWorkspaceStore((s) =>
    workspaceRunsHere(s.workspaces.find((w) => w.id === workspaceId)),
  )
  const filesAsCards =
    clientSupports('drag-paths') &&
    !pickedSsh &&
    !remoteTarget &&
    hostId === LOCAL_HOST_ID &&
    (hostChoosable || tabWorkspaceRunsHere)
  const [attachingCount, setAttachingCount] = React.useState(0)

  // Write-through to the parked draft: every change the person makes is safe
  // the moment it is made, so an unmount from any direction loses nothing.
  React.useEffect(() => {
    if (!draftKey) return
    writeNewChatDraft(draftKey, {
      prompt,
      images,
      files,
      selection,
      // Written back as it stands, which is null from the moment the person
      // picks an engine of their own: parking a retired one would reinstate it
      // on the next visit.
      engine: composer.openingEngine,
      skills: composer.skills,
      mcpServers: composer.mcpServers,
      worktreeName: composer.worktreeName,
    })
  }, [
    draftKey,
    prompt,
    images,
    files,
    selection,
    composer.openingEngine,
    composer.skills,
    composer.mcpServers,
    composer.worktreeName,
  ])

  const insertPromptPath = (dropped: string) => {
    // A file from the SSH machine this chat starts on is typed as that
    // machine spells it: the agent runs there, not on this computer.
    const onMachine = pickedSsh ? parseMachinePath(dropped) : null
    const path = onMachine && onMachine.id === pickedSsh?.id ? onMachine.path : dropped
    setPrompt((current) =>
      current.length === 0 || /\s$/.test(current) ? `${current}${quotePath(path)} ` : `${current} ${quotePath(path)} `,
    )
    promptRef.current?.focus()
  }

  // A drop, whatever it carries: a file from the system is a card where
  // `filesAsCards`, and typed as its path elsewhere; one from the studio's own
  // panes is typed as its path, the way a drop onto a terminal would be; images
  // attach; a file with no path is uploaded where the shell can (a browser) and
  // typed as the server's path, and is otherwise refused with a message rather
  // than swallowed — beside images that did attach as much as alone. Files
  // picked through "Attach files" and pasted files are taken the same way.
  const fileSorting = { attachImages: true, attachByPath: filesAsCards }
  const dropFiles = (data: DataTransfer) => takeFiles(sortDroppedFiles(data, fileSorting))
  const takeFiles = ({ paths, files: attached, images, pathless }: DroppedFiles) => {
    for (const path of paths) insertPromptPath(path)
    if (attached.length > 0) setFiles((current) => [...new Set([...current, ...attached])])
    if (images.length > 0) void attachDroppedFiles(images)
    else setAttachNote(null)
    // No path here: a browser uploads them and types the server's paths.
    if (pathless.length > 0)
      void pathsForPathlessFiles(pathless).then(({ paths: uploaded, message }) => {
        for (const path of uploaded) insertPromptPath(path)
        if (message) setAttachNote(message)
      })
    promptRef.current?.focus()
  }

  // A chat's first message carries at most so many images, as every later one
  // does: refused here, with the reason, rather than by the chat once it has
  // started. Counted against what is staged and what is still being read.
  const attachDroppedFiles = async (files: File[]) => {
    let refusal: string | null = null
    const readable: File[] = []
    for (const file of files) {
      const rejection = attachmentRejection(file, images.length + attachingCount + readable.length)
      if (rejection) refusal ??= rejection
      else readable.push(file)
    }
    setAttachNote(refusal)
    for (const file of readable) {
      const existingPath = window.api.getPathForFile(file)
      setAttachingCount((count) => count + 1)
      try {
        const { mediaType, dataBase64 } = await readFileAsBase64(file)
        const path = existingPath || (await window.api.saveDroppedImage({ mediaType, dataBase64 }))
        // The slice holds the cap under overlapping batches (a paste landing
        // while a drop is still reading); the check above already said why.
        setImages((current) =>
          [
            ...current,
            {
              id: `${Date.now()}-${current.length}-${file.name}`,
              mediaType,
              dataBase64,
              byteLength: file.size,
              ...(file.name ? { name: file.name } : {}),
              path,
            },
          ].slice(0, MAX_ATTACHMENTS_PER_TURN),
        )
      } catch (error) {
        // Shown verbatim under the box.
        setAttachNote(error instanceof Error ? error.message : 'Could not attach that image.')
      } finally {
        setAttachingCount((count) => count - 1)
      }
    }
    promptRef.current?.focus()
  }

  // A paste that is only paths to images outside the project attaches those
  // images, read now: the file may be a screenshot's temporary copy the system
  // clears minutes later, and the copy saved here is the one the prompt names
  // at launch. One that cannot be read goes back in as the text it was, with
  // the reason.
  const attachPastedPaths = async (paths: string[], text: string, selectionStart: number, selectionEnd: number) => {
    setAttachNote(null)
    setAttachingCount((count) => count + paths.length)
    let read: Awaited<ReturnType<typeof readPastedImagePaths>>
    try {
      read = await readPastedImagePaths(paths)
    } finally {
      setAttachingCount((count) => count - paths.length)
    }
    if (read.ok) {
      await attachDroppedFiles(read.files)
      return
    }
    setPrompt((current) => current.slice(0, selectionStart) + text + current.slice(selectionEnd))
    setAttachNote(read.message)
    promptRef.current?.focus()
  }

  const removeImage = (id: string) => setImages((current) => current.filter((image) => image.id !== id))
  const removeFile = (path: string) => setFiles((current) => current.filter((entry) => entry !== path))
  // The words with the file cards typed after them as their paths, for a start
  // that carries text alone: a terminal agent, a schedule, another machine.
  // `spell` writes each path as the machine the agent runs on reads it.
  const typedFiles = (words: string, spell: (path: string) => string = (path) => path) =>
    [words, ...files.map((path) => quotePath(spell(path)))].filter(Boolean).join(' ')

  // A plain shell launches no CLI, so it wears no CLI chip. A chat agent is a
  // CLI too — the same one, driven as a chat — so it wears the same chip and
  // opens the same picker, with the rail narrowed to the CLIs that have a chat
  // runtime (`composer.optionsFor`).
  const launchCli: AgentCli | null = selection.kind === 'terminal' ? null : composer.selectionCli
  const pickerOptions = composer.optionsFor(selection)
  // No installed CLI can run as a chat: the Chat agent choice has nothing to
  // start, and says so with the install route rather than a dead chip.
  const chatUnavailable = isChatLaunch && composer.catalogStatus === 'ready' && pickerOptions.length === 0
  // Only a terminal launch runs a command line, so only it has one to preview.
  const commandCli: AgentCli | null = selection.kind === 'general' ? launchCli : null
  const engineNames = composer.engineNamesFor(selection)
  const model = launchCli ? composer.modelForSelection(selection, launchCli) : undefined
  const reasoning = launchCli ? composer.reasoningForSelection(selection, launchCli) : undefined
  // Permissions are a property of the CLI (owner ruling 2026-09-24): the preset
  // this launch runs on is the one stored for the picked runtime, whichever of
  // its models is picked, and the host's `permissionPreset` is only the
  // app-wide default a CLI nobody has set still resolves to. A terminal or a
  // conversation has no CLI and no permission flag, so it simply reads the
  // fallback and shows no control.
  //
  // A remote machine takes the same preset (owner ruling 2026-09-27: every
  // surface may spawn in bypass), and it travels explicitly, so the agent over
  // there runs on the choice this launcher shows rather than on that machine's
  // own default. Everything the surface says about permissions — the chip, the
  // command-line preview, what the launch carries — reads THIS, never the prop.
  const effectivePreset = useCliPermissionPreset(launchCli, permissionPreset)
  // The CLI's own mode chosen beside it (Claude Code's Accept edits), which the
  // preview renders. A scheduled agent and a launch on another machine carry
  // the preset alone, and run its own mode.
  const effectiveMode = useCliPermissionMode(launchCli)

  // ── The skill trigger ────────────────────────────────────────────────────
  // A chat carries skills as attachments rather than a typed invocation, the
  // same chips the "+" menu adds, so `/` opens the picker and a pick becomes a
  // chip, whichever runtime the chat runs on. A terminal agent has its CLI's
  // own `/` picker once it starts, so its prompt here opens none.
  const skillIntegration = React.useMemo(() => {
    if (!commandCli) return undefined
    return pluginCatalogEntries.find((entry) => entry.id === commandCli)?.skillIntegration
  }, [commandCli, pluginCatalogEntries])
  const mentionPrefix = resolveSkillMentionPrefix(skillIntegration)
  const skillMarker = selection.kind === 'conversation' ? '/' : undefined

  // `/schedule every weekday at 9`: the schedule said where the cursor is.
  // Offered wherever scheduling is, from a chat launch too — picking a
  // schedule is what switches the door to Scheduled agent.
  const [slashDismissed, setSlashDismissed] = React.useState(false)
  const slashRef = React.useRef<ScheduleSlashPickerHandle | null>(null)
  const slashQuery = React.useMemo(() => {
    if (!scheduleOffered || editing || slashDismissed) return null
    const match = SCHEDULE_COMMAND.exec(prompt)
    return match ? (match[1] ?? '') : null
  }, [editing, prompt, scheduleOffered, slashDismissed])
  // A dismissal holds for that `/schedule`, not for the next one typed.
  React.useEffect(() => {
    if (slashDismissed && !SCHEDULE_COMMAND.test(prompt)) setSlashDismissed(false)
  }, [prompt, slashDismissed])
  const applySlashSchedule = React.useCallback((picked: { cron: string }) => {
    setPrompt((current) => current.replace(SCHEDULE_COMMAND, '').trimEnd())
    setMode('scheduled')
    setCron(picked.cron)
    setOnce(null)
    promptRef.current?.focus()
  }, [])

  // The type-ahead opens on a marker at a token boundary — the start of the
  // draft, of any line, or after a space — with the caret in the token, and a
  // pick replaces that token alone. Esc keeps it shut for the token it was
  // pressed in; a token no skill matches closes it until the next keystroke.
  const [mentionDismissedAt, setMentionDismissedAt] = React.useState<number | null>(null)
  const [mentionEmpty, setMentionEmpty] = React.useState(false)
  const mentionRef = React.useRef<InlineSkillPickerHandle | null>(null)
  const mentionToken = React.useMemo(
    () => (skillMarker && slashQuery === null ? composerTokenAt(prompt, promptCaret, skillMarker) : null),
    [prompt, promptCaret, skillMarker, slashQuery],
  )
  const mentionStart = mentionToken?.range.start ?? null
  React.useEffect(() => {
    if (mentionDismissedAt !== null && mentionStart !== mentionDismissedAt) setMentionDismissedAt(null)
  }, [mentionDismissedAt, mentionStart])
  const mentionQuery =
    mentionToken && !mentionEmpty && mentionToken.range.start !== mentionDismissedAt ? mentionToken.query : null
  const dismissMention = React.useCallback(() => setMentionDismissedAt(mentionStart), [mentionStart])

  // Put the caret where a pick asked once the rewritten draft has rendered.
  React.useEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    promptRef.current?.focus()
    promptRef.current?.setSelectionRange(caret, caret)
    setPromptCaretAt({ value: prompt, caret })
  }, [prompt])

  const replaceMentionToken = (text: string) => {
    if (!mentionToken) return
    const { start, end } = mentionToken.range
    // A space already after the token is reused rather than doubled.
    const tail = text.endsWith(' ') && /^\s/u.test(prompt.slice(end)) ? end + 1 : end
    pendingCaretRef.current = start + text.length
    setPrompt(prompt.slice(0, start) + text + prompt.slice(tail))
  }

  const applySkillMention = (skill: WorkspaceSkill) => {
    if (!composer.skills.some((entry) => entry.id === skill.id)) composer.setSkills([...composer.skills, skill])
    replaceMentionToken('')
  }

  // Switching CLIs re-renders mentions already typed in the new one's form.
  const previousPrefix = React.useRef(mentionPrefix)
  React.useEffect(() => {
    const before = previousPrefix.current
    previousPrefix.current = mentionPrefix
    if (!before || !mentionPrefix || before === mentionPrefix) return
    setPrompt((current) =>
      current.replace(new RegExp(`(^|\\s)\\${before}([A-Za-z0-9._-]+)`, 'g'), `$1${mentionPrefix}$2`),
    )
  }, [mentionPrefix])

  // Worktree is offered only inside a git repo: absent, not disabled.
  React.useEffect(() => {
    let cancelled = false
    if (!workspaceRoot) {
      setWorkspaceIsGitRepo(false)
      return
    }
    void window.api
      .getGitRepoRoot(workspaceRoot)
      .then((root) => {
        if (!cancelled) setWorkspaceIsGitRepo(Boolean(root))
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIsGitRepo(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  // A paired machine cuts a chat's worktree itself, from its own checkout of
  // the project, where it said it takes one (`new-chat-worktree`) and the
  // checkout it served is a git repository. An older build would skip the
  // argument and start the chat in the checkout, so there the chip is absent.
  const remoteCapabilities = remoteTarget?.capabilities ?? null
  const remoteWorktreeOffered =
    !extensionMode &&
    remoteTarget?.checkout?.git === true &&
    (remoteCapabilities?.includes('new-chat-worktree') ?? false)
  // Its name, where that machine takes one; elsewhere it makes one up.
  const remoteWorktreeNameable = remoteCapabilities?.includes('new-chat-worktree-name') ?? false
  // A worktree the project already has, where that machine starts a chat in one.
  const remoteWorktreePickable =
    !extensionMode &&
    remoteTarget?.checkout?.git === true &&
    (remoteCapabilities?.includes('new-chat-in-worktree') ?? false) &&
    remoteTarget.checkout.worktrees.some((worktree) => !worktree.isMain)
  // Worktree is offered only inside a git repository, for an agent: absent,
  // not disabled. On this machine, a repository here; on a paired machine,
  // one there that said it cuts worktrees for a chat started from here. An
  // SSH machine's chat has no checkout here to fork, and an extension's
  // folder is new.
  // "No project" is a folder the app made, not a checkout, even where the
  // home folder above it happens to be a repository.
  const worktreeOffered = remoteTarget
    ? remoteWorktreeOffered
    : !extensionMode && selection.kind !== 'terminal' && !pickedSsh && !projectless && workspaceIsGitRepo
  // The Worktree chip and an existing remote worktree are two answers to one
  // question, where the chat runs: turning the chip on puts the picked
  // worktree back, and picking one turns the chip off.
  const setWorktreeName = composer.setWorktreeName
  const changeWorktreeName = (next: string | null) => {
    if (next !== null) setRemoteWorktreePick(null)
    setWorktreeName(next)
  }
  const pickRemoteWorktree = (path: string | null) => {
    if (!remoteConnectionId || !remotePickedId || path === null) {
      setRemoteWorktreePick(null)
      return
    }
    setRemoteWorktreePick({ connectionId: remoteConnectionId, workspaceId: remotePickedId, path })
    setWorktreeName(null)
  }
  // The chip starts on at the door, so a launch it is not offered for drops
  // the worktree rather than carrying one nobody could see: a folder that is
  // not a git repository would fail to make it and keep the chat from
  // starting, and an older paired machine would ignore it.
  const buildLaunchConfirm = (target: AgentComposerSelection): AgentComposerConfirm => {
    const confirm = composer.buildConfirm(target)
    if (worktreeOffered || confirm.kind === 'terminal' || !confirm.worktree) return confirm
    const { worktree: _notOffered, ...rest } = confirm
    return rest
  }

  // ── What a launch would run, for Start's hover ───────────────────────────
  const [commandLine, setCommandLine] = React.useState<LaunchCommandLineState>({ status: 'idle' })
  const previewInput = React.useMemo(
    () => ({
      cli: commandCli,
      model,
      reasoning,
      permissionPreset: effectivePreset,
      ...(effectiveMode ? { permissionMode: effectiveMode } : {}),
      runtime: commandCli
        ? isWslHostId(hostId)
          ? { command: hostSettings?.[hostId]?.cliCommands[commandCli] ?? '', hostId }
          : cliRuntimes?.[commandCli]
        : undefined,
    }),
    [cliRuntimes, commandCli, effectiveMode, effectivePreset, hostId, hostSettings, model, reasoning],
  )
  const previewKey = launchCommandLineKey(previewInput)
  React.useEffect(() => {
    const request = launchPreviewRequest(previewInput)
    if (!request) {
      setCommandLine({ status: 'idle' })
      return
    }
    let cancelled = false
    void window.api
      .agentLaunchPreview(request)
      .then((result) => {
        if (cancelled) return
        setCommandLine(
          result.ok ? { status: 'ready', preview: result.preview } : { status: 'error', message: result.message },
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setCommandLine({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not read this agent’s launch command.',
        })
      })
    return () => {
      cancelled = true
    }
    // previewKey is previewInput's identity; the object would re-run every render.
  }, [previewKey])

  const suggestions = React.useMemo(() => drawSuggestions(seed), [seed])

  // ── Extension ─────────────────────────────────────────────────────────────
  // An extension is made in a folder of its own, never inside the project the
  // door is on (which says nothing about where an extension belongs). By
  // default that is a new folder, named as the chip is typed, in the
  // extensions home main keeps (Documents/SprintEngine/Extensions). A folder
  // the person picks is the extension's instead, and its name is the id —
  // so picking one is naming it, and making the folder first is how to choose
  // both. What is at the folder is asked as the name changes, so a name
  // already taken is said before the press: an empty folder is filled, an
  // extension there is carried on, anything else is never written over.
  const [typedExtensionName, setExtensionName] = React.useState('')
  const [extensionFolder, setExtensionFolder] = React.useState<string | null>(null)
  const [extensionHome, setExtensionHome] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!extensionMode || typeof window.api.extensionScaffoldHome !== 'function') return
    let cancelled = false
    void window.api
      .extensionScaffoldHome()
      .then((home) => {
        if (!cancelled) setExtensionHome(home)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [extensionMode])
  const extensionName = extensionFolder ? extensionIdFromName(basename(extensionFolder)) : typedExtensionName
  const pickExtensionFolder = async (): Promise<void> => {
    const picked = await window.api.openDir(extensionHome ? { defaultPath: extensionHome } : undefined)
    if (picked) setExtensionFolder(picked)
  }
  const [allIdeas, setAllIdeas] = React.useState(false)
  const extensionNameProblem =
    extensionFolder && extensionName === ''
      ? 'Name the folder with letters or digits: the extension takes its name from it.'
      : extensionName === ''
        ? null
        : extensionIdProblem(extensionName)
  const [extensionTarget, setExtensionTarget] = React.useState<{
    key: string
    state: ExtensionScaffoldTargetState
  } | null>(null)
  const extensionTargetKey =
    extensionMode && extensionName && !extensionNameProblem ? `${extensionFolder ?? ''}\u0000${extensionName}` : null
  React.useEffect(() => {
    if (!extensionTargetKey || typeof window.api.extensionScaffoldTarget !== 'function') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api
        .extensionScaffoldTarget({ id: extensionName, ...(extensionFolder ? { folder: extensionFolder } : {}) })
        .then((target) => {
          if (!cancelled && target) setExtensionTarget({ key: extensionTargetKey, state: target.state })
        })
        .catch(() => undefined)
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // extensionTargetKey is (extensionFolder, extensionName); listing them too would ask twice.
  }, [extensionTargetKey])
  const extensionTargetState = extensionTarget?.key === extensionTargetKey ? extensionTarget.state : null
  // The folder the extension will be in, as the strip shows it.
  const extensionFolderShown =
    extensionFolder ?? (extensionHome ? pathJoin(extensionHome, extensionName || 'extension-name') : null)
  // The end of that path: the folder and its parent for one picked, and from
  // SprintEngine on for a new one in the home, which says whose folder it is.
  const extensionFolderLabel = extensionFolderShown
    ? extensionFolderShown
        .split(/[\\/]+/)
        .filter(Boolean)
        .slice(extensionFolder ? -2 : -3)
        .join('/')
    : null
  const extensionNote = extensionNameProblem
    ? extensionNameProblem
    : extensionTargetState === 'taken'
      ? extensionFolder
        ? `${basename(extensionFolder)} already has files in it. Choose an empty folder, or make a new one in the dialog.`
        : `The extensions folder already has a ${extensionName} folder. Choose another name.`
      : extensionTargetState === 'installed'
        ? `An extension named ${extensionName} is already installed on this computer. ${
            extensionFolder ? 'Choose a folder with another name.' : 'Choose another name.'
          }`
        : extensionTargetState === 'no_parent'
          ? 'That folder is not there any more. Choose another.'
          : null
  // Everything the extension needs before ⏎: a name that is free (or an
  // extension to carry on), and something to build.
  const extensionReady =
    !extensionMode ||
    (extensionName !== '' &&
      !extensionNameProblem &&
      (extensionTargetState === 'free' || extensionTargetState === 'extension') &&
      prompt.trim() !== '')
  const pickIdea = (idea: ExtensionIdea): void => {
    setPrompt(idea.prompt)
    window.requestAnimationFrame(() => {
      const field = promptRef.current
      if (!field) return
      field.focus()
      field.setSelectionRange(idea.prompt.length, idea.prompt.length)
    })
  }
  // Every chat runtime runs on a WSL machine as well as on this one, so the
  // machine never keeps a chat from starting (owner ruling 2026-10-01).
  const canLaunch =
    composer.visibleRows.some((row) => rowMatchesSelection(row, selection)) &&
    (!isChatLaunch || (conversationWorkspaceSupported && pickerOptions.length > 0))

  // ── Scheduling ────────────────────────────────────────────────────────────
  // What a scheduled agent is made of is exactly what this launch would start
  // now — the machine, project, CLI, model, preset, skills, MCP servers and
  // worktree on screen — plus the schedule in the tray. Main owns the list;
  // the door closes on the card it lands as.
  const [scheduleBusy, setScheduleBusy] = React.useState(false)
  // Why the last run did not start, until the person has seen it here.
  const [lastRunFailure, setLastRunFailure] = React.useState<string | null>(() =>
    editing?.lastRun && !editing.lastRun.ok && (editing.lastFailureSeenAt ?? 0) < editing.lastRun.at
      ? editing.lastRun.message
      : null,
  )
  const editingId = editing?.id ?? null
  React.useEffect(() => {
    if (editingId && lastRunFailure) void window.api.markScheduledAgentFailureSeen(editingId).catch(() => {})
    // Once, on open: seeing it here is what the card's "Failed" was waiting for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  const schedule = async (text: string) => {
    if (!canLaunch || scheduleBusy) return
    const folder = workspaceRoot?.trim()
    if (!folder) {
      showToast({
        tone: 'warn',
        title: 'Choose a project',
        description: 'A scheduled agent starts its chats in a project.',
      })
      return
    }
    // Each run starts from this text alone, so the files are typed into it.
    const body = typedFiles([text.trim(), ...images.map((image) => quotePath(image.path))].filter(Boolean).join(' '))
    if (!body) {
      showToast({
        tone: 'warn',
        title: 'Say what it should do',
        description: 'Each run starts with this prompt, so a scheduled agent needs one.',
      })
      promptRef.current?.focus()
      return
    }
    if (once !== null && once <= Date.now()) {
      showToast({ tone: 'warn', title: 'Pick a time ahead', description: 'That time has already passed.' })
      return
    }
    const confirm = buildLaunchConfirm(selection)
    if (confirm.kind !== 'conversation' || !confirm.cli) return
    const draftRecord: ScheduledAgentDraft = {
      prompt: body,
      schedule: { cron, timezone: scheduleTimezone, ...(once !== null ? { once } : {}) },
      folderPath: folder,
      // This PC is kept only where the folder would say otherwise.
      hostId: hostIdToRecord(hostId, folder) ?? null,
      cli: confirm.cli,
      cliModel: confirm.model ?? null,
      // The preset this launcher shows, recorded, so each run is the launch
      // the person saw rather than whatever the default is by then.
      permissionPreset: effectivePreset,
      skills: (confirm.skills ?? []).map((skill) => ({ id: skill.id, name: skill.name })),
      mcpServers: composer.mcpServers.map((server) => ({ id: server.id, name: server.name })),
      worktree: confirm.worktree ? { name: confirm.worktree.name } : null,
    }
    setScheduleBusy(true)
    try {
      const result = editing
        ? await window.api.updateScheduledAgent(editing.id, draftRecord)
        : await window.api.createScheduledAgent(draftRecord)
      if (!result.ok) {
        showToast({ tone: 'error', title: editing ? 'Not saved' : 'Not scheduled', description: result.message })
        return
      }
      if (once === null) rememberSchedule(cron)
      onScheduled?.(result.agent)
    } catch (error) {
      showToast({
        tone: 'error',
        title: editing ? 'Not saved' : 'Not scheduled',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setScheduleBusy(false)
    }
  }

  // Run now starts what is saved, not what is on screen: an unsaved edit is
  // still a question, and a run is an answer.
  const runSavedNow = async () => {
    if (!editing) return
    const result = await window.api.runScheduledAgentNow(editing.id).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    if (!result.ok) {
      showToast({ tone: 'error', title: 'Did not run', description: result.message })
    } else if (!result.run.ok) {
      setLastRunFailure(result.run.message)
    } else {
      setLastRunFailure(null)
      // The run is a chat of its own, started in the background as every run
      // is, so the window stays on this editor; it lands first under Recent
      // runs below as soon as this window hears of it — the place to open it.
      showToast({ tone: 'good', title: 'Started', description: 'Its chat is first under Recent runs, below.' })
    }
  }

  // A ⌘⏎ launch went out: the box empties for the next task, keeping every
  // choice around it, and keeps the focus (a toast offers to open the chat).
  // Should the host say nothing started (a worktree that could not be made,
  // which says why itself), the prompt comes back, unless the person has
  // already typed the next one.
  //
  // A worktree NAME belongs to the chat it was typed for: the next one asking
  // for the same name would collide with it. The chip stays on, made up at
  // start, until the person names the next one.
  const keepOnNewChat = (started: void | Promise<boolean>, sentPrompt: string, sentImages: PromptImage[]) => {
    const sentFiles = files
    const sentWorktreeName = composer.worktreeName
    const setWorktreeName = composer.setWorktreeName
    setPrompt('')
    setImages([])
    setFiles([])
    if (sentWorktreeName) setWorktreeName('')
    window.requestAnimationFrame(() => promptRef.current?.focus())
    void Promise.resolve(started).then((ok) => {
      if (ok !== false) return
      setPrompt((current) => (current === '' ? sentPrompt : current))
      setImages((current) => (current.length === 0 ? sentImages : current))
      setFiles((current) => (current.length === 0 ? sentFiles : current))
      if (sentWorktreeName) setWorktreeName((current) => (current === '' ? sentWorktreeName : current))
    })
  }

  const launch = (text: string, options: { stay?: boolean } = {}) => {
    if (!canLaunch || !extensionReady) return
    // Staying applies to a chat or agent started now, here or over SSH; a
    // scheduled agent, an extension and a paired machine's chat each close
    // the door as ⏎ does.
    const stay = options.stay === true && launchesInBackground && !extensionMode
    if (scheduled) {
      void schedule(text)
      return
    }
    if (pickedSsh) {
      if (sshFolderProblem) {
        showToast({ tone: 'warn', title: 'Which folder?', description: sshFolderProblem })
        return
      }
      const confirm = buildLaunchConfirm(selection)
      if (confirm.kind === 'conversation') {
        const providerId = confirm.cli ? conversationProviderForCli(confirm.cli) : null
        if (!providerId) return
        confirm.provider = {
          providerId,
          modelId: confirm.model ?? CONVERSATION_DEFAULT_MODEL_ID,
          modelLabel: engineNames.modelLabel ?? engineNames.cliLabel,
        }
      }
      const folder = sshFolder.trim().replace(/(.)\/+$/u, '$1')
      lastSshFolders.set(pickedSsh.id, folder)
      // The images go with the first message: they are files on this
      // computer, which the chat reads here and sends as bytes, as it does
      // for an image pasted into an SSH chat.
      const sshImages = images.map((image) => image.path)
      const started = onLaunch({
        ...confirm,
        // Files on this computer are typed as their paths there, as before.
        prompt: typedFiles(text.trim()),
        ...(sshImages.length > 0 ? { images: sshImages } : {}),
        environment: { kind: 'ssh', id: pickedSsh.id, label: pickedSsh.label, folder },
        ...(stay ? { stay: true as const } : {}),
      })
      if (stay) keepOnNewChat(started, text, images)
      return
    }
    if (remoteTarget) {
      if (!remoteTarget.picked || !onLaunchRemote || remoteLaunching) return
      const confirm = buildLaunchConfirm(selection)
      // The worktree the project already has, picked and still on offer.
      const remoteRunsIn = remoteWorktreePickable ? remoteExistingWorktree : null
      if (confirm.kind !== 'conversation') return
      // Attached files are files on this disk, and a path here typed into
      // that machine's prompt names nothing there, so their chips refuse
      // rather than vanish. Images travel as bytes with the launch, and skills
      // are that machine's own, picked from its list: it installs and runs
      // them, and refuses them in words if it is too old to.
      if (files.length > 0) {
        showToast({
          tone: 'warn',
          title: 'That chat cannot travel yet',
          description: `Remove the attached files to start on ${remoteTarget.connection.machineName}, or start it on This device.`,
        })
        return
      }
      setRemoteLaunching(true)
      onLaunchRemote({
        connectionId: remoteTarget.connection.id,
        machineName: remoteTarget.connection.machineName,
        remoteWorkspaceId: remoteTarget.picked.workspaceId,
        remoteWorkspaceName: remoteTarget.picked.name,
        remoteWorkspaceRoot: remoteTarget.picked.folderPath,
        prompt: text.trim(),
        cli: confirm.cli,
        cliModel: confirm.model ?? null,
        permissionPreset: effectivePreset,
        ...(remoteTakesEffort && confirm.reasoning ? { effort: confirm.reasoning } : {}),
        branch: remoteRunsIn ? remoteRunsIn.branch : (remoteTarget.checkout?.branch ?? null),
        // Where in the project it runs: a worktree cut for it (named only
        // where the machine takes a name), or one the project already has.
        ...(confirm.worktree
          ? { worktree: { kind: 'new' as const, name: remoteWorktreeNameable ? confirm.worktree.name.trim() : '' } }
          : remoteRunsIn
            ? { worktree: { kind: 'existing' as const, path: remoteRunsIn.path } }
            : {}),
        remoteRepository: remoteTarget.picked.repository,
        ...(images.length > 0 ? { images: images.map(remoteImage) } : {}),
        ...(confirm.skills?.length ? { skills: confirm.skills.map((skill) => skill.id) } : {}),
      })
        .finally(() => setRemoteLaunching(false))
        // The host reports its own failures as toasts; a throw past its catch
        // (an add-workspace fault) must not surface as an unhandled rejection.
        .catch(() => {})
      return
    }
    const confirm = buildLaunchConfirm(selection)
    // A chat sends the attached images as images with its first message. A
    // terminal agent is typed them as paths after the text, quoted only when
    // the path needs it — the terminal drop idiom.
    const imagePaths = images.map((image) => image.path)
    const asImages = confirm.kind === 'conversation' && imagePaths.length > 0
    // A path typed for an agent in a WSL distribution is spelled as Linux
    // sees this computer's drives (`C:\…` is `/mnt/c/…` there); a chat's
    // images are read here, so they keep this computer's spelling.
    const spell = (path: string) => (isWslHostId(hostId) && isWindowsPath(path) ? toWslPath(path) : path)
    const words = [text.trim(), ...(asImages ? [] : imagePaths.map((path) => quotePath(spell(path))))]
      .filter(Boolean)
      .join(' ')
    // A chat on this computer sends its files beside the words, as its first
    // message's `files`, and its bubble draws them as cards; anything else (a
    // terminal agent, a chat on a WSL distribution) is typed them after the
    // words on the same line, as a dropped path would be — a blank line could
    // end a terminal's prompt early.
    const filesBeside = confirm.kind === 'conversation' && filesAsCards
    const prompt = filesBeside ? words : typedFiles(words, spell)
    if (confirm.kind === 'conversation') {
      // The picker's CLI and model, mapped onto the conversation provider that
      // drives that CLI as a chat. The CLI's own default row asks for no model.
      const providerId = confirm.cli ? conversationProviderForCli(confirm.cli) : null
      if (!providerId) return
      confirm.provider = {
        providerId,
        modelId: confirm.model ?? CONVERSATION_DEFAULT_MODEL_ID,
        modelLabel: engineNames.modelLabel ?? engineNames.cliLabel,
      }
    }
    const started = onLaunch({
      ...confirm,
      prompt,
      ...(asImages ? { images: imagePaths } : {}),
      ...(filesBeside && files.length > 0 ? { files } : {}),
      ...(hostChoosable ? { hostId } : {}),
      ...(extensionMode
        ? { extension: { id: extensionName, ...(extensionFolder ? { folder: extensionFolder } : {}) } }
        : {}),
      ...(stay ? { stay: true as const } : {}),
    })
    if (stay) keepOnNewChat(started, text, images)
  }

  React.useEffect(() => {
    if (!canLaunch || (composer.noAgentCliInstalled && localHosts.length <= 1)) return
    const id = requestAnimationFrame(() => promptRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [canLaunch, composer.noAgentCliInstalled, localHosts.length])

  // ── The static New chat box ───────────────────────────────────────────────
  // The field takes over the box as it mounts (`adoptBootInput` below). An
  // Enter pressed in the box is held here, with the words it was pressed on,
  // and starts the chat as soon as the panel can and holds those words —
  // exactly what it would have done had the panel been there to take it.
  const bootLaunchPendingRef = React.useRef<string | null>(null)
  const bootLandingRef = React.useRef<DOMRect | null>(null)
  const adoptBootInput = React.useCallback(() => {
    bootLandingRef.current = bootComposerRect()
    const taken = claimBootComposer()
    if (taken?.enterPending) bootLaunchPendingRef.current = taken.text
    return taken
  }, [])
  React.useEffect(() => {
    const pending = bootLaunchPendingRef.current
    if (pending === null || pending !== prompt || !canLaunch || !extensionReady) return
    bootLaunchPendingRef.current = null
    launch(prompt)
  })
  // The box was drawn from a capture; if the composer it stood in for landed
  // anywhere else, the capture is out of date (a layout changed since), and
  // the next launch must not draw it again.
  React.useLayoutEffect(() => {
    const landed = bootLandingRef.current
    bootLandingRef.current = null
    const composerBox = rootRef.current?.querySelector('[data-new-chat-composer]')
    if (!landed || !composerBox) return
    const actual = composerBox.getBoundingClientRect()
    const off = Math.max(
      Math.abs(actual.left - landed.left),
      Math.abs(actual.top - landed.top),
      Math.abs(actual.width - landed.width),
    )
    if (off > 0.5) dropBootComposerSnapshot()
  }, [])

  // Escape cancels from anywhere on the surface — the prompt is where focus
  // starts, but a person who has tabbed to a chip must not be trapped. The
  // `defaultPrevented` guard is the topmost-surface contract: an open popover or
  // the skill type-ahead handles its own Escape first, and only when nothing
  // did does this close.
  //
  // Not while painted over: the door host parks this surface when a door
  // opens, but a first-run auto-open can mount it UNDER a door that is already
  // up, inert. An Escape meant for that door must not close this on purpose
  // (and take its parked draft with it).
  //
  // Only an Escape pressed on this surface: the tab strip's "+" shares the
  // window with other panes, and an Escape in one of them is theirs. The door
  // covers the stage, so there an Escape with nothing focused is its too. An
  // Escape that drops an input method's candidates belongs to the input method.
  const rootRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeKey(event)) return
      const root = rootRef.current
      if (!root || root.closest('[inert], [aria-hidden="true"]')) return
      const target = event.target instanceof Node ? event.target : null
      const onSurface =
        (target !== null && root.contains(target)) ||
        (root.closest('[data-new-chat-door]') !== null &&
          (target === null || target === document.body || target === document.documentElement || target === document))
      if (!onSurface) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const keyPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const launchInBackgroundKeys = getEffectiveKeybindings(LAUNCH_IN_BACKGROUND_COMMAND, keybindingSettings)
  const withoutProjectKeys = getEffectiveKeybindings('chat.newWithoutProject', keybindingSettings)
  const onPromptKeyDown = (event: ComposerKeyEvent) => {
    // A key in the real field is the person carrying on: an Enter held from
    // the static box no longer speaks for what the field now says.
    bootLaunchPendingRef.current = null
    // The Enter that commits an input method's composition belongs to the
    // input method: it picks the characters, it does not send them half-typed.
    if (isImeKey(event)) return
    if (slashQuery !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (slashRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        // Enter with nothing to pick is not a launch: the words after
        // `/schedule` are not the prompt.
        event.preventDefault()
        slashRef.current?.pickActive()
        return
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (mentionQuery !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (mentionRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        if (mentionRef.current?.pickActive()) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        dismissMention()
        return
      }
    }
    // ⌘⏎ (or whatever the Shortcuts tab bound it to) starts the chat and
    // stays here. Resolved in this handler rather than by the window's
    // dispatcher so the menus above and an input method keep the key first.
    // Disabled, it falls through to ⏎, which is what it did before.
    if (launchesInBackground && keydownMatchesKeybindings(event, launchInBackgroundKeys, keyPlatform)) {
      event.preventDefault()
      launch(prompt, { stay: true })
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      launch(prompt)
    }
    // Escape is not handled here: the window listener above owns cancel, so it
    // works from every control on the surface rather than only this field.
  }

  // A plain shell runs nothing on its behalf: there is no prompt to give it and
  // no suggested task to start it with. Saying so beats a field that silently
  // drops what was typed.
  const isTerminalLaunch = selection.kind === 'terminal'
  // The skills picker is where skills are offered; the inline `$`/`/`
  // type-ahead still works, it just no longer needs advertising. A plain shell
  // takes no prompt: nothing types a command into it for you.
  const placeholder = isTerminalLaunch
    ? 'A shell opens with nothing typed'
    : scheduled
      ? 'What each run should do…'
      : extensionMode
        ? 'Describe the extension…'
        : selection.kind === 'general'
          ? 'Describe the task. It runs in a terminal you can take over.'
          : 'Describe the task…'
  // No agent CLI at all, or (for a chat agent) none with a chat runtime: the
  // same install route either way, because installing a CLI is the answer to
  // both.
  const terminalUnavailable = (composer.noAgentCliInstalled && localHosts.length <= 1) || chatUnavailable
  // A drag holding files lights the box as where they will land; a plain shell
  // takes none.
  const { active: dropActive, handlers: dropHandlers } = useFileDropTarget({
    enabled: !isTerminalLaunch,
    accepts: dataTransferHasDroppableFiles,
    onDrop: dropFiles,
  })
  const boxHasContent = prompt.trim() !== '' || images.length > 0 || files.length > 0 || attachingCount > 0

  // The capture: this panel, untouched, in a window with no chats, is what
  // the next launch opens on. Taken after paint and again whenever the region
  // changes size; anything the person types or picks stops it, and the last
  // untouched capture stands.
  const bootCapturable =
    bootComposer &&
    mode === 'chat' &&
    !editing &&
    prompt === '' &&
    images.length === 0 &&
    files.length === 0 &&
    attachingCount === 0 &&
    scopeFolder === null &&
    composer.skills.length === 0 &&
    composer.mcpServers.length === 0 &&
    hostId === LOCAL_HOST_ID &&
    !pickedSsh &&
    !remoteTarget &&
    !isTerminalLaunch
  React.useEffect(() => {
    const door = rootRef.current?.closest<HTMLElement>('[data-new-chat-door]')
    if (!bootCapturable || !door) return
    let frame = 0
    const capture = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => captureBootComposerSnapshot(door, seed))
    }
    capture()
    // A chip that fills in late (a model label, a machine list) changes what
    // the panel looks like without a render of this component.
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(capture) : null
    resized?.observe(door)
    const changed = typeof MutationObserver === 'function' ? new MutationObserver(capture) : null
    changed?.observe(door, { subtree: true, childList: true, characterData: true, attributes: true })
    // A new theme, material or chat width is a new look; the capture carries
    // the look it was taken under, so it is taken again under the new one.
    changed?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode', 'data-window-material', 'data-chat-width', 'data-chat-contrast'],
    })
    return () => {
      cancelAnimationFrame(frame)
      resized?.disconnect()
      changed?.disconnect()
    }
  }, [bootCapturable, seed, placeholder, selection])

  // ── The "+" menu ──────────────────────────────────────────────────────────
  // How the launch starts. A conversation wherever the workspace can host one;
  // a terminal agent and a plain shell wherever this client runs terminals,
  // except for an extension (built in a chat, with its skill) and a scheduled
  // agent being edited (it stays one).
  const offeredKinds = React.useMemo(() => {
    const kinds = new Set<StartAs>()
    if (chatAvailable) kinds.add('conversation')
    if (!extensionMode && !editing && clientSupports('terminals')) {
      kinds.add('general')
      kinds.add('terminal')
    }
    return kinds
  }, [chatAvailable, editing, extensionMode])
  // Everything handed to the "+" is held steady across renders: the menu is
  // memoized, and a fresh callback or object on each keystroke redrew it with
  // every letter typed.
  const setComposerSelection = composer.setSelection
  const startAs = React.useCallback(
    (kind: StartAs): void => {
      // A scheduled agent's runs are chats: a terminal needs someone at it, so
      // choosing one stops scheduling rather than lying about what would run.
      if (kind !== 'conversation' && mode === 'scheduled' && !editing) setMode('chat')
      const next: AgentComposerSelection = { kind } as AgentComposerSelection
      setComposerSelection(next)
      setLastNewChatAgent(next)
    },
    [editing, mode, setComposerSelection, setLastNewChatAgent],
  )
  const plusStartAs = React.useMemo(
    () => ({ kind: selection.kind, offered: offeredKinds, onStartAs: startAs }),
    [offeredKinds, selection.kind, startAs],
  )
  const attachFiles = React.useCallback(() => {
    fileInputRef.current?.click()
  }, [])
  // What the launch reads skills and MCP servers through: nothing for a plain shell.
  const skillsOffered = selection.kind !== 'terminal'
  const { skills: pickedSkills, setSkills, mcpServers: pickedMcpServers, setMcpServers } = composer
  const remotePickedConnection = remoteTarget?.picked ? remoteTarget.connection.id : null
  const remotePickedWorkspace = remoteTarget?.picked?.workspaceId ?? null
  const remoteSkillsSource = React.useMemo(
    () =>
      remotePickedConnection && remotePickedWorkspace
        ? { connectionId: remotePickedConnection, workspaceId: remotePickedWorkspace }
        : null,
    [remotePickedConnection, remotePickedWorkspace],
  )
  const plusSkills = React.useMemo(
    () =>
      skillsOffered
        ? {
            workspaceRoot,
            // A chat stages skills itself rather than through the CLI's own
            // skill directory, so the workspace-wide inventory is its list.
            pluginId: commandCli,
            skills: pickedSkills,
            onSkillsChange: setSkills,
            mcpServers: pickedMcpServers,
            onMcpServersChange: setMcpServers,
            // A chat on a paired machine is offered that machine's skills and
            // servers. Its servers are its own to configure, so none is
            // added from here.
            ...(remoteSkillsSource ? { remote: remoteSkillsSource, mcpPickable: false } : {}),
          }
        : undefined,
    [
      commandCli,
      pickedMcpServers,
      pickedSkills,
      remoteSkillsSource,
      setMcpServers,
      setSkills,
      skillsOffered,
      workspaceRoot,
    ],
  )
  const scheduleShown = scheduleOffered || editing !== null
  const scheduleDisabled = editing
    ? 'A scheduled agent stays one'
    : selection.kind !== 'conversation'
      ? 'Only a conversation can run on a schedule'
      : null
  const scheduleOption = React.useMemo(
    () =>
      scheduleShown
        ? {
            on: scheduled,
            disabled: scheduleDisabled,
            onToggle: () => {
              if (scheduled) {
                setMode('chat')
                return
              }
              setOnce(defaultSendAt(Date.now()))
              setMode('scheduled')
            },
          }
        : undefined,
    [scheduleDisabled, scheduleShown, scheduled],
  )

  // ── The context strip ─────────────────────────────────────────────────────
  // Where the launch runs: the machine, the project, the worktree and the
  // branch. It replaces the machine · project line that sat above the box and
  // the Worktree chip that sat on its row (owner ruling 2026-10-04).
  const machinePickerShown =
    (remoteSelectable && remoteMachines.length > 0) || localHosts.length > 1 || sshMachines.length > 0
  // The branch the launch starts from: the remote project's as its machine
  // read it, else this checkout's. An SSH machine's folder is typed, not read.
  // An extension's folder is new, or the person's own: the project's branch
  // says nothing about it.
  const stripBranch = extensionMode
    ? null
    : remoteTarget
      ? (remoteTarget.checkout?.branch ?? null)
      : pickedSsh
        ? null
        : branch
  const projectControl = extensionMode ? (
    <ExtensionFolderChip
      folder={extensionFolderShown}
      label={extensionFolderLabel}
      picked={extensionFolder !== null}
      onPick={() => void pickExtensionFolder()}
      onReset={() => setExtensionFolder(null)}
    />
  ) : pickedSsh ? (
    <Input
      aria-label={`Folder on ${pickedSsh.label}`}
      value={sshFolder}
      onChange={(event) => setSshFolder(event.target.value)}
      placeholder={`Folder on ${pickedSsh.label}, such as /home/dev/repo`}
      size="sm"
      variant="well"
      fullWidth={false}
      className="w-72 max-w-full font-mono"
    />
  ) : remoteTarget ? (
    <RemoteProjectPicker
      target={remoteTarget}
      color={scopeProjectColor}
      onPick={(project) => {
        setRemoteTarget((current) => (current ? { ...current, picked: project, checkout: null } : current))
      }}
    />
  ) : canChooseProject ? (
    <>
      <ProjectScopePicker
        label={projectLabel ?? 'Choose a project'}
        // The branch has its own place on the strip.
        branch={null}
        options={projectOptions ?? []}
        selectedPath={workspaceRoot}
        onSelect={(path) => onSelectProject?.(path)}
        onStartWithoutProject={onStartWithoutProject}
        onBrowse={onBrowseProject ? () => onBrowseProject(hostId) : undefined}
        onClone={onCloneProject}
        // The hue, resolved here because only this component holds the
        // repository identity behind the folder; the identity map goes with it
        // so the rows IN the list wear their own colours too, read from the map
        // this panel already asked main for rather than a second round of the
        // same IPC.
        color={scopeProjectColor}
        unfiled={!workspaceRoot?.trim()}
        identities={localIdentities}
      />
      {/* Nothing chosen yet: the other answer, one click away beside the
        question, for a chat that is about no codebase at all. Once a
        project is chosen it moves into the chip's list. */}
      {onStartWithoutProject && !workspaceRoot?.trim() ? (
        <Tooltip
          content={
            withoutProjectKeys[0]
              ? `Runs in a folder of its own · ${renderKeybinding(withoutProjectKeys[0], keyPlatform)}`
              : 'Runs in a folder of its own'
          }
          placement="top"
        >
          <LinkButton ink="quiet" className="shrink-0 px-1 text-meta" onClick={onStartWithoutProject}>
            or start without a project
          </LinkButton>
        </Tooltip>
      ) : null}
    </>
  ) : projectLabel ? (
    // The tab strip's "+": the project is a fact rather than a choice, so this
    // is a line and not a control — but it is the same line, and it wears the
    // same glyph in the same hue. Every state of the strip carries the colour,
    // or the colour stops being how you tell one project from another.
    <span
      data-project-line="true"
      className="inline-flex h-control-xs min-w-0 items-center gap-1.5 px-2 text-meta text-[color:var(--text-subtle)]"
    >
      <FolderIdentityIcon folderPath={workspaceRoot} className="icon-xs shrink-0" color={scopeProjectColor} />
      <span className="min-w-0 truncate">{projectLabel}</span>
    </span>
  ) : null
  // A paired machine's project with worktrees of its own: the branch is a
  // picker of where in the project the chat runs, not a line.
  const remoteWorktreePicker =
    remoteTarget?.checkout && remoteWorktreePickable ? (
      <RemoteWorktreePicker
        machineName={remoteTarget.connection.machineName}
        checkout={remoteTarget.checkout}
        picked={remoteExistingWorktree?.path ?? null}
        newWorktree={worktreeOffered && composer.worktreeName !== null}
        onPick={pickRemoteWorktree}
      />
    ) : null
  const stripShown =
    machinePickerShown ||
    projectControl !== null ||
    worktreeOffered ||
    Boolean(stripBranch) ||
    remoteWorktreePicker !== null

  // The second line of the send's tooltip, where the door can stay: the chord
  // as this platform spells it, for the person who starts several in a row.
  const launchInBackgroundLabel =
    launchesInBackground && !extensionMode && !remoteTarget && launchInBackgroundKeys[0]
      ? renderKeybinding(launchInBackgroundKeys[0], keyPlatform)
      : null
  const launchInBackgroundHint = launchInBackgroundLabel
    ? `${launchInBackgroundLabel} starts it and keeps New chat open for the next one`
    : null
  const sendTip =
    selection.kind === 'terminal'
      ? 'Opens a shell in this folder'
      : extensionMode
        ? `Makes ${extensionName || 'the extension'} in ${
            extensionFolder ? basename(extensionFolder) : 'a new folder in Extensions'
          } and starts ${engineNames.cliLabel} there`
        : isChatLaunch
          ? `Starts ${engineNames.cliLabel} as a chat`
          : commandLine.status === 'ready'
            ? commandLine.preview.display
            : commandLine.status === 'error'
              ? commandLine.message
              : 'Reading this agent’s launch command…'

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--agent-surface)] px-6 pb-8 pt-8"
    >
      {showCloseButton ? (
        <div className="absolute right-3 top-3">
          <CloseIconButton onClick={onClose} aria-label="Cancel" />
        </div>
      ) : null}
      {/* Centred in the pane while it fits, and scrolling from the top when it
          does not: auto margins in a column collapse to nothing once the
          content outgrows it. */}
      <div className="@container m-auto flex w-full max-w-[680px] flex-col">
        {/* No mark and no greeting above the box (owner ruling 2026-10-04):
            the composer is the page. An extension keeps its question, which
            says what the box is for when it is not the usual task. */}
        {extensionMode ? (
          <div className="mb-5 text-center">
            <ExtensionsGlyph className="icon-lg mx-auto text-[color:var(--text-strong)]" />
            <h1 className="mt-2.5 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
              What should your extension do?
            </h1>
          </div>
        ) : null}

        {terminalUnavailable ? (
          <EmptyState
            density="list"
            title={
              chatUnavailable
                ? 'No agent CLI on this machine can run as a chat.'
                : 'No agent CLI is installed on this machine.'
            }
            body={
              chatUnavailable
                ? 'Install one with a chat runtime to start a chat agent here.'
                : 'Install one to start an agent here.'
            }
            action={<CliInstallCta />}
          />
        ) : null}
        {/* Why the last run of the scheduled agent being edited did not
            start, in the tray behind the box, until the person has seen it. */}
        {scheduled && lastRunFailure && !terminalUnavailable ? (
          <ScheduleFailureTray failure={lastRunFailure} onDismiss={() => setLastRunFailure(null)} />
        ) : null}
        <div
          // The box owns the visible border while the field inside it is the
          // tab stop, so the product's one focus ring lands on the box keyed to
          // the field's own focus (`FOCUS_RING_WITHIN_EDITOR_CLASS`) — not
          // an accent border swap on `focus-within`, which lit the box for the
          // row's buttons too and was a second focus idiom. Positioned, so it
          // paints over the strip tucked under its lower edge.
          className={`relative ${terminalUnavailable ? 'hidden' : ''} ${COMPOSER_SURFACE_CLASS} ${FOCUS_RING_WITHIN_EDITOR_CLASS} ${
            dropActive ? 'border-[color:var(--accent-primary)]' : 'border-[color:var(--border-default)]'
          }`}
          data-new-chat-composer="true"
          {...dropHandlers}
        >
          {dropActive ? <ComposerDropOverlay ground="app" /> : null}
          {slashQuery !== null ? (
            <ScheduleSlashPicker
              ref={slashRef}
              query={slashQuery}
              onPick={applySlashSchedule}
              onDismiss={() => setSlashDismissed(true)}
            />
          ) : null}
          {mentionQuery !== null ? (
            <InlineSkillPicker
              ref={mentionRef}
              workspaceRoot={workspaceRoot}
              pluginId={commandCli}
              query={mentionQuery}
              onPick={applySkillMention}
              onMatchCountChange={(count) => {
                if (count === 0 && mentionQuery.length > 0) setMentionEmpty(true)
              }}
              onDismiss={dismissMention}
            />
          ) : null}

          {/* Staged images sit inside the box above the text so the prompt
              reads as one thing — the same strip the chat composer uses. */}
          <ComposerAttachmentStrip
            attachments={images}
            reading={attachingCount}
            onRemove={removeImage}
            files={files}
            onRemoveFile={removeFile}
            className="px-5 pt-4"
          />

          <div className="px-5 pb-1 pt-4">
            {/* Grows with its content from the three-row floor to a ceiling,
                then scrolls — a box that showed two lines of a six-line prompt
                was hiding what the person was about to send. The chat
                composer's field, drawing the prompt's markdown in place, with
                no box of its own: `COMPOSER_SURFACE_CLASS` around it draws the
                border, the ground and the ring. */}
            <ComposerField
              ref={promptRef}
              value={prompt}
              leavesDrop={dataTransferHasDroppableFiles}
              onPaste={(event, field) => {
                // A pasted screenshot only exists as a clipboard item; a text
                // paste reports no image and falls through to the default —
                // unless the text is only paths to images outside the project,
                // which attach instead. A chat starting on another machine
                // cannot open this one's project, so there every path attaches.
                // A file copied in Finder or Explorer pastes as the file, and
                // is taken as a drop of it would be. A paste of nothing that
                // attaches is left to the default, as it always was; once one
                // is taken, everything that came with it is taken as a drop's
                // is — a path typed, a file with no path uploaded or said.
                const pasted = sortFiles(filesFromDataTransfer(event.clipboardData), fileSorting)
                if (pasted.images.length > 0 || pasted.files.length > 0) {
                  event.preventDefault()
                  takeFiles(pasted)
                  return
                }
                const text = event.clipboardData?.getData('text/plain') ?? ''
                const paths = pastedImagePaths(text, !remoteTarget && workspaceRoot ? [workspaceRoot] : [])
                if (!paths) return
                event.preventDefault()
                void attachPastedPaths(paths, text, field.selectionStart, field.selectionEnd)
              }}
              onChange={(value, caret) => {
                setPrompt(value)
                setPromptCaretAt({ value, caret })
                setMentionEmpty(false)
              }}
              // The field's own text, not this render's `prompt`: a caret
              // moved straight after an edit arrives before the re-render.
              onSelectionChange={(caret) => setPromptCaretAt({ value: promptRef.current?.value ?? prompt, caret })}
              onKeyDown={onPromptKeyDown}
              placeholder={placeholder}
              disabled={isTerminalLaunch}
              adoptInput={bootComposer ? adoptBootInput : undefined}
              contentAttributes={{ 'aria-label': 'What this agent should do' }}
              className="max-h-[280px] min-h-[66px] w-full font-mono text-body"
            />
          </div>

          {/* The controls, on the box's own ground with no rule above them:
              the "+", a tag for every choice that is not the default, the
              model, and the send. Each control is quiet — the box is the
              surface, and a standing edge on each drew a box in a box. */}
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
            <HiddenFileInput ref={fileInputRef} onFiles={(files) => takeFiles(sortFiles(files, fileSorting))} />
            <ComposerPlusMenu
              placement="bottom-start"
              startAs={plusStartAs}
              onAttach={isTerminalLaunch ? undefined : attachFiles}
              schedule={scheduleOption}
              skills={plusSkills}
            />

            {/* The tags: each choice the "+" made that is not the default. */}
            {scheduled ? (
              <ScheduleTag
                schedule={{ cron, once }}
                timezone={scheduleTimezone}
                onChange={(next) => {
                  setCron(next.cron)
                  setOnce(next.once)
                }}
                onRemove={editing ? undefined : () => setMode('chat')}
              />
            ) : null}
            {selection.kind !== 'conversation' ? (
              chatAvailable ? (
                <AttachmentChip
                  glyph={<StartAsGlyph kind={selection.kind} className="icon-xs shrink-0" />}
                  label={startAsLabel(selection.kind)}
                  removeLabel={`Start as a conversation instead of ${startAsLabel(selection.kind).toLowerCase()}`}
                  onRemove={() => startAs('conversation')}
                />
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--bg-selected)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
                  <StartAsGlyph kind={selection.kind} className="icon-xs shrink-0" />
                  {startAsLabel(selection.kind)}
                </span>
              )
            ) : null}
            {/* An extension's folder is new, so there is nothing to fork: its
                name is a tag of its own, in the extension violet. It is a field
                the launch cannot start without. */}
            {extensionMode ? (
              <ExtensionNameChip
                name={extensionName}
                onChange={setExtensionName}
                invalid={extensionNote !== null}
                fromFolder={extensionFolder !== null}
              />
            ) : null}
            {/* Every skill and MCP server picked is a tag; the "+" opens the
                picker for more. A terminal launches nothing that reads one. */}
            {skillsOffered ? (
              <>
                {composer.skills.map((skill) => (
                  <AttachmentChip
                    key={`skill-${skill.id}`}
                    glyph={<StarGlyph filled className="icon-xs text-[color:var(--accent-primary)]" />}
                    label={skill.name}
                    removeLabel={`Remove skill ${skill.name}`}
                    onRemove={() => composer.setSkills(composer.skills.filter((entry) => entry.id !== skill.id))}
                  />
                ))}
                {composer.mcpServers.map((server) => (
                  <AttachmentChip
                    key={`mcp-${server.id}`}
                    glyph={
                      <ExtensionIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={13} />
                    }
                    label={server.name}
                    removeLabel={`Remove MCP server ${server.name}`}
                    onRemove={() =>
                      composer.setMcpServers(composer.mcpServers.filter((entry) => entry.id !== server.id))
                    }
                  />
                ))}
              </>
            ) : null}

            <span className="flex-1" />

            {/* Engine: the CLI's own mark, then the model. A plain shell runs
                no CLI, so it has none. */}
            {launchCli ? (
              <EnginePickerChip
                cli={launchCli}
                options={pickerOptions}
                model={model}
                reasoning={reasoning}
                open={enginePopoverOpen}
                onOpenChange={setEnginePopoverOpen}
                onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
                onSelectModel={(cli, next) => composer.setEngineModel(selection, cli, next)}
                onSelectReasoning={(cli, next) => composer.setEngineReasoning(selection, cli, next)}
                effortOffered={effortOffered}
                // Permissions live in the picker rather than on a chip beside
                // it (owner, 2026-09-05). A preset is a property of the runtime
                // the row names — each CLI spells bypass its own way — so it is
                // chosen where the runtime is, remembered once per CLI for all
                // of its models, and sits on the picker's one trailing row
                // beside the effort control.
                permissions={(cli) => (
                  <SpawnPermissionFooter
                    cli={cli}
                    fallback={permissionPreset}
                    launch={isChatLaunch ? 'chat' : 'terminal'}
                  />
                )}
              />
            ) : null}

            {/* Run now starts what is saved; only a scheduled agent that exists
                has anything saved to run. */}
            {scheduled && editing ? (
              <GhostButton size="xs" onClick={() => void runSavedNow()}>
                Run now
              </GhostButton>
            ) : null}

            {/* The send: a small round accent button with an up arrow (owner
                ruling 2026-10-04). A scheduled agent is made, not started, so
                its send says so in a word. The invocation rides the tooltip:
                the one moment someone asks "what am I about to run?". */}
            <Tooltip
              content={
                scheduled ? (
                  editing ? (
                    'Save the prompt, schedule and settings'
                  ) : once !== null ? (
                    `Starts a new ${engineNames.cliLabel} chat with this prompt once, ${sendTimeWords(once, Date.now())}`
                  ) : (
                    `Starts a new ${engineNames.cliLabel} chat with this prompt each time the schedule comes round`
                  )
                ) : launchInBackgroundHint ? (
                  <>
                    <span className="block">{sendTip}</span>
                    <span className="block">{launchInBackgroundHint}</span>
                  </>
                ) : (
                  sendTip
                )
              }
              placement="top"
              multiline
            >
              {scheduled ? (
                <SendButton
                  size="sm"
                  onClick={() => launch(prompt)}
                  disabled={!canLaunch}
                  busy={scheduleBusy}
                  aria-keyshortcuts="Enter"
                  className="shrink-0 gap-1.5 pl-3 pr-2.5"
                >
                  {editing ? 'Save' : 'Schedule'}
                  <SendGlyph className="icon-sm" />
                </SendButton>
              ) : (
                <SendButton
                  size="sm"
                  onClick={() => launch(prompt)}
                  disabled={!canLaunch || !extensionReady}
                  aria-label={isTerminalLaunch ? 'Open terminal' : 'Start agent'}
                  aria-keyshortcuts="Enter"
                  className="w-control-sm shrink-0 px-0"
                >
                  <SendGlyph className="icon-sm" />
                </SendButton>
              )}
            </Tooltip>
          </div>
        </div>

        {/* The context strip, tucked under the box and one piece with it:
            rounded at the bottom only, inset from the box's sides, its top
            hidden under the box's lower edge (owner ruling 2026-10-04). */}
        {stripShown && !terminalUnavailable ? (
          <ComposerStrip>
            {/* One machine dropdown, this computer first (owner ruling
                2026-09-03 — no separate Local/Remote switch). Shown whenever
                there is another machine to pick. */}
            {machinePickerShown ? (
              <MachineScopePicker
                // A scheduled agent runs on this computer or one of its WSL
                // distributions: the scheduler is this computer's, and a paired
                // machine's chat would need its own.
                machines={remoteSelectable && !chatOnly ? remoteMachines : []}
                selected={remoteTarget?.connection ?? null}
                onSelect={(connection) => {
                  pickSsh(null)
                  pickRemoteMachine(connection)
                }}
                sshMachines={chatOnly ? [] : sshMachines}
                selectedSshId={pickedSsh?.id ?? null}
                onSelectSsh={(id) => {
                  pickRemoteMachine(null)
                  pickSsh(id)
                }}
                localHosts={localHosts}
                selectedHostId={hostId}
                onSelectHost={(next) => {
                  pickRemoteMachine(null)
                  pickLocalHost(next)
                }}
                hostDisabledReason={(host) => {
                  // Any folder runs on the machine picked (owner ruling
                  // 2026-10-03): This PC opens a folder inside a distribution
                  // over its share, more slowly, and the hint under the strip
                  // says so. Only another distribution cannot reach it.
                  const refused = hostRefusesFolder(host.id, scopeFolder)
                  if (refused) return refused
                  if (host.state === 'unavailable') return host.reason ?? 'Not available.'
                  return null
                }}
                availability={(machine) =>
                  machineAvailabilityOf(machine, browseOf(machineBrowses.get(machine.id)), activeIdentity)
                }
                // With a project in hand, opening the list asks every machine
                // what it holds — once, then again when the answer is old or
                // was "not answering" (a machine asleep at the first open must
                // be pickable once it wakes). Without a project there is
                // nothing to filter by, and the list is the plain one.
                onOpen={() => {
                  if (!activeIdentity) return
                  for (const machine of remoteMachines) {
                    if (machineBrowseStale(machineBrowses.get(machine.id))) void browseMachine(machine)
                  }
                }}
                projectName={activeIdentity?.name ?? null}
              />
            ) : null}
            {projectControl}
            {/* Worktree, then the branch it is cut from (or the launch runs
                on): off until turned on or named. Set apart from the project
                by the strip's spacing alone, with no rule between. */}
            {worktreeOffered ? (
              <WorktreeChip
                name={composer.worktreeName}
                onChange={changeWorktreeName}
                nameable={!remoteTarget || remoteWorktreeNameable}
              />
            ) : null}
            {remoteWorktreePicker ? (
              remoteWorktreePicker
            ) : stripBranch ? (
              // The one item on the strip that may shrink: it gives its front
              // away first, so the end of the name — the part that says what
              // the branch is for — is what stays.
              <span
                className="inline-flex h-control-xs min-w-0 flex-1 items-center gap-1.5 px-2 text-meta text-[color:var(--text-subtle)]"
                data-composer-branch={stripBranch}
              >
                <GitBranchGlyph className="icon-xs shrink-0" />
                {worktreeOffered && composer.worktreeName !== null ? <span className="shrink-0">from</span> : null}
                <FrontTruncatedText text={stripBranch} className="font-mono" />
              </span>
            ) : null}
          </ComposerStrip>
        ) : null}
        {driveAdvisory ? (
          <p className="mt-2 px-6 text-meta leading-5 text-[color:var(--text-muted)]">{driveAdvisory}</p>
        ) : null}

        {attachNote ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--tone-error)]">
            {attachNote}
          </p>
        ) : null}
        {extensionMode && extensionNote ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--tone-error)]">
            {extensionNote}
          </p>
        ) : extensionMode && extensionTargetState === 'extension' ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--text-muted)]">
            {extensionName} is already an extension there: the chat opens it to carry on.
          </p>
        ) : null}

        {/* Extension mode's cards fill the box and start nothing: the words
            are the person's to change, and the chat needs a name first. */}
        {extensionMode && !terminalUnavailable ? (
          <section aria-label="Extension ideas" className="mt-6">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="m-0 text-meta font-medium text-[color:var(--text-subtle)]">Start from an idea</h2>
              <LinkButton ink="quiet" onClick={() => setAllIdeas((current) => !current)}>
                {allIdeas ? 'Show fewer' : `Show all ${EXTENSION_IDEAS.length}`}
              </LinkButton>
            </div>
            <div className="grid grid-cols-1 gap-2 @[520px]:grid-cols-2">
              {(allIdeas ? EXTENSION_IDEAS : EXTENSION_IDEAS.slice(0, EXTENSION_IDEAS_FIRST)).map((idea) => (
                <ExtensionIdeaCard key={idea.id} idea={idea} onPick={() => pickIdea(idea)} />
              ))}
            </div>
          </section>
        ) : null}
        {editing && scheduled && onOpenScheduledRun ? (
          <ScheduledRuns runs={scheduledRuns} onOpen={onOpenScheduledRun} />
        ) : null}
        {/* The cards are for an empty box: each starts its own prompt, so
            beside words or attachments of the person's one would throw the
            words away and send the attachments with a stranger's text. */}
        {terminalUnavailable || isTerminalLaunch || scheduled || extensionMode || boxHasContent ? null : (
          <div className="mt-6 grid grid-cols-1 gap-2 @[520px]:grid-cols-2">
            {suggestions.map((entry) => (
              <SuggestionCard
                key={entry.id}
                entry={entry}
                disabled={!canLaunch}
                onLaunch={() => launch(entry.prompt)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// An image staged on the prompt: the chat composer's attachment shape (so the
// shared strip renders it) plus the file path that stands in for it once the
// prompt becomes text.
type PromptImage = NewChatDraftImage
