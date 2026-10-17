import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'

import {
  createLoginShellPathResolver,
  findExecutable,
  LOGIN_BASH_PATH_TIMEOUT_MS,
  LOGIN_PATH_SENTINEL,
  loginShellPathDescriptors,
  parseLoginShellPath,
  searchDirectories,
  USER_SHELL_PATH_TIMEOUT_MS,
  userShellProbeSupported,
  withUserShellPath,
  lastKnownLoginShellPath,
  lastKnownLoginShellEnv,
  LOGIN_ENV_SENTINEL,
  LOGIN_SHELL_ENV_VARIABLES,
  parseLoginShellEnv,
  withLoginShellEnv,
  type LoginShellPathDescriptor,
  type LoginShellPathOutcome,
  sharedLoginShellPath,
} from './login-shell-path'
import { runSpawnDescriptor, type RunOutcome } from './process-run'

// The shared lookup starts its shells through the process runner; nothing else
// in this file does.
vi.mock('./process-run', () => ({ runSpawnDescriptor: vi.fn() }))
const runShell = vi.mocked(runSpawnDescriptor)

afterEach(() => {
  sharedLoginShellPath().invalidate()
  runShell.mockReset()
  vi.unstubAllEnvs()
})

const answered = (path: string): LoginShellPathOutcome => ({
  code: 0,
  stdout: `\n${LOGIN_PATH_SENTINEL}${path}\n`,
  timedOut: false,
})
const hung: LoginShellPathOutcome = { code: 3, stdout: '', timedOut: true }

test("the person's own zsh is asked first, interactively, with plain login bash behind it", () => {
  const [own, plain] = loginShellPathDescriptors('/bin/zsh')
  assert.equal(own.file, '/bin/zsh')
  assert.equal(own.args[0], '-ilc', '-i so ~/.zshrc is sourced, as a terminal tab sources it')
  assert.match(own.args[1], /"\$PATH"/)
  assert.equal(own.timeoutMs, USER_SHELL_PATH_TIMEOUT_MS)
  assert.equal(plain.file, 'bash')
  assert.equal(plain.args[0], '-lc')
  assert.equal(plain.timeoutMs, LOGIN_BASH_PATH_TIMEOUT_MS)
})

test('a shell that cannot run the POSIX script, or none at all, leaves only login bash', () => {
  for (const shell of ['/opt/homebrew/bin/fish', '', '  ', undefined]) {
    const descriptors = loginShellPathDescriptors(shell)
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.file),
      ['bash'],
      `${shell ?? 'no shell'}`,
    )
  }
})

test('the user shell is only consulted on a host POSIX target', () => {
  assert.equal(userShellProbeSupported('darwin', '/bin/zsh'), true)
  assert.equal(userShellProbeSupported('linux', '/usr/bin/bash'), true)
  assert.equal(userShellProbeSupported('win32', '/bin/zsh'), false)
  assert.equal(userShellProbeSupported('wsl', '/bin/zsh'), false)
  assert.equal(userShellProbeSupported('darwin', '/usr/bin/fish'), false)
})

test('the PATH is read from its marked line, whatever the rc files printed around it', () => {
  const stdout = [
    'Last login: Mon on ttys001',
    `${LOGIN_PATH_SENTINEL}/decoy/bin`,
    'motd noise',
    `${LOGIN_PATH_SENTINEL}/Users/dev/.nvm/bin:/usr/bin`,
    '',
  ].join('\n')
  assert.equal(parseLoginShellPath(stdout), '/Users/dev/.nvm/bin:/usr/bin', 'the last marked line wins')
  assert.equal(parseLoginShellPath('no marker here\n'), null)
  assert.equal(parseLoginShellPath(`${LOGIN_PATH_SENTINEL}\n`), null, 'an empty PATH is no answer')
})

