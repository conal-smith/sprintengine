import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  claudeTaskOutputRoot,
  createClaudeCommandOutput,
  locateClaudeTaskOutput,
  type ClaudeCommandOutputChunk,
} from './claude-command-output'

// A running Bash command's output in a Claude chat, read from the file Claude
// Code writes it to, as appended output of the call until its result.

const CWD = '/Users/dev/app'
const PROJECT = '-Users-dev-app'

let root: string

beforeEach(async () => {
  // As the CLI names it: a Mac's temp folder is behind a symlink.
  root = await realpath(await mkdtemp(join(tmpdir(), 'claude-command-output-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function taskFile(project: string, session: string, task: string, text = ''): Promise<string> {
  const dir = join(root, project, session, 'tasks')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${task}.output`)
  await writeFile(path, text)
  return path
}

const bashCall = (id: string, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] },
})
const taskStarted = (task: string, toolUseId: string, backgrounded = false) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: task,
  tool_use_id: toolUseId,
  task_type: 'local_bash',
  is_backgrounded: backgrounded,
  session_id: 'sess-1',
})
const toolResult = (toolUseId: string) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
})

function follower(options: { maxBytesPerTick?: number; maxTotalBytes?: number; locateAttempts?: number } = {}) {
  const chunks: ClaudeCommandOutputChunk[] = []
  const tails = createClaudeCommandOutput({
    root,
    cwd: CWD,
    pollMs: 5,
    emit: (chunk) => chunks.push(chunk),
    ...options,
  })
  return { tails, chunks, text: () => chunks.map((chunk) => chunk.output).join('') }
}

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

test('the task root is the CLI temp folder for this user, and there is none on Windows', () => {
  expect(claudeTaskOutputRoot({}, { platform: 'darwin', uid: 501 })).toBe('/tmp/claude-501')
  expect(claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: '/Users/dev/tmp' }, { platform: 'linux', uid: 1000 })).toBe(
    '/Users/dev/tmp/claude-1000',
  )
  expect(claudeTaskOutputRoot({}, { platform: 'win32', uid: 0 })).toBeNull()
  expect(claudeTaskOutputRoot({}, { platform: 'linux', uid: undefined })).toBeNull()
})

test("a task's output file is found under the cwd's folder, or by looking through the others", async () => {
  const expected = await taskFile(PROJECT, 'sess-1', 'b1')
  expect(await locateClaudeTaskOutput(root, CWD, 'sess-1', 'b1')).toBe(expected)
  const hashed = await taskFile('-Users-dev-a-very-long-path-1a2b3c', 'sess-2', 'b2')
  expect(await locateClaudeTaskOutput(root, CWD, 'sess-2', 'b2')).toBe(hashed)
  expect(await locateClaudeTaskOutput(root, CWD, 'sess-1', 'missing')).toBeNull()
  expect(await locateClaudeTaskOutput(join(root, 'absent'), CWD, 'sess-1', 'b1')).toBeNull()
})

test('ids that are not the shape the CLI makes are never made into a path', async () => {
  await taskFile(PROJECT, 'sess-1', 'b1')
  expect(await locateClaudeTaskOutput(root, CWD, '../sess-1', 'b1')).toBeNull()
  expect(await locateClaudeTaskOutput(root, CWD, 'sess-1', '../../b1')).toBeNull()
})

test("a foreground command's output is handed on as it is written, then once more at its result", async () => {
  const path = await taskFile(PROJECT, 'sess-1', 'b1', 'line1\n')
  const { tails, chunks, text } = follower()
  expect(tails.observe(bashCall('toolu_1'))).toBeUndefined()
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text() === 'line1\n')
  await appendFile(path, 'line2\n')
  await until(() => text() === 'line1\nline2\n')
  await appendFile(path, 'line3\n')
  // The result is read for what was written since the last tick.
  await tails.observe(toolResult('toolu_1'))
  expect(text()).toBe('line1\nline2\nline3\n')
  expect(chunks.every((chunk) => chunk.toolUseId === 'toolu_1')).toBe(true)
  expect(chunks.at(-1)?.totalBytes).toBe(18)
  await appendFile(path, 'after\n')
  await pause()
  expect(text(), 'nothing after the result').toBe('line1\nline2\nline3\n')
})

test('the task notification ends the command too, and its result after it adds nothing', async () => {
  const path = await taskFile(PROJECT, 'sess-1', 'b1', 'one\n')
  const { tails, text } = follower()
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text() === 'one\n')
  await appendFile(path, 'two\n')
  await tails.observe({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' })
  expect(text()).toBe('one\ntwo\n')
  expect(tails.observe(toolResult('toolu_1'))).toBeUndefined()
})

test('a command started in the background, or by a subagent, is not followed', async () => {
  await taskFile(PROJECT, 'sess-1', 'b1', 'bg\n')
  await taskFile(PROJECT, 'sess-1', 'b2', 'sub\n')
  const { tails, chunks } = follower()
  tails.observe(bashCall('toolu_bg'))
  tails.observe(taskStarted('b1', 'toolu_bg', true))
  tails.observe(bashCall('toolu_sub', 'toolu_agent'))
  tails.observe(taskStarted('b2', 'toolu_sub'))
  await pause()
  expect(chunks).toEqual([])
})

test('a command sent to the background stops being followed', async () => {
  const path = await taskFile(PROJECT, 'sess-1', 'b1', 'first\n')
  const { tails, text } = follower()
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text() === 'first\n')
  tails.observe({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true } })
  await appendFile(path, 'later\n')
  await pause()
  expect(text()).toBe('first\n')
})

test('a file that never appears is given up on quietly', async () => {
  const { tails, chunks } = follower({ locateAttempts: 3 })
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await pause(60)
  await taskFile(PROJECT, 'sess-1', 'b1', 'too late\n')
  await pause()
  await tails.observe(toolResult('toolu_1'))
  expect(chunks).toEqual([])
})

test('a file the CLI removes ends the following without a word', async () => {
  const path = await taskFile(PROJECT, 'sess-1', 'b1', 'x\n')
  const { tails, text } = follower()
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text() === 'x\n')
  await rm(path)
  await pause()
  // Nothing left to wait on: the following has already ended.
  expect(tails.observe(toolResult('toolu_1'))).toBeUndefined()
  expect(text()).toBe('x\n')
})

test('each read is capped, and so is all of it', async () => {
  await taskFile(PROJECT, 'sess-1', 'b1', 'a'.repeat(25))
  const { tails, chunks, text } = follower({ maxBytesPerTick: 10, maxTotalBytes: 20 })
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text().length === 20)
  await pause()
  await tails.observe(toolResult('toolu_1'))
  expect(chunks.map((chunk) => chunk.output.length)).toEqual([10, 10])
  expect(chunks.map((chunk) => chunk.totalBytes)).toEqual([10, 20])
})

test('a character split across two reads comes out whole', async () => {
  // "é" is two bytes; a 3-byte read cuts the second one in half.
  await taskFile(PROJECT, 'sess-1', 'b1', 'aéé')
  const { tails, chunks, text } = follower({ maxBytesPerTick: 2 })
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text() === 'aéé')
  expect(chunks.map((chunk) => chunk.output)).toEqual(['a', 'é', 'é'])
})

test('nothing is handed on once following stops for good', async () => {
  const path = await taskFile(PROJECT, 'sess-1', 'b1', 'x\n')
  const { tails, text } = follower()
  tails.observe(bashCall('toolu_1'))
  tails.observe(taskStarted('b1', 'toolu_1'))
  await until(() => text() === 'x\n')
  tails.stopAll()
  await appendFile(path, 'y\n')
  await pause()
  expect(text()).toBe('x\n')
  expect(tails.observe(taskStarted('b2', 'toolu_1'))).toBeUndefined()
})
