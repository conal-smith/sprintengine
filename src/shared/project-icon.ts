import { isProjectColor } from './project-hue'

// A project's icon, when the person chose one: a file of theirs, or a
// monogram (one or two characters on a hue). Absent means "detected": the
// repo's own logo when it has one, else the folder glyph. The override wins
// over detection, because choosing one is the whole point of having it.
//
// Keyed by the project's folder (`normalizeFolderKey`), not by its repository
// like the colour is: a file path is this disk's, so it cannot follow the
// repository to another machine's clone.

export type ProjectIconSetting =
  | { kind: 'file'; path: string }
  | {
      kind: 'monogram'
      /** One or two characters, as shown. */
      text: string
      /** An OKLCH hue in degrees, worn at the project-mark lightness and chroma. */
      hue: number
    }

export const PROJECT_MONOGRAM_MAX_CHARS = 2

/** The characters a monogram shows: the first two, upper-cased, whitespace dropped. */
export function normalizeMonogramText(text: string): string {
  return Array.from(text.replace(/\s+/gu, '')).slice(0, PROJECT_MONOGRAM_MAX_CHARS).join('').toLocaleUpperCase('en-US')
}

/**
 * The monogram a project starts from, from its name: the initials of its first
 * two words (`my-app` → `MA`), or its first letter when it is one word. Pure
 * and deterministic, so a project's suggestion is the same every time.
 */
export function suggestedMonogram(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter(Boolean)
  if (words.length === 0) return '?'
  const initials = words.length === 1 ? Array.from(words[0])[0] : words.map((word) => Array.from(word)[0]).join('')
  return normalizeMonogramText(initials)
}

export function isProjectIconSetting(value: unknown): value is ProjectIconSetting {
  if (!value || typeof value !== 'object') return false
  const setting = value as Record<string, unknown>
  if (setting.kind === 'file') return typeof setting.path === 'string' && setting.path.trim() !== ''
  if (setting.kind === 'monogram') {
    return (
      typeof setting.text === 'string' &&
      setting.text !== '' &&
      normalizeMonogramText(setting.text) === setting.text &&
      isProjectColor(setting.hue)
    )
  }
  return false
}

/** The stored overrides, with anything malformed dropped. */
export function normalizeProjectIcons(value: unknown): Record<string, ProjectIconSetting> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, ProjectIconSetting> = {}
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || !isProjectIconSetting(setting)) continue
    out[key] = setting.kind === 'file' ? { kind: 'file', path: setting.path } : { ...setting }
  }
  return out
}
