import React, { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'

import type {
  ConversationContextBreakdown,
  ConversationContextBreakdownResult,
  ConversationContextItem,
  ConversationContextMcpServer,
} from '../../../../../shared/conversation-runtime'
import { formatTokenCount } from '../../../utils/tokenFormat'
import { formatTimeOfDay } from '../../../utils/clockFormat'
import {
  CONTEXT_RING_WARN_PERCENTAGE,
  ContextRing,
  contextRingLabel,
  contextRingTokensLabel,
  GhostButton,
  IconButton,
  Popover,
  RefreshIcon,
  Tooltip,
} from '../../ui'
import { Meter } from '../../ui/Meter'
import { ChevronRightGlyph } from './toolRows/ToolKindGlyph'
import {
  contextSegments,
  contextShareLabel,
  deferredRows,
  groupTokens,
  heaviestLoaded,
  memoryFileLabel,
  type ContextHeaviest,
  type ContextSegment,
} from './contextBreakdownShape'

// What fills the context window, opened from the composer strip's ring. The
// ring says how full; this says with what — the system prompt, the tools, the
// MCP servers and skills a person chose to load, the memory files, the
// conversation itself — and which one item weighs most, because that is the
// one a person can do something about.
//
// The rows are the agent's own reading (Claude Code's `/context`), asked for
// when the panel opens and again when a turn ends while it is open, never on
// a timer: nothing moves the window between turns. An agent that gives no
// reading — Codex reports a total and nothing under it — gets the total
// alone, said as such, rather than a breakdown guessed for it.

export type ContextBreakdownSource = {
  /** Ask the chat's agent; null where it gives no breakdown, and the panel then shows the total alone. */
  load: (() => Promise<ConversationContextBreakdownResult>) | null
  /** The agent's name, for the total-only note. */
  agentName: string
  /** Why there is no breakdown, where it is not the agent's doing (a window that cannot ask); said instead of the agent's. */
  unavailable?: string
  /** What the last reading is kept under between opens: the chat's session. */
  cacheKey: string | null
  /** Changes as a turn ends; an open panel reads again then. */
  refreshKey: string | number
}

// The last reading of each chat, so the panel opens on it rather than on
// nothing while the new one comes. In memory only: a reading is about a
// child process, and a restarted app has none.
const lastReadings = new Map<string, ConversationContextBreakdownResult>()
const LAST_READINGS_KEPT = 24

function remember(key: string, result: ConversationContextBreakdownResult): void {
  lastReadings.delete(key)
  lastReadings.set(key, result)
  while (lastReadings.size > LAST_READINGS_KEPT) lastReadings.delete(lastReadings.keys().next().value!)
}

/** Forget every kept reading; for tests. */
export function resetContextBreakdownCache(): void {
  lastReadings.clear()
}

type Reading = { result: ConversationContextBreakdownResult | null; loading: boolean }

/** Reads the breakdown while `open`: on opening, and again each time `refreshKey` moves. */
export function useContextBreakdown(
  source: ContextBreakdownSource | null,
  open: boolean,
): Reading & { refresh: () => void } {
  const key = source?.cacheKey ?? null
  // Tagged with the chat it is of, so a reading never outlives a change of
  // chat under the panel, nor is kept as the next one's.
  const [reading, setReading] = useState<Reading & { of: string | null }>(() => ({
    result: key ? (lastReadings.get(key) ?? null) : null,
    loading: false,
    of: key,
  }))
  const loadRef = useRef(source?.load ?? null)
  loadRef.current = source?.load ?? null
  // Each read is numbered, so an answer that arrives after a newer read was
  // started, or after the chat changed under the panel, is dropped.
  const generation = useRef(0)
  const refresh = useCallback(() => {
    const load = loadRef.current
    if (!load) return
    const mine = ++generation.current
    setReading((current) => ({ ...current, loading: true }))
    load()
      .catch((error: unknown): ConversationContextBreakdownResult => ({
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : 'The breakdown could not be read.',
      }))
      .then((result) => {
        if (generation.current !== mine) return
        // A failed read keeps a breakdown already drawn, marked old, rather
        // than trading it for an error about a moment.
        setReading((current) => ({
          result: !result.ok && current.result?.ok ? { ...current.result, stale: true as const } : result,
          loading: false,
          of: current.of,
        }))
      })
  }, [])
  useEffect(() => {
    generation.current += 1
    setReading((current) =>
      current.of === key ? current : { result: key ? (lastReadings.get(key) ?? null) : null, loading: false, of: key },
    )
  }, [key])
  const { result: kept, of } = reading
  useEffect(() => {
    if (of && kept) remember(of, kept)
  }, [of, kept])
  const hasLoad = source?.load != null
  const refreshKey = source?.refreshKey
  useEffect(() => {
    if (open && hasLoad) refresh()
  }, [open, hasLoad, refreshKey, refresh])
  const current = reading.of === key ? reading : { result: null, loading: false }
  return { result: current.result, loading: current.loading, refresh }
}

// Static class names, one per slot: Tailwind emits a rule only for a
// candidate it can read as text.
const SLOT_FILL: Record<number | 'other', string> = {
  1: 'bg-[color:var(--chart-1)]',
  2: 'bg-[color:var(--chart-2)]',
  3: 'bg-[color:var(--chart-3)]',
  4: 'bg-[color:var(--chart-4)]',
  5: 'bg-[color:var(--chart-5)]',
  6: 'bg-[color:var(--chart-6)]',
  7: 'bg-[color:var(--chart-7)]',
  8: 'bg-[color:var(--chart-8)]',
  other: 'bg-[color:var(--chart-other)]',
}

// Free space is the track the bar is drawn on, as a meter's is; the buffer
// is held back rather than filled, so it takes the track's own edge colour,
// a neutral one step darker — not a series colour, because it is not content.
function segmentFill(segment: ContextSegment): string {
  if (segment.kind === 'free') return 'bg-[color:var(--bg-active)] shadow-[inset_0_0_0_1px_var(--border-default)]'
  if (segment.kind === 'buffer') return 'bg-[color:var(--border-strong)]'
  return SLOT_FILL[segment.slot ?? 'other']
}

function Swatch({ segment }: { segment: ContextSegment }): JSX.Element {
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-xs ${segmentFill(segment)}`} />
}

function ContextBar({
  segments,
  label,
  total,
}: {
  segments: ContextSegment[]
  label: string
  total: number
}): JSX.Element {
  return (
    // The whole bar is one picture with one name; the rows under it are its
    // table, and say every number the segments draw.
    // A grid rather than a flex row because each segment's tooltip wraps it
    // in a span of its own, and that span is what has to take the share. A
    // row too small to see keeps a sliver, so the swatch beside its name
    // always has a mark in the bar to match.
    <div
      role="img"
      aria-label={label}
      style={{ gridTemplateColumns: segments.map((segment) => `minmax(2px, ${segment.share}fr)`).join(' ') }}
      className="grid h-2.5 w-full gap-0.5 overflow-hidden rounded-xs"
    >
      {segments.map((segment, index) => (
        <Tooltip
          key={`${segment.name}-${index}`}
          content={`${segment.name} · ${formatTokenCount(segment.tokens)} · ${contextShareLabel(segment.tokens, total)}`}
          placement="top"
          openDelayMs={0}
          wrapperClassName="flex min-w-0"
          wrapperRole="presentation"
        >
          <span
            aria-hidden="true"
            data-context-segment={segment.kind}
            className={`block h-full w-full ${segmentFill(segment)}`}
          />
        </Tooltip>
      ))}
    </div>
  )
}

const HEAVIEST_WORDS: Record<ContextHeaviest['group'], string> = {
  mcp: 'MCP server',
  skill: 'skill',
  memory: 'memory file',
  agent: 'custom agent',
}

function heaviestLabel(heaviest: ContextHeaviest): string {
  return heaviest.group === 'memory' ? memoryFileLabel(heaviest.name) : heaviest.name
}

function Disclosure({
  title,
  count,
  tokens,
  windowTokens,
  children,
  defaultOpen = false,
  dataGroup,
}: {
  title: string
  count?: number
  tokens: number
  windowTokens: number
  children: React.ReactNode
  defaultOpen?: boolean
  dataGroup: string
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  return (
    <section data-context-group={dataGroup} className="flex flex-col">
      <GhostButton
        size="xs"
        tone="subtle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((was) => !was)}
        className="w-full justify-start gap-2"
      >
        <ChevronRightGlyph className={`icon-xs shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 truncate text-[color:var(--text-default)]">{title}</span>
        {count !== undefined ? <span className="tabular-nums text-[color:var(--text-subtle)]">{count}</span> : null}
        <span className="ml-auto shrink-0 tabular-nums text-[color:var(--text-subtle)]">
          {formatTokenCount(tokens)} · {contextShareLabel(tokens, windowTokens)}
        </span>
      </GhostButton>
      {open ? (
        <ul id={bodyId} className="flex flex-col">
          {children}
        </ul>
      ) : null}
    </section>
  )
}

