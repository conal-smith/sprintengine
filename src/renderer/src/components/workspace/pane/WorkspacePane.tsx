import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../../modules'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { WorkspacePaneTab, WorkspacePaneTabKind } from '../../../types/workspace'
import {
  ContextMenu,
  IconButton,
  MenuDivider,
  MenuItem,
  OpenInWindowGlyph,
  Tabs,
  TabsScroller,
  Tooltip,
  type TabItem,
} from '../../ui'
import { composePaneKinds, type PaneLaunchKind } from './paneKinds'
import { WORKSPACE_PANE_DATA_ATTRIBUTE } from './paneFocus'
import { paneTabItem } from './paneTabItem'
import { closePaneTabAndItsTerminal } from './paneTerminals'
import { bringBackPaneTab, canPopOutPane, popOutPaneTabs, showPanePopOut } from './popout/panePopOutHost'
import { WorkspacePaneAddMenu } from './WorkspacePaneAddMenu'
import { PANEL_COMMAND_EVENT } from '../../../utils/panelCommands'
import { WorkspacePaneBody } from './WorkspacePaneBody'
import { WorkspacePaneLauncher } from './WorkspacePaneLauncher'
import { WindowCaptionReserve, paneStripOwnsCaptionCorner, windowCaptionReserve } from '../WindowControls'

// One workspace's pane: the 36px strip (tabs · + · pop out · maximise · close)
// over the tab bodies. Mounted once per retained workspace by
// WorkspacePaneColumn so a terminal (later a browser) survives a workspace
// switch; `active` says whether this is the one on screen.

function MaximiseGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M9.5 3H13v3.5M6.5 13H3V9.5M13 3 9.2 6.8M3 13l3.8-3.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RestoreGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M13 3 9.5 6.5M9.5 3v3.5H13M3 13l3.5-3.5M6.5 13V9.5H3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The same panel-right rect the header's pane switch draws: one glyph for the
// column on both ends of the gesture.
function ClosePaneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

type TabMenuState = { x: number; y: number; tabId: string }

type WorkspacePaneProps = {
  workspaceId: string
  active: boolean
}

