import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  CHAT_JUMP_HINT_DELAY_MS,
  chatJumpHintsByRow,
  chatJumpTriggerModifiers,
  createChatJumpHintController,
  createChatJumpHintStore,
  type HintKeyEvent,
} from './chatJumpHints'

const CMD = { ctrl: false, meta: true, alt: false, shift: false }

function key(keyName: string, held: Partial<Record<'ctrl' | 'meta' | 'alt' | 'shift', boolean>> = {}): HintKeyEvent {
  return {
    key: keyName,
    ctrlKey: held.ctrl ?? false,
    metaKey: held.meta ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false,
  }
}

let visible: boolean[]
let controller: ReturnType<typeof createChatJumpHintController>

beforeEach(() => {
  vi.useFakeTimers()
  visible = []
  controller = createChatJumpHintController({ triggers: () => [CMD], onVisibleChange: (next) => visible.push(next) })
})

afterEach(() => {
  controller.dispose()
  vi.useRealTimers()
})

test('holding the modifier alone shows the hints once the delay has passed', () => {
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS - 1)
  expect(visible).toEqual([])
  vi.advanceTimersByTime(1)
  expect(visible).toEqual([true])
})

test('letting go hides them', () => {
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS)
  controller.keyUp(key('Meta'))
  expect(visible).toEqual([true, false])
})

test('a quick tap never shows them', () => {
  controller.keyDown(key('Meta', { meta: true }))
  controller.keyUp(key('Meta'))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS * 2)
  expect(visible).toEqual([])
})

test('the key repeat of a held modifier changes nothing', () => {
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS / 2)
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS / 2)
  controller.keyDown(key('Meta', { meta: true }))
  controller.keyDown(key('Meta', { meta: true }))
  expect(visible).toEqual([true])
})

test('another key while the modifier is down cancels the hints before they show', () => {
  controller.keyDown(key('Meta', { meta: true }))
  controller.keyDown(key('c', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS * 2)
  expect(visible).toEqual([])
})

test('another key hides hints already up, and they stay away until the modifier is let go', () => {
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS)
  controller.keyDown(key('1', { meta: true }))
  expect(visible).toEqual([true, false])
  controller.keyUp(key('1', { meta: true }))
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS * 2)
  expect(visible).toEqual([true, false])

  controller.keyUp(key('Meta'))
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS)
  expect(visible).toEqual([true, false, true])
})

test('adding a second modifier is a chord on its way, not the number keys', () => {
  controller.keyDown(key('Meta', { meta: true }))
  controller.keyDown(key('Shift', { meta: true, shift: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS * 2)
  expect(visible).toEqual([])
})

test('a modifier that announces nothing leaves the hints alone', () => {
  controller.keyDown(key('Alt', { alt: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS * 2)
  expect(visible).toEqual([])
})

test('the window losing focus hides them, since the keyup may never come', () => {
  controller.keyDown(key('Meta', { meta: true }))
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS)
  controller.cancel()
  expect(visible).toEqual([true, false])
})

test('losing focus while arming means they never show', () => {
  controller.keyDown(key('Meta', { meta: true }))
  controller.cancel()
  vi.advanceTimersByTime(CHAT_JUMP_HINT_DELAY_MS * 2)
  expect(visible).toEqual([])
})

test('Primary is ⌘ on macOS and Ctrl elsewhere', () => {
  const bindings = ['Primary+1', 'Primary+2']
  expect(chatJumpTriggerModifiers(bindings, 'darwin')).toEqual([CMD])
  expect(chatJumpTriggerModifiers(bindings, 'windows')).toEqual([{ ctrl: true, meta: false, alt: false, shift: false }])
})

test('a rebound command is announced by its own modifiers', () => {
  expect(chatJumpTriggerModifiers(['Primary+1', 'Alt+2', null], 'darwin')).toEqual([
    CMD,
    { ctrl: false, meta: false, alt: true, shift: false },
  ])
})

test('a binding with no modifier or a second stroke announces nothing', () => {
  expect(chatJumpTriggerModifiers(['F1', 'Primary+K then 1', 'not a chord!!'], 'linux')).toEqual([])
})

test('the first nine numbered rows carry the chord of the command that opens them', () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ rowKey: `row-${index + 1}` }))
  const chords = Array.from({ length: 9 }, (_, index) => `Primary+${index + 1}`)
  const hints = chatJumpHintsByRow(rows, chords)
  expect(hints.size).toBe(9)
  expect(hints.get('row-1')).toBe('Primary+1')
  expect(hints.get('row-9')).toBe('Primary+9')
  expect(hints.has('row-10')).toBe(false)
})

test('a number with no binding leaves its row bare', () => {
  const hints = chatJumpHintsByRow([{ rowKey: 'a' }, { rowKey: 'b' }, { rowKey: 'c' }], ['Primary+1', null, 'Alt+3'])
  expect([...hints]).toEqual([
    ['a', 'Primary+1'],
    ['c', 'Alt+3'],
  ])
})

test('the store tells its readers only when the hints change', () => {
  const store = createChatJumpHintStore()
  const listener = vi.fn()
  store.subscribe(listener)
  store.publish(null)
  expect(listener).not.toHaveBeenCalled()
  store.publish(new Map([['row-1', 'Primary+1']]))
  expect(store.hintFor('row-1')).toBe('Primary+1')
  expect(store.hintFor('row-2')).toBeNull()
  store.publish(null)
  expect(store.hintFor('row-1')).toBeNull()
  expect(listener).toHaveBeenCalledTimes(2)
})
