import React, { type JSX } from 'react'

import CliIcon from '../CliIcon'
import { NewChip } from './NewChip'
import { Popover } from './Popover'
import { StarGlyph } from './StarGlyph'
import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS, FOCUS_RING_WITHIN_INPUT_CLASS } from './tokens'
import {
  ReasoningSelector,
  hasContextWindows,
  hasReasoningAxes,
  hasReasoningLevels,
  reasoningTriggerLabel,
} from './ReasoningSelector'
import { isLegacyCompositionKey, modelFavouriteKey, toggleModelFavourite, useModelFavourites } from './modelFavourites'
import {
  buildModelFamilies,
  familyForModel,
  meaningfulModelId,
  normalizeCliRuntimeOptions,
  type CliModelFamily,
  type CliRuntimeOption,
  type CliRuntimePickerOption,
} from './cliRuntimeCatalog'
import type { AgentCli } from '../../types/workspace'
import { isImeKey } from '../../utils/imeKey'

export type { CliRuntimeOption, CliRuntimePickerOption } from './cliRuntimeCatalog'

// The model popover: a provider rail down the left, search over a flat list of
// models on the right. It replaces a grouped listbox whose every CLI header and
// indented child competed for the same scan — with the rail carrying the
// provider axis, a row only has to say which model it is.
//
// Each row is one model, not one catalog id: context-window variants of the
// same model collapse into a family (see cliRuntimeCatalog). Selecting a row
// selects the CLI and the model together, in one action.
//
// A runtime is ONE control, everywhere (owner, 2026-07-30). Reasoning level and
// context window ride this surface's trailing row — they are properties of the
// model you just picked, and as a second pill beside the trigger they read as an
// unrelated setting: a lone "Standard ⌄" next to "Opus 5 ⌄" that nobody could
// name. Hosts get the same picker with the same axes in the same place, whether
// they open it from the New chat engine control, a Backlog handoff or a card.

const QUICK_SELECT_LIMIT = 9

// The starred rail entry. Sentinel-shaped so it cannot collide with a plugin id.
const FAVOURITES_FILTER = '__starred__'

type RailFilter = AgentCli | typeof FAVOURITES_FILTER

// One rendered list entry: a model row under the key its star is stored as.
type VisibleEntry = { row: ModelRow; key: string }

type ModelRow = {
  key: string
  cli: AgentCli
  /** The model's name, or the CLI's when this is the CLI's own default row. */
  name: string
  /** The provider line under the name. */
  provider: string
  /** Render the name in the mono face — an id nothing labelled. */
  mono: boolean
  /** The raw id beside a friendly label, when it adds information the label does not. */
  monoId?: string
  /** Muted trailing annotation: today, a persisted model the catalog dropped. */
  note?: string
  /** The catalog id this row selects; null selects the CLI's own default model. */
  model: string | null
  family?: CliModelFamily
  /** A probe on this machine first listed this model within NEW_FOR_DAYS. */
  isNew?: boolean
}

// Hosted models (manifest-derived `hostedVia`, e.g. Kimi K3 and Z.AI GLM riding
// the claude binary) name their host on the provider line. The old listbox said
// it once in a section heading; with a provider rail there is no section to
// hang it on, and the fact — this runs on someone else's binary — is exactly
// the kind a row cannot infer.
function providerLine(option: CliRuntimeOption): string {
  return option.hostedVia === 'claude-code' ? `${option.label} · via Claude Code` : option.label
}

