import { useEffect, useMemo, useState } from 'react'

import { getRendererHost, onThirdPartyRendererModulesLoaded, selectModuleEnabled } from '../../modules'
import type {
  RegisteredGlobalSurface,
  RegisteredSidebarNavEntry,
  SidebarNavEntryComponent,
  SurfaceIconComponent,
} from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { DRAWER_ROWS, EXTENSIONS_CATALOGUE_SURFACE_ID } from './extensionsDrawer'
import { extensionContributionRows } from './extensionContributionRows'
import { useSurfaceView } from './surfaceView'

// The drawer's six fixed rows plus installed door contributions, RESOLVED
// (Extensions drawer ruling, 2026-09-05, Stage 3; module-door completion,
// 2026-09-13). `extensionsDrawer.ts` says which product rows exist and in what
// order; installed surfaces follow them. This says what every row currently IS
// against the live registry — its name, glyph, selection, and open behaviour.
//
// It exists because the rows are now offered in two places. The drawer column
// lists them, and the Extensions home lists the same set as tiles, and the
// ruling is explicit that a tile "opens the same surface the drawer row does".
// Two resolvers would be two routings: the day a view row's deep-link latch
// changed, the tile would keep opening the old way and only one of the two
// would be found in testing. So the routing is written once, here, and both
// surfaces render what it returns.
//
// Not in `extensionsDrawer.ts` on purpose: that file is a leaf the store reads
// (settingsSlice), and this one reaches React and the workspace store.

export type ExtensionsDrawerRowView = {
  /** Stable across renders and unique in the list; a React key. */
  key: string
  /**
   * The row's notification key: a fixed row's id (`design`, `plugins`,
   * `skills`), or an installed door's surface id — on that door's only row, or
   * the first of its view rows. Null on the rest, so a count is worn once.
   */
  rowId: string | null
  /** The surface the row leads to. */
  surfaceId: string
  /** The module that contributed the row, for containing its render failures. */
  moduleId: string
  /** The view within it, when the row is one of a multi-row surface's views. */
  viewId?: string
  /**
   * The row's name and glyph, as the owning module declares them. Absent when
   * a door names itself through its own nav-entry component instead; a caller
   * that can only draw a generic row skips those.
   */
  label?: string
  Icon?: SurfaceIconComponent
  /**
   * The module's own row component, for a row contributed as a sidebar nav
   * entry. It owns its full chrome — a status dot, its own reading of
   * "selected" — so the drawer renders THIS rather than a generic row.
   */
  navComponent?: SidebarNavEntryComponent
  /**
   * The card region is showing exactly this row's destination. For a nav row
   * the module's own component owns the richer reading — a door may read as
   * selected in more places than this — so this stays the plain one and the
   * drawer does not use it there.
   */
  active: boolean
  /** Open this row's destination — the one routing both the drawer and the home use. */
  open: () => void
}

/**
 * The nav entries are resolved HERE, not handed in. The drawer used to pass
 * the list the sidebar had memoised on `moduleOverrides` alone, while this
 * resolver bumps itself when third-party renderer modules finish loading late
 * — so a module that registered a nav row after boot appeared on the Extensions
 * home and never in the drawer beside it. One resolution, one generation
 * counter, both callers.
 */
