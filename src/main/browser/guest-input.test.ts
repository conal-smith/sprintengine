import { expect, test, vi } from 'vitest'

import { sendPageInput, toKeyboardInputEvents } from './guest-input'

// A guest reduced to what its input touches: whether it has focus, Electron's
// direct input, and a debugger whose page reports `focusInReach` for the
// cross-site-frame probe.
function guest({ focused, focusInReach = true }: { focused: boolean; focusInReach?: boolean }) {
  const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) =>
    method === 'Runtime.evaluate' && params?.expression?.includes('activeElement')
      ? { result: { value: focusInReach } }
      : { result: {} },
  )
  const wc = {
    focusedFrame: focused ? ({} as never) : null,
    insertText: vi.fn(async (_text: string) => {}),
    sendInputEvent: vi.fn(),
  }
  return {
    wc,
    sendCommand,
    methods: () => sendCommand.mock.calls.map(([method]) => method),
    send: (method: string, params: Record<string, unknown>) => sendPageInput(wc, { sendCommand }, method, params),
  }
}

test("text for a page without focus goes into the page, not the app's focused field", async () => {
  const page = guest({ focused: false })
  await page.send('Input.insertText', { text: 'pairing-code' })
  expect(page.wc.insertText).toHaveBeenCalledWith('pairing-code')
  expect(page.methods()).not.toContain('Input.insertText')
})

test('keys for a page without focus go to the page as Electron key events', async () => {
  const page = guest({ focused: false })
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' })
  expect(page.wc.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
    { type: 'rawKeyDown', keyCode: 'Enter', modifiers: [] },
    { type: 'char', keyCode: '\r', modifiers: [] },
    { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
  ])
  expect(page.methods()).not.toContain('Input.dispatchKeyEvent')
})

test('input to a page without focus returns only after a round trip through the page', async () => {
  const page = guest({ focused: false })
  await page.send('Input.insertText', { text: 'x' })
  // The probe, then the settle: the last thing the call waited on was the page.
  expect(page.methods()).toEqual(['Runtime.evaluate', 'Runtime.evaluate'])
  expect(page.sendCommand.mock.calls.at(-1)?.[1]).toEqual({ expression: '0', returnByValue: true })
})

test('a page with focus keeps taking key and text input through the debugger', async () => {
  const page = guest({ focused: true })
  await page.send('Input.insertText', { text: 'x' })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' })
  expect(page.methods()).toEqual(['Input.insertText', 'Input.dispatchKeyEvent'])
  expect(page.wc.insertText).not.toHaveBeenCalled()
  expect(page.wc.sendInputEvent).not.toHaveBeenCalled()
})

test('text for a cross-site frame holding the focus of a page without focus is refused', async () => {
  const page = guest({ focused: false, focusInReach: false })
  await expect(page.send('Input.insertText', { text: 'secret' })).rejects.toThrow(/cross-site frame/)
  expect(page.wc.insertText).not.toHaveBeenCalled()
  expect(page.methods()).not.toContain('Input.insertText')
})

test('commands other than key and text input go to the debugger unchanged', async () => {
  const page = guest({ focused: false })
  const params = { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }
  await page.send('Input.dispatchMouseEvent', params)
  expect(page.sendCommand.mock.calls).toEqual([['Input.dispatchMouseEvent', params]])
  expect(page.wc.sendInputEvent).not.toHaveBeenCalled()
})

test('Space and the arrows take their Electron key codes', () => {
  expect(toKeyboardInputEvents({ type: 'keyDown', key: ' ', text: ' ' })).toEqual([
    { type: 'rawKeyDown', keyCode: 'Space', modifiers: [] },
    { type: 'char', keyCode: ' ', modifiers: [] },
  ])
  expect(
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map(
      (key) => toKeyboardInputEvents({ type: 'rawKeyDown', key })[0]?.keyCode,
    ),
  ).toEqual(['Up', 'Down', 'Left', 'Right'])
  expect(toKeyboardInputEvents({ type: 'keyUp', key: 'Backspace' })).toEqual([
    { type: 'keyUp', keyCode: 'Backspace', modifiers: [] },
  ])
})

test("a chord's modifier bits become Electron's modifier names", () => {
  // Alt 1, Control 2, Meta 4, Shift 8, as parseKeyChord sets them.
  expect(toKeyboardInputEvents({ type: 'rawKeyDown', key: 'a', modifiers: 4 })).toEqual([
    { type: 'rawKeyDown', keyCode: 'a', modifiers: ['meta'] },
  ])
  expect(toKeyboardInputEvents({ type: 'keyUp', key: 'Tab', modifiers: 15 })).toEqual([
    { type: 'keyUp', keyCode: 'Tab', modifiers: ['alt', 'control', 'meta', 'shift'] },
  ])
  expect(toKeyboardInputEvents({ type: 'keyDown', key: 'A', text: 'A', modifiers: 8 })).toEqual([
    { type: 'rawKeyDown', keyCode: 'A', modifiers: ['shift'] },
    { type: 'char', keyCode: 'A', modifiers: ['shift'] },
  ])
})

test('a key with no Electron key code is refused rather than dropped', () => {
  expect(() => toKeyboardInputEvents({ type: 'rawKeyDown', key: 'AudioVolumeUp' })).toThrow(/AudioVolumeUp/)
})
