// The one-session install an SSH machine runs, for real: the generated
// script goes to `sh -s` under each shell a remote may have (dash, bash,
// zsh as sh, and this machine's /bin/sh, which on macOS is the one a macOS
// remote runs), against a temporary home standing in for `/home/dev`. The
// archive follows the decision line only once the script has said
// `@@SPRINTENGINE_SEND`, as the SSH client writes it.
//
// Busybox (an Alpine remote) runs the same cases in a container when
// `STUDIO_TEST_DOCKER=1` and Docker answers; every generated script passes
// `shellcheck -s sh` where shellcheck is installed.

import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
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
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, test } from 'vitest'

import {
  buildStreamInstallScript,
  COMMITTED_MARKER,
  commitFailure,
  compoundScript,
  NODE_RUNTIME_REL,
  posixInstallFunctions,
  remoteBase,
  REMOTE_DATA_REL,
  SEND_MARKER,
  serverTreeName,
} from './remote-install'
import { buildTar } from './wsl-install'
import { WSL_NODE_VERSION } from './wsl-node-runtime'

// zsh only as sh: ssh hands `sh -s` to a person's login shell, which runs
// `sh`, never the script in zsh's own mode.
const SHELLS: Array<[string, string[]]> = (
  [
    ['dash', ['dash']],
    ['bash', ['bash']],
    ['zsh as sh', ['zsh', '--emulate', 'sh']],
    ['sh', ['sh']],
  ] as Array<[string, string[]]>
).filter(([, argv]) => spawnSync(argv[0]!, [...argv.slice(1), '-c', 'true']).status === 0)
const HAS_TAR = spawnSync('tar', ['--version']).status === 0
const HAS_SHELLCHECK = spawnSync('shellcheck', ['--version']).status === 0
const DOCKER = process.env.STUDIO_TEST_DOCKER === '1' && spawnSync('docker', ['info']).status === 0

let temp = ''
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'se-remote-install-'))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const NODE_DIGEST = 'a'.repeat(64)

// A stand-in Node: answers `--version` with the pinned version, runs this
// machine's Node otherwise (so the server's own `--version` check runs).
function fakeNode(nodePath = process.execPath): Buffer {
  return Buffer.from(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${nodePath}' "$@"\n`,
  )
}

function archive(input: {
  node?: boolean
  server?: string | null
  serverSays?: string
  nodeMode?: number
  nodePath?: string
}): Buffer {
  const files: Array<{ path: string; data: Buffer; mode?: number }> = []
  if (input.node)
    files.push({ path: `${NODE_RUNTIME_REL}/bin/node`, data: fakeNode(input.nodePath), mode: input.nodeMode ?? 0o700 })
  if (input.server) {
    const tree = serverTreeName(input.server)
    files.push({
      path: `${tree}/server.cjs`,
      data: Buffer.from(
        `if (process.argv[2] === '--version') console.log(${JSON.stringify(input.serverSays ?? input.server)})\n`,
      ),
    })
    files.push({ path: `${tree}/bridge.mjs`, data: Buffer.from('// relay\n') })
  }
  return gzipSync(buildTar(files))
}

type Session = { code: number | null; stdout: string; stderr: string }

