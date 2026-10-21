// A plugin's own directory, copied into a workspace and taken back out
// (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SKILL_INSTALL_MAX_FILES, DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES } from './install'
import {
  LEGACY_PLUGIN_WORKSPACE_DIR,
  PLUGIN_PROVENANCE_FILE,
  installPluginDirectory,
  pluginDirectoryName,
  pluginDirectoryPath,
  readPluginDirectoryProvenance,
  uninstallPluginDirectory,
} from './plugin-directory'
import { workspaceStorePath } from '../workspace-store'
import { test } from 'vitest'

test('plugin-directory', async () => {
  const TELEGRAM = [
    { path: '.claude-plugin/plugin.json', size: 294 },
    { path: '.mcp.json', size: 166 },
    { path: '.npmrc', size: 37 },
    { path: 'package.json', size: 307 },
    { path: 'server.ts', size: 40358 },
    { path: 'skills/access/SKILL.md', size: 4463 },
  ]

  const READ = async (file: { path: string }): Promise<Buffer> => Buffer.from(`bytes of ${file.path}\n`, 'utf8')

  async function workspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'sprintengine-plugin-dir-'))
  }

  /** The whole directory lands, subdirectories and dotfiles included, with provenance. */
  async function theWholeDirectoryLands(): Promise<void> {
    const root = await workspace()
    const result = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: TELEGRAM,
      readFile: READ,
      provenance: { sourceId: 'github:anthropics/claude-plugins-official', pluginId: 'telegram', commitSha: '85cce03' },
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.root, pluginDirectoryPath(root, 'telegram'))
    assert.equal(result.dirName, 'telegram')
    assert.equal(result.fileCount, TELEGRAM.length)
    for (const file of TELEGRAM) {
      assert.equal(existsSync(join(result.root, ...file.path.split('/'))), true, `${file.path} landed`)
    }
    assert.equal(
      await readFile(join(result.root, 'package.json'), 'utf8'),
      'bytes of package.json\n',
      'the bytes are the source’s, not a placeholder',
    )
    const provenance = await readPluginDirectoryProvenance(result.root)
    assert.deepEqual(provenance, {
      sourceId: 'github:anthropics/claude-plugins-official',
      pluginId: 'telegram',
      commitSha: '85cce03',
    })
  }

  /** Reinstalling from the same source replaces the copy and leaves no stale file. */
  async function reinstallingReplacesRatherThanMerges(): Promise<void> {
    const root = await workspace()
    const provenance = { sourceId: 's', pluginId: 'telegram', commitSha: 'one' }
    const first = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: [...TELEGRAM, { path: 'withdrawn.ts', size: 1 }],
      readFile: READ,
      provenance,
    })
    assert.equal(first.ok, true)
    const second = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: TELEGRAM,
      readFile: READ,
      provenance: { ...provenance, commitSha: 'two' },
    })
    assert.equal(second.ok, true)
    if (!second.ok) return
    assert.equal(
      existsSync(join(second.root, 'withdrawn.ts')),
      false,
      'a file the plugin dropped is gone, not left behind for the server to load',
    )
    assert.equal((await readPluginDirectoryProvenance(second.root))?.commitSha, 'two')
  }

  /** Someone else's directory of the same name is never written over. */
  async function anotherOwnersDirectoryIsRefusedNotOverwritten(): Promise<void> {
    const root = await workspace()
    const target = pluginDirectoryPath(root, 'telegram')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'mine.txt'), 'hand made', 'utf8')

    const unmarked = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: TELEGRAM,
      readFile: READ,
      provenance: { sourceId: 's', pluginId: 'telegram', commitSha: '' },
    })
    assert.equal(unmarked.ok, false)
    assert.equal(existsSync(join(target, 'mine.txt')), true, 'the files that were there are still there')

    await writeFile(
      join(target, PLUGIN_PROVENANCE_FILE),
      JSON.stringify({ sourceId: 'other', pluginId: 'telegram', commitSha: '' }),
      'utf8',
    )
    const foreign = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: TELEGRAM,
      readFile: READ,
      provenance: { sourceId: 's', pluginId: 'telegram', commitSha: '' },
    })
    assert.equal(foreign.ok, false)
    if (foreign.ok) return
    assert.ok(foreign.message.includes('another source'), foreign.message)
  }

  /** The caps that guard skill installs guard this, and they are the same numbers. */
  async function theSkillInstallCapsApply(): Promise<void> {
    const root = await workspace()
    const tooMany = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: Array.from({ length: DEFAULT_SKILL_INSTALL_MAX_FILES + 1 }, (_, index) => ({
        path: `f${index}.txt`,
        size: 1,
      })),
      readFile: READ,
      provenance: { sourceId: 's', pluginId: 'telegram', commitSha: '' },
    })
    assert.equal(tooMany.ok, false)
    if (tooMany.ok) return
    assert.ok(tooMany.message.includes(String(DEFAULT_SKILL_INSTALL_MAX_FILES)), tooMany.message)
    assert.equal(existsSync(pluginDirectoryPath(root, 'telegram')), false, 'nothing was written')

    const tooBig = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: [{ path: 'big.bin', size: 0 }],
      readFile: async () => Buffer.alloc(64),
      provenance: { sourceId: 's', pluginId: 'telegram', commitSha: '' },
      maxTotalBytes: 32,
    })
    assert.equal(tooBig.ok, false)
    if (tooBig.ok) return
    assert.ok(tooBig.message.includes('larger than 32 bytes'), tooBig.message)
    assert.equal(
      existsSync(pluginDirectoryPath(root, 'telegram')),
      false,
      'the overflow was caught in staging, so no half-plugin reached the workspace',
    )
    assert.equal(DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES, 50 * 1024 * 1024, 'the default is the skill installer’s own')
  }

  /** A file path that climbs out of the plugin stops the install; it is not sanitised. */
  async function anEscapingPathStopsTheInstall(): Promise<void> {
    const root = await workspace()
    for (const path of ['../../.claude/settings.json', '/etc/passwd', 'a/../../b']) {
      const result = await installPluginDirectory({
        workspaceRoot: root,
        pluginId: 'telegram',
        files: [{ path, size: 1 }],
        readFile: READ,
        provenance: { sourceId: 's', pluginId: 'telegram', commitSha: '' },
      })
      assert.equal(result.ok, false, `${path} was refused`)
    }
    assert.equal(existsSync(join(root, '.claude')), false)
  }

  /** A plugin id that cannot make one path segment gets no directory at all. */
  function anUnusableIdIsRefused(): void {
    assert.equal(pluginDirectoryName('telegram'), 'telegram')
    assert.equal(pluginDirectoryName('external_plugins/telegram'), 'telegram')
    assert.equal(pluginDirectoryName('..'), '')
    assert.equal(pluginDirectoryName(''), '')
    assert.equal(pluginDirectoryName('a\\b'), '')
    assert.equal(pluginDirectoryPath('/w', '..'), '')
    // In the workspace's store, never the repository.
    assert.equal(pluginDirectoryPath('/w', 'telegram'), workspaceStorePath('/w', 'claude-plugins', 'telegram'))
  }

  /** Remove takes the directory back out, and says nothing went when nothing was there. */
  async function removeTakesItBackOut(): Promise<void> {
    const root = await workspace()
    const installed = await installPluginDirectory({
      workspaceRoot: root,
      pluginId: 'telegram',
      files: TELEGRAM,
      readFile: READ,
      provenance: { sourceId: 's', pluginId: 'telegram', commitSha: '' },
    })
    assert.equal(installed.ok, true)
    const removed = await uninstallPluginDirectory({ workspaceRoot: root, pluginId: 'telegram' })
    assert.equal(removed.ok, true)
    if (!removed.ok) return
    assert.deepEqual(removed.removedPaths, [pluginDirectoryPath(root, 'telegram')])
    assert.equal(existsSync(pluginDirectoryPath(root, 'telegram')), false)

    const again = await uninstallPluginDirectory({ workspaceRoot: root, pluginId: 'telegram' })
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.deepEqual(again.removedPaths, [], 'already gone is not a failure')
  }

  /** A plugin an earlier build installed inside the workspace is still found, and taken out. */
  async function anEarlierInstallInTheWorkspaceIsRemoved(): Promise<void> {
    const root = await workspace()
    const legacy = join(root, LEGACY_PLUGIN_WORKSPACE_DIR, 'telegram')
    await mkdir(legacy, { recursive: true })
    await writeFile(
      join(legacy, PLUGIN_PROVENANCE_FILE),
      JSON.stringify({ sourceId: 's', pluginId: 'telegram', commitSha: '' }),
      'utf8',
    )
    const removed = await uninstallPluginDirectory({ workspaceRoot: root, pluginId: 'telegram' })
    assert.equal(removed.ok, true)
    if (!removed.ok) return
    assert.deepEqual(removed.removedPaths, [legacy])
    assert.equal(existsSync(legacy), false)
  }

  /** A directory that now holds a different plugin is reported, not deleted. */
  async function aDirectoryThatMovedOnIsLeftAlone(): Promise<void> {
    const root = await workspace()
    const target = pluginDirectoryPath(root, 'telegram')
    await mkdir(target, { recursive: true })
    await writeFile(
      join(target, PLUGIN_PROVENANCE_FILE),
      JSON.stringify({ sourceId: 's', pluginId: 'discord', commitSha: '' }),
      'utf8',
    )
    const removed = await uninstallPluginDirectory({ workspaceRoot: root, pluginId: 'telegram' })
    assert.equal(removed.ok, true)
    if (!removed.ok) return
    assert.deepEqual(removed.removedPaths, [])
    assert.equal(removed.warnings.length, 1)
    assert.equal(existsSync(target), true)
  }

  async function main(): Promise<void> {
    await theWholeDirectoryLands()
    await reinstallingReplacesRatherThanMerges()
    await anotherOwnersDirectoryIsRefusedNotOverwritten()
    await theSkillInstallCapsApply()
    await anEscapingPathStopsTheInstall()
    anUnusableIdIsRefused()
    await removeTakesItBackOut()
    await anEarlierInstallInTheWorkspaceIsRemoved()
    await aDirectoryThatMovedOnIsLeftAlone()
    console.log('plugin directory tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
