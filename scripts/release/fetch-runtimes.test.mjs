import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { NPM_INTEGRITY, NPM_VERSION, vendoredNpmVersion, verifyIntegrity } from '../fetch-runtimes.mjs'

const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

test('the tarball is accepted only when it hashes to the pinned integrity', () => {
  const tarball = Buffer.from('npm tarball bytes')
  verifyIntegrity(tarball, integrityOf(tarball))
  const tampered = Buffer.from('npm tarball bytes, tampered')
  assert.throws(() => verifyIntegrity(tampered, integrityOf(tarball), 'npm.tgz'), /integrity mismatch for npm\.tgz/)
  assert.throws(() => verifyIntegrity(tarball, 'sha1-abc'), /unsupported integrity/)
})

test('the pin is a full sha512 for a release of npm Electron 44 can run', () => {
  assert.match(NPM_INTEGRITY, /^sha512-[A-Za-z0-9+/]{86}==$/)
  assert.match(NPM_VERSION, /^11\.\d+\.\d+$/)
})

test('a vendored npm counts as present only by its own version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-runtimes-'))
  try {
    assert.equal(vendoredNpmVersion(dir), null)
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'npm-cli.js'), '')
    assert.equal(vendoredNpmVersion(dir), null, 'no package.json: not known, so refetched')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'npm', version: '10.9.0' }))
    assert.equal(vendoredNpmVersion(dir), '10.9.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
