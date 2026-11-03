// The one shape the Extensions catalogues share.
//
// Source-tabs ruling (2026-09-05): Plugins and Skills are the same page twice
// — the view's name and a search field on the chrome row, Installed and then
// one tab per source under it with a plus at the end, and
// inside the open tab the connector row idiom in two columns, kept in its
// groups, walked by one pager. The nested Sources rail is gone: the drawer and
// this row are the whole navigation, so the door brings no rail and the
// sidebar column keeps the five drawer rows the person arrived by.
//
// List-card ruling (2026-09-15): each group's rows sit in the settings list
// card — one bordered surface per group, the rows full-bleed inside it, two
// abreast — the same card the Remote tab's machines and the Settings lists
// sit in. The rows were a gap grid before, and a page of them read as a
// different product from the Settings page one door over.
//
// Gallery ruling (owner, 2026-11-03). The catalogue opens as a modal over the
// page, and its frame is a gallery rather than a page of tabs and cards:
//
//   - the title bar holds the dialog's name and the Plugins / Skills switch;
//   - one search field across the dialog, and under it Installed and the
//     sources as pills on one line — the strip of tabs that had to be
//     scrolled sideways to find a source is gone, and the pills that do not
//     fit fold into More. Installed wears the marks of what it holds;
//   - inside a source, each group shows its first few rows and a View all
//     that opens the whole group as a page of its own, with a back chevron;
//   - a row is the mark, the name and the action — no summary on its face
//     (`ConnectorRowGalleryContext`), and no card around the group: the
//     space between groups is what separates them;
//   - a query turns the body into one list of results, grouped, in a single
//     panel under the field.
//
// This file owns that frame. What goes IN a tab is each catalogue's own
// business — a registry category, a repository's folders — and
// arrives as sections of items plus a way to draw one and a way to key it.

import React, { useContext, useMemo, useState, type JSX } from 'react'

import {
  ChipButton,
  IconButton,
  InboxSearchInput,
  LinkButton,
  OverflowMenu,
  Pager,
  SegmentedControl,
  TabPanel,
  Tooltip,
  Badge,
} from '../../../../ui'
import { ConnectorRowGalleryContext, ConnectorSectionHeading } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { GlobalSurfaceShell } from '../../GlobalSurfaceShell'
import { useSurfaceBackNav } from '../../surfaceBackNav'
import { ADD_LOCAL_SKILL_SOURCE_LABEL } from '../../../../../../../shared/skills'
import { EXTENSIONS_DRAWER_VIEWS, type ExtensionsDrawerView } from '../extensionsSurfaceTarget'
import { CATALOGUE_PAGE_SIZE, deriveCataloguePage, stepCataloguePage, type CatalogueGroup } from './cataloguePaging'
import { INSTALLED_TAB_ID, catalogueMonogram, type CatalogueTab } from './catalogueTabs'
import { CatalogueViewSwitchContext } from './catalogueViewSwitch'
import { InstalledStack } from './InstalledStack'
import { SourceAvatar } from './SourceAvatar'

const TABS_PREFIX = 'extensions-catalogue'

/** One group inside the open tab: a heading, and the rows it holds in order. */
export type CatalogueSection<T> = {
  key: string
  label: string
  items: readonly T[]
  /**
   * A mark before the heading — the source's avatar, when the sections are
   * sources rather than a source's folders (a cross-source search). Absent for
   * the ordinary tab, whose head already wears the one source's mark.
   */
  leading?: React.ReactNode
}

/**
 * What the search box reads: `tab` filters the open tab and says so; `sources`
 * reads every source the door holds a scan for (catalogueSearch.ts), and the
 * field and the pager name that scope instead of the tab.
 */
export type CatalogueSearchScope = 'tab' | 'sources'

/**
 * What the plus after the last tab adds: a source (a folder on this machine,
 * or a repository of skills on GitHub) — and, where the door offers it, an
 * extension installed straight from its own repository.
 */
export type CatalogueAddMenu = {
  onAddFromFile: () => void
  onAddFromGitHub: () => void
  onInstallExtensionFromGitHub?: () => void
}

