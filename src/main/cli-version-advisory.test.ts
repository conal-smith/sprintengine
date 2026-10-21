import assert from 'node:assert/strict'

import type { PluginManifest } from '../shared/plugin-manifest'
import {
  chooseCliUpdateCommand,
  clearNpmLatestCache,
  foreignPackageManager,
  npmGlobalPrefix,
  type CliInstallFs,
  deriveCliVersionStatus,
  fetchNpmLatestVersion,
  isHomebrewPath,
  outdatedClis,
  resolveCliVersionAdvisories,
} from './cli-version-advisory'
import { test } from 'vitest'

const manifest = (over: Partial<PluginManifest>): PluginManifest =>
  ({ id: 'codex', displayName: 'Codex', binary: 'codex', version: 1, ...over }) as PluginManifest

// A machine's files as the chooser reads them: each link and where it ends,
// and the files that exist. A path that is in neither does not resolve.
function fakeFs(links: Record<string, string>, files: string[] = []): CliInstallFs {
  return {
    realPath: (path) => links[path] ?? (files.includes(path) ? path : null),
    exists: (path) => files.includes(path),
  }
}

test('cli-version-advisory', async () => {
  async function main(): Promise<void> {
    // Status: loose compare, unknown when either side has no version.
    assert.equal(deriveCliVersionStatus('codex-cli 0.153.2', '0.153.3'), 'behind_latest')
    assert.equal(deriveCliVersionStatus('2.1.261 (Claude Code)', '2.1.261'), 'current')
    assert.equal(deriveCliVersionStatus('2.1.262', '2.1.261'), 'current')
    assert.equal(deriveCliVersionStatus(null, '1.0.0'), 'unknown')
    assert.equal(deriveCliVersionStatus('1.0.0', null), 'unknown')
    assert.equal(deriveCliVersionStatus('grok 1.0.13 (5e9a58528b76) [stable]', '1.0.13'), 'current')

    // Homebrew detection by path.
    assert.equal(isHomebrewPath('/opt/homebrew/bin/codex'), true)
    assert.equal(isHomebrewPath('/opt/homebrew/Cellar/codex/0.153.2/bin/codex'), true)
    assert.equal(isHomebrewPath('/usr/local/Cellar/opencode/1.18.27/bin/opencode'), true)
    assert.equal(isHomebrewPath('/Users/me/.npm-global/bin/codex'), false)
    assert.equal(isHomebrewPath('/Users/me/.local/bin/claude'), false)
    assert.equal(isHomebrewPath(null), false)

    // The update command, in precedence order: the CLI's own updater, then
    // Homebrew, then npm.
    assert.deepEqual(
      chooseCliUpdateCommand({
        manifest: manifest({
          binary: 'claude',
          update: { args: ['update'] },
          package: { npm: '@anthropic-ai/claude-code', brew: 'claude-code' },
        }),
        resolvedPath: '/opt/homebrew/bin/claude',
        fs: fakeFs({}),
      }),
      { kind: 'cli-updater', command: 'claude update' },
      "the CLI's own updater wins even under Homebrew",
    )
    assert.deepEqual(
      chooseCliUpdateCommand({
        manifest: manifest({ package: { npm: '@openai/codex', brew: 'codex' } }),
        resolvedPath: '/opt/homebrew/bin/codex',
        fs: fakeFs({ '/opt/homebrew/bin/codex': '/opt/homebrew/Caskroom/codex/0.161.0/bin/codex' }),
      }),
      { kind: 'brew', command: 'brew upgrade codex' },
    )
    assert.deepEqual(
      chooseCliUpdateCommand({
        manifest: manifest({ package: { npm: '@openai/codex', brew: 'codex' } }),
        resolvedPath: '/Users/me/.nvm/versions/node/v22/bin/codex',
        fs: fakeFs({
          '/Users/me/.nvm/versions/node/v22/bin/codex':
            '/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js',
        }),
      }),
      { kind: 'npm', command: 'npm install -g --prefix /Users/me/.nvm/versions/node/v22 @openai/codex@latest' },
      'npm updates the copy in the prefix it installed',
    )
    assert.deepEqual(
      chooseCliUpdateCommand({
        manifest: manifest({ package: { brew: 'codex' } }),
        resolvedPath: '/usr/bin/codex',
        fs: fakeFs({}, ['/usr/bin/codex']),
      }),
      null,
      'a formula alone helps only when the binary is under Homebrew',
    )
    assert.equal(
      chooseCliUpdateCommand({ manifest: manifest({}), resolvedPath: '/usr/bin/codex', fs: fakeFs({}) }),
      null,
    )

    // npm latest: parsed, cached for an hour (misses too), force bypasses.
    clearNpmLatestCache()
    let calls = 0
    let clock = Date.parse('2026-09-04T12:00:00Z')
    const fetcher = async (url: string): Promise<Response> => {
      calls += 1
      assert.equal(url, 'https://registry.npmjs.org/%40openai%2Fcodex/latest')
      return new Response(JSON.stringify({ version: '0.153.3' }), { status: 200 })
    }
    const deps = { fetcher, now: () => clock }
    assert.equal(await fetchNpmLatestVersion('@openai/codex', deps), '0.153.3')
    assert.equal(await fetchNpmLatestVersion('@openai/codex', deps), '0.153.3')
    assert.equal(calls, 1, 'second read inside the hour is cached')
    clock += 61 * 60 * 1000
    await fetchNpmLatestVersion('@openai/codex', deps)
    assert.equal(calls, 2, 'after the hour it asks again')
    await fetchNpmLatestVersion('@openai/codex', { ...deps, force: true })
    assert.equal(calls, 3, 'force bypasses the cache')

    clearNpmLatestCache()
    let missCalls = 0
    const missing = async (): Promise<Response> => {
      missCalls += 1
      return new Response('{}', { status: 404 })
    }
    assert.equal(await fetchNpmLatestVersion('@xai/grok-cli', { fetcher: missing, now: () => clock }), null)
    assert.equal(await fetchNpmLatestVersion('@xai/grok-cli', { fetcher: missing, now: () => clock }), null)
    assert.equal(missCalls, 1, 'a miss is cached as well')
    const throwing = async (): Promise<Response> => {
      throw new Error('ENOTFOUND')
    }
    clearNpmLatestCache()
    assert.equal(
      await fetchNpmLatestVersion('@openai/codex', { fetcher: throwing, now: () => clock }),
      null,
      'a network error is unknown, not a throw',
    )

    // Advisories over an availability map.
    const manifests: Record<string, PluginManifest> = {
      codex: manifest({ package: { npm: '@openai/codex', brew: 'codex' } }),
      'claude-code': manifest({
        id: 'claude-code',
        displayName: 'Claude Code',
        binary: 'claude',
        update: { args: ['update'] },
        package: { npm: '@anthropic-ai/claude-code', brew: 'claude-code' },
      }),
      cursor: manifest({ id: 'cursor', displayName: 'Cursor', binary: 'cursor-agent' }),
    }
    const latest: Record<string, string | null> = { '@openai/codex': '0.153.3', '@anthropic-ai/claude-code': '2.1.261' }
    const asked: string[] = []
    const advisories = await resolveCliVersionAdvisories(
      {
        codex: { cli: 'codex', installed: true, resolvedPath: '/opt/homebrew/bin/codex', version: 'codex-cli 0.153.2' },
        'claude-code': {
          cli: 'claude-code',
          installed: true,
          resolvedPath: '/Users/me/.local/bin/claude',
          version: '2.1.261 (Claude Code)',
        },
        cursor: {
          cli: 'cursor',
          installed: true,
          resolvedPath: '/Users/me/.local/bin/cursor-agent',
          version: '2026.09.01',
        },
        grok: { cli: 'grok', installed: false, resolvedPath: null, version: null },
      },
      {
        getManifest: (cli) => manifests[cli] ?? null,
        fs: fakeFs({ '/opt/homebrew/bin/codex': '/opt/homebrew/Caskroom/codex/0.161.0/bin/codex' }),
        fetchLatest: async (pkg) => {
          asked.push(pkg)
          return latest[pkg] ?? null
        },
        now: () => new Date('2026-09-04T12:00:00Z'),
      },
    )
    assert.deepEqual(
      asked.sort(),
      ['@anthropic-ai/claude-code', '@openai/codex'],
      'only installed CLIs with an npm package are asked',
    )
    assert.equal(advisories.codex?.status, 'behind_latest')
    assert.equal(advisories.codex?.latestVersion, '0.153.3')
    assert.deepEqual(advisories.codex?.updateCommand, { kind: 'brew', command: 'brew upgrade codex' })
    assert.equal(advisories['claude-code']?.status, 'current')
    assert.equal(advisories.cursor?.status, 'unknown')
    assert.equal(advisories.cursor?.updateCommand, null)
    assert.equal(advisories.grok?.status, 'unknown', 'a CLI that is not installed is never behind')
    assert.deepEqual(
      outdatedClis(advisories).map((entry) => entry.cli),
      ['codex'],
    )

    console.log('cli-version-advisory: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

const grok = manifest({
  id: 'grok',
  displayName: 'Grok Build',
  binary: 'grok',
  package: { npm: '@xai-official/grok' },
  selfUpdate: { args: ['update'] },
})

test('a CLI its vendor script installed updates itself, never through npm', () => {
  const fs = fakeFs({ '/Users/dev/.grok/bin/grok': '/Users/dev/.grok/bin/grok-1.0.41' })
  assert.deepEqual(chooseCliUpdateCommand({ manifest: grok, resolvedPath: '/Users/dev/.grok/bin/grok', fs }), {
    kind: 'cli-updater',
    command: 'grok update',
  })
})

test('a CLI with no updater of its own, at a path npm did not make, names no command', () => {
  const opencodeScript = manifest({ id: 'opencode', binary: 'opencode', package: { npm: 'opencode-ai' } })
  const fs = fakeFs({}, ['/Users/dev/.opencode/bin/opencode'])
  assert.equal(
    chooseCliUpdateCommand({ manifest: opencodeScript, resolvedPath: '/Users/dev/.opencode/bin/opencode', fs }),
    null,
  )
})

test('the same CLI installed by npm is updated by npm, in the prefix that holds it', () => {
  const fs = fakeFs({ '/opt/homebrew/bin/grok': '/opt/homebrew/lib/node_modules/@xai-official/grok/bin/grok-native' })
  assert.deepEqual(chooseCliUpdateCommand({ manifest: grok, resolvedPath: '/opt/homebrew/bin/grok', fs }), {
    kind: 'npm',
    command: 'npm install -g --prefix /opt/homebrew @xai-official/grok@latest',
  })
})

test('an npm install under Homebrew’s prefix is npm’s, not a formula’s', () => {
  const opencode = manifest({ id: 'opencode', binary: 'opencode', package: { npm: 'opencode-ai', brew: 'opencode' } })
  const npmUnderBrew = fakeFs({
    '/opt/homebrew/bin/opencode': '/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode.exe',
  })
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: opencode, resolvedPath: '/opt/homebrew/bin/opencode', fs: npmUnderBrew }),
    { kind: 'npm', command: 'npm install -g --prefix /opt/homebrew opencode-ai@latest' },
  )
  const formula = fakeFs({ '/opt/homebrew/bin/opencode': '/opt/homebrew/Cellar/opencode/1.18.27/bin/opencode' })
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: opencode, resolvedPath: '/opt/homebrew/bin/opencode', fs: formula }),
    { kind: 'brew', command: 'brew upgrade opencode' },
  )
})

