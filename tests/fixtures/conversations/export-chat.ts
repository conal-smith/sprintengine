import type { ConversationEvent, ConversationEventType } from '../../../src/shared/conversation-runtime'

// A finished chat, as its transcript stores it, for the Export chat tests: two
// turns of a Claude Code chat working on a release script, with everything an
// export has to keep or leave out. The person attaches a screenshot and a
// file; the agent thinks (left out), reads a file and runs the tests (one
// line), says what it found between steps, sends off an Explore agent (one
// line), edits a file, and replies in Markdown with a heading, a list, a
// table, code, a link, math and a diagram. A `<script>` in the reply has to
// stay words. Studio's own notice, a compaction, usage and session events are
// the chat's bookkeeping and stay out. The second turn asks a question and is
// stopped.

const START = Date.UTC(2026, 9, 20, 9, 12, 0)

let sequence = 0
function event(
  type: ConversationEventType,
  secondsIn: number,
  payload: Record<string, unknown> = {},
): ConversationEvent {
  sequence += 1
  return {
    id: `event-${sequence}`,
    seq: sequence,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'claude-sonnet-4-5',
    type,
    createdAt: START + secondsIn * 1000,
    payload,
  }
}

export const EXPORT_CHAT_WORKSPACE_ROOT = '/Users/dev/acme-app'
export const EXPORT_CHAT_IMAGE_REF = 'agent-1/screenshot-1.png'

/** A 4 x 3 PNG in the accent green: the screenshot the person attached. */
export const EXPORT_CHAT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGPQz/KCIwacHADOYQqlA9zWxgAAAABJRU5ErkJggg==',
  'base64',
)

export const EXPORT_CHAT_REPLY = [
  '## Release checklist',
  '',
  'The release script now **checks the tag** before it builds:',
  '',
  '1. Read the version from `package.json`',
  '2. Compare it with the tag',
  '   - fail when they differ',
  '',
  '| Step | Time |',
  '| :--- | ---: |',
  '| build | 42s |',
  '| test | 1m 3s |',
  '',
  '```ts',
  'const tag = `v${version}`',
  '```',
  '',
  '```mermaid',
  'graph TD; build --> test',
  '```',
  '',
  'Energy is $$E = mc^2$$, and it costs $5 a month.',
  '',
  'See [the release guide](https://example.com/release) — and note <script>alert("x")</script> is only text.',
].join('\n')

export function exportChatEvents(): ConversationEvent[] {
  sequence = 0
  return [
    event('session_started', 0, { apiKeySource: 'none' }),
    event('user_message', 1, {
      turnId: 't1',
      text: 'Can you make the **release script** check the tag first?',
      attachments: [
        { id: 'image-1', mediaType: 'image/png', name: 'screenshot.png', byteLength: 75, ref: EXPORT_CHAT_IMAGE_REF },
      ],
      files: [{ path: `${EXPORT_CHAT_WORKSPACE_ROOT}/scripts/release.mjs` }],
    }),
    event('turn_started', 2, { turnId: 't1' }),
    event('reasoning_delta', 3, { turnId: 't1', text: 'SECRET-REASONING: the person wants a guard.' }),
    event('tool_started', 4, {
      turnId: 't1',
      toolUseId: 'read-1',
      name: 'Read',
      kind: 'file_read',
      input: { file_path: `${EXPORT_CHAT_WORKSPACE_ROOT}/scripts/release.mjs` },
    }),
    event('tool_output', 5, {
      turnId: 't1',
      toolUseId: 'read-1',
      output: 'FULL-TOOL-OUTPUT const version = 1',
      status: 'ok',
    }),
    event('tool_started', 6, {
      turnId: 't1',
      toolUseId: 'bash-1',
      name: 'Bash',
      kind: 'command',
      input: { command: 'npm test' },
    }),
    event('tool_output', 9, {
      turnId: 't1',
      toolUseId: 'bash-1',
      output: 'FULL-TOOL-OUTPUT 12 passing',
      exitCode: 0,
      status: 'ok',
    }),
    event('content_delta', 10, { turnId: 't1', text: 'The tests pass. I will ask an agent where the tag is made.' }),
    event('tool_started', 11, {
      turnId: 't1',
      toolUseId: 'task-1',
      name: 'Task',
      kind: 'subagent',
      subagentLane: true,
      subagentType: 'Explore',
      input: { description: 'Find where the tag is created', prompt: 'Look through scripts/' },
    }),
    event('tool_started', 12, {
      toolUseId: 'grep-1',
      parentToolUseId: 'task-1',
      turnId: 't1',
      name: 'Grep',
      kind: 'search',
      input: { pattern: 'git tag' },
    }),
    event('tool_output', 13, { turnId: 't1', toolUseId: 'grep-1', output: 'scripts/release.mjs:12', status: 'ok' }),
    event('subagent_status', 20, { toolUseId: 'task-1', status: 'completed', endedAt: START + 20_000 }),
    event('tool_output', 20, { turnId: 't1', toolUseId: 'task-1', output: 'It is made in release.mjs', status: 'ok' }),
    event('tool_started', 21, {
      turnId: 't1',
      toolUseId: 'edit-1',
      name: 'Edit',
      kind: 'file_edit',
      input: { file_path: `${EXPORT_CHAT_WORKSPACE_ROOT}/scripts/release.mjs` },
    }),
    event('tool_output', 22, { turnId: 't1', toolUseId: 'edit-1', output: 'ok', status: 'ok' }),
    event('content_delta', 23, { turnId: 't1', text: EXPORT_CHAT_REPLY }),
    event('usage_updated', 24, { turnId: 't1', inputTokens: 1200, outputTokens: 300 }),
    event('turn_completed', 25, { turnId: 't1', durationMs: 23_000 }),
    // Studio telling the chat something of its own: drawn as a notice, not the person.
    event('user_message', 30, {
      turnId: 'notice-1',
      text: '[SprintEngine Studio] STUDIO-NOTICE: an agent this chat started has finished.',
      origin: { kind: 'studio', reason: 'agent-notice' },
    }),
    event('turn_started', 31, { turnId: 'notice-1' }),
    event('turn_completed', 32, { turnId: 'notice-1' }),
    event('context_compacted', 40, { trigger: 'auto', preTokens: 90_000, postTokens: 12_000 }),
    event('user_message', 60, { turnId: 't2', text: 'Ship it' }),
    event('turn_started', 61, { turnId: 't2' }),
    event('approval_requested', 62, {
      turnId: 't2',
      requestId: 'question-1',
      kind: 'question',
      summary: 'Which channel?',
      questions: [{ question: 'Which channel should it go to?', options: [{ label: 'nightly' }, { label: 'stable' }] }],
    }),
    event('approval_resolved', 70, {
      turnId: 't2',
      requestId: 'question-1',
      approved: true,
      answers: { 'Which channel should it go to?': 'nightly' },
    }),
    event('content_delta', 71, { turnId: 't2', text: 'Publishing to nightly.' }),
    event('turn_failed', 75, { turnId: 't2', reason: 'interrupted' }),
  ]
}
