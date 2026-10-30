// `studio-server triage`: what goes into the prompt, and what is kept out.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'vitest'

import { parseServerArgs } from './main'
import { readTriageEntries, triageEntry, triageLogDirectories, triagePrompt } from './triage'

const scratch = mkdtempSync(join(tmpdir(), 'se-triage-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const HOME = '/Users/dev'

test('an entry keeps its words and loses the home folder, its log path and its secrets', () => {
  const line = JSON.stringify({
    level: 'error',
    source: 'cli',
    title: 'Codex could not start',
    message: 'spawn /Users/dev/.local/bin/codex ENOENT',
    details: 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    timestamp: '2026-10-30T00:49:54.904Z',
    logPath: '/Users/dev/Library/Logs/SprintEngine Studio/diagnostics-2026-10-30.jsonl',
  })
  const entry = triageEntry(line, HOME)!
  assert.match(entry, /2026-10-30T00:49:54.904Z error cli Codex could not start — spawn ~\/.local\/bin\/codex ENOENT/u)
  assert.doesNotMatch(entry, /\/Users\/dev/u)
  assert.doesNotMatch(entry, /Library\/Logs/u, 'the log path is not carried')
  assert.doesNotMatch(entry, /abcdefghijklmnopqrstuvwxyz0123456789/u)
  assert.equal(triageEntry('not json', HOME), null)
  assert.equal(triageEntry(JSON.stringify({ level: 'info' }), HOME), null, 'an entry with no words is left out')
})

test('the newest entries of the newest files are read, oldest first, within the limit', async () => {
  const dir = join(scratch, 'logs')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir)
  const write = (day: string, titles: string[]) =>
    writeFileSync(
      join(dir, `diagnostics-${day}.jsonl`),
      titles.map((title) => JSON.stringify({ level: 'info', source: 'app', title })).join('\n') + '\n',
    )
  write('2026-10-28', ['one'])
  write('2026-10-30', ['four', 'five'])
  write('2026-10-29', ['two', 'three'])
  writeFileSync(join(dir, 'other.txt'), 'ignored')
  const entries = await readTriageEntries([dir, join(scratch, 'missing')], HOME, 4)
  assert.deepEqual(
    entries.map((entry) => entry.split(' ').at(-1)),
    ['two', 'three', 'four', 'five'],
  )
})

test('the prompt says what to do and carries the facts', () => {
  const prompt = triagePrompt(
    { studioVersion: '0.9.0', node: '22.12.0', platform: 'darwin', osRelease: '25.2.0', arch: 'arm64' },
    ['2026-10-30 error cli Codex could not start'],
  )
  assert.match(prompt, /SprintEngine Studio 0\.9\.0/u)
  assert.match(prompt, /darwin 25\.2\.0 \(arm64\)/u)
  assert.match(prompt, /- 2026-10-30 error cli Codex could not start/u)
  assert.match(prompt, /Ask before running any command that changes something/u)
})

test('the desktop app’s log folder is looked in first, on each platform', () => {
  const serverLogsDir = '/Users/dev/.local/state/sprintengine-studio/logs'
  assert.deepEqual(triageLogDirectories({ platform: 'darwin', home: HOME, env: {}, serverLogsDir }), [
    '/Users/dev/Library/Logs/SprintEngine Studio',
    serverLogsDir,
  ])
  assert.equal(
    triageLogDirectories({ platform: 'linux', home: '/home/dev', env: {}, serverLogsDir })[0],
    '/home/dev/.config/SprintEngine Studio/logs',
  )
})

test('triage is a command of its own, with claude by default', () => {
  const parsed = parseServerArgs(['triage'], {})
  assert.equal(parsed.kind, 'triage')
  if (parsed.kind === 'triage') {
    assert.equal(parsed.agent, 'claude')
    assert.equal(parsed.print, false)
  }
  const codex = parseServerArgs(['triage', '--agent', 'codex', '--print'], {})
  assert.ok(codex.kind === 'triage' && codex.agent === 'codex' && codex.print)
  assert.throws(() => parseServerArgs(['triage', '--agent', 'cursor'], {}), /claude or codex/u)
  assert.throws(() => parseServerArgs(['serve', '--print'], {}), /--print goes with triage/u)
})