test('a formula that vendors an npm tree in its keg is still brew’s', () => {
  const codex = manifest({ package: { npm: '@openai/codex', brew: 'codex' } })
  const fs = fakeFs({
    '/opt/homebrew/bin/codex': '/opt/homebrew/Cellar/codex/0.161.0/libexec/lib/node_modules/@openai/codex/bin/codex.js',
  })
  assert.deepEqual(chooseCliUpdateCommand({ manifest: codex, resolvedPath: '/opt/homebrew/bin/codex', fs }), {
    kind: 'brew',
    command: 'brew upgrade codex',
  })
  const noFormula = manifest({ package: { npm: '@openai/codex' } })
  assert.equal(
    chooseCliUpdateCommand({ manifest: noFormula, resolvedPath: '/opt/homebrew/bin/codex', fs }),
    null,
    'npm is never pointed into a keg',
  )
})

test('pnpm, Bun, Volta and Yarn installs are left to the manager that made them', () => {
  const codex = manifest({ package: { npm: '@openai/codex', brew: 'codex' }, selfUpdate: { args: ['update'] } })
  const cases: Array<[string, string, string]> = [
    [
      '/Users/dev/Library/pnpm/codex',
      '/Users/dev/Library/pnpm/global/5/.pnpm/@openai+codex@0.161.0/node_modules/@openai/codex/bin/codex.js',
      'pnpm',
    ],
    ['/Users/dev/.bun/bin/codex', '/Users/dev/.bun/install/global/node_modules/@openai/codex/bin/codex.js', 'Bun'],
    [
      '/Users/dev/.volta/bin/codex',
      '/Users/dev/.volta/tools/image/packages/@openai/codex/lib/node_modules/@openai/codex/bin/codex.js',
      'Volta',
    ],
    ['/Users/dev/.yarn/bin/codex', '/Users/dev/.config/yarn/global/node_modules/@openai/codex/bin/codex.js', 'Yarn'],
  ]
  for (const [path, real, name] of cases) {
    assert.equal(foreignPackageManager(path, real), name)
    assert.equal(
      chooseCliUpdateCommand({ manifest: codex, resolvedPath: path, fs: fakeFs({ [path]: real }) }),
      null,
      name,
    )
  }
  assert.equal(foreignPackageManager('/Users/dev/.nvm/versions/node/v22/bin/codex', null), null)
})

