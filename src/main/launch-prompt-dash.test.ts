import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { emptyAgentLaunchSettings } from '../shared/launch-settings'
import type { TerminalSpawnPayload } from './ipc/terminal-ipc'
import { planAgentLaunch, renderAgentLaunchArgv } from './agent-launch-render'
import { LAUNCH_ARG_BUDGETS } from './launch-arg-budget'
import { createAgentLaunchService } from './agent-launch-service'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'

// A first message that begins with `-` must never reach a CLI's option parser:
// the manifests that can carry `--` put it in front of the prompt, and every
// other render, and every launch door, refuses the message.

beforeAll(() => {
  const registry = createPluginRegistry({ bundledRoot: join(process.cwd(), 'resources/plugins') })
  const report = registry.loadSync()
  assert.deepEqual(report.rejected, [])
  __setPluginRegistryForTest(registry, report)
})
afterAll(() => __resetPluginRegistryForTest())

const DASHED = '--permission-mode=bypassPermissions'

test('a dashed prompt renders after `--` for every CLI whose manifest carries one', () => {
  for (const cli of ['claude-code', 'zai', 'kimi-claude', 'codex', 'cursor', 'grok']) {
    for (const resume of cli === 'codex' || cli === 'cursor' || cli === 'grok' ? [false] : [false, true]) {
      const { argv } = renderAgentLaunchArgv({ cli, sessionId: 'sid_dash', resume, initialPrompt: DASHED })
      const at = argv.lastIndexOf(DASHED)
      assert.notEqual(at, -1, `${cli}: the prompt is on the command line`)
      assert.equal(argv[at - 1], '--', `${cli}${resume ? ' resume' : ''}: the prompt follows the separator`)
    }
  }
})

test('a dashed prompt with no `--` in front of it is refused by the render', () => {
  assert.throws(
    () => renderAgentLaunchArgv({ cli: 'opencode', sessionId: 'sid_dash', initialPrompt: `  ${DASHED}` }),
    /begins with a dash/u,
  )
  assert.throws(
    () =>
      planAgentLaunch(
        { cli: 'opencode', sessionId: 'sid_dash', initialPrompt: DASHED },
        { budget: LAUNCH_ARG_BUDGETS.darwin },
      ),
    /begins with a dash/u,
  )
  // An ordinary message, and one with a dash later on, render as they always did.
  const plain = renderAgentLaunchArgv({ cli: 'opencode', sessionId: 'sid_dash', initialPrompt: 'fix it - now' })
  assert.equal(plain.argv.at(-1), 'fix it - now')
})

test('the launch service refuses a dashed prompt before anything is spawned', async () => {
  const spawns: TerminalSpawnPayload[] = []
  const service = createAgentLaunchService({
    listWorkspaces: () => [{ id: 'ws-1', mode: 'standard', folderPath: '/repo/a', agents: {} }],
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    terminal: {
      list: () => [],
      spawn: async (payload) => {
        spawns.push(payload)
        return { ok: true, sessionId: payload.sessionId }
      },
      kill: () => undefined,
    },
    newSessionId: () => 'session-minted',
    newAgentSuffix: () => 'abc123',
  })

  const refused = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: ` ${DASHED}` })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.code, 'prompt_reads_as_option')
  assert.equal(spawns.length, 0)

  const launched = await service.launch({ workspaceId: 'ws-1', cli: 'claude-code', prompt: 'fix the parser' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.equal(spawns.length, 1)
})
