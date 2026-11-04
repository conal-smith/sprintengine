// The active workspace's identity cluster — star toggle, name and branch
// chip — hoisted out of the retired 48px WorkspaceTopBar
// row into the merged AppTitleBar title strip (it fills the title bar's centre
// slot). It is a display surface, not a control group, so it sits outside the
// top-bar-group cap (the TopBar inventory lives in
// scripts/lint-panel-composition.mjs).
//
// The project is not named here (owner ruling 2026-10-16): the sidebar files
// every chat under its project and the composer's context strip names it under
// the prompt, so a third saying in the title bar was clutter — and once it
// stopped opening Files while a chat was followed, an inert one, with no
// tooltip when folded to its glyph.
//
// The star and branch segments are interactive (toggle starred / toggle Git)
// and opt out of the title strip's drag region with
// `app-no-drag`; the name keeps its sidebar-toggle role (or degrades to a
// draggable span) to preserve the window grab area.

import React from 'react'
import { displayBranchName } from '../../utils/branchLabel'
import { GhostButton, IconButton, OverflowMenu, StarGlyph, Tooltip, type OverflowMenuItem } from '../ui'

// The card that says the workspace folder could not be revealed. It exists
// only after a reveal has failed, which is never at first paint, so the card
// (and the lifecycle glyph and inline-notice shell it draws with) is fetched
// when a failure actually has to be shown.
const CursorErrorPopover = React.lazy(() =>
  import('../ui/CursorErrorPopover').then((m) => ({ default: m.CursorErrorPopover })),
)
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
import { folderOpenTargetLabel } from './openInEditorTargets'
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

// Folder glyph for a paired machine's project. Same
// stroke idiom as GitBranchGlyph (1.3px round strokes on a 16px box) so the
// identity chips read as a set.
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

/**
 * `Primary+O` (workspace.folder.reveal): reveal the checkout the branch chip
 * describes in the file manager. The title bar used to carry an "Open in"
 * control for this and for external editors; it went (owner ruling
 * 2026-11-02) and the shortcut stayed, so it routes here rather than calling
 * the IPC from the command, keeping the folder it reveals the one the chip
 * names. Returns the failure card, already positioned, for the caller to
 * render.
 */