export function CatalogueSurface<T>({
  title,
  tabs,
  activeTabId,
  onSelectTab,
  search,
  add,
  head,
  notices,
  body,
  sections,
  renderRow,
  rowKey,
  noun,
  detail,
}: {
  /** The view's name: "Plugins", "Skills". */
  title: string
  tabs: readonly CatalogueTab[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  search: {
    query: string
    onQueryChange: (value: string) => void
    placeholder: string
    /** Defaults to `tab`. */
    scope?: CatalogueSearchScope
  }
  /** Null hides the plus — a kind no source can carry (see catalogueTabs). */
  add: CatalogueAddMenu | null
  /** The head line under the pills: what this tab is, and its actions. */
  head?: React.ReactNode
  notices?: React.ReactNode
  /**
   * Rendered INSTEAD of the sections, for a state that is not a list:
   * loading, unreadable, nothing here yet.
   */
  body?: React.ReactNode
  sections?: readonly CatalogueSection<T>[]
  /**
   * Draws one item, already in its `<li>`: the surface owns the list item, so
   * a row component need not know it is in a list. `rowKey` names the item
   * for React.
   */
  renderRow?: (item: T, index: number) => React.ReactNode
  rowKey?: (item: T) => string
  /** Singular noun for the pager's sentence: 'plugin', 'skill', 'agent CLI'. */
  noun: string
  /**
   * What a row opens: a dialog over the list (the skill and plugin detail
   * modals). Rendered here so the surface owns its open/closed state, but it
   * is a fixed overlay and takes no room in the row below.
   */
  detail?: React.ReactNode
}): JSX.Element {
  const back = useSurfaceBackNav()
  const viewSwitch = useContext(CatalogueViewSwitchContext)
  const query = search.query.trim()
  const searching = query !== ''
  // The group a View all opened, as a page of its own. It belongs to the tab
  // and the query it was opened under: a different tab, or a query typed,
  // is somewhere else, and lands back on the gallery.
  const placeKey = `${activeTabId} ${query}`
  const [opened, setOpened] = useState<{ place: string; key: string } | null>(null)
  const openedKey = opened && opened.place === placeKey ? opened.key : null
  const openedSection = openedKey ? sections?.find((section) => section.key === openedKey) : undefined
  // The page a person is standing on, and what it is a page OF. Changing tab,
  // opening a group or typing in the search box lands on page 1 — the
  // alternative is page 9 of a two-page result, which the model then clamps,
  // so the person's click on "9" silently becomes something else.
  const positionKey = `${placeKey} ${openedKey ?? ''}`
  const [position, setPosition] = useState({ key: positionKey, page: 1 })
  const current = stepCataloguePage(position, positionKey)

  // What is paged: every group while searching, the one group a View all
  // opened, or a tab that holds a single group anyway. The gallery itself —
  // several groups, each showing its first rows — is not paged at all.
  const paged = Boolean(openedSection) || searching || (sections ?? []).length <= 1
  const pagedSections = useMemo<readonly CatalogueSection<T>[]>(() => {
    if (openedSection) return [openedSection]
    return paged ? (sections ?? []) : []
  }, [openedSection, paged, sections])
  const groups = useMemo<CatalogueGroup[]>(
    () =>
      pagedSections.map((section) => ({
        key: section.key,
        label: section.label,
        count: section.items.length,
      })),
    [pagedSections],
  )
  const view = deriveCataloguePage({
    groups,
    page: current.page,
    pageSize: CATALOGUE_PAGE_SIZE,
    query: search.query,
    noun,
  })
  const sectionByKey = useMemo(() => new Map((sections ?? []).map((section) => [section.key, section])), [sections])

  const acrossSources = search.scope === 'sources'
  const selectTab = (id: string) => {
    onSelectTab(id)
    setOpened(null)
  }

  const bar = {
    title,
    actions: (
      <div className="flex items-center gap-3">
        {viewSwitch ? (
          <SegmentedControl<ExtensionsDrawerView>
            ariaLabel="Extensions to show"
            items={[
              { value: EXTENSIONS_DRAWER_VIEWS.plugins, label: 'Plugins' },
              { value: EXTENSIONS_DRAWER_VIEWS.skills, label: 'Skills' },
            ]}
            value={viewSwitch.view}
            onChange={viewSwitch.onChange}
          />
        ) : null}
      </div>
    ),
  }

  const activeTabLabel = tabs.find((tab) => tab.id === activeTabId)?.label ?? 'this tab'
  // What the pager is a pager OF: the tab, or — with a query on a search that
  // reads every source — the whole door.
  const pagedLabel =
    acrossSources && searching
      ? `${title} across all sources`
      : openedSection
        ? `${openedSection.label} in ${activeTabLabel}`
        : `${title} in ${activeTabLabel}`

  const renderRows = (section: CatalogueSection<T>, start: number, end: number, columns: 1 | 2) =>
    renderRow && rowKey ? (
      <ul
        aria-label={section.label}
        className={`grid gap-x-8 gap-y-1 ${columns === 2 ? 'grid-cols-1 @2xl:grid-cols-2' : 'grid-cols-1'}`}
      >
        {section.items.slice(start, end).map((item, index) => (
          <li key={rowKey(item)} className="min-w-0">
            {renderRow(item, start + index)}
          </li>
        ))}
      </ul>
    ) : null

  const heading = (section: CatalogueSection<T>, label: string, count: number, action?: React.ReactNode) => (
    <div className="flex items-center gap-2.5">
      {section.leading}
      <div className="min-w-0 flex-1">
        <ConnectorSectionHeading label={label} count={count} />
      </div>
      {action}
    </div>
  )

  const pagedBody = (
    <>
      <div className={searching ? 'space-y-5' : 'space-y-8'}>
        {view.groups.map((group) => {
          const section = sectionByKey.get(group.key)
          if (!section) return null
          return (
            <section key={group.key} className="space-y-2">
              {/* A group opened as a page is named by the page's own title
                  above, so it does not name itself a second time. */}
              {openedSection
                ? null
                : heading(
                    section,
                    // A group that started on an earlier page says so, rather
                    // than repeating its heading as if the rows above it were
                    // something else.
                    group.continued ? `${group.label} (continued)` : group.label,
                    group.total,
                  )}
              {renderRows(section, group.start, group.end, searching ? 1 : 2)}
            </section>
          )
        })}
      </div>
      <Pager
        page={view.page}
        pageCount={view.pageCount}
        rangeLabel={view.rangeLabel}
        onPageChange={(page) => setPosition({ key: positionKey, page })}
        ariaLabel={pagedLabel}
      />
    </>
  )

  const galleryBody = (
    <div className="space-y-8">
      {(sections ?? []).map((section) => {
        const more = section.items.length > GALLERY_PREVIEW_ROWS
        return (
          <section key={section.key} className="space-y-2">
            {heading(
              section,
              section.label,
              section.items.length,
              more ? (
                <LinkButton
                  onClick={() => setOpened({ place: placeKey, key: section.key })}
                  aria-label={`View all ${section.items.length} in ${section.label}`}
                >
                  View all
                </LinkButton>
              ) : undefined,
            )}
            {renderRows(section, 0, GALLERY_PREVIEW_ROWS, 2)}
          </section>
        )
      })}
    </div>
  )

  // The pager also says when there is nothing to show — "Nothing matches"
  // for a query — so a paged state with no rows still takes the paged body.
  const content = body ?? (paged ? pagedBody : galleryBody)

  return (
    <GlobalSurfaceShell
      ariaLabel={title}
      bar={bar}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
      controlTabContext="extensions"
    >
      <ConnectorRowGalleryContext.Provider value={true}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 space-y-3 px-6 pb-3 pt-5">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <InboxSearchInput
                  value={search.query}
                  onChange={(value) => {
                    search.onQueryChange(value)
                    setPosition({ key: `${activeTabId} ${value.trim()} `, page: 1 })
                  }}
                  ariaLabel={
                    acrossSources
                      ? `Search ${title.toLowerCase()} across all sources`
                      : `Search ${title.toLowerCase()} in the open tab`
                  }
                  placeholder={search.placeholder}
                  controlsId={`${TABS_PREFIX}-panel-${activeTabId}`}
                />
              </div>
              {add ? <AddSourceMenu add={add} /> : null}
            </div>
            {openedSection ? (
              // A group opened as a page: the way back is glued to its name,
              // where the eye already is — the dialog's X is the way out.
              <div className="flex items-center gap-2">
                <Tooltip content="Back" placement="bottom">
                  <IconButton size="sm" aria-label={`Back to ${activeTabLabel}`} onClick={() => setOpened(null)}>
                    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
                      <path
                        d="M10 3.5 5.5 8l4.5 4.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </IconButton>
                </Tooltip>
                <h3 className="truncate text-title font-semibold tracking-tight text-[color:var(--text-strong)]">
                  {openedSection.label}
                </h3>
              </div>
            ) : tabs.length > 0 ? (
              <SourcePills
                title={title}
                tabs={tabs}
                activeTabId={activeTabId}
                onSelect={(id) => {
                  selectTab(id)
                  setPosition({ key: `${id} ${query} `, page: 1 })
                }}
              />
            ) : null}
          </div>

          <div className="flex min-h-0 flex-1">
            <TabPanel
              idPrefix={TABS_PREFIX}
              tabId={activeTabId}
              active
              className="@container min-h-0 min-w-0 flex-1 overflow-y-auto px-6 pb-6 pt-2"
            >
              {head && !openedSection ? <div className="mb-6">{head}</div> : null}
              {notices ? <div className="mb-4 space-y-2">{notices}</div> : null}
              {content}
            </TabPanel>
            {detail}
          </div>
        </div>
      </ConnectorRowGalleryContext.Provider>
    </GlobalSurfaceShell>
  )
}

/** Rows a group shows in the gallery before its View all: three to a column. */
const GALLERY_PREVIEW_ROWS = 6

/** Pills a line holds before the rest fold into More. */
const VISIBLE_SOURCE_PILLS = 5

/**
 * The sources, as pills on one line (owner ruling 2026-11-03). A tablist —
 * the pills ARE the tabs, and the panel below is theirs — whose arrow keys
 * walk the pills the line shows. The ones that do not fit fold into More,
 * and a source picked from there takes the last visible place, so the open
 * source is always a pill a person can see is open.
 */
function SourcePills({
  title,
  tabs,
  activeTabId,
  onSelect,
}: {
  title: string
  tabs: readonly CatalogueTab[]
  activeTabId: string
  onSelect: (id: string) => void
}): JSX.Element {
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId)
  const visible =
    tabs.length <= VISIBLE_SOURCE_PILLS + 1
      ? tabs
      : activeIndex >= VISIBLE_SOURCE_PILLS
        ? [...tabs.slice(0, VISIBLE_SOURCE_PILLS - 1), tabs[activeIndex]]
        : tabs.slice(0, VISIBLE_SOURCE_PILLS)
  const folded = tabs.filter((tab) => !visible.includes(tab))
  const focusPill = (id: string) => {
    window.requestAnimationFrame(() => document.getElementById(`${TABS_PREFIX}-tab-${id}`)?.focus())
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = visible.findIndex((tab) => tab.id === activeTabId)
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const target =
      event.key === 'Home'
        ? visible[0]
        : event.key === 'End'
          ? visible[visible.length - 1]
          : step !== 0
            ? visible[(Math.max(index, 0) + step + visible.length) % visible.length]
            : null
    if (!target) return
    event.preventDefault()
    onSelect(target.id)
    focusPill(target.id)
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <div role="tablist" aria-label={`${title} sources`} className="contents" onKeyDown={onKeyDown}>
        {visible.map((tab) => (
          <SourcePill key={tab.id} tab={tab} selected={tab.id === activeTabId} onSelect={() => onSelect(tab.id)} />
        ))}
      </div>
      {folded.length > 0 ? (
        <OverflowMenu
          ariaLabel="More sources"
          align="start"
          items={folded.map((tab) => ({
            id: tab.id,
            label: tab.count === null ? tab.label : `${tab.label} · ${tab.count}`,
            onSelect: () => onSelect(tab.id),
          }))}
          renderTriggerControl={(props) => (
            <ChipButton variant="pill" {...props}>
              More
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path
                  d="m4 6 4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ChipButton>
          )}
        />
      ) : null}
    </div>
  )
}

