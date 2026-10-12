// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Mermaid needs a real layout engine, so the renderer is a stand-in that
// draws a recognisable SVG and counts what it is asked to draw.
const mermaid = vi.hoisted(() => {
  const drawn: string[] = []
  return {
    drawn,
    api: {
      initialize: () => undefined,
      parse: async (source: string) => {
        if (source.includes('-->>>')) throw new Error('Parse error on line 2:\n...\nExpecting NODE_STRING')
        return { diagramType: 'flowchart' }
      },
      // The parsed diagram, read for what it would load: nothing here.
      mermaidAPI: { getDiagramFromText: async () => ({ db: {} }) },
      render: async (id: string, source: string) => {
        drawn.push(source)
        return {
          svg: `<svg id="${id}" data-diagram="" viewBox="0 0 400 200"><text>${source.split('\n')[1]?.trim()}</text></svg>`,
        }
      },
    },
  }
})
vi.mock('mermaid', () => ({ default: mermaid.api }))

const { ConversationMarkdown } = await import('./conversationLinks')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mermaid.drawn.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

// Until `ready` holds: a module graph imported afresh takes longer than a few turns.
async function settleUntil(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

const diagram = (label: string) => `\`\`\`mermaid\ngraph TD\n  ${label} --> B\n\`\`\``

test('a reply draws its mermaid block only once the message has settled', async () => {
  // The fence has closed, but the message is still streaming.
  const source = `Here is the flow:\n\n${diagram('Streamed')}`
  act(() => root.render(<ConversationMarkdown text={source} streaming />))
  await settle()
  expect(mermaid.drawn).toEqual([])
  expect(container.querySelector('[data-diagram]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('Streamed --> B')

  act(() => root.render(<ConversationMarkdown text={source} />))
  await settle()
  expect(mermaid.drawn).toHaveLength(1)
  const drawing = container.querySelector('.ds-code-block__drawing')
  expect(drawing?.querySelector('[data-diagram]')?.textContent).toBe('Streamed --> B')
  // The source is still the block's text, for Copy code and a copied selection.
  expect(drawing?.hasAttribute('data-copy-exclude')).toBe(true)
  const body = container.querySelector('.ds-code-block__body')
  expect(body?.hasAttribute('hidden')).toBe(true)
  expect(body?.querySelector('pre')?.textContent).toContain('Streamed --> B')
  expect(container.querySelector('[data-code-language="mermaid"]')).not.toBeNull()
})

test('the same diagram shown twice is drawn once, and each copy has ids of its own', async () => {
  act(() => root.render(<ConversationMarkdown text={`${diagram('Twice')}\n\nAgain:\n\n${diagram('Twice')}`} />))
  await settleUntil(() => container.querySelectorAll('[data-diagram]').length === 2)
  expect(mermaid.drawn).toHaveLength(1)
  const ids = [...container.querySelectorAll('[data-diagram]')].map((svg) => svg.id)
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
})

test('Show source swaps the drawing for its source and back', async () => {
  act(() => root.render(<ConversationMarkdown text={diagram('Toggle')} />))
  await settle()
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show source"]')
  expect(toggle?.getAttribute('aria-pressed')).toBe('false')
  expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull()

  act(() => toggle?.click())
  expect(container.querySelector('.ds-code-block__drawing')).toBeNull()
  expect(container.querySelector('.ds-code-block__body')?.hasAttribute('hidden')).toBe(false)
  expect(toggle?.getAttribute('aria-pressed')).toBe('true')

  act(() => toggle?.click())
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')).not.toBeNull()
})

test('a diagram that does not parse stays its source, with a note saying why', async () => {
  act(() => root.render(<ConversationMarkdown text={'```mermaid\ngraph TD\n  A -->>> B\n```'} />))
  await settle()
  expect(container.querySelector('.ds-code-block__drawing')).toBeNull()
  expect(container.querySelector('button[aria-label="Show source"]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('A -->>> B')
  expect(container.querySelector('.ds-code-block__note')?.textContent).toBe('Shown as source: Parse error on line 2')
})

test('what a person typed is shown as typed: no diagram, no math', async () => {
  act(() => root.render(<ConversationMarkdown text={`${diagram('Typed')}\n\nIs $$x^2$$ right?`} userText />))
  await settle()
  expect(mermaid.drawn).toEqual([])
  expect(container.querySelector('.ds-code-block__drawing')).toBeNull()
  expect(container.querySelector('[data-math]')).toBeNull()
  expect(container.textContent).toContain('Is $$x^2$$ right?')
})

test('other code blocks in a reply are untouched', async () => {
  act(() => root.render(<ConversationMarkdown text={'```ts\nconst cost = "$5"\n```'} />))
  await settle()
  expect(mermaid.drawn).toEqual([])
  expect(container.querySelector('button[aria-label="Show source"]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('const cost = "$5"')
})

test('an appearance switch redraws the diagram, keeping the old drawing up meanwhile', async () => {
  document.documentElement.setAttribute('data-mode', 'light')
  act(() => root.render(<ConversationMarkdown text={diagram('Themed')} />))
  await settle()
  expect(mermaid.drawn).toHaveLength(1)

  act(() => document.documentElement.setAttribute('data-mode', 'dark'))
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')).not.toBeNull()
  await settle()
  expect(mermaid.drawn).toHaveLength(2)
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')).not.toBeNull()
})

test('a renderer that did not load says so, and Retry asks for it again', async () => {
  vi.resetModules()
  vi.doMock('mermaid', () => {
    throw new Error('Failed to fetch dynamically imported module')
  })
  const fresh = await import('./conversationLinks')
  act(() => root.render(<fresh.ConversationMarkdown text={diagram('Offline')} />))
  await settleUntil(() => container.querySelector('.ds-code-block__note') !== null)
  const note = container.querySelector('.ds-code-block__note')
  expect(note?.textContent).toBe('Shown as source: The diagram renderer could not be loaded · Retry')
  expect(container.querySelector('pre')?.textContent).toContain('Offline --> B')

  vi.doMock('mermaid', () => ({ default: mermaid.api }))
  const retry = [...(note?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Retry')
  act(() => retry?.click())
  await settleUntil(() => container.querySelector('.ds-code-block__drawing') !== null)
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')?.textContent).toBe('Offline --> B')
  expect(container.querySelector('.ds-code-block__note')).toBeNull()
  vi.doUnmock('mermaid')
})

test('Open diagram shows the same drawing larger, zooms by button and key, and closes', async () => {
  // jsdom lays nothing out; the viewer only needs to be told its size changed.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  try {
    act(() => root.render(<ConversationMarkdown text={diagram('Enlarged')} />))
    await settle()
    const inline = container.querySelector('.ds-code-block__drawing [data-diagram]')
    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open diagram"]')
    expect(open).not.toBeNull()
    expect(document.querySelector('[data-diagram-viewer]')).toBeNull()

    act(() => open?.click())
    const viewer = document.querySelector('[data-diagram-viewer]')
    // Over the window, not inside the transcript: a row's transform would
    // otherwise hold the fixed scrim inside the chat column.
    expect(viewer).not.toBeNull()
    expect(container.contains(viewer)).toBe(false)
    const copy = viewer?.querySelector('[data-diagram]')
    expect(copy?.textContent).toBe('Enlarged --> B')
    // A copy of its own, not the inline drawing moved or redrawn.
    expect(copy?.id).not.toBe(inline?.id)
    expect(mermaid.drawn.filter((source) => source.includes('Enlarged'))).toHaveLength(1)

    const zoom = () => viewer?.querySelector<HTMLElement>('[data-zoom]')
    const fit = () =>
      document.querySelector<HTMLButtonElement>('[role="toolbar"][aria-label="Zoom"] button[aria-pressed]')
    // Unmeasured, fitting leaves the drawing at its own size.
    expect(zoom()?.dataset.zoom).toBe('100%')
    expect(zoom()?.style.width).toBe('400px')
    expect(fit()?.getAttribute('aria-pressed')).toBe('true')

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click())
    expect(zoom()?.dataset.zoom).toBe('125%')
    expect(zoom()?.style.width).toBe('500px')
    expect(fit()?.getAttribute('aria-pressed')).toBe('false')

    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })))
    expect(zoom()?.dataset.zoom).toBe('100%')
    // The app's own zoom chord is left to the app.
    act(
      () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '-', metaKey: true, bubbles: true })),
    )
    expect(zoom()?.dataset.zoom).toBe('100%')
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })))
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })))
    expect(fit()?.getAttribute('aria-pressed')).toBe('true')

    act(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')?.click())
    expect(document.querySelector('[data-diagram-viewer]')).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a diagram still shown as source has nothing to open', async () => {
  act(() => root.render(<ConversationMarkdown text={'```mermaid\ngraph TD\n  A -->>> B\n```'} />))
  await settle()
  expect(container.querySelector('button[aria-label="Open diagram"]')).toBeNull()
})
