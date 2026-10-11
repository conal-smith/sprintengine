import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { bindGatewayConversation } from '../tools/client-tool-gateway'
import { localOnlyGatewayToolReason } from '../../main/automation/tailnet/tailnet-scopes'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import type { NoteOpenedOutcome, PullRequestConversationKey, WatchOutcome } from './pull-request-record'
import {
  createPullRequestTools,
  PULL_REQUEST_LINK_TOOL,
  PULL_REQUEST_UNWATCH_TOOL,
  PULL_REQUEST_WATCH_TOOL,
  type PullRequestToolsDeps,
} from './pull-request-tools'

const AGENT: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude-code' },
}
// What the gateway's token check does for a connection whose launch token a
// live launch holds.
bindGatewayConversation(AGENT, { workspaceId: 'ws-1', agentId: 'agent-1' })

function toolOver(answer: (key: PullRequestConversationKey, url: string) => NoteOpenedOutcome) {
  const calls: Array<{ key: PullRequestConversationKey; input: { url: string; title?: string } }> = []
  const [tool] = createPullRequestTools({
    ...WATCH_STUBS,
    link: async (key, input) => {
      calls.push({ key, input })
      return answer(key, input.url)
    },
  })
  return { tool, calls }
}

const WATCH_STUBS: Omit<PullRequestToolsDeps, 'link'> = {
  watch: async () => ({ ok: false, code: 'not_open', message: 'not here' }),
  unwatch: () => false,
  pullRequestsOf: () => [],
  isChat: () => true,
}

const linked = (url: string, recorded = true): NoteOpenedOutcome => ({
  ok: true,
  recorded,
  pullRequest: {
    url,
    repoKey: 'gitlab.com/acme/app',
    repoName: 'app',
    number: 4,
    title: '',
    state: 'open',
    isDraft: false,
    openedAt: 1,
    stateAt: 0,
    forge: 'gitlab',
  },
})

test('pull_request.link records under the calling agent, never under what it was told', async () => {
  const { tool, calls } = toolOver((_key, url) => linked(url))
  assert.equal(tool.name, PULL_REQUEST_LINK_TOOL)
  assert.equal(tool.mutates, true, 'it writes the record, so it is audited')
  const result = await tool.handler(
    {
      url: ' https://gitlab.com/acme/app/-/merge_requests/4 ',
      title: 'Marks',
    },
    AGENT,
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, [
    {
      key: { workspaceId: 'ws-1', agentId: 'agent-1' },
      input: { url: 'https://gitlab.com/acme/app/-/merge_requests/4', title: 'Marks' },
    },
  ])
  assert.deepEqual(result.structuredContent, {
    linked: true,
    alreadyLinked: false,
    pullRequest: {
      url: 'https://gitlab.com/acme/app/-/merge_requests/4',
      number: 4,
      repository: 'gitlab.com/acme/app',
      forge: 'gitlab',
    },
  })
  // The schema takes no conversation: there is nothing to claim another's with.
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), ['title', 'url'])
})