function ItemRow({
  name,
  detail,
  tokens,
  windowTokens,
  outside = false,
  nested = false,
  title,
}: {
  name: string
  detail?: string
  tokens: number
  windowTokens: number
  /** Listed but not in the window (a tool loaded only when used): its size, and no share. */
  outside?: boolean
  /** A server's tool, one level further in. */
  nested?: boolean
  title?: string
}): JSX.Element {
  return (
    // design-tokens-allow: structure, not rhythm — the indent puts an item's name under its group's title: the button's 8px inset, the 12px chevron and the 8px gap make 28px (`pl-7`), and a server's tools sit one more chevron in, under the server's name, at 48px (`pl-12`).
    <li className={`flex min-h-6 items-center gap-2 pr-2 text-meta ${nested ? 'pl-12' : 'pl-7'}`} title={title}>
      <span
        className={`min-w-0 truncate ${outside ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-default)]'}`}
      >
        {name}
      </span>
      {detail ? (
        <span className="min-w-0 shrink truncate text-micro text-[color:var(--text-subtle)]">{detail}</span>
      ) : null}
      <span className="ml-auto shrink-0 tabular-nums text-[color:var(--text-subtle)]">
        {formatTokenCount(tokens)} · {outside ? 'not loaded' : contextShareLabel(tokens, windowTokens)}
      </span>
    </li>
  )
}

