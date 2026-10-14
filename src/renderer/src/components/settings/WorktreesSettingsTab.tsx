import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import {
  DEFAULT_WORKTREE_POOL_SETTINGS,
  dependencyInstallSettingFor,
  WORKTREE_INSTALL_COMMAND_MAX,
  WORKTREE_POOL_DISK_LIMIT_CHOICES_GB,
  WORKTREE_POOL_KEEP_IDLE_MAX,
  WORKTREE_POOL_MAX_SLOTS_CEILING,
  WORKTREE_POOL_MAX_SLOTS_MIN,
  type WorktreeDependencyInstallSetting,
  type WorktreeDependencyInstallView,
  type WorktreeInventory,
  type WorktreePoolActionInput,
  type WorktreePoolHeldAction,
  type WorktreePoolSettings,
} from '../../../../shared/ipc/worktree-pool'
import {
  sanitizeWorktreeBranchPrefix,
  worktreeBranchExample,
  worktreeBranchPrefixWarning,
} from '../../../../shared/worktree-branch'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ChevronDownIcon } from '../AppIcons'
import { samePath } from '../../utils/paths'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import {
  ActionResultMessage,
  Badge,
  Checkbox,
  DefinitionList,
  EmptyState,
  FrontTruncatedText,
  IconButton,
  InlineNotice,
  Input,
  OverflowMenu,
  RefreshIcon,
  SegmentedControl,
  Select,
  SettingCard,
  SettingRow,
  Spinner,
  Tooltip,
  useConfirmDialog,
  type ActionResult,
  type DefinitionItem,
  type OverflowMenuItem,
} from '../ui'
import { DangerButton, GhostButton, OutlineButton, PrimaryButton } from '../ui/Buttons'
import { Table } from '../ui/Table'
import { SettingToggle, SettingsPageHeader, SettingsSectionTitle } from './SettingsAtoms'
import { FreeSpaceDialog } from './WorktreesFreeSpaceDialog'
import {
  applyInstallChange,
  buildWorktreeProjects,
  formatBytes,
  installAt,
  inventoryRootsOf,
  partLabel,
  rowMatches,
  withDependencyInstall,
  worktreeTotals,
  type WorktreeFilter,
  type WorktreeProjectView,
  type WorktreeRow,
} from './worktreesSettingsModel'

/**
 * Settings ▸ Worktrees (owner, 2026-10-05): every worktree Studio's agents
 * work in, where it is, who has it, and what it costs on disk; the pool's
 * settings; and the ways to give the space back.
 *
 * The page reads main's inventory (worktree-pool/worktree-inventory.ts) and
 * never runs git itself. Sizes come from the last measurement until the page
 * measures again: once when it opens, and on the refresh button. Every removal
 * goes through the pool (a slot) or its checked removal (anything else), each
 * of which checks the worktree again before it touches it.
 */

const KEEP_IDLE_ITEMS = Array.from({ length: WORKTREE_POOL_KEEP_IDLE_MAX + 1 }, (_, n) => ({
  value: String(n),
  label: n === 0 ? 'None' : String(n),
}))
const MAX_SLOT_ITEMS = [2, 4, 6, 8, 12, 16, 24, WORKTREE_POOL_MAX_SLOTS_CEILING]
  .filter((n) => n >= WORKTREE_POOL_MAX_SLOTS_MIN)
  .map((n) => ({ value: String(n), label: String(n) }))
const DISK_LIMIT_ITEMS = [
  { value: 'none', label: 'No limit' },
  ...WORKTREE_POOL_DISK_LIMIT_CHOICES_GB.map((gb) => ({ value: String(gb), label: `${gb} GB` })),
]

const STATE_TONE = {
  'in-use': 'accent',
  busy: 'neutral',
  held: 'warn',
  ready: 'neutral',
  other: 'neutral',
  missing: 'error',
} as const

const USAGE_SEGMENTS = [
  { key: 'inUse', label: 'In use', color: 'var(--tone-accent)' },
  { key: 'ready', label: 'Ready to reuse', color: 'var(--tone-neutral)' },
  { key: 'held', label: 'Holding work', color: 'var(--tone-warn)' },
  { key: 'other', label: 'Not in the pool', color: 'var(--tone-merged)' },
] as const

/**
 * The last inventory this window read, kept while the window lives: closing
 * Settings and opening it again draws what was there at once and refreshes
 * underneath, instead of a blank page while git reads every worktree again.
 */
let lastInventory: WorktreeInventory | null = null

/** Forget the kept inventory, so one test's page does not open on another's. */
export function forgetWorktreeInventoryForTests(): void {
  lastInventory = null
}

/** Sizes measured this recently are shown as they are; opening the page measures only older ones. */
const SIZES_FRESH_MS = 15 * 60_000

function hasApi(): boolean {
  return typeof window.api?.getWorktreeInventory === 'function'
}

