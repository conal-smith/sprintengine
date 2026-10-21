// The Backlog and pane switches, extracted out of the old PanelRail so they live
// in the window title bar (AppTitleBar / WorkspaceHeader) as the single nav
// toolbar. One source of the PANELS descriptor and its toggle / module-gating /
// active-derivation semantics — the sidebar no longer carries a second copy.
//
// Files and Git have no switches here: they are workspace-pane tabs now
// (browser-pane epic), and the workspace identity cluster's branch chip opens
// Git; the command palette and their keyboard shortcuts
// (panel.files.toggle / panel.git.toggle) toggle them. Backlog is a pane tab
// too, but it keeps its switch: the glyph is the one entry point the panel
// has in the header, and it toggles the pane's Backlog tab.
//
// AppTitleBar is global chrome, so the active workspace id is passed in (it is
// window-scoped in WorkspaceManager and can't be resolved from the store alone);
// the layout model and pane record are subscribed here so the active treatment
// tracks any mutation of that workspace live.
//
// Two clusters, one column: the Backlog switch toggles the pane's Backlog tab
// (open it, bring it forward, or close it), the pane switch the pane itself.
// The pane switch steps aside while the pane is docked open: the pane's own
// strip ends in a Close-pane control with the same glyph, and two of them in
// one band read as a duplicated control. Closed, it is the way back in;
// maximised, the strip drops its own close and this one is the only one.

import type { JSX } from 'react'
import { IconButton, Tooltip } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { selectModuleEnabled } from '../../modules'
import type { WorkspaceId, WorkspacePaneTabKind } from '../../types/workspace'
import { getEffectiveKeybindingLabel, platformKeybindingsFromApiPlatform } from '../../commands/effectiveKeybindings'

type PanelKey = 'backlog' | 'pane'

// Which header cluster a switch renders into.
type PanelCluster = 'left' | 'right'

type PanelDescriptor = {
  key: PanelKey
  commandId?: string
  label: string
  // Accessible name and tooltip while the pane is open, for a control that reads
  // as a collapse once its pane is showing. Falls back to `label`.
  activeLabel?: string
  cluster: PanelCluster
  // Capability module that gates this button; the toolbar hides it when the
  // module is disabled. Undefined for a panel that belongs to no module and is
  // therefore always offered.
  moduleId?: string
  // What the switch drives: one kind of workspace-pane tab (active = the pane
  // is open on that kind's tab, the predicate `gitPanelActive` uses) or the
  // workspace pane column itself (active = the workspace's pane record says
  // open).
  target: { kind: 'pane-tab'; tabKind: WorkspacePaneTabKind } | { kind: 'pane' }
  // Inline SVGs so we stay aligned with the existing 16 px chrome used by the
  // other header strip buttons.
  icon: (props: { className?: string }) => JSX.Element
}

