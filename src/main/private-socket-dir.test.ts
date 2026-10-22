import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'

import { privateSocketDirectory, withOwnerOnlyUmask } from './private-socket-dir'

const bases: string[] = []
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true })
})

function base(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-private-socket-'))
  bases.push(dir)
  return dir
}

const posix = process.platform !== 'win32'
const uid = process.getuid?.() ?? 0

test.runIf(posix)('the folder is made owner-only, and found again by the next caller', () => {
  const root = base()
  const dir = privateSocketDirectory(root)
  assert.equal(dir, join(root, `sprintengine-${uid}`))
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(privateSocketDirectory(root), dir)
})

test.runIf(posix)('a folder of that name others can enter, or a link in its place, is not used', () => {
  const open = base()
  mkdirSync(join(open, `sprintengine-${uid}`))
  chmodSync(join(open, `sprintengine-${uid}`), 0o777)
  const instead = privateSocketDirectory(open)
  assert.notEqual(instead, join(open, `sprintengine-${uid}`))
  assert.equal(dirname(instead), open)
  assert.equal(statSync(instead).mode & 0o777, 0o700)
  // The same stand-in for the rest of this process, so every socket agrees.
  assert.equal(privateSocketDirectory(open), instead)

  const linked = base()
  const elsewhere = join(linked, 'elsewhere')
  mkdirSync(elsewhere, { mode: 0o700 })
  symlinkSync(elsewhere, join(linked, `sprintengine-${uid}`))
  const notTheLink = privateSocketDirectory(linked)
  assert.notEqual(notTheLink, join(linked, `sprintengine-${uid}`))
  assert.equal(lstatSync(notTheLink).isSymbolicLink(), false)
})

test.runIf(posix)('a socket listened on under the owner-only umask is 0600 the moment it exists', async () => {
  const socketPath = join(base(), 's.sock')
  const before = process.umask()
  const server = createServer()
  let modeAtBind = -1
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    withOwnerOnlyUmask(() => {
      server.listen(socketPath)
      // Bound already: read before anything could narrow it.
      modeAtBind = statSync(socketPath).mode & 0o777
    })
    server.once('listening', () => resolve())
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.equal(modeAtBind, 0o600)
  assert.equal(process.umask(), before, 'the umask is put back')
})
