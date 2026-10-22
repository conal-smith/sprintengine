import assert from 'node:assert/strict'

import { createDefaultGhRunner, sharedGhRunner, type GhSpawn } from './gh'
import { test } from 'vitest'

test('gh', async () => {
  // Nothing here spawns a real `gh`: every case injects the spawn seam, so the
  // tests describe the runner's decisions rather than the machine they run on.

  type Call = {
    file: string
    args: string[]
    cwd?: string
    timeout?: number
    killSignal?: NodeJS.Signals
  }

  function spawnStub(respond: (call: Call) => Promise<{ stdout: string; stderr: string }>): {
    spawn: GhSpawn
    calls: Call[]
  } {
    const calls: Call[] = []
    const spawn: GhSpawn = (file, args, options) => {
      const call: Call = {
        file,
        args,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal }),
      }
      calls.push(call)
      return respond(call)
    }
    return { spawn, calls }
  }

  function enoent(): Promise<never> {
    return Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
  }

  /** A Homebrew gh: found when the login PATH has its directory. */
  async function homebrewGh(binary: string, directories: string[]): Promise<string | null> {
    return binary === 'gh' && directories.includes('/opt/homebrew/bin') ? '/opt/homebrew/bin/gh' : null
  }

  // Wrapped in a main() because this suite bundles to CommonJS, where a
  // top-level await is not available.
  async function main(): Promise<void> {
    // ---------------------------------------------------------------------------
    // Off the app's PATH: a GUI-launched app inherits no shell PATH, so a bare
    // spawn of a Homebrew `gh` fails with ENOENT. The person's shell is asked
    // for its PATH, gh is found on it, and spawned by its absolute path.
    // ---------------------------------------------------------------------------
    {
      const { spawn, calls } = spawnStub((call) =>
        call.file === 'gh'
          ? enoent()
          : call.file === '/bin/zsh'
            ? Promise.resolve({
                stdout: 'Now using node v22\nSPRINTENGINE_LOGIN_PATH:/opt/homebrew/bin:/usr/bin\n',
                stderr: '',
              })
            : Promise.resolve({ stdout: 'gh version 2.55.0', stderr: '' }),
      )
      const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin', findExecutable: homebrewGh })
      const result = await gh.run(['pr', 'list', '--head', "it's-a-branch"], { cwd: '/repo' })

      assert.equal(result.found, true, 'gh found on the login PATH is found')
      assert.equal(result.code, 0)
      assert.equal(result.stdout, 'gh version 2.55.0')
      assert.deepEqual(
        calls.map((call) => call.file),
        ['gh', '/bin/zsh', '/opt/homebrew/bin/gh'],
        'direct first, then the shell for its PATH, then gh itself',
      )
      assert.deepEqual(calls[2].args, ['pr', 'list', '--head', "it's-a-branch"], 'arguments go to gh as they are')
      assert.equal(calls[2].cwd, '/repo')
    }

    // ---------------------------------------------------------------------------
    // `found: false` is reserved for a missing binary. Everything else is gh having
    // run and having an opinion — the distinction every caller that writes an answer
    // down depends on.
    // ---------------------------------------------------------------------------
    {
      const { spawn, calls } = spawnStub(() => enoent())
      const gh = createDefaultGhRunner({
        spawn,
        shell: '/bin/zsh',
        platform: 'darwin',
        findExecutable: async () => null,
      })
      const missing = await gh.run(['pr', 'list'])
      assert.equal(missing.found, false, 'ENOENT, and no gh on the login PATH, means the binary is absent')
      assert.ok(calls.length > 1, 'the login PATH was asked before giving up')
      assert.equal(await gh.available(), false)
    }
    {
      const { spawn } = spawnStub(() =>
        Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'no pull requests found' })),
      )
      const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
      const failed = await gh.run(['pr', 'list'])
      assert.equal(failed.found, true, 'gh ran; it just did not like the question')
      assert.equal(failed.code, 1)
      assert.equal(failed.stderr, 'no pull requests found')
      assert.equal(await gh.available(), false, 'a gh that is there but exits non-zero on --version is not usable')
    }

    // ---------------------------------------------------------------------------
    // ONE runner (epic decision 11): every caller — the version-control probe and
    // the review paths — reaches this module's factory and its shell retry.
    // ---------------------------------------------------------------------------
    {
      assert.equal(sharedGhRunner(), sharedGhRunner(), 'one process-wide instance')
    }
    // ---------------------------------------------------------------------------
    // REVIEW FIX (finding 6). A read's bound has to KILL the child, not merely
    // stop waiting on it: a caller that races a timer leaves a `gh` — and on the
    // login-shell fallback a whole `$SHELL -ilc` — running behind every abandoned
    // probe, which on a hover-driven surface is one leaked process per probe.
    // ---------------------------------------------------------------------------
    {
      const { spawn, calls } = spawnStub(() => Promise.resolve({ stdout: '[]', stderr: '' }))
      const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
      await gh.run(['pr', 'list'], { cwd: '/repo', timeoutMs: 15_000 })
      assert.equal(calls[0].timeout, 15_000, 'the bound is the process table`s to enforce')
      assert.equal(calls[0].killSignal, 'SIGTERM')

      // No bound asked for, no kill terms invented.
      await gh.run(['pr', 'list'], { cwd: '/repo' })
      assert.equal(calls[1].timeout, undefined)
      assert.equal(calls[1].killSignal, undefined)

      // A gh found on the login PATH carries it too.
      const offPath = spawnStub((call) =>
        call.file === 'gh'
          ? enoent()
          : Promise.resolve({ stdout: 'SPRINTENGINE_LOGIN_PATH:/opt/homebrew/bin\n', stderr: '' }),
      )
      const located = createDefaultGhRunner({
        spawn: offPath.spawn,
        shell: '/bin/zsh',
        platform: 'darwin',
        findExecutable: homebrewGh,
      })
      await located.run(['pr', 'list'], { timeoutMs: 5_000 })
      const ghCall = offPath.calls.find((call) => call.file === '/opt/homebrew/bin/gh')
      assert.equal(ghCall?.timeout, 5_000, 'the located gh is killed on the same bound')
    }
    {
      // `execFile` reports its own timeout as a killed child: a signal, no exit
      // code. The binary was found and ran, so this is never `found: false` — it
      // is a read that did not happen, and the caller must not write anything down.
      const { spawn } = spawnStub(() =>
        Promise.reject(
          Object.assign(new Error('Command failed: gh pr list'), {
            killed: true,
            signal: 'SIGTERM',
            code: null,
            stdout: '',
            stderr: '',
          }),
        ),
      )
      const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin' })
      const killed = await gh.run(['pr', 'list'], { timeoutMs: 1 })
      assert.equal(killed.found, true, 'the binary was there; it just did not finish')
      assert.equal(killed.timedOut, true, 'and the caller can tell that from an ordinary failure')
    }
  }

  const suiteRun = main().then(
    () => console.log('github/gh: all assertions passed'),
    (error) => {
      console.error(error)
      process.exitCode = 1
    },
  )

  await suiteRun
})