test('pull_request.link refuses whatever is not an agent, and passes the record’s refusals on', async () => {
  const { tool, calls } = toolOver(() => ({
    ok: false,
    code: 'opened_by_another_conversation',
    message: 'Another conversation opened that pull request.',
  }))
  for (const context of [
    undefined,
    { metadata: { kind: 'external-local' as const } },
    { metadata: { kind: 'remote-tailnet' as const, deviceId: 'dev-1', deviceName: 'android-phone' } },
    { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1' } },
    // An agent declared without a launch token proves nothing: anything that
    // can reach the socket can declare one.
    { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1' } },
  ]) {
    const refused = await tool.handler({ url: 'https://github.com/acme/app/pull/1' }, context)
    assert.equal(refused.isError, true)
    assert.equal((refused.structuredContent?.error as { code: string }).code, 'not_a_conversation')
  }
  assert.equal(calls.length, 0)
  const missing = await tool.handler({}, AGENT)
  assert.equal((missing.structuredContent?.error as { code: string }).code, 'invalid_arguments')
  const taken = await tool.handler({ url: 'https://github.com/acme/app/pull/1' }, AGENT)
  assert.equal((taken.structuredContent?.error as { code: string }).code, 'opened_by_another_conversation')
  // A paired device is not an agent: the tool is never served over the tailnet.
  assert.notEqual(localOnlyGatewayToolReason(PULL_REQUEST_LINK_TOOL), null)
})

const pr = (number: number, overrides: Partial<BranchPullRequest> = {}): BranchPullRequest => ({
  url: `https://github.com/acme/app/pull/${number}`,
  repoKey: 'github.com/acme/app',
  repoName: 'app',
  number,
  title: '',
  state: 'open',
  isDraft: false,
  openedAt: number,
  stateAt: 1,
  ...overrides,
})

function watchTools(mine: BranchPullRequest[], deps: Partial<PullRequestToolsDeps> = {}) {
  const watched: Array<{ key: PullRequestConversationKey; url: string }> = []
  const unwatched: string[] = []
  const tools = createPullRequestTools({
    link: async () => ({ ok: false, code: 'not_a_pull_request', message: 'unused' }),
    watch: async (key, input): Promise<WatchOutcome> => {
      watched.push({ key, url: input.url })
      return { ok: true, alreadyWatching: false, pullRequest: pr(Number(input.url.split('/').pop())) }
    },
    unwatch: (_key, input) => {
      unwatched.push(input.url)
      return true
    },
    pullRequestsOf: () => mine,
    isChat: () => true,
    ...deps,
  })
  const byName = (name: string) => tools.find((tool) => tool.name === name)!
  return { watch: byName(PULL_REQUEST_WATCH_TOOL), unwatch: byName(PULL_REQUEST_UNWATCH_TOOL), watched, unwatched }
}

test('pull_request.watch watches for the calling chat, and says to end the turn', async () => {
  const { watch, watched } = watchTools([pr(233, { state: 'merged' }), pr(234, { onSessionBranch: true }), pr(235)])
  assert.equal(watch.mutates, true)
  // Its description carries the rules an agent must follow.
  for (const rule of [
    /instead of polling, sleeping/,
    /end your turn right after/,
    /A wake is news, not a merge decision/,
    /pull_request\.unwatch when you hand the work back/,
  ])
    assert.match(watch.description, rule)
  const result = await watch.handler({}, AGENT)
  assert.equal(result.isError, undefined)
  assert.deepEqual(watched, [
    { key: { workspaceId: 'ws-1', agentId: 'agent-1' }, url: 'https://github.com/acme/app/pull/234' },
  ])
  assert.match(String((result.structuredContent as { next: string }).next), /End your turn now/)
  // A number names one of the chat's own; a URL is taken as given (watching links it).
  await watch.handler({ pullRequest: 235 }, AGENT)
  await watch.handler({ pullRequest: '#235' }, AGENT)
  await watch.handler({ pullRequest: 'https://github.com/acme/other/pull/9' }, AGENT)
  assert.deepEqual(
    watched.slice(1).map((entry) => entry.url),
    [
      'https://github.com/acme/app/pull/235',
      'https://github.com/acme/app/pull/235',
      'https://github.com/acme/other/pull/9',
    ],
  )
  // The schema names the pull request and nothing else: no conversation to claim another's with.
  assert.deepEqual(Object.keys((watch.inputSchema as { properties: object }).properties), ['pullRequest'])
})

test('pull_request.watch refuses what is not a chat, and says which pull request it cannot find', async () => {
  const none = watchTools([])
  for (const context of [undefined, { metadata: { kind: 'external-local' as const } }]) {
    const refused = await none.watch.handler({}, context)
    assert.equal((refused.structuredContent?.error as { code: string }).code, 'not_a_conversation')
  }
  const missing = await none.watch.handler({}, AGENT)
  assert.equal((missing.structuredContent?.error as { code: string }).code, 'not_found')
  const unknownNumber = await watchTools([pr(1)]).watch.handler({ pullRequest: 7 }, AGENT)
  assert.match(String((unknownNumber.structuredContent?.error as { message: string }).message), /No pull request #7/)
  const several = await watchTools([pr(1), pr(2)]).watch.handler({}, AGENT)
  assert.match(String((several.structuredContent?.error as { message: string }).message), /#1, #2/)
  const terminal = watchTools([pr(1)], { isChat: () => false })
  const refused = await terminal.watch.handler({}, AGENT)
  assert.equal((refused.structuredContent?.error as { code: string }).code, 'not_a_chat')
  assert.deepEqual(terminal.watched, [])
  assert.notEqual(localOnlyGatewayToolReason(PULL_REQUEST_WATCH_TOOL), null)
})

test('pull_request.unwatch stops one watch, or every watch the chat has', async () => {
  const watchedPr = (number: number) => pr(number, { watch: { since: 1, waitingOn: 'checks' } })
  const all = watchTools([watchedPr(1), pr(2), watchedPr(3)])
  const result = await all.unwatch.handler({}, AGENT)
  assert.deepEqual(all.unwatched, ['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/3'])
  assert.equal((result.structuredContent as { stopped: number }).stopped, 2)
  const one = watchTools([watchedPr(1), watchedPr(3)])
  await one.unwatch.handler({ pullRequest: 3 }, AGENT)
  assert.deepEqual(one.unwatched, ['https://github.com/acme/app/pull/3'])
  const refused = await one.unwatch.handler({}, undefined)
  assert.equal((refused.structuredContent?.error as { code: string }).code, 'not_a_conversation')
})
