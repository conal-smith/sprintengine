// The SSH setups of spec 9.3 beyond the stock one, each against containers'
// sshd: a machine reached only through a jump host (ProxyJump in the
// person's config), and a machine that asks for a key and then a password
// (AuthenticationMethods publickey,password), the two asked through the
// askpass shim in order. Runs with STUDIO_TEST_DOCKER=1.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../../shared/ssh-environments'
import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { createAskpassBroker, type AskpassRequest } from './askpass'
import { DOCKER_TESTS, prepareSshdImage, SSHD_IMAGE_BUILD_MS, startSshd } from './__fixtures__/docker-sshd'
import { parseDestination, resolveDestination, spawnSshSession } from './ssh-command'
import { SshEnvironment } from './ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const CACHE = process.env.STUDIO_TEST_CACHE || join(tmpdir(), 'se-ssh-node-cache')
let scratch = ''
let tree = ''
let digest = ''

beforeAll(async () => {
  if (!DOCKER_TESTS) return
  await prepareSshdImage()
  scratch = mkdtempSync(join(tmpdir(), 'se-ssh-variants-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
}, SSHD_IMAGE_BUILD_MS)
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

function machine(configFile: string, ask: (request: AskpassRequest) => string | null) {
  const asked: AskpassRequest[] = []
  const brokerReady = createAskpassBroker({
    runAsNode: false,
    ask: async (request) => {
      asked.push(request)
      return ask(request)
    },
  })
  const destination = parseDestination('build-box')
  assert.ok(destination.ok)
  return brokerReady.then((broker) => {
    const env = new SshEnvironment({
      id: 'variant',
      label: () => 'build-box',
      settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
      spawn: ({ interactive }) =>
        spawnSshSession({
          ssh: 'ssh',
          destination: destination.destination,
          label: 'build-box',
          interactive,
          askpass: broker,
          configFile,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }) as unknown as SessionProcess,
      app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
      dataName: 'data',
      startedBy: 'Studio on dev-macbook-air',
      serverTree: () => ({ dir: tree, digest }),
      nodeBinary: (target) => ensureNodeBinary(target, { cacheDir: CACHE }),
      onChange: () => undefined,
    })
    return { env, asked, broker }
  })
}

test.skipIf(!DOCKER_TESTS)(
  'a machine reached only through a jump host: resolved, connected and served through it',
  async () => {
    const network = `se-jump-${process.pid}`
    execFileSync('docker', ['network', 'create', network], { stdio: 'ignore' })
    const target = startSshd({ network: { name: network, alias: 'build-box-inner' }, publish: false })
    const bastion = startSshd({ network: { name: network, alias: 'bastion' }, keyPath: target.keyPath })
    try {
      const knownHosts = join(target.dir, 'known_hosts')
      const config = join(target.dir, 'jump_config')
      writeFileSync(
        config,
        [
          'Host bastion',
          '  HostName 127.0.0.1',
          `  Port ${bastion.port}`,
          '  User dev',
          `  IdentityFile ${target.keyPath}`,
          '  IdentitiesOnly yes',
          `  UserKnownHostsFile ${knownHosts}`,
          'Host build-box',
          '  HostName build-box-inner',
          '  User dev',
          '  ProxyJump bastion',
          `  IdentityFile ${target.keyPath}`,
          '  IdentitiesOnly yes',
          `  UserKnownHostsFile ${knownHosts}`,
          '',
        ].join('\n'),
      )
      const destination = parseDestination('build-box')
      assert.ok(destination.ok)
      const resolved = await resolveDestination('ssh', destination.destination, { configFile: config })
      assert.ok(resolved.ok && resolved.resolved.proxyJump === 'bastion', JSON.stringify(resolved))
      const { env, asked, broker } = await machine(config, (request) => (request.kind === 'host-key' ? 'yes' : null))
      const connection = await env.connect({ interactive: true })
      assert.equal(env.summary().state, 'connected', env.summary().stateText)
      assert.deepEqual(
        asked.map((request) => request.kind),
        ['host-key', 'host-key'],
        "the bastion's key and the target's, each checked",
      )
      assert.ok(connection.backend.listSessions().ok)
      // The server runs on the target, not on the bastion.
      assert.match(target.exec('cat /home/dev/.local/share/sprintengine-studio/data/run/server.json'), /"pid":/u)
      assert.equal(
        spawnSync('docker', ['exec', bastion.id, 'test', '-e', '/home/dev/.local/share/sprintengine-studio']).status,
        1,
      )
      env.disconnect()
      broker.close()
    } finally {
      target.stop()
      bastion.stop()
      spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' })
    }
  },
)

test.skipIf(!DOCKER_TESTS)(
  'a key and then a password: both asked through the shim, in order; a wrong password said in words',
  async () => {
    const sshd = startSshd({
      passphrase: 'correct horse',
      sshdOptions: ['PasswordAuthentication yes', 'AuthenticationMethods publickey,password'],
    })
    try {
      let password = 'devpass'
      const { env, asked, broker } = await machine(sshd.configFile, (request) =>
        request.kind === 'host-key'
          ? 'yes'
          : request.kind === 'passphrase'
            ? 'correct horse'
            : request.kind === 'password'
              ? password
              : null,
      )
      await env.connect({ interactive: true })
      assert.equal(env.summary().state, 'connected', env.summary().stateText)
      assert.deepEqual(asked.map((request) => request.kind).slice(0, 3), ['host-key', 'passphrase', 'password'])
      env.disconnect()

      password = 'wrong'
      await assert.rejects(env.connect({ interactive: true }))
      assert.match(env.summary().stateText, /build-box turned the sign-in down/u)
      broker.close()
    } finally {
      sshd.stop()
    }
  },
)
