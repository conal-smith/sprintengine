// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useToastStore } from '../../store/toastStore'
import { COPY_CONFIRM_MS, CopyGlyphButton, type CopyGlyphButtonProps } from './CopyGlyphButton'

// The app's clipboard bridge, standing in for the main process. Every write
// lands here, so "what did the click copy" is read off this list.
const written: string[] = []
let bridgeFails = false

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  written.length = 0
  bridgeFails = false
  ;(window as unknown as { api: unknown }).api = {
    clipboardWriteText: async (text: string) => {
      if (bridgeFails) throw new Error('clipboard denied')
      written.push(text)
    },
  }
  useToastStore.setState({ toasts: [] })
  vi.useFakeTimers()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

async function mount(props: Partial<CopyGlyphButtonProps> = {}): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(<CopyGlyphButton text="npm test" label="Copy code" {...props} />))
  return host
}

const button = () => host!.querySelector('button')!
const announcement = () => host!.querySelector('[role="status"]')!.textContent

async function click(): Promise<void> {
  await act(async () => button().click())
}

test('clicking copies the text and confirms in place, with no success toast', async () => {
  await mount()
  await click()
  expect(written).toEqual(['npm test'])
  expect(announcement()).toBe('Copied')
  expect(useToastStore.getState().toasts).toEqual([])
})

test('the accessible name stays the label through the confirmation', async () => {
  await mount()
  expect(button().getAttribute('aria-label')).toBe('Copy code')
  await click()
  expect(button().getAttribute('aria-label')).toBe('Copy code')
})

test('the confirmation reverts after the hold', async () => {
  await mount()
  await click()
  await act(async () => vi.advanceTimersByTime(COPY_CONFIRM_MS - 1))
  expect(announcement()).toBe('Copied')
  await act(async () => vi.advanceTimersByTime(1))
  expect(announcement()).toBe('')
})

test('a re-click while confirmed neither writes again nor extends the hold', async () => {
  await mount()
  await click()
  await act(async () => vi.advanceTimersByTime(COPY_CONFIRM_MS / 2))
  await click()
  expect(written).toEqual(['npm test'])
  await act(async () => vi.advanceTimersByTime(COPY_CONFIRM_MS / 2))
  expect(announcement()).toBe('')
})

test('a function source is resolved only when clicked', async () => {
  const build = vi.fn(async () => 'built at click time')
  await mount({ text: build })
  expect(build).not.toHaveBeenCalled()
  await click()
  expect(build).toHaveBeenCalledTimes(1)
  expect(written).toEqual(['built at click time'])
})

test('onCopied fires after a copy lands', async () => {
  const onCopied = vi.fn()
  await mount({ onCopied })
  await click()
  expect(onCopied).toHaveBeenCalledTimes(1)
})

test('a failed write reports through the toast and never shows the confirmation', async () => {
  const onCopied = vi.fn()
  bridgeFails = true
  await mount({ onCopied })
  await click()
  expect(announcement()).toBe('')
  expect(onCopied).not.toHaveBeenCalled()
  expect(useToastStore.getState().toasts.map((toast) => [toast.tone, toast.title])).toEqual([
    ['error', 'Could not copy to clipboard'],
  ])
})

test('a source that throws is a failed copy, not an unhandled rejection', async () => {
  await mount({
    text: () => {
      throw new Error('nothing to serialise')
    },
  })
  await click()
  expect(written).toEqual([])
  expect(announcement()).toBe('')
  expect(useToastStore.getState().toasts.map((toast) => toast.tone)).toEqual(['error'])
})

test('an html flavour is written beside the plain text', async () => {
  const items: Array<Record<string, Blob>> = []
  class FakeClipboardItem {
    constructor(readonly data: Record<string, Blob>) {
      items.push(data)
    }
  }
  vi.stubGlobal('ClipboardItem', FakeClipboardItem)
  vi.stubGlobal('navigator', { clipboard: { write: async () => {} } })
  try {
    await mount({ text: 'a | b', html: () => '<table><tr><td>a</td><td>b</td></tr></table>' })
    await click()
    expect(items).toHaveLength(1)
    expect(await items[0]['text/plain'].text()).toBe('a | b')
    expect(await items[0]['text/html'].text()).toBe('<table><tr><td>a</td><td>b</td></tr></table>')
    expect(announcement()).toBe('Copied')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('in the app both flavours go through the main-process bridge, in one write', async () => {
  const rich: Array<{ text: string; html: string }> = []
  ;(window as unknown as { api: Record<string, unknown> }).api.clipboardWriteRich = async (payload: {
    text: string
    html: string
  }) => {
    rich.push(payload)
  }
  await mount({ text: '**npm** test', html: () => '<strong>npm</strong> test' })
  await click()
  expect(rich).toEqual([{ text: '**npm** test', html: '<strong>npm</strong> test' }])
  expect(written).toEqual([])
  expect(announcement()).toBe('Copied')
})

test('a Shift-click writes the plain text alone, and the tooltip says so', async () => {
  const rich: unknown[] = []
  ;(window as unknown as { api: Record<string, unknown> }).api.clipboardWriteRich = async (payload: unknown) => {
    rich.push(payload)
  }
  const html = vi.fn(() => '<strong>npm</strong> test')
  await mount({ text: '**npm** test', html, label: 'Copy reply' })
  await act(async () => button().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  expect(written).toEqual(['**npm** test'])
  expect(rich).toEqual([])
  expect(html).not.toHaveBeenCalled()
  expect(button().getAttribute('aria-label')).toBe('Copy reply')
})

test('the tooltip of a rich copy names the Shift-click; a plain one does not', async () => {
  const tooltip = () => document.querySelector('[role="tooltip"]')?.textContent
  // Focus the keyboard moved, which opens a tooltip at once.
  const tabTo = () =>
    act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      button().focus()
    })
  await mount({ html: '<code>npm test</code>', label: 'Copy reply' })
  await tabTo()
  expect(tooltip()).toBe('Copy reply · Shift-click for Markdown')
  await act(async () => root?.unmount())
  host?.remove()
  await mount()
  await tabTo()
  expect(tooltip()).toBe('Copy code')
})

test('a refused rich write still copies the plain text', async () => {
  vi.stubGlobal('ClipboardItem', class {})
  vi.stubGlobal('navigator', {
    clipboard: {
      write: async () => {
        throw new Error('rich clipboard refused')
      },
    },
  })
  try {
    await mount({ html: '<code>npm test</code>' })
    await click()
    expect(written).toEqual(['npm test'])
    expect(announcement()).toBe('Copied')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('the control is excluded from copied selections and does not bubble its click', async () => {
  const onRowClick = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () =>
    created.render(
      <div onClick={onRowClick}>
        <CopyGlyphButton text="x" label="Copy message" />
      </div>,
    ),
  )
  expect(button().closest('[data-copy-exclude]')).not.toBeNull()
  await click()
  expect(onRowClick).not.toHaveBeenCalled()
})
