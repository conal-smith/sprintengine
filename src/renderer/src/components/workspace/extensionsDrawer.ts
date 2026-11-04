import type { RegisteredGlobalSurface } from '../../modules/renderer-host'

// What the Extensions drawer IS, as data (Extensions drawer ruling, 2026-09-05).
//
// THREE built-in rows, in a fixed order the owner ruled:
//
//   Design · Plugins · Skills
//
// (Agent CLIs was a fourth until 2026-09-25, when the owner moved them to
// Settings ▸ Agents: that list already showed every CLI per machine with its
// install and update, and two lists of one thing drift.)
//
// Installed module doors follow these three in stable registry order; the
// renderer-side resolver owns those because this file is deliberately a pure
// leaf with no live registry. Registry `order` does not reorder the built-ins.
// The earlier cut sorted doors and modal
// surfaces together by their declared `order`, which meant the column a person
// reads top to bottom was arranged by whichever numbers modules happened to
// claim, and any module registered later could push Design down it. The order
// of the product's parts is a ruling; the list below is that ruling, and each
// entry names only WHERE its row comes from — the owning module still supplies
// the label, the glyph and what opening the row does.
//
// A leaf: pure data plus two predicates, no React and no store, so the drawer
// that RENDERS the rows (ExtensionsRail) and the store action that has to know
// which surfaces BELONG to the drawer (settingsSlice.openGlobalSurface) can
// share one answer instead of keeping two lists that drift.

/**
 * The Extensions home — the surface the app rail's Extensions glyph opens.
 * Core, not a module's: it is where the product's own parts are offered, so no
 * module toggle may take it away (renderer-host reserves the id).
 */
export const EXTENSIONS_HOME_SURFACE_ID = 'extensions-home'

/**
 * The Plugins and Skills catalogue: the one surface the drawer's Plugins and
 * Skills rows are views of. Registered as a door by the agent runtime module,
 * but it opens as a MODAL over whatever owns the card region (owner ruling
 * 2026-11-03), the way Settings does — choosing an extension is a
 * pick-and-close task over work that stays put, and a takeover of the card
 * region was a heavy way in for it. `openGlobalSurface` routes the id there.
 */
export const EXTENSIONS_CATALOGUE_SURFACE_ID = 'extensions'

// Where a row comes from. Three kinds, because the registry has three shapes of
// contribution and the drawer must not flatten them into one hand-written list
// of components:
//   nav     — a module's `registerSidebarNavEntry` row, which owns its own
//             status dot and open behaviour.
//   surface — a module's door, one row for the whole surface (Design).
//   view    — one of a door's registered `views` (renderer-host): the single
//             `extensions` surface is Plugins and Skills to the person, so it
//             contributes two rows, each with its own label, glyph and way of
//             landing the surface on it.
export type DrawerRow =
  | { kind: 'nav'; rowId: ExtensionsDrawerRowId; entryId: string }
  | { kind: 'surface'; rowId: ExtensionsDrawerRowId; surfaceId: string }
  | { kind: 'view'; rowId: ExtensionsDrawerRowId; surfaceId: string; viewId: string }

/**
 * A row's own name, stable across what it resolves to. Two things address a row
 * by it: the unread count each row wears (`useExtensionsRowBadges`), and a bell
 * notification's `extensionsRow`, which says which row a piece of news belongs
 * to. Neither is a surface id — Plugins and Skills are two rows of ONE surface,
 * and a count keyed on the surface would light both.
 */
export type ExtensionsDrawerRowId = 'design' | 'plugins' | 'skills'

export const DRAWER_ROWS: readonly DrawerRow[] = [
  { kind: 'surface', rowId: 'design', surfaceId: 'design' },
  { kind: 'view', rowId: 'plugins', surfaceId: 'extensions', viewId: 'plugins' },
  { kind: 'view', rowId: 'skills', surfaceId: 'extensions', viewId: 'skills' },
]