test('on Windows, gh is spawned by its full PATH location and never looked up in the repository', async () => {
  const files: string[] = []
  const spawn: GhSpawn = async (file) => {
    files.push(file)
    return { stdout: '', stderr: '' }
  }
  const installed = 'C:\\Program Files\\GitHub CLI\\gh.exe'
  const gh = createDefaultGhRunner({ spawn, platform: 'win32', resolveWindowsProgram: async () => installed })
  const result = await gh.run(['pr', 'list'], { cwd: 'C:\\Users\\dev\\repo' })
  assert.equal(result.found, true)
  assert.deepEqual(files, [installed])
})

test('on Windows, no gh on PATH is "not installed", without a bare-name spawn that would search the repository', async () => {
  const files: string[] = []
  const spawn: GhSpawn = async (file) => {
    files.push(file)
    return { stdout: '', stderr: '' }
  }
  const gh = createDefaultGhRunner({ spawn, platform: 'win32', resolveWindowsProgram: async () => null })
  const result = await gh.run(['pr', 'list'], { cwd: 'C:\\Users\\dev\\repo' })
  assert.equal(result.found, false)
  assert.deepEqual(files, [])
})

test('on Windows, gh is looked up on PATH once, not before every call', async () => {
  const files: string[] = []
  const spawn: GhSpawn = async (file) => {
    files.push(file)
    return { stdout: '', stderr: '' }
  }
  const installed = 'C:\\Program Files\\GitHub CLI\\gh.exe'
  let lookups = 0
  const gh = createDefaultGhRunner({
    spawn,
    platform: 'win32',
    resolveWindowsProgram: async () => {
      lookups += 1
      return installed
    },
  })
  await gh.run(['pr', 'list'])
  await gh.run(['pr', 'view'])
  assert.equal(lookups, 1)
  assert.deepEqual(files, [installed, installed])
  gh.forgetLocation()
  await gh.run(['pr', 'list'])
  assert.equal(lookups, 2, 'a forced re-check looks again')
})

