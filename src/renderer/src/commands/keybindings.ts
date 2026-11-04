export type KeybindingPlatform = 'darwin' | 'windows' | 'linux'

type KeybindingModifier = 'primary' | 'ctrl' | 'alt' | 'shift' | 'meta'

export type KeybindingStroke = {
  modifiers: readonly KeybindingModifier[]
  key: string
}

export type KeybindingChord = {
  strokes: readonly KeybindingStroke[]
  canonical: string
}

export type ParsedKeybinding = { ok: true; chord: KeybindingChord } | { ok: false; error: string }

const MODIFIER_ALIASES: Record<string, KeybindingModifier> = {
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  option: 'alt',
  opt: 'alt',
  alt: 'alt',
  shift: 'shift',
  primary: 'primary',
  mod: 'primary',
  cmdorctrl: 'primary',
  commandorcontrol: 'primary',
}

const MODIFIER_ORDER: readonly KeybindingModifier[] = ['primary', 'ctrl', 'alt', 'shift', 'meta']

// The modifiers that can stand as a stroke's KEY rather than decorate it —
// Search Everywhere's `Shift Shift` is two strokes whose key is the Shift key
// itself. `primary` is deliberately absent: it is the abstract
// "Cmd here, Ctrl there" modifier, not a physical key anyone can tap.
const MODIFIER_KEYS: readonly KeybindingModifier[] = ['ctrl', 'alt', 'shift', 'meta']

/**
 * Whether a stroke's key token is a modifier key pressed on its own (`shift`),
 * as opposed to an ordinary key. Exported because the dispatcher has to treat
 * such a stroke as a TAP rather than as a normal keystroke, and the display
 * helpers render it with the modifier's own label.
 */
export function isModifierKeyToken(key: string): boolean {
  return (MODIFIER_KEYS as readonly string[]).includes(key)
}
const DISPLAY_MODIFIER: Record<KeybindingModifier, string> = {
  primary: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Cmd',
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  plus: '+',
  comma: ',',
  period: '.',
  dot: '.',
  slash: '/',
  backslash: '\\',
  quote: "'",
  apostrophe: "'",
  backquote: '`',
  grave: '`',
  minus: '-',
  dash: '-',
  equal: '=',
  equals: '=',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  pageup: 'pageup',
  pagedown: 'pagedown',
}

const DISPLAY_KEY: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  backspace: 'Backspace',
  delete: 'Delete',
  enter: 'Enter',
  escape: 'Esc',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
  tab: 'Tab',
  '+': '+',
  '`': '`',
  "'": "'",
  '\\': '\\',
}

function splitStroke(input: string): string[] {
  const parts = input.split('+')
  const tokens = parts.map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1 && parts.at(-1)?.trim() === '') tokens.push('+')
  return tokens
}

function normalizeKeyToken(token: string): string {
  const compact = token.trim().toLowerCase().replace(/\s+/g, '')
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(compact)) return compact
  if (/^digit[0-9]$/.test(compact)) return compact.slice('digit'.length)
  if (/^key[a-z]$/.test(compact)) return compact.slice('key'.length)
  return KEY_ALIASES[compact] ?? compact
}

