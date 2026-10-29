// The connect script and the session that drives it: a plain `sh -s` with a
// temporary home stands in for `ssh build-box sh -s`, so the real script runs
// in a real shell against the real server tree: probe, install over one
// session, start a managed server, become the relay, attach, upgrade, stop.
// The same against a container's sshd is in ssh-environment.docker.test.ts.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { remoteNodeDigests, WSL_NODE_VERSION } from '../../hosts/wsl-node-runtime'
import { BACKEND_WIRE_VERSION, connectRemoteConversationBackend } from '../../../server/wsl/backend-wire'
import {
  assessProbe,
  buildConnectScript,
  compareVersions,
  locateServer,
  parseProbe,
  spaceFor,
  type Probe,
} from './ssh-connect-script'
import { buildInstallArchive, serverTreeDigest } from './ssh-install'
import { RemoteSession, type SessionProcess } from './ssh-session'

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

let scratch = ''
let tree = ''
let digest = ''
const pids = new Set<number>()

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'se-sshc-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
})
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

/** `ssh build-box sh -s`, as a local shell in a home of its own, with a chatty profile line first. */
function fakeSsh(home: string): () => SessionProcess {
  return () => {
    const child = spawn('sh', ['-c', 'echo "Welcome to build-box"; printf "no newline then "; exec sh -s'], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SHELL: '/bin/sh',
        SSH_CONNECTION: '203.0.113.9 50000 198.51.100.1 22',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return child as unknown as SessionProcess
  }
}

// The pinned Node stands in as a script running this machine's Node.
const fakeNode = Buffer.from(
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
)

const script = (stageId: string, extra: Partial<Parameters<typeof buildConnectScript>[0]> = {}) =>
  buildConnectScript({
    appVersion: VERSION,
    serverDigest: digest,
    stageId,
    installDir: null,
    dataName: 'data',
    channel: 'latest',
    ...extra,
  })

async function probeOf(session: RemoteSession): Promise<Probe> {
  await session.waitFor((line) => line === '@@SPRINTENGINE_PROBE end=1', 30_000, 'the probe')
  const probe = parseProbe(session.lines)
  assert.ok(probe)
  return probe
}

test('a fresh machine: probed, installed in one session, started, reached through the relay, outliving it', async () => {
  const home = join(scratch, 'fresh')
  mkdirSync(home)
  const spawnSsh = fakeSsh(home)

  // First session: the probe says what is missing; the archive goes after SEND.
  const first = RemoteSession.start(spawnSsh, script('i1'))
  assert.throws(() => first.send('install'), /before it says @@SPRINTENGINE_SEND/u)
  const probe = await probeOf(first)
  assert.match(first.noise, /Welcome to build-box/u, "the profile's lines are noise, kept, never parsed")
  assert.equal(probe.home, home)
  assert.ok(probe.writable && probe.exec)
  assert.equal(probe.lock.alive, false)
  const assessed = assessProbe(probe, {
    label: 'build-box',
    nodeDigests: remoteNodeDigests(),
    serverDigest: digest,
    installDir: null,
  })
  assert.ok(assessed.supported)
  assert.deepEqual(assessed.needs, { node: true, server: true })
  const archive = await buildInstallArchive({ node: fakeNode, server: { dir: tree, version: VERSION } })
  assert.equal(spaceFor(probe, archive.unpackedBytes, 'build-box'), null)
  await first.waitForSend(10_000)
  first.send('install', { body: archive.tarGz, end: true })
  await first.waitFor((line) => line === '@@SPRINTENGINE_COMMITTED', 60_000, 'the commit')
  await first.closed()

  // Second session: everything installed; nothing running, so start.
  const second = RemoteSession.start(spawnSsh, script('i2'))
  const after = await probeOf(second)
  const again = assessProbe(after, {
    label: 'build-box',
    nodeDigests: remoteNodeDigests(),
    serverDigest: digest,
    installDir: null,
  })
  assert.ok(again.supported)
  assert.deepEqual(again.needs, { node: false, server: false })
  assert.deepEqual(locateServer(after, { version: VERSION, backendWire: BACKEND_WIRE_VERSION }, 'build-box'), {
    action: 'start',
  })
  await second.waitForSend(10_000)
  second.send(`start keep ${Buffer.from('Studio on dev-macbook-air').toString('base64url')}`)
  const relay = await second.relay(90_000)
  assert.equal(relay.ready.server?.version, VERSION)
  assert.equal(relay.ready.server?.startedBy, 'Studio on dev-macbook-air')
  const serverPid = relay.ready.server!.pid!
  pids.add(serverPid)
  assert.ok(second.lines.some((line) => line.startsWith('@@SPRINTENGINE_READY ')))
  const backend = connectRemoteConversationBackend(await relay.endpoint.open({ kind: 'owner', purpose: 'backend' }))
  await backend.refresh()
  assert.ok(backend.listSessions().ok)
  backend.close()
  second.kill()
  await second.closed()

  // Third session: the server is still there; the client attaches.
  const third = RemoteSession.start(spawnSsh, script('i3'))
  const running = await probeOf(third)
  assert.equal(running.lock.alive, true)
  assert.equal(running.serverRecord?.pid, serverPid)
  assert.deepEqual(locateServer(running, { version: VERSION, backendWire: BACKEND_WIRE_VERSION }, 'build-box'), {
    action: 'attach',
  })
  await third.waitForSend(10_000)
  third.send('attach')
  const attached = await third.relay(30_000)
  assert.equal(attached.ready.server?.pid, serverPid)
  third.kill()

  // An older managed server is upgraded; a newer one is never touched.
  const olderRecord = { ...running, serverRecord: { ...running.serverRecord, version: '0.0.1', origin: 'bootstrap' } }
  assert.deepEqual(locateServer(olderRecord, { version: VERSION, backendWire: BACKEND_WIRE_VERSION }, 'build-box'), {
    action: 'upgrade',
    from: '0.0.1',
  })
  const newer = locateServer(
    { ...running, serverRecord: { ...running.serverRecord, version: '99.0.0' } },
    { version: VERSION, backendWire: BACKEND_WIRE_VERSION },
    'build-box',
  )
  assert.equal(newer.action, 'blocked')
  assert.match(
    newer.action === 'blocked' ? newer.reason : '',
    /runs Studio server 99\.0\.0; this app is .*Update this app/u,
  )
  const external = locateServer(
    { ...running, serverRecord: { ...running.serverRecord, version: '0.0.1', origin: 'cli' } },
    { version: VERSION, backendWire: BACKEND_WIRE_VERSION },
    'build-box',
  )
  assert.deepEqual(external.action === 'blocked' && external.offerUpgrade, true)

  // Upgrade in place: the running one drains and goes, a new one serves.
  const fourth = RemoteSession.start(spawnSsh, script('i4'))
  await probeOf(fourth)
  await fourth.waitForSend(10_000)
  fourth.send('upgrade 300000 ')
  const upgraded = await fourth.relay(120_000)
  const newPid = upgraded.ready.server!.pid!
  pids.add(newPid)
  assert.notEqual(newPid, serverPid)
  fourth.kill()

  // Stop: asked to drain, it goes, and its record with it.
  const fifth = RemoteSession.start(spawnSsh, script('i5'))
  await probeOf(fifth)
  await fifth.waitForSend(10_000)
  fifth.send('stop', { end: true })
  await fifth.waitFor((line) => line === '@@SPRINTENGINE_STOPPED', 90_000, 'the stop')
  assert.ok(!existsSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json')))
})

test('a decision the script does not know, or a start with words in it, changes nothing', async () => {
  const home = join(scratch, 'odd')
  mkdirSync(home)
  for (const decision of ['rm -rf ~', 'start $(id) x', 'start 10 a;b', 'start * x']) {
    const session = RemoteSession.start(fakeSsh(home), script('o1'))
    await session.waitForSend(10_000)
    session.send(decision, { end: true })
    const { code } = await session.closed()
    assert.notEqual(code, 5, decision)
    assert.ok(!session.lines.some((line) => line.startsWith('@@SPRINTENGINE_READY')), decision)
  }
  assert.ok(existsSync(home), 'the home is still there')
})

const probeOfFields = (fields: Record<string, string>, extra: string[] = []) =>
  parseProbe([
    ...Object.entries({
      proto: '1',
      os: 'Linux',
      machine: 'x86_64',
      libc: 'glibc-2.39',
      writable: '1',
      exec: '1',
      base: '/home/dev/.local/share/sprintengine-studio',
      ...fields,
    }).map(([key, value]) => `@@SPRINTENGINE_PROBE ${key}=${value}`),
    ...extra,
    '@@SPRINTENGINE_PROBE end=1',
  ])!

test('machines Studio cannot run on are named, with what was found', () => {
  const assess = (fields: Record<string, string>, installDir: string | null = null) => {
    const result = assessProbe(probeOfFields(fields), {
      label: 'build-box',
      nodeDigests: remoteNodeDigests(),
      serverDigest: 'b'.repeat(64),
      installDir,
    })
    return result.supported ? `ok ${result.target}` : result.reason
  }
  assert.equal(assess({}), 'ok linux-x64')
  assert.equal(assess({ machine: 'aarch64' }), 'ok linux-arm64')
  assert.equal(assess({ os: 'Darwin', machine: 'arm64', libc: 'darwin-15.1' }), 'ok darwin-arm64')
  assert.match(assess({ libc: 'musl' }), /musl \(as Alpine does\)/u)
  assert.match(assess({ libc: 'glibc-2.17' }), /glibc 2\.17, and Studio's runtime needs 2\.28/u)
  assert.match(assess({ os: 'MINGW64_NT-10.0' }), /runs Windows.*use WSL/u)
  assert.match(assess({ machine: 'riscv64' }), /riscv64 machine/u)
  assert.match(assess({ exec: '0' }), /mounted noexec\). Choose an install directory/u)
  assert.match(assess({ exec: '0' }, '/opt/dev'), /from \/opt\/dev on build-box/u)
  assert.match(assess({ writable: '0' }), /is not writable by you/u)
  const kup = assessProbe(probeOfFields({ kill_user_processes: 'yes', user: 'dev' }), {
    label: 'build-box',
    nodeDigests: [],
    serverDigest: '',
    installDir: null,
  })
  assert.ok(kup.notes.some((note) => note.includes('loginctl enable-linger dev')))
  assert.match(
    spaceFor(probeOfFields({ free_kb: '10240' }), 50 * 1024 * 1024, 'build-box') ?? '',
    /Not enough space on build-box: Studio needs 60 MB/u,
  )
  assert.equal(parseProbe(['@@SPRINTENGINE_PROBE os=Linux']), null, 'a probe cut off is not read')
})

test("the probe reads the machine's gh: installed, its version, and whether it holds a token", () => {
  assert.deepEqual(
    probeOfFields({ gh_version: 'gh version 2.62.0 (2024-11-14)', gh_auth: '0' }, ['@@SPRINTENGINE_PROBE has=gh']).gh,
    { installed: true, version: '2.62.0', signedIn: false },
  )
  assert.equal(probeOfFields({ gh_auth: '1' }, ['@@SPRINTENGINE_PROBE has=gh']).gh.signedIn, true)
  assert.deepEqual(probeOfFields({}).gh, { installed: false, version: null, signedIn: null })
  // The script asks without reading the token back, and never signs in.
  const text = script('gh')
  assert.match(text, /auth token <\/dev\/null >\/dev\/null 2>&1/u)
  assert.doesNotMatch(text, /gh auth login/u)
})

test("the probe finds a gh a package manager put off the plain ssh PATH, and gh can't read the script's stdin", async () => {
  // `ssh host sh -s` runs no login profile, so its PATH is the system's (on a
  // Mac: no Homebrew). The server's own gh runs fall back to the login shell
  // and find it there, so the probe must too, or Settings says to install a
  // gh that is installed. `$HOME/.local/bin` stands in for the Homebrew
  // folders a test cannot write to.
  const home = join(scratch, 'gh-off-path')
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  // A gh that would swallow whatever is on its stdin: the script's own stdin
  // carries the decision line, so the probe hands gh nothing.
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\ncase "$1" in --version) echo "gh version 2.62.0 (2024-11-14)" ;; auth) cat >/dev/null; exit 0 ;; esac\n',
  )
  chmodSync(join(bin, 'gh'), 0o755)
  // The system's own tools, less any gh this machine has there (CI runners
  // ship one in /usr/bin), as the plain ssh PATH.
  const system = join(home, 'system-bin')
  mkdirSync(system)
  // A link already made counts even when it dangles: an image whose /usr/bin
  // holds a broken symlink lists the same name again under /bin.
  for (const dir of ['/usr/bin', '/bin']) {
    for (const name of readdirSync(dir)) {
      if (name === 'gh' || lstatSync(join(system, name), { throwIfNoEntry: false })) continue
      symlinkSync(join(dir, name), join(system, name))
    }
  }
  const session = RemoteSession.start(() => {
    const child = spawn('/bin/sh', ['-s'], {
      cwd: home,
      env: { PATH: system, HOME: home, SHELL: '/bin/sh' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return child as unknown as SessionProcess
  }, script('g1'))
  try {
    const probe = await probeOf(session)
    assert.deepEqual(probe.gh, { installed: true, version: '2.62.0', signedIn: true })
  } finally {
    session.kill()
    await session.closed()
  }
})

test('a home shared with another machine is refused, naming it', () => {
  const probe = probeOfFields({ hostname: 'build-box', lock_alive: '1', lock_host: 'build-box-2', lock_pid: '42' }, [
    `@@SPRINTENGINE_PROBE server_json=${JSON.stringify({ version: VERSION, hostId: 'host:build-box-2', origin: 'bootstrap', backendWire: 1 })}`,
  ])
  const located = locateServer(probe, { version: VERSION, backendWire: 1 }, 'build-box')
  assert.equal(located.action, 'blocked')
  assert.match(located.action === 'blocked' ? located.reason : '', /on build-box-2/u)
})

test('two nightlies are ordered by their build, so an older desktop never replaces a newer server', () => {
  const older = '0.5.0-nightly.20260923.9'
  const newer = '0.5.0-nightly.20260923.10'
  assert.ok((compareVersions(older, newer) ?? 0) < 0)
  assert.ok((compareVersions(newer, older) ?? 0) > 0)
  assert.ok((compareVersions('0.5.0-nightly.20260924.1', newer) ?? 0) > 0)
  assert.ok((compareVersions('0.5.0', newer) ?? 0) > 0, 'a release is above its nightlies')
  assert.equal(compareVersions('?', '0.5.0'), null)
  const running = (version: string) =>
    probeOfFields({ hostname: 'build-box', lock_alive: '1', lock_host: 'build-box', lock_pid: '42' }, [
      `@@SPRINTENGINE_PROBE server_json=${JSON.stringify({ version, origin: 'bootstrap', backendWire: BACKEND_WIRE_VERSION })}`,
    ])!
  const app = (version: string) => ({ version, backendWire: BACKEND_WIRE_VERSION })
  const fromOlder = locateServer(running(newer), app(older), 'build-box')
  assert.equal(fromOlder.action, 'blocked')
  assert.match(fromOlder.action === 'blocked' ? fromOlder.reason : '', /Update this app/u)
  assert.deepEqual(locateServer(running(older), app(newer), 'build-box'), { action: 'upgrade', from: older })
  const unknown = locateServer(
    probeOfFields({ hostname: 'build-box', lock_alive: '1', lock_host: 'build-box', lock_pid: '42' }, [
      `@@SPRINTENGINE_PROBE server_json=${JSON.stringify({ origin: 'bootstrap', backendWire: BACKEND_WIRE_VERSION })}`,
    ])!,
    app(newer),
    'build-box',
  )
  assert.equal(unknown.action, 'blocked', 'a server with no version is never replaced')
})

test.skipIf(spawnSync('shellcheck', ['--version']).status !== 0)(
  'the connect script passes shellcheck as POSIX sh',
  () => {
    // SC2016: `$` in single quotes is meant literally (printf formats);
    // SC2086: `set -- $decision` splits on purpose, with globbing off.
    const result = spawnSync('shellcheck', ['-s', 'sh', '-e', 'SC2016,SC2086', '-'], {
      input: script('sc1', { installDir: '/opt/dev/studio' }),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stdout)
  },
)