test('a mise install is left to mise, and a global under a mise-managed Node to npm', () => {
  const codex = manifest({ package: { npm: '@openai/codex', brew: 'codex' }, selfUpdate: { args: ['update'] } })
  const cases: Array<[label: string, path: string, real: string]> = [
    [
      'a shim resolving to a Homebrew mise',
      '/Users/dev/.local/share/mise/shims/codex',
      '/opt/homebrew/Cellar/mise/2026.9.1/bin/mise',
    ],
    ['a shim under a custom data directory', '/Users/dev/tool-data/shims/codex', '/Users/dev/.local/bin/mise'],
    ['a Windows shim', 'C:\\Users\\dev\\AppData\\Local\\mise\\shims\\codex.cmd', 'C:\\Tools\\mise.exe'],
    [
      'the npm backend',
      '/Users/dev/.local/share/mise/installs/npm-openai-codex/0.161.0/bin/codex',
      '/Users/dev/.local/share/mise/installs/npm-openai-codex/0.161.0/lib/node_modules/@openai/codex/bin/codex.js',
    ],
    [
      'a tool alias backed by npm',
      '/Users/dev/.local/share/mise/installs/codex/0.161.0/bin/codex',
      '/Users/dev/.local/share/mise/installs/codex/0.161.0/lib/node_modules/@openai/codex/bin/codex.js',
    ],
  ]
  for (const [label, path, real] of cases) {
    assert.equal(foreignPackageManager(path, real), 'mise', label)
    assert.equal(
      chooseCliUpdateCommand({ manifest: codex, resolvedPath: path, fs: fakeFs({ [path]: real }) }),
      null,
      label,
    )
  }

  const nodePrefix = '/Users/dev/.local/share/mise/installs/node/24.13.0'
  const real = `${nodePrefix}/lib/node_modules/@openai/codex/bin/codex.js`
  assert.equal(foreignPackageManager(`${nodePrefix}/bin/codex`, real), null)
  assert.deepEqual(
    chooseCliUpdateCommand({
      manifest: codex,
      resolvedPath: `${nodePrefix}/bin/codex`,
      fs: fakeFs({ [`${nodePrefix}/bin/codex`]: real }),
    }),
    { kind: 'npm', command: `npm install -g --prefix ${nodePrefix} @openai/codex@latest` },
  )
  assert.equal(foreignPackageManager('/Users/dev/.local/bin/promise', null), null, 'a name ending in mise is not mise')
})

