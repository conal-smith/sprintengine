import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { OpenAuxWindowInput } from '../../../../shared/electron-api'
import type { WorkspaceId } from '../../types/workspace'
import { openGitDiff } from '../../utils/openGitDiff'
import { useWorkspaceStore } from '../workspaceStore'
import { normalizeWorkspacePaneState, partializeWorkspacePaneState } from './workspacePaneSlice'

// An agent's editor.open_diff in the pane: what it asked for — the changelist,
// the `paths` narrowing, the step and the range — has to survive the pane's own
// normalizer, which every pane write runs, and must not survive a restart.

const reveal = {
  key: 'req-1',
  paths: ['src/a.ts'],
  step: { kind: 'commit' as const, hash: 'a'.repeat(40) },
  range: { startLine: 7, endLine: 9 },
  side: 'modified' as const,
}

const diffTab = {
  id: 'tab-diff',
  kind: 'diff' as const,
  diff: {
    repoRoot: '/Users/dev/repo',
    focusPath: '/Users/dev/repo/src/a.ts',
    focusKind: 'unstaged' as const,
    changelistId: 'agent:agent-7',
    reveal,
  },
}

test('the pane keeps an agent reveal and its changelist through normalization', () => {
  const pane = normalizeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [diffTab] })
  assert.deepEqual(pane?.tabs[0].diff, diffTab.diff)
})

test('a restart restores the Diff tab but not the reveal', () => {
  const persisted = partializeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [diffTab] })
  const { reveal: _reveal, ...withoutReveal } = diffTab.diff
  assert.deepEqual(persisted?.tabs[0].diff, withoutReveal)
})

test('the step the viewer has open rides the tab for the session, and a restart drops it', () => {
  const kept = { step: { kind: 'commit' as const, hash: 'b'.repeat(40) }, afterReveal: 'req-1' }
  const withKept = { ...diffTab, diff: { ...diffTab.diff, kept } }
  const pane = normalizeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [withKept] })
  assert.deepEqual(pane?.tabs[0].diff?.kept, kept)
  // A malformed one is dropped, not the tab.
  const bad = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'tab-diff',
    tabs: [{ ...diffTab, diff: { ...diffTab.diff, kept: { step: { kind: 'sideways' } } } }],
  })
  assert.equal(bad?.tabs[0].diff?.kept, undefined)
  assert.equal(bad?.tabs[0].id, 'tab-diff')
  const persisted = partializeWorkspacePaneState({ open: true, activeTabId: 'tab-diff', tabs: [withKept] })
  assert.equal(persisted?.tabs[0].diff?.kept, undefined)
  assert.equal(persisted?.tabs[0].diff?.reveal, undefined)
})

test('an agent diff never takes focus, and a branch or commit view goes to the pane', () => {
  const auxCalls: OpenAuxWindowInput[] = []
  const paneCalls: Array<{ workspaceId: string; input: Record<string, unknown> }> = []
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      api: {
        openAuxWindow: async (input: OpenAuxWindowInput) => {
          auxCalls.push(input)
          return { ok: true as const, retargeted: false }
        },
      },
    },
    configurable: true,
  })
  useWorkspaceStore.setState({
    openPaneTab: (workspaceId: WorkspaceId, input: Record<string, unknown>) => {
      paneCalls.push({ workspaceId, input })
      return 'tab-diff'
    },
  } as unknown as Partial<ReturnType<typeof useWorkspaceStore.getState>>)
  useWorkspaceStore.getState().setDiffOpensInWindow(true)
  const base = {
    workspaceId: 'ws-1',
    repoRoot: '/Users/dev/repo',
    focusPath: '/Users/dev/repo/src/a.ts',
    scope: 'unstaged' as const,
  }

  // Working tree, window preferred: the window, retargeted without focus.
  openGitDiff({
    ...base,
    reveal: { key: 'req-2', paths: ['src/a.ts'], step: { kind: 'uncommitted' } },
    takeFocus: false,
  })
  assert.equal(auxCalls.length, 1)
  assert.equal(auxCalls[0].focus, false)
  assert.equal(auxCalls[0].params.revealKey, 'req-2')
  assert.equal(auxCalls[0].params.revealPaths, JSON.stringify(['src/a.ts']))

  // A commit step only the pane can show: the pane, whatever the preference.
  openGitDiff({ ...base, reveal, takeFocus: false })
  assert.equal(auxCalls.length, 1)
  assert.equal(paneCalls.length, 1)
  assert.deepEqual((paneCalls[0].input.diff as { reveal: unknown }).reveal, reveal)
  assert.equal(paneCalls[0].input.activate, undefined, 'in front when the person is not typing')

  // Typing: behind the tab they are on.
  openGitDiff({ ...base, reveal, takeFocus: false, background: true })
  assert.equal(paneCalls[1].input.activate, false)
})
