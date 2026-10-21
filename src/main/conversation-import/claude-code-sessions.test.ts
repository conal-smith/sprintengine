import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { claudePromptText, readClaudeCodeSession, scanClaudeCodeSessions } from './claude-code-sessions'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const CWD = '/Users/dev/acme-app'
const SESSION = '5f1c2a3e-0000-4000-8000-000000000001'

function base(extra: Record<string, unknown>, at: string): Record<string, unknown> {
  return { sessionId: SESSION, cwd: CWD, entrypoint: 'cli', isSidechain: false, timestamp: at, ...extra }
}

function sessionRecords(): Array<Record<string, unknown>> {
  return [
    base(
      { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' } },
      '2026-09-01T10:00:00Z',
    ),
    base(
      { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Fix the flaky login test' } },
      '2026-09-01T10:00:01Z',
    ),
    { type: 'ai-title', sessionId: SESSION, aiTitle: 'Flaky login test' },
    base(
      {
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'thinking', thinking: 'Look at it.' }] },
      },
      '2026-09-01T10:00:02Z',
    ),
    base(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the test.' }] } },
      '2026-09-01T10:00:03Z',
    ),
    base(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      '2026-09-01T10:00:04Z',
    ),
    base(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Exit code 1\n1 failed', is_error: true }],
        },
        toolUseResult: { stdout: '', stderr: '1 failed', interrupted: false },
      },
      '2026-09-01T10:00:05Z',
    ),
    // A spawned agent's step, and a background task's report: neither is the conversation.
    base(
      {
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] },
      },
      '2026-09-01T10:00:06Z',
    ),
    base(
      {
        type: 'user',
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: { role: 'user', content: '<task-notification>done</task-notification>' },
      },
      '2026-09-01T10:00:07Z',
    ),
    base(
      {
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
        },
      },
      '2026-09-01T10:00:08Z',
    ),
    base(
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 9000 } },
      '2026-09-01T10:00:09Z',
    ),
    base(
      { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } },
      '2026-09-01T10:00:10Z',
    ),
  ]
}

async function fixture(): Promise<{ projects: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-claude-import-'))
  roots.add(root)
  const projects = join(root, 'projects')
  const folder = join(projects, '-Users-dev-acme-app')
  await mkdir(join(folder, SESSION, 'subagents'), { recursive: true })
  const file = join(folder, `${SESSION}.jsonl`)
  await writeFile(
    file,
    `${sessionRecords()
      .map((record) => JSON.stringify(record))
      .join('\n')}\nnot json\n`,
  )
  await writeFile(
    join(folder, SESSION, 'subagents', 'agent-1.jsonl'),
    `${JSON.stringify(base({ type: 'user', message: { role: 'user', content: 'sub task' } }, '2026-09-01T10:00:00Z'))}\n`,
  )
  // A session the Agent SDK ran is a program's: this app's own chats among them.
  await writeFile(
    join(folder, 'aaaaaaaa-0000-4000-8000-000000000002.jsonl'),
    `${JSON.stringify({ ...base({ type: 'user', message: { role: 'user', content: 'hi' } }, '2026-09-02T10:00:00Z'), entrypoint: 'sdk-ts', sessionId: 'sdk' })}\n`,
  )
  // A session nobody typed into: the CLI opened and closed.
  await writeFile(
    join(folder, 'bbbbbbbb-0000-4000-8000-000000000003.jsonl'),
    `${JSON.stringify({ type: 'ai-title', aiTitle: 'Nothing' })}\n`,
  )
  await utimes(file, new Date('2026-09-01T10:00:10Z'), new Date('2026-09-01T10:00:10Z'))
  return { projects, file }
}

test('the scan lists the sessions a person typed into, with their folder and title', async () => {
  const { projects, file } = await fixture()
  const sessions = await scanClaudeCodeSessions(projects)
  assert.deepEqual(sessions, [
    {
      source: 'claude-code',
      sessionId: SESSION,
      path: file,
      folderPath: CWD,
      title: 'Flaky login test',
      firstPrompt: 'Fix the flaky login test',
      startedAt: Date.parse('2026-09-01T10:00:00Z'),
      updatedAt: Date.parse('2026-09-01T10:00:10Z'),
    },
  ])
})

/** A session file of `sessionRecords()` with `extra` after them, and `padding` bytes of replies between. */
async function renamedFixture(extra: Array<Record<string, unknown>>, padding = 0): Promise<string> {
  const { projects, file } = await fixture()
  const filler: Array<Record<string, unknown>> = []
  for (let size = 0; size < padding; size += 1024)
    filler.push(
      base(
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } },
        '2026-09-01T10:00:11Z',
      ),
    )
  const records = [...sessionRecords(), ...filler, ...extra]
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return projects
}

const RENAMED = [
  { type: 'custom-title', sessionId: SESSION, customTitle: 'Login test rewrite' },
  { type: 'ai-title', sessionId: SESSION, aiTitle: 'Flaky login test' },
]

test('the scan titles a session renamed with /rename by its new name, over the title the CLI wrote after it', async () => {
  const projects = await renamedFixture(RENAMED)
  const [session] = await scanClaudeCodeSessions(projects)
  assert.equal(session?.title, 'Login test rewrite')
})

test('the scan finds a rename at the end of a session too long to read whole', async () => {
  const projects = await renamedFixture(RENAMED, 256 * 1024)
  const [session] = await scanClaudeCodeSessions(projects)
  assert.equal(session?.title, 'Login test rewrite')
})

