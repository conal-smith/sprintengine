import { normalizeFontFamilyPreference } from '../../utils/fontFamilyPreference'
import { filterFontFamilies } from '../../utils/localFonts'

/**
 * One row of a font picker's list.
 *
 * - `default` — the bundled face; picking it stores the empty string.
 * - `family` — an installed family the system listed.
 * - `typed` — the query itself, for a family the list does not hold: the
 *   system would not list its fonts (a browser tab that was refused, an engine
 *   without the API), or the face is one it did not list. Always last, so the
 *   arrow keys reach every listed family first.
 */
export type FontPickerOption =
  | { key: string; kind: 'default' }
  | { key: string; kind: 'family'; family: string }
  | { key: string; kind: 'typed'; family: string }

export const DEFAULT_FONT_OPTION_KEY = 'default'

/**
 * The rows a picker shows for a query: Default while nothing is typed, the
 * installed families whose name holds the query, and the typed name when no
 * listed family is exactly it.
 */
export function fontPickerOptions(families: readonly string[], query: string): FontPickerOption[] {
  const typed = normalizeFontFamilyPreference(query)
  const options: FontPickerOption[] = []
  if (typed.length === 0) options.push({ key: DEFAULT_FONT_OPTION_KEY, kind: 'default' })
  for (const family of filterFontFamilies(families, typed)) {
    options.push({ key: `family:${family}`, kind: 'family', family })
  }
  const listed = typed.length > 0 && families.some((family) => family.toLocaleLowerCase() === typed.toLocaleLowerCase())
  if (typed.length > 0 && !listed) options.push({ key: `typed:${typed}`, kind: 'typed', family: typed })
  return options
}

/** The key of the row that holds the stored value, for the check mark and the first highlight. */
export function selectedFontOptionKey(value: string): string {
  const stored = normalizeFontFamilyPreference(value)
  return stored.length === 0 ? DEFAULT_FONT_OPTION_KEY : `family:${stored}`
}
