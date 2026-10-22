import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createWebUploads, MAX_UPLOAD_BYTES, safeUploadName, uploadOwnerDir } from './web-uploads'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'web-uploads-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

function body(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = new PassThrough()
  Object.assign(stream, { headers })
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk)
    stream.end()
  })
  return stream as unknown as IncomingMessage
}

test('a dropped file is saved under its session, by its own name, for the agent to read by path', async () => {
  const uploads = createWebUploads({ dataDir })
  const saved = await uploads.save({
    sessionId: 'sess-1',
    name: 'notes.csv',
    request: body([Buffer.from('a,b\n1,2\n')]),
  })
  expect(saved.ok).toBe(true)
  if (!saved.ok) return
  expect(saved.path.startsWith(join(dataDir, 'web-uploads', uploadOwnerDir('sess-1')))).toBe(true)
  expect(saved.path.endsWith('notes.csv')).toBe(true)
  expect(readFileSync(saved.path, 'utf8')).toBe('a,b\n1,2\n')
  if (process.platform !== 'win32') expect(statSync(saved.path).mode & 0o777).toBe(0o600)
  // Two files of one name never meet.
  const again = await uploads.save({ sessionId: 'sess-1', name: 'notes.csv', request: body([Buffer.from('x')]) })
  expect(again.ok && again.path).not.toBe(saved.path)
})

test('a name cannot leave its directory or carry what a file system refuses', () => {
  expect(safeUploadName('../../etc/passwd')).toBe('passwd')
  expect(safeUploadName('C:\\Users\\dev\\report.pdf')).toBe('report.pdf')
  expect(safeUploadName('..')).toBe('upload')
  expect(safeUploadName('.env')).toBe('env')
  expect(safeUploadName('a<b>:c?.txt')).toBe('a_b__c_.txt')
  expect(safeUploadName(null)).toBe('upload')
  expect(safeUploadName('x'.repeat(300))).toHaveLength(200)
})

test('a name is trimmed before its dots go, and is never a dot name', () => {
  expect(safeUploadName(' ..')).toBe('upload')
  expect(safeUploadName(' . ')).toBe('upload')
  expect(safeUploadName('  .env ')).toBe('env')
  expect(safeUploadName('report.')).toBe('report')
})

test('a name Windows keeps for a device is saved under another', () => {
  for (const name of ['CON', 'con.txt', 'Nul.tar.gz', 'COM1', 'lpt9.log', 'aux ']) {
    const safe = safeUploadName(name)
    expect(safe.startsWith('_')).toBe(true)
  }
  expect(safeUploadName('console.log')).toBe('console.log')
})

test('invisible formatting characters are dropped', () => {
  expect(safeUploadName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
  expect(safeUploadName('a\u200Bb\u2066c.txt')).toBe('abc.txt')
})

test('a long name is cut to 200 bytes on a character boundary, keeping its extension', () => {
  const name = safeUploadName(`${'é'.repeat(150)}.png`)
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
  expect(name.endsWith('.png')).toBe(true)
  expect(name).not.toContain('\uFFFD')
  const emoji = safeUploadName('😀'.repeat(80))
  expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200)
  expect([...emoji].every((char) => char === '😀')).toBe(true)
})

test('two sessions whose ids differ only in characters a folder name drops keep apart', () => {
  expect(uploadOwnerDir('a.b')).not.toBe(uploadOwnerDir('ab'))
  expect(uploadOwnerDir('a/b')).not.toBe(uploadOwnerDir('ab'))
  expect(uploadOwnerDir('sess-1')).toMatch(/^[0-9a-f]{32}$/u)
})

test('over 50 MB is refused, by its declared length or as it arrives, and nothing is kept', async () => {
  const uploads = createWebUploads({ dataDir })
  const declared = await uploads.save({
    sessionId: 'sess-1',
    name: 'big.bin',
    request: body([], { 'content-length': String(MAX_UPLOAD_BYTES + 1) }),
  })
  expect(declared).toMatchObject({ ok: false, status: 413 })
  const chunk = Buffer.alloc(8 * 1024 * 1024)
  const streamed = await uploads.save({ sessionId: 'sess-1', name: 'big.bin', request: body(Array(7).fill(chunk)) })
  expect(streamed).toMatchObject({ ok: false, status: 413 })
  expect(readdirSync(join(dataDir, 'web-uploads', uploadOwnerDir('sess-1')))).toEqual([])
})

test('uploads are kept a week, and a removed browser takes its own with it', async () => {
  let now = Date.now()
  const uploads = createWebUploads({ dataDir, now: () => now })
  const old = await uploads.save({ sessionId: 'sess-1', name: 'old.txt', request: body([Buffer.from('old')]) })
  if (!old.ok) throw new Error('not saved')
  const oldDir = join(old.path, '..')
  utimesSync(oldDir, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000))
  await uploads.save({ sessionId: 'sess-2', name: 'new.txt', request: body([Buffer.from('new')]) })
  expect(() => statSync(oldDir)).toThrow()
  now += 1
  uploads.forgetSession('sess-2')
  expect(() => statSync(join(dataDir, 'web-uploads', uploadOwnerDir('sess-2')))).toThrow()
})
