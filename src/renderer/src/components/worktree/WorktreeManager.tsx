import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { EMPTY_CHAT_TEMPLATE } from '../../layouts/templates'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { WorktreeEntry as StoredWorktreeEntry } from '../../types/workspace'
import { focusOrAddTerminalTab } from '../../utils/modelRegistry'
import { pathJoin, samePath, trimPath } from '../../utils/paths'
import { slugifyWorktreeName, worktreeContainerPath, worktreeIdFromPath } from '../../utils/workspaceWorktree'
import {
  agentWorktreeCleanupPlan,
  chatsReclaimedBy,
  entriesRemovedBy,
  openWorkspaceIds,
} from '../../utils/agentWorktreeCleanup'
import type {
  AgentWorktreeCleanupEntry,
  AgentWorktreeCleanupReport,
  WorktreePoolHeldAction,
  WorktreePoolSlotView,
  WorktreePoolSnapshot,
} from '../../../../shared/electron-api'
import {
  Checkbox,
  EmptyState,
  Field,
  GhostButton,
  InlineNotice,
  Input,
  LifecycleGlyph,
  OverflowMenu,
  PrimaryButton,
  Select,
  Spinner,
  type LifecycleState,
  type SelectItem,
} from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'

type WorktreeMessage = {
  tone: 'neutral' | 'error' | 'success'
  text: string
}

type WorktreeRow = {
  id: string
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  missing: boolean
  locked: boolean
  lockedReason: string | null
  prunable: boolean
  prunableReason: string | null
  dirtyCount: number | null
  ownerAgentId: string | null
  storedEntry: StoredWorktreeEntry | null
  listedEntry: GitWorktreeEntry | null
}

type Props = {
  workspaceId: string
  /** The checkout git operations run against (add/remove/prune/list). */
  repoRoot: string
  /**
   * The same project, in the app's OWN spelling of the path, for recording on a
   * worktree workspace this manager opens. `repoRoot` above comes from git and
   * is realpath-resolved, which under a symlinked root would not string-match
   * the parent workspace's folderPath — and the worktree would found a project
   * header of its own instead of filing under the project it was cut from.
   */
  projectRoot: string
  currentBranch: string | null
  branchOptions: string[]
  mode?: 'section' | 'tab'
  onChanged: () => Promise<void>
}

const terminalCols = 100
const terminalRows = 30

function branchLabel(row: WorktreeRow): string {
  if (row.branch) return row.branch
  if (row.head) return row.head.slice(0, 8)
  return 'detached'
}

// Status is earned: only the exceptional, action-needing states carry a glyph.
// A clean worktree (and the default checkout) shows no mark — the absence reads
// as "fine", which keeps the list from turning into dot-soup.
function worktreeGlyph(row: WorktreeRow): { state: LifecycleState; label: string } | null {
  if (row.missing) return { state: 'failed', label: 'Missing on disk' }
  if (row.prunable) return { state: 'archived', label: 'Prunable' }
  if (row.locked) return { state: 'paused', label: 'Locked' }
  return null
}

// One muted supporting line of facts that aren't already in the name. Built only
// from signal that earns its place; a clean non-main worktree contributes none,
// so its row is just the branch name.
function worktreeMeta(
  row: WorktreeRow,
  ownerName: string,
  cleanup: CleanupFacts | null,
  poolSlot: WorktreePoolSlotView | null,
): string {
  const parts: string[] = []
  if (row.isMain) parts.push('default checkout')
  const poolNote = poolSlotMeta(poolSlot)
  if (poolNote) parts.push(poolNote)
  else if (row.missing) parts.push('missing')
  else if (row.prunable) parts.push('prunable')
  else if (row.locked) parts.push('locked')
  if (row.dirtyCount && row.dirtyCount > 0) parts.push(`${row.dirtyCount} uncommitted`)
  const cleanupNote = cleanupMeta(cleanup)
  if (cleanupNote) parts.push(cleanupNote)
  if (ownerName !== '-') parts.push(ownerName)
  return parts.join(' · ')
}

type CleanupFacts = { entry: AgentWorktreeCleanupEntry; defaultRef: string | null }