function useRevealWorkspaceFolder(workspaceId: string | null, openPath: string): React.ReactNode {
  const [failure, setFailure] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!workspaceId) return
    const reveal = async () => {
      // No resolved checkout means there is nothing to reveal.
      if (!openPath) return
      const label = folderOpenTargetLabel('finder', window.api.platform === 'darwin')
      try {
        const result = await window.api.openFolderInTarget({ target: 'finder', path: openPath })
        if (!result.ok) setFailure(`Could not open ${label}: ${result.message}`)
      } catch (error) {
        // The channel itself failed, which is not one of the typed outcomes;
        // it still has to reach the person who pressed the keys.
        setFailure(`Could not open ${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const onPanelCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; workspaceId?: string }>).detail
      if (detail?.id !== 'workspace.folder.reveal') return
      if (detail.workspaceId && detail.workspaceId !== workspaceId) return
      void reveal()
    }
    window.addEventListener('sprintengine:panel-command', onPanelCommand)
    return () => window.removeEventListener('sprintengine:panel-command', onPanelCommand)
  }, [openPath, workspaceId])

  if (!failure) return null
  // A shortcut has no control to anchor to, so the card sits under the title
  // bar's centre.
  const anchor = { x: window.innerWidth / 2, y: 36 }
  return (
    <React.Suspense fallback={null}>
      <CursorErrorPopover key={failure} message={failure} anchor={anchor} onDismiss={() => setFailure(null)} />
    </React.Suspense>
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
  // fall back to `folderPath` unchanged.
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
  const rawBranchName = followed?.branch ?? gitBranch.branch
  const branchName = rawBranchName ? displayBranchName(rawBranchName) : rawBranchName
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
  // The branch chip doubles as a panel shortcut: it toggles the Git panel —
  // same open/close-on-second-click semantics as the Backlog panel switch. Only
  // offered when the owning capability module is enabled, so we never offer a
  // click that resolves to nothing.
  const gitPanelEnabled = selectModuleEnabled(moduleOverrides, 'git')
  // The branch chip, inline or folded: not while a conversation is followed.
  const branchChipShown = branchIsRepo && !followingConversation
  // Git is a workspace-pane tab (browser-pane epic): the chip keeps its
  // open/close-on-second-click semantics against the pane record.
  const togglePaneKind = useWorkspaceStore((s) => s.togglePaneKind)
  const toggleGitPanel = React.useCallback(() => {
    if (activeWorkspaceId) togglePaneKind(activeWorkspaceId, 'git')
  }, [activeWorkspaceId, togglePaneKind])
  // How much room the strip has left (see titleBarFold): 0 everything inline,
  // 1 the chips keep their glyphs and lose their words, 2 the chips fold into
  // the overflow menu. Nothing is ever deleted — every stage moves a segment,
  // and the menu is where it moves to.
  const fold = useTitleBarFold()
  // The checkout `Primary+O` reveals: the one the branch chip describes — the
  // followed agent's, else the mounted worktree, else the project root — so
  // the two name one tree. Called unconditionally (hooks).
  const revealFailure = useRevealWorkspaceFolder(activeWorkspaceId, gitProbePath ?? '')

  if (!activeWorkspace) return null

  const starred = isStarred(activeWorkspace.highlight)

  // Per-workspace highlight: the retired 48px row tinted its bottom border, but
  // that strip is now the full-width app title bar, where an app-wide bottom
  // tint reads too subtly. Re-home the accent onto the identity cluster itself —
  // the name carries an underline in the highlight colour — so the current
  // workspace's colour stays legible without chroming the whole strip.
  const highlightHex = activeWorkspace.highlight?.color ? getHighlightSwatch(activeWorkspace.highlight.color).hex : null

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

  // The ladder, read once. Each flag is "this segment is still on the strip".
  const showChipWords = fold < 1
  const chipsInline = fold < 2

  // Everything the ladder has taken off the strip, in the order it left. A row
  // here does exactly what the segment it replaces did — the branch row toggles
  // Git — so folding changes where a control is,
  // never what it does. The branch row spells its ±lines out in words: a menu
  // row has the width the chip did not, and this is the one place the count can
  // be read rather than glanced at.
  const overflowItems: OverflowMenuItem[] = []
  if (!chipsInline) {
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

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      {/*
       * Truncation priority is encoded in flex-shrink factors so the workspace
       * name — the primary identity — yields last: a paired machine's project
       * (shrink-100) collapses first, then the branch (shrink-10), and the name (default
       * shrink-1) keeps its content until the others are exhausted. Each segment
       * grows to its full content when the bar has room; cropping only kicks in
       * as the cluster approaches the right-side controls.
       *
       * The name also carries a `min-w-[7ch]` floor so identity never fully
       * collapses at the 800px window minimum (or the 600px detached width) under
       * a full control load: the other segments still yield first, but the
       * name keeps a few legible characters instead of shrinking to a single glyph.
       * The floor is only reachable because the right-side controls condense first
       * (WorkspaceActions View→icon-only, win/linux menu bar→hamburger).
       */}
      {/*
       * The name is an interactive chip (same hover treatment as the branch
       * chip) that toggles the sidebar — open when collapsed, close when
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
       * Metadata: the branch (and a paired machine's project) read as a quiet,
       * muted cluster beside the bold name. Separation is spacing only (the
       * cluster's gap) — no separator dots. The branch is a subtle chip (hover
       * fill, not a resting border) and opts out of the drag region so it stays
       * clickable.
       *
       * At fold 1 the chips keep the glyph and the ±lines and drop the WORDS —
       * the tooltip already carries the full branch name, so nothing needs a new
       * home yet. At fold 2 they leave the strip entirely for the overflow menu
       * below.
       */}
      {/* A chat that lives on a paired machine names its project over there —
          the one fact the sidebar's local project groups cannot say — followed by the machine's mark: the glyph the sidebar row and
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
      {chipsInline && branchChipShown ? (
        gitPanelEnabled ? (
          <Tooltip content={branchTooltip} placement="bottom" wrapperClassName="flex min-w-0 shrink-[10]">
            {/* The inline ghost; the tone's `--text-muted` rest ink is the one
                this chip already spelled. */}
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
       * Where every folded segment goes. The strip's answer to "too narrow" is
       * this menu, never a deleted control: at fold 2 it holds the branch row.
       * It is absent at fold 0/1 because it would hold nothing.
       */}
      {overflowItems.length > 0 ? (
        <span className="app-no-drag inline-flex shrink-0">
          <OverflowMenu ariaLabel="More workspace controls" triggerTooltip="More" items={overflowItems} />
        </span>
      ) : null}
      {revealFailure}
    </div>
  )
}
