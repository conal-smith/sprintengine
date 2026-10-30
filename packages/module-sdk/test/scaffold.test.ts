// Every bundled template scaffolds into a project the app would accept, and
// that project's own dev loop runs end to end.
//
// For each template: scaffold into a temporary folder; validate the module
// manifest and plugin.json with this package's validators and the host API
// check; type-check the project against this package's SOURCE (a paths
// mapping, so the test never depends on dist/ being current); then run the
// project's real scripts — `npm run build`, `npm test` (the smoke test loads
// the built bundles against fake hosts), `npm run validate`, and
// `scripts/dev-install.mjs` into a throwaway module root — and check the
// installed copy carries a `files` map that matches it byte for byte.
//
// The projects resolve packages through one shared node_modules: the
// repository's own react, @types and esbuild, symlinked, plus this SDK
// transpiled from source into @sprintengine/module-sdk.
//
// Also: the scaffolder's refusals, the placeholder and tarball handling, the
// copies that must not drift — the build scripts the parts share with the
// templates — projects composed from parts (`parts`, `addModuleParts`) running
// the same loop, and a rebuild of unchanged code leaving the manifest alone.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { test } from 'vitest'

import { BUNDLED_MODULE_IDS, HOST_API_VERSION, KNOWN_CAPABILITY_PERMISSIONS } from '../src/index.js'
import { checkHostApiCompatibility } from '../src/host-api.js'
import { validateThirdPartyModuleManifest } from '../src/manifest-validate.js'
import { validateMarketplacePluginAuthoringManifest } from '../src/plugin-manifest.js'
import {
  addModuleParts,
  listModuleParts,
  listModuleTemplates,
  sanitizeDisplayText,
  scaffoldModuleProject,
} from '../src/scaffold.js'

