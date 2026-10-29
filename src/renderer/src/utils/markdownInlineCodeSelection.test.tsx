// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { renderMarkdown } from './markdown'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  window.getSelection()?.removeAllRanges()
})

async function mount(markdown: string, density?: 'chat'): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(renderMarkdown(markdown, density ? { density } : {})))
  return host
}

function doubleClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
}

test('a double-click on inline code selects the whole span, hyphens and dots included', async () => {
  for (const density of [undefined, 'chat'] as const) {
    const page = await mount('Run `migration-gate --dry-run` first.', density)
    doubleClick(page.querySelector('code')!)
    expect(window.getSelection()?.toString()).toBe('migration-gate --dry-run')
    await act(async () => root?.unmount())
    host?.remove()
    root = null
    window.getSelection()?.removeAllRanges()
  }
})

test('a double-click in a code block keeps the browser’s word selection', async () => {
  const page = await mount('```\nfenced-block word\n```')
  doubleClick(page.querySelector('pre code')!)
  expect(window.getSelection()?.toString()).toBe('')
})