test('on Windows, a gh not found is looked for again on the next call', async () => {
  let installed: string | null = null
  let lookups = 0
  const gh = createDefaultGhRunner({
    spawn: async () => ({ stdout: '', stderr: '' }),
    platform: 'win32',
    resolveWindowsProgram: async () => {
      lookups += 1
      return installed
    },
  })
  assert.equal((await gh.run(['--version'])).found, false)
  installed = 'C:\\Program Files\\GitHub CLI\\gh.exe'
  assert.equal((await gh.run(['--version'])).found, true)
  assert.equal(lookups, 2)
})

test('on Windows, a remembered gh that is gone is looked up again and the call runs once more', async () => {
  const moved = 'C:\\Users\\dev\\scoop\\shims\\gh.exe'
  let location = 'C:\\Program Files\\GitHub CLI\\gh.exe'
  const files: string[] = []
  const gh = createDefaultGhRunner({
    spawn: async (file) => {
      files.push(file)
      if (file !== location) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      return { stdout: 'ok', stderr: '' }
    },
    platform: 'win32',
    resolveWindowsProgram: async () => location,
  })
  await gh.run(['pr', 'list'])
  location = moved
  const result = await gh.run(['pr', 'list'])
  assert.equal(result.found, true)
  assert.equal(result.stdout, 'ok')
  assert.equal(files.at(-1), moved)
})

test('on Windows, a PATH that changed is searched again', async () => {
  const saved = process.env.PATH
  let lookups = 0
  const gh = createDefaultGhRunner({
    spawn: async () => ({ stdout: '', stderr: '' }),
    platform: 'win32',
    resolveWindowsProgram: async () => {
      lookups += 1
      return 'C:\\Program Files\\GitHub CLI\\gh.exe'
    },
  })
  try {
    process.env.PATH = 'C:\\Windows\\system32'
    await gh.run(['--version'])
    process.env.PATH = 'C:\\Program Files\\GitHub CLI;C:\\Windows\\system32'
    await gh.run(['--version'])
    assert.equal(lookups, 2)
  } finally {
    process.env.PATH = saved
  }
})

test("the git that gh runs inside a repository ignores the repository's filesystem-monitor program and stray bare repositories", async () => {
  const envs: NodeJS.ProcessEnv[] = []
  const spawn: GhSpawn = async (_file, _args, options) => {
    envs.push(options.env)
    return { stdout: '', stderr: '' }
  }
  const gh = createDefaultGhRunner({ spawn, platform: 'darwin' })
  await gh.run(['pr', 'list'], { cwd: '/Users/dev/repo' })
  const env = envs[0]
  const count = Number(env.GIT_CONFIG_COUNT)
  const pairs = Array.from({ length: count }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`],
    env[`GIT_CONFIG_VALUE_${index}`],
  ])
  assert.deepEqual(pairs.slice(-2), [
    ['core.fsmonitor', 'false'],
    ['safe.bareRepository', 'explicit'],
  ])
})

test('gh off the app PATH is looked up once: many calls start at most one shell, then gh directly', async () => {
  const files: string[] = []
  const spawn: GhSpawn = async (file) => {
    files.push(file)
    if (file === 'gh') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    if (file === '/bin/zsh') return { stdout: 'SPRINTENGINE_LOGIN_PATH:/opt/homebrew/bin:/usr/bin\n', stderr: '' }
    return { stdout: '[]', stderr: '' }
  }
  const findExecutable = async (_binary: string, directories: string[]) =>
    directories.includes('/opt/homebrew/bin') ? '/opt/homebrew/bin/gh' : null
  const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin', findExecutable })
  // Concurrent first calls share the one lookup, and later ones reuse it.
  await Promise.all([gh.run(['pr', 'list']), gh.run(['pr', 'list']), gh.run(['pr', 'list'])])
  for (let call = 0; call < 5; call += 1) await gh.run(['pr', 'list'])
  assert.equal(files.filter((file) => file === '/bin/zsh').length, 1)
  assert.equal(files.filter((file) => file === '/opt/homebrew/bin/gh').length, 8)

  // A forced re-check asks the shell again.
  gh.forgetLocation()
  await gh.run(['pr', 'list'])
  assert.equal(files.filter((file) => file === '/bin/zsh').length, 2)
})

test('no gh on the login PATH either means gh is not installed, and starts no further shells', async () => {
  const files: string[] = []
  const spawn: GhSpawn = async (file) => {
    files.push(file)
    if (file === 'gh') throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    return { stdout: 'SPRINTENGINE_LOGIN_PATH:/usr/bin\n', stderr: '' }
  }
  const gh = createDefaultGhRunner({ spawn, shell: '/bin/zsh', platform: 'darwin', findExecutable: async () => null })
  const result = await gh.run(['pr', 'list'])
  assert.equal(result.found, false)
  assert.equal(await gh.available(), false)
  assert.equal(files.filter((file) => file === '/bin/zsh').length, 1, 'the PATH is kept; only gh is looked for again')
})