// Single source of the panel-switch descriptor. Exported so any future consumer
// reuses the same behavior instead of re-implementing icons/module-gating.
const PANELS: PanelDescriptor[] = [
  {
    key: 'backlog',
    moduleId: 'backlog',
    label: 'Backlog',
    cluster: 'left',
    target: { kind: 'pane-tab', tabKind: 'backlog' },
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="3" cy="4.5" r="1" fill="currentColor" />
        <circle cx="3" cy="8" r="1" fill="currentColor" />
        <circle cx="3" cy="11.5" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'pane',
    commandId: 'pane.toggle',
    label: 'Open pane',
    activeLabel: 'Close pane',
    cluster: 'right',
    target: { kind: 'pane' },
    // SidebarChrome's collapse glyph mirrored: the same rect, the same 1.5
    // stroke, the divider moved from x=6 to x=10. One idiom, both edges.
    icon: ({ className }) => (
      <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 3V13" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
]

type PanelSwitchesProps = {
  // Window-scoped active workspace; null while none is active — the whole switch
  // group (and its leading divider) hides so the strip reads as nav-only.
  activeWorkspaceId: WorkspaceId | null
  // The leading hairline divider separates the switches from an adjacent window
  // nav cluster (collapse · back · forward) in the full-width AppTitleBar. In the
  // split-chrome WorkspaceHeader the switches lead the strip, so it's dropped.
  leadingDivider?: boolean
  // Which cluster's switches to render. The left group owns its own toolbar; the
  // right group joins WorkspaceHeader's existing right toolbar (diagnostics ·
  // attention), so it renders bare — a nested toolbar there would be invalid.
  cluster?: PanelCluster
}

export function PanelSwitches({ activeWorkspaceId, leadingDivider = true, cluster = 'left' }: PanelSwitchesProps) {
  // Subscribe to the active workspace's pane record so the active treatment
  // re-renders whenever any path (switch click, "+" menu, accelerator, tab
  // close, a reveal from another surface) mutates it.
  const paneOpen = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.paneState?.open ?? false,
  )
  const activePaneTabKind = useWorkspaceStore((state) => {
    const pane = state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.paneState
    return pane?.tabs.find((tab) => tab.id === pane.activeTabId)?.kind ?? null
  })
  const paneMaximised = useWorkspaceStore((state) => state.workspacePaneMaximised)
  const setPaneOpen = useWorkspaceStore((state) => state.setPaneOpen)
  const togglePaneKind = useWorkspaceStore((state) => state.togglePaneKind)

  // Hide a switch when its capability module is disabled — driven by each
  // descriptor's moduleId, so a new gated panel just sets moduleId.
  const moduleOverrides = useWorkspaceStore((state) => state.appSettings.modules)
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const keybindingPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const panels = PANELS.filter(
    (panel) =>
      panel.cluster === cluster &&
      (!panel.moduleId || selectModuleEnabled(moduleOverrides, panel.moduleId)) &&
      !(panel.target.kind === 'pane' && paneOpen && !paneMaximised),
  )
  const shortcutFor = (commandId: string): string | null =>
    getEffectiveKeybindingLabel(commandId, keybindingSettings, keybindingPlatform)

  // No active workspace, or every panel's module disabled: render nothing at all
  // (including the divider) so the nav arrows sit alone.
  if (!activeWorkspaceId || panels.length === 0) return null

  const renderSwitch = (panel: PanelDescriptor) => {
    const Icon = panel.icon
    const active = panel.target.kind === 'pane-tab' ? paneOpen && activePaneTabKind === panel.target.tabKind : paneOpen
    const label = active ? (panel.activeLabel ?? panel.label) : panel.label
    const shortcut = panel.commandId ? shortcutFor(panel.commandId) : null
    const tooltip = shortcut ? `${label} (${shortcut})` : label
    const toggle = () => {
      if (panel.target.kind === 'pane-tab') {
        togglePaneKind(activeWorkspaceId, panel.target.tabKind)
      } else {
        setPaneOpen(activeWorkspaceId, !paneOpen)
      }
    }
    return (
      <Tooltip key={panel.key} content={tooltip} placement="bottom">
        {/* The kit's icon toggle. `pressed` IS this switch's active state — the
            neutral selection fill, not an accent underline, because the accent
            is reserved for the one primary action per view (principles.md §
            Restraint) — and it supplies `aria-pressed` as `false` while off,
            which is what a toggle owes a screen reader. `app-no-drag` is the
            drag-region opt-out this control needs inside the title bar. */}
        <IconButton
          pressed={active}
          onClick={toggle}
          aria-label={label}
          className="app-no-drag"
          // The pane's own close control hands focus back here (WorkspacePane).
          {...(panel.target.kind === 'pane' ? { 'data-pane-switch': '' } : {})}
        >
          <Icon className="size-icon-sm" />
        </IconButton>
      </Tooltip>
    )
  }

  // The right cluster sits inside WorkspaceHeader's existing right toolbar, so
  // it contributes buttons only — its own wrapper would nest one toolbar in
  // another.
  if (cluster === 'right') return <>{panels.map(renderSwitch)}</>

  return (
    <div role="toolbar" aria-label="Workspace panels" className="flex items-center">
      {/* Hairline divider separating window nav (collapse · back · forward) from
          the per-workspace panel switches — only when they share a strip. */}
      {leadingDivider ? <span aria-hidden="true" className="mx-1.5 h-4 w-px bg-[color:var(--border-subtle)]" /> : null}
      <div className="flex items-center gap-0.5">{panels.map(renderSwitch)}</div>
    </div>
  )
}