export function parseKeybinding(input: string): ParsedKeybinding {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'Keybinding is empty.' }

  let rawStrokes = raw
    .split(/\s+then\s+|,\s+|\s{2,}/i)
    .map((stroke) => stroke.trim())
    .filter(Boolean)
  if (rawStrokes.length === 1 && /\s/.test(raw) && !raw.includes('+')) {
    const canonicalLikeStrokes = raw
      .split(/\s+/)
      .map((stroke) => stroke.trim())
      .filter(Boolean)
    if (canonicalLikeStrokes.length > 1) rawStrokes = canonicalLikeStrokes
  }
  if (rawStrokes.length === 0) return { ok: false, error: 'Keybinding is empty.' }
  if (rawStrokes.length > 2) return { ok: false, error: 'Only one or two-stroke chords are supported.' }

  const strokes: KeybindingStroke[] = []
  for (const rawStroke of rawStrokes) {
    const tokens = splitStroke(rawStroke)
    if (tokens.length === 0) return { ok: false, error: 'Stroke is empty.' }

    // A stroke that is nothing BUT a modifier name is legal: the modifier is
    // the key. That is what makes `Shift Shift` expressible. Only as the whole
    // stroke, though — `Ctrl+Shift` is still a chord missing its key — and
    // only as a double tap, which the check after the loop enforces.
    if (tokens.length === 1) {
      const only = MODIFIER_ALIASES[tokens[0].toLowerCase().replace(/\s+/g, '')]
      if (only && MODIFIER_KEYS.includes(only)) {
        strokes.push({ modifiers: [], key: only })
        continue
      }
    }

    const modifiers = new Set<KeybindingModifier>()
    let key: string | null = null
    for (const token of tokens) {
      const compact = token.toLowerCase().replace(/\s+/g, '')
      const modifier = MODIFIER_ALIASES[compact]
      if (modifier) {
        modifiers.add(modifier)
        continue
      }
      if (key !== null) return { ok: false, error: `Stroke "${rawStroke}" has more than one key.` }
      key = normalizeKeyToken(token)
    }

    if (key === null) return { ok: false, error: `Stroke "${rawStroke}" is missing a key.` }
    if (MODIFIER_ALIASES[key]) return { ok: false, error: `Stroke "${rawStroke}" is missing a key.` }
    if (
      key.length !== 1 &&
      !/^(?:f(?:[1-9]|1[0-9]|2[0-4])|arrow(?:left|right|up|down)|backspace|delete|enter|escape|home|end|pageup|pagedown|space|tab)$/.test(
        key,
      )
    ) {
      return { ok: false, error: `Unsupported key "${key}".` }
    }

    const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
    strokes.push({ modifiers: orderedModifiers, key })
  }

  // A lone modifier binds ONLY as a double tap of the same modifier, because
  // that is the one shape the dispatcher can fire: a single Shift is never a
  // stroke, `Shift Ctrl` is two different taps, and a lone modifier as the
  // second stroke of an ordinary chord (`Primary+K then Shift`) would swallow
  // its first stroke as a pending chord whose completion never arrives. Ruling
  // it out here keeps the recorder from saving a one-stroke `meta` when Super
  // or AltGraph is pressed, and the menu from being handed "shift" as an
  // accelerator.
  const loneModifierStrokes = strokes.filter((stroke) => isModifierKeyToken(stroke.key)).length
  if (
    loneModifierStrokes > 0 &&
    !(strokes.length === 2 && loneModifierStrokes === 2 && strokes[0].key === strokes[1].key)
  ) {
    return {
      ok: false,
      error: 'A modifier on its own only binds as a double tap of the same modifier, e.g. "Shift Shift".',
    }
  }

  const canonical = strokes.map((stroke) => [...stroke.modifiers, stroke.key].join('+')).join(' ')
  return { ok: true, chord: { strokes, canonical } }
}

export function normalizeKeybinding(input: string): string | null {
  const parsed = parseKeybinding(input)
  return parsed.ok ? parsed.chord.canonical : null
}

export function collapseDuplicateKeybindings(keybindings: readonly string[]): string[] {
  const seen = new Set<string>()
  const collapsed: string[] = []
  for (const keybinding of keybindings) {
    const canonical = normalizeKeybinding(keybinding)
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    collapsed.push(canonical)
  }
  return collapsed
}

// On macOS a shortcut is drawn in the keyboard's own glyphs, as the menu bar
// and every Mac app draw it: "⌘⇧F", not "Cmd+Shift+F" (2026-11-04). The worded
// form read as a Windows label on a Mac, and the model picker beside it already
// drew "⌘1", so one product spelled the same key two ways.
const DARWIN_MODIFIER: Record<KeybindingModifier, string> = {
  primary: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
}

function renderModifier(modifier: KeybindingModifier, platform: KeybindingPlatform): string {
  if (platform === 'darwin') return DARWIN_MODIFIER[modifier]
  if (modifier === 'primary') return 'Ctrl'
  return DISPLAY_MODIFIER[modifier]
}

