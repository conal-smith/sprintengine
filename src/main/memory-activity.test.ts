// The knowledge-activity hook on this machine: the opt-in and the trace live in
// the workspace's store under the home, and the hook rides the launch's own
// settings, so a repository that turned it on holds none of it.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', async () => {
  const stub = await import('../../tests/stubs/electron')
  return {
    ...stub,
    app: { isPackaged: false, getPath: () => userData.dir, getAppPath: () => process.cwd() },
  }
})

const { workspaceStorePath } = await import('./workspace-store')
const {
  installMemoryActivityHook,
  isMemoryActivityInstalled,
  knowledgeActivityLaunchCommand,
  uninstallMemoryActivityHook,
} = await import('./memory-activity')

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'se-memory-activity-'))
  userData.dir = join(root, 'userData')
  await mkdir(userData.dir, { recursive: true })
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  return workspace
}

test('turning it on writes nothing into the workspace, and the launch is handed the hook', async () => {
  const workspace = await fixture()
  const installed = await installMemoryActivityHook(workspace, 'docs/knowledge')
  assert.equal(installed.ok, true)
  assert.equal(existsSync(join(workspace, '.claude')), false)
  assert.equal(existsSync(join(workspace, '.sprintengine')), false)
  assert.equal(await isMemoryActivityInstalled(workspace), true)

  const command = await knowledgeActivityLaunchCommand(workspace)
  assert.ok(command?.includes('--knowledge-root'), command ?? 'no command')
  assert.ok(command?.includes('docs/knowledge'))
  assert.ok(command?.includes('--trace-dir'))
  assert.ok(
    command?.includes(workspaceStorePath(workspace, 'knowledge-trace').split('\\').join('/')),
    command ?? 'no command',
  )

  assert.equal((await uninstallMemoryActivityHook(workspace)).ok, true)
  assert.equal(await knowledgeActivityLaunchCommand(workspace), null)
  assert.equal(await isMemoryActivityInstalled(workspace), false)
})

test('a workspace an earlier build registered moves on its next launch, and its entry leaves the settings', async () => {
  const workspace = await fixture()
  await mkdir(join(workspace, '.claude'), { recursive: true })
  await writeFile(
    join(workspace, '.claude', 'settings.local.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Read|Edit|Write',
            hooks: [
              {
                type: 'command',
                command:
                  "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' knowledge-activity --knowledge-root 'notes'",
                _sprintengine: 'sprintengine-knowledge-activity',
              },
            ],
          },
        ],
      },
    }),
  )
  await mkdir(join(workspace, '.sprintengine', 'hooks'), { recursive: true })
  await writeFile(
    join(workspace, '.sprintengine', 'hooks', 'installed.json'),
    JSON.stringify({ memoryRelativeRoot: 'notes', tag: 'sprintengine-knowledge-activity' }),
  )

  const command = await knowledgeActivityLaunchCommand(workspace)
  assert.ok(command?.includes('notes'), command ?? 'no command')
  const settings = JSON.parse(await readFile(join(workspace, '.claude', 'settings.local.json'), 'utf8'))
  assert.deepEqual(settings, { permissions: { allow: ['Bash(ls:*)'] } })
  assert.equal(existsSync(join(workspace, '.sprintengine')), false, 'the record and its folder are gone')
  assert.equal(await isMemoryActivityInstalled(workspace), true, 'the choice survived the move')
})
