// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, test, vi } from 'vitest'

// Every source the reply renderer is asked to parse, to tell what was parsed
// from what was only held.
const parsed = vi.hoisted(() => [] as string[])
vi.mock('../../../utils/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/markdown')>()
  return {
    ...actual,
    renderMarkdown: (source: string, options?: Parameters<typeof actual.renderMarkdown>[1]) => {
      parsed.push(source)
      return actual.renderMarkdown(source, options)
    },
  }
})

const { renderMarkdown } = await import('../../../utils/markdown')
const { StreamingMarkdown } = await import('./StreamingMarkdown')

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  parsed.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const draw = (source: string, hold: boolean) =>
  act(() => root.render(<StreamingMarkdown source={source} options={{ streaming: true }} hold={hold} />))

const markup = (source: string) => renderToStaticMarkup(<>{renderMarkdown(source)}</>).replace(/\s+/gu, ' ')

test('held, only finished blocks are drawn, as a whole parse of them draws them', () => {
  const source = 'First paragraph.\n\n- one\n- two\n\nStill being writ'
  const held = renderToStaticMarkup(<StreamingMarkdown source={source} hold />).replace(/\s+/gu, ' ')
  assert.equal(held, markup('First paragraph.\n\n- one\n- two\n\n'))
  assert.ok(!held.includes('Still'))
})

test('held with nothing finished, nothing is drawn', () => {
  draw('The first words of a', true)
  assert.equal(host.textContent, '')
  assert.deepEqual(parsed, [])
})

test('the unfinished text is never parsed, and a finished block is parsed once', () => {
  const stream = 'One.\n\nTwo is a longer paragraph that streams in.\n\nThree'
  for (let length = 1; length <= stream.length; length += 1) draw(stream.slice(0, length), true)
  assert.ok(!parsed.some((source) => source.includes('Three')), 'the paragraph still streaming is not parsed')
  assert.ok(
    parsed.every((source) => !source.includes('Two') || source.includes('streams in.')),
    'nor any part of one before it finished',
  )
  // A block is parsed as it finishes, and once more as the next one freezes
  // it: a handful of parses for the whole stream, not one per token.
  assert.ok(parsed.length <= 4, `${parsed.length} parses for ${stream.length} tokens`)
  assert.equal(host.textContent?.includes('Two is a longer paragraph that streams in.'), true)
  assert.equal(host.textContent?.includes('Three'), false)
})

test('once the reply finishes, everything is drawn, held text included', () => {
  draw('One.\n\nTwo is still', true)
  assert.equal(host.textContent?.includes('Two'), false)
  draw('One.\n\nTwo is still going.', false)
  assert.equal(host.innerHTML.replace(/\s+/gu, ' '), markup('One.\n\nTwo is still going.'))
})

test('as it is written, every token is drawn', () => {
  draw('One.\n\nTwo is still', false)
  assert.equal(host.textContent?.includes('Two is still'), true)
})
