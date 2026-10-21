import { useSyncExternalStore } from 'react'

import { parseKeybinding, type KeybindingPlatform } from '../../../commands/keybindings'

// The number keys' hints: while the modifier of Primary+1…9 is held on its own
// for a moment, each of the first nine numbered chat rows shows the chord that
// opens it. Pressing one of the chords (or any other key) puts them away, so a
// ⌘C or a ⌘K never flashes the list.
//
// Everything here is pure or a tiny store; the listener that drives it is
// `useChatJumpHints` (WorkspaceSidebar), one for the whole sidebar.

/** How long the modifier is held alone before the hints show. A chord typed at speed never sees them. */
export const CHAT_JUMP_HINT_DELAY_MS = 200

/** The command each of the first nine numbered rows answers to, top to bottom. */
export const CHAT_JUMP_COMMAND_IDS: readonly string[] = Array.from(
  { length: 9 },
  (_, index) => `workspace.switch.${index + 1}`,
)

/** Which modifier keys are down, as a keyboard event reports them. */
export type HeldModifiers = { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }

export type HintKeyEvent = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const MODIFIER_KEY_NAMES: ReadonlySet<string> = new Set(['Control', 'Meta', 'Alt', 'Shift', 'OS', 'AltGraph'])

function heldModifiers(event: HintKeyEvent): HeldModifiers {
  return { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }
}

function sameModifiers(left: HeldModifiers, right: HeldModifiers): boolean {
  return left.ctrl === right.ctrl && left.meta === right.meta && left.alt === right.alt && left.shift === right.shift
}

const anyHeld = (held: HeldModifiers): boolean => held.ctrl || held.meta || held.alt || held.shift

/**
 * The modifier sets that announce the number keys: the modifiers of each
 * chat-switch binding in force, resolved for this platform — ⌘ on macOS and
 * Ctrl elsewhere for the default Primary. A binding rebound to Alt+1 is
 * announced by holding Alt; one with no modifier, a second stroke, or none at
 * all announces nothing, since holding a key cannot be the start of it.
 */
export function chatJumpTriggerModifiers(
  bindings: readonly (string | null)[],
  platform: KeybindingPlatform,
): HeldModifiers[] {
  const triggers: HeldModifiers[] = []
  for (const binding of bindings) {
    if (!binding) continue
    const parsed = parseKeybinding(binding)
    if (!parsed.ok || parsed.chord.strokes.length !== 1) continue
    const modifiers = parsed.chord.strokes[0]!.modifiers
    const held: HeldModifiers = {
      ctrl: modifiers.includes('ctrl') || (modifiers.includes('primary') && platform !== 'darwin'),
      meta: modifiers.includes('meta') || (modifiers.includes('primary') && platform === 'darwin'),
      alt: modifiers.includes('alt'),
      shift: modifiers.includes('shift'),
    }
    if (anyHeld(held) && !triggers.some((trigger) => sameModifiers(trigger, held))) triggers.push(held)
  }
  return triggers
}

/**
 * The hints' state machine.
 *
 * - `idle` — nothing held that announces the number keys.
 * - `arming` — the trigger modifiers are held alone; the timer is running.
 * - `visible` — they have been held long enough; the hints are up.
 * - `spoiled` — another key went down while they were held. The hints stay
 *   away until every modifier is let go, so ⌘C, ⌘K, or ⌘1 itself never brings
 *   them back while ⌘ is still down.
 *
 * Only a change between hidden and shown reaches `onVisibleChange`, so a held
 * modifier's key repeat costs nothing past this object.
 */
export type ChatJumpHintController = {
  keyDown: (event: HintKeyEvent) => void
  keyUp: (event: HintKeyEvent) => void
  /** The window lost focus or was hidden: the keyup may never arrive. */
  cancel: () => void
  dispose: () => void
}

export function createChatJumpHintController({
  delayMs = CHAT_JUMP_HINT_DELAY_MS,
  triggers,
  onVisibleChange,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: {
  delayMs?: number
  /** Read when a modifier goes down, so a rebinding takes effect at once. */
  triggers: () => readonly HeldModifiers[]
  onVisibleChange: (visible: boolean) => void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): ChatJumpHintController {
  let state: 'idle' | 'arming' | 'visible' | 'spoiled' = 'idle'
  let timer: unknown = null

  const stopTimer = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }
  const settle = (next: 'idle' | 'spoiled'): void => {
    stopTimer()
    const wasVisible = state === 'visible'
    state = next
    if (wasVisible) onVisibleChange(false)
  }

  return {
    keyDown(event) {
      const held = heldModifiers(event)
      if (!MODIFIER_KEY_NAMES.has(event.key)) {
        settle(anyHeld(held) ? 'spoiled' : 'idle')
        return
      }
      if (state === 'spoiled') return
      const announces = triggers().some((trigger) => sameModifiers(trigger, held))
      if (!announces) {
        // ⌘ held, then Shift added: a chord on its way, not the number keys.
        if (state !== 'idle') settle('spoiled')
        return
      }
      if (state !== 'idle') return
      state = 'arming'
      timer = setTimer(() => {
        timer = null
        if (state !== 'arming') return
        state = 'visible'
        onVisibleChange(true)
      }, delayMs)
    },
    keyUp(event) {
      const held = heldModifiers(event)
      if (!anyHeld(held)) settle('idle')
      else if (state === 'arming' || state === 'visible') settle('spoiled')
    },
    cancel() {
      settle('idle')
    },
    dispose() {
      stopTimer()
      state = 'idle'
    },
  }
}

/**
 * The hints, keyed by sidebar row (`data-row-key`): the chord each of the
 * first nine numbered rows answers to. `rows` is what
 * `numberedChatRows` read off the drawn tree, so the row a hint sits on is the
 * row `workspace.switch.N` opens; `chords[i]` is that command's binding in
 * force, and a command with none leaves its row bare.
 */
export function chatJumpHintsByRow(
  rows: readonly { rowKey: string }[],
  chords: readonly (string | null)[],
): Map<string, string> {
  const hints = new Map<string, string>()
  rows.slice(0, CHAT_JUMP_COMMAND_IDS.length).forEach((row, index) => {
    const chord = chords[index]
    if (chord) hints.set(row.rowKey, chord)
  })
  return hints
}

// ── The store the rows read ────────────────────────────────────────────────
//
// A row subscribes to its OWN hint, so the moment the hints appear only the
// nine rows that carry one re-render, and the sidebar around them does not.

type HintStore = {
  publish: (hints: ReadonlyMap<string, string> | null) => void
  subscribe: (listener: () => void) => () => void
  hintFor: (rowKey: string) => string | null
}

export function createChatJumpHintStore(): HintStore {
  let hints: ReadonlyMap<string, string> | null = null
  const listeners = new Set<() => void>()
  return {
    publish(next) {
      if (next === hints || (next === null && hints === null)) return
      hints = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hintFor: (rowKey) => hints?.get(rowKey) ?? null,
  }
}

/** This window's hints. One sidebar per window, so one store. */
export const chatJumpHintStore = createChatJumpHintStore()

const NO_HINT = (): null => null

/** The chord to show on this row while the hints are up; null otherwise. */
export function useChatJumpHint(rowKey: string): string | null {
  return useSyncExternalStore(chatJumpHintStore.subscribe, () => chatJumpHintStore.hintFor(rowKey), NO_HINT)
}
