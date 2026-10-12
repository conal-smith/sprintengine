import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { GitChangesToolbar, type GitChangesToolbarProps } from './GitChangesToolbar'
import type { Changelist } from '../../../../../shared/git/changelists'
import { test } from 'vitest'

test('GitChangesToolbar', async () => {
  // The Commit window's glyph band (epic `git-commit-window`, T5/T6; adversarial
  // review). SSR: the band's arrow walk is `Toolbar`'s and is proved with a DOM
  // in `ui/Toolbar.test.tsx`; what is unproved is what THIS band hands it —
  // The nine controls in workflow order, one divider in the right place, and the
  // two attributes that decide whether the unavailable item stays reachable.

  const dom = new JSDOM('<!doctype html><html><body></body></html>')

  const LISTS: Changelist[] = [
    { id: 'default', name: 'Changes', paths: [], active: true },
    { id: 'spike', name: 'Spike', paths: [], active: false },
  ]

  const NOOP = (): void => {}

  function render(over: Partial<GitChangesToolbarProps> = {}): Element {
    const props: GitChangesToolbarProps = {
      busy: false,
      hasTarget: true,
      changelists: LISTS,
      currentChangelistId: 'default',
      untrackedOnly: false,
      grouping: 'changelist',
      commitMessageDraft: { drafting: false, unavailableReason: null },
      onWriteCommitMessage: NOOP,
      onStopCommitMessage: NOOP,
      onRefresh: NOOP,
      onDiscard: NOOP,
      onStash: NOOP,
      onShowDiff: NOOP,
      onMoveToChangelist: NOOP,
      onMoveToNewChangelist: NOOP,
      onGroupingChange: NOOP,
      onExpandAll: NOOP,
      onCollapseAll: NOOP,
      ...over,
    }
    const host = dom.window.document.createElement('div')
    host.innerHTML = renderToStaticMarkup(React.createElement(GitChangesToolbar, props))
    const band = host.querySelector('[role="toolbar"]')
    assert.ok(band, 'the band rendered nothing')
    return band
  }

  const labels = (band: Element): string[] =>
    Array.from(band.querySelectorAll('button')).map((button) => button.getAttribute('aria-label') ?? '')

  // ── Nine controls in workflow order, with one divider ───────────────────
  {
    const band = render()
    assert.deepEqual(
      labels(band),
      [
        'Refresh the working tree',
        'Discard changes in the selected files',
        'Move to another changelist',
        'Stash all changes',
        'Write commit message',
        'Show diff',
        'Group by changelist',
        'Expand all groups',
        'Collapse all groups',
      ],
      'six that act on the files, then three that act on the view',
    )

    assert.equal(band.getAttribute('aria-label'), 'Changed files', 'the band names the region, never "Toolbar"')

    // The divider is the only thing in a band of identical squares that can say
    // which three are which, so there is exactly one and it is between six and
    // seven.
    const children = Array.from(band.children)
    const dividers = children.filter((child) => (child.getAttribute('class') ?? '').includes('w-px'))
    assert.equal(dividers.length, 1, 'one divider — a second would be a ladder')
    assert.equal(dividers[0].getAttribute('aria-hidden'), 'true', 'and it is decoration')
    const buttonsBeforeDivider = children
      .slice(0, children.indexOf(dividers[0]))
      .filter((child) => child.querySelector('button') !== null).length
    assert.equal(buttonsBeforeDivider, 6, 'the divider falls after the sixth item')

    // Every item is glyph-only, so every one carries a name and a tooltip.
    for (const button of Array.from(band.querySelectorAll('button'))) {
      assert.ok(button.getAttribute('aria-label'), 'an icon-only control with no name is a blank button')
      assert.equal(button.querySelector('svg')?.getAttribute('aria-hidden'), 'true', 'the glyph never speaks')
    }

    // The three that open menus say so.
    const menus = Array.from(band.querySelectorAll('button[aria-haspopup="menu"]')).map((button) =>
      button.getAttribute('aria-label'),
    )
    assert.deepEqual(menus, ['Move to another changelist', 'Show diff', 'Group by changelist'])
  }

  // ── the unavailable item is still in the walk ────────────────────────────────
  //
  // `Toolbar` drops an item carrying the `disabled` ATTRIBUTE from its walk,
  // because the DOM will not focus one. "Write commit message" is glyph-only and
  // its tooltip is the only explanation of why it does nothing — so it is
  // soft-disabled, and both halves of that have to hold.
  {
    const band = render({
      commitMessageDraft: { drafting: false, unavailableReason: 'check the files to commit first' },
    })
    const write = Array.from(band.querySelectorAll('button')).find((button) =>
      (button.getAttribute('aria-label') ?? '').startsWith('Write commit message'),
    )
    assert.ok(write)
    assert.equal(write!.getAttribute('aria-disabled'), 'true', 'it says it is unavailable')
    assert.equal(write!.hasAttribute('disabled'), false, 'and stays focusable, or the tooltip can never open')
    assert.equal(
      write!.getAttribute('aria-label'),
      'Write commit message — check the files to commit first',
      'the reason is in the name too, for a reader who never sees a tooltip',
    )

    // The rest of the band uses the hard kind where the reason needs no words.
    const discard = Array.from(band.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Discard changes in the selected files',
    )
    assert.equal(discard!.hasAttribute('disabled'), false, 'with a target, discard is available')
    const noTarget = render({ hasTarget: false })
    const discardAlone = Array.from(noTarget.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Discard changes in the selected files',
    )
    assert.equal(discardAlone!.hasAttribute('disabled'), true, 'with nothing picked, it has nothing to act on')
  }

  // ── the move is soft-disabled when every picked file is untracked ────────────
  {
    const band = render({ untrackedOnly: true })
    const move = Array.from(band.querySelectorAll('button')).find((button) =>
      (button.getAttribute('aria-label') ?? '').startsWith('Move to another changelist'),
    )
    assert.equal(move!.getAttribute('aria-disabled'), 'true')
    assert.equal(move!.hasAttribute('disabled'), false, 'so its tooltip opens and says why')
    assert.match(move!.getAttribute('aria-label') ?? '', /tracked files only/)
  }

  // ── the group-by item names the arrangement in force ─────────────────────────
  {
    assert.ok(labels(render({ grouping: 'directory' })).includes('Group by directory'))
    assert.ok(labels(render({ grouping: 'none' })).includes('Group by none'))
  }

  console.log('ok - the Commit band is nine items, one divider, and one reachable explanation')
})

