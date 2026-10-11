import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, expect, test } from 'vitest'

// The primitives the composer strip is made of: the context ring with its
// token counts, the split diff pill, the front-truncated text, and the strip
// itself — one line, never two.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const previous = Object.getOwnPropertyDescriptors(globalThis)

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
})

afterAll(() => {
  dom.window.close()
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'getComputedStyle']) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
  for (const key of ['requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
})

async function mount(node: React.ReactNode) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return {
    container,
    act,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

test('the ring’s tooltip says the token counts and nothing else; its name says the share and the counts', async () => {
  const { ContextRing, contextRingTokensLabel } = await import('./ContextRing')
  expect(contextRingTokensLabel(76_000, 200_000)).toBe(
    `${(76_000).toLocaleString()} / ${(200_000).toLocaleString()} tokens`,
  )
  const view = await mount(<ContextRing usedPercentage={38} tokens={{ used: 76_000, total: 200_000 }} />)
  try {
    const ring = view.container.querySelector<HTMLElement>('[role="img"]')!
    expect(ring.getAttribute('aria-label')).toBe(`Context 38% used, ${contextRingTokensLabel(76_000, 200_000)}`)
    await view.act(async () => ring.focus())
    const tooltip = dom.window.document.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toBe(contextRingTokensLabel(76_000, 200_000))
  } finally {
    await view.unmount()
  }
  // Without counts the ring keeps its one sentence, as the peek card draws it.
  const bare = await mount(<ContextRing usedPercentage={38} />)
  try {
    expect(bare.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Context 38% used')
  } finally {
    await bare.unmount()
  }
})

test('the diff pill draws only the halves that have something to say', async () => {
  const { DiffStatPill } = await import('./DiffStatPill')
  const halves = async (added: number, removed: number) => {
    const view = await mount(<DiffStatPill added={added} removed={removed} ariaLabel="changes" />)
    const pill = view.container.querySelector('[data-diff-stat-pill]')
    const result = pill ? Array.from(pill.querySelectorAll('span')).map((span) => span.textContent) : null
    await view.unmount()
    return result
  }
  expect(await halves(3, 2)).toEqual(['+3', '−2'])
  expect(await halves(3, 0)).toEqual(['+3'])
  expect(await halves(0, 2)).toEqual(['−2'])
  expect(await halves(0, 0)).toBeNull()
})

test('the diff pill groups the digits of a big count, in tabular figures', async () => {
  const { DiffStatPill } = await import('./DiffStatPill')
  const view = await mount(<DiffStatPill added={83_065} removed={1_204} ariaLabel="changes" />)
  try {
    const pill = view.container.querySelector('[data-diff-stat-pill]')!
    expect(Array.from(pill.querySelectorAll('span')).map((span) => span.textContent)).toEqual([
      `+${(83_065).toLocaleString()}`,
      `−${(1_204).toLocaleString()}`,
    ])
    expect(pill.className).toContain('tabular-nums')
  } finally {
    await view.unmount()
  }
})

test('the clickable diff pill is one named button, its halves the diff channel’s inks on their washes', async () => {
  const { DiffStatPill } = await import('./DiffStatPill')
  let opened = 0
  const view = await mount(
    <DiffStatPill
      added={3}
      removed={2}
      ariaLabel="3 files added, 2 removed — open changes"
      onClick={() => {
        opened += 1
      }}
    />,
  )
  try {
    const buttons = view.container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-label')).toBe('3 files added, 2 removed — open changes')
    await view.act(async () => buttons[0]!.click())
    expect(opened).toBe(1)
    const [plus, minus] = Array.from(buttons[0]!.querySelectorAll('span span'))
    expect(plus!.className).toContain('bg-[color:var(--tone-good-soft)]')
    expect(plus!.className).toContain('text-[color:var(--diff-added)]')
    expect(minus!.className).toContain('bg-[color:var(--tone-error-soft)]')
    expect(minus!.className).toContain('text-[color:var(--diff-removed)]')
    expect(buttons[0]!.className).toContain('rounded-[var(--sem-radius-pill)]')
  } finally {
    await view.unmount()
  }
})

test('front truncation keeps the end of the text, and a screen reader hears the whole', async () => {
  const { frontTruncate, FrontTruncatedText } = await import('./FrontTruncatedText')
  expect(frontTruncate('fix/cli-update-output', 18)).toBe('…cli-update-output')
  expect(frontTruncate('fix/cli-update-output', 8, 4)).toBe('…-output')
  expect(frontTruncate('fix/cli-update-output', 3, 4)).toBeNull()
  // Unmeasured (jsdom): the whole text, once.
  const view = await mount(<FrontTruncatedText text="fix/cli-update-output" />)
  try {
    expect(view.container.textContent).toBe('fix/cli-update-output')
  } finally {
    await view.unmount()
  }
})

test('the composer strip is one line: it never wraps, and its items keep to one line', async () => {
  const { ComposerStrip } = await import('../workspace/agentComposer/ComposerStrip')
  const view = await mount(
    <ComposerStrip>
      <span>item</span>
    </ComposerStrip>,
  )
  try {
    const strip = view.container.querySelector<HTMLElement>('[data-composer-strip]')!
    const classes = strip.className.split(/\s+/)
    expect(classes).toContain('flex-nowrap')
    expect(classes).toContain('whitespace-nowrap')
    expect(classes).not.toContain('flex-wrap')
  } finally {
    await view.unmount()
  }
  // And neither composer brings a wrap of its own to the strip: the New chat
  // strip and the conversation strip are both this container, and no item on
  // the conversation strip but the branch may shrink.
  const read = (path: string) => readFileSync(join(process.cwd(), 'src/renderer/src/components', path), 'utf8')
  const newChat = read('workspace/agentComposer/NewAgentPanel.tsx')
  expect(newChat).toContain('<ComposerStrip>')
  expect(newChat).not.toContain('data-composer-strip="true"')
  const strip = read('panels/agentChat/conversationStrip.tsx')
  expect(strip).toContain('<ComposerStrip ')
  expect(strip).not.toMatch(/flex-wrap/)
  // Every item wrapper on the conversation strip is `shrink-0` except the branch.
  for (const item of ['ref={machineRef}', 'ref={changesRef}', 'ref={overflowRef}', 'ref={ringRef}']) {
    const at = strip.indexOf(item)
    expect(at, item).toBeGreaterThan(-1)
    expect(strip.slice(at, at + 400), item).toMatch(/shrink-0/)
  }
})
