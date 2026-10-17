import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, test } from 'vitest'
import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import type { ComposerKeyEvent } from './ComposerField'
import type { LoadedStashedPrompt, PromptStash, PromptStashInput } from './promptStash'

type Box = { text: string; images: ConversationImageAttachment[] }

let restoreGlobals: (() => void) | null = null

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  restoreGlobals = () => Object.assign(globalThis, previous)
})

afterEach(() => {
  restoreGlobals?.()
  restoreGlobals = null
})

function key(init: Partial<ComposerKeyEvent> & { key: string }): ComposerKeyEvent & { prevented: boolean } {
  const event = {
    code: init.key.length === 1 ? `Key${init.key.toUpperCase()}` : init.key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    nativeEvent: {} as KeyboardEvent,
    currentTarget: {} as ComposerKeyEvent['currentTarget'],
    prevented: false,
    preventDefault() {
      event.prevented = true
    },
    stopPropagation() {},
    ...init,
  }
  return event
}

const primaryS = () => key({ key: 's', code: 'KeyS', metaKey: true })
const picture: ConversationImageAttachment = { id: 'shot', mediaType: 'image/png', dataBase64: 'eA==', byteLength: 1 }

async function mount(options: { acceptsImages?: boolean; stashKeys?: string[]; initial?: Box } = {}) {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { createPromptStash, memoryImageVault } = await import('./promptStash')
  const { usePromptStash } = await import('./promptStashPicker')
  const { useToastStore } = await import('../../../store/toastStore')
  useToastStore.setState({ toasts: [] })
  let clock = 1_000
  let id = 0
  const values = new Map<string, string>()
  const stash: PromptStash = createPromptStash({
    storage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => void values.set(k, v) },
    vault: memoryImageVault(),
    now: () => clock++,
    newId: () => `entry-${++id}`,
  })
  const box: Box = options.initial ?? { text: '', images: [] }
  let hook!: ReturnType<typeof usePromptStash>
  function Harness({ text }: { text: string }) {
    hook = usePromptStash({
      stashKeys: options.stashKeys ?? ['Primary+S'],
      platform: 'darwin',
      content: (): PromptStashInput => ({ text: box.text, images: box.images }),
      clear: () => {
        box.text = ''
        box.images = []
      },
      restore: ({ prompt, images }: LoadedStashedPrompt) => {
        box.text = [prompt.text, box.text].filter(Boolean).join('\n\n')
        box.images = [...images, ...box.images]
        return true
      },
      acceptsImages: options.acceptsImages ?? true,
      empty: !text.trim(),
      stash,
    })
    return hook.picker
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = () => act(async () => root.render(createElement(Harness, { text: box.text })))
  await render()
  const press = async (event: ComposerKeyEvent) => {
    let handled = false
    await act(async () => {
      handled = hook.handleKeyDown(event)
    })
    await render()
    // Restores are asynchronous: let the vault's read and the state settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await render()
    return handled
  }
  return {
    box,
    stash,
    host,
    press,
    render,
    hook: () => hook,
    toasts: () => useToastStore.getState().toasts,
    unmount: () => act(async () => root.unmount()),
  }
}

test('Primary+S with words typed stashes them, clears the box and offers Undo', async () => {
  const view = await mount({ initial: { text: 'half a thought', images: [picture] } })
  const event = primaryS()
  assert.equal(await view.press(event), true)
  assert.equal(event.prevented, true)
  assert.deepEqual(view.box, { text: '', images: [] })
  assert.equal(view.stash.list()[0].text, 'half a thought')
  const toast = view.toasts().find((entry) => entry.title === 'Prompt stashed')
  assert.ok(toast?.actions?.some((action) => action.label === 'Undo'))
  await view.unmount()
})

test('Undo puts the stashed words and images back and empties the stash', async () => {
  const view = await mount({ initial: { text: 'undo me', images: [picture] } })
  await view.press(primaryS())
  const undo = view.toasts()[0].actions!.find((action) => action.label === 'Undo')!
  undo.run()
  await view.press(key({ key: 'Shift' }))
  assert.equal(view.box.text, 'undo me')
  assert.equal(view.box.images[0].dataBase64, 'eA==')
  assert.deepEqual(view.stash.list(), [])
  assert.equal(view.toasts().length, 0)
  await view.unmount()
})