// Every selectable runtime, flattened. Order is rail order, and within a
// provider the CLI's own default leads its models — the same reading order the
// grouped listbox had, minus the indentation that carried it.
export function buildModelRows(
  options: ReadonlyArray<CliRuntimeOption>,
  currentCli: AgentCli,
  effectiveModelFor: (cli: AgentCli) => string | undefined,
): ModelRow[] {
  const rows: ModelRow[] = []
  for (const option of options) {
    const provider = providerLine(option)
    const families = buildModelFamilies(option.modelSelection?.options)
    rows.push({
      key: modelFavouriteKey(option.value, null),
      cli: option.value,
      name: option.label,
      provider,
      mono: false,
      model: null,
    })
    for (const family of families) {
      rows.push({
        key: modelFavouriteKey(option.value, family.defaultId),
        cli: option.value,
        name: family.label ?? family.defaultId,
        provider,
        mono: !family.label,
        monoId: meaningfulModelId(family.defaultId, family.label),
        model: family.defaultId,
        family,
        ...(family.isNew ? { isNew: true } : {}),
      })
    }
    // A persisted model no longer in the catalog still launches with that id;
    // surface it as its own row, marked "Not listed" so it reads as active but
    // not one of the configured ids.
    const effective = option.value === currentCli ? effectiveModelFor(option.value) : undefined
    if (option.modelSelection && effective && !familyForModel(families, effective)) {
      rows.push({
        key: modelFavouriteKey(option.value, effective),
        cli: option.value,
        name: effective,
        provider,
        mono: true,
        note: 'Not listed',
        model: effective,
      })
    }
  }
  return rows
}

function rowMatchesQuery(row: ModelRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    row.name.toLowerCase().includes(needle) ||
    row.provider.toLowerCase().includes(needle) ||
    (row.model ?? '').toLowerCase().includes(needle)
  )
}

