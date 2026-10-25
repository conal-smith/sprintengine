import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  AgentCapabilitiesResult,
  SkillHarness,
  WorkspaceSkill,
  WorkspaceSkillSource,
} from '../../../../shared/electron-api'
import { builtinInstallsIntoHarness, skillDirName } from '../../../../shared/skills'
import { ensureSkillForAgent } from '../../utils/skillInvocation'
import { Badge } from './Badge'
import { Popover, type PopoverPlacement, type PopoverProps } from './Popover'
import { MENU_GROUP_LABEL_CLASS, MENU_ITEM_CLASS } from './menuClasses'
import { FOCUS_RING_CLASS } from './tokens'
import { Spinner } from './Spinner'
import { StarGlyph } from './StarGlyph'
import { TruncatedText } from './TruncatedText'
import { isImeKey } from '../../utils/imeKey'

// One inventory, every door: the searchable skill list behind the composer
// Skills chip, the `/` and `$` type-aheads, the terminal panel-header action
// and the agent composer's "+ Skill" attachment. Rows show the real SKILL.md
// name with its description on the same line and a source badge at the far
// edge (one row per skill, the description beside the name rather than under
// it, so twelve skills fit in the height six used to), grouped installed-first.
//
// Installed means what the agent can reach: the open folder's skills and the
// ones installed for every project in the home folder, so a chat with no
// folder still has its skills. Available means everything the person could
// have — the skills the app ships and every skill in their added sources — and
// picking one installs it for every project, then behaves identically. Picking
// NEVER auto-sends — callers prefill their input and keep the caret.

const SOURCE_LABEL: Record<WorkspaceSkillSource, string> = {
  builtin: 'Built-in',
  custom: 'Custom',
  plugin: 'Plugin',
}

export type SkillInventoryState = {
  skills: WorkspaceSkill[]
  loading: boolean
  error: string | null
}

type LoadedInventory = { skills: WorkspaceSkill[]; error: string | null }

/**
 * A row the picker can install on pick. A skill from an added source carries
 * where it is read from, because its row id is the directory it installs as
 * and the source names it by its path inside the repository.
 */
type PickerSkill = WorkspaceSkill & { fromSource?: { sourceId: string; skillId: string } }

type AgentSkillRow = Extract<AgentCapabilitiesResult, { ok: true }>['skills'][number]

// The capability service answers for one CLI, so its skills are already known to
// be reachable there; the harness id travels with them because callers render
// the CLI-native invocation from it.
function reachableRow(skill: AgentSkillRow, harnessId: string): WorkspaceSkill {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    // A row carries one source label; `source` and `local` are both "not one of
    // ours" here, and the full provenance lives in the Extensions inventory.
    source: skill.source === 'builtin' ? 'builtin' : 'custom',
    // The harness id is a manifest value, so a user plugin can name one this
    // legacy union does not enumerate. Attribution stays truthful either way.
    harnesses: [harnessId as SkillHarness],
    installState: 'installed',
    ...(skill.sourceId ? { sourceId: skill.sourceId } : {}),
  }
}