export function WorktreesSettingsTab({
  onOpenChat,
}: {
  /** Leave Settings for this chat. */
  onOpenChat: (id: string) => void
}): React.JSX.Element {
  const dialog = useConfirmDialog()
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [inventory, setInventory] = useState<WorktreeInventory | null>(() => lastInventory)
  const [settings, setSettings] = useState<WorktreePoolSettings>(DEFAULT_WORKTREE_POOL_SETTINGS)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [filter, setFilter] = useState<WorktreeFilter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [freeOpen, setFreeOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // Dependency installs running in leased worktrees, by worktree; shown on its row with Cancel.
  const [installs, setInstalls] = useState<ReadonlyMap<string, WorktreeDependencyInstallView>>(new Map())
  const mounted = useRef(true)
  // Each read is numbered, and an answer older than one already applied is
  // dropped: a slow read answered after a quicker, later one would otherwise
  // put an older picture back.
  const latestRead = useRef(0)
  const appliedRead = useRef(0)
  // Measurements in flight. Their answer reads the pools after measuring, so
  // a change announced meanwhile needs no read of its own.
  const measuringNow = useRef(0)

  const read = useCallback(async (measure: boolean) => {
    if (!hasApi()) return
    // The projects are read from the store at the moment of asking, not
    // subscribed to: a background agent's write elsewhere must not re-read
    // every worktree.
    const repoRoots = inventoryRootsOf(useWorkspaceStore.getState().workspaces)
    const sequence = ++latestRead.current
    if (measure) {
      measuringNow.current += 1
      setMeasuring(true)
    }
    try {
      const next = await window.api.getWorktreeInventory({ repoRoots, measure })
      if (!mounted.current) return
      if (sequence < appliedRead.current) {
        // A measurement overtaken by a quicker read: its sizes are kept in
        // main now, and one more quick read brings them in.
        if (measure) void read(false)
        return
      }
      appliedRead.current = sequence
      lastInventory = next
      setInventory(next)
      setLoadError(null)
      setNow(Date.now())
    } catch (error) {
      if (mounted.current && sequence >= appliedRead.current) {
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (measure) measuringNow.current -= 1
      if (measure && mounted.current && measuringNow.current === 0) setMeasuring(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    // Fast first (what is known), then measured, unless the sizes on hand
    // are recent: `du` over every worktree is the slow part of opening.
    void read(false).then(() => {
      const measuredAt = lastInventory?.measuredAt ?? null
      if (measuredAt === null || Date.now() - measuredAt > SIZES_FRESH_MS) void read(true)
    })
    void window.api
      ?.getWorktreePoolSettings?.()
      .then((value) => mounted.current && setSettings(value))
      // The controls below would otherwise show the defaults as if they were saved.
      .catch(
        (error: unknown) =>
          mounted.current &&
          setResult({
            tone: 'error',
            text: `Could not read the pool's settings: ${error instanceof Error ? error.message : String(error)}`,
          }),
      )
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.api?.onWorktreePoolChanged?.(() => {
      // A measurement under way answers with the pools as they are after it.
      if (measuringNow.current > 0) return
      // A lease or a return moves several records in a row; one re-read covers them.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void read(false), 400)
    })
    return () => {
      mounted.current = false
      if (timer) clearTimeout(timer)
      unsubscribe?.()
    }
  }, [read])

  useEffect(() => {
    let live = true
    const unsubscribe = window.api?.onWorktreeInstallChanged?.((view) => {
      setInstalls((current) => applyInstallChange(current, view))
    })
    void window.api
      ?.listWorktreeInstalls?.()
      .then((views) => {
        if (live) setInstalls((current) => views.reduce(applyInstallChange, current))
      })
      // Installs still show as they start and end (the subscription above);
      // only one already running when the page opened is missed.
      .catch((error: unknown) => console.warn('[worktrees] could not list the running installs', error))
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [])

  const projects = useMemo(
    () => (inventory ? buildWorktreeProjects(inventory, workspaces, now) : []),
    [inventory, workspaces, now],
  )
  const totals = useMemo(() => worktreeTotals(projects), [projects])
  const rowsByKey = useMemo(() => {
    const map = new Map<string, WorktreeRow>()
    for (const project of projects) for (const row of [...project.poolRows, ...project.otherRows]) map.set(row.key, row)
    return map
  }, [projects])
  const selectedRows = [...selected].map((key) => rowsByKey.get(key)).filter((row): row is WorktreeRow => !!row)

  const updateSettings = async (patch: Partial<WorktreePoolSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
    try {
      setSettings(await window.api.setWorktreePoolSettings(patch))
      // A lower limit removes worktrees at once.
      void read(false)
    } catch (error) {
      setResult({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  // Off means no idle slot is kept (the pool's limit drops to none), so every
  // ready worktree is removed at once: said, and asked, before it happens.
  const setPoolEnabled = async (enabled: boolean) => {
    if (!enabled && totals.ready > 0) {
      const confirmed = await dialog.confirm({
        title: 'Stop reusing worktrees?',
        body: (
          <p>
            The {totals.ready} ready worktree{totals.ready === 1 ? ' is' : 's are'} removed now
            {totals.bytes.ready ? `, freeing up to ${formatBytes(totals.bytes.ready)}` : ''}, except any holding a
            chat&apos;s history or files that may be someone&apos;s work. Worktrees in use or holding changes stay. New
            chats get a fresh worktree, with no dependencies installed.
          </p>
        ),
        confirmLabel: 'Turn off and remove',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    await updateSettings({ enabled })
  }

  const updateInstall = (repoRoot: string, setting: WorktreeDependencyInstallSetting) =>
    void updateSettings({ dependencyInstall: withDependencyInstall(settings.dependencyInstall, repoRoot, setting) })

  const cancelInstall = async (install: WorktreeDependencyInstallView) => {
    const stopped = await window.api.cancelWorktreeInstall(install.id).catch(() => false)
    setResult(
      stopped
        ? { tone: 'info', text: `Stopped ${install.command}. The agent starts without it.` }
        : { tone: 'info', text: 'That install had already ended.' },
    )
  }

  /** Run one step against a worktree, the row marked busy meanwhile, and say how it went. */
  const run = async (
    keys: string[],
    step: () => Promise<{ ok: boolean; message?: string | null }>,
    done: string,
  ): Promise<boolean> => {
    setBusy((current) => new Set([...current, ...keys]))
    try {
      const outcome = await step()
      setResult(
        outcome.ok
          ? { tone: 'info', text: outcome.message || done }
          : { tone: 'error', text: outcome.message || 'That did not work.' },
      )
      return outcome.ok
    } catch (error) {
      setResult({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      if (mounted.current) {
        setBusy((current) => new Set([...current].filter((key) => !keys.includes(key))))
        setSelected((current) => new Set([...current].filter((key) => !keys.includes(key))))
        void read(false)
      }
    }
  }

  const poolAction = (row: WorktreeRow, input: WorktreePoolActionInput, done: string) =>
    run([row.key], () => window.api.worktreePoolAction(input), done)

  const removeOne = (row: WorktreeRow) =>
    row.removal === 'evict' && row.slot
      ? window.api.worktreePoolAction({ kind: 'evict', repoRoot: row.repoRoot, slotId: row.slot.id })
      : window.api.removeOtherWorktree({ repoRoot: row.repoRoot, path: row.path })

  const confirmRemove = async (row: WorktreeRow) => {
    const unmerged = row.entry?.merged === false && row.branch
    const confirmed = await dialog.confirm({
      title: `Remove ${row.name}?`,
      body: (
        <p>
          Deletes the folder{row.bytes ? ` and frees ${formatBytes(row.bytes)}` : ''}. It has no uncommitted changes.{' '}
          {unmerged
            ? `The branch ${row.branch} and its ${row.entry?.uniqueCommits ?? ''} commits not on the default branch are kept.`
            : row.slot
              ? 'The next chat gets a new worktree, with no dependencies installed.'
              : row.branch
                ? `The branch ${row.branch} is kept.`
                : ''}
        </p>
      ),
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!confirmed) return
    await run([row.key], () => removeOne(row), `Removed ${row.name}.`)
  }

  const removeSelected = async () => {
    const rows = selectedRows.filter((row) => row.removal === 'evict' || row.removal === 'remove')
    if (rows.length === 0) return
    const bytes = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
    const confirmed = await dialog.confirm({
      title: `Remove ${rows.length} worktree${rows.length === 1 ? '' : 's'}?`,
      body: (
        <p>
          Deletes their folders{bytes ? ` and frees ${formatBytes(bytes)}` : ''}. None has uncommitted changes, and
          their branches are kept.
        </p>
      ),
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!confirmed) return
    await removeRows(rows)
  }

  const removeRows = async (rows: WorktreeRow[]) => {
    const failures: string[] = []
    await run(
      rows.map((row) => row.key),
      async () => {
        for (const row of rows) {
          const outcome = await removeOne(row)
          if (!outcome.ok) failures.push(`${row.name}: ${outcome.message ?? 'not removed'}`)
        }
        return failures.length
          ? { ok: false, message: `Removed ${rows.length - failures.length}. ${failures.join(' ')}` }
          : { ok: true }
      },
      `Removed ${rows.length} worktree${rows.length === 1 ? '' : 's'}.`,
    )
  }

  const clearIgnored = async (row: WorktreeRow, ask = true) => {
    if (!row.slot) return
    if (ask) {
      const confirmed = await dialog.confirm({
        title: `Clear ignored files in ${row.name}?`,
        body: (
          <p>
            Deletes its installed dependencies and build output (everything git ignores). The worktree stays in the
            pool; the next agent in it runs the install from the start.
          </p>
        ),
        confirmLabel: 'Clear',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    await poolAction(row, { kind: 'clear-ignored', repoRoot: row.repoRoot, slotId: row.slot.id }, 'Cleared.')
  }

  const heldAction = async (row: WorktreeRow, action: WorktreePoolHeldAction) => {
    if (!row.slot) return
    let message: string | undefined
    if (action === 'commit') {
      const value = await dialog.prompt({
        title: `Commit the changes in ${row.name}`,
        body: <p>Commits everything in it on {row.branch ?? 'its branch'}, then the worktree goes back to the pool.</p>,
        inputLabel: 'Commit message',
        initialValue: 'Work left in a pooled worktree',
        required: true,
        confirmLabel: 'Commit',
      })
      if (value === null) return
      message = value
    }
    if (action === 'discard') {
      const confirmed = await dialog.confirm({
        title: `Discard the changes in ${row.name}?`,
        body: (
          <p>
            Its uncommitted changes and untracked files are deleted, and the worktree goes back to the pool. Commits on
            the branch are kept. This cannot be undone.
          </p>
        ),
        confirmLabel: 'Discard',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    const done: Record<WorktreePoolHeldAction, string> = {
      commit: 'Committed; back in the pool.',
      stash: 'Stashed; back in the pool.',
      discard: 'Discarded; back in the pool.',
      keep: 'Kept as an ordinary worktree, outside the pool.',
    }
    await poolAction(row, { kind: 'held', repoRoot: row.repoRoot, slotId: row.slot.id, action, message }, done[action])
  }

  // `git worktree prune` forgets every missing worktree of the project, and
  // keeps one locked by another profile or by hand without a word: what it did
  // is read back from git's listing, not assumed.
  const prune = (row: WorktreeRow) =>
    run(
      [row.key],
      async () => {
        const pruned = await window.api.pruneGitWorktrees(row.repoRoot)
        if (!pruned.ok) return pruned
        const listed = await window.api.listGitWorktrees(row.repoRoot)
        // Without the listing there is nothing to say what git did, only that it ran.
        if (!listed.ok)
          return {
            ok: true,
            message: `Git pruned the project's missing worktrees; whether it forgot ${row.name} could not be read back.`,
          }
        const still = listed.data.worktrees.find((worktree) => samePath(worktree.path, row.path))
        if (still) {
          return {
            ok: false,
            message: still.locked
              ? `Git kept ${row.name}: it is locked${still.lockedReason ? ` (${still.lockedReason})` : ''}. Unlock it from the Worktree manager first.`
              : `Git still lists ${row.name}.`,
          }
        }
        const others = projects
          .find((project) => samePath(project.repoRoot, row.repoRoot))
          ?.otherRows.filter(
            (other) =>
              other.state === 'missing' &&
              other.key !== row.key &&
              // Forgotten, not kept: a locked one is still in git's listing.
              !listed.data.worktrees.some((worktree) => samePath(worktree.path, other.path)),
          ).length
        return {
          ok: true,
          message: others
            ? `Git forgot ${row.name}, and the project's ${others} other missing worktree${others === 1 ? '' : 's'}.`
            : `Git forgot ${row.name}.`,
        }
      },
      'Git forgot the missing worktree.',
    )

  const toggle = (set: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, key: string) =>
    set((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (!hasApi()) {
    return (
      <div role="tabpanel" id="settings-panel-worktrees" aria-labelledby="settings-tab-worktrees">
        <SettingsPageHeader title="Worktrees" />
        <EmptyState density="list" title="Worktrees are managed from the desktop app." />
      </div>
    )
  }

  const counts: Record<WorktreeFilter, number> = {
    all: totals.count,
    'in-use': totals.inUse,
    ready: totals.ready,
    held: totals.held,
    other: totals.other,
  }
  const limitBytes = settings.diskLimitGb !== null ? settings.diskLimitGb * 1024 ** 3 : null
  const barTotal = Math.max(totals.bytes.all, limitBytes ?? 0, 1)
  const visibleProjects = projects
    .map((project) => ({
      project,
      poolRows: project.poolRows.filter((row) => rowMatches(row, filter, query)),
      otherRows: project.otherRows.filter((row) => rowMatches(row, filter, query)),
    }))
    .filter(({ poolRows, otherRows }) => poolRows.length + otherRows.length > 0)
  const selectedBytes = selectedRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)

  return (
    <div role="tabpanel" id="settings-panel-worktrees" aria-labelledby="settings-tab-worktrees">
      <SettingsPageHeader
        title="Worktrees"
        meta={
          measuring
            ? 'Measuring…'
            : inventory?.measuredAt
              ? `Sizes measured ${formatRelativeMsAgo(inventory.measuredAt, now)}`
              : undefined
        }
        actions={
          <>
            <Tooltip content="Measure every worktree again">
              <IconButton
                aria-label={measuring ? 'Measuring every worktree' : 'Measure every worktree again'}
                disabled={measuring}
                onClick={() => void read(true)}
              >
                {measuring ? <Spinner className="icon-sm" /> : <RefreshIcon />}
              </IconButton>
            </Tooltip>
            <OutlineButton size="sm" disabled={!inventory} onClick={() => setFreeOpen(true)}>
              Free up space…
            </OutlineButton>
          </>
        }
      />

      {loadError ? (
        <InlineNotice tone="error" title="Could not read the worktrees." detail={loadError} className="mb-4" />
      ) : null}
      <ActionResultMessage message={result} className="mb-4" />

      <SettingCard className="mb-6 px-4 py-4">
        {/* Reflows with the page's own width, not the window's: five across only where
            every label fits on its line. */}
        <div className="@container">
          <div className="grid grid-cols-2 gap-4 @[480px]:grid-cols-3 @[720px]:grid-cols-5" aria-label="Overview">
            <Stat
              label="Worktrees"
              value={String(totals.count)}
              sub={`in ${projects.length} project${projects.length === 1 ? '' : 's'}`}
            />
            <Stat
              label="In use"
              swatch={USAGE_SEGMENTS[0].color}
              value={String(totals.inUse)}
              sub={
                totals.chats
                  ? `by ${totals.chats} chat${totals.chats === 1 ? '' : 's'}`
                  : totals.inUse
                    ? 'by chats and agents'
                    : 'none right now'
              }
            />
            <Stat
              label="Ready to reuse"
              swatch={USAGE_SEGMENTS[1].color}
              value={String(totals.ready)}
              sub="kept for reuse"
            />
            <Stat
              label="Holding work"
              swatch={USAGE_SEGMENTS[2].color}
              value={String(totals.held)}
              sub={totals.held ? 'needs you' : 'nothing waiting'}
            />
            <Stat
              label="On disk"
              value={totals.bytes.all ? formatBytes(totals.bytes.all) : '—'}
              sub={settings.diskLimitGb !== null ? `pool limit ${settings.diskLimitGb} GB` : 'no pool limit'}
            />
          </div>
        </div>
        <div
          className="mt-4 flex h-2 overflow-hidden rounded-full bg-[color:var(--bg-well)]"
          role="img"
          aria-label={USAGE_SEGMENTS.map(
            (segment) => `${segment.label} ${formatBytes(totals.bytes[segment.key])}`,
          ).join(', ')}
        >
          {USAGE_SEGMENTS.map((segment) =>
            totals.bytes[segment.key] > 0 ? (
              <span
                key={segment.key}
                className="h-full"
                style={{ width: `${(totals.bytes[segment.key] / barTotal) * 100}%`, backgroundColor: segment.color }}
              />
            ) : null,
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-meta text-[color:var(--text-muted)]">
          {USAGE_SEGMENTS.map((segment) => (
            <span key={segment.key} className="inline-flex items-center gap-1.5">
              <Swatch color={segment.color} />
              {segment.label} {formatBytes(totals.bytes[segment.key])}
            </span>
          ))}
          {limitBytes !== null ? (
            <span className="ml-auto text-[color:var(--text-subtle)]">
              {totals.bytes.pool > limitBytes
                ? `Pool over its ${settings.diskLimitGb} GB limit`
                : `${formatBytes(limitBytes - totals.bytes.pool)} under the pool limit`}
            </span>
          ) : null}
        </div>
      </SettingCard>

      <SettingsSectionTitle className="mb-2">Pool</SettingsSectionTitle>
      <SettingCard className="mb-6">
        <SettingToggle
          label="Reuse worktrees for new chats"
          description="A new chat or an agent's worktree comes from the pool instead of a fresh checkout, reset to the default branch as fetched at that moment. Its ignored files (node_modules, build output) are kept, so installs are faster. Turning it off removes every ready worktree; ones in use or holding work stay."
          enabled={settings.enabled}
          onChange={(enabled) => void setPoolEnabled(enabled)}
        />
        <SettingRow
          label="Ready worktrees to keep"
          help="Per project. When a chat is done and its worktree comes back, any beyond this are removed, longest unused first."
          disabled={!settings.enabled}
        >
          <Select
            ariaLabel="Ready worktrees to keep"
            items={KEEP_IDLE_ITEMS}
            value={String(settings.keepIdle)}
            disabled={!settings.enabled}
            onChange={(value) => void updateSettings({ keepIdle: Number(value) })}
          />
        </SettingRow>
        <SettingRow
          label="Most worktrees per project"
          help="Counting the ones in use. Past this a new chat still gets a worktree, but a fresh one that is removed when the chat is done, not kept for reuse."
          disabled={!settings.enabled}
        >
          <Select
            ariaLabel="Most worktrees per project"
            items={MAX_SLOT_ITEMS}
            value={String(settings.maxSlots)}
            disabled={!settings.enabled}
            onChange={(value) => void updateSettings({ maxSlots: Number(value) })}
          />
        </SettingRow>
        <SettingRow
          label="Disk limit"
          help="For all of the pool's worktrees together. Past it, the longest-unused ready ones are removed. Nothing in use or holding work is ever removed, and worktrees outside the pool don't count."
          disabled={!settings.enabled}
        >
          <Select
            ariaLabel="Disk limit"
            items={
              settings.diskLimitGb !== null &&
              !DISK_LIMIT_ITEMS.some((item) => item.value === String(settings.diskLimitGb))
                ? [...DISK_LIMIT_ITEMS, { value: String(settings.diskLimitGb), label: `${settings.diskLimitGb} GB` }]
                : DISK_LIMIT_ITEMS
            }
            value={settings.diskLimitGb === null ? 'none' : String(settings.diskLimitGb)}
            disabled={!settings.enabled}
            onChange={(value) => void updateSettings({ diskLimitGb: value === 'none' ? null : Number(value) })}
          />
        </SettingRow>
        <SettingRow label="Location" help="Next to each project, in a folder of its own.">
          <code className="rounded-[var(--radius-chip)] bg-[color:var(--bg-well)] px-2 py-1 font-mono text-meta text-[color:var(--text-default)]">
            {'<project>/../.sprintengine-worktrees/<project>/'}
          </code>
        </SettingRow>
      </SettingCard>

      <SettingsSectionTitle className="mb-2">Branches</SettingsSectionTitle>
      <SettingCard className="mb-6">
        <BranchPrefixSetting />
      </SettingCard>

      <SettingsSectionTitle className="mb-2" count={totals.count}>
        Worktrees
      </SettingsSectionTitle>
      {/* The field takes what the filter leaves, and drops under it when that is too little. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl<WorktreeFilter>
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'in-use', label: `In use ${counts['in-use']}` },
            { value: 'ready', label: `Ready ${counts.ready}` },
            { value: 'held', label: `Holding work ${counts.held}` },
            { value: 'other', label: `Not in the pool ${counts.other}` },
          ]}
        />
        <Input
          size="sm"
          aria-label="Filter worktrees"
          placeholder="Filter by branch, chat or path"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          fullWidth={false}
          className="min-w-48 flex-1"
        />
      </div>

      {!inventory && !loadError ? (
        <div className="flex items-center gap-2 py-6 text-meta text-[color:var(--text-muted)]">
          <Spinner className="icon-sm" /> Reading every worktree…
        </div>
      ) : visibleProjects.length === 0 ? (
        <EmptyState
          density="list"
          title={projects.length === 0 ? 'No worktrees yet.' : 'Nothing matches.'}
          body={
            projects.length === 0
              ? 'A new chat gets a worktree of its own, and it appears here with the project it belongs to.'
              : undefined
          }
        />
      ) : (
        visibleProjects.map(({ project, poolRows, otherRows }) => (
          <ProjectCard
            key={project.repoRoot}
            project={project}
            poolRows={poolRows}
            otherRows={otherRows}
            now={now}
            expanded={expanded}
            selected={selected}
            busy={busy}
            onToggleExpanded={(key) => toggle(setExpanded, key)}
            onToggleSelected={(key) => toggle(setSelected, key)}
            poolEnabled={settings.enabled}
            install={dependencyInstallSettingFor(settings, project.repoRoot)}
            onInstallChange={(setting) => updateInstall(project.repoRoot, setting)}
            installs={installs}
            actions={{
              openChat: onOpenChat,
              remove: (row) => void confirmRemove(row),
              clearIgnored: (row) => void clearIgnored(row),
              held: (row, action) => void heldAction(row, action),
              prune: (row) => void prune(row),
              cancelInstall: (install) => void cancelInstall(install),
            }}
          />
        ))
      )}

      {selectedRows.length > 0 ? (
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-[var(--radius-shell)] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-4 py-2.5">
          <span className="text-body font-medium text-[color:var(--text-strong)]">{selectedRows.length} selected</span>
          <span className="text-meta text-[color:var(--text-muted)]">{formatBytes(selectedBytes)}</span>
          <span className="flex-1" />
          <GhostButton size="xs" onClick={() => setSelected(new Set())}>
            Clear selection
          </GhostButton>
          <DangerButton size="xs" onClick={() => void removeSelected()}>
            Remove {selectedRows.length} · free {formatBytes(selectedBytes)}
          </DangerButton>
        </div>
      ) : null}

      <FreeSpaceDialog
        open={freeOpen}
        projects={projects}
        onClose={() => setFreeOpen(false)}
        onRun={async ({ remove, clear }) => {
          setFreeOpen(false)
          if (remove.length) await removeRows(remove)
          for (const row of clear) await clearIgnored(row, false)
        }}
      />
    </div>
  )
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-[var(--radius-chip)]"
      style={{ backgroundColor: color }}
    />
  )
}

function Stat({ label, value, sub, swatch }: { label: string; value: string; sub: string; swatch?: string }) {
  return (
    <div className="min-w-0">
      {/* One line, so the swatch sits beside the label and every value below
          stays level with its neighbours'. */}
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
        {swatch ? <Swatch color={swatch} /> : null}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-title font-semibold tabular-nums text-[color:var(--text-strong)]">{value}</div>
      <div className="truncate text-meta text-[color:var(--text-subtle)]">{sub}</div>
    </div>
  )
}

type RowActions = {
  openChat: (workspaceId: string) => void
  remove: (row: WorktreeRow) => void
  clearIgnored: (row: WorktreeRow) => void
  held: (row: WorktreeRow, action: WorktreePoolHeldAction) => void
  prune: (row: WorktreeRow) => void
  cancelInstall: (install: WorktreeDependencyInstallView) => void
}

function ProjectCard({
  project,
  poolRows,
  otherRows,
  now,
  expanded,
  selected,
  busy,
  onToggleExpanded,
  onToggleSelected,
  poolEnabled,
  install,
  onInstallChange,
  installs,
  actions,
}: {
  project: WorktreeProjectView
  poolRows: WorktreeRow[]
  otherRows: WorktreeRow[]
  now: number
  expanded: ReadonlySet<string>
  selected: ReadonlySet<string>
  busy: ReadonlySet<string>
  onToggleExpanded: (key: string) => void
  onToggleSelected: (key: string) => void
  poolEnabled: boolean
  /** The project's install choice; null when it never made one (off). */
  install: WorktreeDependencyInstallSetting | null
  onInstallChange: (setting: WorktreeDependencyInstallSetting) => void
  installs: ReadonlyMap<string, WorktreeDependencyInstallView>
  actions: RowActions
}) {
  const [open, setOpen] = useState(true)
  const count = project.poolRows.length + project.otherRows.length
  const facts = [
    project.defaultRef ? `Forks from ${project.defaultRef}` : null,
    project.lastFetchAt ? `Fetched ${formatRelativeMsAgo(project.lastFetchAt, now)}` : null,
  ].filter(Boolean)
  const rowProps = { now, expanded, selected, busy, onToggleExpanded, onToggleSelected, installs, actions }
  // Two lines, so neither has to squeeze: the name, its count and the folder
  // button on the first, which never wrap; where it lives and what it forks
  // from under them, the path giving way first and from its front. The second
  // line starts under the name: the button's inset, the chevron and its gap.
  return (
    <SettingCard className="mb-4 overflow-hidden">
      <div className="border-b border-[color:var(--border-subtle)] py-2 pl-2 pr-3">
        <div className="flex items-center gap-2">
          <GhostButton
            size="xs"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="min-w-0 whitespace-nowrap"
          >
            <ChevronDownIcon
              className={`size-icon-xs shrink-0 text-[color:var(--text-subtle)] transition-transform ${open ? '' : '-rotate-90'}`}
            />
            <span className="truncate font-semibold text-[color:var(--text-strong)]">{project.name}</span>
          </GhostButton>
          <span className="shrink-0 whitespace-nowrap text-meta tabular-nums text-[color:var(--text-muted)]">
            {count} worktree{count === 1 ? '' : 's'}
            {project.bytes ? ` · ${formatBytes(project.bytes)}` : ''}
          </span>
          <span className="flex-1" />
          <GhostButton
            size="xs"
            className="shrink-0 whitespace-nowrap"
            onClick={() => void window.api.showItemInFolder(project.containerPath ?? project.repoRoot)}
          >
            Show folder
          </GhostButton>
        </div>
        <div className="flex min-w-0 items-center gap-2 pl-[calc(var(--icon-xs)+--spacing(3.5))] text-meta text-[color:var(--text-subtle)]">
          <FrontTruncatedText text={project.repoRoot} className="font-mono" />
          {facts.length ? <span className="shrink-0 whitespace-nowrap">{facts.join(' · ')}</span> : null}
        </div>
      </div>
      {project.heldByOtherInstance ? (
        <InlineNotice
          tone="warn"
          className="m-3"
          title="Another copy of SprintEngine Studio manages this pool."
          hint="Its worktrees are shown here; change them from that copy."
        />
      ) : null}
      {project.error ? <InlineNotice tone="error" className="m-3" title={project.error} /> : null}
      {open ? (
        <DependencyInstallSettings
          projectName={project.name}
          install={install}
          disabled={!poolEnabled || project.heldByOtherInstance}
          onChange={onInstallChange}
        />
      ) : null}
      {open ? (
        <Table
          fixed
          ariaLabel={`Worktrees of ${project.name}`}
          className="w-full"
          colgroup={
            <colgroup>
              {/* Sized for the Settings column (about 920px, 680px at the
                  narrowest window). Four text tracks there left a folder name
                  120px and cut every agent's worktree to "agent-a1d…", so the
                  branch rides under the name and the state badge leads what
                  the worktree is doing: two tracks that share what the size
                  and the actions leave. */}
              <col className="w-8" />
              <col className="w-[32%]" />
              <col />
              <col className="w-24" />
              <col className="w-20" />
              <col className="w-36" />
            </colgroup>
          }
        >
          <thead>
            <tr>
              <Table.Head sticky={false}>
                <span className="sr-only">Select</span>
              </Table.Head>
              <Table.Head sticky={false}>Worktree</Table.Head>
              <Table.Head sticky={false}>Status</Table.Head>
              <Table.Head sticky={false}>Last used</Table.Head>
              <Table.Head sticky={false} numeric>
                Size
              </Table.Head>
              <Table.Head sticky={false}>
                <span className="sr-only">Actions</span>
              </Table.Head>
            </tr>
          </thead>
          <tbody>
            {poolRows.map((row) => (
              <WorktreeTableRow key={row.key} row={row} {...rowProps} />
            ))}
            {otherRows.length > 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="bg-[color:var(--bg-surface)] px-2 py-1.5 pl-8 text-meta text-[color:var(--text-subtle)]"
                >
                  Not in the pool: other worktrees of this project
                </td>
              </tr>
            ) : null}
            {otherRows.map((row) => (
              <WorktreeTableRow key={row.key} row={row} {...rowProps} />
            ))}
          </tbody>
        </Table>
      ) : null}
    </SettingCard>
  )
}

function WorktreeTableRow({
  row,
  now,
  expanded,
  selected,
  busy,
  onToggleExpanded,
  onToggleSelected,
  installs,
  actions,
}: {
  row: WorktreeRow
  now: number
  expanded: ReadonlySet<string>
  selected: ReadonlySet<string>
  busy: ReadonlySet<string>
  onToggleExpanded: (key: string) => void
  onToggleSelected: (key: string) => void
  installs: ReadonlyMap<string, WorktreeDependencyInstallView>
  actions: RowActions
}) {
  const isOpen = expanded.has(row.key)
  const install = installAt(installs, row.path)
  const isBusy = busy.has(row.key) || row.state === 'busy'
  const selectable = row.removal === 'evict' || row.removal === 'remove'
  const menu: OverflowMenuItem[] = [
    {
      id: 'reveal',
      label: 'Show in Finder',
      onSelect: () => void window.api.showItemInFolder(row.path),
      disabled: row.state === 'missing',
    },
    { id: 'copy', label: 'Copy path', onSelect: () => void navigator.clipboard?.writeText(row.path) },
  ]
  if (row.state === 'ready') {
    menu.push(
      { kind: 'separator', id: 'sep' },
      { id: 'clear', label: 'Clear ignored files…', onSelect: () => actions.clearIgnored(row), disabled: isBusy },
      { id: 'remove', label: 'Remove…', destructive: true, onSelect: () => actions.remove(row), disabled: isBusy },
    )
  } else if (row.state === 'held') {
    menu.push(
      { kind: 'separator', id: 'sep' },
      { id: 'stash', label: 'Stash changes and reuse', onSelect: () => actions.held(row, 'stash'), disabled: isBusy },
      {
        id: 'keep',
        label: 'Keep it out of the pool',
        onSelect: () => actions.held(row, 'keep'),
        disabled: isBusy,
      },
      {
        id: 'discard',
        label: 'Discard changes…',
        destructive: true,
        onSelect: () => actions.held(row, 'discard'),
        disabled: isBusy,
      },
    )
  } else if (row.removal === 'remove') {
    menu.push(
      { kind: 'separator', id: 'sep' },
      { id: 'remove', label: 'Remove…', destructive: true, onSelect: () => actions.remove(row), disabled: isBusy },
    )
  }
  const foreign = row.keptBecause?.startsWith('Another SprintEngine Studio') === true

  return (
    <>
      <Table.Row
        className={isOpen ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'}
        onClick={(event: React.MouseEvent<HTMLTableRowElement>) => {
          if ((event.target as HTMLElement).closest('button, input, a, [role="menu"]')) return
          onToggleExpanded(row.key)
        }}
      >
        <Table.Cell className="pl-3">
          {selectable && !foreign ? (
            <Checkbox
              checked={selected.has(row.key)}
              onChange={() => onToggleSelected(row.key)}
              ariaLabel={`Select ${row.name}`}
              disabled={isBusy}
            />
          ) : null}
        </Table.Cell>
        <Table.Cell className="py-2">
          <div className="truncate text-body font-medium text-[color:var(--text-strong)]" title={row.path}>
            {row.name}
          </div>
          {/* A branch's end says what it is for; its head is a prefix many share. */}
          <div
            className={`flex min-w-0 font-mono text-meta ${row.branch ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-subtle)]'}`}
            title={row.branch ?? undefined}
          >
            <FrontTruncatedText text={row.branch ?? 'no branch'} />
          </div>
        </Table.Cell>
        <Table.Cell className="py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge tone={STATE_TONE[row.state]} className="shrink-0">
              {row.stateLabel}
            </Badge>
            {isBusy ? <Spinner size={12} label="Working" /> : null}
            <span className="truncate text-body text-[color:var(--text-default)]" title={row.usedBy}>
              {row.usedBy}
            </span>
          </div>
          <div
            className="mt-0.5 truncate text-meta text-[color:var(--text-subtle)]"
            title={install?.lastLine ?? undefined}
          >
            {install
              ? `installing dependencies · ${install.lastLine ?? install.command}`
              : [row.branchNote, usedBySub(row, now)].filter(Boolean).join(' · ')}
          </div>
        </Table.Cell>
        <Table.Cell
          className="whitespace-nowrap text-meta tabular-nums text-[color:var(--text-muted)]"
          title={row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : undefined}
        >
          {row.lastUsedAt ? formatRelativeMsAgo(row.lastUsedAt, now) : '—'}
        </Table.Cell>
        <Table.Cell numeric className="whitespace-nowrap text-[color:var(--text-muted)]">
          {formatBytes(row.bytes)}
        </Table.Cell>
        <Table.Cell className="pr-3">
          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
            {install ? (
              <OutlineButton size="xs" onClick={() => actions.cancelInstall(install)}>
                Cancel install
              </OutlineButton>
            ) : row.state === 'held' ? (
              <PrimaryButton size="xs" disabled={isBusy} onClick={() => actions.held(row, 'commit')}>
                Commit…
              </PrimaryButton>
            ) : row.chat && (row.state === 'in-use' || row.state === 'busy') ? (
              <OutlineButton size="xs" onClick={() => actions.openChat(row.chat!.workspaceId)}>
                Open chat
              </OutlineButton>
            ) : row.state === 'missing' ? (
              <OutlineButton size="xs" disabled={isBusy} onClick={() => actions.prune(row)}>
                Prune
              </OutlineButton>
            ) : selectable && !foreign ? (
              <OutlineButton size="xs" disabled={isBusy} onClick={() => actions.remove(row)}>
                Remove
              </OutlineButton>
            ) : null}
            <OverflowMenu ariaLabel={`More for ${row.name}`} items={menu} />
          </div>
        </Table.Cell>
      </Table.Row>
      {isOpen ? (
        <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]">
          <td colSpan={6} className="px-4 py-4 pl-8">
            <RowDetail row={row} now={now} actions={actions} busy={isBusy} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

/**
 * A project's choice to install dependencies in its pooled worktrees (owner
 * ruling 2026-10-06): off until turned on here, because the install runs the
 * repository's own scripts. The command is kept as typed and saved when the
 * field is left; empty means the one the lockfile implies.
 */
function DependencyInstallSettings({
  projectName,
  install,
  disabled,
  onChange,
}: {
  projectName: string
  install: WorktreeDependencyInstallSetting | null
  disabled: boolean
  onChange: (setting: WorktreeDependencyInstallSetting) => void
}) {
  const enabled = install?.enabled === true
  const saved = install?.command ?? ''
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const commit = () => {
    const command = draft.trim()
    if (command !== saved) onChange({ enabled, command: command || null })
  }
  return (
    <div className="border-b border-[color:var(--border-subtle)]">
      <SettingToggle
        label="Install dependencies when the lockfile changes"
        description="Before an agent starts in one of this project's pooled worktrees, the install runs if the lockfile changed since that worktree last installed, and the agent waits for it. It runs the project's own install scripts with your permissions, so turn it on only for code you trust."
        enabled={enabled}
        disabled={disabled}
        onChange={(next) => onChange({ enabled: next, command: install?.command ?? null })}
      />
      {enabled ? (
        <SettingRow
          label="Install command"
          help="Empty uses the lockfile's own: npm ci, pnpm install --frozen-lockfile, yarn install with --frozen-lockfile or --immutable, or bun install --frozen-lockfile. A command of your own runs again whenever any lockfile changes."
          disabled={disabled}
        >
          <Input
            size="sm"
            aria-label={`Install command for ${projectName}`}
            placeholder="From the lockfile"
            value={draft}
            maxLength={WORKTREE_INSTALL_COMMAND_MAX}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
            className="w-64 font-mono"
          />
        </SettingRow>
      ) : null}
    </div>
  )
}

/**
 * What every new worktree's branch starts with: a chat's, an agent's, a
 * scheduled run's, wherever Studio names one. Kept in main's launch settings,
 * so a worktree main makes with no window open is named the same way. The
 * prefix is kept as typed and saved, sanitized to what git accepts, when the
 * field is left; the line under it names the branch the draft would make as
 * it is typed, sanitized the same way, so what is saved is never a surprise.
 */
function BranchPrefixSetting() {
  const saved = useWorkspaceStore((s) => s.appSettings.worktreeBranchPrefix)
  const setWorktreeBranchPrefix = useWorkspaceStore((s) => s.setWorktreeBranchPrefix)
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const inputId = useId()
  const exampleId = useId()
  const warningId = useId()
  const commit = () => {
    const prefix = sanitizeWorktreeBranchPrefix(draft)
    setDraft(prefix)
    if (prefix !== saved) setWorktreeBranchPrefix(prefix)
  }
  const prefix = sanitizeWorktreeBranchPrefix(draft)
  // A name git keeps for itself, or a common remote's, said as it is typed.
  const warning = worktreeBranchPrefixWarning(draft)
  return (
    <SettingRow
      label="Branch prefix"
      htmlFor={inputId}
      help="What each new worktree’s branch starts with, or nothing when empty. Your own branches can share it: Studio only ever deletes a branch it made, once its work is merged and no chat uses it."
    >
      <div className="flex flex-col items-end gap-1">
        <Input
          id={inputId}
          size="sm"
          placeholder="No prefix"
          value={draft}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-describedby={warning ? `${exampleId} ${warningId}` : exampleId}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          className="w-48 font-mono"
        />
        <span id={exampleId} aria-live="polite" className="text-meta text-[color:var(--text-muted)]">
          New worktrees are named <span className="font-mono">{worktreeBranchExample(prefix)}</span>
          {prefix ? '' : ', with no prefix'}
        </span>
        {warning ? (
          <span id={warningId} role="status" className="max-w-xs text-right text-meta text-[color:var(--tone-warn)]">
            {warning}
          </span>
        ) : null}
      </div>
    </SettingRow>
  )
}

function usedBySub(row: WorktreeRow, now: number): string {
  const slot = row.slot
  if (row.state === 'in-use' && slot?.lease) {
    const how = slot.lease.agentId ? 'leased with worktree.lease' : row.chat?.settled ? 'settled chat' : 'chat'
    return `${how} · ${formatRelativeMsAgo(slot.lease.leasedAt, now)}`
  }
  if (row.state === 'held' && slot?.held) return `since ${formatRelativeMsAgo(slot.held.since, now)}`
  if (row.state === 'ready' && slot?.kept) return `kept: ${slot.kept}`
  if (row.state === 'ready' && slot?.lastBranch) return `last on ${slot.lastBranch}`
  if (row.keptBecause && row.state === 'other') return row.keptBecause
  return ''
}

function RowDetail({ row, now, actions, busy }: { row: WorktreeRow; now: number; actions: RowActions; busy: boolean }) {
  const slot = row.slot
  const entry = row.entry
  const items = (
    [
      { term: 'Path', description: <span className="break-all font-mono">{row.path}</span> },
      row.branch ? { term: 'Branch', description: <span className="font-mono">{row.branch}</span> } : null,
      slot?.baseRef
        ? {
            term: row.state === 'ready' ? 'At' : 'Forked from',
            description: (
              <span className="font-mono">
                {slot.baseRef}
                {slot.baseSha ? ` ${slot.baseSha.slice(0, 7)}` : ''}
              </span>
            ),
          }
        : null,
      row.chat ? { term: 'Chat', description: `${row.chat.title}${row.chat.settled ? ' (settled)' : ''}` } : null,
      slot?.lease
        ? {
            term: 'Leased',
            description: `${formatRelativeMsAgo(slot.lease.leasedAt, now)}${slot.lease.agentId ? ', by the agent itself (worktree.lease)' : ''}. It comes back to the pool when its chat is done.`,
          }
        : null,
      slot ? { term: 'Leases served', description: String(slot.uses) } : null,
      slot?.lastBranch && row.state === 'ready' ? { term: 'Last branch', description: slot.lastBranch } : null,
      slot?.error ? { term: 'Last error', description: slot.error } : null,
      row.keptBecause && !slot ? { term: 'Kept', description: row.keptBecause } : null,
      slot?.kept && row.state === 'ready'
        ? {
            term: 'Kept',
            description: `${slot.kept.charAt(0).toUpperCase()}${slot.kept.slice(1)}. The idle and disk limits leave it on disk until its ignored files are cleared.`,
          }
        : null,
    ] as Array<DefinitionItem | null>
  ).filter((item): item is DefinitionItem => item !== null)
  const parts = (slot?.size ?? entry?.size)?.parts ?? []
  const total = (slot?.size ?? entry?.size)?.bytes ?? 0

  return (
    <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-8">
      <div className="min-w-0">
        {row.state === 'held' ? (
          <p className="mb-3 text-body text-[color:var(--text-default)]">
            {slot?.held?.detail ??
              'The chat was done with changes that are not committed. Nothing is reused or removed until you decide what happens to them.'}
          </p>
        ) : null}
        <DefinitionList layout="compact-grid" items={items} />
        {entry?.changes.length ? (
          <pre className="mt-3 overflow-x-auto rounded-[var(--radius-chip)] bg-[color:var(--bg-well)] px-3 py-2 font-mono text-meta text-[color:var(--text-default)]">
            {entry.changes.map((change) => `${change.code.padEnd(2)} ${change.path}`).join('\n')}
            {(entry.changedPaths ?? 0) > entry.changes.length
              ? `\n… and ${(entry.changedPaths ?? 0) - entry.changes.length} more`
              : ''}
          </pre>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {row.state === 'held' ? (
            <>
              <PrimaryButton size="xs" disabled={busy} onClick={() => actions.held(row, 'commit')}>
                Commit to {row.branch ?? 'a branch'}…
              </PrimaryButton>
              <OutlineButton size="xs" disabled={busy} onClick={() => actions.held(row, 'stash')}>
                Stash and reuse
              </OutlineButton>
              <OutlineButton size="xs" disabled={busy} onClick={() => actions.held(row, 'keep')}>
                Keep it out of the pool
              </OutlineButton>
              <GhostButton size="xs" tone="danger" disabled={busy} onClick={() => actions.held(row, 'discard')}>
                Discard changes…
              </GhostButton>
            </>
          ) : null}
          {row.state === 'ready' ? (
            <>
              <OutlineButton size="xs" disabled={busy} onClick={() => actions.clearIgnored(row)}>
                Clear ignored files…
              </OutlineButton>
              <GhostButton size="xs" tone="danger" disabled={busy} onClick={() => actions.remove(row)}>
                Remove from the pool…
              </GhostButton>
            </>
          ) : null}
          {row.state !== 'missing' ? (
            <GhostButton size="xs" onClick={() => void window.api.showItemInFolder(row.path)}>
              Show in Finder
            </GhostButton>
          ) : null}
        </div>
      </div>
      <div className="min-w-0">
        <div className="mb-2 text-meta font-medium text-[color:var(--text-muted)]">On disk</div>
        {parts.length === 0 ? (
          <p className="text-meta text-[color:var(--text-subtle)]">Not measured yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {parts.map((part) => (
              <li key={part.name} className="text-meta">
                <div className="flex justify-between gap-3">
                  <span className="truncate font-mono text-[color:var(--text-default)]">{partLabel(part.name)}</span>
                  <span className="tabular-nums text-[color:var(--text-muted)]">{formatBytes(part.bytes)}</span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-[color:var(--bg-well)]">
                  <span
                    className="block h-full bg-[color:var(--text-subtle)]"
                    style={{ width: `${total ? Math.max(1, (part.bytes / total) * 100) : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