// ── "Write commit message", one state at a time ────────────────────────────────

const WRITE_PROPS: GitChangesToolbarProps = {
  busy: false,
  hasTarget: false,
  changelists: [{ id: 'default', name: 'Changes', paths: [], active: true }],
  currentChangelistId: null,
  untrackedOnly: false,
  grouping: 'changelist',
  commitMessageDraft: { drafting: false, unavailableReason: null },
  onWriteCommitMessage: () => {},
  onStopCommitMessage: () => {},
  onRefresh: () => {},
  onDiscard: () => {},
  onStash: () => {},
  onShowDiff: () => {},
  onMoveToChangelist: () => {},
  onMoveToNewChangelist: () => {},
  onGroupingChange: () => {},
  onExpandAll: () => {},
  onCollapseAll: () => {},
}

function writeButton(over: Partial<GitChangesToolbarProps>): HTMLButtonElement {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const host = dom.window.document.createElement('div')
  host.innerHTML = renderToStaticMarkup(React.createElement(GitChangesToolbar, { ...WRITE_PROPS, ...over }))
  const button = Array.from(host.querySelectorAll('button')).find((node) =>
    /commit message/i.test(node.getAttribute('aria-label') ?? ''),
  )
  assert.ok(button, 'the band has a commit message control')
  return button as unknown as HTMLButtonElement
}

test('with something checked and an agent to ask, the button is live', () => {
  const button = writeButton({})
  assert.equal(button.getAttribute('aria-label'), 'Write commit message')
  assert.equal(button.hasAttribute('aria-disabled'), false)
  assert.equal(button.hasAttribute('disabled'), false)
  assert.equal(button.hasAttribute('aria-busy'), false)
})

test('each reason it cannot draft is its accessible name, and it stays reachable', () => {
  for (const reason of [
    'check the files to commit first',
    'text generation is off in Settings → Agents',
    'needs Claude Code or Codex installed',
  ]) {
    const button = writeButton({ commitMessageDraft: { drafting: false, unavailableReason: reason } })
    assert.equal(button.getAttribute('aria-label'), `Write commit message — ${reason}`)
    assert.equal(button.getAttribute('aria-disabled'), 'true')
    assert.equal(button.hasAttribute('disabled'), false, 'soft, so the tooltip can say why')
  }
})

test('while another git action runs it is hard-disabled like its neighbours', () => {
  assert.equal(writeButton({ busy: true }).hasAttribute('disabled'), true)
})

test('while a draft is written it shows the working spinner and becomes the stop', () => {
  const button = writeButton({ busy: true, commitMessageDraft: { drafting: true, unavailableReason: null } })
  assert.equal(button.getAttribute('aria-label'), 'Stop writing the commit message')
  assert.equal(button.hasAttribute('disabled'), false, 'the stop stays pressable whatever else is running')
  assert.match(button.querySelector('svg')?.getAttribute('class') ?? '', /lifecycle-spin/, 'the kit spinner')
})

test('pressing it drafts, and pressing it mid-draft stops; a soft-disabled press does nothing', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const { act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const calls: string[] = []
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const show = async (over: Partial<GitChangesToolbarProps>) =>
      act(async () =>
        root.render(
          <GitChangesToolbar
            {...WRITE_PROPS}
            onWriteCommitMessage={() => calls.push('write')}
            onStopCommitMessage={() => calls.push('stop')}
            {...over}
          />,
        ),
      )
    const press = async () => {
      const button = Array.from(container.querySelectorAll('button')).find((node) =>
        /commit message/i.test(node.getAttribute('aria-label') ?? ''),
      )
      await act(async () => button?.click())
    }
    await show({})
    await press()
    await show({ commitMessageDraft: { drafting: true, unavailableReason: null } })
    await press()
    await show({ commitMessageDraft: { drafting: false, unavailableReason: 'check the files to commit first' } })
    await press()
    assert.deepEqual(calls, ['write', 'stop'])
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
