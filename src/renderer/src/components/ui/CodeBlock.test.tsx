// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { revealMatch } from '../../utils/revealMatch'
import { CodeBlock, COLLAPSE_AFTER_LINES, type CodeBlockProps } from './CodeBlock'

// The app's clipboard bridge, standing in for the main process.
const written: string[] = []
const rich: unknown[] = []

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  written.length = 0
  rich.length = 0
  ;(window as unknown as { api: unknown }).api = {
    clipboardWriteText: async (text: string) => {
      written.push(text)
    },
    clipboardWriteRich: async (payload: unknown) => {
      rich.push(payload)
    },
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(props: CodeBlockProps): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(<CodeBlock {...props} />))
  return host
}

async function rerender(props: CodeBlockProps): Promise<void> {
  await act(async () => root!.render(<CodeBlock {...props} />))
}

const block = () => host!.querySelector('section')!
const header = () => host!.querySelector('[data-copy-exclude]')!
const buttonNamed = (name: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

test('the header names the language, not the fence tag', async () => {
  await mount({ code: 'const a = 1', language: 'ts' })
  expect(header().textContent).toContain('TypeScript')
  expect(header().textContent).not.toMatch(/\bts\b/)
  expect(block().getAttribute('aria-label')).toBe('TypeScript code')
})

test('a block with a filename shows the filename in place of the language', async () => {
  await mount({ code: '{}', language: 'json', filename: 'config/app.json' })
  expect(header().textContent).toContain('config/app.json')
  expect(header().textContent).not.toContain('JSON')
  expect(block().getAttribute('aria-label')).toBe('JSON code, config/app.json')
})

test('the root says it is a code block and which language, for code that reads the rendered DOM', async () => {
  await mount({ code: 'echo hi', language: 'sh' })
  expect(block().hasAttribute('data-code-block')).toBe(true)
  expect(block().getAttribute('data-code-language')).toBe('bash')
  expect(block().querySelector('pre > code')?.textContent).toBe('echo hi')
})

test('the header is chrome that a copied selection leaves out, and its actions are glyphs', async () => {
  await mount({ code: 'x', language: 'ts' })
  expect(header().querySelector('.ds-code-block__actions')).not.toBeNull()
  expect(header().textContent).not.toMatch(/Wrap|Copy/)
})

test('copy puts the raw code on the clipboard, without fences', async () => {
  await mount({ code: 'npm test\nnpm run build', language: 'bash' })
  await act(async () => buttonNamed('Copy code')!.click())
  expect(written).toEqual(['npm test\nnpm run build'])
})

test('copied code is plain text alone, with no rich flavour to paste as formatting', async () => {
  await mount({ code: 'const a = 1', language: 'ts' })
  await act(async () => buttonNamed('Copy code')!.click())
  expect(written).toEqual(['const a = 1'])
  expect(rich).toEqual([])
})

test('wrap is a toggle that says whether it is on', async () => {
  await mount({ code: 'x', language: 'ts' })
  const wrap = buttonNamed('Wrap lines')!
  expect(wrap.getAttribute('aria-pressed')).toBe('false')
  await act(async () => wrap.click())
  expect(wrap.getAttribute('aria-pressed')).toBe('true')
  expect(block().classList.contains('ds-code-block--wrap')).toBe(true)
})

test('a short block has no fold control', async () => {
  await mount({ code: lines(COLLAPSE_AFTER_LINES), language: 'ts' })
  expect(host!.querySelector('[aria-expanded]')).toBeNull()
})

test('a long settled block folds, keeps every line in the DOM, and opens on request', async () => {
  const code = lines(40)
  await mount({ code, language: 'ts' })
  const toggle = host!.querySelector<HTMLButtonElement>('[aria-expanded]')!
  expect(toggle.textContent).toBe('Show all 40 lines')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.closest('[data-copy-exclude]')).not.toBeNull()
  expect(host!.querySelector('[data-folded]')).not.toBeNull()
  expect(block().querySelector('pre')!.textContent).toBe(code)
  await act(async () => toggle.click())
  expect(toggle.textContent).toBe('Show less')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(host!.querySelector('[data-folded]')).toBeNull()
})

test('a find that lands on a folded line opens the block', async () => {
  await mount({ code: lines(40), language: 'ts' })
  // The deepest last node of the source: text on the last, folded-away line.
  let lastLine: Node = block().querySelector('pre')!
  while (lastLine.lastChild) lastLine = lastLine.lastChild
  expect(lastLine.textContent).toBe('40')
  await act(async () => revealMatch(lastLine))
  expect(host!.querySelector('[data-folded]')).toBeNull()
  expect(host!.querySelector('[aria-expanded]')!.textContent).toBe('Show less')
})

test('a long block that streamed in stays open when it settles', async () => {
  await mount({ code: lines(40), language: 'ts', streaming: true })
  expect(host!.querySelector('[aria-expanded]')).toBeNull()
  await rerender({ code: lines(40), language: 'ts', streaming: false })
  expect(host!.querySelector('[data-folded]')).toBeNull()
  expect(host!.querySelector('[aria-expanded]')!.textContent).toBe('Show less')
})

test('a surface can turn folding off', async () => {
  await mount({ code: lines(40), language: 'ts', collapsible: false })
  expect(host!.querySelector('[aria-expanded]')).toBeNull()
  expect(host!.querySelector('[data-folded]')).toBeNull()
})

test('a settled shell block offers to paste its command, prompts stripped', async () => {
  const onPasteInTerminal = vi.fn()
  await mount({ code: '$ npm install\nadded 3 packages\n$ npm test', language: 'console', onPasteInTerminal })
  await act(async () => buttonNamed('Paste into terminal')!.click())
  expect(onPasteInTerminal).toHaveBeenCalledWith('npm install\nnpm test')
})

test('the paste action is hidden while streaming, on other languages, and with nowhere to paste', async () => {
  const onPasteInTerminal = vi.fn()
  await mount({ code: 'npm test', language: 'bash', streaming: true, onPasteInTerminal })
  expect(buttonNamed('Paste into terminal')).toBeNull()
  await rerender({ code: 'npm test', language: 'ts', onPasteInTerminal })
  expect(buttonNamed('Paste into terminal')).toBeNull()
  await rerender({ code: 'npm test', language: 'bash' })
  expect(buttonNamed('Paste into terminal')).toBeNull()
  await rerender({ code: 'npm test', language: 'bash', onPasteInTerminal })
  expect(buttonNamed('Paste into terminal')).not.toBeNull()
})

test('a surface action sits in the header beside the block’s own', async () => {
  await mount({ code: 'x', language: 'ts', actions: <span data-testid="extra">extra</span> })
  expect(header().querySelector('[data-testid="extra"]')).not.toBeNull()
})

test('Show source keeps its place beside Copy in both views, so a second click switches back', async () => {
  await mount({ code: 'graph TD; A-->B', language: 'mermaid', drawing: <svg /> })
  const actionNames = () =>
    Array.from(host!.querySelectorAll('.ds-code-block__actions button')).map((button) =>
      button.getAttribute('aria-label'),
    )
  expect(actionNames().slice(-2)).toEqual(['Show source', 'Copy code'])
  await act(async () => buttonNamed('Show source')!.click())
  expect(buttonNamed('Wrap lines')).not.toBeNull()
  expect(actionNames().slice(-2)).toEqual(['Show source', 'Copy code'])
})
