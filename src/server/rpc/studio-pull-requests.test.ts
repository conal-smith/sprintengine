import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioPullRequestsMethodMap } from '../../../packages/studio-protocol/src/public'
import type { PullRequestsChanged, StudioPullRequests } from '../pull-requests/pull-request-domain'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `pullRequests.*` over the owner socket: the capability, the three methods
// and the stream, as a client reads them. The record behind them is a stub;
// what it decides is pull-request-record.test.ts's and pull-request-domain's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function stubPullRequests() {
  const listeners = new Set<(change: PullRequestsChanged) => void>()
  let listening: () => void = () => undefined
  const subscribed = new Promise<void>((resolve) => {
    listening = resolve
  })
  const noted: Array<StudioPullRequestsMethodMap['pullRequests.noteWork']['params']> = []
  const calls: Array<StudioPullRequestsMethodMap['pullRequests.noteToolCall']['params']> = []
  const stub: StudioPullRequests = {
    list: async (target): Promise<StudioPullRequestsMethodMap['pullRequests.list']['result']> => ({
      workspaces: (target.workspaceIds ?? []).includes('ws-1')
        ? {
            'ws-1': [
              {
                url: 'https://github.com/acme/app/pull/4',
                repoKey: 'github.com/acme/app',
                repoName: 'app',
                number: 4,
                title: 'Marks',
                state: 'open',
                isDraft: false,
                openedAt: 1,
                stateAt: 2,
              },
            ],
          }
        : ({} as Record<string, never[]>),
      conversations: [],
    }),
    refresh: async (target) => ({ asked: (target.workspaceIds ?? []).length > 0 }),
    noteWork: async (input) => {
      noted.push(input)
    },
    noteToolCall: async (input) => {
      calls.push(input)
    },
    link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'not here' }),
    onChanged: (listener) => {
      listeners.add(listener)
      listening()
      return () => listeners.delete(listener)
    },
  }
  return {
    stub,
    noted,
    calls,
    subscribed,
    emit: (change: PullRequestsChanged) => listeners.forEach((listener) => listener(change)),
  }
}

async function ownerOver(pullRequests?: StudioPullRequests) {
  const started = await startTestServer(pullRequests ? { pullRequests } : {})
  cleanups.push(() => started.dispose())
  const owner = await connectLineClient(started.path)
  cleanups.push(() => owner.close())
  owner.send(hello({ token: OWNER_TOKEN }))
  const welcome = await owner.next((frame) => frame.t === 'welcome')
  let seq = 0
  const request = async (method: string, params: unknown) => {
    const id = `r${++seq}`
    owner.send({ t: 'req', id, method, params })
    return owner.next((frame) => frame.t === 'res' && frame.id === id)
  }
  return { started, owner, welcome, request }
}

test('a Studio with a pull request record advertises it, and one without does not', async () => {
  const withRecord = await ownerOver(stubPullRequests().stub)
  assert.equal(withRecord.welcome.t === 'welcome' && withRecord.welcome.capabilities.includes('pull-requests'), true)
  assert.equal(
    withRecord.welcome.t === 'welcome' && withRecord.welcome.capabilities.includes('pull-request-tool-calls'),
    true,
  )
  const without = await ownerOver()
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('pull-requests'), false)
  assert.equal(
    without.welcome.t === 'welcome' && without.welcome.capabilities.includes('pull-request-tool-calls'),
    false,
  )
  const refused = await without.request('pullRequests.list', { workspaceIds: ['ws-1'] })
  assert.equal(refused.t === 'res' && !refused.ok && refused.error.code, 'unavailable')
})

test('an owner lists, refreshes, notes work and tool calls, and malformed params are refused', async () => {
  const { stub, noted, calls } = stubPullRequests()
  const { request } = await ownerOver(stub)
  const listed = await request('pullRequests.list', { workspaceIds: ['ws-1', 'ws-2'] })
  assert.equal(listed.t === 'res' && listed.ok, true)
  const result =
    listed.t === 'res' && listed.ok
      ? (listed.result as StudioPullRequestsMethodMap['pullRequests.list']['result'])
      : null
  assert.deepEqual(Object.keys(result?.workspaces ?? {}), ['ws-1'])
  assert.equal(result?.workspaces['ws-1'][0].number, 4)

  const refreshed = await request('pullRequests.refresh', { workspaceIds: ['ws-1'] })
  assert.deepEqual(refreshed.t === 'res' && refreshed.ok && refreshed.result, { asked: true })

  const note = {
    conversation: { workspaceId: 'ws-1', agentId: 'term-1' },
    sessionId: 'terminal-1',
    checkout: { gitRoot: '/Users/dev/app', branch: 'agent/x' },
    changedPaths: ['/Users/dev/other-repo/README.md'],
    turnEnded: true,
  }
  const accepted = await request('pullRequests.noteWork', note)
  assert.deepEqual(accepted.t === 'res' && accepted.ok && accepted.result, {})
  assert.deepEqual(noted, [note])

  const toolCall = {
    conversation: { workspaceId: 'ws-1', agentId: 'term-1' },
    toolCall: { name: 'Bash', command: 'gh pr create --fill', output: 'https://github.com/acme/app/pull/4\n' },
    extra: 'dropped',
  }
  const heard = await request('pullRequests.noteToolCall', toolCall)
  assert.deepEqual(heard.t === 'res' && heard.ok && heard.result, {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [{ conversation: toolCall.conversation, toolCall: toolCall.toolCall }])

  for (const [method, params] of [
    ['pullRequests.list', { workspaceIds: 'ws-1' }],
    ['pullRequests.list', { conversations: [{ workspaceId: 'ws-1' }] }],
    [
      'pullRequests.noteWork',
      { conversation: { workspaceId: 'ws-1', agentId: 'a' }, checkout: { gitRoot: '/x', branch: '--upload-pack' } },
    ],
    ['pullRequests.noteWork', { conversation: { workspaceId: 'ws-1', agentId: 'a' }, changedPaths: [42] }],
    ['pullRequests.noteToolCall', { conversation: { workspaceId: 'ws-1', agentId: 'a' }, toolCall: { name: 'Bash' } }],
    [
      'pullRequests.noteToolCall',
      { conversation: { workspaceId: 'ws-1', agentId: 'a' }, toolCall: { name: 'Bash', output: 'x'.repeat(40_000) } },
    ],
    ['pullRequests.noteToolCall', { toolCall: { name: 'Bash', output: '' } }],
  ] as const) {
    const refused = await request(method, params)
    assert.deepEqual([method, refused.t === 'res' && !refused.ok && refused.error.code], [method, 'invalid_params'])
  }
})

test('a paired app is refused, whatever it holds', async () => {
  const { stub } = stubPullRequests()
  const { started } = await ownerOver(stub)
  const app = await connectLineClient(started.path)
  cleanups.push(() => app.close())
  app.send(hello({ token: pairFakeClient(started.auth, 'app', ['workspaces:read', 'conversation:read']) }))
  await app.next((frame) => frame.t === 'welcome')
  app.send({ t: 'req', id: 'a1', method: 'pullRequests.list', params: { workspaceIds: ['ws-1'] } })
  const refused = await app.next((frame) => frame.t === 'res' && frame.id === 'a1')
  assert.equal(refused.t === 'res' && !refused.ok && refused.error.code, 'owner_required')
  app.send({ t: 'sub', id: 's1', topic: 'pullRequests.changed', params: {} })
  const failed = await app.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'owner_required')
})

