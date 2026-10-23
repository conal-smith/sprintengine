import assert from 'node:assert/strict'
import { beforeEach, test } from 'vitest'

import { forgetGitExecutable, resolveGitForMacos, resolveGitForWindows, withGitExecutable } from './git-executable'

const files =
  (...paths: string[]) =>
  async (path: string): Promise<boolean> =>
    paths.includes(path)

beforeEach(() => {
  forgetGitExecutable()
})

test("the installer's cmd launcher is swapped for the ucrt64 git it would start", async () => {
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd' },
    {
      isFile: files(
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe',
        'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
      ),
    },
  )
  assert.equal(file, 'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe')
})

test("the portable build's bin launcher is swapped for its mingw64 git", async () => {
  const file = await resolveGitForWindows(
    { PATH: 'D:\\PortableGit\\bin' },
    { isFile: files('D:\\PortableGit\\bin\\git.exe', 'D:\\PortableGit\\mingw64\\bin\\git.exe') },
  )
  assert.equal(file, 'D:\\PortableGit\\mingw64\\bin\\git.exe')
})

test('an ARM64 install runs its clangarm64 git', async () => {
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Program Files\\Git\\cmd' },
    { isFile: files('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\clangarm64\\bin\\git.exe') },
  )
  assert.equal(file, 'C:\\Program Files\\Git\\clangarm64\\bin\\git.exe')
})

test('PATH spelled the way Windows spells it is read', async () => {
  const file = await resolveGitForWindows(
    { Path: 'C:\\Program Files\\Git\\cmd' },
    { isFile: files('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe') },
  )
  assert.equal(file, 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe')
})

test('the launcher stays when MSYSTEM is set, since the real git would not add its folders to PATH', async () => {
  let asked = 0
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Program Files\\Git\\cmd', MSYSTEM: 'MINGW64' },
    {
      isFile: async () => {
        asked += 1
        return true
      },
    },
  )
  assert.equal(file, 'git')
  assert.equal(asked, 0)
})

test('the launcher stays when no real git sits beside it', async () => {
  const file = await resolveGitForWindows(
    { PATH: 'C:\\Program Files\\Git\\cmd' },
    { isFile: files('C:\\Program Files\\Git\\cmd\\git.exe') },
  )
  assert.equal(file, 'git')
})

test('a git that is not a Git for Windows launcher is left to the OS to find', async () => {
  const everything = async () => true
  assert.equal(await resolveGitForWindows({ PATH: 'C:\\Users\\dev\\scoop\\shims' }, { isFile: everything }), 'git')
  assert.equal(await resolveGitForWindows({ PATH: '' }, { isFile: everything }), 'git')
})

test('off Windows and macOS git is started at once, with no lookup', async () => {
  let started: string | null = null
  const run = withGitExecutable(
    { PATH: '/usr/bin' },
    async (file) => {
      started = file
      return file
    },
    {
      platform: 'linux',
      isFile: async () => {
        throw new Error('no lookup on Linux')
      },
      findXcodeGit: async () => {
        throw new Error('no xcrun on Linux')
      },
      xcodeSelection: () => {
        throw new Error('no xcode-select on Linux')
      },
    },
  )
  assert.equal(started, 'git', 'started synchronously')
  assert.equal(await run, 'git')
})

// ── macOS: the git behind the xcrun shim ─────────────────────────────────

const XCODE_GIT = '/Applications/Xcode.app/Contents/Developer/usr/bin/git'
const XCODE_BETA_GIT = '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git'
const MAC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Lets a lookup started in the background finish. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A Mac with `installed` on disk, where xcrun names `xcrunGit` and xcode-select points at Xcode. */
function mac(installed: string[], xcrunGit: string | null = XCODE_GIT) {
  const host = { installed: new Set(installed), xcrunGit, selection: '/Applications/Xcode.app/Contents/Developer' }
  const asked: NodeJS.ProcessEnv[] = []
  const deps = {
    platform: 'darwin' as const,
    isFile: async (path: string) => host.installed.has(path),
    findXcodeGit: async (env: NodeJS.ProcessEnv) => {
      asked.push(env)
      return host.xcrunGit
    },
    xcodeSelection: () => host.selection,
  }
  return { host, asked, deps }
}