test('search order is the login PATH, then what only the caller PATH has', () => {
  assert.deepEqual(searchDirectories('/Users/dev/.nvm/bin:/usr/bin::relative/bin:/bin', '/managed/shims:/usr/bin:'), [
    '/Users/dev/.nvm/bin',
    '/usr/bin',
    '/bin',
    '/managed/shims',
  ])
  assert.deepEqual(searchDirectories(null, '/usr/bin:/bin'), ['/usr/bin', '/bin'], 'no login PATH: the caller PATH')
})

test('a binary is found in PATH order, and only as an executable regular file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'login-shell-path-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    // The first directory holds a non-executable `claude` and a directory named
    // `codex`; the only real binary is the second directory's `claude`.
    await writeFile(join(first, 'claude'), '#!/bin/sh\n')
    await chmod(join(first, 'claude'), 0o644)
    await mkdir(join(first, 'codex'))
    await writeFile(join(second, 'claude'), '#!/bin/sh\n')
    await chmod(join(second, 'claude'), 0o755)

    assert.equal(await findExecutable('claude', [first, second]), join(second, 'claude'))
    assert.equal(await findExecutable('codex', [first, second]), null, 'a directory is not a binary')
    assert.equal(await findExecutable('missing', [first, second]), null)
    assert.equal(await findExecutable('  ', [first, second]), null)
    // A command override that is already a path is checked where it points,
    // never looked up on PATH.
    assert.equal(await findExecutable(join(second, 'claude'), []), join(second, 'claude'))
    assert.equal(await findExecutable(join(first, 'claude'), [second]), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent callers share one shell, and the answer is kept for the session', async () => {
  const runs: LoginShellPathDescriptor[] = []
  let release: (outcome: LoginShellPathOutcome) => void = () => undefined
  const resolver = createLoginShellPathResolver({
    shell: () => '/bin/zsh',
    run: (descriptor) => {
      runs.push(descriptor)
      return new Promise((resolve) => (release = resolve))
    },
  })
  const pending = Array.from({ length: 10 }, () => resolver.resolve({}))
  release(answered('/Users/dev/.nvm/bin:/usr/bin'))
  const answers = await Promise.all(pending)
  assert.deepEqual(new Set(answers), new Set(['/Users/dev/.nvm/bin:/usr/bin']))
  assert.equal(await resolver.resolve({}), '/Users/dev/.nvm/bin:/usr/bin')
  assert.equal(runs.length, 1, 'ten CLIs, later refreshes: one shell')
})

test('a hung interactive shell falls through to login bash', async () => {
  const files: string[] = []
  const resolver = createLoginShellPathResolver({
    shell: () => '/bin/zsh',
    run: async (descriptor) => {
      files.push(descriptor.file)
      return descriptor.file === '/bin/zsh' ? hung : answered('/usr/local/bin:/usr/bin')
    },
  })
  assert.equal(await resolver.resolve({}), '/usr/local/bin:/usr/bin')
  assert.deepEqual(files, ['/bin/zsh', 'bash'])
})

test('a resolution no shell answered is not kept, so the next caller asks again', async () => {
  let runs = 0
  let broken = true
  const resolver = createLoginShellPathResolver({
    shell: () => undefined,
    run: async () => {
      runs += 1
      if (broken) throw new Error('spawn bash ENOENT')
      return answered('/usr/bin')
    },
  })
  assert.equal(await resolver.resolve({}), null)
  broken = false
  assert.equal(await resolver.resolve({}), '/usr/bin')
  assert.equal(runs, 2)
})

test('invalidate makes the next caller ask a shell again', async () => {
  let path = '/usr/bin'
  let runs = 0
  const resolver = createLoginShellPathResolver({
    shell: () => undefined,
    run: async () => {
      runs += 1
      return answered(path)
    },
  })
  assert.equal(await resolver.resolve({}), '/usr/bin')
  // An installer appended a directory to the shell config.
  path = '/Users/dev/.local/bin:/usr/bin'
  assert.equal(await resolver.resolve({}), '/usr/bin', 'still the session answer')
  resolver.invalidate()
  assert.equal(await resolver.resolve({}), '/Users/dev/.local/bin:/usr/bin')
  assert.equal(runs, 2)
})