export const EXTENSIONS_DRAWER_ROW_IDS: readonly ExtensionsDrawerRowId[] = DRAWER_ROWS.map((row) => row.rowId)

export function isExtensionsDrawerRowId(value: unknown): value is ExtensionsDrawerRowId {
  return typeof value === 'string' && (EXTENSIONS_DRAWER_ROW_IDS as readonly string[]).includes(value)
}

/**
 * The installed doors' rows, by row id, with the module that owns each. An
 * installed door's row id IS its surface id — the same id its module's
 * `registerDoorBadge({ rowId })` names and its `notify` rows `target` — so
 * a count, a piece of news and a selection all address one row without a
 * second vocabulary. Empty until the live registry resolves (the drawer rows
 * hook builds it); the fixed rows above are never in it.
 */
export type InstalledDoorRows = ReadonlyMap<string, string>

const NO_INSTALLED_DOOR_ROWS: InstalledDoorRows = new Map()

/**
 * Which row the card region is showing, from the open surface and — for the
 * rows that are views of one surface — the view it stands on. Null while
 * no drawer row is open (the home, a chat, a surface that is not a row). This is what "opening a row" means to the row's unread count: the
 * moment its page is on screen, its news has been seen.
 */
export function openExtensionsDrawerRow(
  activeGlobalSurface: string | null,
  activeView: string | null,
  installedDoorRows: InstalledDoorRows = NO_INSTALLED_DOOR_ROWS,
): string | null {
  if (!activeGlobalSurface) return null
  for (const row of DRAWER_ROWS) {
    if (row.kind === 'nav' && row.entryId === activeGlobalSurface) return row.rowId
    if (row.kind === 'surface' && row.surfaceId === activeGlobalSurface) return row.rowId
    if (row.kind === 'view' && row.surfaceId === activeGlobalSurface && row.viewId === activeView) return row.rowId
  }
  // An installed door is one row to its count, whichever of its views is up:
  // the row id is the surface id.
  return installedDoorRows.has(activeGlobalSurface) ? activeGlobalSurface : null
}

/**
 * The surfaces that live UNDER the Extensions glyph: the home the glyph opens,
 * plus every surface the drawer's rows lead to. Opening one of these is a move
 * inside the Extensions section, so the rail glyph follows it and leaving lands
 * back on the drawer rather than on the workspaces tree.
 *
 * A surface that stands on the app rail is deliberately absent: it is what the
 * product DOES rather than something added to it, so opening it must not drag
 * the sidebar into a section it does not belong to.
 */
export const EXTENSIONS_DRAWER_SURFACE_IDS: readonly string[] = [
  ...new Set([
    EXTENSIONS_HOME_SURFACE_ID,
    // A nav row's entry id IS its surface id — that pairing is the door contract
    // (`registerSidebarNavEntry` + `registerGlobalSurface` under one id), so a
    // module's nav row belongs here without a second list naming it.
    // Deduplicated because two of the three rows are two VIEWS of one
    // surface.
    ...DRAWER_ROWS.map((row) => (row.kind === 'nav' ? row.entryId : row.surfaceId)),
  ]),
]

/** Whether opening this surface is a move inside the Extensions section. */
export function isExtensionsDrawerSurface(surfaceId: string): boolean {
  return EXTENSIONS_DRAWER_SURFACE_IDS.includes(surfaceId)
}

/**
 * Whether this door's rail REPLACES the sidebar column (the context-rail swap,
 * item 1993) or renders beside its own canvas.
 *
 * Default `sidebar`, which is what every door did before the drawer ruling. A
 * door that is itself a row of the drawer declares `inline`: the drawer is the
 * navigation that reached it and must stay put while the card region swaps, so
 * taking the column would delete the column the person is navigating with.
 * A module door whose rail is a list of its own still swaps.
 */
export function surfaceTakesSidebarColumn(
  surface: Pick<RegisteredGlobalSurface, 'railPlacement'> | null | undefined,
): boolean {
  return (surface?.railPlacement ?? 'sidebar') === 'sidebar'
}