test('on macOS the git behind the /usr/bin/git shim is the one to start', async () => {
  const { asked, deps } = mac(['/usr/bin/git', XCODE_GIT])
  const env = { PATH: MAC_PATH, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
  assert.equal(await resolveGitForMacos(env, deps), XCODE_GIT)
  assert.equal(asked[0]?.DEVELOPER_DIR, env.DEVELOPER_DIR, 'xcrun is asked with the child environment')
})

test('on macOS a git of its own first on PATH is left to the OS to find, and xcrun is never asked', async () => {
  const { asked, deps } = mac(['/opt/homebrew/bin/git', '/usr/bin/git', XCODE_GIT])
  assert.equal(await resolveGitForMacos({ PATH: `/opt/homebrew/bin:${MAC_PATH}` }, deps), 'git')
  assert.equal(asked.length, 0)
})

test('on macOS a PATH whose git cannot be told without the working directory keeps the shim', async () => {
  const { asked, deps } = mac(['/usr/bin/git', XCODE_GIT])
  assert.equal(await resolveGitForMacos({ PATH: `node_modules/.bin:${MAC_PATH}` }, deps), 'git')
  assert.equal(await resolveGitForMacos({ PATH: `:${MAC_PATH}` }, deps), 'git')
  assert.equal(await resolveGitForMacos({ PATH: '' }, deps), 'git')
  assert.equal(asked.length, 0)
})

test('on macOS the shim stays when xcrun fails or names a git that is not there', async () => {
  const failed = mac(['/usr/bin/git', XCODE_GIT], null)
  assert.equal(await resolveGitForMacos({ PATH: MAC_PATH }, failed.deps), 'git')

  const missing = mac(['/usr/bin/git'])
  assert.equal(await resolveGitForMacos({ PATH: MAC_PATH }, missing.deps), 'git')

  // Output that is not an absolute path is never started, whatever answers to that name.
  const odd = mac(
    ['/usr/bin/git', 'xcrun: error: unable to find utility "git"'],
    'xcrun: error: unable to find utility "git"',
  )
  assert.equal(await resolveGitForMacos({ PATH: MAC_PATH }, odd.deps), 'git')

  const thrown = mac(['/usr/bin/git', XCODE_GIT])
  thrown.deps.findXcodeGit = async () => {
    throw new Error('spawn /usr/bin/xcrun EACCES')
  }
  let started: string | null = null
  await withGitExecutable({ PATH: MAC_PATH }, async (file) => (started = file), thrown.deps)
  await settled()
  await withGitExecutable({ PATH: MAC_PATH }, async (file) => (started = file), thrown.deps)
  assert.equal(started, 'git')
})

test('on macOS a spawn never waits for xcrun: the shim runs until the lookup is in, then the real git, at once', async () => {
  const { asked, deps } = mac(['/usr/bin/git', XCODE_GIT])
  const env = { PATH: MAC_PATH }
  const started: string[] = []
  const start = async (file: string) => {
    started.push(file)
    return file
  }

  const first = withGitExecutable(env, start, deps)
  assert.deepEqual(started, ['git'], 'started synchronously, before the lookup')
  await first
  await settled()

  const second = withGitExecutable(env, start, deps)
  assert.deepEqual(started, ['git', XCODE_GIT], 'started synchronously with the remembered git')
  await second
  await withGitExecutable(env, start, deps)
  assert.deepEqual(started, ['git', XCODE_GIT, XCODE_GIT])
  assert.equal(asked.length, 1, 'xcrun is asked once per PATH')
})

test('on macOS a new xcode-select choice or DEVELOPER_DIR is looked up again, as the shim would follow it', async () => {
  const { host, asked, deps } = mac(['/usr/bin/git', XCODE_GIT, XCODE_BETA_GIT])
  const env = { PATH: MAC_PATH }
  const start = async (file: string) => file
  await withGitExecutable(env, start, deps)
  await settled()
  assert.equal(await withGitExecutable(env, start, deps), XCODE_GIT)

  host.selection = '/Applications/Xcode-beta.app/Contents/Developer'
  host.xcrunGit = XCODE_BETA_GIT
  assert.equal(await withGitExecutable(env, start, deps), 'git', 'the shim, while xcrun is asked again')
  await settled()
  assert.equal(await withGitExecutable(env, start, deps), XCODE_BETA_GIT)
  assert.equal(asked.length, 2)

  const pinned = { ...env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
  host.xcrunGit = XCODE_GIT
  assert.equal(await withGitExecutable(pinned, start, deps), 'git')
  await settled()
  assert.equal(await withGitExecutable(pinned, start, deps), XCODE_GIT)
  assert.equal(await withGitExecutable(env, start, deps), XCODE_BETA_GIT, 'each DEVELOPER_DIR keeps its own answer')
  assert.equal(asked.length, 3)
})

test('on macOS a remembered git that has gone missing is started once more as the shim, then looked up again', async () => {
  // An Xcode update or removal deletes the binary the lookup named.
  const { host, asked, deps } = mac(['/usr/bin/git', XCODE_GIT])
  const env = { PATH: MAC_PATH }
  await withGitExecutable(env, async (file) => file, deps)
  await settled()
  host.installed.delete(XCODE_GIT)
  host.xcrunGit = null

  const started: string[] = []
  const result = await withGitExecutable(
    env,
    async (file) => {
      started.push(file)
      if (file === XCODE_GIT) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      return 'ok'
    },
    deps,
  )
  assert.equal(result, 'ok')
  assert.deepEqual(started, [XCODE_GIT, 'git'])

  assert.equal(await withGitExecutable(env, async (file) => file, deps), 'git')
  await settled()
  assert.equal(await withGitExecutable(env, async (file) => file, deps), 'git')
  assert.equal(asked.length, 2, 'looked up again after the failed start, and that answer kept')
})

test('on macOS a git that started and failed is not run a second time', async () => {
  const { deps } = mac(['/usr/bin/git', XCODE_GIT])
  await withGitExecutable({ PATH: MAC_PATH }, async (file) => file, deps)
  await settled()
  const started: string[] = []
  await assert.rejects(
    withGitExecutable(
      { PATH: MAC_PATH },
      async (file) => {
        started.push(file)
        throw Object.assign(new Error('git exited with code 128'), { code: 128 })
      },
      deps,
    ),
    /code 128/,
  )
  assert.deepEqual(started, [XCODE_GIT])
})

test('the lookup is made once per PATH, not once per command', async () => {
  let asked = 0
  const isFile = async (path: string) => {
    asked += 1
    return path === 'C:\\Git\\cmd\\git.exe' || path === 'C:\\Git\\mingw64\\bin\\git.exe'
  }
  const env = { PATH: 'C:\\Git\\cmd' }
  const first = await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  const askedOnce = asked
  const second = await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  assert.equal(first, 'C:\\Git\\mingw64\\bin\\git.exe')
  assert.equal(second, first)
  assert.equal(asked, askedOnce)
})

test('a remembered git that has gone missing is looked up again and started once more', async () => {
  // An upgrade to 2.56 moves the real binary from mingw64 to ucrt64.
  let installed = 'C:\\Git\\mingw64\\bin\\git.exe'
  const isFile = async (path: string) => path === 'C:\\Git\\cmd\\git.exe' || path === installed
  const env = { PATH: 'C:\\Git\\cmd' }
  await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  installed = 'C:\\Git\\ucrt64\\bin\\git.exe'

  const started: string[] = []
  const result = await withGitExecutable(
    env,
    async (file) => {
      started.push(file)
      if (file !== installed) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      return 'ok'
    },
    { platform: 'win32', isFile },
  )
  assert.equal(result, 'ok')
  assert.deepEqual(started, ['C:\\Git\\mingw64\\bin\\git.exe', 'C:\\Git\\ucrt64\\bin\\git.exe'])
})

test('a runner that reports a failed start instead of throwing is retried the same way', async () => {
  let installed = 'C:\\Git\\mingw64\\bin\\git.exe'
  const isFile = async (path: string) => path === 'C:\\Git\\cmd\\git.exe' || path === installed
  const env = { PATH: 'C:\\Git\\cmd' }
  await withGitExecutable(env, async (file) => file, { platform: 'win32', isFile })
  installed = 'C:\\Git\\ucrt64\\bin\\git.exe'

  const result = await withGitExecutable(env, async (file) => ({ file, spawnFailed: file !== installed }), {
    platform: 'win32',
    isFile,
    didNotStart: (outcome) => outcome.spawnFailed,
  })
  assert.deepEqual(result, { file: 'C:\\Git\\ucrt64\\bin\\git.exe', spawnFailed: false })
})

test('a git that started and failed is not run a second time', async () => {
  const isFile = files('C:\\Git\\cmd\\git.exe', 'C:\\Git\\mingw64\\bin\\git.exe')
  let starts = 0
  await assert.rejects(
    withGitExecutable(
      { PATH: 'C:\\Git\\cmd' },
      async () => {
        starts += 1
        throw Object.assign(new Error('git exited with code 128'), { code: 128 })
      },
      { platform: 'win32', isFile },
    ),
    /code 128/,
  )
  assert.equal(starts, 1)
})
