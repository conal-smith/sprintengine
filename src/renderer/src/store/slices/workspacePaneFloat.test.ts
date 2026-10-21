import assert from 'node:assert/strict'

import {
  FLOAT_MAX_HEIGHT,
  FLOAT_MAX_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  normalizeWorkspacePaneState,
  partializeWorkspacePaneState,
} from './workspacePaneSlice'
import { test } from 'vitest'

test('workspacePaneFloat', async () => {
  // The floating browser player's persisted half. What is worth pinning is the
  // split between what survives a restart and what does not, and that a rect
  // saved on one machine cannot come back as a player nobody can reach.

  let failures = 0

  function check(name: string, run: () => void): void {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const browserTab = (overrides: Record<string, unknown> = {}) => ({
    id: 'tab-1',
    kind: 'browser',
    url: 'http://localhost:5173/',
    ...overrides,
  })

  check('a float rect survives normalization', () => {
    const state = normalizeWorkspacePaneState({
      open: true,
      activeTabId: 'tab-1',
      tabs: [browserTab({ float: { x: 100, y: 80, width: 400, height: 300 } })],
    })
    assert.deepEqual(state?.tabs[0]?.float, { x: 100, y: 80, width: 400, height: 300 })
  })

  check('a rect saved bigger than the player allows is clamped to the ceiling', () => {
    const state = normalizeWorkspacePaneState({
      open: true,
      activeTabId: 'tab-1',
      tabs: [browserTab({ float: { x: 0, y: 0, width: 99999, height: 99999 } })],
    })
    assert.equal(state?.tabs[0]?.float?.width, FLOAT_MAX_WIDTH)
    assert.equal(state?.tabs[0]?.float?.height, FLOAT_MAX_HEIGHT)
  })

  check('a rect saved smaller than readable is raised to the floor', () => {
    const state = normalizeWorkspacePaneState({
      open: true,
      activeTabId: 'tab-1',
      tabs: [browserTab({ float: { x: 10, y: 10, width: 1, height: 1 } })],
    })
    assert.equal(state?.tabs[0]?.float?.width, FLOAT_MIN_WIDTH)
    assert.equal(state?.tabs[0]?.float?.height, FLOAT_MIN_HEIGHT)
  })

  check('a malformed rect is dropped rather than half-read', () => {
    for (const float of [null, 'nope', {}, { x: 1, y: 2 }, { x: 1, y: 2, width: Number.NaN, height: 3 }]) {
      const state = normalizeWorkspacePaneState({
        open: true,
        activeTabId: 'tab-1',
        tabs: [browserTab({ float })],
      })
      assert.equal(state?.tabs[0]?.float, undefined, `${JSON.stringify(float)} is dropped`)
    }
  })

  check('a canvas tab carries a float too: a board an agent draws on floats', () => {
    const state = normalizeWorkspacePaneState({
      open: false,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          kind: 'canvas',
          canvas: { path: 'plan.excalidraw' },
          float: { x: 1, y: 2, width: 400, height: 300 },
          floating: true,
        },
      ],
    })
    assert.deepEqual(state?.tabs[0]?.float, { x: 1, y: 2, width: 400, height: 300 })
    assert.equal(state?.tabs[0]?.floating, true)
  })

  check('only a browser or canvas tab carries a float', () => {
    const state = normalizeWorkspacePaneState({
      open: true,
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', kind: 'git', float: { x: 1, y: 2, width: 400, height: 300 }, floating: true }],
    })
    assert.equal(state?.tabs[0]?.float, undefined)
    assert.equal(state?.tabs[0]?.floating, undefined)
  })

  check('the rect persists across a restart; "is it floating right now" does not', () => {
    // A cold start showing a collapsed pane and a window floating over the
    // workspace is a confusing first frame, and the spec only promises the rect.
    const persisted = partializeWorkspacePaneState({
      open: false,
      activeTabId: 'tab-1',
      tabs: [browserTab({ floating: true, float: { x: 100, y: 80, width: 400, height: 300 } })],
    })
    assert.deepEqual(persisted?.tabs[0]?.float, { x: 100, y: 80, width: 400, height: 300 })
    assert.equal(persisted?.tabs[0]?.floating, undefined)
  })

  check('partialize still strips the favicon it always did', () => {
    const persisted = partializeWorkspacePaneState({
      open: true,
      activeTabId: 'tab-1',
      tabs: [browserTab({ faviconUrl: 'data:image/png;base64,AAAA' })],
    })
    assert.equal(persisted?.tabs[0]?.faviconUrl, undefined)
    assert.equal(persisted?.tabs[0]?.url, 'http://localhost:5173/')
  })

  if (failures > 0) {
    console.error(`${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('workspace pane float tests passed')
})
