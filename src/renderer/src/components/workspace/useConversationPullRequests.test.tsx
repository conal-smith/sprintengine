import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import type { StudioPullRequest } from '../../../../../packages/studio-protocol/src/public'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import type { PullRequestsChanged, StudioPullRequests } from '../../../../server/pull-requests/pull-request-domain'
import { installStudioLoopback, type StudioLoopback } from '../../../../../tests/studio-chat-loopback'

// The sidebar's rows read a conversation's pull requests from the Studio
// server over the window's own client: asked on mount, again when the server
// names what moved and when the connection comes back, and never blanked by a
// read that failed. A window coming to the front asks the server to look again.

function mark(number: number, state: StudioPullRequest['state'] = 'open'): StudioPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number,
    title: `#${number}`,
    state,
    isDraft: false,
    openedAt: number,
    stateAt: number,
    onConversationBranch: true,
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('useConversationPullRequests', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  // A Studio whose record is a table the test edits.
  const answers: Record<string, StudioPullRequest[]> = { 'ws-1': [mark(4)] }
  const listeners = new Set<(change: PullRequestsChanged) => void>()
  const refreshed: unknown[] = []
  let lists = 0
  let failLists = false
  const pullRequests: StudioPullRequests = {
    list: async (target) => {
      lists += 1
      if (failLists) throw new Error('the record is away')
      const workspaces: Record<string, StudioPullRequest[]> = {}
      for (const id of target.workspaceIds ?? []) if (answers[id]) workspaces[id] = answers[id]
      return { workspaces, conversations: [] }
    },
    refresh: async (target) => {
      refreshed.push(target)
      return { asked: true }
    },
    noteWork: async () => undefined,
    noteToolCall: async () => undefined,
    link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'not here' }),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const emit = () => listeners.forEach((listener) => listener({ workspaceIds: ['ws-1'], conversations: [] }))
  const win = dom.window as unknown as { api: Record<string, unknown> }
  win.api = {}
  const loopback = installStudioLoopback(win, { pullRequests }) as StudioLoopback

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useConversationPullRequests, pullRequestsForRow } = await import('./useConversationPullRequests')

  let seen: Readonly<Record<string, readonly BranchPullRequest[]>> = {}
  function Probe({ ids }: { ids: string[] }) {
    seen = useConversationPullRequests(ids)
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(Probe, { ids: ['ws-1', 'ws-2'] })))

  try {
    // Asked on mount; a conversation with nothing is absent, and no entry
    // on a workspace's list speaks for a branch.
    await until(() => seen['ws-1']?.length === 1, 'the first list')
    assert.deepEqual(Object.keys(seen), ['ws-1'])
    assert.equal(seen['ws-1'][0].onSessionBranch, undefined)

    // The server names what moved; the hook asks again.
    await until(() => listeners.size === 1, 'the subscription')
    answers['ws-1'] = [mark(4, 'merged')]
    await act(async () => emit())
    await until(() => seen['ws-1']?.[0]?.state === 'merged', 'the merge')

    // A read that fails leaves the marks on screen.
    failLists = true
    const before = lists
    await act(async () => emit())
    await until(() => lists > before, 'the failed read')
    assert.equal(seen['ws-1']?.[0]?.state, 'merged', 'a mark never blinks out for a read that failed')
    failLists = false

    // A window coming to the front asks the server to look again, at everything.
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event('focus'))
    })
    await until(() => refreshed.length === 1, 'the refresh')
    assert.deepEqual(refreshed, [{}])

    // A server restart: the client reconnects, the hook asks again, and a
    // change after it still arrives.
    answers['ws-1'] = [mark(4, 'merged'), mark(6)]
    loopback.drop()
    await until(() => seen['ws-1']?.length === 2, 'the list after the reconnect')
    await until(() => listeners.size >= 1, 'the subscription after the reconnect')
    answers['ws-1'] = [mark(7), mark(4, 'merged'), mark(6)]
    await act(async () => emit())
    await until(() => seen['ws-1']?.length === 3, 'a change after the reconnect')

    // A client that closed for good is replaced when the window next asks for
    // one; the hook subscribes on the new client, or no change would arrive.
    const { windowStudioClient } = await import('../../studio/windowStudioClient')
    const closing = await windowStudioClient(win.api as never)
    closing.close()
    await closing.closed
    await until(() => listeners.size === 0, 'the old subscription gone')
    const replacement = await windowStudioClient(win.api as never)
    assert.notEqual(replacement, closing)
    await until(() => listeners.size === 1, 'a subscription on the new client')
    answers['ws-1'] = [mark(8), mark(7), mark(4, 'merged'), mark(6)]
    await act(async () => emit())
    await until(() => seen['ws-1']?.length === 4, 'a change on the new client')

    // The ids leaving the screen take their marks with them.
    await act(async () => root.render(React.createElement(Probe, { ids: ['ws-2'] })))
    await until(() => Object.keys(seen).length === 0, 'the marks leaving with their row')

    // A row with agent lines of its own draws those, never the conversation's.
    const list = [{ ...mark(9), onConversationBranch: undefined }]
    assert.deepEqual(pullRequestsForRow({ hasLiveLines: true, conversation: list }), [])
    assert.equal(pullRequestsForRow({ hasLiveLines: false, conversation: list }), list)
  } finally {
    await act(async () => root.unmount())
    loopback.drop()
  }
})
