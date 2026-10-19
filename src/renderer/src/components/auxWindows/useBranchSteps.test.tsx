// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'
import { useBranchSteps } from './useBranchSteps'

// A pane's Diff tab unmounts its viewer while another tab is shown. The step
// the strip had open comes back with it, and an agent's request the person had
// moved on from is not applied again.

type Kept = { step: BranchStepSelection; afterReveal: string | null }

const SNAPSHOT: BranchStepsSnapshot = {
  branch: 'feat',
  baseOid: 'base000',
  scope: 'worktree',
  steps: [
    { hash: 'aaaaaa1', shortHash: 'aaaaaa', subject: 'first', authoredAt: 1, isMerge: false },
    { hash: 'bbbbbb2', shortHash: 'bbbbbb', subject: 'second', authoredAt: 2, isMerge: false },
  ],
  hasUncommitted: true,
}

let selection: BranchStepSelection | null = null
let select: ((next: BranchStepSelection) => void) | null = null
const keptWrites: Kept[] = []

function Probe(props: { requested: { selection: BranchStepSelection; key: string } | null; kept: Kept | null }) {
  const state = useBranchSteps('/Users/dev/app', true, 1, props.requested, props.kept, (kept) => keptWrites.push(kept))
  selection = state.selection
  select = state.select
  return null
}

let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, {
    api: {
      getBranchSteps: vi.fn(async () => SNAPSHOT),
      getBranchStepDiff: vi.fn(async () => ({ files: [] })),
    },
  })
  container = document.createElement('div')
  keptWrites.length = 0
  selection = null
  select = null
})

afterEach(() => {
  delete (window as { api?: unknown }).api
})

async function mount(props: Parameters<typeof Probe>[0]) {
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe, props))
  })
  return root
}

test('a remount opens on the step the strip had open, not the whole branch', async () => {
  const first = await mount({ requested: null, kept: null })
  expect(selection).toEqual({ kind: 'span' })
  await act(async () => select!({ kind: 'uncommitted' }))
  expect(selection).toEqual({ kind: 'uncommitted' })
  const kept = keptWrites.at(-1)!
  expect(kept).toEqual({ step: { kind: 'uncommitted' }, afterReveal: null })
  act(() => first.unmount())

  await mount({ requested: null, kept })
  expect(selection).toEqual({ kind: 'uncommitted' })
})

test('an agent request is applied once; a remount keeps where the person went from there', async () => {
  const requested = { selection: { kind: 'commit', hash: 'aaaaaa1' } as BranchStepSelection, key: 'reveal-1' }
  const first = await mount({ requested, kept: null })
  expect(selection).toEqual({ kind: 'commit', hash: 'aaaaaa1' })
  await act(async () => select!({ kind: 'commit', hash: 'bbbbbb2' }))
  const kept = keptWrites.at(-1)!
  expect(kept.afterReveal).toBe('reveal-1')
  act(() => first.unmount())

  // The same request still on the tab: the person's step stands.
  const second = await mount({ requested, kept })
  expect(selection).toEqual({ kind: 'commit', hash: 'bbbbbb2' })
  // A new request is applied.
  await act(async () => {
    second.render(createElement(Probe, { requested: { selection: { kind: 'uncommitted' }, key: 'reveal-2' }, kept }))
  })
  expect(selection).toEqual({ kind: 'uncommitted' })
})
