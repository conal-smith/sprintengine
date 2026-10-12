// The active workspace's identity cluster — star toggle, name, project
// (folder-name) chip, and branch chip — hoisted out of the retired 48px WorkspaceTopBar
// row into the merged AppTitleBar title strip (it fills the title bar's centre
// slot). It is a display surface, not a control group, so it sits outside the
// top-bar-group cap (the TopBar inventory lives in
// scripts/lint-panel-composition.mjs).
//
// The star, project, and branch segments are interactive (toggle starred /
// toggle Files / toggle Git) and opt out of the title strip's drag region with
// `app-no-drag`; the name keeps its sidebar-toggle role (or degrades to a
// draggable span) to preserve the window grab area.

import React from 'react'
import {
  GhostButton,
  IconButton,
  OutlineButton,
  OverflowMenu,
  SplitButton,
  StarGlyph,
  Tooltip,
  type OverflowMenuItem,
  type SplitButtonItem,
} from '../ui'
import type { CursorAnchor } from '../ui/CursorErrorPopover'

// The "Open in editor" failure card, anchored at the cursor. It exists only
// after a probe or a launch has failed, which is never at first paint, so the
// card (and the lifecycle glyph and inline-notice shell it draws with) is
// fetched when a failure actually has to be shown.
const CursorErrorPopover = React.lazy(() =>
  import('../ui/CursorErrorPopover').then((m) => ({ default: m.CursorErrorPopover })),
)
import { publishDiagnostic } from '../../utils/diagnostics'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitBranch } from '../../hooks/useGitBranch'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { followedCheckoutOf } from './followedCheckout'
import { branchChipCopy, changedFilesPhrase } from './terminalLines'
import { checkoutPathFor } from './useSidebarGitSummaries'
import { ChangeCountBadge, checkoutChangesOf, useCheckoutChangeSummary } from './checkoutChanges'
import { normalizeAgentRuntime } from '../../store/slices/agentsSlice'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'
import CliIcon from '../CliIcon'
import { selectModuleEnabled } from '../../modules'
import { getHighlightSwatch, isStarred } from '../../utils/highlight'
import type { FolderOpenTargetAvailability, FolderOpenTargetId } from '../../../../shared/folder-open-targets'
import {
  availableFolderOpenTargets,
  folderOpenTargetLabel,
  offersFolderOpenMenu,
  resolveFolderOpenPrimary,
} from './openInEditorTargets'
import { useTitleBarFold } from './titleBarFold'
import type { Workspace } from '../../types/workspace'

// Branch-fork glyph for the header identity cluster. Stroke idiom matches the
// Git panel's local icons (round strokes on a 16px box) so the two Git
// surfaces read as one family. The drawing is the ONE shared branch fork
// (AppIcons, mirrored in design-system/glyphs/git-branch.svg) — this chip and
// the sidebar row's branch glyph sit on adjacent chrome and must agree.
import { GitBranchGlyph } from '../AppIcons'
import { shortMachineName } from '../remote/machineRowModel'
import { remoteProjectName } from './sidebar/folderGroups'
import { MachineRowGlyph } from './sidebar/rowParts'
import {
  AntigravityMark,
  CLionMark,
  CursorMark,
  DataGripMark,
  GoLandMark,
  IntelliJMark,
  KiroMark,
  PhpStormMark,
  PyCharmMark,
  RiderMark,
  RubyMineMark,
  RustRoverMark,
  SublimeTextMark,
  TraeMark,
  VSCodiumMark,
  VsCodeInsidersMark,
  VsCodeMark,
  WebStormMark,
  WindsurfMark,
  ZedMark,
} from '../brand/EditorMarks'

// Folder glyph for the project chip. Same stroke idiom as GitBranchGlyph
// (1.3px round strokes on a 16px box) so the two identity chips read as a set.
function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none">
      <path
        d="M2.1 4.4a1.3 1.3 0 0 1 1.3-1.3h2.6l1.4 1.5h5.2a1.3 1.3 0 0 1 1.3 1.3v5.4a1.3 1.3 0 0 1-1.3 1.3H3.4a1.3 1.3 0 0 1-1.3-1.3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Each editor's own mark in its vendor's colour (brand/EditorMarks; ruled
