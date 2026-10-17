import type { KeyboardInputEvent, WebContents } from 'electron'

// The agent's keys and text for a tab, kept inside the tab's page.
//
// Chromium hands DevTools-protocol key and text input (Input.insertText,
// Input.dispatchKeyEvent) to whichever frame has focus in the window, not to
// the page whose debugger sent it. A `<webview>` guest shares the window's
// focus with the app around it, and while the agent works the person is
// usually in the chat composer (the floating preview is the live guest with
// pointer events off): the agent's text lands in their draft, a `clear`
// Backspace eats it, and a `submit` Enter sends it.
//
// While the guest has focus the protocol already reaches the page, so the
// input goes as it always did. Otherwise it goes to the guest's own widget
// through Electron, which no focus redirects. Focusing the guest first would
// also land it, and would take the caret out of whatever the person is typing
// into, which is the same leak the other way round.

/** Input Chromium routes by the window's focus rather than to the debugged page. */
const FOCUS_ROUTED = new Set(['Input.insertText', 'Input.dispatchKeyEvent'])

// Page script: whether the element the page has focused is in a document the
// top frame can reach. Electron's direct input reaches the top frame's
// renderer only, and inserting text while a cross-site frame holds the focus
// can take the guest's renderer down.
const FOCUS_IN_REACH = `(() => {
  let doc = document;
  for (;;) {
    const el = doc.activeElement;
    if (!el || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME')) return true;
    if (!el.contentDocument) return false;
    doc = el.contentDocument;
  }
})()`

const CROSS_SITE_FOCUS =
  'The focused field is inside a cross-site frame, which takes typed input only while the page has focus. ' +
  'Ask the person to click into the page, then type again.'

// The protocol's modifier bits, as parseKeyChord builds them.
const MODIFIER_BITS = [
  [1, 'alt'],
  [2, 'control'],
  [4, 'meta'],
  [8, 'shift'],
] as const

// DOM key names whose Electron accelerator name differs. The rest of the keys
// browser_press accepts (Enter, Tab, Escape, Backspace, Delete, Home, End,
// PageUp, PageDown, single characters) are spelt the same in both.
const ACCELERATOR_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}
const SAME_NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'])

function acceleratorFor(key: string): string {
  if (Object.hasOwn(ACCELERATOR_NAMES, key)) return ACCELERATOR_NAMES[key]
  if (SAME_NAMED_KEYS.has(key) || [...key].length === 1) return key
  throw new Error(`"${key}" has no key code the page's own input takes.`)
}

/**
 * The Electron key events one `Input.dispatchKeyEvent` stands for. Electron
 * derives a key's code and a char's text from `keyCode`, so a key down that
 * types text sends that text as `char` events after it, as the protocol does.
 */
export function toKeyboardInputEvents(params: Record<string, unknown>): KeyboardInputEvent[] {
  const bits = typeof params.modifiers === 'number' ? params.modifiers : 0
  const modifiers = MODIFIER_BITS.filter(([bit]) => bits & bit).map(([, name]) => name)
  const text = typeof params.text === 'string' ? params.text : ''
  const chars = [...text].map((char): KeyboardInputEvent => ({ type: 'char', keyCode: char, modifiers }))
  const key = () => acceleratorFor(typeof params.key === 'string' ? params.key : '')
  switch (params.type) {
    case 'keyDown':
      return [{ type: 'rawKeyDown', keyCode: key(), modifiers }, ...chars]
    case 'rawKeyDown':
    case 'keyUp':
      return [{ type: params.type, keyCode: key(), modifiers }]
    case 'char':
      return chars
    default:
      throw new Error(`"${String(params.type)}" is not a key event type.`)
  }
}

type GuestContents = Pick<WebContents, 'focusedFrame' | 'insertText' | 'sendInputEvent'>
type GuestDebugger = Pick<WebContents['debugger'], 'sendCommand'>

async function evaluate(dbg: GuestDebugger, expression: string): Promise<unknown> {
  const reply = (await dbg.sendCommand('Runtime.evaluate', { expression, returnByValue: true })) as {
    result?: { value?: unknown }
  }
  return reply.result?.value
}

/**
 * Sends one protocol command to the guest's page, with key and text input
 * delivered to the page itself when the guest does not have focus.
 */
export async function sendPageInput(
  wc: GuestContents,
  dbg: GuestDebugger,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!FOCUS_ROUTED.has(method) || wc.focusedFrame) {
    await dbg.sendCommand(method, params)
    return
  }
  if ((await evaluate(dbg, FOCUS_IN_REACH)) !== true) throw new Error(CROSS_SITE_FOCUS)
  if (method === 'Input.insertText') {
    await wc.insertText(typeof params.text === 'string' ? params.text : '')
  } else {
    for (const event of toKeyboardInputEvents(params)) wc.sendInputEvent(event)
  }
  // The protocol replies once the page has handled the input; Electron returns
  // before. A round trip through the page waits for it here too, so the next
  // input cannot overtake this one, and the guest's `before-input-event` runs
  // while the caller's agent-input bracket is still raised: after it, the
  // agent's keys would count as the person taking over, or as app shortcuts.
  await evaluate(dbg, '0')
}
