// ConnectorRow — the one list row the whole Connectors surface renders: Browse
// (catalog + registry via ConnectorEntryRow) and the Installed view (via the
// generic ConnectorRow) share it so the surface reads as one system. Icon chip ·
// name + kind chip · one-line summary (or status line) · right-aligned
// actions. Transport and other plumbing stay off the row face — they belong to
// the detail panels. There is one row, not a "compact" cousin: the Installed
// view once had its own single-line idiom and read as a different product from
// the grid beside it.

import React from 'react'

import { Badge, GhostButton, PrimaryButton, RowButton, TruncatedText, type MarkBadge } from '../../ui'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import { PluginIcon, resolveIconUrl } from '../../settings/BrowseStorefront'
import type { ConnectorEntry } from './connectorsFacets'

// The one section-heading treatment for the whole Connectors surface: muted
// label · count. It used to carry a hairline out to the right edge, which was
// the group's separator while the rows under it sat loose; the rows now sit in
// a list card (ruled 2026-09-15), and a rule directly above a card's border is
// two rules for one boundary. The card is the edge; the heading only names it.
export function ConnectorSectionHeading({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-body font-medium text-[color:var(--text-muted)]">{label}</span>
      {typeof count === 'number' ? (
        <span className="tabular-nums font-mono text-meta text-[color:var(--text-subtle)]">{count}</span>
      ) : null}
    </div>
  )
}

// Small neutral text chip ("MCP server", "Skill pack", "Bundled", "http", …):
// the kit's label badge, decorative because the row's name and summary already
// say what it is.
function ConnectorChip({ label }: { label: string }) {
  return (
    <Badge decorative className="shrink-0">
      {label}
    </Badge>
  )
}

// The mark and, when the row has news, the count docked on its corner. Same
// pip as the agent CLI rows and the app rail's squares (owner, 2026-09-10):
// what a person scanning a page of extensions needs is WHICH of them wants
// them, and a chip in the middle of the name line is not something the eye
// finds from across the page. The chip stays — it is the words — and this is
// the mark that gets you to them.
function ConnectorMark({ icon, badge }: { icon: React.ReactNode; badge?: MarkBadge | null }) {
  if (!badge || badge.count <= 0) return <>{icon}</>
  return (
    <span className="relative inline-flex shrink-0">
      {icon}
      <Badge
        corner
        tone={badge.tone ?? 'accent'}
        count={badge.count}
        max={99}
        ariaLabel={badge.label}
        // The ground these lists sit on, not the app ground the primitive
        // assumes.
        className="border-[color:var(--bg-surface)]"
      />
    </span>
  )
}

/**
 * Set by a surface that lays its rows out as a gallery — the Extensions
 * catalogue (owner ruling 2026-11-03): the mark, the name, its chips and the
 * action, and no summary or status line under them. A catalogue of hundreds
 * is scanned for a name the person already knows, and a sentence under every
 * one of them was a page of text to read past; the detail a row opens still
 * carries all of it. The chips stay: a state such as "Could not be read" is
 * one, and a row that hid it would look installable.
 */
export const ConnectorRowGalleryContext = React.createContext(false)