test('the shell is handed the caller environment', async () => {
  const seen: NodeJS.ProcessEnv[] = []
  const resolver = createLoginShellPathResolver({
    shell: () => undefined,
    run: async (_descriptor, env) => {
      seen.push(env)
      return answered('/usr/bin')
    },
  })
  await resolver.resolve({ PATH: '/managed/shims:/usr/bin' })
  assert.equal(seen[0]?.PATH, '/managed/shims:/usr/bin', 'the managed shims reach the shell it extends')
})

// What a Mac app opened from Finder or the Dock inherits from launchd, with the
// managed runtime's bin in front, as an agent's shell reported it.
const FINDER_PATH = '/Users/dev/.sprintengine/node/bin:/usr/bin:/bin:/usr/sbin:/sbin'

test('a Finder launch gets the login shell PATH in front of its own, keeping what only the app had', () => {
  const env = withUserShellPath(
    { PATH: FINDER_PATH, HOME: '/Users/dev' },
    { platform: 'darwin', loginPath: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', exists: () => false },
  )
  assert.equal(
    env.PATH,
    '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/dev/.sprintengine/node/bin:/usr/sbin:/sbin',
  )
  assert.equal(env.HOME, '/Users/dev', 'the rest of the environment is untouched')
})

test('before any login shell has answered, Homebrew and /usr/local/bin are added when they exist', () => {
  const present = new Set(['/opt/homebrew/bin', '/usr/local/bin'])
  const env = withUserShellPath(
    { PATH: FINDER_PATH },
    { platform: 'darwin', loginPath: null, exists: (directory) => present.has(directory) },
  )
  assert.equal(env.PATH, `${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`)
  const linux = withUserShellPath(
    { PATH: '/usr/bin:/bin' },
    { platform: 'linux', loginPath: null, exists: (directory) => directory === '/home/linuxbrew/.linuxbrew/bin' },
  )
  assert.equal(linux.PATH, '/usr/bin:/bin:/home/linuxbrew/.linuxbrew/bin')
})

test('a PATH that already has everything is returned as it was, and Windows is left alone', () => {
  const full = { PATH: '/opt/homebrew/bin:/usr/bin:/bin' }
  assert.equal(withUserShellPath(full, { platform: 'darwin', loginPath: null, exists: () => false }), full)
  const windows = { PATH: 'C:\\Windows\\system32' }
  assert.equal(
    withUserShellPath(windows, { platform: 'win32', loginPath: '/opt/homebrew/bin', exists: () => true }),
    windows,
  )
})

test('a resolved login PATH is what the next synchronous spawn reads', async () => {
  const resolver = createLoginShellPathResolver({
    run: async () => answered('/opt/homebrew/bin:/Users/dev/.local/bin:/usr/bin'),
    shell: () => '/bin/zsh',
  })
  await resolver.resolve({})
  assert.equal(lastKnownLoginShellPath(), '/opt/homebrew/bin:/Users/dev/.local/bin:/usr/bin')
})

const shellPrinted = (path: string | null): RunOutcome => ({
  code: path === null ? 1 : 0,
  stdout: path === null ? '' : `\n${LOGIN_PATH_SENTINEL}${path}\n`,
  stderr: '',
  timedOut: false,
})

test('CLI detection, gh and the local-server runner share one login shell for the whole process', async () => {
  vi.stubEnv('SHELL', '/bin/zsh')
  let release: (outcome: RunOutcome) => void = () => undefined
  runShell.mockImplementation(() => new Promise((resolve) => (release = resolve)))
  // Each caller fetches the lookup the way its module does, at its own time.
  const callers = [sharedLoginShellPath(), sharedLoginShellPath(), sharedLoginShellPath()]
  const pending = callers.map((resolver) => resolver.resolve({ PATH: '/usr/bin' }))
  release(shellPrinted('/opt/homebrew/bin:/usr/bin'))
  assert.deepEqual(await Promise.all(pending), Array(3).fill('/opt/homebrew/bin:/usr/bin'))
  assert.equal(await sharedLoginShellPath().resolve({}), '/opt/homebrew/bin:/usr/bin')
  assert.equal(runShell.mock.calls.length, 1)
  assert.equal(runShell.mock.calls[0]?.[0].file, '/bin/zsh')
})

test("one caller's invalidate makes the next caller, whichever it is, ask a shell again", async () => {
  vi.stubEnv('SHELL', '/bin/zsh')
  let path = '/usr/bin'
  runShell.mockImplementation(async () => shellPrinted(path))
  assert.equal(await sharedLoginShellPath().resolve({}), '/usr/bin')
  // An install appended a directory to the shell config, and CLI detection
  // dropped the answer before re-detecting.
  path = '/Users/dev/.local/bin:/usr/bin'
  sharedLoginShellPath().invalidate()
  assert.equal(await sharedLoginShellPath().resolve({}), '/Users/dev/.local/bin:/usr/bin', 'gh sees it too')
  assert.equal(runShell.mock.calls.length, 2)
})

test('a shared lookup no shell answered is asked again by the next caller', async () => {
  vi.stubEnv('SHELL', '/bin/zsh')
  let answers = false
  runShell.mockImplementation(async () => shellPrinted(answers ? '/usr/local/bin:/usr/bin' : null))
  assert.equal(await sharedLoginShellPath().resolve({}), null)
  answers = true
  assert.equal(await sharedLoginShellPath().resolve({}), '/usr/local/bin:/usr/bin')
  // zsh then bash for the failure, zsh alone for the answer.
  assert.equal(runShell.mock.calls.length, 3)
})

test("the shell that answers for PATH also says which certificate trust the person's profile sets", () => {
  const stdout = [
    'Last login: Mon',
    `${LOGIN_PATH_SENTINEL}/usr/bin`,
    `${LOGIN_ENV_SENTINEL}SSL_CERT_FILE=/opt/homebrew/etc/ca-certificates/cert.pem`,
    `${LOGIN_ENV_SENTINEL}NODE_EXTRA_CA_CERTS=/Users/dev/corp-root.pem`,
    `${LOGIN_ENV_SENTINEL}NODE_EXTRA_CA_CERTS=/Users/dev/corp root.pem`,
    `${LOGIN_ENV_SENTINEL}AWS_SECRET_ACCESS_KEY=never-read`,
    `${LOGIN_ENV_SENTINEL}SSL_CERT_DIR=`,
  ].join('\n')
  assert.deepEqual(parseLoginShellEnv(stdout), {
    SSL_CERT_FILE: '/opt/homebrew/etc/ca-certificates/cert.pem',
    NODE_EXTRA_CA_CERTS: '/Users/dev/corp root.pem',
  })
  assert.deepEqual(parseLoginShellEnv(`${LOGIN_PATH_SENTINEL}/usr/bin\n`), {})
})

test.skipIf(process.platform === 'win32')(
  'the probe script prints the trust variables a shell has set, and only those',
  () => {
    const script = loginShellPathDescriptors(undefined)[0]!.args[1]!
    const stdout = execFileSync('/bin/sh', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', NODE_EXTRA_CA_CERTS: '/Users/dev/corp-root.pem' },
    })
    assert.equal(parseLoginShellPath(stdout), '/usr/bin:/bin')
    assert.deepEqual(parseLoginShellEnv(stdout), { NODE_EXTRA_CA_CERTS: '/Users/dev/corp-root.pem' })
  },
)

