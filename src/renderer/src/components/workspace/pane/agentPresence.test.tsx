import assert from 'node:assert/strict'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, test, vi } from 'vitest'

import { Tabs } from '../../ui/Tabs'
import { browserPresenceKey, createAgentPresenceStore, paneTabPresenceKey } from './agentPresence'
import { paneTabItem } from './paneTabItem'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('an agent taking a page lights it at once', () => {
  const store = createAgentPresenceStore(1_000)
  let changes = 0
  store.subscribe(() => (changes += 1))
  store.observe('page', 'agent')
  assert.equal(store.isLit('page'), true)
  assert.equal(changes, 1)
  store.observe('page', 'agent')
  assert.equal(changes, 1, 'a repeat claim changes nothing')
})

test('a claim lapsing between two steps keeps the mark for the linger, then lets it go', () => {
  const store = createAgentPresenceStore(1_000)
  store.observe('page', 'agent')
  store.observe('page', 'none')
  vi.advanceTimersByTime(900)
  assert.equal(store.isLit('page'), true, 'the model is thinking: still here')
  store.observe('page', 'agent')
  vi.advanceTimersByTime(5_000)
  assert.equal(store.isLit('page'), true, 'back before the linger ran out: the lapse is forgotten')
  store.observe('page', 'none')
  vi.advanceTimersByTime(1_000)
  assert.equal(store.isLit('page'), false, 'a quiet linger: gone')
})

test('the person taking the page back clears the mark at once', () => {
  const store = createAgentPresenceStore(1_000)
  store.observe('page', 'agent')
  store.observe('page', 'none')
  store.observe('page', 'human')
  assert.equal(store.isLit('page'), false)
  vi.advanceTimersByTime(2_000)
  assert.equal(store.isLit('page'), false, 'and no timer brings it back')
})

test('a page nobody but the person has held is never tracked', () => {
  const store = createAgentPresenceStore(1_000)
  store.observe('page', 'human')
  store.observe('page', 'none')
  assert.equal(store.isLit('page'), false)
})

test('only pages and boards have a presence', () => {
  assert.equal(paneTabPresenceKey('ws', { id: 't1', kind: 'browser' }), browserPresenceKey('t1'))
  assert.notEqual(paneTabPresenceKey('ws', { id: 't2', kind: 'canvas', canvas: { path: '/b.excalidraw' } }), null)
  assert.equal(paneTabPresenceKey('ws', { id: 't3', kind: 'files' }), null)
})

test('a tab an agent is using wears the pill and says so; a popped-out one does not', () => {
  const page = { id: 'p', kind: 'browser' as const, url: 'https://example.com', title: 'Example' }
  const lit = paneTabItem(page, { diffCount: null, agentPresent: true })
  assert.equal(lit.agent, true)
  assert.match(lit.ariaLabel ?? '', /an agent is using this/)
  const html = renderToStaticMarkup(
    <Tabs ariaLabel="Pane" items={[lit]} value="p" onChange={() => {}} onCloseItem={() => {}} />,
  )
  assert.match(html, /data-agent-pill/)
  assert.match(html, />Agent</)

  const out = paneTabItem({ ...page, poppedOut: 'popout-1' }, { diffCount: null, agentPresent: true })
  assert.equal(out.agent, undefined, 'its own window says it, where the page is')
  const plain = paneTabItem(page, { diffCount: null })
  assert.doesNotMatch(
    renderToStaticMarkup(<Tabs ariaLabel="Pane" items={[plain]} value="p" onChange={() => {}} />),
    /data-agent-pill/,
  )
})
