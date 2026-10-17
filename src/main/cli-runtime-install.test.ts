import assert from 'node:assert/strict'

import {
  binaryVersionProbeFrom,
  buildExistsDescriptor,
  buildInstallDescriptor,
  buildProbeDescriptor,
  buildUpdateDescriptor,
  createCliExecutableResolver,
  parseProbeOutput,
  resolveInstallPlatform,
  runCliCommand,
  updateFailure,
} from './cli-runtime-install'
import { test } from 'vitest'

test('cli-runtime-install', async () => {
  // The exit code the probe scripts use for "binary not found on PATH".
  const NOT_FOUND_CODE = 3

  function main(): void {
    // resolveInstallPlatform: WSL only on Windows, for a WSL machine.
    assert.equal(resolveInstallPlatform('darwin', 'local'), 'darwin')
    assert.equal(resolveInstallPlatform('linux', undefined), 'linux')
    assert.equal(resolveInstallPlatform('win32', 'local'), 'win32')
    assert.equal(resolveInstallPlatform('win32', 'wsl:Ubuntu'), 'wsl')
    assert.equal(resolveInstallPlatform('win32', 'wsl:not a distro'), 'win32')
    assert.equal(resolveInstallPlatform('darwin', 'wsl:Ubuntu'), 'darwin')
    // Unknown POSIX-like platforms fall back to linux.
    assert.equal(resolveInstallPlatform('freebsd' as NodeJS.Platform, null), 'linux')

    // POSIX probe runs through a login bash and guards on `command -v`.
    const posixProbe = buildProbeDescriptor({ binary: 'claude', versionArgs: ['--version'], target: 'linux' })
    assert.equal(posixProbe.file, 'bash')
    assert.deepEqual(posixProbe.args.slice(0, 1), ['-lc'])
    assert.match(posixProbe.args[1], /command -v 'claude'/)
    assert.match(posixProbe.args[1], /'claude' '--version' 2>&1 \|\| true/)
    assert.match(posixProbe.args[1], /exit 3/)

    // WSL probe is routed through wsl.exe, with the script on stdin for a
    // login bash rather than on the command line wsl.exe re-quotes.
    const wslProbe = buildProbeDescriptor({ binary: 'claude', versionArgs: ['--version'], target: 'wsl' })
    assert.equal(wslProbe.file, 'wsl.exe')
    assert.deepEqual(wslProbe.args.slice(-5), ['--cd', '~', '--exec', 'sh', '-s'])
    assert.match(wslProbe.stdin ?? '', /^exec bash -l <</u)
    assert.ok(wslProbe.stdin?.includes("command -v 'claude'"), wslProbe.stdin ?? '')

    // Windows probe is PowerShell + Get-Command.
    const winProbe = buildProbeDescriptor({ binary: 'claude', versionArgs: ['--version'], target: 'win32' })
    assert.equal(winProbe.file, 'powershell.exe')
    assert.match(winProbe.args.join(' '), /Get-Command 'claude'/)
    assert.match(winProbe.args.join(' '), /exit 3/)

    // Exists descriptor never invokes the binary, only resolves it.
    const posixExists = buildExistsDescriptor({ binary: 'npm', target: 'linux' })
    assert.match(posixExists.args[1], /command -v 'npm' >\/dev\/null 2>&1 \|\| exit 3/)
    const winExists = buildExistsDescriptor({ binary: 'npm', target: 'win32' })
    assert.match(winExists.args.join(' '), /Get-Command 'npm' -ErrorAction SilentlyContinue/)

    // Install descriptor passes the command verbatim into the host shell.
    const posixInstall = buildInstallDescriptor({
      shell: 'curl -fsSL https://example/install.sh | bash',
      target: 'darwin',
    })
    assert.equal(posixInstall.file, 'bash')
    assert.equal(posixInstall.args[0], '-lc')
    assert.equal(posixInstall.args[1], 'curl -fsSL https://example/install.sh | bash')
    const winInstall = buildInstallDescriptor({ shell: 'irm https://example/install.ps1 | iex', target: 'win32' })
    assert.equal(winInstall.file, 'powershell.exe')
    assert.equal(winInstall.args.at(-1), 'irm https://example/install.ps1 | iex')

    // Single quotes in a binary path are escaped for POSIX.
    const quoted = buildProbeDescriptor({ binary: "/o'dd/claude", versionArgs: [], target: 'linux' })
    assert.match(quoted.args[1], /'\/o'\\''dd\/claude'/)

    // parseProbeOutput: not-found exit short-circuits.
    assert.deepEqual(parseProbeOutput(3, ''), { installed: false, version: null, resolvedPath: null })

    // parseProbeOutput pulls the path sentinel and the first version-looking line.
    const parsed = parseProbeOutput(0, 'SPRINTENGINE_PATH:/usr/local/bin/claude\nclaude 1.4.2 (build 99)\n')
    assert.equal(parsed.installed, true)
    assert.equal(parsed.resolvedPath, '/usr/local/bin/claude')
    assert.equal(parsed.version, 'claude 1.4.2 (build 99)')

    // Installed but version line missing a number still counts as installed.
    const noVersion = parseProbeOutput(0, 'SPRINTENGINE_PATH:/usr/local/bin/codex\n')
    assert.equal(noVersion.installed, true)
    assert.equal(noVersion.resolvedPath, '/usr/local/bin/codex')
    assert.equal(noVersion.version, null)

    // Update descriptor: the CLI's own updater (manifest update.args) runs
    // against the resolved binary in the target shell, mirroring the probe.
    const posixUpdate = buildUpdateDescriptor({ binary: 'claude', args: ['update'], target: 'darwin' })
    assert.equal(posixUpdate.file, 'bash')
    assert.equal(posixUpdate.args[0], '-lc')
    assert.equal(posixUpdate.args[1], "'claude' 'update'")
    const wslUpdate = buildUpdateDescriptor({ binary: 'claude', args: ['update'], target: 'wsl' })
    assert.equal(wslUpdate.file, 'wsl.exe')
    assert.deepEqual(wslUpdate.args.slice(-5), ['--cd', '~', '--exec', 'sh', '-s'])
    assert.ok(wslUpdate.stdin?.includes("'claude' 'update'"), wslUpdate.stdin ?? '')
    const winUpdate = buildUpdateDescriptor({ binary: 'claude', args: ['update'], target: 'win32' })
    assert.equal(winUpdate.file, 'powershell.exe')
    assert.equal(winUpdate.args.at(-1), "& 'claude' 'update'")
    // A runtime command override with awkward characters stays safely quoted.
    const quotedUpdate = buildUpdateDescriptor({ binary: "/o'dd/claude", args: ['update'], target: 'linux' })
    assert.match(quotedUpdate.args[1], /'\/o'\\''dd\/claude' 'update'/)

    // Unmanaged-binary probe (git/gh): the three outcomes stay distinct. Versions
    // below are synthetic fixtures; real ones only ever come from a real probe.
    assert.deepEqual(
      binaryVersionProbeFrom({
        parsed: parseProbeOutput(0, 'SPRINTENGINE_PATH:/usr/bin/git\ngit version 0.0.0-fixture\n'),
        inconclusive: false,
      }),
      { outcome: 'resolved', version: 'git version 0.0.0-fixture', resolvedPath: '/usr/bin/git' },
    )
    // A binary that is genuinely absent: a definitive verdict.
    assert.deepEqual(binaryVersionProbeFrom({ parsed: parseProbeOutput(NOT_FOUND_CODE, ''), inconclusive: false }), {
      outcome: 'not_installed',
    })
    // A probe killed at its deadline parses as absent, but that is a non-answer:
    // it must never read as a missing binary.
    assert.deepEqual(binaryVersionProbeFrom({ parsed: parseProbeOutput(NOT_FOUND_CODE, ''), inconclusive: true }), {
      outcome: 'probe_failed',
    })
    // Resolves on PATH but prints no version line: ran, told us nothing usable.
    assert.deepEqual(
      binaryVersionProbeFrom({ parsed: parseProbeOutput(0, 'SPRINTENGINE_PATH:/usr/bin/true\n'), inconclusive: false }),
      { outcome: 'probe_failed' },
    )

    console.log('cli-runtime-install: all assertions passed')
  }

  main()
})

test('a CLI is looked up once per machine and command, and again once its path is gone', async () => {
  const lookups: string[] = []
  const present = new Set(['/usr/local/bin/claude', '/opt/bin/codex', '/Users/dev/bin/claude'])
  const resolver = createCliExecutableResolver({
    lookup: async (cli, runtime) => {
      lookups.push(`${cli}@${runtime?.hostId ?? 'local'}${runtime?.command ? `:${runtime.command}` : ''}`)
      const path = runtime?.command
        ? runtime.command
        : cli === 'claude-code'
          ? '/usr/local/bin/claude'
          : cli === 'codex'
            ? '/opt/bin/codex'
            : null
      return { path, error: path ? null : 'not on PATH' }
    },
    stillThere: async (path, runtime) => (runtime?.hostId?.startsWith('wsl:') ? null : present.has(path)),
  })
  // Concurrent starts share one lookup, and later starts run none.
  const [first, second] = await Promise.all([resolver.resolve('claude-code'), resolver.resolve('claude-code')])
  assert.equal(first.path, '/usr/local/bin/claude')
  assert.equal(second.path, '/usr/local/bin/claude')
  assert.equal((await resolver.resolve('claude-code', { hostId: 'local' })).path, '/usr/local/bin/claude')
  assert.deepEqual(lookups, ['claude-code@local'])
  // A command override is a lookup of its own.
  assert.equal(
    (await resolver.resolve('claude-code', { command: '/Users/dev/bin/claude' })).path,
    '/Users/dev/bin/claude',
  )
  assert.equal(lookups.length, 2)
  // A path that is no longer there is looked up again.
  present.delete('/usr/local/bin/claude')
  await resolver.resolve('claude-code')
  assert.equal(lookups.length, 3)
  // A CLI that is not found says why, and is not remembered as missing.
  assert.deepEqual(await resolver.resolve('gemini'), { path: null, error: 'not on PATH' })
  assert.equal((await resolver.resolve('gemini')).path, null)
  assert.equal(lookups.filter((entry) => entry.startsWith('gemini')).length, 2)
  // Forgetting one CLI keeps the others; forgetting all drops every path.
  await resolver.resolve('codex')
  present.add('/usr/local/bin/claude')
  await resolver.resolve('claude-code')
  const before = lookups.length
  resolver.invalidate('codex')
  await resolver.resolve('claude-code')
  await resolver.resolve('codex')
  assert.deepEqual(lookups.slice(before), ['codex@local'])
  resolver.invalidate()
  await resolver.resolve('claude-code')
  assert.equal(lookups.at(-1), 'claude-code@local')
  // A path this process cannot check (inside WSL) is trusted.
  await resolver.resolve('codex', { hostId: 'wsl:Ubuntu' })
  const wslLookups = lookups.length
  await resolver.resolve('codex', { hostId: 'wsl:Ubuntu' })
  assert.equal(lookups.length, wslLookups)
})

test('a failed lookup is not remembered', async () => {
  let calls = 0
  const resolver = createCliExecutableResolver({
    lookup: async () => {
      calls++
      if (calls === 1) throw new Error('probe failed')
      return { path: '/usr/bin/codex', error: null }
    },
    stillThere: async () => true,
  })
  await assert.rejects(resolver.resolve('codex'), /probe failed/)
  assert.equal((await resolver.resolve('codex')).path, '/usr/bin/codex')
  assert.equal((await resolver.resolve('codex')).path, '/usr/bin/codex')
  assert.equal(calls, 2)
})

test('a failed update says what the command printed last, not only its exit code', () => {
  const log = [
    '$ npm install -g @openai/codex@latest',
    'npm error code EACCES',
    'npm error syscall mkdir',
    "\u001b[31mnpm error\u001b[0m Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@openai'",
    '',
  ].join('\n')
  assert.equal(
    updateFailure(243, log),
    "Update command exited with code 243: npm error code EACCES npm error syscall mkdir npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@openai'",
  )
  // A link a CLI prints is its text, not its escape.
  assert.equal(
    updateFailure(1, '$ claude update\r\nSee \u001b]8;;https://example.com\u0007the docs\u001b]8;;\u0007\r\n'),
    'Update command exited with code 1: See the docs',
  )
  // A command that printed nothing has only its code to give.
  assert.equal(updateFailure(1, '$ claude update\n'), 'Update command exited with code 1.')
})

test("a command's set variables reach it on top of its environment, which is left as it was", async () => {
  const env = { ...process.env, GROK_DISABLE_AUTOUPDATER: '0' }
  const outcome = await runCliCommand({
    binary: process.execPath,
    args: ['-e', 'process.stdout.write(String(process.env.GROK_DISABLE_AUTOUPDATER))'],
    timeoutMs: 20_000,
    env,
    setEnv: { GROK_DISABLE_AUTOUPDATER: '1' },
  })
  assert.equal(outcome.code, 0, outcome.stderr)
  assert.match(outcome.stdout, /1$/u)
  assert.equal(env.GROK_DISABLE_AUTOUPDATER, '0')
})