// 2026-09-06, principles.md → "Identity colour"), so the control says which
// tool it opens the way every other app does — a two-letter "VS"/"IJ" mono
// chip was ours, not theirs, and the monochrome logos that replaced it still
// read as placeholders beside the real marks in every other menu on the
// machine. The file manager's folder is ours and rides currentColor. Keyed by
// target rather than chained ternaries, so adding a target to the shared id
// list fails to compile here instead of silently drawing the wrong mark.
const TARGET_MARK: Record<FolderOpenTargetId, React.ReactNode> = {
  vscode: <VsCodeMark className="size-icon-sm" />,
  'vscode-insiders': <VsCodeInsidersMark className="size-icon-sm" />,
  vscodium: <VSCodiumMark className="size-icon-sm" />,
  cursor: <CursorMark className="size-icon-sm" />,
  windsurf: <WindsurfMark className="size-icon-sm" />,
  trae: <TraeMark className="size-icon-sm" />,
  kiro: <KiroMark className="size-icon-sm" />,
  antigravity: <AntigravityMark className="size-icon-sm" />,
  zed: <ZedMark className="size-icon-sm" />,
  sublime: <SublimeTextMark className="size-icon-sm" />,
  intellij: <IntelliJMark className="size-icon-sm" />,
  webstorm: <WebStormMark className="size-icon-sm" />,
  pycharm: <PyCharmMark className="size-icon-sm" />,
  goland: <GoLandMark className="size-icon-sm" />,
  clion: <CLionMark className="size-icon-sm" />,
  phpstorm: <PhpStormMark className="size-icon-sm" />,
  rider: <RiderMark className="size-icon-sm" />,
  rubymine: <RubyMineMark className="size-icon-sm" />,
  rustrover: <RustRoverMark className="size-icon-sm" />,
  datagrip: <DataGripMark className="size-icon-sm" />,
  finder: <FolderGlyph className="size-icon-sm" />,
}

function TargetGlyph({ target }: { target: FolderOpenTargetId }) {
  return (
    <span aria-hidden="true" className="grid size-icon-sm shrink-0 place-items-center text-[color:var(--text-muted)]">
      {TARGET_MARK[target]}
    </span>
  )
}

// Open the workspace's active checkout in an external tool. Three rules the
// surface depends on, whichever spelling it wears:
// - **Probe-hide, not probe-disable.** An editor that is not installed is
//   absent from the menu, the same rule the agent pickers follow for
//   uninstalled CLIs. A disabled row for a missing editor is a fake affordance.
// - **The active checkout, not the project root.** A worktree-backed workspace
//   opens its worktree, resolved through `resolveWorkspaceWorktree` exactly as
//   the Git view and the branch chip above do — opening the parent checkout
//   would show the operator a different branch than the one their agents run on.
// - **A failed launch is visible and stops there.** The typed failure from the
//   IPC is surfaced on the control; nothing silently retries in another editor.
export type FolderOpenTargets = {
  /** Every target that actually resolved on this machine. */
  available: FolderOpenTargetId[]
  /** The target the primary half runs; null while nothing has resolved yet. */
  primaryTarget: FolderOpenTargetId | null
  /** `remember` re-points the primary half — only ever on a launch that worked. */
  openTarget: (target: FolderOpenTargetId, remember: boolean) => Promise<void>
  /** Re-probe on menu open, so an editor installed since boot appears. */
  reprobe: (open: boolean) => void
  isMac: boolean
  primaryRef: React.MutableRefObject<HTMLButtonElement | null>
  /** The failure popover, already positioned. Render it once, beside the row. */
  failureNode: React.ReactNode
}

/**
 * The probe + launch + remembered-primary state behind "Open".
 *
 * A hook rather than state inside the button because the control has two
 * spellings — the inline SplitButton and, once the strip folds (titleBarFold
 * stage 2), a set of rows in the identity cluster's overflow menu. One hook
 * instance, called once by `WorkspaceIdentity`, is what keeps those two from
 * each registering the `Primary+O` listener and revealing the folder twice.
 */