test('the stream names what moved, never the lists', async () => {
  const { stub, emit, subscribed } = stubPullRequests()
  const { owner } = await ownerOver(stub)
  owner.send({ t: 'sub', id: 's1', topic: 'pullRequests.changed' })
  // The subscription is registered as the frame is read: the stub hears it.
  await subscribed
  emit({ workspaceIds: ['ws-1'], conversations: [{ workspaceId: 'ws-1', agentId: 'agent-1' }] })
  const pushed = await owner.next((frame) => frame.t === 'push' && frame.sub === 's1')
  assert.deepEqual(pushed.t === 'push' && pushed.payload, {
    workspaceIds: ['ws-1'],
    conversations: [{ workspaceId: 'ws-1', agentId: 'agent-1' }],
  })
})

test('an owner links a pull request it opened; one another conversation claimed is refused as claimed', async () => {
  const { stub } = stubPullRequests()
  const linked: unknown[] = []
  stub.link = async (input) => {
    linked.push(input)
    if (input.url.endsWith('/9')) {
      return { ok: false, code: 'opened_by_another_conversation', message: 'Another conversation opened it.' }
    }
    return {
      ok: true,
      recorded: true,
      pullRequest: {
        url: input.url,
        repoKey: 'github.com/acme/app',
        repoName: 'app',
        number: 4,
        title: input.title ?? '',
        state: 'open',
        isDraft: false,
        openedAt: 1,
        stateAt: 0,
      },
    }
  }
  const { request, welcome } = await ownerOver(stub)
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('pull-request-link'), true)
  const conversation = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const ok = await request('pullRequests.link', {
    conversation,
    url: 'https://github.com/acme/app/pull/4',
    title: 'Marks',
  })
  assert.equal(ok.t === 'res' && ok.ok && (ok.result as { recorded: boolean }).recorded, true)
  const claimed = await request('pullRequests.link', { conversation, url: 'https://github.com/acme/app/pull/9' })
  assert.equal(claimed.t === 'res' && !claimed.ok && claimed.error.code, 'claimed')
  const malformed = await request('pullRequests.link', { conversation, url: 42 })
  assert.equal(malformed.t === 'res' && !malformed.ok && malformed.error.code, 'invalid_params')
  assert.equal(linked.length, 2)
})

test('an owner stops a conversation’s watch; a Studio that cannot advertises no watch capability', async () => {
  const { stub } = stubPullRequests()
  const without = await ownerOver(stub)
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('pull-request-watch'), false)
  const unserved = await without.request('pullRequests.unwatch', {
    conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
    url: 'https://github.com/acme/app/pull/4',
  })
  assert.equal(unserved.t === 'res' && !unserved.ok && unserved.error.code, 'unavailable')

  const stopped: unknown[] = []
  const watching = stubPullRequests().stub
  watching.unwatch = async (input) => {
    stopped.push(input)
    return { watched: input.url.endsWith('/4') }
  }
  const { request, welcome } = await ownerOver(watching)
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('pull-request-watch'), true)
  const conversation = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const ok = await request('pullRequests.unwatch', { conversation, url: 'https://github.com/acme/app/pull/4' })
  assert.deepEqual(ok.t === 'res' && ok.ok && ok.result, { watched: true })
  const notWatched = await request('pullRequests.unwatch', { conversation, url: 'https://github.com/acme/app/pull/5' })
  assert.deepEqual(notWatched.t === 'res' && notWatched.ok && notWatched.result, { watched: false })
  const malformed = await request('pullRequests.unwatch', { conversation: { workspaceId: 'ws-1' }, url: 'x' })
  assert.equal(malformed.t === 'res' && !malformed.ok && malformed.error.code, 'invalid_params')
  assert.deepEqual(stopped, [
    { conversation, url: 'https://github.com/acme/app/pull/4' },
    { conversation, url: 'https://github.com/acme/app/pull/5' },
  ])
})
