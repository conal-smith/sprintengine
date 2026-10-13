import { cssFontFamilyList } from './fontFamilyPreference'

// The font families installed on this computer, for the pickers in Settings ▸
// Appearance, and two questions a picker asks about one of them.
//
// The list comes from the Local Font Access API (`window.queryLocalFonts`),
// which Electron answers once main grants `local-fonts`
// (src/main/app-window-permissions.ts). Reading it walks every face on the
// machine, so it is read lazily — the first time a picker opens, never at boot
// — and at most once a session: a granted list is kept, and every picker after
// the first reads the same promise.

export type InstalledFontFamilies =
  | { status: 'granted'; families: readonly string[] }
  /** No API (a browser without it), or the permission was refused. Names are typed instead. */
  | { status: 'unavailable' }

type LocalFontData = { readonly family: string }
type QueryLocalFonts = () => Promise<readonly LocalFontData[]>

let installed: Promise<InstalledFontFamilies> | null = null

/** The installed families, sorted and de-duplicated; null-safe in every engine. */
export function loadInstalledFontFamilies(): Promise<InstalledFontFamilies> {
  if (installed) return installed
  const pending = readInstalledFontFamilies()
  installed = pending
  // A refusal is not kept: in a browser tab the person can still allow it, and
  // the next open asks again. A granted list does not change in a session that
  // matters for this.
  void pending.then((result) => {
    if (result.status !== 'granted' && installed === pending) installed = null
  })
  return pending
}

async function readInstalledFontFamilies(): Promise<InstalledFontFamilies> {
  const query =
    typeof window === 'undefined' ? undefined : (window as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts
  if (typeof query !== 'function') return { status: 'unavailable' }
  try {
    const fonts = await query.call(window)
    const families = familyNamesOf(fonts)
    // A refused permission can resolve with an empty list rather than throw,
    // and no machine has no fonts at all.
    return families.length > 0 ? { status: 'granted', families } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * One name per family, sorted the way a person reads them. A face per style
 * arrives (Regular, Bold, Italic…), so a family appears many times. A family
 * whose name starts with a dot is one of macOS's private system faces: it
 * cannot be asked for by name, so offering it would offer nothing.
 */
export function familyNamesOf(fonts: readonly LocalFontData[]): string[] {
  const names = new Set<string>()
  for (const font of fonts) {
    const family = font.family.trim()
    if (family.length > 0 && !family.startsWith('.')) names.add(family)
  }
  return [...names].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
}

/** The families whose name holds the query, ignoring case; every family for an empty query. */
export function filterFontFamilies(families: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return families
  return families.filter((family) => family.toLocaleLowerCase().includes(needle))
}

// ── Probes ─────────────────────────────────────────────────────────────────
//
// Both measure text on a canvas. `document.fonts.check` cannot answer either:
// it says true for a family that is not installed at all, because there is
// nothing to load. Where there is no canvas to measure on, both answer yes, so
// a missing canvas never refuses a real font.

let probeContext: CanvasRenderingContext2D | null | undefined
const monospaceAnswers = new Map<string, boolean>()

function probe(): CanvasRenderingContext2D | null {
  if (probeContext === undefined) {
    try {
      probeContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    } catch {
      probeContext = null
    }
  }
  return probeContext
}

const AVAILABILITY_TEXT = 'mmmmmmmmMMWli1O0@# fjord'

/**
 * Whether a family is installed: drawn with a generic family behind it, it
 * measures differently from the generic alone under at least one of three.
 */
export function isFontFamilyAvailable(family: string): boolean {
  const list = cssFontFamilyList(family)
  if (list === null) return false
  const context = probe()
  if (!context) return true
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    context.font = `16px ${generic}`
    const baseline = context.measureText(AVAILABILITY_TEXT).width
    context.font = `16px ${list}, ${generic}`
    if (context.measureText(AVAILABILITY_TEXT).width !== baseline) return true
  }
  return false
}

const MONOSPACE_GLYPHS = ['i', 'M', 'W', '0', '@', '.', ' '] as const

/**
 * Whether a family draws every character on the same advance — what a
 * terminal's cell grid and an editor's columns need. A family that is not
 * installed falls back to the generic monospace and answers yes, leaving it to
 * the normal fallback. Answers are kept for the session.
 */
export function isMonospaceFamily(family: string): boolean {
  const list = cssFontFamilyList(family)
  if (list === null) return true
  const known = monospaceAnswers.get(list)
  if (known !== undefined) return known
  const context = probe()
  if (!context) return true
  context.font = `32px ${list}, monospace`
  const advances = MONOSPACE_GLYPHS.map((glyph) => context.measureText(glyph).width)
  const answer = advancesAreEqual(advances)
  monospaceAnswers.set(list, answer)
  return answer
}

/** Whether every advance matches the first, within a hundredth of a pixel. Unmeasurable is yes. */
export function advancesAreEqual(advances: readonly number[]): boolean {
  const first = advances[0]
  if (first === undefined || !(first > 0) || advances.some((advance) => !Number.isFinite(advance) || advance <= 0)) {
    return true
  }
  return advances.every((advance) => Math.abs(advance - first) < 0.01)
}