/** One install session: the script, then (after SEND) the decision line and the archive. */
function session(
  spawnShell: () => ChildProcess,
  script: string,
  decision: string,
  body: Buffer | null,
): Promise<Session> {
  return new Promise((resolve) => {
    const child = spawnShell()
    let stdout = ''
    let stderr = ''
    let sent = false
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (!sent && stdout.includes(`${SEND_MARKER}\n`)) {
        sent = true
        child.stdin!.write(`${decision}\n`)
        if (body) child.stdin!.write(body)
        child.stdin!.end()
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.stdin!.on('error', () => undefined)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin!.write(script)
  })
}

function homeFor(name: string): string {
  const home = join(temp, name)
  mkdirSync(home, { recursive: true })
  return home
}

const local = (shell: string | string[], home: string, binFirst?: string) => () => {
  const argv = typeof shell === 'string' ? [shell] : shell
  return spawn(argv[0]!, [...argv.slice(1), '-s'], {
    cwd: home,
    env: { PATH: binFirst ? `${binFirst}:${process.env.PATH}` : process.env.PATH, HOME: home },
    stdio: 'pipe',
  })
}

const script = (stageId: string, appVersion = '0.4.0', serverDigest = 'b'.repeat(64)) =>
  buildStreamInstallScript({ stageId, appVersion, serverDigest, nodeDigest: NODE_DIGEST })

for (const [shell, argv] of SHELLS) {
  test.skipIf(!HAS_TAR)(`${shell}: a fresh install puts the runtime and the server in place, marked`, async () => {
    const home = homeFor(`fresh-${shell}`)
    const result = await session(local(argv, home), script('s1'), 'install', archive({ node: true, server: '0.4.0' }))
    assert.ok(result.stdout.includes(COMMITTED_MARKER), `${result.stdout}${result.stderr}`)
    const base = join(home, REMOTE_DATA_REL)
    assert.equal(readFileSync(join(base, NODE_RUNTIME_REL, '.ready'), 'utf8'), NODE_DIGEST)
    assert.equal(readFileSync(join(base, 'server-0.4.0', '.ready'), 'utf8'), 'b'.repeat(64))
    assert.deepEqual(readdirSync(join(base, '.stage')), [], 'the stage is cleaned up')
    assert.ok(!existsSync(join(base, '.install.lock')), 'the lock is let go')
  })

  test.skipIf(!HAS_TAR)(
    `${shell}: the same tree again changes nothing, and anything but install ends the session`,
    async () => {
      const home = homeFor(`again-${shell}`)
      assert.ok(
        (
          await session(local(argv, home), script('a1'), 'install', archive({ node: true, server: '0.4.0' }))
        ).stdout.includes(COMMITTED_MARKER),
      )
      const again = await session(local(argv, home), script('a2'), 'install', archive({ server: '0.4.0' }))
      assert.ok(again.stdout.includes(COMMITTED_MARKER), again.stdout + again.stderr)
      const declined = await session(local(argv, home), script('a3'), 'quit', null)
      assert.equal(declined.code, 0)
      assert.ok(!declined.stdout.includes(COMMITTED_MARKER))
    },
  )

  test.skipIf(!HAS_TAR)(`${shell}: a server that is not this version is refused, and nothing changes`, async () => {
    const home = homeFor(`skew-${shell}`)
    await session(local(argv, home), script('k1'), 'install', archive({ node: true, server: '0.4.0' }))
    const result = await session(
      local(argv, home),
      script('k2', '0.5.0'),
      'install',
      archive({ server: '0.5.0', serverSays: '0.4.9' }),
    )
    assert.equal(result.code, 4)
    assert.equal(commitFailure(result.stdout, result.stderr), 'server-version 0.4.9')
    assert.ok(!existsSync(join(home, REMOTE_DATA_REL, 'server-0.5.0')))
    assert.ok(existsSync(join(home, REMOTE_DATA_REL, 'server-0.4.0')), 'the installed tree stays')
    assert.ok(!existsSync(join(home, REMOTE_DATA_REL, '.install.lock')))
  })
}

test.skipIf(!HAS_TAR)(
  'a Node that cannot run (a noexec home, a glibc below the floor) fails the install in words',
  async () => {
    const home = homeFor('noexec')
    const result = await session(
      local('sh', home),
      script('n1'),
      'install',
      // Not executable: what a `noexec` mount looks like to the shell.
      archive({ node: true, server: '0.4.0', nodeMode: 0o600 }),
    )
    assert.equal(result.code, 4)
    assert.match(commitFailure(result.stdout, result.stderr), /^node-run /u)
    assert.ok(!existsSync(join(home, REMOTE_DATA_REL, NODE_RUNTIME_REL)))
  },
)

test.skipIf(!HAS_TAR)('a lock whose holder is gone is taken over at once', async () => {
  const home = homeFor('stale')
  const lock = join(home, REMOTE_DATA_REL, '.install.lock')
  mkdirSync(lock, { recursive: true })
  // A pid no process has: the highest pid a system hands out is far below this.
  writeFileSync(join(lock, 'pid'), '99999999\n')
  const started = Date.now()
  const result = await session(local('sh', home), script('l1'), 'install', archive({ node: true, server: '0.4.0' }))
  assert.ok(result.stdout.includes(COMMITTED_MARKER), result.stdout + result.stderr)
  assert.ok(Date.now() - started < 5_000, 'no wait for a dead holder')
})

test.skipIf(!HAS_TAR)('two installs at once: the second waits for the first, and both commit', async () => {
  const home = homeFor('concurrent')
  const lock = join(home, REMOTE_DATA_REL, '.install.lock')
  mkdirSync(lock, { recursive: true })
  // A live holder: this sleeper, until it is killed.
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(join(lock, 'pid'), `${holder.pid}\n`)
  const first = session(local('sh', home), script('c1'), 'install', archive({ node: true, server: '0.4.0' }))
  const second = session(local('dash', home), script('c2'), 'install', archive({ node: true, server: '0.4.0' }))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.ok(existsSync(join(lock, 'pid')), 'still held')
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(holder.pid), 'nobody took a live lock')
  holder.kill('SIGKILL')
  const results = await Promise.all([first, second])
  for (const result of results) assert.ok(result.stdout.includes(COMMITTED_MARKER), result.stdout + result.stderr)
})

