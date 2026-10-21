import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import type { Workspace } from '../../../types/workspace'
import { getNextWorkspaceId } from './layoutTabActions'
import { drawnSidebarChatIds, numberedChatIds, numberedChatRows } from './numberedChats'

const NOW = 1_000_000

function workspace(id: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, name: id, ...extra } as Workspace
}

test('the sidebar rows are read top to bottom, as drawn', () => {
  const dom = new JSDOM(`
    <nav role="tree" data-workspace-tree>
      <section role="group" aria-label="Starred workspaces">
        <div role="treeitem" data-workspace-id="ws-starred"></div>
      </section>
      <div role="treeitem" data-row-key="folder:acme">acme</div>
      <div role="treeitem" data-workspace-id="ws-newest"></div>
      <div role="treeitem" data-workspace-id="ws-older"></div>
    </nav>
  `)
  assert.deepEqual(drawnSidebarChatIds(dom.window.document), ['ws-starred', 'ws-newest', 'ws-older'])
})

test('a document with no sidebar tree has no drawn order', () => {
  const dom = new JSDOM(`<nav role="tree"><div role="treeitem" data-workspace-id="ws-a"></div></nav>`)
  assert.equal(drawnSidebarChatIds(dom.window.document), null)
})

test('the number keys follow the drawn order, not the store order', () => {
  const workspaces = [workspace('ws-a'), workspace('ws-b'), workspace('ws-c')]
  assert.deepEqual(numberedChatIds(['ws-c', 'ws-a', 'ws-b'], workspaces, NOW), ['ws-c', 'ws-a', 'ws-b'])
})

test('a chat that is not drawn — in a collapsed project — gets no number', () => {
  const workspaces = [workspace('ws-a'), workspace('ws-b'), workspace('ws-c')]
  assert.deepEqual(numberedChatIds(['ws-c', 'ws-a'], workspaces, NOW), ['ws-c', 'ws-a'])
})

test('settled and snoozed rows are passed over even on an open shelf', () => {
  const workspaces = [
    workspace('ws-a'),
    workspace('ws-settled', { settledAt: NOW - 10 }),
    workspace('ws-asleep', { snoozedUntil: NOW + 60_000 }),
    workspace('ws-woken', { snoozedUntil: NOW - 60_000 }),
  ]
  assert.deepEqual(numberedChatIds(['ws-a', 'ws-settled', 'ws-asleep', 'ws-woken'], workspaces, NOW), [
    'ws-a',
    'ws-woken',
  ])
})

test('a row drawn twice counts once, and an id the store does not hold is dropped', () => {
  const workspaces = [workspace('ws-a'), workspace('ws-b')]
  assert.deepEqual(numberedChatIds(['ws-a', 'ws-gone', 'ws-a', 'ws-b'], workspaces, NOW), ['ws-a', 'ws-b'])
})

test('with no sidebar to read, the store order stands in without resting chats', () => {
  const workspaces = [workspace('ws-a'), workspace('ws-settled', { settledAt: NOW }), workspace('ws-b')]
  assert.deepEqual(numberedChatIds(null, workspaces, NOW), ['ws-a', 'ws-b'])
})

test('next and previous step through the drawn order from the chat on screen, even a settled one', () => {
  const workspaces = [
    workspace('ws-a'),
    workspace('ws-b'),
    workspace('ws-on-screen', { settledAt: NOW - 10 }),
    workspace('ws-asleep', { snoozedUntil: NOW + 60_000 }),
  ]
  const drawn = ['ws-b', 'ws-on-screen', 'ws-asleep', 'ws-a']
  const order = numberedChatIds(drawn, workspaces, NOW, 'ws-on-screen').map((id) =>
    workspaces.find((candidate) => candidate.id === id)!,
  )
  assert.deepEqual(
    order.map((candidate) => candidate.id),
    ['ws-b', 'ws-on-screen', 'ws-a'],
  )
  assert.equal(getNextWorkspaceId(order, 'ws-on-screen', 1), 'ws-a', 'the sleeping row is passed over')
  assert.equal(getNextWorkspaceId(order, 'ws-on-screen', -1), 'ws-b')
  assert.equal(getNextWorkspaceId(order, 'ws-a', 1), 'ws-b', 'and it wraps')
})

test('the numbered rows are the rows the number keys open, in order', () => {
  const dom = new JSDOM(`
    <nav role="tree" data-workspace-tree>
      <div role="treeitem" data-row-key="starred-ws-b" data-workspace-id="ws-b"></div>
      <div role="treeitem" data-row-key="folder:acme">acme</div>
      <div role="treeitem" data-row-key="ws-a" data-workspace-id="ws-a"></div>
      <div role="treeitem" data-row-key="ws-settled" data-workspace-id="ws-settled"></div>
      <div role="treeitem" data-row-key="ws-b" data-workspace-id="ws-b"></div>
      <div role="treeitem" data-row-key="ws-c" data-workspace-id="ws-c"></div>
    </nav>
  `)
  const workspaces = [
    workspace('ws-a'),
    workspace('ws-b'),
    workspace('ws-c'),
    workspace('ws-settled', { settledAt: NOW - 10 }),
  ]
  const rows = numberedChatRows(dom.window.document, workspaces, NOW)
  // A starred chat is numbered where it is first drawn, and only there.
  assert.deepEqual(
    rows.map((row) => row.rowKey),
    ['starred-ws-b', 'ws-a', 'ws-c'],
  )
  // Row N is exactly the chat Primary+N switches to.
  assert.deepEqual(
    rows.map((row) => row.workspaceId),
    numberedChatIds(drawnSidebarChatIds(dom.window.document), workspaces, NOW),
  )
})

test('with no sidebar tree there are no numbered rows to label', () => {
  const dom = new JSDOM(`<nav role="tree"><div role="treeitem" data-workspace-id="ws-a"></div></nav>`)
  assert.deepEqual(numberedChatRows(dom.window.document, [workspace('ws-a')], NOW), [])
})
