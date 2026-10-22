import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { installedStudioPlatform } from '../../server/platform/platform'
import type { SecretCipher } from '../../server/platform/secret-cipher'

// Record of the third-party modules the user has trusted, keyed by module id to
// the *manifest fingerprint* that was trusted (see module-signature.ts). Binding
// trust to content means reinstalling a different manifest under the same id
// does not inherit trust.
//
// A trusted module runs with full access to the app, so the record is only
// honoured as Studio wrote it: the file carries an HMAC over its entries, keyed
// by a random key that is kept sealed with the platform's cipher (safeStorage:
// the OS keychain on macOS, DPAPI on Windows, the secret service on Linux).
// A file edited, or written, by anything that cannot open that key reads as
// "nothing trusted" — the safe default, as is a missing or malformed file.
// So does a record an earlier build wrote without a MAC: there is no telling
// it from one written outside Studio, so each module is trusted again once.
//
// With no cipher that protects what it seals (Linux without a keyring, or
// before the app is ready there), nothing is read from disk or written to it:
// trust granted then lasts for the session only, the rule every sealed store
// in the app keeps.

const FILE_NAME = 'trusted-modules.json'
const KEY_FILE_NAME = 'trusted-modules.key'
const FORMAT_VERSION = 2
const MAC_CONTEXT = 'sprintengine-studio/trusted-modules/v2\n'
const KEY_BYTES = 32

type TrustCipher = Pick<SecretCipher, 'available' | 'seal' | 'open'>

function trustedModulesPath(userDataDir: string): string {
  return join(userDataDir, FILE_NAME)
}

function keyPath(userDataDir: string): string {
  return join(userDataDir, KEY_FILE_NAME)
}

/** The platform's cipher, when it protects what it seals right now. */
function trustCipher(): TrustCipher | null {
  const cipher = installedStudioPlatform()?.secrets
  try {
    return cipher && cipher.available() ? cipher : null
  } catch {
    return null
  }
}

// The MAC key once opened (or made), per profile: the keychain is asked once a
// session, and a key file removed while the app runs does not change the answer.
const openedKeys = new Map<string, Buffer>()

// Trust granted while no cipher could keep it, per profile, for this session.
const sessionTrust = new Map<string, Map<string, string>>()

function openKey(userDataDir: string, cipher: TrustCipher): Buffer | null {
  const cached = openedKeys.get(userDataDir)
  if (cached) return cached
  const path = keyPath(userDataDir)
  if (!existsSync(path)) return null
  try {
    const key = Buffer.from(cipher.open(readFileSync(path)), 'base64')
    if (key.length !== KEY_BYTES) return null
    openedKeys.set(userDataDir, key)
    return key
  } catch {
    return null
  }
}

/** The key to write with: the one on record, or a new one when there is none that opens. */
function writingKey(userDataDir: string, cipher: TrustCipher): Buffer {
  const existing = openKey(userDataDir, cipher)
  if (existing) return existing
  const key = randomBytes(KEY_BYTES)
  writeFileSync(keyPath(userDataDir), cipher.seal(key.toString('base64')), { mode: 0o600 })
  openedKeys.set(userDataDir, key)
  return key
}

function sortedRecord(trusted: Map<string, string>): Record<string, string> {
  const record: Record<string, string> = {}
  for (const id of [...trusted.keys()].sort()) record[id] = trusted.get(id)!
  return record
}

function macOf(key: Buffer, modules: Record<string, string>): Buffer {
  return createHmac('sha256', key)
    .update(MAC_CONTEXT + JSON.stringify(modules))
    .digest()
}

function parseTrustedModules(raw: string, key: Buffer): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const file = parsed as { version?: unknown; modules?: unknown; mac?: unknown }
    if (file.version !== FORMAT_VERSION || typeof file.mac !== 'string') return new Map()
    if (!file.modules || typeof file.modules !== 'object' || Array.isArray(file.modules)) return new Map()
    const out = new Map<string, string>()
    for (const [id, fingerprint] of Object.entries(file.modules as Record<string, unknown>)) {
      if (id.length > 0 && typeof fingerprint === 'string' && fingerprint.length > 0) out.set(id, fingerprint)
    }
    // The MAC is over the entries as they are honoured, so an entry the reader
    // would drop cannot ride along on a record that otherwise verifies.
    const expected = macOf(key, sortedRecord(out))
    const given = Buffer.from(file.mac, 'hex')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Map()
    return out
  } catch {
    return new Map()
  }
}

export function readTrustedModulesSync(userDataDir: string): Map<string, string> {
  const cipher = trustCipher()
  if (!cipher) return new Map(sessionTrust.get(userDataDir) ?? [])
  const path = trustedModulesPath(userDataDir)
  if (!existsSync(path)) return new Map()
  const key = openKey(userDataDir, cipher)
  if (!key) return new Map()
  try {
    return parseTrustedModules(readFileSync(path, 'utf8'), key)
  } catch {
    return new Map()
  }
}

export type TrustWriteResult = { ok: boolean; message?: string }

async function persist(userDataDir: string, trusted: Map<string, string>): Promise<TrustWriteResult> {
  const cipher = trustCipher()
  if (!cipher) {
    sessionTrust.set(userDataDir, new Map(trusted))
    return { ok: true }
  }
  const path = trustedModulesPath(userDataDir)
  try {
    await mkdir(userDataDir, { recursive: true })
    const key = writingKey(userDataDir, cipher)
    const modules = sortedRecord(trusted)
    const tmp = `${path}.tmp`
    const file = { version: FORMAT_VERSION, modules, mac: macOf(key, modules).toString('hex') }
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 })
    await rename(tmp, path)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'write_failed' }
  }
}

// Serialize read-modify-write so two rapid trust toggles can't lose an update
// (each call re-reads the on-disk state after the previous write completes).
let writeChain: Promise<unknown> = Promise.resolve()

// `previous` is what this id mapped to before the write (null when it was not
// trusted). It is what a caller restores when the work the grant belongs to
// fails afterwards — the marketplace install grants trust before writing its
// receipt, and a failed receipt write has to put the entry back as it was.
export async function setModuleTrust(
  userDataDir: string,
  id: string,
  fingerprint: string | null,
): Promise<{ result: TrustWriteResult; trustedModules: Map<string, string>; previous: string | null }> {
  const run = writeChain.then(async () => {
    const current = readTrustedModulesSync(userDataDir)
    const previous = current.get(id) ?? null
    if (fingerprint) current.set(id, fingerprint)
    else current.delete(id)
    const result = await persist(userDataDir, current)
    return { result, trustedModules: current, previous }
  })
  // Keep the chain alive even if this link rejects, so a failure doesn't wedge it.
  writeChain = run.catch(() => undefined)
  return run
}
