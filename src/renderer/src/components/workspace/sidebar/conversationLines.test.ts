import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import {
  combinedAgentActivity,
  conversationFinishedAt,
  conversationLastInputAt,
  conversationLineMark,
  conversationLineText,
  conversationsWithTabs,
  replyPreviewText,
  workspaceIsWorking,
} from './conversationLines'
import type { TerminalSessionSnapshot } from '../../../../../shared/ipc/terminal'

const session = (
  status: ConversationSessionSummary['status'],
  lastAssistantText?: string,
): ConversationSessionSummary => ({
  sessionId: 'conversation-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  providerId: 'provider-1',
  modelId: 'model-1',
  status,
  createdAt: 1,
  updatedAt: 2,
  lastAssistantText,
})

test('conversation lines use the sidebar status idiom', () => {
  assert.equal(conversationLineText(session('awaiting_approval')), 'Needs approval')
  assert.equal(conversationLineText(session('active')), 'Thinking')
  assert.equal(conversationLineText({ ...session('active'), currentToolTitle: 'Reading files' }), 'Reading files')
  assert.equal(conversationLineText(session('failed')), 'Failed')
  assert.equal(conversationLineText(session('ready', 'The checks pass.')), 'The checks pass.')
  assert.equal(combinedAgentActivity('working', [session('awaiting_approval')]), 'needs-input')
  assert.equal(combinedAgentActivity('idle', [session('active')]), 'working')
  assert.equal(combinedAgentActivity('failed', [session('ready')]), 'failed')
})

test('a chat line names the CLI it rides, the way a terminal line does', () => {
  const claude = conversationLineMark({ providerId: 'claude-agent', modelId: 'default', displayName: 'Mara Quill' })
  assert.equal(claude.cli, 'claude-code')
  assert.equal(claude.runtimeLabel, 'Claude Code chat')
  assert.equal(claude.tooltip, 'Mara Quill · Claude Code chat · default')
  assert.equal(conversationLineMark({ providerId: 'codex-agent', modelId: 'gpt-5' }).cli, 'codex')
  const api = conversationLineMark({ providerId: 'openai-compatible-api', modelId: 'model-1' })
  assert.equal(api.cli, null)
  assert.equal(api.tooltip, 'Chat · model-1')
})

test('a resting chat counts from when its last turn ended, not from its last update', () => {
  const finished = { ...session('ready', 'Done.'), updatedAt: 900, lastTurnEndedAt: 500 }
  assert.equal(conversationFinishedAt(finished), 500)
  assert.equal(conversationFinishedAt({ ...session('failed'), lastTurnEndedAt: 400 }), 400)
  // A turn in flight or waiting on a person has no finished time to show.
  assert.equal(conversationFinishedAt({ ...session('active'), lastTurnEndedAt: 500 }), null)
  assert.equal(conversationFinishedAt({ ...session('awaiting_approval'), lastTurnEndedAt: 500 }), null)
  // Nothing has finished yet.
  assert.equal(conversationFinishedAt(session('ready')), null)
})

test("a chat's last input is the person's last message, not a model or permission change", () => {
  // `updatedAt` (2) moved on a setting change after the message at 1.5.
  assert.equal(conversationLastInputAt({ ...session('ready'), lastUserMessageAt: 1.5 }), 1.5)
  // Nothing sent yet: opening the chat is the last thing the person did.
  assert.equal(conversationLastInputAt(session('ready')), 1)
})

test('the last-reply line reads as prose, not as the markdown it was written in', () => {
  assert.equal(
    conversationLineText(session('ready', '## Summary\n\nThe **build** passes and `npm test` is *green*.')),
    'Summary The build passes and npm test is green.',
  )
})

test('a reply preview drops heading, quote, list and task markers', () => {
  assert.equal(
    replyPreviewText('# Done\n> Note: cache cleared\n- First\n2. Second\n- [x] Third'),
    'Done Note: cache cleared First Second Third',
  )
})

test('a reply preview keeps a link’s or an image’s text and drops its target', () => {
  assert.equal(
    replyPreviewText('See [the guide](https://example.com/guide), ![chart](a.png) and <https://example.com>.'),
    'See the guide, chart and https://example.com.',
  )
})

test('a reply preview keeps a code block’s code and drops its fences', () => {
  assert.equal(replyPreviewText('Run:\n```bash\nnpm test\n```\n---\nDone.'), 'Run: npm test Done.')
})

test('a reply preview keeps a table’s cells and drops its alignment row', () => {
  assert.equal(replyPreviewText('| File | Lines |\n| :--- | ---: |\n| a.ts | 12 |'), 'File · Lines a.ts · 12')
})

test('a reply preview drops markers whose partners were cut off with the rest of the reply', () => {
  assert.equal(
    replyPreviewText('The **fix is in [the handler](https://example.com/a-very-long'),
    'The fix is in the handler',
  )
})