export function CliModelPopoverSurface({
  ariaLabel,
  options,
  currentCli,
  effectiveModelFor,
  effectiveReasoningFor,
  onSelectReasoning,
  onSelectCli,
  onSelectModel,
  showReasoning = false,
  showReasoningLevels = true,
  reasoningAriaLabel,
  groupNote,
  permissions,
}: {
  ariaLabel: string
  options: ReadonlyArray<CliRuntimeOption>
  currentCli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  /** Opt-in effort support: both accessors must be set for the Reasoning group to appear. */
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  /**
   * Render the reasoning selector as a trailing row of this surface. This is
   * where the axes live for every host, so the surface reads the same wherever
   * it opens.
   */
  showReasoning?: boolean
  /**
   * Whether that row offers the effort levels. Off where the launch could not
   * honour a level (a paired machine that keeps none), so the picker does not
   * show a choice that would go nowhere; the context window, which is a model
   * choice, stays.
   */
  showReasoningLevels?: boolean
  /**
   * Accessible name for that trailing control. Hosts with a trigger name it for
   * the runtime it belongs to ("Reasoning for Agent runtime"), so a screen
   * reader hears which agent the level applies to rather than a bare axis name.
   */
  reasoningAriaLabel?: string
  /**
   * A quiet line about ONE runtime, drawn as that runtime's group heading above
   * its rows — the shape Frame 4 of `2026-09-06-extensions-home.html` gives a
   * card's `require.cli` ("Claude Code · the card asks for this one").
   *
   * A heading rather than part of the trailing row, because the sentence is
   * about the list it sits over. The rail already groups this surface by provider, so the heading is shown only
   * while that runtime's own group is the one on screen: under a search the
   * results span every provider and each row names its own.
   */
  groupNote?: { cli: AgentCli; note: string }
  /**
   * The permission control, seated at the TRAILING end immediately right of the
   * effort control: the two dropdowns belong side by side in that order, and
   * where they sit is this row's business, not each host's. Hosts that do not
   * configure permissions pass none. The highlighted row supplies the runtime
   * and model so browsing another agent cannot edit the previous row's preset.
   */
  permissions?: (cli: AgentCli, model: string | null) => React.ReactNode
}): JSX.Element {
  const favourites = useModelFavourites()
  const favouriteSet = React.useMemo(() => new Set(favourites), [favourites])
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<RailFilter>(() =>
    options.some((option) => option.value === currentCli) ? currentCli : (options[0]?.value ?? currentCli),
  )
  const railRef = React.useRef<HTMLDivElement | null>(null)
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  const listId = React.useId()

  // Search takes focus on open. Not React's `autoFocus`: this surface is
  // portaled into a Popover that paints `visibility: hidden` until it has
  // measured itself, and a hidden element cannot take focus — the mount-time
  // call lands nowhere and a keyboard user is stranded on the trigger. Retrying
  // once the surface is visible is what makes the popover typeable.
  React.useEffect(() => {
    const input = searchRef.current
    if (!input) return
    input.focus()
    if (document.activeElement === input) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const rows = React.useMemo(
    () => buildModelRows(options, currentCli, effectiveModelFor),
    [options, currentCli, effectiveModelFor],
  )
  const rowByKey = React.useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])
  // Every stored star that still resolves on this machine, in the order they
  // were starred. A legacy model+role star is skipped: there is no role to
  // spawn it as.
  const starredEntries = React.useMemo<VisibleEntry[]>(() => {
    const entries: VisibleEntry[] = []
    for (const key of favourites) {
      if (isLegacyCompositionKey(key)) continue
      const row = rowByKey.get(key)
      if (row) entries.push({ row, key })
    }
    return entries
  }, [favourites, rowByKey])
  const hasFavourites = starredEntries.length > 0

  // Unstarring the last favourite retires the starred rail entry underneath the
  // filter that is pointing at it. Falling back to the current CLI is what
  // stops that leaving an empty list beside a rail where nothing is selected —
  // and, because the rail's tab stop follows the active entry, a rail Tab
  // cannot reach either.
  const filterIsLive = filter === FAVOURITES_FILTER ? hasFavourites : true
  const activeFilter: RailFilter = filterIsLive ? filter : currentCli
  // Searching reaches across every provider — a name you can spell is faster
  // than a rail you have to pick first — so a live query suspends the filter
  // rather than intersecting with it.
  const searching = query.trim().length > 0
  const composeEntry = (row: ModelRow): VisibleEntry => ({
    row,
    key: modelFavouriteKey(row.cli, row.model),
  })
  const visible: VisibleEntry[] = searching
    ? rows.filter((row) => rowMatchesQuery(row, query)).map(composeEntry)
    : activeFilter === FAVOURITES_FILTER
      ? starredEntries
      : rows.filter((row) => row.cli === activeFilter).map(composeEntry)

  const effectiveModel = effectiveModelFor(currentCli)
  const isSelected = (row: ModelRow): boolean => {
    if (row.cli !== currentCli) return false
    if (row.model === null) return !effectiveModel
    if (row.family) return row.family.variants.some((variant) => variant.id === effectiveModel)
    return row.model === effectiveModel
  }
  const selectedRowIndex = visible.findIndex((entry) => isSelected(entry.row))

  // ── the keyboard model ─────────────────────────────────────────
  //
  // The search field is the combobox and keeps focus for the whole life of this
  // surface; the highlighted row is named by `aria-activedescendant` and is
  // never focused. This list used to move real DOM focus onto the row, which
  // meant the first arrow took focus off the field and every keystroke after it
  // went to the row instead of the query — you could narrow, or walk, but not
  // both. The ruling and its two clauses are in
  // `design-system/components/combobox/component.md`.
  //
  // The highlight is tracked by row KEY, not index: narrowing the list leaves it
  // on the same model when that model survives the query, and falls back to the
  // selected row (then the first) when it does not. An index would point at a
  // different model in the window between a rebuild and the effect re-anchoring
  // it.
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const activeRowRef = React.useRef<HTMLDivElement | null>(null)
  const activeIndex = ((): number => {
    const held = activeKey ? visible.findIndex((entry) => entry.key === activeKey) : -1
    if (held >= 0) return held
    if (selectedRowIndex >= 0) return selectedRowIndex
    return visible.length > 0 ? 0 : -1
  })()
  const optionId = (index: number): string => `${listId}-option-${index}`
  const permissionRow = visible[activeIndex]?.row
  const permissionControl = permissionRow
    ? permissions?.(permissionRow.cli, isSelected(permissionRow) ? (effectiveModel ?? null) : permissionRow.model)
    : null

  // `scrollIntoView` is optional-called: jsdom does not implement it, and the
  // node tests drive this surface for real rather than through a shim.
  React.useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const choose = ({ row }: VisibleEntry): void => {
    if (row.model === null) {
      const option = options.find((entry) => entry.value === row.cli)
      if (option?.modelSelection) onSelectModel(row.cli, null)
      else onSelectCli(row.cli)
      return
    }
    // Re-choosing the family that is already selected must not silently drop
    // the context window the user picked on it.
    if (isSelected(row) && effectiveModel) {
      onSelectModel(row.cli, effectiveModel)
      return
    }
    onSelectModel(row.cli, row.model)
  }

  // ⌘1–⌘9 pin to the first nine rows of the CURRENT filter, so the chord a row
  // advertises is the row it selects. Bound on the whole surface, because the
  // search field owns focus for most of the popover's life.
  const onSurfaceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.metaKey || event.ctrlKey) || !/^[1-9]$/.test(event.key)) return
    const entry = visible[Number(event.key) - 1]
    if (!entry) return
    event.preventDefault()
    choose(entry)
  }

  // True when the caret has nothing left to its right, so a horizontal key is
  // free for the list. An empty field is trivially at its end.
  const caretAtEnd = (): boolean => {
    const input = searchRef.current
    if (!input) return true
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    return start === end && start === input.value.length
  }

  // A key this field consumes stops here. A host that is a MENU runs
  // `roveMenuFocus` on its own keydown, which answers ArrowUp/Down/Home/End by
  // moving real focus onto one of ITS items. Left to bubble, the host would take
  // focus off the field on the first arrow, which is the exact failure the
  // ruling exists to end. Escape is not consumed here, so
  // the surface still closes from anywhere inside it.
  const consume = (event: React.KeyboardEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeKey(event)) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      consume(event)
      if (visible.length === 0) return
      const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length
      setActiveKey(visible[next]?.key ?? null)
      return
    }
    if (event.key === 'Enter') {
      if (activeIndex < 0) return
      consume(event)
      const entry = visible[activeIndex]
      if (entry) choose(entry)
      return
    }
    // Home/End belong to the caret whenever the field has text: this is a field
    // you type into, and stealing them leaves no way to reach the ends of the
    // query. With nothing typed there is no caret to serve, so they jump the
    // list.
    if ((event.key === 'Home' || event.key === 'End') && query.length === 0) {
      if (visible.length === 0) return
      consume(event)
      setActiveKey(visible[event.key === 'Home' ? 0 : visible.length - 1]?.key ?? null)
      return
    }
    // The row's own control, reached without a pointer. The star is revealed on
    // hover, so with focus pinned to the field it would otherwise have no
    // keyboard path at all — this is the escape hatch the ruling requires of any
    // picker whose rows carry a control. ArrowLeft on the star comes back.
    if (event.key === 'ArrowRight' && caretAtEnd()) {
      const star = activeRowRef.current?.querySelector<HTMLButtonElement>('[data-model-star="true"]')
      if (!star) return
      consume(event)
      star.focus()
    }
  }

  // The rail is one tab stop with arrows moving inside it, as a tablist is.
  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index < 0 || tabs.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    tabs[(index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length]?.focus()
  }

  const reasoningWired = Boolean(onSelectReasoning && effectiveReasoningFor)
  const currentOption = options.find((option) => option.value === currentCli)
  const currentFamily = familyForModel(buildModelFamilies(currentOption?.modelSelection?.options), effectiveModel)
  const reasoningAxes = {
    reasoningSelection: currentOption?.reasoningSelection,
    family: currentFamily,
    reasoningEnabled: reasoningWired,
  }

  const railEntries: Array<{
    key: RailFilter
    label: string
    glyph: React.ReactNode
  }> = [
    ...(hasFavourites
      ? [
          {
            key: FAVOURITES_FILTER as RailFilter,
            label: 'Starred',
            glyph: <StarGlyph filled className="size-icon-sm" />,
          },
        ]
      : []),
    ...options.map((option) => ({
      key: option.value as RailFilter,
      label: option.label,
      glyph: <CliIcon cli={option.value} className="size-icon-sm" />,
    })),
  ]
  const activeRail = searching ? null : activeFilter
  const chordModifier = quickSelectModifier()

  return (
    <div className="flex w-[380px] max-w-[calc(100vw-2rem)]" onKeyDown={onSurfaceKeyDown}>
      <div
        ref={railRef}
        // A one-of-N filter, not tabs: `tablist`/`tab` promises a tabpanel this
        // rail does not have, and a screen reader announces one.
        role="radiogroup"
        aria-label="Provider"
        aria-orientation="vertical"
        onKeyDown={onRailKeyDown}
        className="flex flex-col gap-0.5 border-r border-[color:var(--border-subtle)] p-1.5"
      >
        {railEntries.map((entry, index) => (
          <RailButton
            key={String(entry.key)}
            label={entry.label}
            controls={listId}
            selected={activeRail === entry.key}
            // Roving tab stop: the active filter owns it, and with search
            // suspending the filter the first entry keeps the rail reachable.
            tabbable={activeRail === entry.key || (activeRail === null && index === 0)}
            onSelect={() => setFilter(entry.key)}
          >
            {entry.glyph}
          </RailButton>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The search row is a composite: the input is the tab stop, the row is
            the box a user sees, so the row draws the indicator — the same
            treatment InboxSearchInput uses. It matters more here than in an
            ordinary field, because this input takes focus the moment the
            popover opens: without it the surface opens with a focused element
            and nothing marking it. */}
        <div
          className={`flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2 ${FOCUS_RING_WITHIN_INPUT_CLASS}`}
        >
          <SearchGlyph />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveKey(null)
            }}
            onKeyDown={onQueryKeyDown}
            aria-label={`Search ${ariaLabel}`}
            // This field IS the combobox: it owns the query, keeps focus while
            // the arrows move the highlight, and names the highlighted row
            // through `aria-activedescendant`. The list below is rendered for as
            // long as this surface is, hence the constant `aria-expanded`.
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder="Search models…"
            className="min-w-0 flex-1 bg-transparent text-meta text-[color:var(--text-default)] outline-none placeholder:text-[color:var(--text-subtle)] [&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        {/* The group heading, when a host has something to say about the group
            below it. Outside the listbox rather than in it: a `role="listbox"`
            takes options and groups of options, and this is a caption. */}
        {groupNote && !searching && activeRail === groupNote.cli ? (
          <p className="m-0 px-3 pt-2 text-micro text-[color:var(--text-muted)]">
            {options.find((option) => option.value === groupNote.cli)?.label ?? groupNote.cli}
            <span className="ml-1.5 text-[color:var(--text-subtle)]">{groupNote.note}</span>
          </p>
        ) : null}
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="max-h-[300px] min-h-0 flex-1 overflow-y-auto p-1"
        >
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-meta text-[color:var(--text-subtle)]">
              {searching ? 'No models match.' : 'No models here yet.'}
            </p>
          ) : (
            visible.map((entry, index) => (
              <ModelRowView
                key={entry.key}
                id={optionId(index)}
                rowRef={activeIndex === index ? activeRowRef : undefined}
                row={entry.row}
                selected={isSelected(entry.row)}
                active={activeIndex === index}
                chord={index < QUICK_SELECT_LIMIT ? index + 1 : undefined}
                chordModifier={chordModifier}
                showProvider={searching || activeFilter === FAVOURITES_FILTER}
                starred={favouriteSet.has(entry.key)}
                onHighlight={() => setActiveKey(entry.key)}
                onToggleStar={() => toggleModelFavourite(entry.key)}
                onLeaveStar={() => searchRef.current?.focus()}
                onSelect={() => choose(entry)}
              />
            ))
          )}
        </div>

        {/* ONE trailing row, not a stack of them (owner, 2026-09-05). Permissions
            and effort are both settings about the row above, and they used to sit
            on two bordered bands — the permission chip alone on one, the effort
            chip alone on the next. They belong on the same line, so this row owns
            the chrome and the hosts pass bare controls into it: the two
            dropdowns that settle the row above, effort on the left,
            permissions on its right. Same kind of
            control, same line — which is the pairing the two-band layout broke.

            It wraps rather than truncates: both chips are as wide as the value
            they carry, and a runtime with a long level name plus a permission
            word can outgrow a narrow surface. A second line beats a clipped
            one. */}
        {permissionControl ||
        (showReasoning &&
          (showReasoningLevels ? hasReasoningAxes(reasoningAxes) : hasContextWindows(reasoningAxes))) ? (
          <div className="flex flex-wrap items-center gap-1 border-t border-[color:var(--border-subtle)] px-1.5 py-1">
            <span className="flex-1" />
            {/* Two controls, not one composed trigger: context window and effort
                are separate decisions about the chosen model, and "Auto ·
                Standard" made changing either one a menu-open away from knowing
                which half you were reading. Context sits left of reasoning — it
                is a property of the model above it, and effort is the thing
                changed more often. Each is withheld unless the runtime actually
                offers that axis. */}
            {showReasoning && hasContextWindows(reasoningAxes) ? (
              <ReasoningSelector
                scope="context"
                ariaLabel="Context window"
                reasoningSelection={currentOption?.reasoningSelection}
                reasoning={effectiveReasoningFor?.(currentCli)}
                onSelectReasoning={
                  reasoningWired ? (reasoning) => onSelectReasoning!(currentCli, reasoning) : undefined
                }
                family={currentFamily}
                model={effectiveModel}
                onSelectModel={(model) => onSelectModel(currentCli, model)}
              />
            ) : null}
            {showReasoning && showReasoningLevels && hasReasoningLevels(reasoningAxes) ? (
              <ReasoningSelector
                scope="reasoning"
                ariaLabel={reasoningAriaLabel ?? 'Reasoning'}
                reasoningSelection={currentOption?.reasoningSelection}
                reasoning={effectiveReasoningFor?.(currentCli)}
                onSelectReasoning={
                  reasoningWired ? (reasoning) => onSelectReasoning!(currentCli, reasoning) : undefined
                }
                family={currentFamily}
                model={effectiveModel}
                onSelectModel={(model) => onSelectModel(currentCli, model)}
              />
            ) : null}
            {permissionControl}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function RailButton({
  label,
  selected,
  tabbable,
  controls,
  onSelect,
  children,
}: {
  label: string
  selected: boolean
  tabbable: boolean
  controls: string
  onSelect: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <Tooltip content={label} placement="bottom">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-controls={controls}
        aria-label={label}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className={[
          'interactive grid size-7 shrink-0 place-items-center rounded-sm',
          selected
            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// One model. The row is a `div[role=option]` rather than a `<button>` because it
// hosts the star's own button, and a button inside a button is invalid.
//
// A row is never focused: the search field keeps focus and names the
// highlighted row through `aria-activedescendant`, so a row carries no tab stop
// and no key handler of its own. `aria-selected` still marks the CURRENT
// runtime, which is a different fact from the highlight and outlives it —
// `data-active` carries the highlight for the tests that assert on it.
function ModelRowView({
  id,
  rowRef,
  row,
  selected,
  active,
  chord,
  chordModifier,
  showProvider,
  starred,
  onHighlight,
  onToggleStar,
  onLeaveStar,
  onSelect,
}: {
  id: string
  rowRef?: React.Ref<HTMLDivElement>
  row: ModelRow
  /** The CURRENT runtime — a persistent fact, not the keyboard highlight. */
  selected: boolean
  /** The keyboard highlight: this row is the search field's `aria-activedescendant`. */
  active: boolean
  chord?: number
  chordModifier: string
  /** True while the list spans more than one provider (searching, or the starred filter). */
  showProvider: boolean
  starred: boolean
  onHighlight: () => void
  onToggleStar: () => void
  /** ArrowLeft on the star hands focus back to the field that owns it. */
  onLeaveStar: () => void
  onSelect: () => void
}): JSX.Element {
  const detail = [showProvider && row.model !== null ? row.provider : null, row.monoId].filter(Boolean).join(' · ')
  return (
    <div
      id={id}
      ref={rowRef}
      role="option"
      aria-selected={selected}
      data-model-row="true"
      data-active={active ? 'true' : undefined}
      onClick={onSelect}
      onPointerEnter={onHighlight}
      className={[
        'interactive group/row flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pl-2 pr-1.5 text-left',
        selected
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : active
            ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
      ].join(' ')}
    >
      <CliIcon cli={row.cli} className="size-icon-sm shrink-0 text-[color:var(--text-muted)]" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate text-body ${row.mono ? 'font-mono text-meta' : ''}`} title={row.name}>
            {row.name}
          </span>
          {/* "New": a probe on this machine first listed this model within
              NEW_FOR_DAYS (the merge sets the mark). A chip, not a hoist: the row stays
              where the catalog put it so a muscle-memory pick still lands. The
              drawing is the kit's, shared with the Design door's "arrived since
              you last looked" marker, so one word cannot have two looks. */}
          {row.isNew ? <NewChip /> : null}
        </span>
        {/* The second line qualifies the name; it never restates it. The
            provider appears only while the list spans more than one — under a
            rail filter the rail already said it, and on the CLI's own row the
            name IS the provider. The raw id appears only when the label does
            not already spell it (meaningfulModelId). */}
        {detail ? (
          <span className="block truncate font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">
            {detail}
          </span>
        ) : null}
      </span>
      {row.note ? (
        <span className="shrink-0 whitespace-nowrap text-micro text-[color:var(--text-muted)]">{row.note}</span>
      ) : null}
      {chord ? (
        <kbd className="shrink-0 rounded-[3px] bg-[color:var(--bg-active)] px-1 font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">
          {chordModifier}
          {chord}
        </kbd>
      ) : null}
      <button
        type="button"
        data-model-star="true"
        aria-pressed={starred}
        aria-label={`${starred ? 'Unstar' : 'Star'} ${row.name}`}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation()
          onToggleStar()
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          // The way back to the field. Escape is deliberately NOT bound here:
          // Escape closes the surface from anywhere inside it, and a key that
          // means two things depending on where focus sits is worse than a
          // second one that always means the same thing.
          if (event.key !== 'ArrowLeft') return
          event.preventDefault()
          onLeaveStar()
        }}
        className={[
          'interactive grid size-5 shrink-0 place-items-center rounded-[3px]',
          'text-[color:var(--text-disabled)] hover:text-[color:var(--text-default)]',
          // Revealed on hover, on the keyboard HIGHLIGHT, and on its own focus —
          // hover-only is a bug. The highlight earns a reveal because ArrowRight
          // from the field is the star's only keyboard path, and an affordance
          // that appears solely under a pointer cannot advertise it. A starred
          // row keeps its mark at rest, which is the whole point of it.
          //
          // The highlight is branched in JS rather than written as a
          // `group-data-[active=true]/row:` variant: that variant appears
          // nowhere else in the app, and tokens.ts documents at length what a
          // variant Tailwind never emits costs — an affordance that silently
          // renders inert. `opacity-100` is a utility the stylesheet certainly
          // has.
          starred
            ? 'text-[color:var(--text-muted)]'
            : active
              ? 'opacity-100'
              : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        <StarGlyph filled={starred} stroked={!starred} className="size-icon-xs" />
      </button>
    </div>
  )
}

// The chord the rows advertise. Cmd on macOS, Ctrl elsewhere — the handler
// accepts either, so a mislabelled platform is cosmetic, not a dead shortcut.
// Read per render, never once at module load: preload publishes `window.api`
// after this module is first evaluated, so a module constant freezes on the
// wrong platform for the life of the session.
function quickSelectModifier(): string {
  return typeof window !== 'undefined' && window.api?.platform === 'darwin' ? '⌘' : 'Ctrl+'
}

function SearchGlyph(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-[color:var(--text-muted)]"
    >
      <circle cx="4.5" cy="4.5" r="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M7 7l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// The two controls as a host embeds them: the model trigger (provider glyph +
// model name) and, when the runtime has a second axis to offer, the reasoning
// selector beside it. One inline-flex wrapper, so a host lays this out as the
// single control it replaced.
export function CliModelPickerButton({
  ariaLabel,
  options,
  cli,
  effectiveModelFor,
  effectiveReasoningFor,
  onSelectReasoning,
  disabled,
  quiet,
  maxWidthClassName = 'max-w-[220px]',
  onSelectCli,
  onSelectModel,
}: {
  ariaLabel: string
  /**
   * The runtimes to offer: the app's catalog rows, or a module's
   * `host.listChatRuntimes()` result passed straight through — the two shapes
   * may even be mixed. Chat runtimes this machine lacks are left out unless
   * one is the current `cli` (`normalizeCliRuntimeOptions`).
   */
  options: ReadonlyArray<CliRuntimePickerOption>
  cli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  /**
   * Opt-in reasoning-effort support (manifest reasoningSelection). When both
   * accessors are provided, the reasoning selector offers the CLI's levels.
   * Hosts without effort persistence omit them and the selector carries the
   * context-window axis alone — or nothing, when the model has no windows.
   */
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  disabled?: boolean
  /**
   * Opt-in low-emphasis trigger for in-place property editing: renders as
   * plain muted text until hover or focus reveal the control chrome.
   */
  quiet?: boolean
  /** Trigger width clamp override for hosts where the model name must never truncate. */
  maxWidthClassName?: string
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}): JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const resolvedOptions = React.useMemo(() => {
    const normalized = normalizeCliRuntimeOptions(options, cli)
    return normalized.some((option) => option.value === cli) ? normalized : [{ value: cli, label: cli }, ...normalized]
  }, [options, cli])
  const selected = resolvedOptions.find((option) => option.value === cli) ?? resolvedOptions[0]
  if (!selected) return null

  const model = effectiveModelFor(cli)
  const families = buildModelFamilies(selected.modelSelection?.options)
  const family = familyForModel(families, model)
  // The trigger names the model, not the runtime that carries it: the glyph
  // already says which provider this is, so repeating "Claude Code · " spends
  // the row's width on a fact the icon states. Hosted runtimes name their own
  // model, so their CLI label is the model name. A model the catalog dropped
  // still reads as its raw id rather than vanishing.
  const modelLabel = family?.label ?? model ?? selected.label
  const reasoning = effectiveReasoningFor?.(cli)
  const reasoningWired = Boolean(onSelectReasoning && effectiveReasoningFor)
  const axisLabel = reasoningTriggerLabel({
    reasoningSelection: selected.reasoningSelection,
    family,
    reasoningEnabled: reasoningWired,
    reasoning,
    model,
  })
  // The accessible name carries the whole runtime the visible trigger trims to
  // its model: provider, model, and the axes the selector beside it holds.
  const runtime = model
    ? `${selected.label} · ${modelLabel}`
    : selected.hostedVia === 'claude-code'
      ? `${selected.label} · Claude Code`
      : selected.label
  const runtimeLabel = [runtime, axisLabel].filter(Boolean).join(' · ')

  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-0.5">
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel={ariaLabel}
        popupRole="dialog"
        placement="bottom-start"
        className="min-w-0 shrink-0"
        surfaceClassName="overflow-hidden"
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <Tooltip content={`Agent runtime: ${runtimeLabel}`} wrapperClassName="inline-flex min-w-0">
            <button
              ref={ref}
              type="button"
              aria-label={`${ariaLabel}: ${runtimeLabel}`}
              disabled={disabled}
              onClick={togglePopover}
              className={[
                'interactive group/pill inline-flex items-center gap-2 rounded-sm text-left',
                maxWidthClassName,
                quiet
                  ? 'h-6 border border-transparent px-1.5 text-micro text-[color:var(--text-muted)] hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-surface)] hover:text-[color:var(--text-default)]'
                  : 'h-control-xs border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 text-meta text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                'disabled:cursor-not-allowed disabled:opacity-45',
                FOCUS_RING_CLASS,
              ].join(' ')}
              {...triggerProps}
            >
              <CliIcon cli={selected.value} className="size-icon-sm shrink-0 text-[color:var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate">{modelLabel}</span>
              <ChevronGlyph
                className={`shrink-0 text-[color:var(--text-disabled)] ${
                  quiet
                    ? 'opacity-0 transition-opacity group-hover/pill:opacity-100 group-focus-visible/pill:opacity-100'
                    : ''
                }`}
              />
            </button>
          </Tooltip>
        )}
      >
        <CliModelPopoverSurface
          ariaLabel={`${ariaLabel} options`}
          options={resolvedOptions}
          currentCli={cli}
          effectiveModelFor={effectiveModelFor}
          effectiveReasoningFor={effectiveReasoningFor}
          onSelectReasoning={onSelectReasoning}
          showReasoning
          reasoningAriaLabel={`Reasoning for ${ariaLabel}`}
          onSelectCli={(nextCli) => {
            onSelectCli(nextCli)
            setOpen(false)
          }}
          onSelectModel={(nextCli, nextModel) => {
            onSelectModel(nextCli, nextModel)
            setOpen(false)
          }}
        />
      </Popover>
    </span>
  )
}

function ChevronGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={`size-icon-xs ${className ?? ''}`}>
      <path
        d="M4.5 6.5L8 10l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