export function useFolderOpenTargets(workspaceId: string | null, openPath: string): FolderOpenTargets {
  const isMac = window.api.platform === 'darwin'
  const lastTarget = useWorkspaceStore((state) => state.appSettings.lastFolderOpenTarget)
  const setLastTarget = useWorkspaceStore((state) => state.setLastFolderOpenTarget)
  // null until the first probe answers: the control does not render before it
  // knows which targets exist, rather than guessing a primary and correcting it.
  const [availability, setAvailability] = React.useState<FolderOpenTargetAvailability[] | null>(null)
  const [failure, setFailure] = React.useState<{ message: string; anchor: CursorAnchor } | null>(null)
  const primaryRef = React.useRef<HTMLButtonElement | null>(null)

  const probe = React.useCallback(async () => {
    try {
      return await window.api.listFolderOpenTargets()
    } catch (error) {
      // The probe is the whole basis for what this control offers, so a failed
      // one leaves it unrendered rather than showing a menu we cannot stand
      // behind. Reported through the diagnostics channel, not in the operator's
      // face on a boot they did not ask anything of.
      void publishDiagnostic({
        level: 'error',
        source: 'filesystem',
        title: 'Could not list open-in-editor targets',
        message: 'The workspace bar cannot offer an external editor until the check succeeds.',
        details: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void probe().then((result) => {
      if (!cancelled && result) setAvailability(result)
    })
    return () => {
      cancelled = true
    }
  }, [probe])

  const available = React.useMemo(() => availableFolderOpenTargets(availability), [availability])
  const primaryTarget = resolveFolderOpenPrimary(available, lastTarget)

  const showFailure = React.useCallback(
    (target: FolderOpenTargetId, detail: string) => {
      const rect = primaryRef.current?.getBoundingClientRect()
      setFailure({
        message: `Could not open ${folderOpenTargetLabel(target, isMac)}: ${detail}`,
        anchor: rect ? { x: rect.left + rect.width / 2, y: rect.bottom } : { x: window.innerWidth / 2, y: 0 },
      })
    },
    [isMac],
  )

  const openTarget = React.useCallback(
    async (target: FolderOpenTargetId, remember: boolean) => {
      // No resolved checkout means there is nothing to open. The hook runs for
      // every workspace (it owns the `Primary+O` listener), so this is the
      // guard that used to be "the button does not render".
      if (!openPath) return
      let result
      try {
        result = await window.api.openFolderInTarget({ target, path: openPath })
      } catch (error) {
        // The channel itself failed, which is not one of the typed outcomes. It
        // still has to reach the operator: every caller invokes this as
        // fire-and-forget, so without this the click would be a silent no-op
        // (and an unhandled rejection).
        showFailure(target, error instanceof Error ? error.message : String(error))
        return
      }
      if (result.ok) {
        // Remembered only on a launch that happened: repointing the primary at
        // an editor that just failed would repeat the failure on the next click.
        if (remember) setLastTarget(target)
        return
      }
      showFailure(target, result.message)
    },
    [openPath, setLastTarget, showFailure],
  )

  // `Primary+O` (workspace.folder.reveal) reveals the same checkout in the file
  // manager. It routes here rather than calling the IPC itself so the shortcut
  // and the control cannot disagree about which folder the workspace is on. It
  // deliberately does NOT re-point the primary half: a shortcut for one target
  // is not a choice of default.
  React.useEffect(() => {
    if (!workspaceId) return
    const onPanelCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; workspaceId?: string }>).detail
      if (detail?.id !== 'workspace.folder.reveal') return
      if (detail.workspaceId && detail.workspaceId !== workspaceId) return
      void openTarget('finder', false)
    }
    window.addEventListener('sprintengine:panel-command', onPanelCommand)
    return () => window.removeEventListener('sprintengine:panel-command', onPanelCommand)
  }, [openTarget, workspaceId])

  // Re-probed whenever the menu opens: an editor installed while the app was
  // running should appear without a restart, and one uninstalled since boot
  // should stop being offered.
  const reprobe = React.useCallback(
    (open: boolean) => {
      if (open) void probe().then((result) => result && setAvailability(result))
    },
    [probe],
  )

  return {
    available,
    primaryTarget,
    openTarget,
    reprobe,
    isMac,
    primaryRef,
    failureNode: failure ? (
      <React.Suspense fallback={null}>
        <CursorErrorPopover
          key={`${failure.anchor.x},${failure.anchor.y},${failure.message}`}
          message={failure.message}
          anchor={failure.anchor}
          onDismiss={() => setFailure(null)}
        />
      </React.Suspense>
    ) : null,
  }
}

/**
 * The inline spelling of "Open": the one bordered control in the identity
 * cluster. Primary half runs the last-used target; the chevron half lists every
 * target that resolved and re-points the primary (item 1990). Renders nothing
 * until the probe has answered — it does not guess a primary and then correct
 * itself.
 *
 * Exported for `seams/premiumFeelSeam.test.tsx`, which mounts this control over
 * the real launcher probe to prove seam 3 — probe-HIDE, not probe-disable. It
 * lost its export on 2026-09-04 (bc02a70db) when the probe state moved out to
 * `useFolderOpenTargets` so the folded overflow menu could share one instance;
 * the seam then resolved `undefined` and rendered nothing, which no one saw
 * because verify:app halts long before that step. Keep the export with the
 * hook: the two together are what the seam mounts.
 */