test('a Windows npm shim is npm’s when the package sits beside it', () => {
  const codex = manifest({ package: { npm: '@openai/codex' } })
  const shim = 'C:\\Users\\Dev User\\AppData\\Roaming\\npm\\codex.cmd'
  const fs = fakeFs({}, ['C:\\Users\\Dev User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\package.json'])
  assert.equal(npmGlobalPrefix(shim, '@openai/codex', fs), 'C:\\Users\\Dev User\\AppData\\Roaming\\npm')
  assert.deepEqual(chooseCliUpdateCommand({ manifest: codex, resolvedPath: shim, fs }), {
    kind: 'npm',
    command: "npm install -g --prefix 'C:\\Users\\Dev User\\AppData\\Roaming\\npm' @openai/codex@latest",
  })
  assert.equal(chooseCliUpdateCommand({ manifest: codex, resolvedPath: shim, fs: fakeFs({}) }), null)
})

test('a prefix with a space is quoted for the shell', () => {
  const codex = manifest({ package: { npm: '@openai/codex' } })
  const fs = fakeFs({
    '/Users/dev/my tools/bin/codex': '/Users/dev/my tools/lib/node_modules/@openai/codex/bin/codex.js',
  })
  assert.deepEqual(chooseCliUpdateCommand({ manifest: codex, resolvedPath: '/Users/dev/my tools/bin/codex', fs }), {
    kind: 'npm',
    command: "npm install -g --prefix '/Users/dev/my tools' @openai/codex@latest",
  })
})