// A worktree pool slot says where it is in the pool rather than "locked": its
// lock is the pool's own bookkeeping. A held one says why, because only a
// person moves it on (the row's menu).
function poolSlotMeta(slot: WorktreePoolSlotView | null): string | null {
  if (!slot) return null
  switch (slot.state) {
    case 'idle':
      return 'in the worktree pool, ready to reuse'
    case 'held': {
      const why =
        slot.held?.reason === 'dirty'
          ? `${slot.held.changedPaths ?? 'some'} uncommitted change${slot.held.changedPaths === 1 ? '' : 's'}`
          : (slot.held?.detail ?? slot.held?.reason ?? 'needs a look')
      return `held in the worktree pool: ${why}`
    }
    case 'leased':
      return null
    default:
      return `worktree pool: ${slot.state}`
  }
}

// What the automatic cleanup made of an agent worktree, when it is something
// the person should know: why it was kept, or that it is due to go. A dirty
// worktree already says "N uncommitted" above, and an in-use one is simply in
// use, so neither adds words here.
function cleanupMeta(cleanup: CleanupFacts | null): string | null {
  if (!cleanup) return null
  const { entry, defaultRef } = cleanup
  switch (entry.verdict) {
    case 'unmerged':
      return `kept: ${entry.uniqueCommits ?? 'some'} commit${entry.uniqueCommits === 1 ? '' : 's'} not on ${defaultRef ?? 'the default branch'}`
    case 'removed':
      return 'merged, will be cleaned up'
    case 'returned':
      return 'unused, will go back to the worktree pool'
    case 'held':
      return `kept in the worktree pool: ${entry.detail ?? 'it holds work'}`
    case 'no-default-branch':
      return 'kept: no default branch to compare with'
    case 'ignored-files':
      return `kept: ignored files that may be work (${entry.detail ?? 'unlisted'})`
    case 'hidden-edits':
      return `kept: edits hidden from git status (${entry.detail ?? 'unlisted'})`
    case 'recent':
      return 'kept: used within the last hour'
    case 'error':
      return 'kept: could not be checked'
    default:
      return null
  }
}

function messageFromResult<T>(result: GitWorktreeOperationResult<T>, success: string): WorktreeMessage {
  if (result.ok) return { tone: 'success', text: result.message ?? success }
  return { tone: 'error', text: result.message }
}