export function OpenWorkspaceFolderButton({ targets }: { targets: FolderOpenTargets }) {
  const { available, primaryTarget, openTarget, reprobe, isMac, primaryRef } = targets

  const items = React.useMemo<SplitButtonItem[]>(
    () =>
      available.map((target) => ({
        id: target,
        label: folderOpenTargetLabel(target, isMac),
        icon: <TargetGlyph target={target} />,
        shortcut: target === 'finder' ? (isMac ? '⌘O' : 'Ctrl+O') : undefined,
        checked: target === primaryTarget,
        onSelect: () => void openTarget(target, true),
      })),
    [available, isMac, openTarget, primaryTarget],
  )

  if (!primaryTarget) return null

  return (
    <>
      {!offersFolderOpenMenu(available) ? (
        // Nothing to choose between — no editor resolved, so the file manager is
        // the only target. A chevron whose menu holds one row, already the
        // primary, is a control that opens to say nothing; this is a plain
        // button until a second target exists.
        <OutlineButton
          ref={primaryRef}
          className="app-no-drag shrink-0 gap-1.5"
          aria-label={`Open workspace folder in ${folderOpenTargetLabel(primaryTarget, isMac)}`}
          onClick={() => void openTarget(primaryTarget, false)}
        >
          <TargetGlyph target={primaryTarget} />
          Open
        </OutlineButton>
      ) : (
        <SplitButton
          className="app-no-drag shrink-0"
          label="Open"
          glyph={<TargetGlyph target={primaryTarget} />}
          primaryAriaLabel={`Open workspace folder in ${folderOpenTargetLabel(primaryTarget, isMac)}`}
          menuAriaLabel="Open workspace folder in…"
          items={items}
          onPrimary={() => void openTarget(primaryTarget, false)}
          onMenuOpenChange={reprobe}
          primaryRef={primaryRef}
        />
      )}
    </>
  )
}

// The chip's reading of its checkout's changes, keyed apart from any other
// reader of the same checkout (checkoutChanges.tsx).
const CHIP_SUMMARY_ID = 'workspace-identity-chip'