test('on a machine whose files cannot be read, the CLI’s own updater comes before a guess at npm', () => {
  assert.deepEqual(chooseCliUpdateCommand({ manifest: grok, resolvedPath: '/home/dev/.grok/bin/grok', fs: null }), {
    kind: 'cli-updater',
    command: 'grok update',
  })
  const codex = manifest({ package: { npm: '@openai/codex', brew: 'codex' } })
  assert.deepEqual(chooseCliUpdateCommand({ manifest: codex, resolvedPath: '/usr/local/bin/codex', fs: null }), {
    kind: 'npm',
    command: 'npm install -g @openai/codex@latest',
  })
  assert.deepEqual(
    chooseCliUpdateCommand({ manifest: codex, resolvedPath: '/home/linuxbrew/.linuxbrew/bin/codex', fs: null }),
    { kind: 'brew', command: 'brew upgrade codex' },
  )
})

test('an advisory for a WSL machine never reads this machine’s files', async () => {
  let read = 0
  const fs: CliInstallFs = {
    realPath: () => {
      read += 1
      return null
    },
    exists: () => {
      read += 1
      return false
    },
  }
  const advisories = await resolveCliVersionAdvisories(
    { grok: { cli: 'grok', installed: true, resolvedPath: '/home/dev/.grok/bin/grok', version: 'grok 1.0.41' } },
    { hostId: 'wsl:Ubuntu', getManifest: () => grok, fetchLatest: async () => '1.0.52', fs },
  )
  assert.deepEqual(advisories.grok?.updateCommand, { kind: 'cli-updater', command: 'grok update' })
  assert.equal(read, 0)
})

test('a CLI WinGet installed gets no update command, not its own updater that cannot move it', () => {
  const claude = manifest({
    id: 'claude-code',
    binary: 'claude',
    update: { args: ['update'] },
    package: { npm: '@anthropic-ai/claude-code' },
  })
  const link = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
  const pkg =
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe'
  // WinGet's link, its package folder, and a native-looking alias that resolves into it.
  assert.equal(chooseCliUpdateCommand({ manifest: claude, resolvedPath: link, fs: fakeFs({ [link]: pkg }) }), null)
  assert.equal(chooseCliUpdateCommand({ manifest: claude, resolvedPath: pkg, fs: fakeFs({}, [pkg]) }), null)
  const alias = 'C:\\Users\\me\\.local\\bin\\claude.exe'
  assert.equal(chooseCliUpdateCommand({ manifest: claude, resolvedPath: alias, fs: fakeFs({ [alias]: pkg }) }), null)
  // A machine-wide install.
  const machine = 'C:\\Program Files\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe'
  assert.equal(chooseCliUpdateCommand({ manifest: claude, resolvedPath: machine, fs: fakeFs({}, [machine]) }), null)
  assert.equal(foreignPackageManager(link), 'WinGet')
  // The native install keeps the CLI's own updater.
  const native = 'C:\\Users\\me\\.local\\bin\\claude.exe'
  assert.deepEqual(chooseCliUpdateCommand({ manifest: claude, resolvedPath: native, fs: fakeFs({}, [native]) }), {
    kind: 'cli-updater',
    command: 'claude update',
  })
})
