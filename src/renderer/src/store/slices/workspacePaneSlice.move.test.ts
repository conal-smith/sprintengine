import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'
import { createWorkspacePaneSlice } from './workspacePaneSlice'

// Dragging a pane tab to a new place: the strip keeps the order it was put in,
// and the move changes nothing but the order.

const WS = 'ws-move'

function carrierWith(paneState: WorkspacePaneState) {
  const workspace = { id: WS, paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { slice, pane: () => carrier.workspaces[0].paneState! }
}

const THREE: WorkspacePaneState = {
  open: true,
  activeTabId: 'files',
  tabs: [
    { id: 'files', kind: 'files' },
    { id: 'term', kind: 'terminal', terminalId: 'term-1' },
    { id: 'page', kind: 'browser', url: 'http://localhost:5173/' },
  ],
}

const order = (pane: WorkspacePaneState) => pane.tabs.map((tab) => tab.id)

test('a tab moves to the index it is dropped at, either way', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE))
  slice.movePaneTab(WS, 'page', 0)
  assert.deepEqual(order(pane()), ['page', 'files', 'term'])
  slice.movePaneTab(WS, 'page', 2)
  assert.deepEqual(order(pane()), ['files', 'term', 'page'])
})

test('moving a tab leaves the tab in front and the pane as they were', () => {
  const { slice, pane } = carrierWith(structuredClone({ ...THREE, open: false }))
  slice.movePaneTab(WS, 'files', 2)
  assert.equal(pane().activeTabId, 'files')
  assert.equal(pane().open, false)
})

test('an index past either end lands at that end', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE))
  slice.movePaneTab(WS, 'files', 99)
  assert.deepEqual(order(pane()), ['term', 'page', 'files'])
  slice.movePaneTab(WS, 'files', -4)
  assert.deepEqual(order(pane()), ['files', 'term', 'page'])
})

test('a drop where the tab already is, or of a tab that is gone, writes nothing', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE))
  const before = pane()
  slice.movePaneTab(WS, 'term', 1)
  slice.movePaneTab(WS, 'gone', 0)
  slice.movePaneTab(WS, 'term', Number.NaN)
  assert.equal(pane(), before)
})

test('a tab opened after a move joins the end and leaves the moved order alone', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE))
  slice.movePaneTab(WS, 'page', 0)
  const opened = slice.openPaneTab(WS, { kind: 'diff' })
  assert.deepEqual(order(pane()), ['page', 'files', 'term', opened])
  // Opening a singleton that is already there focuses it where it was put.
  slice.openPaneTab(WS, { kind: 'files' })
  assert.deepEqual(order(pane()), ['page', 'files', 'term', opened])
  assert.equal(pane().activeTabId, 'files')
})