export function WorkspaceIdentity({
  activeWorkspace,
  activeWorkspaceId,
  sidebarCollapsed = false,
  onToggleSidebar,
}: {
  activeWorkspace: Workspace | null
  activeWorkspaceId: string | null
  // The workspace name doubles as a sidebar toggle — it's the workspace's
  // headline, so clicking it shows/hides the workspace list (Cursor idiom). The
  // click always toggles; `sidebarCollapsed` only drives the tooltip/aria
  // wording. When no handler is supplied the name renders as plain text.
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}) {
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const setWorkspaceHighlight = useWorkspaceStore((state) => state.setWorkspaceHighlight)
  // For a worktree-backed workspace (a
  // worktree opened as a workspace) the branch label AND the change count must
  // reflect the worktree the work runs on — matching the Git panel, which also
  // resolves the worktree. A run_worktree workspace's `folderPath` points at the
  // parent project checkout (e.g. `main`), so probing it reports that checkout's
  // branch and its uncommitted files rather than the worktree's — which is why the
  // count stayed stuck on main's dirty files across branch switches. Resolve the
  // worktree first and probe its `gitRoot`; regular workspaces have no worktree and
  // fall back to `folderPath` unchanged. The folder-path segment still opens the
  // file explorer rooted at `folderPath` — only the git probes move to the worktree.
  //
  // And since sidebar-lists-every-terminal, the chip follows the FOCUSED
  // AGENT: an agent that moved into a worktree of its own is what the chip
  // describes while its tab is the one selected — with no tab focused, the
  // last one that was. Only a workspace that never focused an agent shows its
  // own checkout. `followedCheckoutOf` is that rule, shared with the lines.
  const terminalSessions = useTerminalSessions()
  const focusedAgentId = useWorkspaceStore((state) =>
    activeWorkspaceId ? state.focusedAgentByWorkspaceId[activeWorkspaceId] : undefined,
  )
  const followed = activeWorkspace ? followedCheckoutOf(activeWorkspace, focusedAgentId, terminalSessions) : null
  const gitProbePath = followed?.probePath ?? null
  const gitBranch = useGitBranch(gitProbePath)
  // The chip's numbers, from the SAME summary the sidebar's lines read: the
  // branch's span, or what the checkout still carries once that branch landed.
  // Owner, 2026-09-09: they are FILES — "+5 −2" is five files added or updated
  // and two removed — because that is the question the summary level answers;
  // the per-file line counts live where a single file is in view (the
  // conversation peek's rows and the diff viewer).
  const gitSummary = useCheckoutChangeSummary(gitProbePath, CHIP_SUMMARY_ID)
  const branchIsRepo = followed?.isRepo ?? gitBranch.isRepo
  const branchName = followed?.branch ?? gitBranch.branch
  // Who the chip is describing, for its mark and its words; null means the
  // workspace's own checkout, said the way it always was.
  const followedAgent = followed?.agent ?? null
  // The pull requests the followed agent's terminals carry, so the chip reaches
  // the `landed` scope exactly when its line does: a squash-merged branch shows
  // what the checkout still carries in BOTH places, or neither.
  const followedPullRequests = React.useMemo(
    () =>
      followedAgent && activeWorkspaceId
        ? terminalSessions
            .filter((session) => session.workspaceId === activeWorkspaceId && session.agentId === followedAgent.agentId)
            .flatMap((session) => session.pullRequests ?? [])
        : [],
    [terminalSessions, activeWorkspaceId, followedAgent],
  )
  const {
    files: gitFiles,
    marks: gitMarks,
    hasCounts: gitHasCounts,
  } = checkoutChangesOf(gitSummary, followedPullRequests)
  // A conversation says where it works on the strip under its own composer —
  // its branch, its changes, its machine — and the branch and the counts
  // opening the file explorer and the Git panel from there (owner ruling
  // 2026-10-04). While one is the agent followed, the title bar carries none
  // of it: the project's name stays as a fact, and the two panel doors are the
  // strip's. A terminal has no strip, so with one followed (or none) the bar
  // keeps its chips and its doors as they were.
  const followedRecord = followedAgent ? activeWorkspace?.agents?.[followedAgent.agentId] : undefined
  const followingConversation =
    followedRecord !== undefined && normalizeAgentRuntime(followedRecord).runtimeKind === 'conversation'
  // The chip names the agent only where the checkout is the agent's OWN
  // worktree: on the workspace's own checkout there is nobody to credit — a
  // person and any number of terminals share it — and naming one agent there
  // would claim the tree's changes for them.
  const ownCheckoutPath = activeWorkspace ? checkoutPathFor(activeWorkspace) : null
  const agentWorktree = followedAgent !== null && gitProbePath !== null && gitProbePath !== ownCheckoutPath
  const chipCopy = branchChipCopy({
    branch: branchName,
    agent:
      agentWorktree && followedAgent
        ? { name: followedAgent.name, runtime: followedAgent.cli ? labelForCliRuntime(followedAgent.cli) : null }
        : null,
    files: gitFiles,
  })
  // The header identity segments double as panel shortcuts: the folder path
  // toggles the file explorer and the branch toggles the Git panel — same
  // open/close-on-second-click semantics as the Backlog panel switch. Only
  // offered when the owning capability module is enabled, so we never offer a
  // click that resolves to nothing.
  const filesPanelEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools') && !followingConversation
  const gitPanelEnabled = selectModuleEnabled(moduleOverrides, 'git')
  // The branch chip, inline or folded: not while a conversation is followed.
  const branchChipShown = branchIsRepo && !followingConversation
  // Files and Git are workspace-pane tabs (browser-pane epic): the chips keep
  // their open/close-on-second-click semantics against the pane record.
  const togglePaneKind = useWorkspaceStore((s) => s.togglePaneKind)
  const toggleFilesPanel = React.useCallback(() => {
    if (activeWorkspaceId) togglePaneKind(activeWorkspaceId, 'files')
  }, [activeWorkspaceId, togglePaneKind])
  const toggleGitPanel = React.useCallback(() => {
    if (activeWorkspaceId) togglePaneKind(activeWorkspaceId, 'git')
  }, [activeWorkspaceId, togglePaneKind])
  // How much room the strip has left (see titleBarFold): 0 everything inline,
  // 1 the chips keep their glyphs and lose their words, 2 "Open" folds into the
  // overflow menu, 3 the chips fold in with it. Nothing is ever deleted — every
  // stage moves a segment, and the menu is where it moves to.
  const fold = useTitleBarFold()
  // The checkout an external editor should open: the one the branch chip
  // describes — the followed agent's, else the mounted worktree, else the
  // project root — so the two name one tree. Called unconditionally (hooks)
  // and for both spellings of the control at once, so the `Primary+O` reveal
  // listener is registered exactly once.
  const folderTargets = useFolderOpenTargets(activeWorkspaceId, gitProbePath ?? '')

  if (!activeWorkspace) return null

  const starred = isStarred(activeWorkspace.highlight)

  // Per-workspace highlight: the retired 48px row tinted its bottom border, but
  // that strip is now the full-width app title bar, where an app-wide bottom
  // tint reads too subtly. Re-home the accent onto the identity cluster itself —
  // the name carries an underline in the highlight colour — so the current
  // workspace's colour stays legible without chroming the whole strip.
  const highlightHex = activeWorkspace.highlight?.color ? getHighlightSwatch(activeWorkspace.highlight.color).hex : null

  // Show the project's folder name, not the full absolute path — the path was
  // the strip's biggest source of clutter and its only meaningful part is the
  // basename. The full path still rides the chip's tooltip, and the reveal-Files
  // affordance is preserved. Handles POSIX and Windows separators and trailing
  // slashes; falls back to the whole string if there is no separator.
  // The checkout an external editor should open is `gitProbePath` — the one
  // the branch chip above describes. Distinct from `folderPath` below, which
  // stays the project root because the Files panel is rooted there.
  // Drawn once for both spellings of this control (the Git-panel button and the
  // read-only span when the panel module is off), so they can never drift.
  const gitCountBadge = gitHasCounts && gitMarks ? <ChangeCountBadge marks={gitMarks} className="ml-0.5" /> : null
  // The followed agent's runtime mark, ahead of the branch glyph, so "whose
  // branch" reads at a glance; decorative here — the control's words carry the
  // name (`chipCopy.spoken`), and the chip's tooltip names it in full.
  const followedMark = followedAgent?.cli ? (
    <span aria-hidden="true" className="flex shrink-0 items-center text-[color:var(--text-subtle)]">
      <CliIcon cli={followedAgent.cli} className="icon-xs" />
    </span>
  ) : null
  // The chip says WHAT you are looking at and nothing else (owner, 2026-09-09):
  // the branch, the agent whose own worktree it is, and how many files that
  // checkout carries. The old tooltip ended "select another tab to follow it" —
  // an instruction taped to a fact, in the one place a person is reading the
  // header to answer "where am I?".
  const branchTooltip = chipCopy.tooltip

  const openPath = gitProbePath

  const folderPath = activeWorkspace.folderPath
  const projectName = folderPath
    ? (() => {
        const trimmed = folderPath.replace(/[\\/]+$/, '')
        const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
        return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || trimmed
      })()
    : null

  // The ladder, read once. Each flag is "this segment is still on the strip".
  const showChipWords = fold < 1
  const openInline = fold < 2
  const chipsInline = fold < 3

  // Everything the ladder has taken off the strip, in the order it left. A row
  // here does exactly what the segment it replaces did — the project row toggles
  // Files, the branch row toggles Git — so folding changes where a control is,
  // never what it does. The branch row spells its ±lines out in words: a menu
  // row has the width the chip did not, and this is the one place the count can
  // be read rather than glanced at.
  const overflowItems: OverflowMenuItem[] = []
  if (!chipsInline) {
    if (folderPath && filesPanelEnabled && projectName) {
      overflowItems.push({
        id: 'identity-files',
        label: `Files — ${projectName}`,
        icon: <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />,
        onSelect: toggleFilesPanel,
      })
    }
    if (branchChipShown && gitPanelEnabled) {
      const branchRowLabel = branchName ?? 'detached'
      overflowItems.push({
        id: 'identity-git',
        label:
          gitHasCounts && gitFiles
            ? `Git — ${branchRowLabel} (${changedFilesPhrase(gitFiles)})`
            : `Git — ${branchRowLabel}`,
        icon: <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />,
        onSelect: toggleGitPanel,
      })
    }
  }
  if (!openInline && openPath && folderTargets.primaryTarget) {
    if (overflowItems.length > 0) overflowItems.push({ kind: 'separator', id: 'identity-open-separator' })
    for (const target of folderTargets.available) {
      overflowItems.push({
        id: `identity-open-${target}`,
        // Named in full: "Open" alone was legible next to its own editor mark
        // on the strip, and a menu row has neither that adjacency nor the
        // chevron that listed the alternatives.
        label: `Open in ${folderOpenTargetLabel(target, folderTargets.isMac)}`,
        icon: <TargetGlyph target={target} />,
        shortcut: target === 'finder' ? (folderTargets.isMac ? '⌘O' : 'Ctrl+O') : undefined,
        // Remembered, exactly as picking it from the split button's menu is:
        // choosing a target here is the same choice.
        onSelect: () => void folderTargets.openTarget(target, true),
      })
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {/*
       * Truncation priority is encoded in flex-shrink factors so the workspace
       * name — the primary identity — yields last: the folder path (shrink-100)
       * collapses first, then the branch (shrink-10), and the name (default
       * shrink-1) keeps its content until the others are exhausted. Each segment
       * grows to its full content when the bar has room; cropping only kicks in
       * as the cluster approaches the right-side controls.
       *
       * The name also carries a `min-w-[7ch]` floor so identity never fully
       * collapses at the 800px window minimum (or the 600px detached width) under
       * a full control load: path and branch still yield to nothing first, but the
       * name keeps a few legible characters instead of shrinking to a single glyph.
       * The floor is only reachable because the right-side controls condense first
       * (WorkspaceActions View→icon-only, win/linux menu bar→hamburger).
       */}
      {/*
       * The name is an interactive chip (same hover treatment as the project and
       * branch chips) that toggles the sidebar — open when collapsed, close when
       * open. When no toggle handler is supplied it degrades to a plain draggable
       * span so the window keeps a grab area and other mount sites still work.
       */}
      {/*
       * The star is its own control, not a passive badge inside the name chip:
       * filled when starred, a quiet outline when not, and clicking it toggles
       * the same `highlight.starred` the sidebar's context menu drives. It
       * replaces the workspace-type icon that used to lead the cluster — when
       * you're already inside the workspace the mode glyph earned nothing, and
       * highlight identity survives on the name's underline.
       */}
      <span
        className="flex min-w-[7ch] items-center gap-0.5"
        style={highlightHex ? { boxShadow: `inset 0 -1.5px 0 ${highlightHex}` } : undefined}
      >
        <Tooltip content={starred ? 'Unstar workspace' : 'Star workspace'} placement="bottom">
          {/* The kit's 22px icon step (`icon.size.lg`), which is what the
              hand-written `h-[22px] w-[22px]` was, and it pads out to the
              24px hit-target floor with a transparent overlay rather than
              growing the drawn square. `aria-pressed` stays an attribute: the
              `pressed` prop would add the neutral selection fill, and the star
              glyph is already the whole state display. */}
          <IconButton
            size="2xs"
            onClick={() => setWorkspaceHighlight(activeWorkspace.id, { starred: !starred })}
            aria-pressed={starred}
            aria-label={starred ? 'Unstar workspace' : 'Star workspace'}
            className="app-no-drag group/star shrink-0"
          >
            <StarGlyph
              filled={starred}
              stroked={!starred}
              className={`icon-xs shrink-0 transition-colors ${
                starred
                  ? 'text-[color:var(--tone-warn)]'
                  : 'text-[color:var(--text-subtle)] group-hover/star:text-[color:var(--text-default)]'
              }`}
            />
          </IconButton>
        </Tooltip>
        <Tooltip
          content={onToggleSidebar ? (sidebarCollapsed ? 'Open sidebar' : 'Close sidebar') : activeWorkspace.name}
          placement="bottom"
          wrapperClassName="flex min-w-0"
        >
          {onToggleSidebar ? (
            // The kit's one size that spends no height: the name rides the
            // identity line rather than setting it. Ink stays on the span —
            // the tone's `text-*` never reaches it — so the button is the
            // ground and the name is the label.
            <GhostButton
              size="inline"
              onClick={onToggleSidebar}
              // The visible name leads the accessible one (label-in-name): a
              // voice user says what they see, and "Open sidebar" alone hid it.
              aria-label={`${activeWorkspace.name}, ${sidebarCollapsed ? 'open sidebar' : 'close sidebar'}`}
              className="app-no-drag min-w-0"
            >
              <span className="min-w-0 truncate text-body font-semibold text-[color:var(--text-strong)]">
                {activeWorkspace.name}
              </span>
            </GhostButton>
          ) : (
            // The non-interactive twin keeps the control's inset so the name
            // does not shift when there is no sidebar to toggle.
            <span className="flex min-w-0 items-center px-1">
              <span className="min-w-0 truncate text-body font-semibold text-[color:var(--text-strong)]">
                {activeWorkspace.name}
              </span>
            </span>
          )}
        </Tooltip>
      </span>
      {/*
       * Metadata group: project (folder basename) + branch read as one quiet,
       * muted cluster beside the bold name. Separation is spacing only (the
       * cluster's gap) — no separator dots, so the three segments read as evenly
       * spaced peers rather than one dot sitting between only the first pair.
       * Both segments are subtle chips (hover fill, not a resting border) and opt
       * out of the drag region so they stay clickable.
       *
       * At fold 1 they keep the glyph and the ±lines and drop the WORDS — the
       * tooltip was already carrying the full path and the full branch name, so
       * nothing needs a new home yet. At fold 3 they leave the strip entirely
       * for the overflow menu below.
       */}
      {/* A chat that lives on a paired machine has no local folder to chip, so
          its project over there takes that seat, in the folder chip's own
          shape, followed by the machine's mark: the glyph the sidebar row and
          the tab wear, in the machine's colour, named on hover (owner,
          2026-10-08: no tailnet address in the strip, and no second saying of
          the chat's own title, which is all the remote workspace's name is). */}
      {chipsInline && activeWorkspace?.remoteOrigin ? (
        <span
          className="flex min-w-0 shrink-[100] items-center gap-1.5 text-meta text-[color:var(--text-muted)]"
          data-remote-machine={activeWorkspace.remoteOrigin.machineName}
        >
          <Tooltip
            content={
              activeWorkspace.remoteOrigin.workspaceRoot ??
              `On ${shortMachineName(activeWorkspace.remoteOrigin.machineName)}`
            }
            placement="bottom"
            wrapperClassName="flex min-w-0"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              {showChipWords ? (
                <span className="min-w-0 truncate">
                  {remoteProjectName(
                    activeWorkspace.remoteOrigin.workspaceRoot,
                    activeWorkspace.remoteOrigin.machineName,
                  )}
                </span>
              ) : null}
            </span>
          </Tooltip>
          <MachineRowGlyph
            machine={{
              ref: { kind: 'paired', name: activeWorkspace.remoteOrigin.machineName },
              name: activeWorkspace.remoteOrigin.machineName,
            }}
          />
        </span>
      ) : null}
      {chipsInline && folderPath ? (
        filesPanelEnabled ? (
          <Tooltip content={folderPath} placement="bottom" wrapperClassName="flex min-w-0 shrink-[100]">
            <GhostButton
              size="inline"
              onClick={toggleFilesPanel}
              aria-label={`Toggle file explorer, ${folderPath}`}
              className="app-no-drag min-w-0"
            >
              <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              {showChipWords ? <span className="min-w-0 truncate">{projectName}</span> : null}
            </GhostButton>
          </Tooltip>
        ) : (
          // The twin takes the control's gap so the two chips keep one rhythm.
          <span className="flex min-w-0 shrink-[100] items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
            <FolderGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
            {showChipWords ? <span className="min-w-0 truncate">{projectName}</span> : null}
          </span>
        )
      ) : null}
      {chipsInline && branchChipShown ? (
        gitPanelEnabled ? (
          <Tooltip content={branchTooltip} placement="bottom" wrapperClassName="flex min-w-0 shrink-[10]">
            {/* The same inline ghost the files chip takes; the tone's
                `--text-muted` rest ink is the one this chip already spelled. */}
            <GhostButton
              size="inline"
              onClick={toggleGitPanel}
              aria-label={`${branchName ? `Toggle Git panel, branch ${branchName}` : 'Toggle Git panel, detached HEAD'}${chipCopy.spoken}`}
              className="app-no-drag min-w-0"
            >
              {followedMark}
              <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              {showChipWords ? <span className="min-w-0 max-w-[22ch] truncate">{branchName ?? 'detached'}</span> : null}
              {gitCountBadge}
            </GhostButton>
          </Tooltip>
        ) : (
          <Tooltip content={branchTooltip} placement="bottom" wrapperClassName="flex min-w-0 shrink-[10]">
            <span className="flex min-w-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
              {followedMark}
              <GitBranchGlyph className="icon-xs shrink-0 text-[color:var(--text-subtle)]" />
              {showChipWords ? <span className="min-w-0 truncate">{branchName ?? 'detached'}</span> : null}
              {gitCountBadge}
              {/* aria-hidden on the badge above: the numbers read visually, and
                  the words ride along here for AT — the same split the sidebar
                  row's diff stat uses. */}
              {chipCopy.spoken ? <span className="sr-only">{chipCopy.spoken}</span> : null}
            </span>
          </Tooltip>
        )
      ) : null}
      {/*
       * The one action in this cluster, and the only bordered control in it: the
       * chips above are display segments that happen to toggle a panel, so the
       * border is what separates "opens something outside the app" from them.
       * It sits last, next to the branch it will open — the checkout is what the
       * project and branch segments were describing.
       */}
      {openInline && openPath ? <OpenWorkspaceFolderButton targets={folderTargets} /> : null}
      {/*
       * Where every folded segment goes. The strip's answer to "too narrow" is
       * this menu, never a deleted control: at fold 2 it holds the editor
       * targets, at fold 3 the project and branch rows join them. It is absent
       * at fold 0/1 because it would hold nothing.
       */}
      {overflowItems.length > 0 ? (
        <span className="app-no-drag inline-flex shrink-0">
          <OverflowMenu ariaLabel="More workspace controls" triggerTooltip="More" items={overflowItems} />
        </span>
      ) : null}
      {/* Rendered here rather than inside the button so a launch that failed
          from a MENU row still reports itself. */}
      {folderTargets.failureNode}
    </div>
  )
}
