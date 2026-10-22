import assert from 'node:assert/strict'
import { test } from 'vitest'

import { defaultAgent } from '../../shared/agent-state'
import { createArtifactPublishRoots } from './artifact-publish-roots'

test("a publishing agent may take files from its chat's folder, worktrees and the app's artifacts folder only", async () => {
  const worktreeAgent = defaultAgent('agent-wt')
  worktreeAgent.execution = { mode: 'worktree', worktreeId: 'wt-1', cwd: '/Users/dev/app-worktrees/stars' }
  const roots = createArtifactPublishRoots({
    findWorkspace: (id) =>
      id === 'ws-1'
        ? { folderPath: '/Users/dev/app', agents: { 'agent-1': defaultAgent('agent-1'), 'agent-wt': worktreeAgent } }
        : null,
    poolWorktrees: async () => [
      { path: '/Users/dev/pool/app/pool-1', lease: { workspaceId: 'ws-1', agentId: 'agent-1' } },
      { path: '/Users/dev/pool/app/pool-2', lease: { workspaceId: 'ws-2', agentId: 'agent-9' } },
      { path: '/Users/dev/pool/app/pool-3', lease: { workspaceId: 'ws-1', agentId: 'agent-wt' } },
      { path: '/Users/dev/pool/app/pool-4', lease: null },
    ],
    appDirs: ['/Users/dev/Library/Application Support/SprintEngine Studio/artifacts'],
  })
  const agent = (agentId: string) => ({ metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId } })

  assert.deepEqual(await roots(agent('agent-1')), [
    '/Users/dev/app',
    '/Users/dev/pool/app/pool-1',
    '/Users/dev/Library/Application Support/SprintEngine Studio/artifacts',
  ])
  assert.deepEqual(await roots(agent('agent-wt')), [
    '/Users/dev/app',
    '/Users/dev/app-worktrees/stars',
    '/Users/dev/pool/app/pool-3',
    '/Users/dev/Library/Application Support/SprintEngine Studio/artifacts',
  ])
  for (const context of [
    undefined,
    { metadata: { kind: 'external-local' as const } },
    { metadata: { kind: 'remote-tailnet' as const, deviceId: 'device-1' } },
    { metadata: { kind: 'studio-agent' as const } },
    { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-unknown', agentId: 'agent-1' } },
  ]) {
    assert.equal(await roots(context), null, JSON.stringify(context))
  }
})