export function useExtensionsDrawerRows(): ExtensionsDrawerRowView[] {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  // The Plugins and Skills catalogue is open as a modal, not a door (owner
  // ruling 2026-11-03), and its rows read selected while it shows their view.
  const catalogueModalOpen = useWorkspaceStore((s) => s.activeModalSurface === EXTENSIONS_CATALOGUE_SURFACE_ID)
  const openSurfaceId = catalogueModalOpen ? EXTENSIONS_CATALOGUE_SURFACE_ID : activeGlobalSurface
  const openGlobalSurface = useWorkspaceStore((s) => s.openGlobalSurface)
  const setSidebarSection = useWorkspaceStore((s) => s.setSidebarSection)
  // Which view the OPEN surface is standing on, so exactly one of a
  // multi-view surface's rows reads selected — including when the person moved
  // with the surface's own rail rather than by clicking a row. Only the open
  // surface can own a selected row, so one subscription answers for the whole
  // list.
  const activeView = useSurfaceView(openSurfaceId ?? '')
  // Third-party renderer modules can finish loading after first render (the
  // boot timeout race WorkspaceManager's moduleRegistryGeneration handles):
  // without this bump an SDK module's registerGlobalSurface would mount fine
  // but its row — the only user-visible way in — would stay absent until an
  // unrelated module toggle or a reload.
  const [registryGeneration, setRegistryGeneration] = useState(0)
  useEffect(() => onThirdPartyRendererModulesLoaded(() => setRegistryGeneration((n) => n + 1)), [])
  const globalSurfaces = useMemo(
    () => getRendererHost().getGlobalSurfaces((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides, registryGeneration],
  )
  const hostNavEntries = useMemo(
    () => getRendererHost().getSidebarNavEntries((id) => selectModuleEnabled(moduleOverrides, id)),
    [moduleOverrides, registryGeneration],
  )

  return useMemo(() => {
    const surfaceById = new Map<string, RegisteredGlobalSurface>(globalSurfaces.map((surface) => [surface.id, surface]))
    const entryById = new Map<string, RegisteredSidebarNavEntry>(hostNavEntries.map((entry) => [entry.id, entry]))
    const fixedRows = DRAWER_ROWS.flatMap((row): ExtensionsDrawerRowView[] => {
      if (row.kind === 'nav') {
        const entry = entryById.get(row.entryId)
        if (!entry) return []
        // A nav row's entry id IS its surface id (the door contract), so the
        // module's `registerGlobalSurface` is where its name and glyph live
        // even though the drawer draws neither — the home's tile needs both.
        const surface = surfaceById.get(entry.id)
        return [
          {
            key: `nav:${entry.id}`,
            rowId: row.rowId,
            surfaceId: entry.id,
            moduleId: entry.moduleId,
            label: surface?.label,
            Icon: surface?.Icon,
            navComponent: entry.Component,
            active: activeGlobalSurface === entry.id,
            // The same call the module's own row makes. It is a plain open —
            // a nav door has no view to latch — so nothing precedes it.
            open: () => openGlobalSurface(entry.id),
          },
        ]
      }
      const surface = surfaceById.get(row.surfaceId)
      // A door with no label or glyph names itself through its own nav-entry
      // component and cannot be drawn as a generic row.
      if (!surface?.label || !surface.Icon) return []
      if (row.kind === 'surface') {
        return [
          {
            key: `surface:${surface.id}`,
            rowId: row.rowId,
            surfaceId: surface.id,
            moduleId: surface.moduleId,
            label: surface.label,
            Icon: surface.Icon,
            active: activeGlobalSurface === surface.id,
            open: () => {
              // A plain open lands on the surface's default view: the surface
              // discards any stale deep-link latch in `onOpen` first.
              surface.onOpen?.()
              openGlobalSurface(surface.id)
            },
          },
        ]
      }
      const view = surface.views?.find((candidate) => candidate.id === row.viewId)
      if (!view) return []
      return [
        {
          key: `view:${surface.id}:${view.id}`,
          rowId: row.rowId,
          surfaceId: surface.id,
          moduleId: surface.moduleId,
          viewId: view.id,
          label: view.label,
          Icon: view.Icon,
          // Selected while the surface is open ON THIS VIEW — not merely while
          // it is open, which would light all three of its rows.
          active: openSurfaceId === surface.id && activeView === view.id,
          open: () => {
            // The view latches its target first and the shell opens second,
            // the order every deep-link opener uses: the surface drains the
            // latch as it mounts, so an already-open surface and a cold one
            // both land on the row that was clicked.
            view.open()
            openGlobalSurface(surface.id)
          },
        },
      ]
    })
    return [
      ...fixedRows,
      ...extensionContributionRows({
        surfaces: globalSurfaces,
        navEntries: hostNavEntries,
        activeGlobalSurface,
        activeView,
        enterExtensions: () => setSidebarSection('extensions'),
        openGlobalSurface,
      }),
    ]
  }, [
    activeGlobalSurface,
    activeView,
    hostNavEntries,
    globalSurfaces,
    openGlobalSurface,
    openSurfaceId,
    setSidebarSection,
  ])
}