function McpServerRow({
  server,
  windowTokens,
}: {
  server: ConversationContextMcpServer
  windowTokens: number
}): JSX.Element {
  const loaded = server.tools.filter((tool) => tool.loaded)
  const deferred = server.tools.length - loaded.length
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // Which of its tools are in the window: a deferred one is listed but not
  // loaded until the agent reaches for it.
  const toolWords =
    deferred > 0
      ? `${loaded.length} of ${server.tools.length} loaded`
      : `${loaded.length} ${loaded.length === 1 ? 'tool' : 'tools'}`
  return (
    <li className="flex flex-col pl-5" data-context-mcp-server={server.name}>
      <GhostButton
        size="xs"
        tone="subtle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((was) => !was)}
        className="w-full justify-start gap-2"
      >
        <ChevronRightGlyph className={`icon-xs shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 max-w-40 shrink-0 truncate text-[color:var(--text-default)]">{server.name}</span>
        <span className="min-w-0 shrink truncate text-micro text-[color:var(--text-subtle)]">{toolWords}</span>
        <span className="ml-auto shrink-0 tabular-nums text-[color:var(--text-subtle)]">
          {formatTokenCount(server.tokens)} · {contextShareLabel(server.tokens, windowTokens)}
        </span>
      </GhostButton>
      {open ? (
        <ul id={bodyId} className="-ml-5 flex flex-col">
          {server.tools.map((tool) => (
            <ItemRow
              key={tool.name}
              name={tool.name}
              tokens={tool.tokens}
              windowTokens={windowTokens}
              outside={!tool.loaded}
              nested
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function ItemGroup({
  title,
  dataGroup,
  items,
  windowTokens,
  label = (item) => item.name,
}: {
  title: string
  dataGroup: string
  items: ConversationContextItem[]
  windowTokens: number
  label?: (item: ConversationContextItem) => string
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <Disclosure
      title={title}
      count={items.length}
      tokens={groupTokens(items)}
      windowTokens={windowTokens}
      dataGroup={dataGroup}
    >
      {items.map((item) => (
        <ItemRow
          key={item.name}
          name={label(item)}
          {...(item.detail ? { detail: item.detail } : {})}
          tokens={item.tokens}
          windowTokens={windowTokens}
          title={item.name}
        />
      ))}
    </Disclosure>
  )
}

/** The breakdown itself: the bar, its rows, the heaviest item, and each group. */
export function ContextBreakdownView({ breakdown }: { breakdown: ConversationContextBreakdown }): JSX.Element {
  const segments = contextSegments(breakdown)
  const deferred = deferredRows(breakdown)
  const heaviest = heaviestLoaded(breakdown)
  const window = breakdown.windowTokens
  const barLabel = segments.map((segment) => `${segment.name} ${contextShareLabel(segment.tokens, window)}`).join(', ')
  const mcpTokens = breakdown.mcpServers.reduce((sum, server) => sum + server.tokens, 0)
  return (
    <div className="flex flex-col gap-3">
      <ContextBar segments={segments} label={`What fills the window: ${barLabel}`} total={window} />
      <ul className="flex flex-col gap-0.5" aria-label="By category">
        {segments.map((segment, index) => (
          <li
            key={`${segment.name}-${index}`}
            className="flex items-center gap-2 px-2 text-meta"
            data-context-category={segment.kind}
          >
            <Swatch segment={segment} />
            <span className="min-w-0 truncate text-[color:var(--text-default)]">{segment.name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[color:var(--text-subtle)]">
              {formatTokenCount(segment.tokens)} · {contextShareLabel(segment.tokens, window)}
            </span>
          </li>
        ))}
        {deferred.map((row) => (
          <li key={row.name} className="flex items-center gap-2 px-2 text-meta" data-context-category="deferred">
            <span aria-hidden="true" className="size-2 shrink-0" />
            <span className="min-w-0 truncate text-[color:var(--text-subtle)]">{row.name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-[color:var(--text-subtle)]">
              {formatTokenCount(row.tokens)} · not in the window
            </span>
          </li>
        ))}
      </ul>
      {heaviest ? (
        <p className="px-2 text-meta text-[color:var(--text-default)]" data-context-heaviest={heaviest.group}>
          <span className="text-[color:var(--text-subtle)]">Heaviest you loaded: </span>
          the <span className="font-medium text-[color:var(--text-strong)]">{heaviestLabel(heaviest)}</span>
          {` ${HEAVIEST_WORDS[heaviest.group]}, ${formatTokenCount(heaviest.tokens)} tokens (${contextShareLabel(heaviest.tokens, window)} of the window)`}
        </p>
      ) : null}
      <div className="flex flex-col">
        {breakdown.mcpServers.length > 0 ? (
          <Disclosure
            title="MCP servers"
            count={breakdown.mcpServers.length}
            tokens={mcpTokens}
            windowTokens={window}
            dataGroup="mcp"
          >
            {breakdown.mcpServers.map((server) => (
              <McpServerRow key={server.name} server={server} windowTokens={window} />
            ))}
          </Disclosure>
        ) : null}
        <ItemGroup title="Skills" dataGroup="skills" items={breakdown.skills} windowTokens={window} />
        <ItemGroup
          title="Memory files"
          dataGroup="memory"
          items={breakdown.memoryFiles}
          windowTokens={window}
          label={(item) => memoryFileLabel(item.name)}
        />
        <ItemGroup title="Custom agents" dataGroup="agents" items={breakdown.agents} windowTokens={window} />
      </div>
    </div>
  )
}

/** "Claude Code's estimate · 3:12 PM", and that it is the last reading where the agent is not running now. */
export function contextReadingNote(breakdown: ConversationContextBreakdown, stale: boolean, agentName: string): string {
  const source = breakdown.estimated ? `${agentName}’s estimate` : `Counted by ${agentName}`
  const at = formatTimeOfDay(new Date(breakdown.measuredAt))
  return stale ? `${source} · last read at ${at}` : `${source} · ${at}`
}

/** The panel the ring opens: the window's totals, and the breakdown where the agent gives one. */
export function ContextBreakdownPanel({
  context,
  source,
  reading,
  onRefresh,
}: {
  context: { used: number; total: number }
  source: ContextBreakdownSource | null
  reading: Reading
  onRefresh: () => void
}): JSX.Element {
  const headingId = useId()
  const result = reading.result
  const breakdown = result?.ok ? result.breakdown : null
  // The breakdown's own totals where it has them, so the header and the bar
  // under it add up; the ring's turn reading otherwise.
  const used = breakdown?.usedTokens ?? context.used
  const total = breakdown?.windowTokens ?? context.total
  const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const agentName = source?.agentName ?? 'This agent'
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-context-breakdown="">
      <div className="flex items-center gap-3">
        <h3 id={headingId} className="text-meta font-medium text-[color:var(--text-strong)]">
          Context window
        </h3>
        <span className="ml-auto shrink-0 tabular-nums text-meta text-[color:var(--text-subtle)]">
          {percent}% · {formatTokenCount(used)} of {formatTokenCount(total)}
        </span>
        {/* Always here while there is an agent to ask, busy while it
            answers: the one control the dialog is sure to hold, so focus
            has somewhere to land as it opens. */}
        {source?.load ? (
          <Tooltip content="Read again" placement="top">
            <IconButton size="xs" tone="subtle" aria-label="Read again" busy={reading.loading} onClick={onRefresh}>
              <RefreshIcon className="icon-xs" />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
      {breakdown ? (
        <ContextBreakdownView breakdown={breakdown} />
      ) : (
        <>
          <Meter
            value={percent}
            warn={percent >= CONTEXT_RING_WARN_PERCENTAGE}
            ariaLabelledBy={headingId}
            ariaValueText={`${percent}% used`}
          />
          <p className="text-meta text-[color:var(--text-subtle)]" data-context-breakdown-note="">
            {!source?.load
              ? (source?.unavailable ?? `${agentName} reports how full the window is, not what fills it.`)
              : reading.loading && !result
                ? 'Reading what fills the window…'
                : result && !result.ok
                  ? result.message
                  : null}
          </p>
        </>
      )}
      {breakdown ? (
        <p className="px-2 text-micro text-[color:var(--text-subtle)]" data-context-reading-note="">
          {contextReadingNote(breakdown, result?.ok === true && result.stale === true, agentName)}
        </p>
      ) : null}
    </section>
  )
}

// A dialog owes its content the keyboard: focus moves in as it opens, to its
// first control, and Escape gives it back to the ring. A frame later, because
// the surface stays hidden until it has been measured, and a hidden element
// cannot take focus. A dialog with nothing to operate (the total alone)
// leaves focus on the ring, which still names everything it says.
function focusIntoDialog(surface: HTMLElement): void {
  requestAnimationFrame(() => {
    if (surface.isConnected) surface.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  })
}

/**
 * The strip's ring as a button: the tooltip says the counts, as the bare
 * ring's does, and a click or Enter opens what fills the window.
 */
export function ContextStripButton({
  percentage,
  context,
  source,
}: {
  percentage: number
  context: { used: number; total: number }
  source: ContextBreakdownSource | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const reading = useContextBreakdown(source, open)
  const label = contextRingLabel(percentage, context)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Context window"
      popupRole="dialog"
      placement="top-end"
      surfaceClassName="w-[360px] max-h-[min(560px,70vh)] overflow-y-auto p-3"
      onOpenAutoFocus={focusIntoDialog}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The tooltip says the counts, as the bare ring's does: the sweep
        // already shows the share.
        <Tooltip content={contextRingTokensLabel(context.used, context.total)} placement="top" wrapperClassName="flex">
          <IconButton
            ref={ref}
            size="xs"
            tone="subtle"
            onClick={togglePopover}
            {...triggerProps}
            aria-label={`${label} — show what fills it`}
            data-strip-context-button=""
          >
            <ContextRing usedPercentage={percentage} decorative />
          </IconButton>
        </Tooltip>
      )}
    >
      <ContextBreakdownPanel context={context} source={source} reading={reading} onRefresh={reading.refresh} />
    </Popover>
  )
}
