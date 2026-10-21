import { beforeEach, expect, test, vi } from 'vitest'

// Main's clipboard, as a record of what was written to it.
const writes: Array<Array<Record<string, string>>> = []
vi.mock('electron', () => ({
  clipboard: {
    readText: async () => '',
    writeText: async () => undefined,
    write: async (items: Array<{ items: Record<string, string> }>) => {
      writes.push(items.map((item) => item.items))
    },
  },
  ClipboardItem: class {
    constructor(readonly items: Record<string, string>) {}
  },
}))

const { MAX_RICH_CLIPBOARD_CHARS, registerClipboardIpc, richClipboardPayload } = await import('./clipboard-ipc')

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
registerClipboardIpc({
  handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  },
} as unknown as Parameters<typeof registerClipboardIpc>[0])

const writeRich = (payload: unknown) => handlers.get('clipboard:write-rich')!({}, payload)

beforeEach(() => {
  writes.length = 0
})

test('a rich write puts both flavours on the clipboard in one item', async () => {
  await writeRich({ text: '**bold**', html: '<strong>bold</strong>' })
  expect(writes).toEqual([[{ 'text/plain': '**bold**', 'text/html': '<strong>bold</strong>' }]])
})

test('only the two flavours cross: anything else on the payload is left behind', () => {
  expect(richClipboardPayload({ text: 'a', html: '<p>a</p>', 'image/png': 'x' })).toEqual({
    text: 'a',
    html: '<p>a</p>',
  })
})

test('a payload that is not two strings is refused, and nothing is written', () => {
  for (const payload of [
    undefined,
    null,
    'text',
    42,
    [],
    { text: 'a' },
    { html: '<p>a</p>' },
    { text: 1, html: '<p>a</p>' },
    { text: 'a', html: { toString: () => '<p>a</p>' } },
  ]) {
    expect(() => writeRich(payload), JSON.stringify(payload) ?? String(payload)).toThrow(TypeError)
  }
  expect(writes).toEqual([])
})

test('a flavour past the size limit is refused, and nothing is written', () => {
  const huge = 'x'.repeat(MAX_RICH_CLIPBOARD_CHARS + 1)
  expect(() => writeRich({ text: huge, html: '' })).toThrow(RangeError)
  expect(() => writeRich({ text: '', html: huge })).toThrow(RangeError)
  expect(writes).toEqual([])
  expect(() => richClipboardPayload({ text: 'x'.repeat(MAX_RICH_CLIPBOARD_CHARS), html: '' })).not.toThrow()
})