test('a reply preview leaves snake_case, stray asterisks and escaped characters as the reader saw them', () => {
  assert.equal(
    replyPreviewText('Set max_retry_count to 2 * 3 \\*not emphasis\\*.'),
    'Set max_retry_count to 2 * 3 *not emphasis*.',
  )
})

test('strikethrough and underscore emphasis read as their words', () => {
  assert.equal(replyPreviewText('~~Old~~ plan: __new__ and _quick_.'), 'Old plan: new and quick.')
})

test('a chat line names the CLI it rides, the way a terminal line does', () => {
  const claude = conversationLineMark({ providerId: 'claude-agent', modelId: 'default', displayName: 'Mara Quill' })
  assert.equal(claude.cli, 'claude-code')
  assert.equal(claude.runtimeLabel, 'Claude Code chat')
  assert.equal(claude.tooltip, 'Mara Quill · Claude Code chat · default')
  assert.equal(conversationLineMark({ providerId: 'codex-agent', modelId: 'gpt-5' }).cli, 'codex')
  const api = conversationLineMark({ providerId: 'openai-compatible-api', modelId: 'model-1' })
  assert.equal(api.cli, null)
  assert.equal(api.tooltip, 'Chat · model-1')
})

test('a resting chat counts from when its last turn ended, not from its last update', () => {
  const finished = { ...session('ready', 'Done.'), updatedAt: 900, lastTurnEndedAt: 500 }
  assert.equal(conversationFinishedAt(finished), 500)
  assert.equal(conversationFinishedAt({ ...session('failed'), lastTurnEndedAt: 400 }), 400)
  // A turn in flight or waiting on a person has no finished time to show.
  assert.equal(conversationFinishedAt({ ...session('active'), lastTurnEndedAt: 500 }), null)
  assert.equal(conversationFinishedAt({ ...session('awaiting_approval'), lastTurnEndedAt: 500 }), null)
  // Nothing has finished yet.
  assert.equal(conversationFinishedAt(session('ready')), null)
})

test('a row draws one chat line per chat tab', () => {
  const layout = {
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          children: [
            { type: 'tab', component: 'agent', config: { agentId: 'agent-1' } },
            { type: 'tab', component: 'agent', config: { agentId: 'agent-2' } },
          ],
        },
      ],
    },
  }
  const tabbed = { ...session('ready'), sessionId: 'current', updatedAt: 5 }
  const superseded = { ...session('failed'), sessionId: 'superseded', updatedAt: 3 }
  const second = { ...session('active'), sessionId: 'second', agentId: 'agent-2' }
  const untabbed = { ...session('failed'), sessionId: 'untabbed', agentId: 'agent-closed' }
  assert.deepEqual(
    conversationsWithTabs([superseded, untabbed, tabbed, second], layout).map((entry) => entry.sessionId),
    ['current', 'second'],
  )
  assert.deepEqual(conversationsWithTabs([tabbed], null), [])
})

test('a terminal agent mid-turn holds Settle while another waits at a prompt', () => {
  const terminal = (kind: 'working' | 'idle', processAlive = true) =>
    ({ sessionId: `pty-${kind}`, kind: 'agent', processAlive, activity: { kind, since: 1 } }) as TerminalSessionSnapshot
  // The row reads `needs-input` (the prompt outranks working), and the working
  // agent beside it still counts.
  assert.equal(workspaceIsWorking('needs-input', [], [terminal('idle'), terminal('working')]), true)
  assert.equal(workspaceIsWorking('needs-input', [], [terminal('idle')]), false)
  // A paused process runs no turn, whatever it last said.
  assert.equal(workspaceIsWorking('idle', [], [terminal('working', false)]), false)
})

test('a plain shell printing holds neither Settle nor the rest of the chat', () => {
  const session = (kind: 'agent' | 'terminal', activity: 'working' | 'idle') =>
    ({
      sessionId: `${kind}-${activity}`,
      kind,
      processAlive: true,
      activity: { kind: activity, since: 1 },
    }) as TerminalSessionSnapshot
  // A chat holding only a shell: the row's activity reads working off the
  // shell's output, and the chat settles all the same.
  assert.equal(workspaceIsWorking('working', [], [session('terminal', 'working')]), false)
  assert.equal(workspaceIsWorking('idle', [], [session('terminal', 'working')]), false)
  // A shell beside an agent mid-turn: the agent still holds it.
  assert.equal(workspaceIsWorking('working', [], [session('terminal', 'working'), session('agent', 'working')]), true)
  // And the row's activity alone, with no shell printing, is still believed.
  assert.equal(workspaceIsWorking('working', [], [session('terminal', 'idle')]), true)
})
