import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { createTailnetFileUploads } from './tailnet-file-uploads'

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