export default function WorkspacePane({ workspaceId, active }: WorkspacePaneProps) {
  const paneState = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.paneState)
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const maximised = useWorkspaceStore((s) => s.workspacePaneMaximised)
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? '')
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const openModalSurface = useWorkspaceStore((s) => s.openModalSurface)
  const setActivePaneTab = useWorkspaceStore((s) => s.setActivePaneTab)
  const movePaneTab = useWorkspaceStore((s) => s.movePaneTab)
  const setPaneOpen = useWorkspaceStore((s) => s.setPaneOpen)
  const setMaximised = useWorkspaceStore((s) => s.setWorkspacePaneMaximised)

  const tabs = paneState?.tabs ?? []
  const activeTabId = paneState?.activeTabId ?? null
  const collapsedWithFloatingPlayer = !(paneState?.open ?? false) && tabs.some((tab) => tab.floating)
  // What the agent tools act on when they name no tab: the browser tab the
  // person is looking at, or none when the active tab is not a browser. A
  // browser tab out in a window of its own is that window's to name; main
  // keeps this pane's "none" from clearing it (browser:note-active).
  const activeBrowserTabId =
    tabs.find((tab) => tab.id === activeTabId && tab.kind === 'browser' && !tab.poppedOut)?.id ?? null
  useEffect(() => {
    void window.api.browserNoteActive(workspaceId, activeBrowserTabId)
  }, [activeBrowserTabId, workspaceId])
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  // The "+" menu, held here so `pane.add` (⌘T) can open it: the window
  // routes the command to the pane on screen, opening the column first.
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  useEffect(() => {
    if (!active) return
    const onPanelCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; workspaceId?: string }>).detail
      if (detail?.id === 'pane.add' && detail.workspaceId === workspaceId) setAddMenuOpen(true)
    }
    window.addEventListener(PANEL_COMMAND_EVENT, onPanelCommand)
    return () => window.removeEventListener(PANEL_COMMAND_EVENT, onPanelCommand)
  }, [active, workspaceId])
  // The Diff tab's canonical count — the files its viewer lists — reported by
  // the viewer while it is mounted; null until it has answered.
  const [diffCount, setDiffCount] = useState<number | null>(null)

  // Third-party modules normally finish loading before the React root renders;
  // when a slow one lands after it, this bump recomposes the kinds so its row
  // appears without a reload (the same generation trick WorkspaceManager uses).
  const [moduleRegistryGeneration, setModuleRegistryGeneration] = useState(0)
  useEffect(() => onThirdPartyRendererModulesLoaded(() => setModuleRegistryGeneration((n) => n + 1)), [])

  // Kinds whose module is on: the shell's own, then the rows modules
  // contributed on their modal surfaces. A disabled module's kind is absent,
  // not greyed — for a contributed row exactly as for a built-in one.
  const kinds = useMemo(
    () =>
      composePaneKinds(getRendererHost().getModalSurfaceLaunchers(), (moduleId) =>
        selectModuleEnabled(moduleOverrides, moduleId),
      ),
    // moduleRegistryGeneration: a late third-party load re-derives the list.
    [moduleOverrides, moduleRegistryGeneration],
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (tab) closePaneTabAndItsTerminal(workspaceId, tab)
    },
    [tabs, workspaceId],
  )

  // Closing the column with focus inside it would strand the keyboard in
  // hidden chrome; the header's pane switch is where the gesture came from.
  const closePane = useCallback(() => {
    setPaneOpen(workspaceId, false)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-pane-switch]')?.focus()
    })
  }, [setPaneOpen, workspaceId])

  const closeTabsWhere = useCallback(
    (predicate: (tab: WorkspacePaneTab, index: number) => boolean) => {
      tabs.forEach((tab, index) => {
        if (predicate(tab, index)) closeTab(tab.id)
      })
    },
    [closeTab, tabs],
  )

  // A kind that names a modal surface floats it over the page instead of
  // opening a tab (Reviews). Everything else is a tab of this pane.
  const openKind = useCallback(
    (kind: PaneLaunchKind) => {
      // The composed row is what was picked, so its modalSurfaceId is read
      // from the list the person clicked — `paneKindDefinition` only knows the
      // static tab kinds.
      const definition = kinds.find((candidate) => candidate.kind === kind)
      if (definition?.modalSurfaceId) {
        // The modal floats over the window, not inside this workspace's card,
        // so it is handed the workspace it was opened FROM — a review runs its
        // guide in the workspace the reviewer reached for it in (D5).
        openModalSurface(definition.modalSurfaceId, { workspaceId })
        return
      }
      // Every kind opens docked, Canvas included (owner ruling 2026-09-22): a
      // tab that took the whole window on arrival read as the pane opening full
      // screen by default. The editor falls back to its compact layout in a
      // narrow pane, and Maximise beside "+" is the person's call to make.
      openPaneTab(workspaceId, { kind: kind as WorkspacePaneTabKind })
    },
    [kinds, openModalSurface, openPaneTab, workspaceId],
  )

  const items: TabItem[] = tabs.map((tab) => paneTabItem(tab, { diffCount }))

  const menuTabIndex = tabMenu ? tabs.findIndex((tab) => tab.id === tabMenu.tabId) : -1
  const menuTab = menuTabIndex === -1 ? null : tabs[menuTabIndex]
  // A window of its own is a desktop thing: a browser tab has no second OS
  // window to give the pane, so the web client offers neither entry point.
  const popOutOffered = canPopOutPane()
  // What "Pop out pane" takes: every tab still docked. Tabs already out stay
  // in the windows they are in — one tab, one window.
  const dockedTabIds = tabs.filter((tab) => !tab.poppedOut).map((tab) => tab.id)

  return (
    <section
      aria-label={workspaceName ? `${workspaceName} pane` : 'Workspace pane'}
      data-control-tab-scope
      {...{ [WORKSPACE_PANE_DATA_ATTRIBUTE]: workspaceId }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* The strip: the pane's one band of chrome, on the header's 36px
          baseline. Its empty run drags the window; the tabs and the controls
          opt out. `chrome-bar` joins it to the window's top band, and the band
          draws no bottom hairline any more (owner, 2026-09-09: no divider under
          the bar) — the rounded card below is the edge. The active tab's
          underline still sits on the strip's bottom edge; it now draws on the
          gap between the strip and the card rather than on a rule. */}
      {/* The strip is clipped to nothing by a collapsed column, but a collapsed
          column stays INTERACTIVE while a tab is floating (the player paints
          outside it), so the strip has to take itself out of the tab order —
          otherwise focus lands in chrome nobody can see. */}
      <div
        className="chrome-bar app-drag flex h-[36px] shrink-0 items-end pl-1.5 pr-1"
        inert={collapsedWithFloatingPlayer}
      >
        {/* Scrolls sideways with no scrollbar and a fade at each overflowing
            edge (TabsScroller): a 10px bar under a 36px strip is a second line
            in a band that already has one, and a plain vertical wheel is the
            gesture people make over a row of tabs. */}
        {/* The scroller takes only the width its tabs need (it shrinks, it
            never grows), so the "+" after it sits right of the last tab. Once
            the tabs outgrow the strip the scroller is squeezed to what is
            left, the tabs scroll inside it, and the "+" stays in view at its
            end. The empty run between "+" and the controls is the spacer's,
            and it is what drags the window. */}
        <TabsScroller className="flex min-w-0 flex-initial items-end self-stretch">
          {tabs.length > 0 && activeTabId ? (
            <Tabs
              ariaLabel="Pane tabs"
              className="app-no-drag"
              idPrefix={`pane-${workspaceId}`}
              items={items}
              value={activeTabId}
              controlTabItems
              onChange={(tabId) => setActivePaneTab(workspaceId, tabId)}
              // Dragged into the order the person wants, which is the order
              // the strip keeps: opening a tab adds it at the end and leaves
              // the rest where they were put.
              onReorder={(tabId, toIndex) => movePaneTab(workspaceId, tabId, toIndex)}
              onCloseItem={closeTab}
              onItemAuxClick={(tabId, event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeTab(tabId)
                }
              }}
              onItemContextMenu={(tabId, event) => {
                event.preventDefault()
                setTabMenu({ x: event.clientX, y: event.clientY, tabId })
              }}
              borderless
            />
          ) : null}
        </TabsScroller>
        <div className="app-no-drag flex h-full shrink-0 items-center pl-0.5">
          <WorkspacePaneAddMenu kinds={kinds} onPick={openKind} open={addMenuOpen} onOpenChange={setAddMenuOpen} />
        </div>
        <div className="min-w-0 flex-1 self-stretch" aria-hidden="true" />
        <div className="app-no-drag flex h-full shrink-0 items-center gap-0.5">
          {/* Out into a window of its own, which can be resized and taken full
              screen: the pane's whole strip, with its tab in front kept in
              front. The tabs stay in this strip, marked, and come back when
              the window closes. */}
          {popOutOffered ? (
            <Tooltip content="Pop out pane" placement="bottom">
              <IconButton
                onClick={() => void popOutPaneTabs(workspaceId, dockedTabIds)}
                aria-label="Pop out pane"
                disabled={dockedTabIds.length === 0}
              >
                <OpenInWindowGlyph className="icon-sm" />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip content={maximised ? 'Restore pane' : 'Maximise pane'} placement="bottom">
            <IconButton
              onClick={() => setMaximised(!maximised)}
              aria-label={maximised ? 'Restore pane' : 'Maximise pane'}
              pressed={maximised}
            >
              {maximised ? <RestoreGlyph className="icon-sm" /> : <MaximiseGlyph className="icon-sm" />}
            </IconButton>
          </Tooltip>
          {/* Maximised, this strip sits directly under the WorkspaceHeader,
              whose pane switch draws the same glyph and does the same thing
              one row up; two of them stacked in one corner read as a
              duplicated control. Docked, the two are a column apart and both
              stay. */}
          {maximised ? null : (
            <Tooltip content="Close pane" placement="bottom">
              <IconButton onClick={closePane} aria-label="Close pane">
                <ClosePaneGlyph className="icon-sm" />
              </IconButton>
            </Tooltip>
          )}
        </div>
        {/* Docked, the pane is the window's rightmost column, so on win/linux
            the floating caption buttons sit over THIS strip's corner: leave
            them their width, or Close-pane hides under Close-window. Maximised,
            the strip starts below the WorkspaceHeader and the header takes the
            corner and the reserve (paneStripOwnsCaptionCorner). */}
        <WindowCaptionReserve
          width={
            paneStripOwnsCaptionCorner({ open: true, maximised })
              ? windowCaptionReserve(window.api.platform === 'darwin')
              : 0
          }
        />
      </div>
      {/* The pane's body is its own card: the 36px strip above it belongs to
          the window's frosted band, not to this column, so the body starts at
          the same y as the workspace card beside it and rounds the same way.
          `overflow-hidden` is what clips a terminal or a browser to the
          corners. The gap toward the workspace card is this card's own margin
          and reads --shell-card-gap, the same token the sidebar card uses on
          its other side, so the two gaps in the shell cannot drift apart. It
          takes the same gap on its RIGHT, against the window edge, so the frost
          frames the card on all four sides rather than three. The 36px strip
          above is deliberately not inset: it belongs to the band, and the band
          runs to the window edge. */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--shell-card-radius)] bg-[color:var(--bg-surface)] ml-[var(--shell-card-gap)] mr-[var(--shell-card-gap)] mb-[var(--shell-card-gap)]">
        {tabs.length === 0 ? (
          <WorkspacePaneLauncher kinds={kinds} onPick={openKind} />
        ) : (
          <WorkspacePaneBody
            workspaceId={workspaceId}
            tabs={tabs}
            // A tab is "active" for its panel only while someone can see it:
            // this workspace on screen and the pane open. A collapsed pane's
            // browser tab must not keep polling for dev servers.
            // A floating tab is on screen even though the pane is closed, so it
            // stays active; without this it would stop polling and stop
            // reporting itself as the tab the person is looking at.
            activeTabId={
              active
                ? (paneState?.open ?? false)
                  ? activeTabId
                  : (tabs.find((tab) => tab.floating)?.id ?? null)
                : null
            }
            selectedTabId={activeTabId}
            collapsed={!(paneState?.open ?? false)}
            onDiffCountChange={setDiffCount}
          />
        )}
      </div>
      {tabMenu && active ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          ariaLabel="Pane tab actions"
          onClose={() => setTabMenu(null)}
          surfaceClassName="min-w-[180px]"
        >
          <MenuItem onClick={() => closeTab(tabMenu.tabId)}>Close</MenuItem>
          <MenuItem disabled={tabs.length <= 1} onClick={() => closeTabsWhere((tab) => tab.id !== tabMenu.tabId)}>
            Close others
          </MenuItem>
          <MenuItem
            disabled={menuTabIndex === -1 || menuTabIndex >= tabs.length - 1}
            onClick={() => closeTabsWhere((_tab, index) => index > menuTabIndex)}
          >
            Close to the right
          </MenuItem>
          {popOutOffered && menuTab ? (
            <>
              <MenuDivider />
              {menuTab.poppedOut ? (
                <>
                  <MenuItem onClick={() => showPanePopOut(menuTab.poppedOut!)}>Show window</MenuItem>
                  <MenuItem onClick={() => bringBackPaneTab(workspaceId, menuTab)}>Bring back</MenuItem>
                </>
              ) : (
                // Just this tab, in a window of its own; the rest of the pane
                // stays where it is.
                <MenuItem onClick={() => void popOutPaneTabs(workspaceId, [menuTab.id])}>Pop out</MenuItem>
              )}
            </>
          ) : null}
        </ContextMenu>
      ) : null}
    </section>
  )
}