// The keys a Mac draws as glyphs too. Escape and Space keep their words: their
// glyphs (⎋, ␣) are ones most people do not recognise.
const DARWIN_KEY: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  backspace: '⌫',
  delete: '⌦',
  // design-tokens-allow: a keyboard glyph, not an emoji — ↩ is Return in every Mac menu
  enter: '↩',
  tab: '⇥',
}

function renderStrokeKeys(stroke: KeybindingStroke, platform: KeybindingPlatform): string[] {
  // A modifier standing as the key wears the modifier's own label ("Shift",
  // "⇧"), not the raw token uppercased ("SHIFT").
  const keyLabel = isModifierKeyToken(stroke.key)
    ? renderModifier(stroke.key as KeybindingModifier, platform)
    : ((platform === 'darwin' ? DARWIN_KEY[stroke.key] : undefined) ??
      DISPLAY_KEY[stroke.key] ??
      stroke.key.toUpperCase())
  return [...stroke.modifiers.map((modifier) => renderModifier(modifier, platform)), keyLabel]
}

/**
 * A chord made only of lone-modifier taps — `Shift Shift`. Its strokes are not
 * a sequence a person performs one after the other but one gesture (a double
 * tap), so callers join them with a space rather than the two-stroke "then".
 */
export function isModifierTapChord(input: string | KeybindingChord): boolean {
  const parsed = typeof input === 'string' ? parseKeybinding(input) : { ok: true as const, chord: input }
  if (!parsed.ok) return false
  const strokes = parsed.chord.strokes
  return (
    strokes.length > 1 && strokes.every((stroke) => stroke.modifiers.length === 0 && isModifierKeyToken(stroke.key))
  )
}

export function renderKeybinding(input: string | KeybindingChord, platform: KeybindingPlatform = 'linux'): string {
  const chord = typeof input === 'string' ? parseKeybinding(input) : { ok: true as const, chord: input }
  if (!chord.ok) return input as string
  // Glyphs sit together on a Mac ("⌘⇧F"); words need the "+" between them.
  return chord.chord.strokes
    .map((stroke) => renderStrokeKeys(stroke, platform).join(platform === 'darwin' ? '' : '+'))
    .join(isModifierTapChord(chord.chord) ? ' ' : ' then ')
}

const GLYPH_WORDS: Record<string, string> = {
  '⌘': 'cmd command',
  '⌃': 'ctrl control',
  '⌥': 'option alt',
  '⇧': 'shift',
  // design-tokens-allow: a keyboard glyph, not an emoji — ↩ is Return in every Mac menu
  '↩': 'enter return',
  '⌫': 'backspace',
  '⌦': 'delete',
  '⇥': 'tab',
  '←': 'left',
  '→': 'right',
  '↑': 'up',
  '↓': 'down',
}

/**
 * A rendered shortcut with its glyphs also spelled out, for search: a person
 * looking for every Command shortcut types "cmd", not "⌘".
 */
export function keybindingSearchText(input: string | KeybindingChord, platform: KeybindingPlatform = 'linux'): string {
  const rendered = renderKeybinding(input, platform)
  const words = [...rendered].map((char) => GLYPH_WORDS[char]).filter(Boolean)
  return words.length > 0 ? `${rendered} ${words.join(' ')}` : rendered
}

export function keybindingToKbdKeys(
  input: string | KeybindingChord,
  platform: KeybindingPlatform = 'linux',
): string[][] {
  const chord = typeof input === 'string' ? parseKeybinding(input) : { ok: true as const, chord: input }
  if (!chord.ok) return []
  return chord.chord.strokes.map((stroke) => renderStrokeKeys(stroke, platform))
}

// Persisted keybinding overrides / disabled flags are keyed by command id.
// When a command's id migrates (e.g. a shell command moving onto its own
// module), the user's persisted settings keep working through this map. Keys
// are the CURRENT ids, values the legacy ids they replaced; every read of
// persisted keybinding state consults it. Aliases for commands that no longer
// exist are dropped: an override keyed by a retired id is simply ignored, and
// the Keyboard Shortcuts tab prunes it (RETIRED_COMMAND_IDS). Empty today: the
// last alias went with voice dictation (2026-10-09).
export const LEGACY_COMMAND_ID_ALIASES: Record<string, string> = {}