test('the scan titles a session whose rename was cleared by the title the CLI gave it', async () => {
  const projects = await renamedFixture([
    ...RENAMED,
    { type: 'custom-title', sessionId: SESSION, customTitle: '' },
    { type: 'ai-title', sessionId: SESSION, aiTitle: 'Flaky login test' },
  ])
  const [session] = await scanClaudeCodeSessions(projects)
  assert.equal(session?.title, 'Flaky login test')
})

test('a renamed session reads back with its new name', async () => {
  const projects = await renamedFixture(RENAMED)
  const [session] = await scanClaudeCodeSessions(projects)
  const history = await readClaudeCodeSession(session!.path, 0)
  assert.equal(history.title, 'Login test rewrite')
})

test('a scan of a home with no sessions is empty, not an error', async () => {
  assert.deepEqual(await scanClaudeCodeSessions('/Users/dev/no-such-claude/projects'), [])
})

test('a session reads back as turns of the person’s messages, with the steps drawn as the live adapter draws them', async () => {
  const { file } = await fixture()
  const history = await readClaudeCodeSession(file, 0)
  assert.equal(history.title, 'Flaky login test')
  assert.equal(history.firstPrompt, 'Fix the flaky login test')
  assert.deepEqual(
    history.events.map((entry) => entry.type),
    [
      'user_message',
      'turn_started',
      'reasoning_delta',
      'content_delta',
      'tool_started',
      'tool_output',
      'turn_completed',
      'user_message',
      'turn_started',
      'context_compacted',
      'turn_completed',
    ],
  )
  const messages = history.events.filter((entry) => entry.type === 'user_message').map((entry) => entry.payload.text)
  assert.deepEqual(messages, ['Fix the flaky login test', '/compact'])
  const step = history.events.find((entry) => entry.type === 'tool_started')
  assert.equal(step?.payload.kind, 'command')
  assert.equal(step?.payload.toolUseId, 'toolu_1')
  assert.deepEqual(step?.payload.input, { command: 'npm test' })
  const result = history.events.find((entry) => entry.type === 'tool_output')
  assert.equal(result?.payload.status, 'error')
  assert.equal(result?.payload.exitCode, 1)
  assert.equal(result?.payload.turnId, 'turn_import_1')
  assert.equal(history.startedAt, Date.parse('2026-09-01T10:00:01Z'))
})

test('the person’s message is unwrapped from the tags the CLI puts around it', () => {
  assert.equal(claudePromptText('plain'), 'plain')
  assert.equal(
    claudePromptText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    'a\n\nb',
  )
  assert.equal(claudePromptText('<command-name>/review</command-name><command-args>12</command-args>'), '/review 12')
  assert.equal(claudePromptText('<bash-input>git status</bash-input>'), '!git status')
  assert.equal(claudePromptText('<local-command-stdout>ok</local-command-stdout>'), null)
  assert.equal(claudePromptText('[Request interrupted by user]'), null)
  assert.equal(claudePromptText('<system-reminder>note</system-reminder>\nkeep this'), 'keep this')
})

test('a session that kept its plan with the task tools reads back with the plan on its todo rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sprintengine-claude-import-'))
  roots.add(root)
  const file = join(root, `${SESSION}.jsonl`)
  const call = (id: string, name: string, input: Record<string, unknown>, at: string) =>
    base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }, at)
  const answer = (id: string, text: string, toolUseResult: unknown, at: string) =>
    base(
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
        toolUseResult,
      },
      at,
    )
  const records = [
    base({ type: 'user', message: { role: 'user', content: 'Plan the release' } }, '2026-09-01T10:00:00Z'),
    call('toolu_1', 'TaskCreate', { subject: 'Write the notes', description: 'Notes' }, '2026-09-01T10:00:01Z'),
    answer(
      'toolu_1',
      'Task #1 created successfully: Write the notes',
      { task: { id: '1', subject: 'Write the notes' } },
      '2026-09-01T10:00:02Z',
    ),
    call('toolu_2', 'TaskCreate', { subject: 'Tag the build', description: 'Tag' }, '2026-09-01T10:00:03Z'),
    answer(
      'toolu_2',
      'Task #2 created successfully: Tag the build',
      { task: { id: '2', subject: 'Tag the build' } },
      '2026-09-01T10:00:04Z',
    ),
    call('toolu_3', 'TaskUpdate', { taskId: '1', status: 'completed' }, '2026-09-01T10:00:05Z'),
    answer(
      'toolu_3',
      'Updated task #1 status',
      { success: true, taskId: '1', updatedFields: ['status'] },
      '2026-09-01T10:00:06Z',
    ),
  ]
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const history = await readClaudeCodeSession(file, 0)
  const rows = history.events.filter((entry) => entry.type === 'tool_started')
  assert.deepEqual(
    rows.map((row) => [row.payload.toolUseId, row.payload.kind]),
    [
      ['toolu_1', 'todo'],
      ['toolu_1', 'todo'],
      ['toolu_2', 'todo'],
      ['toolu_2', 'todo'],
      ['toolu_3', 'todo'],
      ['toolu_3', 'todo'],
    ],
  )
  assert.deepEqual((rows.at(-1)?.payload.input as { todos: unknown }).todos, [
    { content: 'Write the notes', status: 'completed' },
    { content: 'Tag the build', status: 'pending' },
  ])
  // Each answer closes its row: nothing is left open to be marked stopped.
  assert.deepEqual(
    history.events.filter((entry) => entry.type === 'tool_output').map((entry) => entry.payload.status),
    ['ok', 'ok', 'ok'],
  )
})
