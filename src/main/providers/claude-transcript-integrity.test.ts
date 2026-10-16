import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { claudeProjectDirName, ensureResumableTranscript, transcriptCheckNote } from './claude-transcript-integrity'

const cwd = '/Users/dev/acme-app'
const sessionId = '11111111-2222-3333-4444-555555555555'
let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'claude-transcript-'))
})
afterEach(() => rmSync(configDir, { recursive: true, force: true }))

function writeSession(rows: object[], dir = claudeProjectDirName(cwd)): string {
  const folder = join(configDir, 'projects', dir)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${sessionId}.jsonl`)
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return path
}

function parents(path: string): Array<string | null> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { parentUuid?: string | null })
    .map((row) => row.parentUuid ?? null)
}

test('the folder name is the cwd with every non-alphanumeric character as a dash', () => {
  expect(claudeProjectDirName('/Volumes/work drive/app.v2')).toBe('-Volumes-work-drive-app-v2')
})

test('an intact chain is left as it is, and its saved cost total is read', async () => {
  const path = writeSession([
    { type: 'user', uuid: 'a', parentUuid: null },
    { type: 'assistant', uuid: 'b', parentUuid: 'a' },
    { type: 'cost-state', totalCostUSD: 4.5 },
    { type: 'user', uuid: 'c', parentUuid: 'b' },
  ])
  const before = readFileSync(path, 'utf8')
  const check = await ensureResumableTranscript(configDir, cwd, sessionId)
  expect(check).toEqual({ kind: 'ok', savedCostUsd: 4.5 })
  expect(readFileSync(path, 'utf8')).toBe(before)
  expect(transcriptCheckNote(check)).toBeNull()
})

test('an entry whose parent was never written is relinked to the entry before it, with a backup kept', async () => {
  const path = writeSession([
    { type: 'user', uuid: 'a', parentUuid: null },
    { type: 'assistant', uuid: 'b', parentUuid: 'a' },
    { type: 'user', uuid: 'side', parentUuid: 'b', isSidechain: true },
    // The assistant message holding this tool call was lost in a crash.
    { type: 'user', uuid: 'c', parentUuid: 'lost' },
    { type: 'assistant', uuid: 'd', parentUuid: 'c' },
  ])
  const check = await ensureResumableTranscript(configDir, cwd, sessionId, () => 42)
  expect(check).toMatchObject({ kind: 'repaired', links: 1, backupPath: `${path}.before-repair-42` })
  expect(parents(path)).toEqual([null, 'a', 'b', 'b', 'c'])
  expect(parents(`${path}.before-repair-42`)[3]).toBe('lost')
  expect(transcriptCheckNote(check)).toMatch(/relinked/u)
  // Nothing else is left behind in the folder.
  expect(readdirSync(join(configDir, 'projects', claudeProjectDirName(cwd))).sort()).toEqual([
    `${sessionId}.jsonl`,
    `${sessionId}.jsonl.before-repair-42`,
  ])
})

test('a session filed under another folder (a long, hashed cwd) is still found', async () => {
  const path = writeSession(
    [
      { type: 'user', uuid: 'a', parentUuid: null },
      { type: 'user', uuid: 'b', parentUuid: 'gone' },
    ],
    '-Users-dev-acme-app-shortened-1a2b3c',
  )
  expect(await ensureResumableTranscript(configDir, cwd, sessionId)).toMatchObject({ kind: 'repaired', links: 1 })
  expect(parents(path)).toEqual([null, 'a'])
})

test('a session with no file is reported missing and says nothing of its own', async () => {
  const check = await ensureResumableTranscript(configDir, cwd, sessionId)
  expect(check).toEqual({ kind: 'missing' })
  expect(transcriptCheckNote(check)).toBeNull()
})
