// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const { ConversationMarkdown } = await import('./conversationLinks')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// Until `ready` holds: the sanitizer is imported the first time a visual is drawn.
async function settleUntil(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

const frame = () => container.querySelector<HTMLIFrameElement>('.ds-code-block__drawing iframe')

const visual = (label: string, tag = 'visual') =>
  `\`\`\`${tag}\n<h3>${label}</h3>\n<svg width="100%" height="40" viewBox="0 0 100 40"><rect width="60" height="20" fill="var(--chart-1)"/></svg>\n\`\`\``

test('a reply draws its visual block only once the message has settled', async () => {
  const source = `Usage this week:\n\n${visual('Streamed')}`
  act(() => root.render(<ConversationMarkdown text={source} streaming />))
  await settle()
  expect(frame()).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('<h3>Streamed</h3>')

  act(() => root.render(<ConversationMarkdown text={source} />))
  await settleUntil(() => frame() !== null)
  const drawn = frame()
  expect(drawn?.getAttribute('sandbox')).toBe('allow-same-origin')
  expect(drawn?.getAttribute('title')).toBe('Streamed')
  const document = drawn?.getAttribute('srcdoc') ?? ''
  expect(document).toContain('Content-Security-Policy')
  expect(document).toContain('<rect width="60" height="20" fill="var(--chart-1)"></rect>')
  // The source is still the block's text, for Copy code and a copied selection.
  expect(container.querySelector('.ds-code-block__drawing')?.hasAttribute('data-copy-exclude')).toBe(true)
  const body = container.querySelector('.ds-code-block__body')
  expect(body?.hasAttribute('hidden')).toBe(true)
  expect(body?.querySelector('pre')?.textContent).toContain('<h3>Streamed</h3>')
})

test('Show source swaps the visual for its source and back', async () => {
  act(() => root.render(<ConversationMarkdown text={visual('Toggle', 'studio-visual')} />))
  await settleUntil(() => frame() !== null)
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show source"]')
  expect(toggle?.getAttribute('aria-pressed')).toBe('false')

  act(() => toggle?.click())
  expect(frame()).toBeNull()
  expect(container.querySelector('.ds-code-block__body')?.hasAttribute('hidden')).toBe(false)
  expect(toggle?.getAttribute('aria-pressed')).toBe('true')

  act(() => toggle?.click())
  expect(frame()).not.toBeNull()
})

test('a visual with nothing left to draw stays its source, with a note saying why', async () => {
  act(() => root.render(<ConversationMarkdown text={'```visual\n<script>steal()</script>\n```'} />))
  await settleUntil(() => container.querySelector('.ds-code-block__note') !== null)
  expect(frame()).toBeNull()
  expect(container.querySelector('button[aria-label="Show source"]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('<script>steal()</script>')
  expect(container.querySelector('.ds-code-block__note')?.textContent).toBe(
    'Shown as source: the visual has nothing to draw',
  )
})

test('html and svg blocks, and what a person typed, are shown as written', async () => {
  const html = '```html\n<h3>Code</h3>\n```\n\n```svg\n<svg><rect/></svg>\n```'
  act(() => root.render(<ConversationMarkdown text={html} />))
  await settle()
  act(() => root.render(<ConversationMarkdown text={visual('Typed')} userText />))
  await settle()
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('<h3>Typed</h3>')
})

test('an appearance switch builds the visual again, keeping the old frame up meanwhile', async () => {
  document.documentElement.setAttribute('data-mode', 'light')
  act(() => root.render(<ConversationMarkdown text={visual('Themed')} />))
  await settleUntil(() => frame() !== null)
  const light = frame()?.getAttribute('srcdoc')

  document.documentElement.style.setProperty('--sem-color-chart-1', 'rgb(1, 2, 3)')
  act(() => document.documentElement.setAttribute('data-mode', 'dark'))
  expect(frame()).not.toBeNull()
  await settleUntil(() => frame()?.getAttribute('srcdoc') !== light)
  expect(frame()?.getAttribute('srcdoc')).toContain('--chart-1: rgb(1, 2, 3);')
  document.documentElement.style.removeProperty('--sem-color-chart-1')
})

test('a sanitizer that did not load says so, and Retry asks for it again', async () => {
  vi.resetModules()
  vi.doMock('dompurify', () => {
    throw new Error('Failed to fetch dynamically imported module')
  })
  const fresh = await import('./conversationLinks')
  act(() => root.render(<fresh.ConversationMarkdown text={visual('Offline')} />))
  await settleUntil(() => container.querySelector('.ds-code-block__note') !== null)
  const note = container.querySelector('.ds-code-block__note')
  expect(note?.textContent).toBe('Shown as source: the visual renderer could not be loaded · Retry')

  vi.doMock('dompurify', () => vi.importActual('dompurify'))
  const retry = [...(note?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Retry')
  act(() => retry?.click())
  await settleUntil(() => frame() !== null)
  expect(frame()?.getAttribute('title')).toBe('Offline')
  expect(container.querySelector('.ds-code-block__note')).toBeNull()
  vi.doUnmock('dompurify')
})