// Stand-ins for `mkdir`, `find` and `mv` that run the real one and pause where
// a loaded machine can preempt a shell: what each pauses on is in `pauses`.
function slowTools(name: string, pauses: { afterLockMade?: number; beforeJudging?: number; afterLockMoved?: number }) {
  const bin = join(temp, `slow-${name}`)
  mkdirSync(bin, { recursive: true })
  const real = (tool: string) => spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
  const tool = (tool: string, body: string) => writeFileSync(join(bin, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  if (pauses.afterLockMade)
    tool(
      'mkdir',
      `'${real('mkdir')}' "$@" || exit\ncase "$1" in */.install.lock) sleep ${pauses.afterLockMade} ;; esac`,
    )
  if (pauses.beforeJudging)
    tool(
      'find',
      `case " $* " in *'/.install.lock -prune -mmin +30 '*) sleep ${pauses.beforeJudging} ;; esac\nexec '${real('find')}' "$@"`,
    )
  if (pauses.afterLockMoved)
    tool('mv', `'${real('mv')}' "$@" || exit\ncase "$1" in */.install.lock) sleep ${pauses.afterLockMoved} ;; esac`)
  return bin
}

test.skipIf(!HAS_TAR)(
  'two installs that both find the holder gone: the slower never takes the lock the faster has just made',
  async () => {
    const home = homeFor('stale-race')
    const lock = join(home, REMOTE_DATA_REL, '.install.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'pid'), '99999999\n')
    // Both read the dead holder's pid at once. The first acts on it sooner, makes
    // its own lock, and is slow to write its pid in it; the second acts later,
    // while the first's lock is still being made, and is slow after moving it.
    const first = session(
      local('sh', home, slowTools('first', { beforeJudging: 0.1, afterLockMade: 0.3 })),
      script('r1'),
      'install',
      archive({ node: true, server: '0.4.0' }),
    )
    const second = session(
      local('sh', home, slowTools('second', { beforeJudging: 0.25, afterLockMoved: 0.3 })),
      script('r2'),
      'install',
      archive({ node: true, server: '0.4.0' }),
    )
    const results = await Promise.all([first, second])
    for (const result of results) assert.ok(result.stdout.includes(COMMITTED_MARKER), result.stdout + result.stderr)
    assert.ok(!existsSync(lock), 'the lock is let go')
  },
  30_000,
)

test.skipIf(!HAS_TAR)(
  'an older server tree a process still runs from is kept; one nothing runs from is pruned',
  async () => {
    const home = homeFor('prune')
    const base = join(home, REMOTE_DATA_REL)
    await session(local('sh', home), script('p1', '0.3.0'), 'install', archive({ node: true, server: '0.3.0' }))
    await session(local('sh', home), script('p2', '0.3.5'), 'install', archive({ server: '0.3.5' }))
    assert.ok(!existsSync(join(base, 'server-0.3.0')), 'unused, so pruned by the next install')
    // A process that names the 0.3.5 tree in its command line, as a running
    // server does: found through /proc on Linux, through `ps` on macOS.
    const runner = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)', join(base, 'server-0.3.5', 'server.cjs')],
      {
        stdio: 'ignore',
      },
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const result = await session(local('sh', home), script('p3', '0.4.0'), 'install', archive({ server: '0.4.0' }))
      assert.ok(result.stdout.includes(COMMITTED_MARKER), result.stdout + result.stderr)
      assert.ok(existsSync(join(base, 'server-0.3.5')), 'a tree in use is left alone')
      assert.ok(existsSync(join(base, 'server-0.4.0')))
    } finally {
      runner.kill('SIGKILL')
    }
    const after = await session(local('sh', home), script('p4', '0.4.0'), 'install', archive({ server: '0.4.0' }))
    assert.ok(after.stdout.includes(COMMITTED_MARKER))
    assert.ok(!existsSync(join(base, 'server-0.3.5')), 'pruned once nothing runs from it')
  },
)

test.skipIf(!HAS_TAR)(
  'an install directory anyone may write in, or a link to one, is refused; a link to your own is followed',
  async () => {
    const shared = join(temp, 'shared-install')
    mkdirSync(shared, { recursive: true })
    chmodSync(shared, 0o777)
    const linked = homeFor('linked-world')
    mkdirSync(join(linked, '.local', 'share'), { recursive: true })
    symlinkSync(shared, join(linked, REMOTE_DATA_REL))
    const result = await session(local('sh', linked), script('w1'), 'install', archive({ node: true, server: '0.4.0' }))
    assert.equal(result.code, 4)
    assert.match(commitFailure(result.stdout, result.stderr), /^base-owner /u)
    assert.ok(!existsSync(join(shared, 'server-0.4.0')), 'nothing was installed there')
    const open = homeFor('open-base')
    mkdirSync(join(open, REMOTE_DATA_REL), { recursive: true })
    chmodSync(join(open, REMOTE_DATA_REL), 0o777)
    const refused = await session(local('sh', open), script('w2'), 'install', archive({ node: true, server: '0.4.0' }))
    assert.match(commitFailure(refused.stdout, refused.stderr), /^base-owner /u)

    const mine = join(temp, 'own-install')
    mkdirSync(mine, { recursive: true, mode: 0o700 })
    const followed = homeFor('linked-own')
    mkdirSync(join(followed, '.local', 'share'), { recursive: true })
    symlinkSync(mine, join(followed, REMOTE_DATA_REL))
    const installed = await session(
      local('sh', followed),
      script('w3'),
      'install',
      archive({ node: true, server: '0.4.0' }),
    )
    assert.ok(installed.stdout.includes(COMMITTED_MARKER), installed.stdout + installed.stderr)
    assert.ok(existsSync(join(mine, 'server-0.4.0', '.ready')))
  },
)

test("an install never prunes a person's data directory", async () => {
  const home = homeFor('data')
  const base = join(home, REMOTE_DATA_REL)
  mkdirSync(join(base, 'data', 'run'), { recursive: true })
  mkdirSync(join(base, 'data-nightly'), { recursive: true })
  if (!HAS_TAR) return
  await session(local('sh', home), script('d1'), 'install', archive({ node: true, server: '0.4.0' }))
  assert.ok(existsSync(join(base, 'data', 'run')))
  assert.ok(existsSync(join(base, 'data-nightly')))
})

test('the install directory for a noexec home is a plain absolute path, or refused', () => {
  assert.equal(remoteBase(null), `"$HOME/${REMOTE_DATA_REL}"`)
  assert.equal(remoteBase('/opt/dev/studio/'), "'/opt/dev/studio'")
  for (const bad of ['relative/dir', '/has space', "/q'uote", '/a/$HOME', '/a/../etc', '/a;rm'])
    assert.throws(() => remoteBase(bad), /plain characters/u, bad)
})

test('the script is one compound command that ends the shell', () => {
  const text = script('x1')
  assert.ok(text.startsWith('{\n'))
  assert.ok(text.endsWith('exit 0\n}\n'))
  assert.equal(compoundScript(['true']), '{\ntrue\nexit 0\n}\n')
  // The archive is read after the marker, and the marker is said before anything is read.
  assert.ok(text.indexOf(SEND_MARKER) < text.indexOf('read -r decision'))
  assert.ok(text.indexOf('read -r decision') < text.indexOf('tar -xzf -'))
})

test.skipIf(!HAS_SHELLCHECK)('every generated script passes shellcheck as POSIX sh', () => {
  const scripts = {
    install: script('sc1'),
    functions: [
      '#!/bin/sh',
      'base="$HOME/x"',
      'id=x',
      ...posixInstallFunctions(),
      'live "$base"',
      'lock_take',
      'lock_drop',
      'place a b',
    ].join('\n'),
  }
  for (const [name, text] of Object.entries(scripts)) {
    const result = spawnSync('shellcheck', ['-s', 'sh', '-e', 'SC2016', '-'], { input: text, encoding: 'utf8' })
    assert.equal(result.status, 0, `${name}:\n${result.stdout}`)
  }
})

// Busybox (Alpine): the same session in a container, its home inside it.
test.skipIf(!DOCKER)('busybox sh: install, a skewed server refused, and a live lock waited on', async () => {
  const name = `se-remote-install-${process.pid}`
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, 'node:22-alpine', 'sleep', '300'], {
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  try {
    const exec = () =>
      spawn(
        'docker',
        ['exec', '-i', '-e', 'HOME=/tmp/h', '-w', '/tmp', name, 'sh', '-c', 'mkdir -p /tmp/h && exec sh -s'],
        {
          stdio: 'pipe',
        },
      )
    const fresh = await session(
      exec,
      script('b1'),
      'install',
      archive({ node: true, server: '0.4.0', nodePath: '/usr/local/bin/node' }),
    )
    assert.ok(fresh.stdout.includes(COMMITTED_MARKER), fresh.stdout + fresh.stderr)
    const skew = await session(
      exec,
      script('b2', '0.5.0'),
      'install',
      archive({ server: '0.5.0', serverSays: '0.1.0' }),
    )
    assert.equal(commitFailure(skew.stdout, skew.stderr), 'server-version 0.1.0')
    const listing = spawnSync('docker', ['exec', name, 'ls', `/tmp/h/${REMOTE_DATA_REL}`], { encoding: 'utf8' })
    assert.deepEqual(listing.stdout.trim().split('\n').sort(), ['runtime', 'server-0.4.0'])
  } finally {
    spawnSync('docker', ['rm', '-f', name])
  }
})
