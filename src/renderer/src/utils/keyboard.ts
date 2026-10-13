// Shared keyboard-handling helpers. Extracted per the brand panel-design
// system note: keyboard guards used by three or more panels graduate from
// per-panel duplicates to a shared util.

/**
 * Returns true when the target is an editable element where keyboard
 * shortcuts should NOT fire (text inputs, textareas, selects, or
 * contentEditable nodes). Pattern is identical across every panel that
 * wires a `j`/`k`/arrow handler at the section level — the guard prevents
 * shortcuts from stealing focus while the user is typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

export function isGlobalShortcutSuppressedTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (isEditableTarget(target)) return true
  if (target.closest('.monaco-editor')) return true
  if (target.closest('.xterm')) return true
  // A surface that owns its own chords (the model picker's ⌘1–9 jumps) marks
  // itself so the shell treats focus inside it like an editable target: only
  // commands that allow editable targets still fire there.
  if (target.closest('[data-suppress-shortcuts]')) return true
  return false
}

/**
 * The marker a terminal pane puts on its outer element so the shell can tell
 * that a keystroke came from inside one.
 *
 * `.xterm` alone is not enough: the pane's own chrome — the find bar — sits
 * outside xterm's element but inside the surface, and a key pressed there is
 * still a key pressed in the terminal.
 */
export const TERMINAL_SURFACE_ATTRIBUTE = 'data-terminal-surface'

/**
 * Whether a keystroke originated inside a terminal pane.
 *
 * This is what makes the `terminal` command scope real. The scope has been
 * declared (and paired with `editor` as mutually exclusive) since the
 * keybinding system was built, but nothing activated it, so a command scoped to
 * it could never fire. Deriving it from the EVENT rather than from which tab is
 * active is what keeps ⌘F in a Monaco editor as Monaco's find: the shell never
 * claims the key unless the key came from a terminal.
 */
export function isTerminalKeyTarget(target: EventTarget | null | undefined): boolean {
  // Duck-typed for the same reason as `isTerminalChromeTarget` below.
  const element = target as { closest?: (selector: string) => unknown } | null | undefined
  if (!element || typeof element.closest !== 'function') return false
  return element.closest(`.xterm, [${TERMINAL_SURFACE_ATTRIBUTE}]`) != null
}

/**
 * The marker a pane's own chrome puts on itself — today the find bar.
 *
 * A terminal pane installs NATIVE listeners on its container (mousedown,
 * mouseup, click, keydown, copy, paste, contextmenu) that focus the terminal
 * and route the clipboard. React's handlers cannot stop those: React attaches
 * at the tree root, so a native listener on an element between the target and
 * the root has already run by the time a synthetic `stopPropagation()` is
 * reached. Chrome that lives INSIDE the container therefore has to be
 * recognised rather than shielded, and this attribute is how.
 */
export const TERMINAL_CHROME_ATTRIBUTE = 'data-terminal-chrome'

/**
 * Whether an event came from a pane's own chrome rather than from its terminal.
 *
 * Duck-typed rather than `instanceof HTMLElement`: this runs inside the
 * clipboard handlers, which are unit-tested against a bare Node event target
 * where the DOM constructor does not exist at all — and `instanceof` against an
 * undefined global is a ReferenceError, not a false.
 */
export function isTerminalChromeTarget(target: EventTarget | null | undefined): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null | undefined
  if (!element || typeof element.closest !== 'function') return false
  return element.closest(`[${TERMINAL_CHROME_ATTRIBUTE}]`) != null
}

/**
 * Whether a keydown is the given letter's key: by the character it typed, or
 * by where the key sits.
 *
 * On a layout whose letters are not Latin — Russian, Greek, Ukrainian — the
 * key marked S types `ы` or `σ`, so `event.key` never says `s` and a ⌘S that
 * read only the character did nothing at all. `event.code` names the physical
 * key whatever the layout prints on it, and is read only when the key typed no
 * Latin letter: on AZERTY the key in A's place types `q`, and is Q.
 */
export function isLetterKey(event: { key: string; code: string }, letter: string): boolean {
  const key = event.key.toLowerCase()
  if (/^[a-z]$/u.test(key)) return key === letter
  return event.code === `Key${letter.toUpperCase()}`
}
