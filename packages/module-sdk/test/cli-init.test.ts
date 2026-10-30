// `sprintengine-module init`: the command-line door into the scaffolder the
// app's "Build your own extension" flow also uses.
//
// The CLI runs as a real subprocess, bundled from source. The bundle is
// CommonJS, where `import.meta.url` does not exist, so it is pinned to the
// scaffolder's source file: the templates and the package version
// then resolve from this package exactly as they do from `dist/`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, test } from 'vitest'

const SDK = join(process.cwd(), 'packages/module-sdk')
const SDK_VERSION = (JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')) as { version: string }).version

let workDir = ''
let cliBundle = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-init-'))
  cliBundle = join(workDir, 'sprintengine-module.cjs')
  buildSync({
    entryPoints: [join(SDK, 'src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: cliBundle,
    logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(SDK, 'src/scaffold.ts')).href) },
  })
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliBundle, ...args], {
    cwd: workDir,
    encoding: 'utf8',
  })
  return { status, stdout, stderr }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('sprintengine-module init', () => {
  test('scaffolds a template, taking the id from the folder name', () => {
    const dir = join(workDir, 'Focus Notes')
    const run = runCli(['init', dir, '--template', 'panel'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /Created focus-notes from the panel template/)

    const manifest = readJson(join(dir, 'module', 'manifest.json'))
    assert.equal(manifest.id, 'focus-notes')
    assert.equal(manifest.displayName, 'Focus Notes')
    const pkg = readJson(join(dir, 'package.json')) as { devDependencies: Record<string, string> }
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], `^${SDK_VERSION}`)
    assert.equal(existsSync(join(dir, '.gitignore')), true)
  })

  test('takes --id and --name, and depends on a local tarball when given one', () => {
    const tarball = join(workDir, 'sprintengine-module-sdk-9.9.9.tgz')
    writeFileSync(tarball, 'not really a tarball')
    const dir = join(workDir, 'named')
    const run = runCli([
      'init',
      dir,
      '--template',
      'blank',
      '--id',
      'pomodoro',
      '--name',
      'Pomodoro timer',
      '--sdk-tarball',
      tarball,
    ])
    assert.equal(run.status, 0, run.stderr)
    const manifest = readJson(join(dir, 'module', 'manifest.json'))
    assert.equal(manifest.id, 'pomodoro')
    assert.equal(manifest.displayName, 'Pomodoro timer')
    const pkg = readJson(join(dir, 'package.json')) as { devDependencies: Record<string, string> }
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], 'file:vendor/sprintengine-module-sdk-9.9.9.tgz')
    assert.equal(existsSync(join(dir, 'vendor', 'sprintengine-module-sdk-9.9.9.tgz')), true)
  })

  test('without --template, or with an unknown one, it lists the templates', () => {
    const missing = runCli(['init', join(workDir, 'no-template')])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /requires --template/)
    assert.match(missing.stderr, /panel {2,}/)

    const unknown = runCli(['init', join(workDir, 'unknown'), '--template', 'spreadsheet'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /no "spreadsheet" template/)
    assert.match(unknown.stderr, /global-surface {2,}/)
    assert.equal(existsSync(join(workDir, 'unknown')), false)
  })

  test('refuses a folder with files in it unless --force, and a reserved id', () => {
    const dir = join(workDir, 'occupied')
    mkdirSync(dir)
    writeFileSync(join(dir, 'notes.txt'), 'mine')
    const refused = runCli(['init', dir, '--template', 'blank'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /already has files in it/)

    const forced = runCli(['init', dir, '--template', 'blank', '--force'])
    assert.equal(forced.status, 0, forced.stderr)
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine')

    const reserved = runCli(['init', join(workDir, 'reserved'), '--template', 'blank', '--id', 'backlog'])
    assert.equal(reserved.status, 1)
    assert.match(reserved.stderr, /reserved/)
  })

  test('carries no skill: its agent instructions send the agent to the extension guide', () => {
    const dir = join(workDir, 'no-skill')
    assert.equal(runCli(['init', dir, '--template', 'blank']).status, 0)
    assert.equal(existsSync(join(dir, '.agents')), false)
    assert.equal(existsSync(join(dir, '.claude')), false)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.match(agents, /`extension\.guide`/)
    assert.match(agents, /node_modules\/@sprintengine\/module-sdk\/guide\//)
  })

  test('--with adds parts on top of the template', () => {
    const dir = join(workDir, 'composed')
    const run = runCli(['init', dir, '--template', 'global-surface', '--with', 'main,mcp', '--with', 'settings'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /from the global-surface template with main, mcp, settings/)
    const manifest = readJson(join(dir, 'module', 'manifest.json')) as {
      entry: Record<string, string>
      permissions: string[]
      dependsOn: string[]
    }
    assert.deepEqual(manifest.entry, { renderer: 'dist/renderer.mjs', main: 'dist/main.cjs' })
    assert.deepEqual(manifest.permissions, ['ipc:workspace-read', 'mcp:tools', 'storage', 'module:bridge'])
    assert.deepEqual(manifest.dependsOn, ['agent-runtime'])
    const plugin = readJson(join(dir, 'plugin.json')) as { permissions: string[] }
    assert.deepEqual(plugin.permissions, manifest.permissions, 'the bundle discloses the same')
    const pkg = readJson(join(dir, 'package.json')) as { scripts: Record<string, string> }
    assert.match(pkg.scripts['build:main'] ?? '', /esbuild src\/main\.ts/)
    const main = readFileSync(join(dir, 'src', 'main.ts'), 'utf8')
    assert.match(main, /import \{ registerTools \} from '\.\/mcp-tools'/)
    assert.match(main, /=> \{\n {2}registerTools\(host\)\n/)
    assert.match(readFileSync(join(dir, 'src', 'renderer.tsx'), 'utf8'), /registerSettings\(host\)/)
    for (const test of ['test/main.test.ts', 'test/mcp-tools.test.ts', 'test/settings.test.ts']) {
      assert.equal(existsSync(join(dir, test)), true, `${test} comes with its part`)
    }
  })

  test('add puts a part into an existing project, and refuses what it already has', () => {
    const dir = join(workDir, 'tools-then-door')
    assert.equal(runCli(['init', dir, '--template', 'mcp-tools']).status, 0)
    const added = runCli(['add', 'door', '--project', dir])
    assert.equal(added.status, 0, added.stderr)
    assert.match(added.stdout, /Added renderer, door/)
    const manifest = readJson(join(dir, 'module', 'manifest.json')) as {
      entry: Record<string, string>
      permissions: string[]
    }
    assert.deepEqual(manifest.entry, { main: 'dist/main.cjs', renderer: 'dist/renderer.mjs' })
    assert.deepEqual(manifest.permissions, ['mcp:tools', 'ipc:workspace-read'], 'no bridge: main registers no channels')
    assert.match(readFileSync(join(dir, 'src', 'renderer.tsx'), 'utf8'), /registerDoor\(host\)/)
    const pkg = readJson(join(dir, 'package.json')) as { devDependencies: Record<string, string> }
    assert.ok(pkg.devDependencies.react && pkg.devDependencies['react-dom'], 'a renderer brings React')

    const again = runCli(['add', 'main', '--project', dir])
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already has entry\.main/)
    const clash = runCli(['add', 'door', '--project', dir])
    assert.equal(clash.status, 1)
    assert.match(clash.stderr, /already in the project: src\/door\.tsx/)
    const unknown = runCli(['add', 'spreadsheet', '--project', dir])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /no "spreadsheet" part/)
    assert.match(unknown.stderr, /settings {2,}/)
    const none = runCli(['add', '--project', dir])
    assert.equal(none.status, 1)
    assert.match(none.stderr, /door {2,}/)
    assert.equal(runCli(['add', 'door', '--project', join(workDir, 'nowhere')]).status, 1)
  })
})