test('a spawn gets the trust variables it lacks, never in place of ones the app was started with', () => {
  const login = { SSL_CERT_FILE: '/opt/homebrew/etc/cert.pem', NODE_EXTRA_CA_CERTS: '/Users/dev/corp-root.pem' }
  assert.deepEqual(withLoginShellEnv({ PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/etc/mine.pem' }, login), {
    PATH: '/usr/bin',
    SSL_CERT_FILE: '/opt/homebrew/etc/cert.pem',
    NODE_EXTRA_CA_CERTS: '/etc/mine.pem',
  })
  const untouched = { PATH: '/usr/bin' }
  assert.equal(withLoginShellEnv(untouched, {}), untouched)
})

test('the trust variables are kept with the PATH they came with, for the next synchronous spawn', async () => {
  const resolver = createLoginShellPathResolver({
    run: async () => ({
      code: 0,
      stdout: `\n${LOGIN_PATH_SENTINEL}/usr/bin\n${LOGIN_ENV_SENTINEL}SSL_CERT_DIR=/etc/corp/certs\n`,
      timedOut: false,
    }),
    shell: () => '/bin/zsh',
  })
  await resolver.resolve({})
  assert.deepEqual(lastKnownLoginShellEnv(), { SSL_CERT_DIR: '/etc/corp/certs' })
  resolver.invalidate()
  const without = createLoginShellPathResolver({ run: async () => answered('/usr/bin'), shell: () => '/bin/zsh' })
  await without.resolve({})
  assert.deepEqual(lastKnownLoginShellEnv(), {}, 'a profile that stopped setting one stops passing it on')
})

test("the shell that answers for PATH also says which provider settings the person's profile exports", () => {
  const stdout = [
    `${LOGIN_PATH_SENTINEL}/usr/bin`,
    `${LOGIN_ENV_SENTINEL}CLAUDE_CODE_USE_BEDROCK=1`,
    `${LOGIN_ENV_SENTINEL}AWS_PROFILE=acme-dev`,
    `${LOGIN_ENV_SENTINEL}HTTPS_PROXY=http://proxy.example.com:8080`,
    `${LOGIN_ENV_SENTINEL}no_proxy=localhost,.example.com`,
    `${LOGIN_ENV_SENTINEL}OPENROUTER_API_KEY=sk-or-test`,
    `${LOGIN_ENV_SENTINEL}ANTHROPIC_DEFAULT_SONNET_MODEL=acme-sonnet`,
  ].join('\n')
  assert.deepEqual(parseLoginShellEnv(stdout), {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_PROFILE: 'acme-dev',
    HTTPS_PROXY: 'http://proxy.example.com:8080',
    no_proxy: 'localhost,.example.com',
    OPENROUTER_API_KEY: 'sk-or-test',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'acme-sonnet',
  })
})

test('the Anthropic auth a Claude chat strips is never read from the profile', () => {
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    assert.ok(!(LOGIN_SHELL_ENV_VARIABLES as readonly string[]).includes(name), name)
  }
  const stdout = [
    `${LOGIN_PATH_SENTINEL}/usr/bin`,
    `${LOGIN_ENV_SENTINEL}ANTHROPIC_API_KEY=sk-ant-never-read`,
    `${LOGIN_ENV_SENTINEL}ANTHROPIC_AUTH_TOKEN=never-read`,
    `${LOGIN_ENV_SENTINEL}ANTHROPIC_BASE_URL=https://proxy.example.com`,
  ].join('\n')
  assert.deepEqual(parseLoginShellEnv(stdout), {})
})

test.skipIf(process.platform === 'win32')('the probe script prints the provider settings a shell has set', () => {
  const script = loginShellPathDescriptors(undefined)[0]!.args[1]!
  const stdout = execFileSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      GEMINI_API_KEY: 'gm-test',
      http_proxy: 'http://proxy.example.com:3128',
      ANTHROPIC_API_KEY: 'sk-ant-never-read',
    },
  })
  assert.deepEqual(parseLoginShellEnv(stdout), {
    GEMINI_API_KEY: 'gm-test',
    http_proxy: 'http://proxy.example.com:3128',
  })
})

test('a spawn gets the provider settings it lacks, never in place of ones the app was started with', () => {
  const login = { AWS_REGION: 'us-west-2', CLAUDE_CODE_USE_VERTEX: '1', GH_TOKEN: 'gh-from-profile' }
  assert.deepEqual(withLoginShellEnv({ PATH: '/usr/bin', GH_TOKEN: 'gh-from-launch' }, login), {
    PATH: '/usr/bin',
    AWS_REGION: 'us-west-2',
    CLAUDE_CODE_USE_VERTEX: '1',
    GH_TOKEN: 'gh-from-launch',
  })
})