test('Primary+S on an empty box opens the stash, and Enter restores the chosen prompt', async () => {
  const view = await mount()
  view.stash.stash({ text: 'older' })
  view.stash.stash({ text: 'newer' })
  await view.press(primaryS())
  assert.equal(view.hook().open, true)
  const options = [...view.host.querySelectorAll('[role="option"]')].map((option) => option.textContent)
  assert.equal(options.length, 2)
  assert.match(options[0] ?? '', /^newer/)
  await view.press(key({ key: 'ArrowDown' }))
  const enter = key({ key: 'Enter' })
  assert.equal(await view.press(enter), true)
  assert.equal(enter.prevented, true, 'Enter restores, it does not send')
  assert.equal(view.box.text, 'older')
  assert.deepEqual(
    view.stash.list().map((entry) => entry.text),
    ['newer'],
  )
  assert.equal(view.hook().open, false)
  await view.unmount()
})

test('Primary+Backspace deletes the chosen prompt and Escape closes the list', async () => {
  const view = await mount()
  view.stash.stash({ text: 'keep' })
  view.stash.stash({ text: 'drop' })
  await view.press(primaryS())
  await view.press(key({ key: 'Backspace', code: 'Backspace', metaKey: true }))
  assert.deepEqual(
    view.stash.list().map((entry) => entry.text),
    ['keep'],
  )
  assert.equal(view.box.text, '')
  const escape = key({ key: 'Escape' })
  assert.equal(await view.press(escape), true)
  assert.equal(escape.prevented, true, 'the box’s own Escape (stop the turn, close New chat) does not run')
  assert.equal(view.hook().open, false)
  assert.equal(view.host.querySelector('[role="listbox"]'), null)
  await view.unmount()
})

test('an empty stash opens to a line saying how to fill it', async () => {
  const view = await mount()
  await view.press(primaryS())
  assert.match(view.host.textContent ?? '', /Nothing stashed/)
  await view.unmount()
})

test('a prompt with images is not restored into a box that takes none', async () => {
  const view = await mount({ acceptsImages: false })
  view.stash.stash({ text: 'has a picture', images: [picture] })
  await view.press(primaryS())
  const option = view.host.querySelector<HTMLButtonElement>('[role="option"]')
  assert.equal(option?.disabled, true)
  assert.match(option?.textContent ?? '', /this chat takes no images/)
  await view.press(key({ key: 'Enter' }))
  assert.equal(view.box.text, '')
  assert.equal(view.stash.list().length, 1)
  await view.unmount()
})

test('with the list closed, the box keeps every other key', async () => {
  const view = await mount({ initial: { text: 'typed', images: [] } })
  for (const event of [key({ key: 'Enter' }), key({ key: 'Escape' }), key({ key: 'ArrowUp' })])
    assert.equal(await view.press(event), false)
  await view.unmount()
})

test('typing closes the open list', async () => {
  const view = await mount()
  view.stash.stash({ text: 'something' })
  await view.press(primaryS())
  assert.equal(view.hook().open, true)
  view.box.text = 'n'
  await view.render()
  assert.equal(view.hook().open, false)
  await view.unmount()
})

test('with the shortcut turned off, Primary+S is left alone', async () => {
  const view = await mount({ stashKeys: [], initial: { text: 'typed', images: [] } })
  const event = primaryS()
  assert.equal(await view.press(event), false)
  assert.equal(event.prevented, false)
  assert.equal(view.box.text, 'typed')
  await view.unmount()
})

test('closing the composer takes its Undo toast with it', async () => {
  const view = await mount({ initial: { text: 'leaving', images: [] } })
  await view.press(primaryS())
  assert.equal(view.toasts().length, 1)
  await view.unmount()
  assert.equal(view.toasts().length, 0)
})

test('a held Primary+S stashes once and does not go on to open the list', async () => {
  const view = await mount({ initial: { text: 'once', images: [] } })
  await view.press(primaryS())
  assert.equal(await view.press({ ...primaryS(), repeat: true }), true)
  assert.equal(view.hook().open, false)
  assert.equal(view.stash.list().length, 1)
  await view.unmount()
})