// One inventory, two questions. With a CLI in play the rows are what that agent
// can actually reach, through the one capability query. Without one — a
// conversation provider, or a scheduled automation that installs into a per-run
// worktree — there is no harness to ask about, and the workspace-wide inventory
// is the honest answer.
async function loadInventory(workspaceRoot: string | null, pluginId: string | null): Promise<LoadedInventory> {
  if (!pluginId) {
    const result = await window.api.workspaceSkillsList({ workspaceRoot, includeGlobal: true })
    return result.ok ? { skills: result.skills, error: null } : { skills: [], error: result.message }
  }

  const capabilities = await window.api.agentCapabilities({ workspaceRoot, pluginId, includeGlobal: true })
  if (!capabilities.ok) return { skills: [], error: capabilities.message }
  if (capabilities.support === 'unsupported') {
    return { skills: [], error: 'This agent does not read workspace skills.' }
  }
  // A path that failed to read must never render as an empty list. Only the
  // skills half is this list's business: an unparseable MCP config is a real
  // fault, but not a reason to stop showing the skills that did read.
  const [failed] = capabilities.diagnostics.filter((diagnostic) => diagnostic.capability === 'skills')
  if (failed) return { skills: [], error: `Could not read ${failed.path} — ${failed.message}` }

  const reachable = capabilities.skills.map((skill) => reachableRow(skill, capabilities.harnessId))
  const reachableIds = new Set(reachable.map((skill) => skill.id))
  const bundled = await window.api.builtinSkillsList()
  const available = bundled
    .filter((skill) => !reachableIds.has(skill.id) && builtinInstallsIntoHarness(skill, capabilities.harnessId))
    .map((skill): WorkspaceSkill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: 'builtin',
      harnesses: [],
      installState: 'available',
      version: skill.version,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { skills: [...reachable, ...available], error: null }
}

/**
 * Every skill in the person's added sources, as rows to install. Only what is
 * already on this machine is read — the bundled sources, folders, and the
 * repositories whose scan is cached. A repository nobody has opened yet is a
 * network read and stays in Extensions, where reading it is asked for.
 */
async function loadSourceSkills(): Promise<PickerSkill[]> {
  if (typeof window.api.skillsListSources !== 'function' || typeof window.api.skillsGetScan !== 'function') return []
  const listed = await window.api.skillsListSources()
  if (!listed.ok) return []
  const readable = listed.sources.filter((source) => source.kind !== 'github' || source.scannedAt !== '')
  const scans = await Promise.all(
    readable.map((source) =>
      window.api
        .skillsGetScan({ sourceId: source.id })
        .then((result) => (result.ok ? { sourceId: source.id, skills: result.scan.skills } : null))
        .catch(() => null),
    ),
  )
  const rows: PickerSkill[] = []
  for (const scan of scans) {
    if (!scan) continue
    for (const skill of scan.skills) {
      rows.push({
        id: skillDirName(skill.id),
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        source: 'custom',
        harnesses: [],
        installState: 'available',
        sourceId: scan.sourceId,
        fromSource: { sourceId: scan.sourceId, skillId: skill.id },
      })
    }
  }
  return rows
}

/**
 * The installed inventory with every source skill not already in it appended
 * as available. One row per directory name: that is what an install writes and
 * what an agent invokes, so two sources shipping the same name are one choice
 * — the first source's — and a skill already installed is never offered again.
 */
function withSourceSkills(skills: readonly WorkspaceSkill[], fromSources: readonly PickerSkill[]): PickerSkill[] {
  const taken = new Set(skills.map((skill) => skill.id))
  const offered: PickerSkill[] = []
  for (const skill of fromSources) {
    if (taken.has(skill.id)) continue
    taken.add(skill.id)
    offered.push(skill)
  }
  return [...skills, ...offered.sort((a, b) => a.name.localeCompare(b.name))]
}

// The picker's list: what is installed and what could be. Source skills load
// beside the inventory and never hold it up — a source that cannot be read
// only means fewer rows to install.
function usePickerSkills(workspaceRoot: string | null, pluginId: string | null, active: boolean) {
  const inventory = useWorkspaceSkills(workspaceRoot, pluginId, active)
  const [fromSources, setFromSources] = useState<PickerSkill[]>([])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    loadSourceSkills()
      .then((rows) => {
        if (!cancelled) setFromSources(rows)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [active])
  const skills = useMemo(() => withSourceSkills(inventory.skills, fromSources), [inventory.skills, fromSources])
  return { ...inventory, skills }
}

// Loads the inventory when `active` flips true (each open refetches — installs
// and removals elsewhere must show up on the next open).
export function useWorkspaceSkills(
  workspaceRoot: string | null,
  pluginId: string | null,
  active: boolean,
): SkillInventoryState {
  // Loading from the first render when active: an empty list before the first
  // answer is not "nothing matches", and a type-ahead mounted on a token
  // already typed (`/back` pasted) would read it so and close.
  const [state, setState] = useState<SkillInventoryState>({ skills: [], loading: active, error: null })
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    loadInventory(workspaceRoot, pluginId)
      .then((loaded) => {
        if (cancelled) return
        setState({ skills: loaded.skills, loading: false, error: loaded.error })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          skills: [],
          loading: false,
          error: error instanceof Error ? error.message : 'Unable to list workspace skills.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [active, pluginId, workspaceRoot])
  return state
}

function matchesQuery(skill: WorkspaceSkill, normalized: string): boolean {
  if (!normalized) return true
  return (
    skill.id.toLowerCase().includes(normalized) ||
    skill.name.toLowerCase().includes(normalized) ||
    (skill.description?.toLowerCase().includes(normalized) ?? false)
  )
}

type SkillGroups = {
  installed: PickerSkill[]
  available: PickerSkill[]
  flat: PickerSkill[]
}

function groupSkills(skills: PickerSkill[], query: string): SkillGroups {
  const normalized = query.trim().toLowerCase()
  const matched = skills.filter((skill) => matchesQuery(skill, normalized))
  const installed = matched.filter((skill) => skill.installState !== 'available')
  const available = matched.filter((skill) => skill.installState === 'available')
  return { installed, available, flat: [...installed, ...available] }
}

function SkillGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 2.5h8.5A1.5 1.5 0 0 1 13 4v9.5H4.5A1.5 1.5 0 0 1 3 12V2.5z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 11.5A1.5 1.5 0 0 1 4.5 10H13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function SkillRow({
  skill,
  active,
  installing,
  onPick,
  onHover,
}: {
  skill: WorkspaceSkill
  active: boolean
  installing: boolean
  onPick: (skill: WorkspaceSkill) => void
  onHover: () => void
}) {
  const notInstalled = skill.installState === 'available'
  // One line per skill: the name, then the description beside it taking the
  // slack and truncating (its full text surfaces in the truncation tooltip),
  // then the source at the far edge. A menu row, so it takes the menu item's
  // full-bleed geometry and meta type (design-system/components/menu).
  return (
    <button
      type="button"
      role="menuitem"
      data-skill-row={skill.id}
      onClick={() => onPick(skill)}
      onMouseMove={onHover}
      disabled={installing}
      className={`${MENU_ITEM_CLASS} disabled:cursor-wait ${
        // One paint for the one state: the keyboard cursor and the pointer
        // hover are the same "you are here" and share `--bg-hover` — the
        // `--bg-active` split painted two colors for it (the ConnectorPicker
        // defect the selection sweep fixed; ripple review 2026-08-05 caught this twin).
        active
          ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]'
      }`}
    >
      <SkillGlyph
        className={`icon-xs shrink-0 ${active ? 'text-[color:var(--accent-primary)]' : 'text-[color:var(--text-subtle)]'}`}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <TruncatedText
          as="span"
          text={skill.name}
          className="max-w-[60%] shrink-0 font-medium text-[color:var(--text-strong)]"
        />
        {skill.description ? (
          <TruncatedText as="span" text={skill.description} className="min-w-0 flex-1 text-[color:var(--text-muted)]" />
        ) : null}
      </span>
      {installing ? (
        <Spinner className="shrink-0" />
      ) : notInstalled ? (
        <span className="shrink-0 text-micro font-medium text-[color:var(--accent-primary)]">Install</span>
      ) : (
        // The source is the only thing on the row that says where the skill
        // comes from, so the chip is named by its own text rather than marked
        // decorative (design-system/components/badge, "Only a count is a live
        // region").
        <Badge className="shrink-0">{SOURCE_LABEL[skill.source]}</Badge>
      )}
    </button>
  )
}

// The grouped list core shared by every anchor mode. Selection is index-based
// over the flattened installed→available order; the parent owns query state.
function SkillList({
  groups,
  loading,
  error,
  query,
  activeIndex,
  installingId,
  onPick,
  onActiveIndexChange,
}: {
  groups: SkillGroups
  loading: boolean
  error: string | null
  query: string
  activeIndex: number
  installingId: string | null
  onPick: (skill: WorkspaceSkill) => void
  onActiveIndexChange: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement | null>(null)

  // Keep the active row visible under keyboard navigation.
  useEffect(() => {
    const activeSkill = groups.flat[activeIndex]
    if (!activeSkill) return
    listRef.current
      ?.querySelector(`[data-skill-row="${CSS.escape(activeSkill.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, groups.flat])

  if (loading && groups.flat.length === 0) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
        <Spinner />
        Loading skills…
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-2.5 py-3 text-meta text-[color:var(--tone-error)]" role="status">
        {error}
      </div>
    )
  }
  if (groups.flat.length === 0) {
    return (
      <div className="px-2.5 py-3 text-meta text-[color:var(--text-muted)]" role="status">
        {query.trim() ? `No skills match “${query.trim()}”` : 'No skills yet'}
      </div>
    )
  }

  const renderGroup = (label: string, skills: PickerSkill[], offset: number) =>
    skills.length > 0 ? (
      <div className="py-0.5">
        <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>{label}</div>
        {skills.map((skill, index) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            active={offset + index === activeIndex}
            installing={installingId === skill.id}
            onPick={onPick}
            onHover={() => onActiveIndexChange(offset + index)}
          />
        ))}
      </div>
    ) : null

  return (
    // Vertical inset only: rows reach both side edges so the highlight is
    // full-bleed, per the menu spec — a horizontal inset here is what forced
    // the nested-card fill the spec rules out.
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
      {renderGroup('Installed', groups.installed, 0)}
      {renderGroup('Available to install', groups.available, groups.installed.length)}
    </div>
  )
}

// Shared pick pipeline: available entries install first (busy row) — for every
// project, so the skill is there in the next chat too — then hand the skill,
// flipped to installed, to the caller.
function usePickWithInstall(onPick: (skill: WorkspaceSkill) => void, onError: (message: string) => void) {
  const [installingId, setInstallingId] = useState<string | null>(null)
  const pick = useCallback(
    async (skill: PickerSkill) => {
      const { fromSource, ...row } = skill
      if (row.installState !== 'available') {
        onPick(row)
        return
      }
      setInstallingId(row.id)
      const result = fromSource
        ? await installFromSource(fromSource)
        : await ensureSkillForAgent({ workspaceRoot: null, skill: row })
      setInstallingId(null)
      if (!result.ok) {
        onError(result.message)
        return
      }
      onPick({ ...row, installState: 'installed' })
    },
    [onError, onPick],
  )
  return { installingId, pick }
}

async function installFromSource(from: {
  sourceId: string
  skillId: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const result = await window.api.skillsInstall({ sourceId: from.sourceId, skillId: from.skillId, scope: 'global' })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Unable to install the skill.' }
  }
}

export type SkillPickerPopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceRoot: string | null
  // The CLI plugin the picked skill is for. Set it wherever one agent's CLI is
  // known, and the list becomes what that agent can actually reach instead of
  // everything in the workspace. Omit it where no single CLI applies.
  pluginId?: string | null
  onPick: (skill: WorkspaceSkill) => void
  // "Manage skills →" footer; omit to hide (e.g. surfaces with no route to
  // Connectors → Installed).
  onManageSkills?: () => void
  placement?: PopoverPlacement
  // Custom trigger (e.g. a panel-header icon button). Defaults to the quiet
  // composer "Skills" chip.
  renderTrigger?: PopoverProps['renderTrigger']
  // Opt-in inventory filter (default: show every skill). A surface that can only
  // honor a subset — e.g. a scheduled automation, which installs into a per-run
  // worktree and so only supports built-in skills — narrows the list here rather
  // than offering skills it cannot attach.
  filterSkill?: (skill: WorkspaceSkill) => boolean
}

// Chip-anchored mode: a trigger opens the popover with its own search input;
// search, arrows and Enter all work from the input (keyboard-only operable).
export function SkillPickerPopover({
  open,
  onOpenChange,
  workspaceRoot,
  pluginId = null,
  onPick,
  onManageSkills,
  placement = 'top-start',
  renderTrigger,
  filterSkill,
}: SkillPickerPopoverProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const inventory = usePickerSkills(workspaceRoot, pluginId, open)
  const visibleSkills = useMemo(
    () => (filterSkill ? inventory.skills.filter(filterSkill) : inventory.skills),
    [inventory.skills, filterSkill],
  )
  const groups = useMemo(() => groupSkills(visibleSkills, query), [visibleSkills, query])

  const { installingId, pick } = usePickWithInstall((skill) => {
    onOpenChange(false)
    onPick(skill)
  }, setActionError)

  const clampedActive = Math.min(activeIndex, Math.max(0, groups.flat.length - 1))

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(event)) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // Nothing to move to while the skills are still loading. Stepping anyway
      // stored -1, which no clamp lifts, so the list arrived with nothing
      // highlighted and Enter did nothing.
      if (groups.flat.length === 0) return
      setActiveIndex(Math.min(clampedActive + 1, groups.flat.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(clampedActive - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const skill = groups.flat[clampedActive]
      if (skill) void pick(skill)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          setActiveIndex(0)
          setActionError(null)
        }
        onOpenChange(next)
      }}
      ariaLabel="Use a skill"
      popupRole="menu"
      placement={placement}
      renderTrigger={
        renderTrigger ??
        (({ ref, triggerProps, togglePopover }) => (
          <button
            ref={ref}
            type="button"
            onClick={togglePopover}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-meta font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]"
            {...triggerProps}
          >
            <StarGlyph filled={false} stroked className="icon-sm" />
            Skills
          </button>
        ))
      }
    >
      <div className="flex max-h-[400px] w-[340px] flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5">
          <svg
            className="icon-xs shrink-0 text-[color:var(--text-disabled)]"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setActiveIndex(0)
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search skills…"
            aria-label="Search skills"
            className={`min-w-0 flex-1 bg-transparent px-1 py-1 text-body text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
          />
        </div>
        <SkillList
          groups={groups}
          loading={inventory.loading}
          error={actionError ?? inventory.error}
          query={query}
          activeIndex={clampedActive}
          installingId={installingId}
          onPick={(skill) => void pick(skill)}
          onActiveIndexChange={setActiveIndex}
        />
        {onManageSkills ? (
          <div className="flex items-center justify-end border-t border-[color:var(--border-subtle)] px-2.5 py-1.5">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onManageSkills()
              }}
              className={`text-micro font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
            >
              Manage skills →
            </button>
          </div>
        ) : null}
      </div>
    </Popover>
  )
}

export type InlineSkillPickerHandle = {
  // Returns true when the event was consumed (matches existed).
  moveSelection: (delta: 1 | -1) => boolean
  pickActive: () => boolean
  matchCount: () => number
}

// The type-ahead surface's height budget. The cap is the combobox listbox's
// (roughly ten rows before it scrolls); the floor is what keeps the list
// usable when the composer has grown until only a sliver of transcript is
// left above it — below that the shell's own flip-and-clamp takes over.
const INLINE_PICKER_MAX_HEIGHT = 340
const INLINE_PICKER_MIN_HEIGHT = 120
// The shell's 8px viewport clamp plus its 4px trigger gap: what the surface
// can never occupy between the top of the window and the top of the composer.
const INLINE_PICKER_VIEWPORT_INSET = 12

// Type-ahead mode: the same list anchored to the caller's composer box. Focus
// stays in the caller's textarea; it forwards ↑↓/⏎ through the ref handle and
// drives `query` from the draft text after the trigger character. Rendered
// only while open, as a child of the composer box (which must be `relative`):
// the anchor covers the box, so the surface hugs its top or bottom edge and
// spans its width.
//
// It rides the shared `Popover` engine rather than positioning itself. The
// first version was an `absolute bottom-full` surface inside the composer's
// container, which meant its height was whatever space happened to be above
// the composer — a long draft grew the composer, the surface slid up with it,
// and the top rows left the window with no way to scroll to them. The shell
// portals to <body> and clamps inside the viewport; this picks the side of the
// composer with room (above, where a chat composer sits at the foot of its
// pane; below, where the New chat door's composer sits near the top of the
// window) and caps its own height to that room, so it never has to choose
// between covering the field and running off an edge.
export const InlineSkillPicker = forwardRef<
  InlineSkillPickerHandle,
  {
    workspaceRoot: string | null
    pluginId?: string | null
    query: string
    onPick: (skill: WorkspaceSkill) => void
    // Fires when the settled (not loading, not errored) match count changes,
    // so the caller can dismiss on non-matching text per the trigger contract.
    onMatchCountChange?: (count: number) => void
    // A light dismiss the shell saw — a pointer landing outside the surface, or
    // an Escape the caller's field did not already consume. The caller marks
    // the trigger dismissed so the typed character stays literal.
    onDismiss?: () => void
    // Skills listed elsewhere, in place of this machine's: a paired machine's,
    // for a chat that runs there. Picked as they are listed, never installed
    // here; that machine installs one into the chat's folder when the message
    // carrying it goes.
    inventory?: SkillInventoryState
  }
>(function InlineSkillPicker(
  { workspaceRoot, pluginId = null, query, onPick, onMatchCountChange, onDismiss, inventory: listed },
  ref,
) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const local = usePickerSkills(listed ? null : workspaceRoot, pluginId, !listed)
  const inventory = listed ?? local
  const groups = useMemo(() => groupSkills(inventory.skills, query), [inventory.skills, query])
  const clampedActive = Math.min(activeIndex, Math.max(0, groups.flat.length - 1))

  const installing = usePickWithInstall(onPick, setActionError)
  const installingId = listed ? null : installing.installingId
  const pickListed = useCallback(async ({ fromSource: _source, ...skill }: PickerSkill) => onPick(skill), [onPick])
  const pick = listed ? pickListed : installing.pick

  // Reset the highlight whenever typing changes the filter.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (inventory.loading || inventory.error) return
    onMatchCountChange?.(groups.flat.length)
  }, [groups.flat.length, inventory.error, inventory.loading, onMatchCountChange])

  useImperativeHandle(
    ref,
    () => ({
      moveSelection: (delta) => {
        if (groups.flat.length === 0) return false
        setActiveIndex((prev) => {
          const clamped = Math.min(prev, groups.flat.length - 1)
          return Math.max(0, Math.min(clamped + delta, groups.flat.length - 1))
        })
        return true
      },
      pickActive: () => {
        const skill = groups.flat[clampedActive]
        if (!skill) return false
        void pick(skill)
        return true
      },
      matchCount: () => groups.flat.length,
    }),
    [clampedActive, groups.flat, pick],
  )

  // The room beside the composer is the surface's height budget. Above is the
  // preferred side (the list completes the field the way a menu completes its
  // trigger, and a chat composer sits at the foot of its pane); below wins
  // only when above cannot hold the full list and below has more. Measured on
  // every render (each keystroke re-renders this, and each keystroke is what
  // can grow the composer) and on resize; React drops a write of the same
  // value, so the re-measure is free when nothing moved.
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [fit, setFit] = useState<{ side: 'top' | 'bottom'; maxHeight: number }>({
    side: 'top',
    maxHeight: INLINE_PICKER_MAX_HEIGHT,
  })
  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const above = rect.top - INLINE_PICKER_VIEWPORT_INSET
      const below = window.innerHeight - rect.bottom - INLINE_PICKER_VIEWPORT_INSET
      const side = above >= INLINE_PICKER_MAX_HEIGHT || above >= below ? 'top' : 'bottom'
      const room = side === 'top' ? above : below
      const maxHeight = Math.max(INLINE_PICKER_MIN_HEIGHT, Math.min(INLINE_PICKER_MAX_HEIGHT, room))
      // Same values, same state: a fresh object every render would re-render
      // forever, since this effect has no dependency list.
      setFit((current) => (current.side === side && current.maxHeight === maxHeight ? current : { side, maxHeight }))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onDismiss?.()
    },
    [onDismiss],
  )

  return (
    // The anchor: an inert layer covering the composer box, so the shell's
    // trigger rect IS the box and either edge can be glued to. It is not the
    // surface (the shell portals that to <body>), so nothing here is focusable
    // or announced. `flex`, so the shell's empty inline-flex wrapper is a
    // stretched flex item and not an inline box sitting on a line's baseline
    // — which put the anchor a strut below the box's top edge. Not
    // `aria-hidden`: the shell closes a popover whose anchor sits in a hidden
    // subtree (its trigger has left the screen), which shut this list on the
    // first frame after it opened. The layer is empty, so there is nothing
    // here to hide anyway.
    <div ref={anchorRef} className="pointer-events-none absolute inset-0 flex">
      <Popover
        open
        onOpenChange={onOpenChange}
        ariaLabel="Use a skill"
        popupRole="menu"
        placement={fit.side === 'top' ? 'top-start' : 'bottom-start'}
        // Glass, because this is drawn over the transcript the person is
        // reading — see the material note on `Popover`.
        material="glass"
        className="w-full"
        renderTrigger={() => null}
        // Composer-wide, like the field it completes; the shell mirrors the
        // anchor's width into the variable and clamps the rest.
        surfaceClassName="w-[var(--popover-trigger-width)] max-w-[calc(100vw-16px)]"
      >
        <div className="flex flex-col overflow-hidden" style={{ maxHeight: fit.maxHeight }}>
          <SkillList
            groups={groups}
            loading={inventory.loading}
            error={actionError ?? inventory.error}
            query={query}
            activeIndex={clampedActive}
            installingId={installingId}
            onPick={(skill) => void pick(skill)}
            onActiveIndexChange={setActiveIndex}
          />
        </div>
      </Popover>
    </div>
  )
})
