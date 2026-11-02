import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkspaceAsideColumn } from './workspaceAsideColumn'
import {
  WORKSPACE_ASIDE_DEFAULT_WIDTH,
  WORKSPACE_ASIDE_MIN_WIDTH,
  clampWorkspaceAsideWidth,
} from './workspaceAsideWidth'
import { test } from 'vitest'

test('workspaceAsideColumn', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  // Retiring the aside that lived here kept the column as a
  // mount seam. No module claims the column today, so these are the tests that
  // keep the chrome a future tenant inherits — the labelled landmark, the width,
  // and the keyboard-reachable resize edge — from rotting while it is empty.
  run('renders a labelled column at the requested width around its tenant', () => {
    const html = renderToStaticMarkup(
      <WorkspaceAsideColumn label="Skills" width={320} onWidthChange={() => {}}>
        <div data-testid="tenant">tenant content</div>
      </WorkspaceAsideColumn>,
    )
    // The column is a labelled complementary landmark, not a dialog: it consumes
    // window width beside the workspace card rather than covering it.
    assert.match(html, /<aside aria-label="Skills"/, 'the column is a labelled landmark')
    assert.doesNotMatch(html, /role="dialog"|aria-modal/, 'the column is chrome, never a dialog')
    assert.match(html, /width:320px/, 'the caller-supplied width drives the column')
    assert.match(html, /data-testid="tenant"/, 'the tenant fills the column')
  })

  run('exposes a keyboard-operable resize edge named for the tenant', () => {
    const html = renderToStaticMarkup(
      <WorkspaceAsideColumn label="Skills" width={WORKSPACE_ASIDE_DEFAULT_WIDTH} onWidthChange={() => {}}>
        <div />
      </WorkspaceAsideColumn>,
    )
    assert.match(html, /role="separator"/, 'the resize edge is a separator')
    assert.match(html, /aria-orientation="vertical"/, 'the separator is vertical')
    assert.match(html, /aria-label="Resize Skills panel"/, 'the separator names what it resizes')
    assert.match(html, /tabindex="0"/, 'the separator is reachable by keyboard, not pointer-only')
  })

  run('floors a narrow width and leaves a wide one to the row', () => {
    assert.equal(clampWorkspaceAsideWidth(10), WORKSPACE_ASIDE_MIN_WIDTH)
    assert.equal(clampWorkspaceAsideWidth(10_000), 10_000, 'there is no fixed ceiling')
    assert.equal(clampWorkspaceAsideWidth(Number.NaN), WORKSPACE_ASIDE_DEFAULT_WIDTH)
    assert.equal(clampWorkspaceAsideWidth(321.4), 321, 'a fractional width rounds to whole pixels')
    const html = renderToStaticMarkup(
      <WorkspaceAsideColumn label="Skills" width={10_000} onWidthChange={() => {}}>
        <div />
      </WorkspaceAsideColumn>,
    )
    assert.match(html, /width:10000px/, 'the chosen width is drawn as chosen')
    assert.match(html, /max-width:100%/, 'and capped by the row it sits in')
  })

  console.log('workspace aside mount tests passed')
})