export default function WorktreeManager({
  workspaceId,
  repoRoot,
  projectRoot,
  currentBranch,
  branchOptions,
  mode = 'section',
  onChanged,
}: Props) {
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === workspaceId) ?? null)
  const setWorkspaceWorktreeState = useWorkspaceStore((state) => state.setWorkspaceWorktreeState)
  const upsertWorktreeEntry = useWorkspaceStore((state) => state.upsertWorktreeEntry)
  const removeWorktreeEntry = useWorkspaceStore((state) => state.removeWorktreeEntry)
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace)
  const setActiveWorkspaceForWindow = useWorkspaceStore((state) => state.setActiveWorkspaceForWindow)
  const workspaceWindowId = useWorkspaceStore(
    (state) =>
      state.workspaceWindows.find((windowState) => windowState.workspaceIds.includes(workspaceId))?.id ??
      state.primaryWorkspaceWindowId,
  )
  const dialog = useConfirmDialog()
  const [open, setOpen] = useState(true)
  const [rows, setRows] = useState<WorktreeRow[]>([])
  const [cleanupReport, setCleanupReport] = useState<AgentWorktreeCleanupReport | null>(null)
  const [pool, setPool] = useState<WorktreePoolSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<WorktreeMessage | null>(null)
  const [creating, setCreating] = useState(false)
  const [worktreeName, setWorktreeName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [baseRef, setBaseRef] = useState(currentBranch ?? 'HEAD')
  const [copyIncludedFiles, setCopyIncludedFiles] = useState(true)

  const storedEntries = useMemo(
    () => Object.values(workspace?.worktreeState.entries ?? {}),
    [workspace?.worktreeState.entries],
  )
  const containerPath = workspace?.worktreeState.containerPath ?? worktreeContainerPath(repoRoot)
  // Opening a worktree opens the New chat launch surface in it — the person
  // picks the agent there, and opens the editor and panes as they need them.
  // It used to mint the Solo Dev layout (Editor + one agent), the layout the
  // owner retired with the New workspace hub (2026-09-04).
  const template = EMPTY_CHAT_TEMPLATE

  useEffect(() => {
    if (!baseRef || baseRef === 'HEAD') setBaseRef(currentBranch ?? 'HEAD')
  }, [baseRef, currentBranch])

  useEffect(() => {
    const slug = slugifyWorktreeName(worktreeName)
    if (!slug) {
      setBranchName('')
      return
    }
    setBranchName(`sprintengine/${slug}`)
  }, [worktreeName])

  const refreshWorktrees = useCallback(async () => {
    if (typeof window.api.listGitWorktrees !== 'function') return
    setLoading(true)
    try {
      const result = await window.api.listGitWorktrees(repoRoot)
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message })
        return
      }

      const listedRows = await Promise.all(
        result.data.worktrees.map(async (worktree): Promise<WorktreeRow> => {
          const exists = await window.api.pathExists(worktree.path).catch(() => false)
          let dirtyCount: number | null = null
          if (exists && !worktree.bare) {
            try {
              const status = await window.api.getGitStatus(worktree.path)
              dirtyCount = Object.keys(status.files).length
            } catch {
              dirtyCount = null
            }
          }

          const storedEntry = storedEntries.find((entry) => samePath(entry.path, worktree.path)) ?? null
          return {
            id: storedEntry?.id ?? worktreeIdFromPath(worktree.path),
            path: worktree.path,
            branch: worktree.branch,
            head: worktree.head,
            isMain: samePath(worktree.path, repoRoot),
            missing: !exists,
            // This profile's own agent in-use lock is the app's bookkeeping, not
            // a lock the person placed: it is not shown, and removing the
            // worktree here releases it (main's removeGitWorktree). Another
            // profile's is shown for what it is.
            locked: worktree.locked && worktree.agentLock !== 'this-profile',
            lockedReason:
              worktree.agentLock === 'other-profile'
                ? 'In use by an agent in another SprintEngine Studio profile'
                : worktree.agentLock === 'this-profile'
                  ? null
                  : worktree.lockedReason,
            prunable: worktree.prunable,
            prunableReason: worktree.prunableReason,
            dirtyCount,
            ownerAgentId: storedEntry?.ownerAgentId ?? null,
            storedEntry,
            listedEntry: worktree,
          }
        }),
      )

      const listedPaths = new Set(listedRows.map((row) => trimPath(row.path).toLowerCase()))
      const orphanedRows = (
        await Promise.all(
          storedEntries
            .filter((entry) => !listedPaths.has(trimPath(entry.path).toLowerCase()))
            .map(async (entry): Promise<WorktreeRow | null> => {
              const exists = await window.api.pathExists(entry.path).catch(() => false)
              if (!exists) {
                removeWorktreeEntry(workspaceId, entry.id)
                return null
              }

              return {
                id: entry.id,
                path: entry.path,
                branch: entry.branch,
                head: null,
                isMain: samePath(entry.path, repoRoot),
                missing: true,
                locked: false,
                lockedReason: null,
                prunable: false,
                prunableReason: 'Stored worktree is not listed by Git.',
                dirtyCount: null,
                ownerAgentId: entry.ownerAgentId,
                storedEntry: entry,
                listedEntry: null,
              }
            }),
        )
      ).filter((row): row is WorktreeRow => Boolean(row))

      setRows(
        [...listedRows, ...orphanedRows].sort(
          (a, b) => Number(b.isMain) - Number(a.isMain) || branchLabel(a).localeCompare(branchLabel(b)),
        ),
      )

      if (typeof window.api.getWorktreePoolSnapshot === 'function') {
        setPool(await window.api.getWorktreePoolSnapshot(repoRoot).catch(() => null))
      }

      // What the automatic cleanup would do, without doing it: the kept
      // worktrees (unmerged work, uncommitted changes) are shown here, which
      // is the only place anyone will see why they are still on disk.
      if (typeof window.api.cleanupAgentWorktrees === 'function') {
        const records = useWorkspaceStore.getState()
        const plan = agentWorktreeCleanupPlan(records.workspaces, openWorkspaceIds(records))
        const report = await window.api
          .cleanupAgentWorktrees({
            repoRoot,
            protectedPaths: plan.protectedPaths,
            agentIds: plan.agentIds,
            agentKeys: plan.agentKeys,
            dryRun: true,
          })
          .catch(() => null)
        setCleanupReport(report)
      }
    } finally {
      setLoading(false)
    }
  }, [removeWorktreeEntry, repoRoot, storedEntries, workspaceId])

  useEffect(() => {
    void refreshWorktrees()
  }, [refreshWorktrees])

  // A slot leased, returned or held while the manager is open.
  useEffect(() => {
    if (typeof window.api.onWorktreePoolChanged !== 'function') return
    return window.api.onWorktreePoolChanged((snapshot) => {
      if (samePath(snapshot.repoRoot, repoRoot)) setPool(snapshot)
    })
  }, [repoRoot])

  const runWorktreeAction = async (label: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(label)
    setMessage({ tone: 'neutral', text: `${label}…` })
    try {
      await action()
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const handleCreate = async () => {
    const slug = slugifyWorktreeName(worktreeName)
    const branch = branchName.trim()
    if (!slug || !branch) {
      setMessage({ tone: 'error', text: 'Enter a worktree name and branch.' })
      return
    }

    await runWorktreeAction('Creating worktree', async () => {
      const destinationPath = pathJoin(containerPath, slug)
      setWorkspaceWorktreeState(workspaceId, { containerPath })
      const result = await window.api.createGitWorktree({
        repoRoot,
        containerPath,
        destinationPath,
        branchName: branch,
        baseRef: baseRef.trim() || 'HEAD',
        copyIncludedFiles,
      })
      setMessage(messageFromResult(result, 'Created worktree.'))
      if (!result.ok) return

      const now = Date.now()
      upsertWorktreeEntry(workspaceId, {
        id: worktreeIdFromPath(result.data.path),
        path: result.data.path,
        branch: result.data.branch ?? branch,
        ownerAgentId: null,
        status: 'available',
        createdAt: now,
        updatedAt: now,
      })
      setWorktreeName('')
      setBranchName('')
      setCreating(false)
      await refreshWorktrees()
      await onChanged()
    })
  }

  const handlePrune = async () => {
    await runWorktreeAction('Pruning stale worktrees', async () => {
      const result = await window.api.pruneGitWorktrees(repoRoot)
      setMessage(messageFromResult(result, 'Pruned stale worktree metadata.'))
      if (result.ok) {
        await refreshWorktrees()
        await onChanged()
      }
    })
  }

  const handleReveal = async (row: WorktreeRow) => {
    await runWorktreeAction('Revealing worktree', async () => {
      await window.api.showItemInFolder(row.path)
      setMessage({ tone: 'success', text: 'Revealed worktree path.' })
    })
  }

  const handleOpenWorkspace = (row: WorktreeRow) => {
    const workspaceName = `Worktree: ${branchLabel(row)}`
    const nextWorkspaceId = addWorkspace(template, {
      name: workspaceName,
      folderPath: row.path,
      // Flag the workspace as worktree-backed so its Git view and terminal glyph
      // treat it as a worktree (its folderPath already IS the worktree), and
      // record the checkout it was cut from so the sidebar files it under that
      // project rather than founding a header named after the worktree.
      worktree: { branch: row.branch ?? undefined, repoRoot: projectRoot },
      windowId: workspaceWindowId,
    })
    setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)
  }

  const handleOpenTerminal = async (row: WorktreeRow) => {
    await runWorktreeAction('Opening terminal', async () => {
      const terminalId = `worktree-${row.id}`
      const result = await window.api.terminalSpawn(
        `terminal-${terminalId}`,
        terminalCols,
        terminalRows,
        row.path,
        false,
        undefined,
        undefined,
        undefined,
        true,
        {
          kind: 'terminal',
          workspaceId,
          terminalId,
        },
      )
      if (!result.ok) {
        setMessage({ tone: 'error', text: result.message })
        return
      }
      focusOrAddTerminalTab(workspaceId, terminalId, `WT ${branchLabel(row)}`)
      setMessage({ tone: 'success', text: 'Opened terminal in worktree.' })
    })
  }

  const handleRemove = async (row: WorktreeRow) => {
    const force = Boolean(row.dirtyCount && row.dirtyCount > 0)
    if (force) {
      const confirmation = await dialog.prompt({
        title: 'Force remove worktree?',
        body: (
          <>
            Worktree <span className="font-mono">{branchLabel(row)}</span> has uncommitted changes. Removing it will
            discard those changes. Type <span className="font-mono">remove</span> to confirm.
          </>
        ),
        inputLabel: 'Type "remove" to confirm',
        placeholder: 'remove',
        required: true,
        confirmLabel: 'Force remove',
        tone: 'danger',
        validate: (value) => (value.trim() === 'remove' ? null : 'Type "remove" exactly to confirm'),
      })
      if (confirmation === null || confirmation.trim() !== 'remove') {
        setMessage({ tone: 'neutral', text: 'Remove cancelled.' })
        return
      }
    }

    await runWorktreeAction('Removing worktree', async () => {
      const result = await window.api.removeGitWorktree({ repoRoot, path: row.path, force })
      setMessage(messageFromResult(result, 'Removed worktree.'))
      if (!result.ok) return
      if (row.storedEntry) removeWorktreeEntry(workspaceId, row.storedEntry.id)
      await refreshWorktrees()
      await onChanged()
    })
  }

  // A held pool worktree moves on only on a person's word: commit or stash keep
  // its changes, discard drops them, keep takes it out of the pool as it is.
  // Each but keep returns it to the pool for the next agent.
  const handlePoolHeldAction = async (row: WorktreeRow, slot: WorktreePoolSlotView, action: WorktreePoolHeldAction) => {
    if (action === 'discard') {
      const confirmed = await dialog.confirm({
        title: 'Discard the changes?',
        body: (
          <>
            The uncommitted changes in <span className="font-mono">{slot.held?.branch ?? branchLabel(row)}</span> are
            deleted, and the worktree goes back to the pool. Commits on the branch are kept.
          </>
        ),
        confirmLabel: 'Discard changes',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    const labels: Record<WorktreePoolHeldAction, string> = {
      commit: 'Committing the changes',
      stash: 'Stashing the changes',
      discard: 'Discarding the changes',
      keep: 'Keeping the worktree',
    }
    await runWorktreeAction(labels[action], async () => {
      const result = await window.api.worktreePoolAction({ kind: 'held', repoRoot, slotId: slot.id, action })
      setMessage(
        result.ok ? { tone: 'success', text: result.message ?? 'Done.' } : { tone: 'error', text: result.message },
      )
      await refreshWorktrees()
    })
  }

  // Asked first, in the words Settings ▸ Worktrees uses for the same removal.
  const handlePoolEvict = async (slot: WorktreePoolSlotView) => {
    const confirmed = await dialog.confirm({
      title: `Remove ${slot.id}?`,
      body: (
        <p>
          Deletes the folder. It has no uncommitted changes. The next chat gets a new worktree, with no dependencies
          installed.
        </p>
      ),
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!confirmed) return
    await runWorktreeAction('Removing the pooled worktree', async () => {
      const result = await window.api.worktreePoolAction({ kind: 'evict', repoRoot, slotId: slot.id })
      setMessage(
        result.ok ? { tone: 'success', text: result.message ?? 'Removed.' } : { tone: 'error', text: result.message },
      )
      await refreshWorktrees()
      await onChanged()
    })
  }

  // Another profile's agent lock is lifted only here, on a person's word: that
  // profile may be running an agent in it right now, or may be long gone.
  const handleUnlockAgentLock = async (row: WorktreeRow) => {
    const confirmed = await dialog.confirm({
      title: 'Release the agent lock?',
      body: (
        <>
          Worktree <span className="font-mono">{branchLabel(row)}</span> is locked by an agent in another SprintEngine
          Studio profile. Release it only if that profile no longer uses it: once released, this profile may remove it.
        </>
      ),
      confirmLabel: 'Release lock',
      tone: 'danger',
    })
    if (!confirmed) return
    await runWorktreeAction('Releasing agent lock', async () => {
      const result = await window.api.unlockAgentGitWorktree(repoRoot, row.path)
      setMessage(messageFromResult(result, 'Released the agent lock.'))
      if (!result.ok) return
      await refreshWorktrees()
    })
  }

  // The same sweep the app runs unattended (useAgentWorktreeCleanup), run now.
  const handleCleanup = async () => {
    await runWorktreeAction('Cleaning up merged agent worktrees', async () => {
      const store = useWorkspaceStore.getState()
      const plan = agentWorktreeCleanupPlan(store.workspaces, openWorkspaceIds(store))
      const report = await window.api.cleanupAgentWorktrees({
        repoRoot,
        protectedPaths: plan.protectedPaths,
        agentIds: plan.agentIds,
        agentKeys: plan.agentKeys,
        keepBranches: plan.keepBranches,
      })
      const after = useWorkspaceStore.getState()
      for (const [ownerWorkspaceId, entryId] of entriesRemovedBy(after.workspaces, report)) {
        removeWorktreeEntry(ownerWorkspaceId, entryId)
      }
      const reclaimedAt = Date.now()
      for (const chatId of chatsReclaimedBy(after.workspaces, report)) {
        after.setWorkspaceWorktreeReclaimed(chatId, reclaimedAt)
      }
      const removed = report.entries.filter((entry) => entry.verdict === 'removed').length
      const returned = report.entries.filter((entry) => entry.verdict === 'returned').length
      const branches = report.deletedBranches?.length ?? 0
      const kept = report.entries.filter(
        (entry) =>
          entry.verdict === 'dirty' ||
          entry.verdict === 'unmerged' ||
          entry.verdict === 'ignored-files' ||
          entry.verdict === 'hidden-edits',
      ).length
      setMessage({
        tone: 'neutral',
        text:
          `${removed === 0 ? 'No agent worktree was ready to remove' : `Removed ${removed} merged agent worktree${removed === 1 ? '' : 's'}`}` +
          (returned > 0 ? `; returned ${returned} to the worktree pool` : '') +
          (branches > 0 ? `; deleted ${branches} merged agent branch${branches === 1 ? '' : 'es'}` : '') +
          (kept > 0 ? `; kept ${kept} holding work that is not on the default branch.` : '.'),
      })
      await refreshWorktrees()
      await onChanged()
    })
  }

  const formDisabled = Boolean(busy) || loading
  const contentOpen = mode === 'tab' || open
  const sectionClassName = mode === 'tab' ? 'min-h-0' : 'mb-5 border-b border-[color:var(--border-subtle)] pb-4'

  const onlyMain = rows.length === 1 && rows[0].isMain
  const canCreate = !formDisabled && Boolean(worktreeName.trim()) && Boolean(branchName.trim())

  return (
    <section className={sectionClassName}>
      <div className="mb-2 flex h-7 items-center justify-between gap-2">
        {mode === 'tab' ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-meta font-semibold text-[color:var(--text-strong)]">Worktrees</span>
            <span className="text-micro tabular-nums text-[color:var(--text-subtle)]">{rows.length}</span>
          </div>
        ) : (
          // A heading that opens a section: `inline` spends no height, and `ink`
          // takes no ground, so the section title still reads as a heading.
          <GhostButton
            size="inline"
            align="start"
            tone="ink"
            onClick={() => setOpen((current) => !current)}
            className="group min-w-0"
            aria-expanded={open}
          >
            <svg
              viewBox="0 0 12 12"
              aria-hidden="true"
              className={`icon-xs shrink-0 text-[color:var(--text-subtle)] transition-transform group-hover:text-[color:var(--text-default)] ${open ? 'rotate-90' : ''}`}
              fill="none"
            >
              <path
                d="M4.25 2.5 7.75 6l-3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-meta font-semibold text-[color:var(--text-strong)]">Worktrees</span>
            <span className="text-micro tabular-nums text-[color:var(--text-subtle)]">{rows.length}</span>
          </GhostButton>
        )}
        {contentOpen ? (
          <div className="flex shrink-0 items-center gap-1">
            <GhostButton
              size="xs"
              onClick={() => setCreating((current) => !current)}
              disabled={formDisabled}
              aria-expanded={creating}
            >
              {creating ? 'Cancel' : '+ New worktree'}
            </GhostButton>
            <OverflowMenu
              ariaLabel="Worktree list actions"
              items={[
                { id: 'refresh', label: 'Refresh', onSelect: () => void refreshWorktrees(), disabled: formDisabled },
                {
                  id: 'prune',
                  label: 'Prune stale metadata',
                  onSelect: () => void handlePrune(),
                  disabled: formDisabled,
                },
                {
                  id: 'cleanup',
                  label: 'Clean up merged agent worktrees',
                  onSelect: () => void handleCleanup(),
                  disabled: formDisabled || typeof window.api.cleanupAgentWorktrees !== 'function',
                },
              ]}
            />
          </div>
        ) : null}
      </div>

      {contentOpen ? (
        <>
          {creating ? (
            <div className="mb-3 space-y-3 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3">
              <Field label="Name" htmlFor="worktree-name" help="Folder name under the worktree container.">
                <Input
                  variant="well"
                  value={worktreeName}
                  onChange={(event) => setWorktreeName(event.target.value)}
                  disabled={formDisabled}
                  placeholder="feature-login"
                  className="min-w-0"
                />
              </Field>
              <Field label="Branch" htmlFor="worktree-branch">
                <Input
                  variant="well"
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  disabled={formDisabled}
                  placeholder="sprintengine/feature-login"
                  className="min-w-0 font-mono"
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <Field.Label>Base ref</Field.Label>
                <Select<string>
                  ariaLabel="Worktree base ref"
                  items={[
                    { value: 'HEAD', label: 'HEAD' },
                    ...branchOptions.map((branch): SelectItem<string> => ({ value: branch, label: branch })),
                  ]}
                  value={baseRef}
                  onChange={setBaseRef}
                  disabled={formDisabled}
                  className="w-full"
                />
              </div>
              <Checkbox
                checked={copyIncludedFiles}
                onChange={setCopyIncludedFiles}
                disabled={formDisabled}
                label="Copy .worktreeinclude files"
                className="w-fit"
              />
              <div className="flex items-center justify-end gap-1.5 pt-0.5">
                <GhostButton onClick={() => setCreating(false)} disabled={formDisabled}>
                  Cancel
                </GhostButton>
                <PrimaryButton onClick={() => void handleCreate()} disabled={!canCreate}>
                  Create worktree
                </PrimaryButton>
              </div>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 px-1 py-3 text-micro text-[color:var(--text-subtle)]">
              <Spinner size={14} label="Loading worktrees" />
              Loading worktrees…
            </div>
          ) : rows.length === 0 ? (
            <EmptyState density="list" title="No worktrees reported by Git." />
          ) : (
            <ul role="list" className="-mx-1 space-y-0.5">
              {rows.map((row) => {
                const ownerName = row.ownerAgentId
                  ? (workspace?.agents[row.ownerAgentId]?.name ?? row.ownerAgentId)
                  : '-'
                const canUsePath = !row.missing && Boolean(row.listedEntry)
                // The pool owns its slots: one is removed through the pool, or
                // git and the pool's record would disagree about it.
                const poolSlot = pool?.slots.find((slot) => samePath(slot.path, row.path)) ?? null
                const canRemove = !row.isMain && Boolean(row.listedEntry) && !row.locked && !poolSlot
                const glyph = poolSlot && poolSlot.state !== 'held' ? null : worktreeGlyph(row)
                const cleanupEntry = cleanupReport?.entries.find((entry) => samePath(entry.path, row.path)) ?? null
                const meta = worktreeMeta(
                  row,
                  ownerName,
                  cleanupEntry ? { entry: cleanupEntry, defaultRef: cleanupReport?.defaultRef ?? null } : null,
                  poolSlot,
                )
                const reason = poolSlot
                  ? (poolSlot.held?.detail ?? undefined)
                  : (row.lockedReason ?? row.prunableReason ?? undefined)
                const poolItems =
                  poolSlot?.state === 'held'
                    ? [
                        { kind: 'separator' as const, id: 'pool-sep' },
                        ...(['commit', 'stash', 'discard', 'keep'] as const).map((action) => ({
                          id: `pool-${action}`,
                          label: {
                            commit: 'Commit changes and return to the pool',
                            stash: 'Stash changes and return to the pool',
                            discard: 'Discard changes and return to the pool…',
                            keep: 'Keep as an ordinary worktree',
                          }[action],
                          destructive: action === 'discard',
                          onSelect: () => void handlePoolHeldAction(row, poolSlot, action),
                          disabled: formDisabled,
                        })),
                      ]
                    : poolSlot?.state === 'idle'
                      ? [
                          { kind: 'separator' as const, id: 'pool-sep' },
                          {
                            id: 'pool-evict',
                            label: 'Remove from the worktree pool…',
                            destructive: true,
                            onSelect: () => void handlePoolEvict(poolSlot),
                            disabled: formDisabled,
                          },
                        ]
                      : []
                return (
                  <li
                    key={`${row.id}:${row.path}`}
                    className="group/wt flex min-h-[36px] items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[color:var(--bg-hover)]"
                  >
                    <span
                      className="flex w-4 shrink-0 items-center justify-center self-start pt-1"
                      title={glyph ? (reason ?? glyph.label) : undefined}
                    >
                      {glyph ? <LifecycleGlyph state={glyph.state} live={false} label={glyph.label} /> : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate font-mono text-meta ${
                          row.missing
                            ? 'text-[color:var(--text-subtle)] line-through decoration-[color:var(--text-subtle)]'
                            : 'text-[color:var(--text-default)]'
                        }`}
                        title={row.path}
                      >
                        {branchLabel(row)}
                      </div>
                      {meta ? (
                        <div className="truncate text-micro text-[color:var(--text-subtle)]" title={reason}>
                          {meta}
                        </div>
                      ) : null}
                    </div>
                    <span className="shrink-0 opacity-60 transition-opacity group-hover/wt:opacity-100 focus-within:opacity-100">
                      <OverflowMenu
                        ariaLabel={`Actions for worktree ${branchLabel(row)}`}
                        items={[
                          {
                            id: 'reveal',
                            label: 'Reveal in file manager',
                            onSelect: () => void handleReveal(row),
                            disabled: formDisabled || !canUsePath,
                          },
                          {
                            id: 'terminal',
                            label: 'Open terminal here',
                            onSelect: () => void handleOpenTerminal(row),
                            disabled: formDisabled || !canUsePath,
                          },
                          {
                            id: 'workspace',
                            label: 'Open as workspace',
                            onSelect: () => handleOpenWorkspace(row),
                            disabled: formDisabled || !canUsePath,
                          },
                          { kind: 'separator', id: 'sep' },
                          ...(row.listedEntry?.agentLock === 'other-profile'
                            ? [
                                {
                                  id: 'unlock',
                                  label: 'Release agent lock…',
                                  onSelect: () => void handleUnlockAgentLock(row),
                                  disabled: formDisabled,
                                },
                              ]
                            : []),
                          {
                            id: 'remove',
                            label: 'Remove worktree',
                            destructive: true,
                            onSelect: () => void handleRemove(row),
                            disabled: formDisabled || !canRemove,
                          },
                          ...poolItems,
                        ]}
                      />
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {!loading && onlyMain ? (
            <p className="mt-1 px-1 text-micro text-[color:var(--text-subtle)]">
              Only the default checkout. Create a worktree to run an agent on a branch in parallel.
            </p>
          ) : null}

          {message ? (
            message.tone === 'error' ? (
              <InlineNotice tone="error" className="mt-2 [overflow-wrap:anywhere]">
                {message.text}
              </InlineNotice>
            ) : (
              // Success and neutral outcomes are copy, not notices: the notice
              // vocabulary has no info or success tone (ui/InlineNotice).
              <p role="status" className="mt-2 px-1 text-meta text-[color:var(--text-muted)] [overflow-wrap:anywhere]">
                {message.text}
              </p>
            )
          ) : null}
        </>
      ) : null}
    </section>
  )
}
