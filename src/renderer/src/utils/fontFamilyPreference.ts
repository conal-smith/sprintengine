// A font family chosen in Settings ▸ Appearance, as it is stored and as it is
// written into CSS.
//
// The value is free text — the picker offers the installed families, but where
// the system will not list them (or the face is one it did not list) a name is
// typed — and it ends up inside a custom property on <html>. So it is cleaned
// twice over: on the way into the store, and again on the way into CSS, where
// every name that is not a generic keyword is wrapped in double quotes. With
// the quote, the backslash and the control characters gone, nothing inside
// those quotes can end the string, and with `;`, `{`, `}`, `<` and `>` gone
// nothing outside them can end the declaration either. No real family name
// uses any of them.

/** The longest stored value. A family list longer than this is not a family list. */
export const FONT_FAMILY_PREFERENCE_MAX_LENGTH = 200

const UNSAFE_CHARACTERS = /[;{}<>"'`\\\u0000-\u001f\u007f]/gu

// The generic families keep their meaning only unquoted: `"monospace"` names a
// font called monospace, which no machine has.
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])

/**
 * A stored family as the store keeps it: unsafe characters dropped, runs of
 * white space folded, trimmed, and capped. Anything that is not a string is
 * the empty string, which means the default face.
 */
export function normalizeFontFamilyPreference(value: unknown): string {
  if (typeof value !== 'string') return ''
  // White space first, so a tab or a line break reads as the space it stood
  // for rather than vanishing with the other control characters.
  return value
    .replace(/\s+/gu, ' ')
    .replace(UNSAFE_CHARACTERS, '')
    .replace(/ {2,}/gu, ' ')
    .trim()
    .slice(0, FONT_FAMILY_PREFERENCE_MAX_LENGTH)
    .trim()
}

/**
 * The preference as a CSS `font-family` list — each name quoted, a generic
 * keyword left bare — or null when it names nothing, which means the default.
 * A comma-separated preference is a list of its own, in the order typed.
 */
export function cssFontFamilyList(preference: string): string | null {
  const names = normalizeFontFamilyPreference(preference)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`))
  return names.length > 0 ? names.join(', ') : null
}

/**
 * The stack a preference resolves to: the chosen families first, then the
 * whole default stack, so a face missing a glyph (or missing altogether) falls
 * back to the bundled one rather than to whatever the platform picks.
 */
export function fontStackFor(preference: string, defaultStack: string): string {
  const list = cssFontFamilyList(preference)
  return list === null ? defaultStack : `${list}, ${defaultStack}`
}