function SourcePill({
  tab,
  selected,
  onSelect,
}: {
  tab: CatalogueTab
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const updates = tab.updateCount > 0
  const moved = tab.updateAvailable && !updates
  return (
    <ChipButton
      variant="pill"
      selected={selected}
      // A tab says it is the chosen one through `aria-selected`; the chip's
      // own `aria-current` is for a step in a trail.
      aria-current={undefined}
      role="tab"
      id={`${TABS_PREFIX}-tab-${tab.id}`}
      data-tab-id={tab.id}
      aria-selected={selected}
      aria-controls={`${TABS_PREFIX}-panel-${tab.id}`}
      tabIndex={selected ? 0 : -1}
      // The pip and the moved mark say things the label does not, so the pill
      // names itself the way the tab strip it replaces did.
      aria-label={
        updates
          ? `${tab.label}: ${tab.updateCount} ${tab.updateCount === 1 ? 'update' : 'updates'} available`
          : moved
            ? `${tab.label} — update available`
            : undefined
      }
      onClick={onSelect}
    >
      {/* Installed wears the marks of a few of the things it holds — what this
          machine has, recognised before it is counted; a source wears its
          own mark. */}
      {tab.id === INSTALLED_TAB_ID ? (
        <InstalledStack size={16} />
      ) : tab.source ? (
        <SourceAvatar source={tab.source} monogram={catalogueMonogram(tab.source)} size={16} />
      ) : null}
      <span className="max-w-[14rem] truncate">{tab.label}</span>
      {/* A count that is not known is absent, never zero: a scan still
          reading, or one that failed, must not render as an empty source. */}
      {tab.count !== null ? (
        <span className="tabular-nums font-mono text-micro text-[color:var(--text-subtle)]">{tab.count}</span>
      ) : null}
      {updates ? <Badge tone="accent" count={tab.updateCount} max={99} decorative /> : null}
      {moved ? <UpdateMark /> : null}
    </ChipButton>
  )
}

/** An upward step: this source has moved on since it was last read. */
function UpdateMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 10.6V5.4M5.8 7.4 8 5.2l2.2 2.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The plus beside the search field: a folder on this machine or a repository of
 * skills on GitHub, and — a different act, so it says so in its own words —
 * an extension installed from its repository. The two GitHub items name what
 * each repository is, because the same pasted URL means different things to
 * each. It is the kit's overflow menu wearing a plus rather than a kebab, so
 * Enter opens it, the arrows rove and Escape closes it without this file
 * writing a menu of its own.
 */
function AddSourceMenu({ add }: { add: CatalogueAddMenu }): JSX.Element {
  return (
    <OverflowMenu
      ariaLabel="Add source"
      align="end"
      items={[
        { id: 'file', label: ADD_LOCAL_SKILL_SOURCE_LABEL, onSelect: add.onAddFromFile },
        { id: 'github', label: 'Add skill source from GitHub…', onSelect: add.onAddFromGitHub },
        ...(add.onInstallExtensionFromGitHub
          ? [
              {
                id: 'install-extension-github',
                label: 'Install extension from GitHub…',
                onSelect: add.onInstallExtensionFromGitHub,
              },
            ]
          : []),
      ]}
      renderTriggerControl={(props, opened) => (
        <Tooltip content="Add source" placement="bottom">
          {/* Beside the search field, at the field's own height: adding a
              source is the other way to find more, so it stands where the
              looking is done. */}
          <IconButton size="md" {...props} pressed={opened ? true : undefined} className="shrink-0">
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </IconButton>
        </Tooltip>
      )}
    />
  )
}

/**
 * The head line under the tab row: the source's own state on the left, its
 * actions on the right. Sync, Open on GitHub and Remove lived on the Sources
 * rail's source page; they are here now, in one place per tab, rather than on
 * the tab itself where they would be three controls inside a navigation.
 */
/**
 * The head of a tab: the source's mark, its name at title weight, and ONE quiet
 * line under it — where it comes from (the repository, the folder, the
 * registry). Not what it holds: the tab already carries the count, the section
 * heading carries it again, and the rows are the holdings. Not what happened
 * to it either: a sync outcome or a partial read is a notice under the head,
 * where it can be read once and dismissed, rather than a clause the head
 * carries forever (extensions review, 2026-09-08 — the head had grown to four
 * lines of counts, links and caveats, and nobody could find the name in it).
 */
export function CatalogueHead({
  monogram,
  name,
  stateLine,
  actions,
}: {
  /** The source's mark — an avatar or a monogram chip — at the head's own size. */
  monogram?: React.ReactNode
  name: string
  /** Where this tab's rows come from. One line; it truncates rather than wraps. */
  stateLine: React.ReactNode
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-4">
      {monogram}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-title font-semibold tracking-tight text-[color:var(--text-strong)]">{name}</h3>
        <p className="mt-0.5 truncate text-body text-[color:var(--text-muted)]">{stateLine}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