const REPO = process.cwd()
const SDK = join(REPO, 'packages/module-sdk')
const TEMPLATES = join(SDK, 'templates')
const SDK_VERSION = '1.0.0-beta.1'

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(join(dir, entry.name), path) : [path]
  })
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed in ${cwd}:\n${output}`)
  return output
}

/** A node_modules the scaffolded projects resolve through. */
function sharedNodeModules(root: string): string {
  const nodeModules = join(root, 'node_modules')
  mkdirSync(join(nodeModules, '.bin'), { recursive: true })
  for (const name of ['react', 'react-dom', 'esbuild', '@types']) {
    symlinkSync(join(REPO, 'node_modules', name), join(nodeModules, name))
  }
  symlinkSync(join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild'), join(nodeModules, '.bin', 'esbuild'))

  // The SDK as a project installs it, transpiled from source: one file per
  // source file, so `./signing`, `./ui` and the CLI exist as they do in dist/.
  const sdkPackage = join(nodeModules, '@sprintengine', 'module-sdk')
  const sources = readdirSync(join(SDK, 'src')).filter((name) => name.endsWith('.ts'))
  buildSync({
    entryPoints: sources.map((name) => join(SDK, 'src', name)),
    outdir: join(sdkPackage, 'dist'),
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const sub = (name: string) => ({ default: `./dist/${name}.js` })
  writeFileSync(
    join(sdkPackage, 'package.json'),
    JSON.stringify({
      name: '@sprintengine/module-sdk',
      version: SDK_VERSION,
      type: 'module',
      main: './dist/index.js',
      exports: {
        '.': sub('index'),
        './signing': sub('signing'),
        './ui': sub('ui'),
        './surface': sub('surface'),
        './testing': sub('testing'),
        './testing/kit': sub('testing-kit'),
        './testing/register': sub('testing-register'),
      },
      bin: { 'sprintengine-module': './dist/cli.js' },
    }),
  )
  return nodeModules
}

/** Type-check a project against this package's source, tests included. */
function typecheckAgainstSource(dir: string, env: NodeJS.ProcessEnv): void {
  writeFileSync(
    join(dir, 'tsconfig.scaffold-test.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: {
        paths: {
          '@sprintengine/module-sdk': [join(SDK, 'src/index.ts')],
          '@sprintengine/module-sdk/ui': [join(SDK, 'src/ui.ts')],
          '@sprintengine/module-sdk/surface': [join(SDK, 'src/surface.ts')],
          '@sprintengine/module-sdk/testing': [join(SDK, 'src/testing.ts')],
          '@sprintengine/module-sdk/testing/kit': [join(SDK, 'src/testing-kit.ts')],
        },
      },
    }),
  )
  run(join(REPO, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.scaffold-test.json'], dir, env)
  rmSync(join(dir, 'tsconfig.scaffold-test.json'))
}

test('scaffold', async () => {
  const work = mkdtempSync(join(tmpdir(), 'sprintengine-scaffold-'))
  try {
    // ── The templates on offer ─────────────────────────────────────────────────
    const templates = listModuleTemplates(TEMPLATES)
    const templateIds = templates.map((template) => template.id)
    const dirs = readdirSync(TEMPLATES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
    assert.deepEqual([...templateIds].sort(), [...dirs].sort(), 'every template folder is listed, once')
    assert.equal(templateIds[0], 'blank', 'the empty starting point leads the picker')
    for (const expected of [
      'blank',
      'panel',
      'workspace-type',
      'global-surface',
      'top-bar-item',
      'settings-section',
      'mcp-tools',
      'chat-companion',
      'backlog-action',
      'file-action',
    ]) {
      assert.ok(templateIds.includes(expected), `template "${expected}" is missing`)
    }

    // ── Copies that must not drift ─────────────────────────────────────────────
    // A part that adds an entry builds it exactly as the templates do.
    const partScripts = (id: string) =>
      (
        JSON.parse(readFileSync(join(TEMPLATES, '_parts', id, 'part.json'), 'utf8')) as {
          scripts: Record<string, string>
        }
      ).scripts
    const companionScripts = (
      JSON.parse(readFileSync(join(TEMPLATES, 'chat-companion', 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    assert.equal(partScripts('renderer')['build:renderer'], companionScripts['build:renderer'])
    assert.equal(partScripts('main')['build:main'], companionScripts['build:main'])
    assert.deepEqual(
      listModuleParts(TEMPLATES).map((part) => part.id),
      ['main', 'mcp', 'settings', 'door'],
    )

    // ── Refusals ───────────────────────────────────────────────────────────────
    const base = { templateId: 'blank', displayName: 'X', sdkVersion: SDK_VERSION, templatesRoot: TEMPLATES }
    const refused = async (options: Partial<Parameters<typeof scaffoldModuleProject>[0]>, code: string) => {
      const result = await scaffoldModuleProject({ ...base, id: 'fine-id', dir: join(work, 'refused'), ...options })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, code, result.message)
    }
    await refused({ id: 'Not_Kebab' }, 'invalid_id')
    await refused({ id: BUNDLED_MODULE_IDS[0] }, 'invalid_id')
    await refused({ templateId: 'no-such-template' }, 'unknown_template')
    await refused({ templateId: '_shared' }, 'unknown_template')
    mkdirSync(join(work, 'occupied'))
    writeFileSync(join(work, 'occupied', 'keep.txt'), 'mine')
    await refused({ dir: join(work, 'occupied') }, 'dir_not_empty')
    const forced = await scaffoldModuleProject({ ...base, id: 'forced', dir: join(work, 'occupied'), force: true })
    assert.ok(forced.ok)
    assert.equal(readFileSync(join(work, 'occupied', 'keep.txt'), 'utf8'), 'mine', 'force leaves unrelated files')

    assert.equal(sanitizeDisplayText(` Bob's  "Big" {tool} <x> \`$y\\ `), 'Bob’s Big tool x y')

    // ── Every template ─────────────────────────────────────────────────────────
    const nodeModules = sharedNodeModules(work)
    const { SPRINTENGINE_SIGNING_KEY: _ownKey, ...inherited } = process.env
    const env = {
      ...inherited,
      PATH: `${join(nodeModules, '.bin')}:${process.env.PATH ?? ''}`,
      // Keep the dev loop away from the real ~/.sprintengine: no key is found,
      // and the install lands in a throwaway module root.
      HOME: join(work, 'home'),
      SPRINTENGINE_USER_MODULE_ROOT: join(work, 'installed'),
      npm_config_update_notifier: 'false',
    }

    for (const template of templates) {
      const id = `demo-${template.id}`
      const dir = join(work, template.id)
      const idea = template.id === 'panel' ? '# My idea\n\nA scratchpad.' : undefined
      const scaffolded = await scaffoldModuleProject({
        dir,
        templateId: template.id,
        id,
        displayName: `Demo's ${template.title}`,
        publisher: 'Acme',
        sdkVersion: SDK_VERSION,
        templatesRoot: TEMPLATES,
        ideaMarkdown: idea,
      })
      assert.ok(scaffolded.ok, scaffolded.ok ? '' : scaffolded.message)
      if (!scaffolded.ok) continue

      // The files, filled in.
      const files = walk(dir)
      assert.deepEqual(scaffolded.files, [...files].sort(), `${template.id}: the result lists what was written`)
      for (const required of [
        'package.json',
        'tsconfig.json',
        'plugin.json',
        'module/manifest.json',
        'IDEA.md',
        'AGENTS.md',
        'CLAUDE.md',
        '.gitignore',
        'test/smoke.test.mjs',
        'test/module.test.ts',
        'scripts/check-toolchain.mjs',
        'scripts/dev-install.mjs',
        'scripts/validate.mjs',
      ]) {
        assert.ok(files.includes(required), `${template.id}: ${required} is missing`)
      }
      assert.deepEqual(
        files.filter((path) => path.includes('skills/')),
        [],
        `${template.id}: a project carries no skill; the extension guide is the SDK's and Studio's`,
      )
      for (const file of files) {
        const text = readFileSync(join(dir, file), 'utf8')
        assert.ok(!/\{\{\w+\}\}/.test(text), `${template.id}: ${file} still has a placeholder`)
      }
      assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md')
      if (idea) assert.equal(readFileSync(join(dir, 'IDEA.md'), 'utf8'), `${idea}\n`)
      const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
      for (const pattern of ['node_modules/', 'packed/', '*.key', '*.pem', '.DS_Store']) {
        assert.ok(gitignore.includes(pattern), `${template.id}: .gitignore does not ignore ${pattern}`)
      }
      // A GitHub install reads the built module at a commit, so the build is
      // committed: nothing may ignore module/dist.
      const ignored = gitignore.split('\n').map((line) => line.trim())
      for (const line of ignored.filter((entry) => entry && !entry.startsWith('#'))) {
        assert.ok(!/(^|\/)dist\/?$/.test(line), `${template.id}: .gitignore ignores the built module (${line})`)
      }

      // The manifests, as the app reads them.
      const raw = JSON.parse(readFileSync(join(dir, 'module/manifest.json'), 'utf8'))
      const manifest = validateThirdPartyModuleManifest(raw)
      assert.ok(manifest.ok, `${template.id}: ${JSON.stringify(manifest.ok ? [] : manifest.issues)}`)
      assert.deepEqual(checkHostApiCompatibility(raw), { ok: true }, `${template.id}: host API`)
      assert.equal(raw.engines.hostApi, HOST_API_VERSION)
      assert.equal(raw.id, id)
      assert.equal(raw.displayName, `Demo’s ${template.title}`)
      assert.equal(raw.publisher, 'Acme')
      assert.equal(raw.source, 'third-party')
      assert.equal(raw.defaultEnabled, false)
      assert.deepEqual(raw.permissions, template.permissions, `${template.id}: template.json permissions`)
      for (const permission of raw.permissions) {
        assert.ok(KNOWN_CAPABILITY_PERMISSIONS.includes(permission), `${template.id}: unknown permission ${permission}`)
      }
      const plugin = validateMarketplacePluginAuthoringManifest(
        JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')),
      )
      assert.ok(plugin.ok, `${template.id}: ${JSON.stringify(plugin.ok ? [] : plugin.issues)}`)
      if (plugin.ok) {
        assert.equal(plugin.manifest.id, id)
        assert.deepEqual(plugin.manifest.permissions, raw.permissions, `${template.id}: plugin.json discloses the same`)
        assert.deepEqual(plugin.manifest.components, { module: { path: 'module' } })
      }
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], `^${SDK_VERSION}`)
      for (const script of ['typecheck', 'build', 'test', 'validate', 'check', 'dev:install', 'keygen']) {
        assert.ok(pkg.scripts[script], `${template.id}: package.json has no "${script}" script`)
      }

      typecheckAgainstSource(dir, env)

      // The project's own dev loop.
      run('npm', ['run', 'build', '--silent'], dir, env)
      // A rebuild of unchanged code leaves the committed manifest as it was.
      const manifestPath = join(dir, 'module/manifest.json')
      const firstBuild = { text: readFileSync(manifestPath, 'utf8'), mtime: statSync(manifestPath).mtimeMs }
      assert.match(run('npm', ['run', 'build'], dir, env), /already describes module\//)
      assert.equal(
        readFileSync(manifestPath, 'utf8'),
        firstBuild.text,
        `${template.id}: a rebuild rewrote the manifest`,
      )
      assert.equal(statSync(manifestPath).mtimeMs, firstBuild.mtime, `${template.id}: a rebuild touched the manifest`)
      // A build leaves the manifest describing module/ exactly, so the
      // repository can be committed and installed from GitHub as it stands.
      const built = JSON.parse(readFileSync(join(dir, 'module/manifest.json'), 'utf8'))
      assert.deepEqual(
        Object.keys(built.files ?? {}).sort(),
        walk(join(dir, 'module'))
          .filter((path) => path !== 'manifest.json')
          .sort(),
        `${template.id}: npm run build records the files digests`,
      )
      assert.doesNotMatch(
        run('npm', ['run', 'validate', '--silent'], dir, env),
        /changed since its "files" digests were written|no "files" digests/,
        `${template.id}: validate finds the build's digests current`,
      )
      run('npm', ['test', '--silent'], dir, env)
      run('npm', ['run', 'validate', '--silent'], dir, env)
      const installed = run(process.execPath, ['scripts/dev-install.mjs'], dir, env)
      assert.match(installed, new RegExp(`Installed ${id} v1 \\(unsigned`), installed)

      const installedDir = join(work, 'installed', id)
      const installedManifest = JSON.parse(readFileSync(join(installedDir, 'manifest.json'), 'utf8'))
      const entryFiles = Object.values(raw.entry as Record<string, string>)
      assert.deepEqual(
        Object.keys(installedManifest.files).sort(),
        walk(installedDir)
          .filter((path) => path !== 'manifest.json')
          .sort(),
        `${template.id}: the files map lists exactly what was installed`,
      )
      for (const entry of entryFiles) assert.match(installedManifest.files[entry], /^[a-f0-9]{64}$/)
      assert.equal(installedManifest.engines?.hostApi, HOST_API_VERSION)
      // The source manifest now carries the same map, and still validates.
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, 'module/manifest.json'), 'utf8')).files,
        installedManifest.files,
      )
      run('npm', ['run', 'validate', '--silent'], dir, env)
    }

    // ── Projects composed from parts ───────────────────────────────────────────
    // Every part on the smallest template, and a door added to a project with
    // no renderer at all: each runs the whole loop, its parts' tests included.
    const composed = join(work, 'composed')
    const scaffoldedComposed = await scaffoldModuleProject({
      dir: composed,
      templateId: 'blank',
      id: 'demo-composed',
      displayName: 'Composed',
      sdkVersion: SDK_VERSION,
      templatesRoot: TEMPLATES,
      parts: ['door', 'mcp', 'settings', 'main'],
    })
    assert.ok(scaffoldedComposed.ok, scaffoldedComposed.ok ? '' : scaffoldedComposed.message)
    const toolsDir = join(work, 'mcp-tools')
    const addedDoor = await addModuleParts({ dir: toolsDir, parts: ['door'], templatesRoot: TEMPLATES })
    assert.ok(addedDoor.ok, addedDoor.ok ? '' : addedDoor.message)
    assert.deepEqual(addedDoor.ok && addedDoor.added, ['renderer', 'door'])
    for (const dir of [composed, toolsDir]) {
      typecheckAgainstSource(dir, env)
      run('npm', ['run', 'build', '--silent'], dir, env)
      run('npm', ['test', '--silent'], dir, env)
      run('npm', ['run', 'validate', '--silent'], dir, env)
    }
    const composedTests = run('npm', ['test'], composed, env)
    for (const name of [
      'the door renders',
      'an agent can ask which extension this is',
      'the section shows what was saved',
    ]) {
      assert.ok(composedTests.includes(name), `the composed project ran "${name}"`)
    }
    assert.ok(composedTests.includes('door "demo-composed-door" renders'), 'the smoke test rendered the added door')
    const refusedPart = await scaffoldModuleProject({
      ...base,
      id: 'twice',
      dir: join(work, 'twice'),
      templateId: 'chat-companion',
      parts: ['main'],
    })
    assert.equal(!refusedPart.ok && refusedPart.code, 'already_present')
    assert.equal(existsSync(join(work, 'twice')), false, 'a refused part leaves no half-made project')

    // ── The smoke test catches what the old recording host let through ───────
    // A door that throws while rendering, and a service used without its
    // permission, both fail `npm test` now.
    const doorPath = join(composed, 'src', 'door.tsx')
    const door = readFileSync(doorPath, 'utf8')
    writeFileSync(doorPath, door.replace('function Door() {', "function Door() {\n  throw new Error('door exploded')"))
    run('npm', ['run', 'build', '--silent'], composed, env)
    const exploded = spawnSync('node', ['--test', 'test/smoke.test.mjs'], { cwd: composed, env, encoding: 'utf8' })
    assert.notEqual(exploded.status, 0)
    assert.match(exploded.stdout, /door "demo-composed-door" renders[\s\S]*door exploded/)
    writeFileSync(doorPath, door)
    const manifestPath = join(composed, 'module', 'manifest.json')
    const declared = readFileSync(manifestPath, 'utf8')
    const withoutBridge = JSON.parse(declared) as { permissions: string[] }
    withoutBridge.permissions = withoutBridge.permissions.filter((permission) => permission !== 'module:bridge')
    writeFileSync(manifestPath, JSON.stringify(withoutBridge, null, 2))
    run('npm', ['run', 'build', '--silent'], composed, env)
    const unbridged = spawnSync('node', ['--test', 'test/smoke.test.mjs'], { cwd: composed, env, encoding: 'utf8' })
    assert.notEqual(unbridged.status, 0)
    assert.match(unbridged.stdout, /needs the "module:bridge" permission/)
    writeFileSync(manifestPath, declared)

    // ── A local SDK tarball instead of the npm release ─────────────────────────
    const tarball = join(work, 'sprintengine-module-sdk-9.9.9.tgz')
    writeFileSync(tarball, 'not really a tarball')
    const local = await scaffoldModuleProject({
      ...base,
      id: 'local-sdk',
      dir: join(work, 'local'),
      sdkTarballPath: tarball,
    })
    assert.ok(local.ok)
    assert.ok(existsSync(join(work, 'local/vendor/sprintengine-module-sdk-9.9.9.tgz')))
    const localPkg = JSON.parse(readFileSync(join(work, 'local/package.json'), 'utf8'))
    assert.equal(localPkg.devDependencies['@sprintengine/module-sdk'], 'file:vendor/sprintengine-module-sdk-9.9.9.tgz')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
