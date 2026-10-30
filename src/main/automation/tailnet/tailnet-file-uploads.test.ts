import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { noteUploadsSent } from '../../upload-references'
import { createTailnetFileUploads, holdTailnetUpload, releaseTailnetUpload } from './tailnet-file-uploads'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tailnet-file-uploads-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('two files of one name from one device each get a folder of their own', () => {
  const uploads = createTailnetFileUploads({ root })
  const first = uploads.place('device-1', 'report.pdf')
  const second = uploads.place('device-1', 'report.pdf')
  assert.notEqual(dirname(first.path), dirname(second.path))
  assert.equal(first.name, 'report.pdf')
  assert.ok(existsSync(dirname(first.path)))
})

test('a device id is a folder name, never a path', () => {
  const uploads = createTailnetFileUploads({ root })
  const place = uploads.place('../../elsewhere', 'a.txt')
  assert.ok(!relative(root, place.path).startsWith('..'), place.path)
})

test('removing a place removes its folder only', () => {
  const uploads = createTailnetFileUploads({ root })
  const kept = uploads.place('device-1', 'kept.txt')
  const gone = uploads.place('device-1', 'gone.txt')
  writeFileSync(kept.path, 'kept')
  writeFileSync(gone.path, 'gone')
  gone.remove()
  assert.equal(existsSync(dirname(gone.path)), false)
  assert.ok(existsSync(kept.path))
})

test('a file kept over a week is removed when the next one is placed', () => {
  let now = Date.UTC(2026, 9, 1)
  const uploads = createTailnetFileUploads({ root, now: () => now })
  const old = uploads.place('device-1', 'old.txt')
  writeFileSync(old.path, 'old')
  const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000)
  utimesSync(dirname(old.path), eightDaysAgo, eightDaysAgo)
  const recent = uploads.place('device-1', 'recent.txt')
  writeFileSync(recent.path, 'recent')
  now += 1000
  uploads.place('device-2', 'next.txt')
  assert.equal(existsSync(old.path), false)
  assert.ok(existsSync(recent.path))
})

test('forgetting a device removes everything it sent, and nothing another sent', () => {
  const uploads = createTailnetFileUploads({ root })
  const mine = uploads.place('device-1', 'mine.txt')
  const theirs = uploads.place('device-2', 'theirs.txt')
  writeFileSync(mine.path, 'mine')
  writeFileSync(theirs.path, 'theirs')
  uploads.forgetDevice('device-1')
  assert.equal(existsSync(mine.path), false)
  assert.ok(existsSync(theirs.path))
})

test('two devices whose ids differ only in characters a folder name drops keep apart', () => {
  const uploads = createTailnetFileUploads({ root })
  const first = uploads.place('device.1', 'a.txt')
  const second = uploads.place('device1', 'a.txt')
  assert.notEqual(dirname(dirname(first.path)), dirname(dirname(second.path)))
  uploads.forgetDevice('device1')
  assert.ok(existsSync(dirname(first.path)))
})

test('a file a held message carries outlives the week, and goes or stays as the message did', () => {
  const now = Date.UTC(2026, 9, 1)
  const uploads = createTailnetFileUploads({ root, now: () => now })
  const held = uploads.place('device-1', 'held.txt')
  const dropped = uploads.place('device-1', 'dropped.txt')
  writeFileSync(held.path, 'held')
  writeFileSync(dropped.path, 'dropped')
  assert.equal(holdTailnetUpload(root, held.path), true)
  assert.equal(holdTailnetUpload(root, dropped.path), true)
  // Only an upload's own file is ever marked or removed.
  assert.equal(holdTailnetUpload(root, join(root, 'elsewhere.txt')), false)
  assert.equal(holdTailnetUpload(root, join(root, '..', 'outside', 'a', 'b')), false)
  const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000)
  utimesSync(dirname(held.path), eightDaysAgo, eightDaysAgo)
  uploads.place('device-2', 'next.txt')
  assert.ok(existsSync(held.path), 'pruning passes a held file by')
  releaseTailnetUpload(root, held.path, true)
  uploads.place('device-2', 'again.txt')
  assert.ok(existsSync(held.path), 'sent, it is kept a week from now')
  releaseTailnetUpload(root, dropped.path, false)
  assert.equal(existsSync(dirname(dropped.path)), false, 'deleted, it goes with its folder')
})

test('a file sent in a chat outlives the week while the chat is kept, and goes once it is deleted', async () => {
  const now = Date.UTC(2026, 9, 1)
  const uploads = createTailnetFileUploads({ root, now: () => now })
  const sent = uploads.place('device-1', 'spec.pdf')
  writeFileSync(sent.path, 'spec')
  const transcript = join(root, '..', `${relative(tmpdir(), root)}-transcript.jsonl`)
  writeFileSync(transcript, '{}\n')
  try {
    await noteUploadsSent([root], [sent.path], transcript)
    await noteUploadsSent([root], [sent.path], transcript)
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000)
    utimesSync(dirname(sent.path), eightDaysAgo, eightDaysAgo)
    uploads.place('device-2', 'next.txt')
    assert.ok(existsSync(sent.path), 'its chat may read it again')
    rmSync(transcript)
    uploads.place('device-2', 'after.txt')
    assert.equal(existsSync(sent.path), false, 'no chat it was sent in is kept')
  } finally {
    rmSync(transcript, { force: true })
  }
})

test('only a file in an upload folder is noted', async () => {
  const outside = join(root, 'loose.txt')
  writeFileSync(outside, 'x')
  await noteUploadsSent([root], [outside, join(root, '..', 'elsewhere.txt')], '/Users/dev/transcript.jsonl')
  assert.equal(existsSync(join(root, '.sent')), false)
})