export function ConnectorRow({
  icon,
  badge,
  name,
  meta,
  summary,
  summaryLines = 1,
  chips = [],
  status,
  actions,
  selected = false,
  onOpen,
  surface = 'page',
}: {
  icon: React.ReactNode
  /** News waiting on this row, as the kit's corner count on the mark. Null, or
   *  a count of 0, draws nothing. */
  badge?: MarkBadge | null
  name: string
  /**
   * The qualifier that tells two rows of the same name apart — the plugin a
   * skill belongs to, a version — in the mono, low-contrast slot the agent
   * CLI rows keep beside their name. A row called "access" three times over
   * is three rows nobody can choose between; "access · discord" is one.
   */
  meta?: string
  summary?: string
  /**
   * How many lines the summary may take before it clips. One keeps a
   * catalogue of hundreds in rhythm; a short list of rows in a narrow column
   * (the Modules tab) takes two, so the summary says something rather than
   * the first few words of it.
   */
  summaryLines?: 1 | 2
  chips?: string[]
  // Optional status line (Installed rows): a StatusDot + plain-language label,
  // rendered under the summary.
  status?: React.ReactNode
  actions?: React.ReactNode
  selected?: boolean
  // When present the name/summary area is a button that opens the detail panel.
  onOpen?: () => void
  /**
   * Where the row sits. `page` (default) is a row loose in a gap grid: its own
   * radius under the fill, a tight inset. `card` is a row inside the list card
   * (`SettingCard as="ul"`, ruled 2026-09-15): no radius because the card
   * clips, the card's 16px inset, and the fill reaching the card's edge — the
   * same numbers the Remote tab's machine rows draw, so a plugin, a skill and
   * a paired device read as rows of one product.
   */
  surface?: 'page' | 'card'
}) {
  const gallery = React.useContext(ConnectorRowGalleryContext)
  const inCard = surface === 'card' && !gallery
  const shownSummary = gallery ? undefined : summary
  const shownStatus = gallery ? undefined : status
  // list-row, not a card of its own: no border box — the standard fills carry
  // hover (--bg-hover) and selection (--bg-selected). Loose, the grid's gaps
  // separate rows; in a card, the card's hairlines do.
  const rowClass = selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'
  // The content branches keep the kit's `flush` inset (8/6px). The card form
  // adds the remainder on the wrapper — 8px more at the left, 6px more above
  // and below — so the row lands on the machine row's 16/12px without
  // restating a padding the kit already owns (two `p*-` utilities on one
  // element are resolved by stylesheet order, not by the order they are
  // written). The wrapper is what carries the fill, so the fill still runs
  // edge to edge.
  const wrapperClass = inCard ? 'pl-2 py-1.5 pr-4' : gallery ? 'rounded-md py-1 pr-2' : 'rounded-md pr-2.5'
  const content = (
    <>
      <ConnectorMark icon={icon} badge={badge} />
      <span className="min-w-0 flex-1">
        {/* overflow-hidden, because the chips are shrink-0: once the name has
            truncated away, a chip row wider than the column would otherwise
            paint on under the right-aligned actions (seen in the condensed
            Plugins modal). Clipping is the row's contract — the detail panel
            carries the full component list. */}
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <TruncatedText
            as="span"
            text={name}
            className="min-w-0 text-body font-semibold leading-5 text-[color:var(--text-strong)]"
          />
          {meta ? (
            <TruncatedText
              as="span"
              text={meta}
              className="min-w-0 shrink font-mono text-meta text-[color:var(--text-subtle)]"
            />
          ) : null}
          {chips.map((label) => (
            <ConnectorChip key={label} label={label} />
          ))}
        </span>
        {shownSummary ? (
          <TruncatedText
            as="span"
            text={shownSummary}
            multiline={summaryLines === 2}
            className={`mt-0.5 block text-body leading-4 text-[color:var(--text-subtle)]${summaryLines === 2 ? ' line-clamp-2' : ''}`}
          />
        ) : null}
        {shownStatus ? (
          // Clipped, not wrapped — the same contract the name row keeps above.
          // A state line long enough to wrap ("Active · No longer in source")
          // would grow this row taller than its neighbours and step the whole
          // list out of rhythm; the detail surfaces carry the full sentence.
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-meta leading-4 text-[color:var(--text-subtle)]">
            {shownStatus}
          </span>
        ) : null}
      </span>
    </>
  )
  return (
    // The row's own inset moved onto the two content branches, because the
    // interactive one is now `RowButton density="flush"` and the kit owns a row's
    // padding. The non-interactive twin repeats it verbatim so the two branches
    // stay the same shape; this element keeps the ground, the radius and the
    // right-hand inset the trailing actions sit in.
    <div className={`group relative flex items-center gap-2 transition-colors ${wrapperClass} ${rowClass}`}>
      {onOpen ? (
        <RowButton
          density="flush"
          onClick={onOpen}
          aria-expanded={selected}
          aria-label={`Show details for ${name}`}
          className="min-w-0 flex-1"
        >
          {content}
        </RowButton>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">{content}</div>
      )}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

// The Browse mapping: one ConnectorEntry (either source) → a ConnectorRow with
// the source's icon and affordances. Catalog entries add/launch in place;
// registry entries route through the detail panel's install flow via Get.
export function ConnectorEntryRow({
  entry,
  registryUrl,
  selected,
  onOpen,
  onToggleInstalled,
  onLaunch,
  surface,
}: {
  entry: ConnectorEntry
  registryUrl: string | null
  selected: boolean
  onOpen: () => void
  // Installed entries only — removes the server from the active set.
  onToggleInstalled?: () => void
  // Launchable connectors only.
  onLaunch?: () => void
  surface?: 'page' | 'card'
}) {
  const icon = entry.plugin ? (
    <PluginIcon iconUrl={resolveIconUrl(registryUrl, entry.plugin.icon)} name={entry.name} size={36} />
  ) : (
    <ExtensionIcon slug={mcpIconSlug(entry.id)} name={entry.name} size={36} />
  )
  return (
    <ConnectorRow
      icon={icon}
      name={entry.name}
      summary={entry.summary}
      chips={entry.componentLabels}
      selected={selected}
      onOpen={onOpen}
      surface={surface}
      actions={
        <>
          {entry.source === 'registry' ? (
            <GhostButton size="sm" onClick={onOpen} className="border border-[color:var(--border-default)]">
              Get
            </GhostButton>
          ) : entry.installed ? (
            <span className="flex items-center gap-1 pr-1 text-meta font-medium text-[color:var(--accent-primary)]">
              <svg
                viewBox="0 0 10 10"
                className="h-2.5 w-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="1.5,5 4,7.5 8.5,2.5" />
              </svg>
              Added
            </span>
          ) : onToggleInstalled ? (
            <GhostButton
              size="sm"
              onClick={onToggleInstalled}
              className="border border-[color:var(--border-default)]"
              aria-label={`Add ${entry.name}`}
            >
              Add
            </GhostButton>
          ) : null}
          {onLaunch ? (
            <PrimaryButton size="sm" onClick={onLaunch}>
              New chat
            </PrimaryButton>
          ) : null}
        </>
      }
    />
  )
}
