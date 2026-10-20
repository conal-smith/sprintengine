import React, { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { Workspace, WorkspaceId, WorkspaceWindowId } from '../../types/workspace'
import type { BuiltinSkill, WorkspaceSkill } from '../../../../shared/electron-api'
import { togglePanelRailComponent } from '../../utils/modelRegistry'
import { openFileSurface } from '../../utils/openFileSurface'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { getEffectiveKeybindingLabel, platformKeybindingsFromApiPlatform } from '../../commands/effectiveKeybindings'
import { isCommandEnabled, isCommandIdEnabled, type CommandAvailabilityContext } from '../../commands/availability'
import type { CommandScope, ModuleCommandContext } from '../../commands/types'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import {
  clampPaletteSelection,
  commandMatchesQuery,
  composeRestingPage,
  groupInScope,
  orderPaletteCommands,
  PALETTE_SCOPE_ORDER,
  stepPaletteSelection,
  workspaceSearchKeywords,
  workspaceSwitchRowId,
  type PaletteCommandGroup,
  type PaletteScope,
} from '../commandPaletteSearch'
import {
  usePaletteProviders,
  type PaletteCommand,
  type PaletteProviderContext,
  type PaletteResultProvider,
  type PaletteRowMark,
} from '../palette/paletteProvider'
import {
  createExtensionsProvider,
  EXTENSION_ROWS_PER_GROUP,
  PALETTE_ROW_ICON_SIZE,
  type ExtensionPluginRow,
  type ExtensionSkillRow,
  type ExtensionSourceRow,
} from '../palette/extensionsProvider'
import { createConversationHistoryProvider } from '../palette/conversationHistoryProvider'
import {
  chatBranch,
  chatPullRequestBadge,
  chatSearchKeywords,
  mergeChatPullRequests,
  sameChatPullRequests,
} from '../palette/chatSearchTerms'
import { useConversationPullRequests } from '../workspace/useConversationPullRequests'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { createBuildExtensionPaletteProvider } from '../extensions/buildExtensionPaletteProvider'
import {
  decidePaletteTarget,
  handSkillToAgent,
  installPluginRow,
  installSkillRow,
  planPluginRow,
  type ExtensionActionOutcome,
  type ResolvedSkillOutcome,
} from '../palette/extensionsActions'
import type { PaletteAgentTarget } from '../palette/paletteOpenRequest'
import {
  listLiveAgentSessions,
  resolveWorkspaceSkill,
  NO_LIVE_AGENT_MESSAGE,
  NO_WORKSPACE_FOLDER_MESSAGE,
  type LiveAgentSession,
} from '../../utils/useSkillInAgent'
import { requestTerminalFocus, type TerminalFocusTarget } from '../../utils/terminalFocusRequest'
import { acquireTerminalRepaintPause } from '../../utils/terminalRepaintPause'
import { isLiveTerminal, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { GeneralSettingsIcon, NewChatIcon, RemoteMachineGlyph, WorkspaceTypeIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { getExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import { dispatchExtensionsSurfaceTarget } from '../workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { showToast } from '../../store/toastStore'
import { dispatchPanelCommandEvent } from '../../utils/panelCommands'
import { useScheduledAgents, useScheduledAgentsPause } from '../../store/scheduledAgentsStore'
import {
  pauseAllScheduledAgents,
  resumeAllScheduledAgents,
  setScheduledAgentPaused,
} from '../../utils/scheduledAgentsPause'
import { scheduledAgentPaletteCommands } from '../palette/scheduledAgentsCommands'
import { WorkingMark } from './WorkingMark'
import { ExtensionIcon } from './ExtensionIcon'
import { FileTypeGlyph } from './FileTypeGlyph'
import { TruncatedText } from './index'
import { FocusTrap } from './FocusTrap'
import { KbdChord } from './KbdChord'
import { Tabs, type TabItem } from './Tabs'
import {
  INSTALLED_SKILLS_RESULTS_ID,
  InstalledSkillsPanel,
  type InstalledSkillsPanelHandle,
} from '../palette/InstalledSkillsPanel'
import { OVERLAY_SHELL_CHROME_CLASS, overlayWidthStyle } from './tokens'
import { isImeKey } from '../../utils/imeKey'

// The four canonical source groups the global-search palette organizes results
// into (T6), plus the two disk-backed groups: Files (name matches, plus the
// active workspace's open editors) and Text in files (content matches). The
// order here is the vertical order in the list and therefore the order the
// arrow keys traverse. "Agents & workspaces" folds in the workspace-filtering
// the sidebar "Search workspaces" box used to own.
type CommandGroup = PaletteCommandGroup

const PALETTE_GROUP_LABELS: Record<CommandGroup, string> = {
  agents: 'Conversations',
  skills: 'Skills',
  // Everything a source offers that is not a bare skill: the plugins its
  // marketplace lists, and the first-party registry's entries.
  extensions: 'Plugins',
  commands: 'Commands',
  actions: 'Actions',
  files: 'Files',
  content: 'Text in files',
}

/**
 * The tab strip across the top of the shell: the launcher, then the four
 * questions it can be narrowed to (owner ruling 2026-09-10). The order is
 * `PALETTE_SCOPE_ORDER`'s; the words are
 * here because they are display copy.
 */
const PALETTE_SCOPE_LABELS: Record<PaletteScope, string> = {
  all: 'All',
  skills: 'Skills',
  conversations: 'Conversations',
  files: 'Files',
  text: 'Text',
  actions: 'Actions',
}

const PALETTE_SCOPE_TABS: TabItem<PaletteScope>[] = PALETTE_SCOPE_ORDER.map((scope) => ({
  id: scope,
  label: PALETTE_SCOPE_LABELS[scope],
}))

/** The one sentence the input asks for, per scope. */
const PALETTE_PLACEHOLDER: Record<PaletteScope, string> = {
  all: 'Search chats, skills, plugins, files, text, actions…',
  skills: 'Filter installed skills…',
  conversations: 'Search chats and workspaces by title or folder…',
  files: 'Search file names…',
  text: 'Search text in files…',
  actions: 'Search commands and actions…',
}

const PALETTE_INPUT_LABEL: Record<PaletteScope, string> = {
  all: 'Search chats, skills, plugins, files, text in files, and actions',
  skills: 'Filter installed skills for this agent CLI',
  conversations: 'Search chats and workspaces by title or folder',
  files: 'Search file names',
  text: 'Search text in files',
  actions: 'Search commands and actions',
}

// With no query, each group shows a short preview rather than its full contents,
// so the first frame stays calm and scannable instead of dumping every command.
const PREVIEW_PER_GROUP = 6

// Disk search is a subprocess per keystroke, so it waits for a pause the
// in-memory command filter does not need. 180ms is under the ~200ms that reads
// as lag while still collapsing a burst of typing into one ripgrep run.
const DISK_SEARCH_DEBOUNCE_MS = 180
// A single character matches most of a repo, and the cost is paid in the main
// process. File names stay cheap enough to match from the first character;
// content search — which reads every file's bytes — waits for a second.
const CONTENT_SEARCH_MIN_QUERY = 2
const PALETTE_FILE_SEARCH_LIMIT = 50
const PALETTE_CONTENT_SEARCH_LIMIT = 100

// The project a new chat lands in, said the way the sidebar says it: the
// folder's own name, not its path.
function folderDisplayName(folderPath: string): string {
  const trimmed = folderPath.replace(/[\\/]+$/u, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || trimmed
}

// The disk provider is memoized on the open-file list, and a fresh `[]` every
// render would rebuild it every render — which, since the runner re-runs a
// provider whose identity changed, would restart ripgrep on every render.
const EMPTY_OPEN_FILES: NonNullable<Workspace['editorState']>['openFiles'] = []

// Results are labelled by their path inside the workspace: an absolute path
// repeats the workspace root on every row and pushes the part that identifies
// the file off the end of the line.
function workspaceRelativePath(rootPath: string, filePath: string): string {
  const root = rootPath.replace(/[\\/]+$/u, '')
  if (!filePath.toLowerCase().startsWith(root.toLowerCase())) return filePath
  return filePath.slice(root.length).replace(/^[\\/]+/u, '')
}

// The row shape is `PaletteCommand` (components/palette/paletteProvider.ts):
// it is what the providers produce, so it cannot be private to this file any
// more. `keywords` is still extra match text that is searched but never
// displayed — a workspace switch row matches on its type label and curated
// search terms ("schedule", "cron") the way the retired sidebar search did,
// without crowding those terms into the visible description.
type Command = PaletteCommand

// A command shape before its source group is stamped on — used by the
// panel/registry sub-lists that are all one group, so the group is applied once
// where they are composed instead of repeated on every literal.
type UngroupedCommand = Omit<Command, 'group'>

interface Props {
  onClose: () => void
  /**
   * The shell's own command runner, for the actions that are shell commands
   * (New chat opens the pre-creation panel; Open settings). Returns whether
   * the shell took it, like `runCommand`.
   */
  onRunCommand: (commandId: string) => boolean
  /** Settings, opened on the Remote tab: the machines this one is paired with. */
  onOpenRemoteConnections: () => void
  workspaceWindowId: WorkspaceWindowId
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  // The active command scopes and runtime availability that the keyboard
  // dispatcher uses, supplied by WorkspaceManager so the palette offers a panel
  // command only when the shortcut path would also run it.
  activeScopes: readonly CommandScope[]
  commandAvailability: CommandAvailabilityContext
  // The published context view module availability predicates evaluate
  // against — same object the dispatcher uses, so both stay in agreement.
  moduleCommandContext: ModuleCommandContext
  // Which tab the palette opens on. ⌘K and Shift Shift open `all`; ⌘⇧F opens
  // `files`; the terminal's star opens `skills`. Absent behaves as `all`, so
  // existing call sites are unchanged.
  initialScope?: PaletteScope
  /**
   * The agent a chosen skill lands in without asking — the pane the palette was
   * opened FOR. The terminal star passes its own session, which is what turns
   * "find a skill, install it, use it here" into one keystroke and one Enter.
   * Absent means the palette works the target out (the focused agent, the only
   * live agent, or a question).
   */
  preferredTarget?: PaletteAgentTarget | null
}

export default function CommandPalette({
  onClose,
  onRunCommand,
  onOpenRemoteConnections,
  workspaceWindowId,
  workspaces,
  activeWorkspaceId,
  activeScopes,
  commandAvailability,
  moduleCommandContext,
  initialScope = 'all',
  preferredTarget = null,
}: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [scope, setScope] = useState<PaletteScope>(initialScope)
  const inputRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const selectedRowRef = useRef<HTMLDivElement>(null)
  // Choosing a tab — from the strip, or from a row that IS a tab — narrows
  // in place and hands the caret back to the field.
  const selectScope = (next: PaletteScope) => {
    setScope(next)
    setSelected(0)
    inputRef.current?.focus()
  }
  useEffect(() => {
    inputRef.current?.focus()
  }, [scope])
  // The Skills tab lists the installed inventory under the same field: the
  // panel takes the field's arrows and Enter first and names its active row.
  const skillsPanelRef = useRef<InstalledSkillsPanelHandle>(null)
  const [skillsActiveOptionId, setSkillsActiveOptionId] = useState<string | undefined>(undefined)
  // One selector per action, never the whole store: destructuring
  // `useWorkspaceStore()` subscribed the open palette to every store write.
  const setActiveWorkspaceForWindow = useWorkspaceStore((state) => state.setActiveWorkspaceForWindow)
  const setActiveFile = useWorkspaceStore((state) => state.setActiveFile)
  const openExtensionsSurface = useWorkspaceStore((state) => state.openExtensionsSurface)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const moduleEnablement = useWorkspaceStore((state) => state.appSettings.modules)
  const usageLimitsShown = useWorkspaceStore((state) => state.appSettings.appearance.usageLimits)
  // Scheduled agents, for their pause rows: gone with their module.
  const scheduledAgents = useScheduledAgents()
  const scheduledAgentsPause = useScheduledAgentsPause()
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const shortcutFor = (commandId: string): string | undefined =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform) ?? undefined
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const openFiles = activeWorkspace?.editorState?.openFiles ?? EMPTY_OPEN_FILES
  const activeFolderPath = activeWorkspace?.folderPath ?? null

  // The workspace's own skills. Built-in skills are global and always listed;
  // installed skill packs are workspace-scoped, so they load only when a
  // workspace is open. Loading is best-effort: a failed list leaves the Skills
  // group thinner rather than breaking the palette.
  //
  // They are held here rather than inside a provider because TWO providers read
  // them — the installed-skills provider lists them, and the extensions
  // provider needs them to know which of a source's skills you already have.
  const [builtinSkills, setBuiltinSkills] = useState<BuiltinSkill[]>([])
  const [installedSkills, setInstalledSkills] = useState<WorkspaceSkill[]>([])

  useEffect(() => {
    let cancelled = false
    void window.api
      .builtinSkillsList()
      .then((skills) => {
        if (!cancelled) setBuiltinSkills(skills)
      })
      .catch(() => {
        if (!cancelled) setBuiltinSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!activeFolderPath) {
      setInstalledSkills([])
      return
    }
    let cancelled = false
    void window.api
      .workspaceSkillsList({ workspaceRoot: activeFolderPath })
      .then((result) => {
        if (cancelled) return
        // Only what the workspace actually holds, and only what the bundled
        // list above does not already carry: a builtin listed twice would be
        // two palette rows running the same skill.
        setInstalledSkills(
          result.ok
            ? result.skills.filter((skill) => skill.installState !== 'available' && skill.source !== 'builtin')
            : [],
        )
      })
      .catch(() => {
        if (!cancelled) setInstalledSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [activeFolderPath])

  // The terminal an invocation was just parked in, when one was. Set right
  // before the palette closes over a successful paste, and read by the
  // focus-restore cleanup below: the whole point of the round trip is that the
  // person's next keystroke is Enter at THAT prompt, and "whatever opened the
  // palette" is the star button, or a sidebar, or a Monaco editor — not it.
  const focusAfterCloseRef = useRef<TerminalFocusTarget | null>(null)

  // Initial focus into the input, and focus back to whatever opened the palette
  // when it closes — the same open/close contract `Modal` carries, so dismissing
  // the palette leaves the keyboard where it started. Its own effect,
  // with no dependencies: a re-created `onClose` must not re-run focus and pull
  // the caret out of the input mid-search.
  useEffect(() => {
    const opener = openerRef.current
    inputRef.current?.focus()
    return () => {
      // The pane that took the paste, when a pane is still mounted to answer;
      // otherwise the opener, as before. `requestTerminalFocus` is synchronous
      // and says whether anyone took it, so there is no guessing here.
      const pasted = focusAfterCloseRef.current
      if (pasted && requestTerminalFocus(pasted)) return
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // While the palette covers the app, terminal panes stop writing — the same
  // hold `Modal` takes, for the same reason: a streaming pane under an overlay
  // re-invalidates the covered region on every PTY chunk. It matters twice
  // here. The shell is GLASS (owner ruling 2026-09-10): its ground samples what
  // is behind it, and a backdrop over a pane that repaints thirty times a
  // second would re-blur thirty times a second — which is what the 2026-09-01
  // measurement at ~10fps was. With the panes paused for the palette's lifetime
  // the blur is computed once and sits still, and the area is the shell's, not
  // the scrim's. `isAlive` is the self-heal: a hold whose dialog has left the
  // document is reclaimed by the store's watchdog.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      acquireTerminalRepaintPause({
        label: 'CommandPalette',
        isAlive: () => dialogRef.current?.isConnected === true,
      }),
    [],
  )

  // Escape steps OUT of the "which agent" question before it closes the
  // palette: the question replaced the result list, and the way back to that
  // list must not be "reopen the palette and search again". Read through a ref
  // so the listener is not re-bound on every state change.
  const agentChoiceOpenRef = useRef(false)
  const dismissAgentChoiceRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A child surface (menu, popover) that already handled Escape marks the
      // event; the palette must not also close — same guard Modal carries.
      if (event.defaultPrevented) return
      if (event.key !== 'Escape') return
      if (agentChoiceOpenRef.current) {
        event.preventDefault()
        dismissAgentChoiceRef.current()
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const terminalSessions = useTerminalSessions()
  // The pull requests each chat holds, from where the sidebar reads them: the
  // conversation's record, asked once as the palette opens and again only when
  // the server says one moved, and the marks its sessions carry. They are
  // what a chat is found by when someone types `#482` or pastes the URL
  // (`chatSearchTerms.ts`). A chat keeps its previous list while it searches
  // the same, so a session snapshot that moved nothing here rebuilds no row.
  const workspaceIds = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces])
  const recordedPullRequests = useConversationPullRequests(workspaceIds)
  const chatPullRequestsRef = useRef<ReadonlyMap<string, readonly BranchPullRequest[]>>(new Map())
  const chatPullRequests = useMemo(() => {
    const live = new Map<string, (readonly BranchPullRequest[] | undefined)[]>()
    for (const session of terminalSessions) {
      if (!session.workspaceId || !session.pullRequests?.length) continue
      const lists = live.get(session.workspaceId)
      if (lists) lists.push(session.pullRequests)
      else live.set(session.workspaceId, [session.pullRequests])
    }
    const previous = chatPullRequestsRef.current
    const next = new Map<string, readonly BranchPullRequest[]>()
    let changed = false
    for (const workspace of workspaces) {
      const merged = mergeChatPullRequests(recordedPullRequests[workspace.id], live.get(workspace.id) ?? [])
      if (merged.length === 0) continue
      const before = previous.get(workspace.id)
      if (before && sameChatPullRequests(before, merged)) next.set(workspace.id, before)
      else {
        next.set(workspace.id, merged)
        changed = true
      }
    }
    if (!changed && next.size === previous.size) return previous
    chatPullRequestsRef.current = next
    return next
  }, [workspaces, recordedPullRequests, terminalSessions])

  const commands = useMemo((): Command[] => {
    // A panel command is offered only when its scope is active and its runtime
    // preconditions are met — the exact predicate the keyboard dispatcher
    // applies. Rows that fail are dropped rather than left to silently no-op, so
    // the palette and the shortcut path always agree on availability. The panel
    // that owns the command still performs the final precondition check and
    // surfaces a real diagnostic if state changed between open and run.
    const panelCommandEnabled = (id: string): boolean => isCommandIdEnabled(id, activeScopes, commandAvailability)
    // Git refresh/fetch/commit run the Git panel's real handlers; the shared
    // availability context (gitPanelActive) keeps them listed only while the Git
    // panel is open, so a selection cannot land on an unmounted handler. They are
    // targeted at the active workspace so commit never fires in a background repo.
    const runGitPanel = (id: string) => () => {
      dispatchPanelCommandEvent(id, activeWorkspaceId ?? undefined)
      onClose()
    }
    const gitCommands: UngroupedCommand[] = [
      {
        id: 'git.refresh',
        label: 'Git: Refresh status',
        shortcut: shortcutFor('git.refresh'),
        run: runGitPanel('git.refresh'),
      },
      {
        id: 'git.fetch',
        label: 'Git: Fetch remotes',
        shortcut: shortcutFor('git.fetch'),
        run: runGitPanel('git.fetch'),
      },
      {
        id: 'git.commit',
        label: 'Git: Commit staged changes',
        shortcut: shortcutFor('git.commit'),
        run: runGitPanel('git.commit'),
      },
      {
        id: 'git.changes.showDiff',
        label: 'Git: Show diff for the selected file',
        shortcut: shortcutFor('git.changes.showDiff'),
        run: runGitPanel('git.changes.showDiff'),
      },
      {
        id: 'git.changes.discard',
        label: 'Git: Discard changes in the selected files',
        shortcut: shortcutFor('git.changes.discard'),
        run: runGitPanel('git.changes.discard'),
      },
      {
        id: 'git.changes.moveToChangelist',
        label: 'Git: Move the selected files to another changelist',
        shortcut: shortcutFor('git.changes.moveToChangelist'),
        run: runGitPanel('git.changes.moveToChangelist'),
      },
    ].filter((command) => panelCommandEnabled(command.id))
    const panelToggleCommands: UngroupedCommand[] = activeWorkspace
      ? [
          {
            id: 'panel.files.toggle',
            label: 'Toggle file explorer',
            searchLabel: 'File Explorer',
            shortcut: shortcutFor('panel.files.toggle'),
            run: () => {
              // Files is a workspace-pane tab (browser-pane epic).
              useWorkspaceStore.getState().togglePaneKind(activeWorkspace.id, 'files')
              onClose()
            },
          },
          {
            id: 'panel.editor.toggle',
            label: 'Toggle code editor',
            searchLabel: 'Code Editor',
            shortcut: shortcutFor('panel.editor.toggle'),
            run: () => {
              togglePanelRailComponent(activeWorkspace.id, 'editor', 'Editor')
              onClose()
            },
          },
          {
            id: 'panel.git.toggle',
            label: 'Toggle Git panel',
            searchLabel: 'Git Panel',
            shortcut: shortcutFor('panel.git.toggle'),
            run: () => {
              useWorkspaceStore.getState().togglePaneKind(activeWorkspace.id, 'git')
              onClose()
            },
          },
          // The agents the focused chat sent off to work: running, finished,
          // and each one's own steps.
          ...(panelCommandEnabled('panel.agents.toggle')
            ? [
                {
                  id: 'panel.agents.toggle',
                  label: 'Toggle agents',
                  searchLabel: 'Agents',
                  shortcut: shortcutFor('panel.agents.toggle'),
                  run: () => {
                    onRunCommand('panel.agents.toggle')
                    onClose()
                  },
                },
              ]
            : []),
          // Canvas has no rail glyph either, so this row and the pane's "+"
          // menu are its entry points. Availability-gated the same way, and run
          // through the shell rather than `togglePaneKind` directly: the
          // command's handler also widens the pane for a tab the person has
          // just created, and the editor falls back to its phone layout in a
          // pane narrower than 730px. A row that toggled the tab itself would
          // quietly drop that.
          ...(panelCommandEnabled('panel.canvas.toggle')
            ? [
                {
                  id: 'panel.canvas.toggle',
                  label: 'Toggle canvas',
                  searchLabel: 'Canvas',
                  shortcut: shortcutFor('panel.canvas.toggle'),
                  run: () => {
                    onRunCommand('panel.canvas.toggle')
                    onClose()
                  },
                },
              ]
            : []),
          // The Knowledge Graph has no rail glyph, so this row (and the View
          // menu) is its entry point. Availability-gated like the panel
          // commands: hidden while the memory-graph module is disabled.
          ...(panelCommandEnabled('panel.knowledge-graph.toggle')
            ? [
                {
                  id: 'panel.knowledge-graph.toggle',
                  label: 'Toggle knowledge graph',
                  searchLabel: 'Knowledge Graph',
                  shortcut: shortcutFor('panel.knowledge-graph.toggle'),
                  run: () => {
                    togglePanelRailComponent(activeWorkspace.id, 'memory-graph', 'Knowledge Graph')
                    onClose()
                  },
                },
              ]
            : []),
        ]
      : []
    // Commands contributed by enabled capability modules, gated by the same
    // scope + availability predicate as built-in panel commands. Rows label as
    // "<category>: <title>" so a module's commands read like the built-in
    // groups; the handler is the module's own callback.
    const moduleCommands: UngroupedCommand[] = getRendererHost()
      .getModuleCommands((moduleId) => selectModuleEnabled(moduleEnablement, moduleId))
      .filter((moduleCommand) =>
        isCommandEnabled(moduleCommand, activeScopes, commandAvailability, moduleCommandContext),
      )
      .map((moduleCommand) => ({
        id: moduleCommand.id,
        label: `${moduleCommand.category}: ${moduleCommand.title}`,
        shortcut:
          getEffectiveKeybindingLabel(moduleCommand.id, keybindingSettings, keybindingPlatform, moduleCommand) ??
          undefined,
        run: () => {
          void moduleCommand.run(moduleCommandContext)
          onClose()
        },
      }))

    // Registry- and panel-backed commands are all one source group; stamp it
    // once here rather than on every literal above.
    // The usage dashboard, always; and the subscription usage limits as a
    // dialog, the one place to read them with no Claude or Codex chat open,
    // gone with the setting that hides them.
    const usageCommands: UngroupedCommand[] = [
      {
        id: 'usage.show',
        label: 'Show usage',
        keywords: 'cost tokens spend dashboard metrics statistics claude codex opencode gemini grok cursor',
        shortcut: shortcutFor('usage.show'),
        run: () => {
          onRunCommand('usage.show')
          onClose()
        },
      },
      ...(usageLimitsShown
        ? [
            {
              id: 'usage.limits.show',
              label: 'Show usage limits',
              keywords: 'subscription plan limit five-hour weekly claude codex',
              shortcut: shortcutFor('usage.limits.show'),
              run: () => {
                onRunCommand('usage.limits.show')
                onClose()
              },
            },
          ]
        : []),
    ]

    // Pause every scheduled agent for a while, or one of them; or resume.
    const scheduledAgentCommands: UngroupedCommand[] = selectModuleEnabled(moduleEnablement, 'scheduled-agents')
      ? scheduledAgentPaletteCommands(scheduledAgents, scheduledAgentsPause, Date.now(), {
          pauseAll: (choice) => {
            void pauseAllScheduledAgents(choice)
            onClose()
          },
          resumeAll: () => {
            void resumeAllScheduledAgents()
            onClose()
          },
          setPaused: (agent, paused) => {
            void setScheduledAgentPaused(agent, paused)
            onClose()
          },
        })
      : []

    const registryCommands: Command[] = [
      ...panelToggleCommands,
      ...gitCommands,
      ...usageCommands,
      ...moduleCommands,
      ...scheduledAgentCommands,
    ].map((command) => ({
      ...command,
      group: 'commands' as const,
    }))

    // Skills are a provider now (see below): they are one of three sources that
    // fetch, and the group also carries every skill the configured SOURCES hold.

    return [
      // Agents & workspaces — the switch targets that absorb the sidebar's
      // former "Search workspaces" box. Rail-hidden workspaces are never a switch
      // target: the palette mirrors the rail/hotkey navigation surfaces exactly,
      // so any module's own hidden workspaces stay out. Those are found on the owning door, which lists them across
      // every project — including the historical ones no workspace holds. The
      // folder path rides `description` so typing a path filters here too,
      // preserving the sidebar's path matching.
      ...workspaces
        .filter((workspace) => !isHiddenFromRail(workspace, moduleEnablement))
        .map((workspace): Command => ({
          id: workspaceSwitchRowId(workspace.id),
          // The chat's own title, the way the sidebar lists it: the group
          // heading already says these are conversations, and a "Switch to:"
          // in front of every one of them was the verb said eight times.
          // "switch" still finds them, through the keywords.
          label: workspace.name,
          description: workspace.folderPath ?? (workspace.id === activeWorkspaceId ? 'active workspace' : undefined),
          // Its pull requests and branch ride the keywords: found by `#482`
          // or the branch name, never printed under the title.
          keywords: `switch to ${workspaceSearchKeywords(workspace.mode)} ${chatSearchKeywords(
            chatPullRequests.get(workspace.id) ?? [],
            chatBranch(workspace),
          )}`.trimEnd(),
          mark: { kind: 'chat', workspaceId: workspace.id, mode: workspace.mode },
          group: 'agents',
          run: () => {
            setActiveWorkspaceForWindow(workspaceWindowId, workspace.id)
            onClose()
          },
        })),
      ...registryCommands,
      // Actions — the five verbs the launcher opens on (owner rulings
      // 2026-09-11): start a chat, find a file, search the project's text,
      // open settings, open the remote connections. The agent spawn rows
      // went with the same ruling; the spawn menu and its chords still own
      // them. "New chat" opens the pre-creation panel — the one way to start —
      // never a workspace on the spot.
      {
        id: 'chat.new',
        label: activeFolderPath ? `New chat in ${folderDisplayName(activeFolderPath)}` : 'New chat',
        searchLabel: 'New chat',
        shortcut: shortcutFor('chat.new'),
        mark: { kind: 'new-chat' as const },
        group: 'actions' as const,
        run: () => {
          onRunCommand('chat.new')
          onClose()
        },
      },
      ...(activeWorkspace
        ? [
            // The two rows that do not close the palette: each IS a tab, so
            // choosing it narrows in place and leaves the caret where the
            // query is about to be typed.
            {
              id: 'go-to-file',
              label: 'Go to file',
              shortcut: shortcutFor('search.goToFile'),
              mark: { kind: 'go-to-file' as const },
              group: 'actions' as const,
              run: () => selectScope('files'),
            },
            {
              id: 'search.files.open',
              label: 'Search project contents',
              shortcut: shortcutFor('search.files.open'),
              mark: { kind: 'search' as const },
              group: 'actions' as const,
              run: () => selectScope('text'),
            },
          ]
        : []),
      {
        id: 'app.settings.open',
        label: 'Open settings',
        shortcut: shortcutFor('app.settings.open'),
        mark: { kind: 'settings' as const },
        group: 'actions' as const,
        run: () => {
          onRunCommand('app.settings.open')
          onClose()
        },
      },
      {
        id: 'app.settings.remote',
        label: 'Open remote connections',
        mark: { kind: 'remote' as const },
        group: 'actions' as const,
        run: () => {
          onOpenRemoteConnections()
          onClose()
        },
      },
      ...(activeWorkspace
        ? [
            {
              id: 'git.worktrees.open',
              label: 'Git: Manage Worktrees',
              description: activeWorkspace.folderPath ?? 'Open the Git panel',
              shortcut: shortcutFor('git.worktrees.open'),
              group: 'commands' as const,
              run: () => {
                useWorkspaceStore.getState().openPaneTab(activeWorkspace.id, { kind: 'git' })
                onClose()
              },
            },
          ]
        : []),
      // Files — the active workspace's open editors.
      ...(activeWorkspaceId
        ? openFiles.map((file): Command => ({
            id: `file-${file.path}`,
            label: file.name,
            description: file.path,
            file: file.name,
            group: 'files',
            run: () => {
              setActiveFile(activeWorkspaceId, file.path)
              openFileSurface({ workspaceId: activeWorkspaceId, path: file.path, name: file.name })
              onClose()
            },
          }))
        : []),
    ]
  }, [
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    activeFolderPath,
    openFiles,
    setActiveWorkspaceForWindow,
    setActiveFile,
    onClose,
    onRunCommand,
    onOpenRemoteConnections,
    workspaceWindowId,
    keybindingPlatform,
    keybindingSettings,
    activeScopes,
    commandAvailability,
    moduleCommandContext,
    moduleEnablement,
    usageLimitsShown,
    chatPullRequests,
    scheduledAgents,
    scheduledAgentsPause,
  ])

  // ── Handing a result to an agent ────────────────────────────────────────
  //
  // Every skill row in this palette — one the workspace has, one a source
  // holds, one a plugin ships — ends in the same place: written where the
  // agent's CLI reads skills, with that CLI's own invocation parked at its
  // prompt, unsubmitted. What differs is only how the skill comes to exist,
  // which is what `prepare` carries.

  // The pane the person was last looking at in this workspace, so a workspace
  // with several agents still answers without a question.
  const focusedAgentId = useWorkspaceStore((state) =>
    state.activeWorkspaceId ? state.focusedAgentByWorkspaceId[state.activeWorkspaceId] : undefined,
  )
  const clis = useWorkspaceStore((state) => state.pluginCatalogEntries)

  // The second step, when there IS a question: which agent. It replaces the
  // result list rather than opening a menu over it — the palette is already a
  // keyboard surface with a selection, and a popover inside it would be a
  // second one to arrow around.
  const [agentChoice, setAgentChoice] = useState<{ title: string; options: Command[] } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  // The guard is a ref, not the state: the flow awaits the session list before
  // it sets anything, so two Enters inside that wait would both read `false`
  // from their own render closure and both run the whole trip — two installs
  // and two invocations parked at the agent — the same hole the door's menu
  // had, review 2026-09-10. The state still drives what the surface SAYS.
  const actionBusyRef = useRef(false)

  const runSkillFlow = async (skillName: string, prepare: () => Promise<ResolvedSkillOutcome>) => {
    if (actionBusyRef.current) return
    if (!activeFolderPath) {
      setActionError(NO_WORKSPACE_FOLDER_MESSAGE)
      return
    }
    const workspaceRoot = activeFolderPath
    const settle = (session: LiveAgentSession, outcome: ExtensionActionOutcome) => {
      actionBusyRef.current = false
      setActionBusy(false)
      if (!outcome.ok) {
        setActionError(outcome.message)
        return
      }
      // grok and opencode declare that they re-read their skills directory only
      // on restart, and nothing used to say so.
      if (outcome.toast) showToast(outcome.toast)
      // The invocation is at that agent's prompt, unsubmitted; the keyboard
      // goes there with it (see the focus-restore effect).
      focusAfterCloseRef.current =
        session.workspaceId && session.agentId ? { workspaceId: session.workspaceId, agentId: session.agentId } : null
      onClose()
    }
    const useIn = async (session: LiveAgentSession) => {
      if (actionBusyRef.current) return
      actionBusyRef.current = true
      setActionBusy(true)
      setActionError(null)
      const prepared = await prepare()
      if (!prepared.ok) {
        actionBusyRef.current = false
        setActionBusy(false)
        setActionError(prepared.message)
        return
      }
      settle(session, await handSkillToAgent({ workspaceRoot, skill: prepared.skill, session, clis }))
    }

    const sessions = await listLiveAgentSessions({ workspaceId: activeWorkspaceId })
    // The pane the palette was opened for wins while it is live and is never
    // replaced by a guess once it is not; with no pane named, the focused
    // agent, then one live agent — see `decidePaletteTarget` for the ruling.
    const decision = decidePaletteTarget(sessions, preferredTarget, focusedAgentId)
    if (decision.kind === 'use') {
      await useIn(decision.session)
      return
    }

    // "New agent…" is the shell's route, read from the door's host seam at
    // click time the way every other host action is — and offered only when a
    // shell is mounted to take it.
    const host = getExtensionsSurfaceHost()
    const options: Command[] = sessions.map((session): Command => ({
      id: `palette-agent-${session.sessionId}`,
      label: session.label,
      description: session.cli,
      group: 'agents',
      run: () => void useIn(session),
    }))
    if (host) {
      options.push({
        id: 'palette-agent-new',
        label: 'New agent…',
        description: `Start an agent with ${skillName} attached`,
        group: 'agents',
        run: () => {
          void (async () => {
            if (actionBusyRef.current) return
            actionBusyRef.current = true
            setActionBusy(true)
            setActionError(null)
            const prepared = await prepare()
            actionBusyRef.current = false
            setActionBusy(false)
            if (!prepared.ok) {
              setActionError(prepared.message)
              return
            }
            getExtensionsSurfaceHost()?.onUseSkillInNewAgent(prepared.skill)
            onClose()
          })()
        },
      })
    }
    if (options.length === 0) {
      setActionError(decision.notice ?? NO_LIVE_AGENT_MESSAGE)
      return
    }
    setActionError(decision.notice)
    setAgentChoice({ title: `Use ${skillName} in…`, options })
    setSelected(0)
  }
  agentChoiceOpenRef.current = agentChoice !== null
  dismissAgentChoiceRef.current = () => {
    setAgentChoice(null)
    setActionError(null)
    setSelected(0)
  }

  // A skill the workspace already has: nothing to install, just resolve it.
  const useInstalledSkill = (skillId: string, skillName: string) =>
    runSkillFlow(skillName, () => resolveWorkspaceSkill({ workspaceRoot: activeFolderPath, skillId }))

  // A skill a source holds: installed first when it is not in yet.
  const onSelectSkill = (row: ExtensionSkillRow) =>
    runSkillFlow(row.name, () => installSkillRow({ row, workspaceRoot: activeFolderPath }))

  // Open one plugin's detail pane in the Extensions door. The door is opened
  // first and the full target dispatched after, because the store's opener
  // latches a view-only target of its own and the last dispatch wins.
  const deepLinkToPlugin = (row: ExtensionPluginRow) => {
    openExtensionsSurface({ view: 'plugins' })
    dispatchExtensionsSurfaceTarget({
      view: 'plugins',
      pluginId: row.pluginId,
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
    })
    onClose()
  }

  // A source nothing has read yet: the read happens in the door, on purpose,
  // not as a side effect of a palette warm — so the row opens that source's
  // tab, where opening it IS the read.
  const onSelectSource = (row: ExtensionSourceRow) => {
    openExtensionsSurface({ view: 'skills' })
    dispatchExtensionsSurfaceTarget({ view: 'skills', sourceId: row.sourceId })
    onClose()
  }

  // A plugin: one press only when the answer is unambiguous AND safe. Hooks,
  // MCP servers, an unread linked repository, several skills or a first-party
  // registry entry all mean a page — see `planPluginRow`, which owns that ruling.
  const onSelectPlugin = (row: ExtensionPluginRow) => {
    const plan = planPluginRow(row)
    if (plan.kind === 'deep-link') {
      deepLinkToPlugin(row)
      return
    }
    return runSkillFlow(row.name, () =>
      installPluginRow({
        row,
        workspaceRoot: activeFolderPath,
        skillDirName: plan.skillDirName,
      }),
    )
  }

  // The providers below are memoized on their DATA, so they must not close over
  // handlers that are re-created every render; the refs are how a stable
  // provider reaches the current handler.
  const useInstalledSkillRef = useRef(useInstalledSkill)
  useInstalledSkillRef.current = useInstalledSkill
  const onSelectSkillRef = useRef(onSelectSkill)
  onSelectSkillRef.current = onSelectSkill
  const onSelectPluginRef = useRef(onSelectPlugin)
  onSelectPluginRef.current = onSelectPlugin
  const onSelectSourceRef = useRef(onSelectSource)
  onSelectSourceRef.current = onSelectSource

  // ── The three fetching sources ──────────────────────────────────────────
  //
  // Disk, installed skills, and every source's catalogue. They are providers
  // (components/palette/paletteProvider.ts) rather than three shapes bolted
  // onto this component: one of them debounces and cancels a subprocess, one
  // filters an array in memory, and one warms once and then filters — and the
  // runner is what knows the difference so this file does not have to.

  // Disk. The palette's Files group used to list only the editors already open,
  // so the launcher could not find a file the user had never opened — let alone
  // a line of text inside one. This is the same ripgrep the "Search in files"
  // panel runs, driven off the palette query.
  //
  // Note the main process keys one active content search per sender (window),
  // so this and an open ContentSearchPanel supersede each other's ripgrep
  // child. Harmless — both re-run on their next keystroke — but it is why the
  // cancel is unconditional rather than tracked per surface.
  const diskProvider = useMemo((): PaletteResultProvider => {
    const openFilePaths = new Set(openFiles.map((file) => file.path))
    return {
      id: 'disk',
      group: 'files',
      // Disk search is a subprocess per keystroke, so it waits for a pause the
      // in-memory filters do not need.
      debounceMs: DISK_SEARCH_DEBOUNCE_MS,
      minQueryLength: 1,
      cancel: () => {
        void window.api.cancelContentSearch().catch(() => {})
      },
      load: async (searchQuery, context): Promise<Command[]> => {
        if (!activeWorkspaceId || !activeFolderPath) return []
        const openOnDisk = (path: string, name: string, lineNumber?: number, column?: number) => {
          void window.api
            .readfile(path)
            .then((content) => {
              openFileSurface({ workspaceId: activeWorkspaceId, path, name, content, lineNumber, column })
            })
            .catch(() => {
              // A file ripgrep listed can be gone by the time it is picked (a
              // branch switch, a build). Opening is best-effort; the palette is
              // closing.
            })
          // Through the context rather than the captured prop: `onClose` is a
          // new function on most renders, and a provider rebuilt for that
          // reason would restart the search it is in the middle of.
          context.close()
        }
        // A single character matches most of a repo, and the cost is paid in
        // the main process. File names stay cheap enough to match from the
        // first character; content search — which reads every file's bytes —
        // waits for a second.
        // Each leg runs only under a tab that shows it: the Files tab never
        // reads every file's bytes for rows it hides, and the Text tab never
        // lists file names.
        const wantsFiles = groupInScope('files', context.scope)
        const wantsContent = groupInScope('content', context.scope) && searchQuery.length >= CONTENT_SEARCH_MIN_QUERY
        const [fileResult, contentResult] = await Promise.all([
          wantsFiles
            ? window.api
                .searchFiles(activeFolderPath, searchQuery, { limit: PALETTE_FILE_SEARCH_LIMIT })
                .catch((error: unknown) => ({ ok: false as const, message: String(error), engine: null }))
            : Promise.resolve(null),
          wantsContent
            ? window.api
                .searchContent(activeFolderPath, searchQuery, { limit: PALETTE_CONTENT_SEARCH_LIMIT })
                .catch((error: unknown) => ({ ok: false as const, message: String(error), engine: null }))
            : Promise.resolve(null),
        ])
        // Only a failure the user would otherwise read as "no matches" is worth
        // surfacing; a cancelled run resolves ok with an empty list.
        const failure =
          fileResult && !fileResult.ok
            ? fileResult.message
            : contentResult && !contentResult.ok
              ? contentResult.message
              : null
        if (failure) throw new Error(failure)
        // Disk results are already matched — ripgrep did the matching in the
        // main process — so they carry no keywords and are never re-filtered
        // against their own line text, which would drop every match whose query
        // spans a word boundary.
        return [
          // A file already open is listed by the in-memory Files rows; listing
          // it again from disk would put the same file in the group twice.
          ...(fileResult?.ok ? fileResult.results : [])
            .filter((entry) => !openFilePaths.has(entry.path))
            .map((entry): Command => ({
              id: `disk-file-${entry.path}`,
              label: entry.name,
              description: workspaceRelativePath(activeFolderPath, entry.path),
              file: entry.name,
              group: 'files',
              run: () => openOnDisk(entry.path, entry.name),
            })),
          ...(contentResult?.ok ? contentResult.results : []).map((entry, index): Command => ({
            // Line and column are part of the id: one file legitimately
            // contributes many rows, and React keys and the selection index
            // both need them apart.
            id: `disk-content-${entry.path}:${entry.lineNumber}:${entry.column}:${index}`,
            // The matched line is the row's identity here — the file path is
            // the supporting detail, which is the inverse of the Files group.
            label: entry.lineText.trim() || entry.matchText,
            description: `${workspaceRelativePath(activeFolderPath, entry.path)}:${entry.lineNumber}`,
            file: entry.name,
            path: workspaceRelativePath(activeFolderPath, entry.path),
            line: entry.lineNumber,
            group: 'content',
            run: () => openOnDisk(entry.path, entry.name, entry.lineNumber, entry.column),
          })),
        ]
      },
    }
  }, [activeFolderPath, activeWorkspaceId, openFiles])

  // The skills the workspace already has: the bundled ones and the packs it
  // installed. Selecting one hands it to a running agent — the same round trip
  // the doors run — instead of the old behaviour, which was to open the
  // Extensions door and leave the person to find the row again.
  const skillsProvider = useMemo((): PaletteResultProvider => {
    const rows: Command[] = [
      ...builtinSkills.map((skill): Command => ({
        id: `skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills',
        // No artwork of its own, so the empty props: `ExtensionIcon` draws the
        // skill's monogram chip, the same letter chip the Skills aside and the
        // composer picker wear for it.
        icon: {},
        badge: 'Built in',
        installed: false,
        run: () => void useInstalledSkillRef.current(skill.id, skill.name),
      })),
      ...installedSkills.map((skill): Command => ({
        id: `installed-skill-${skill.id}`,
        label: skill.name,
        description: skill.description,
        group: 'skills',
        icon: {},
        badge: 'Installed',
        installed: true,
        run: () => void useInstalledSkillRef.current(skill.id, skill.name),
      })),
    ]
    return {
      id: 'installed-skills',
      group: 'skills',
      respondsToEmptyQuery: true,
      load: (searchQuery) =>
        orderPaletteCommands(rows, searchQuery).filter((row) => commandMatchesQuery(row, searchQuery)),
    }
  }, [builtinSkills, installedSkills])

  // Every skill and plugin every configured source holds, from the cached scans
  // the Extensions door reads — plus the first-party registry. This is the one
  // that makes the palette a search for things you have NOT installed.
  const installedDirNames = useMemo(() => new Set(installedSkills.map((skill) => skill.id)), [installedSkills])
  // Constructed once, deliberately: it warms by reading every source's cached
  // scan, and a provider re-created because the inventory landed or the scope
  // chip was popped would throw that warm away and read them all again. The two
  // facts that DO change are read through refs at load time.
  const installedDirNamesRef = useRef(installedDirNames)
  installedDirNamesRef.current = installedDirNames
  // The cap is per group, and it is lifted when the palette is narrowed to
  // skills: the tab IS the person saying they want the whole list.
  const rowLimitRef = useRef(EXTENSION_ROWS_PER_GROUP)
  rowLimitRef.current = scope === 'skills' ? Number.MAX_SAFE_INTEGER : EXTENSION_ROWS_PER_GROUP
  const extensionsProvider = useMemo(
    () =>
      createExtensionsProvider({
        getInstalledDirNames: () => installedDirNamesRef.current,
        getLimit: () => rowLimitRef.current,
        onSelectSkill: (row) => void onSelectSkillRef.current(row),
        onSelectPlugin: (row) => void onSelectPluginRef.current(row),
        onSelectSource: (row) => onSelectSourceRef.current(row),
      }),
    [],
  )

  // Only the providers whose groups the scope admits. A provider whose rows
  // would be filtered out anyway must not RUN: Find-in-Path would otherwise
  // read every source's scan for a list it hides, and the terminal star would
  // start a ripgrep for a snippet nobody asked for.
  //
  // `scope` is a dependency of the ARRAY rather than of any provider in it:
  // popping the chip also lifts or reapplies the per-group cap, and a new array
  // is how the runner is told to ask again. The provider objects are unchanged,
  // so a warm already done is not repeated.
  const conversationHistoryProvider = useMemo(
    () => createConversationHistoryProvider(),
    [activeFolderPath, activeWorkspaceId],
  )
  // "Build your own extension", among the Extensions rows: it opens the New
  // chat door in extension mode.
  const buildExtensionProvider = useMemo(() => createBuildExtensionPaletteProvider(), [])
  const providers = useMemo(() => {
    const active: PaletteResultProvider[] = []
    // Installed inventory owns Skills; catalogue providers run in All only.
    if (scope === 'skills') return active
    if (groupInScope('skills', scope)) active.push(skillsProvider)
    if (groupInScope('extensions', scope)) active.push(extensionsProvider, buildExtensionProvider)
    if (groupInScope('files', scope) || groupInScope('content', scope)) active.push(diskProvider)
    if (groupInScope('agents', scope)) active.push(conversationHistoryProvider)
    return active
  }, [skillsProvider, extensionsProvider, buildExtensionProvider, diskProvider, conversationHistoryProvider, scope])
  const providerContext = useMemo(
    (): PaletteProviderContext => ({
      workspaceRoot: activeFolderPath,
      workspaceId: activeWorkspaceId,
      scope,
      close: onClose,
    }),
    [activeFolderPath, activeWorkspaceId, scope, onClose],
  )
  const provided = usePaletteProviders(providers, query, providerContext)

  // Matches are ranked, then grouped in the order the ranking first mentions
  // each group — so the arrow keys traverse exactly what the eye reads, and a
  // row that scored best is not buried under a group that merely sorts earlier.
  // With no query each group shows a capped preview.
  const filtered = useMemo((): Command[] => {
    const q = query.trim()
    const inScope = (command: Command) => groupInScope(command.group, scope)
    const matched = q ? commands.filter((command) => commandMatchesQuery(command, q)) : commands
    const all = [...matched, ...provided.commands].filter(inScope)
    const ordered = orderPaletteCommands(all, q)
    if (q) return ordered
    const perGroup = new Map<CommandGroup, number>()
    return ordered.filter((command) => {
      const count = (perGroup.get(command.group) ?? 0) + 1
      perGroup.set(command.group, count)
      return count <= PREVIEW_PER_GROUP
    })
  }, [commands, provided.commands, query, scope])

  // Groups appear in the order the RANKING first mentions them, not in a fixed
  // order the ranking then fights: an exact skill-name match puts Skills at the
  // top, and the canonical order (PALETTE_GROUP_ORDER) is only the tie-break
  // inside the scorer. While the palette is asking which agent, the whole list
  // is that one question.
  //
  // At rest — no query, the All tab — the launcher is not a preview of every
  // group but a landing page (owner ruling 2026-09-10): the actions,
  // then the live chats most recently spoken in, in the sidebar's own order.
  // What a person opens ⌘K for without a query is to start something or to
  // get back to something; the other groups are one keystroke or one tab away.
  // The chats with a living process — the ones the resting page lists (owner
  // ruling 2026-09-11: "the recent threads that are still alive"). A parked
  // chat is still found by typing, and still sits in the sidebar.
  const liveWorkspaces = useMemo(() => {
    const alive = new Set<string>()
    for (const session of terminalSessions) {
      if (session.workspaceId && isLiveTerminal(session)) alive.add(session.workspaceId)
    }
    return workspaces.filter((workspace) => alive.has(workspace.id))
  }, [terminalSessions, workspaces])
  // The agent a chat's mark shows: the CLI of its most recent session, the way
  // the sidebar's rows wear the provider mark. A chat nothing has run in yet
  // falls back to its workspace type's icon.
  const cliByWorkspaceId = useMemo(() => {
    const map = new Map<string, { cli: string; at: number; alive: boolean }>()
    for (const session of terminalSessions) {
      if (!session.workspaceId || !session.cli) continue
      const at = session.lastOutputAt ?? session.startedAt
      const current = map.get(session.workspaceId)
      // A living process outranks a parked one; among peers, the latest.
      if (
        !current ||
        (session.processAlive && !current.alive) ||
        (session.processAlive === current.alive && at > current.at)
      ) {
        map.set(session.workspaceId, { cli: session.cli, at, alive: session.processAlive })
      }
    }
    return map
  }, [terminalSessions])

  const restingPage = !query.trim() && scope === 'all' && !agentChoice
  const groupedResults = useMemo((): { key: CommandGroup; label: string; items: Command[] }[] => {
    if (agentChoice) return [{ key: 'agents', label: agentChoice.title, items: agentChoice.options }]
    if (restingPage) {
      const { actions, recent } = composeRestingPage(commands, liveWorkspaces)
      return [
        ...(actions.length > 0 ? [{ key: 'actions' as const, label: 'Actions', items: actions }] : []),
        ...(recent.length > 0 ? [{ key: 'agents' as const, label: 'Recent conversations', items: recent }] : []),
      ]
    }
    const order: CommandGroup[] = []
    const items = new Map<CommandGroup, Command[]>()
    filtered.forEach((command) => {
      const existing = items.get(command.group)
      if (existing) existing.push(command)
      else {
        order.push(command.group)
        items.set(command.group, [command])
      }
    })
    return order.map((key) => ({ key, label: PALETTE_GROUP_LABELS[key], items: items.get(key) ?? [] }))
  }, [filtered, agentChoice, restingPage, commands, liveWorkspaces])

  // The rows on screen, in the order they are drawn — which is what the arrow
  // keys traverse. Grouping compacts the ranked list (a group's rows are drawn
  // together), so the selection index is taken from the grouped order rather
  // than from `filtered`, or the highlight would drift off the row under it.
  const visible = useMemo(() => groupedResults.flatMap((group) => group.items), [groupedResults])

  // The flat selection index for each command, so a row can highlight/scroll
  // without an O(n) indexOf scan per render.
  const flatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    visible.forEach((command, index) => map.set(command.id, index))
    return map
  }, [visible])

  // The rows can change under the highlight without a keystroke: disk search
  // keeps the previous query's rows up through its pause, and its answer can be
  // shorter than the list the person has just arrowed down. The highlight is
  // pulled back onto the list, and the pulled-back index is what is kept, so a
  // list that grows again does not jump the highlight to the row that was lost.
  const highlighted = clampPaletteSelection(selected, visible.length)
  if (highlighted !== selected) setSelected(highlighted)

  // Keep the highlighted row in view as the selection moves by keyboard.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  const handleKey = (event: React.KeyboardEvent) => {
    if (isImeKey(event)) return
    // The inventory's rows are the panel's; only the step back to All below is
    // the palette's own in that tab.
    if (scope === 'skills' && event.key !== 'Backspace') {
      skillsPanelRef.current?.handleKey(event)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => stepPaletteSelection(current, visible.length, 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => stepPaletteSelection(current, visible.length, -1))
    }
    if (event.key === 'Enter') {
      if (!actionBusy) visible[highlighted]?.run()
    }
    if (event.key === 'Backspace' && !query) {
      // Backspace at an empty query steps back one state: out of the "which
      // agent" question first, then back to the All tab — so ⌘⇧F's narrowing
      // and the star's are both reversible from the keyboard without leaving
      // the field for the strip or reopening the overlay.
      if (agentChoice) {
        event.preventDefault()
        setAgentChoice(null)
        setActionError(null)
        setSelected(0)
        return
      }
      if (scope !== 'all') {
        event.preventDefault()
        setScope('all')
        setSelected(0)
      }
    }
  }

  const renderMark = (mark: PaletteRowMark): React.ReactNode => {
    switch (mark.kind) {
      case 'new-chat':
        return <NewChatIcon className="icon-sm shrink-0" />
      case 'go-to-file':
        return <FileTypeGlyph kind="generic" className="icon-sm shrink-0" />
      case 'search':
        return <PaletteSearchGlyph />
      case 'settings':
        return <GeneralSettingsIcon className="icon-sm shrink-0" />
      case 'remote':
        return <RemoteMachineGlyph className="icon-sm shrink-0" />
      case 'chat': {
        const cli = cliByWorkspaceId.get(mark.workspaceId)?.cli
        return (
          // The sidebar's provider chip, so a chat is recognised here by the
          // same mark it wears there.
          <span
            aria-hidden="true"
            className="flex size-icon-sm shrink-0 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
          >
            {cli ? (
              <CliIcon cli={cli} className="icon-xs" />
            ) : (
              <WorkspaceTypeIcon mode={mark.mode} className="icon-xs text-[color:var(--text-muted)]" />
            )}
          </span>
        )
      }
    }
  }

  const activeOptionId =
    scope === 'skills'
      ? skillsActiveOptionId
      : visible[highlighted]
        ? `palette-option-${visible[highlighted].id}`
        : undefined
  // One id per scope, so the strip's `aria-controls` and the combobox's both
  // resolve to the list that is showing — the results ARE the tab's panel.
  const resultsId = `command-palette-panel-${scope}`

  return (
    <div
      className="overlay-scrim fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh]"
      // `mousedown`, matching `Modal`: on `click`, a drag that STARTED inside
      // the palette (selecting the query text) and was released over the scrim
      // dismisses it, which reads as the palette closing itself.
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      {/* The palette is a modal surface like any other: it says so (`role`,
          `aria-modal`), and the trap is what makes the claim true. */}
      <FocusTrap>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          tabIndex={-1}
          style={overlayWidthStyle('palette')}
          // The palette keeps its own scrim — it sits at 15vh rather than
          // centred, which no dialog does — but not its own geometry: shell
          // chrome and width both come from the scale, so `Modal` and this read
          // as the same surface. The ground is the one thing it
          // paints itself: `surface-glass`, the kit's frosted material (owner
          // ruling 2026-09-10 — the fourth sanctioned glass shell, and the
          // repaint hold above is what makes it affordable). The scrim behind
          // stays a plain tone; it never blurs. `overflow-hidden` is the other
          // local addition: the bands' hairlines have to be clipped by the
          // shell's corners.
          className={`${OVERLAY_SHELL_CHROME_CLASS} surface-glass overflow-hidden outline-none`}
        >
          {/* One band of chrome, two lines: the scope strip and the field. The
              strip is borderless so the band draws ONE hairline, under the
              field — the active tab's own underline is the only mark between
              the two lines. */}
          <div className="border-b border-[color:var(--border-default)]">
            <Tabs
              ariaLabel="Search in"
              idPrefix="command-palette"
              items={PALETTE_SCOPE_TABS}
              value={scope}
              onChange={selectScope}
              borderless
              className="px-2 pt-1"
            />
            {/* Every tab, Skills included, filters through this one field. */}
            <div className="flex items-center gap-2 px-4 py-3">
              {/* The leading mark is the search glyph, not a ⌘: the field is a
                search, and the chord that opened it is not what it is for. */}
              <PaletteSearchGlyph className="icon-sm shrink-0 text-[color:var(--text-disabled)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSelected(0)
                }}
                onKeyDown={handleKey}
                placeholder={PALETTE_PLACEHOLDER[scope]}
                aria-label={PALETTE_INPUT_LABEL[scope]}
                role="combobox"
                aria-expanded={scope === 'skills' ? skillsActiveOptionId !== undefined : visible.length > 0}
                aria-controls={scope === 'skills' ? INSTALLED_SKILLS_RESULTS_ID : resultsId}
                aria-activedescendant={activeOptionId}
                // No ring on the field (owner ruling 2026-09-10). The shell IS
                // the field: it opens with the caret in it, the caret is the
                // focus signal, and a 2px ring drawn inside a bordered band the
                // whole width of the shell read as a second box around the one
                // thing on screen. The tab strip keeps its ring, so a keyboard
                // walk still shows where focus went; coming back to the field
                // shows the caret.
                className="flex-1 bg-transparent text-heading text-[color:var(--text-strong)] outline-none placeholder-[color:var(--text-disabled)]"
              />
            </div>
          </div>

          {scope === 'skills' ? (
            <InstalledSkillsPanel
              ref={skillsPanelRef}
              query={query}
              fieldRef={inputRef}
              onActiveOptionChange={setSkillsActiveOptionId}
              workspaceRoot={activeFolderPath}
              workspaceId={activeWorkspaceId}
              preferredTarget={preferredTarget}
              onBrowse={() => {
                openExtensionsSurface({ view: 'skills' })
                onClose()
              }}
              onUsed={(session) => {
                focusAfterCloseRef.current =
                  session.workspaceId && session.agentId
                    ? { workspaceId: session.workspaceId, agentId: session.agentId }
                    : null
                onClose()
              }}
            />
          ) : (
            <div
              id={resultsId}
              role="listbox"
              aria-label="Search results"
              className="max-h-[360px] overflow-y-auto py-1"
            >
              {/* An action that failed says so where the person is looking, and
                the list stays up: a skill whose install was refused must not
                also make the palette vanish. */}
              {actionError && (
                <p role="alert" className="px-4 py-2 text-meta text-[color:var(--tone-error)]">
                  {actionError}
                </p>
              )}
              {/* The one part of the palette that is not a search and not
                instant — an install-and-use round trip — says so at the top of
                the list, with the kit's working mark (liveness: alive right
                now, for an unknown duration). Never beside the query: a note
                on the field's own line read as part of what was typed. */}
              {actionBusy && (
                <p role="status" className="flex items-center gap-2 px-4 py-2 text-meta text-[color:var(--text-muted)]">
                  Working
                  <WorkingMark label="Working" />
                </p>
              )}
              {visible.length === 0 ? (
                // "No results" is only true once the search that would have
                // produced them has finished; a failure says what failed instead.
                // A search in flight is the working mark, not a static ellipsis:
                // the marker the system already uses for "alive right now".
                <p
                  role={provided.loading ? 'status' : undefined}
                  className="flex items-center gap-2 px-4 py-3 text-meta text-[color:var(--text-muted)]"
                >
                  {provided.error ? (
                    provided.error
                  ) : provided.loading ? (
                    <>
                      Searching
                      <WorkingMark label="Searching" />
                    </>
                  ) : (
                    'No results'
                  )}
                </p>
              ) : (
                groupedResults.map((group) => (
                  <div key={group.key} role="group" aria-label={group.label}>
                    {/* The group's name and nothing else: quieter ink than the
                      rows, no rule filling the line, no count (owner ruling
                      2026-09-10 — the rule and the number were chrome
                      between every group and the next). */}
                    <div aria-hidden="true" className="px-4 pb-1 pt-2 text-meta text-[color:var(--text-muted)]">
                      {group.label}
                    </div>
                    {group.items.map((command, position) => {
                      const index = flatIndexById.get(command.id) ?? -1
                      const isSelected = index === highlighted
                      const textHit = group.key === 'content' && command.path !== undefined
                      // A text hit sits under its file, the way a search tool
                      // lists them: one heading per file — its kind glyph, its
                      // name, its folder, how many lines matched — then the
                      // lines, each with its number in the gutter. The heading
                      // is not an option: Enter acts on a line, never a file.
                      const previous = position > 0 ? group.items[position - 1] : undefined
                      const heading =
                        textHit && previous?.path !== command.path ? (
                          <div
                            key={`${command.path}-heading`}
                            role="presentation"
                            className="flex items-center gap-2 px-4 pb-1 pt-2 text-meta text-[color:var(--text-default)]"
                          >
                            <FileTypeGlyph name={command.file ?? ''} tone="kind" className="icon-sm shrink-0" />
                            <span className="shrink-0 font-medium">{command.file}</span>
                            <TruncatedText
                              as="span"
                              text={parentDirectory(command.path ?? '')}
                              className="min-w-0 text-[color:var(--text-subtle)]"
                            />
                            <span className="ml-auto shrink-0 tabular-nums text-micro text-[color:var(--text-muted)]">
                              {group.items.filter((item) => item.path === command.path).length}
                            </span>
                          </div>
                        ) : null
                      if (textHit) {
                        return (
                          <React.Fragment key={command.id}>
                            {heading}
                            <div
                              ref={isSelected ? selectedRowRef : undefined}
                              id={`palette-option-${command.id}`}
                              role="option"
                              aria-selected={isSelected}
                              onClick={command.run}
                              onMouseEnter={() => setSelected(index)}
                              className={`flex cursor-pointer items-center gap-3 py-1 pl-4 pr-4 font-mono text-meta transition-colors ${
                                isSelected
                                  ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                                  : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                              }`}
                            >
                              <span className="w-10 shrink-0 text-right tabular-nums text-[color:var(--text-disabled)]">
                                {command.line}
                              </span>
                              <TruncatedText as="span" text={command.label} className="min-w-0 flex-1" />
                            </div>
                          </React.Fragment>
                        )
                      }
                      // A chat with a pull request wears its number — the one
                      // the query names when it names one — so a search for
                      // `#482` shows which chat holds it.
                      const badge =
                        command.mark?.kind === 'chat'
                          ? chatPullRequestBadge(chatPullRequests.get(command.mark.workspaceId) ?? [], query)
                          : command.badge
                      return (
                        <div
                          key={command.id}
                          ref={isSelected ? selectedRowRef : undefined}
                          id={`palette-option-${command.id}`}
                          role="option"
                          aria-selected={isSelected}
                          onClick={command.run}
                          onMouseEnter={() => setSelected(index)}
                          // The row's ink is the sidebar's: `text.default` at
                          // rest, `text.strong` under the cursor. It shipped at
                          // `text.muted`, which put the one thing a person came
                          // to read a step below its own heading.
                          className={`flex cursor-pointer items-center gap-2.5 px-4 py-2 transition-colors ${
                            isSelected
                              ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                              : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
                          }`}
                        >
                          {/* The row's mark. A file wears the kind glyph the File
                            Explorer draws for the same name, in its kind's hue
                            — the tile is how a list of forty hits is scanned
                            before it is read. A skill or plugin wears its own
                            artwork, down the same ladder the Extensions door
                            draws (glyph → logo → the publishing account's
                            avatar → monogram), so a row reads the same in both
                            places. A command or a chat wears none: the verb is
                            the whole row. */}
                          {command.file ? (
                            <FileTypeGlyph name={command.file} tone="kind" className="icon-sm shrink-0" />
                          ) : command.mark ? (
                            renderMark(command.mark)
                          ) : command.icon ? (
                            <ExtensionIcon name={command.label} size={PALETTE_ROW_ICON_SIZE} {...command.icon} />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              {/* A content hit's label is a line of source, not a
                                title: it reads in mono at body size, with the
                                file:line beneath it as the locator. */}
                              <TruncatedText
                                as="div"
                                text={command.label}
                                className={`min-w-0 ${command.group === 'content' ? 'font-mono text-meta' : 'text-heading'}`}
                              />
                              {/* Where it came from, or that you already have it —
                                the one fact a cross-source list cannot leave
                                out, because the same skill name appears in
                                several marketplaces. */}
                              {badge ? (
                                <span className="shrink-0 rounded-[var(--radius-xs)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 text-micro text-[color:var(--text-subtle)]">
                                  {badge}
                                </span>
                              ) : null}
                            </div>
                            {command.description && (
                              <TruncatedText
                                as="div"
                                text={command.description}
                                className={`mt-0.5 text-micro text-[color:var(--text-disabled)] ${command.group === 'content' ? 'font-mono' : ''}`}
                              />
                            )}
                          </div>
                          {command.shortcut && (
                            // The chord arrives already rendered for this
                            // platform ("⌘K"), so it is one capsule, not a parse.
                            <KbdChord
                              keys={[command.shortcut]}
                              ariaLabel={command.shortcut}
                              className="ml-3 shrink-0"
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </FocusTrap>
    </div>
  )
}

/** The folder a workspace-relative path sits in; empty at the root. */
function parentDirectory(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? '' : path.slice(0, slash)
}

/** The kit's search glyph (design-system/glyphs/search.svg). */
function PaletteSearchGlyph({ className = 'icon-sm shrink-0' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 11 11" fill="none" aria-hidden="true" className={`${className} p-0.5`}>
      <circle cx="4.5" cy="4.5" r="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M7 7l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
