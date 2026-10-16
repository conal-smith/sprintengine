import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { agentPathOf, createWorkspaceRecordingOutputs } from './recording-output'
import { readWebmDurationMs, withWebmDuration } from './webm-duration'
import { workspaceStorePath } from '../workspace-store'

// Where a recording lands, on a real folder: the project's store in the home
// folder (the test setup's), never the project, written as it arrives and
// finished with its length.

const RECORDED = new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'media-recorder-vp9-160x120.webm')))

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-recording-'))
  made.push(dir)
  return dir
}

const recordings = (root: string) => workspaceStorePath(root, 'browser', 'recordings')

test('a recording is written into the project’s store, not the project, and finished with its length', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-localhost-5173-20261004-090507' })
  assert.ok(created.ok)
  const { output } = created
  assert.equal(output.path, join(recordings(root), 'recording-localhost-5173-20261004-090507.webm'))
  assert.deepEqual(readdirSync(root), [], 'nothing is written into the project')

  // Written as it arrives, under a name that says it is not done.
  await output.append(RECORDED.subarray(0, 4_000))
  await output.append(RECORDED.subarray(4_000))
  assert.equal(existsSync(output.path!), false)
  assert.deepEqual(readdirSync(recordings(root)), ['recording-localhost-5173-20261004-090507.webm.part'])

  const done = await output.finish(1_000)
  const saved = new Uint8Array(readFileSync(output.path!))
  assert.equal(done.bytes, saved.length)
  assert.equal(readWebmDurationMs(saved), 1_000)
  assert.deepEqual(readdirSync(recordings(root)), ['recording-localhost-5173-20261004-090507.webm'])
})

test('bytes this edit does not understand are kept as they came', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(created.ok)
  await created.output.append(new Uint8Array([1, 2, 3]))
  assert.equal((await created.output.finish(500)).bytes, 3)
  assert.deepEqual([...readFileSync(created.output.path!)], [1, 2, 3])
})

test('a recording far longer than the header read is finished whole, byte for byte after its length', async () => {
  // The fixture's own clusters, then a megabyte more: well past the head the
  // finish reads, so everything after it has to be copied across.
  const tail = new Uint8Array(1024 * 1024).map((_, index) => index % 251)
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-long' })
  assert.ok(created.ok)
  await created.output.append(RECORDED)
  await created.output.append(tail)
  const done = await created.output.finish(61_000)
  const saved = new Uint8Array(readFileSync(created.output.path!))
  const whole = new Uint8Array(RECORDED.length + tail.length)
  whole.set(RECORDED)
  whole.set(tail, RECORDED.length)
  assert.deepEqual(saved, withWebmDuration(whole, 61_000))
  assert.equal(done.bytes, saved.length)
  assert.equal(readWebmDurationMs(saved), 61_000)
  assert.deepEqual(readdirSync(recordings(root)), ['recording-long.webm'])
})

test('a second recording in the same second takes the next free name', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const first = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  const second = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(first.ok && second.ok)
  assert.equal(second.output.path, join(recordings(root), 'recording-x-2.webm'))
})

test('two recordings that start together never share a file', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await Promise.all([1, 2, 3].map(() => outputs.create({ workspaceId: 'ws', stem: 'recording-x' })))
  const names = created.map((result) => (result.ok ? result.output.path : result.code))
  assert.equal(new Set(names).size, 3, names.join(', '))
  assert.deepEqual(readdirSync(recordings(root)).sort(), [
    'recording-x-2.webm.part',
    'recording-x-3.webm.part',
    'recording-x.webm.part',
  ])
})

test('a discarded recording leaves nothing behind', async () => {
  const root = workspace()
  const outputs = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => root })
  const created = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(created.ok)
  await created.output.append(new Uint8Array([1]))
  await created.output.discard()
  assert.deepEqual(readdirSync(recordings(root)), [])
})

test('a workspace on an SSH machine is refused before anything is written, naming the machine', async () => {
  const outputs = createWorkspaceRecordingOutputs({
    resolveWorkspaceRoot: () => 'ssh://e1/home/dev/app',
    machineLabel: (id) => (id === 'e1' ? 'build-box' : null),
  })
  const refused = await outputs.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.ok(!refused.ok)
  assert.equal(refused.code, 'recording_unavailable')
  assert.match(refused.message, /build-box/)
})

test('a workspace with no folder here is refused', async () => {
  const none = createWorkspaceRecordingOutputs({ resolveWorkspaceRoot: () => null })
  const refused = await none.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.equal(!refused.ok && refused.code, 'no_workspace_folder')
  const gone = createWorkspaceRecordingOutputs({
    resolveWorkspaceRoot: () => join(tmpdir(), 'se-recording-missing-folder'),
  })
  const alsoRefused = await gone.create({ workspaceId: 'ws', stem: 'recording-x' })
  assert.equal(!alsoRefused.ok && alsoRefused.code, 'no_workspace_folder')
})

test('a WSL workspace’s file is named for the agent by its Linux path', () => {
  assert.equal(
    agentPathOf('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.sprintengine\\workspaces\\app-0123456789abcdef\\r.webm'),
    '/home/dev/.sprintengine/workspaces/app-0123456789abcdef/r.webm',
  )
  assert.equal(agentPathOf('/Users/dev/app/r.webm'), '/Users/dev/app/r.webm')
})
