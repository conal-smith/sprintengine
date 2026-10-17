// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningBlock, reasoningPreview } from './reasoningBlock'
import { partitionWorkTimeline, WorkTimeline } from './timelineRows'
import type { TranscriptToolEntry } from './conversationProjection'

const tool = (id: string, name = 'Read'): TranscriptToolEntry => ({
  kind: 'tool',
  id,
  turnId: 'turn',
  name,
  status: 'done',
  input: { path: id },
  summary: id,
})

test('the closed header previews the first line of the reasoning as plain words', () => {
  expect(reasoningPreview('\n\n## Checking the **fixture**\nmore detail')).toBe('Checking the fixture')
  expect(reasoningPreview('- read [the guide](https://example.com) and `a.ts`')).toBe('read the guide and a.ts')
  expect(reasoningPreview('```\ncode first\n```')).toBe('code first')
  expect(reasoningPreview('   ')).toBe('')
})

test('settled reasoning rests closed under "Thought for", live reasoning shimmers "Thinking"', () => {
  const settled = renderToStaticMarkup(
    <ReasoningBlock text={'Look at the test.\nThen the fixture.'} duration="4s" disclosureId="t1" />,
  )
  expect(settled).toContain('aria-expanded="false"')
  expect(settled).toContain('Thought for 4s')
  expect(settled).toContain('Look at the test.')
  expect(settled).not.toContain('Then the fixture.')
  expect(settled).not.toContain('chat-shimmer')

  const live = renderToStaticMarkup(<ReasoningBlock text="Hmm" live disclosureId="t1" />)
  expect(live).toContain('chat-shimmer')
  expect(live).toContain('Thinking')
})

test('reasoning splits the work timeline where it happened, ahead of the prose there', () => {
  const tools = [tool('a'), tool('b'), tool('c', 'Bash')]
  const reasoning = [
    { text: 'Start with the config.', beforeToolUseId: 'a', durationMs: 2000 },
    { text: 'Now run it.', beforeToolUseId: 'c', durationMs: 5000 },
  ]
  const intermediateText = [{ text: 'Running the suite.', beforeToolUseId: 'c' }]
  expect(partitionWorkTimeline(tools, intermediateText, reasoning)).toEqual([
    { text: [], reasoning: [reasoning[0]], tools: tools.slice(0, 2) },
    { text: ['Running the suite.'], reasoning: [reasoning[1]], tools: tools.slice(2) },
  ])
  const html = renderToStaticMarkup(
    <WorkTimeline tools={tools} live={false} intermediateText={intermediateText} reasoning={reasoning} turnId="t1" />,
  )
  const first = html.indexOf('Thought for 2s')
  const group = html.indexOf('Read 2 files')
  const second = html.indexOf('Thought for 5s')
  const prose = html.indexOf('Running the suite.')
  expect(first).toBeGreaterThan(-1)
  expect(first).toBeLessThan(group)
  expect(group).toBeLessThan(second)
  expect(second).toBeLessThan(prose)
})

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

// jsdom lays nothing out, so the opened body is given a 100px window onto
// text 10px tall per character; scrollTop itself is jsdom's own.
async function openLive(disclosureId: string, text: string) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const render = (next: string, live = true) =>
    act(async () => root!.render(<ReasoningBlock text={next} live={live} disclosureId={disclosureId} />))
  await render(text)
  await act(async () => host!.querySelector('button')!.click())
  const body = host.querySelector<HTMLElement>('[aria-expanded="true"] + div')!
  Object.defineProperty(body, 'scrollHeight', { get: () => (body.textContent ?? '').length * 10 })
  Object.defineProperty(body, 'clientHeight', { get: () => 100 })
  return { body, render }
}

test('an opened body follows live reasoning down as it grows past the bottom', async () => {
  const { body, render } = await openLive('follow', 'a'.repeat(20))
  await render('a'.repeat(40))
  expect(body.scrollTop).toBe(400)
  await render('a'.repeat(60))
  expect(body.scrollTop).toBe(600)
})

test('scrolling up to read stops the follow until the person is back at the bottom', async () => {
  const { body, render } = await openLive('scrolled', 'a'.repeat(20))
  await render('a'.repeat(40))
  body.scrollTop = 120
  await act(async () => body.dispatchEvent(new Event('scroll')))
  await render('a'.repeat(60))
  expect(body.scrollTop).toBe(120)

  body.scrollTop = 500
  await act(async () => body.dispatchEvent(new Event('scroll')))
  await render('a'.repeat(80))
  expect(body.scrollTop).toBe(800)
})

test('settled reasoning is left where the person put it', async () => {
  const { body, render } = await openLive('settled', 'a'.repeat(20))
  body.scrollTop = 0
  await render('a'.repeat(60), false)
  expect(body.scrollTop).toBe(0)
})
