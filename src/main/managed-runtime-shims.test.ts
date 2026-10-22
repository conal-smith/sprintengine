import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, test, vi } from 'vitest'

// The shims land under the home directory; this suite's is a temporary one.
const home = mkdtempSync(join(tmpdir(), 'managed-runtime-shims-'))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), homedir: () => home }))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const { ensureManagedRuntimeShims, EXTRA_CA_PRELOAD_FILE, EXTRA_CA_PRELOAD_SOURCE } = await import('./managed-runtime')

function env(execPathIsElectron: boolean | undefined) {
  const npmCli = join('/app/resources', 'runtime', 'npm', 'bin', 'npm-cli.js')
  return {
    platform: 'linux' as const,
    resourcesPath: '/app/resources',
    isPackaged: true,
    execPath: execPathIsElectron === false ? '/usr/local/bin/node' : '/app/sprintengine',
    ...(execPathIsElectron === undefined ? {} : { execPathIsElectron }),
    cwd: '/checkout',
    exists: (path: string) => path === npmCli,
  }
}

test.skipIf(process.platform === 'win32')(
  'the shims turn Electron into Node, and leave a plain Node exactly as it is',
  () => {
    const electron = ensureManagedRuntimeShims(env(undefined))
    assert.ok(electron)
    const electronNode = readFileSync(join(electron.shimDir, 'node'), 'utf8')
    assert.match(
      electronNode,
      /^exec env ELECTRON_RUN_AS_NODE=1 SPRINTENGINE_NODE_EXTRA_CA_CERTS="\$\{NODE_EXTRA_CA_CERTS-\}" '\/app\/sprintengine' --require '[^']+studio-extra-ca\.cjs' "\$@"$/m,
    )
    assert.match(readFileSync(join(electron.shimDir, 'npm'), 'utf8'), /--require '[^']+studio-extra-ca\.cjs' '\/app/)
    assert.equal(readFileSync(join(electron.shimDir, EXTRA_CA_PRELOAD_FILE), 'utf8'), EXTRA_CA_PRELOAD_SOURCE)

    const node = ensureManagedRuntimeShims(env(false))
    assert.ok(node)
    const nodeShim = readFileSync(join(node.shimDir, 'node'), 'utf8')
    const npmShim = readFileSync(join(node.shimDir, 'npm'), 'utf8')
    assert.doesNotMatch(nodeShim + npmShim, /ELECTRON_RUN_AS_NODE|--require/)
    assert.match(nodeShim, /^exec '\/usr\/local\/bin\/node' "\$@"$/m)
  },
)

// Studio's binary removes NODE_EXTRA_CA_CERTS from its own environment as it
// starts (its nodeOptions fuse), so the shim hands it over under another name
// and the preload applies it. Run here against a stand-in for Node's tls.
test('the certificate preload adds what NODE_EXTRA_CA_CERTS names, and puts the variable back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extra-ca-'))
  try {
    const pem = join(dir, 'proxy.pem')
    const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'
    writeFileSync(pem, `${cert}\n${cert.replace('AAAA', 'BBBB')}\n`)
    const run = (env: Record<string, string>) => {
      let defaults: string[] = ['root']
      const warnings: string[] = []
      const process = { env: { ...env }, emitWarning: (message: string) => warnings.push(message) }
      const tls = {
        getCACertificates: () => defaults,
        setDefaultCACertificates: (next: string[]) => {
          defaults = next
        },
      }
      const require = (name: string) => (name === 'tls' ? tls : name === 'fs' ? { readFileSync } : assert.fail(name))
      runInNewContext(EXTRA_CA_PRELOAD_SOURCE, { process, require })
      return { defaults, env: process.env, warnings }
    }
    const handedOver = run({ SPRINTENGINE_NODE_EXTRA_CA_CERTS: pem })
    assert.equal(handedOver.defaults.length, 3)
    assert.equal(handedOver.defaults[0], 'root')
    assert.deepEqual(handedOver.env, { NODE_EXTRA_CA_CERTS: pem })
    // Nothing named: nothing changes.
    const none = run({ SPRINTENGINE_NODE_EXTRA_CA_CERTS: '' })
    assert.deepEqual(none.defaults, ['root'])
    assert.deepEqual(none.env, {})
    // A file that is not there is a warning, as it is in Node.
    const missing = run({ SPRINTENGINE_NODE_EXTRA_CA_CERTS: join(dir, 'missing.pem') })
    assert.deepEqual(missing.defaults, ['root'])
    assert.match(missing.warnings[0] ?? '', /Ignoring extra certs/)
    assert.equal(existsSync(join(dir, 'missing.pem')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
