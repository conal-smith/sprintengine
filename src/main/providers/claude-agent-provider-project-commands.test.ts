import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './mock-conversation-provider'

// A Claude chat loads the person's settings only, so a project's own
// `.claude/commands` reach its child as a staged plugin named `project`
// (claude-project-commands.ts), kept current between messages.

type Plugin = { type: string; path: string }

/** A stand-in SDK whose queries answer every prompt with a result. */
function harness(tempDir: string, options: { reloads?: boolean } = {}) {
  const spawns: Array<Record<string, unknown>> = []
  // What each reload found in the staged commands folder.
  const reloads: string[][] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    spawns.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'system', subtype: 'init', session_id: 'native', slash_commands: [] })
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native' })
        wake?.()
      }
    })()
    const plugins = (params.options.plugins as Plugin[] | undefined) ?? []
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
      ...(options.reloads === false
        ? {}
        : {
            reloadPlugins: async () => {
              reloads.push(await readdir(join(plugins[0]!.path, 'commands')))
              return { commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 }
            },
          }),
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    tempDir,
  })
  return { adapter, spawns, reloads }
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function workspace(commands: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'claude-project-commands-provider-'))
  roots.push(root)
  const workspaceRoot = join(root, 'app')
  const tempDir = join(root, 'tmp')
  await mkdir(join(workspaceRoot, '.claude', 'commands'), { recursive: true })
  await mkdir(tempDir)
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(workspaceRoot, '.claude', 'commands', path, '..'), { recursive: true })
      await writeFile(join(workspaceRoot, '.claude', 'commands', path), text)
    }
  }
  await write(commands)
  const turn = (turnId: string): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot,
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
  })
  return { workspaceRoot, tempDir, turn, write }
}

async function drain(stream: AsyncIterable<ConversationEvent> | ConversationEvent[]): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const pluginsOf = (options: Record<string, unknown> | undefined) => (options?.plugins as Plugin[] | undefined) ?? []

test("a chat's child is given the project's commands as a plugin named project, under the user settings alone", async () => {
  const f = await workspace({
    'deploy.md': '---\ndescription: Ship it\nallowed-tools: Bash(npm run deploy:*)\n---\nDeploy.',
    'frontend/component.md': 'Make a component.',
  })
  const { adapter, spawns } = harness(f.tempDir)
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    assert.deepEqual(spawns[0]?.settingSources, ['user'])
    const plugins = pluginsOf(spawns[0])
    assert.equal(plugins.length, 1)
    assert.ok(plugins[0]!.path.startsWith(f.tempDir), 'staged outside the project')
    assert.match(await readFile(join(plugins[0]!.path, '.claude-plugin', 'plugin.json'), 'utf8'), /"name":"project"/)
    assert.equal(
      await readFile(join(plugins[0]!.path, 'commands', 'deploy.md'), 'utf8'),
      '---\ndescription: Ship it\n---\nDeploy.',
    )
    assert.equal(
      await readFile(join(plugins[0]!.path, 'commands', 'frontend', 'component.md'), 'utf8'),
      'Make a component.',
    )
    assert.deepEqual(await readdir(join(f.workspaceRoot, '.claude')), ['commands'])
  } finally {
    await adapter.disposeAll()
  }
})

test('a project without commands starts its child with no plugin', async () => {
  const f = await workspace({})
  const { adapter, spawns } = harness(f.tempDir)
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    assert.equal(spawns[0]?.plugins, undefined)
    assert.deepEqual(await readdir(f.tempDir), [])
  } finally {
    await adapter.disposeAll()
  }
})

test("the project's commands plugin is removed with its child", async () => {
  const f = await workspace({ 'deploy.md': 'Deploy.' })
  const { adapter } = harness(f.tempDir)
  await adapter.startSession(f.turn('turn_1'))
  await drain(await adapter.sendTurn(f.turn('turn_1')))
  assert.equal((await readdir(f.tempDir)).length, 1)
  await adapter.disposeAll()
  assert.deepEqual(await readdir(f.tempDir), [])
})

test('a command changed between messages is rewritten into the same child and reloaded', async () => {
  const f = await workspace({ 'deploy.md': 'Deploy.' })
  const { adapter, spawns, reloads } = harness(f.tempDir)
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    // Unchanged: nothing is rewritten or reloaded.
    await drain(await adapter.sendTurn(f.turn('turn_2')))
    assert.deepEqual(reloads, [])
    await f.write({ 'deploy.md': 'Deploy to staging.', 'release.md': 'Release.' })
    await drain(await adapter.sendTurn(f.turn('turn_3')))
    assert.equal(spawns.length, 1)
    assert.deepEqual(reloads, [['deploy.md', 'release.md']])
    const staged = pluginsOf(spawns[0])[0]!.path
    assert.equal(await readFile(join(staged, 'commands', 'deploy.md'), 'utf8'), 'Deploy to staging.')
  } finally {
    await adapter.disposeAll()
  }
})

test('commands added to a project whose child started without any replace the child, which resumes', async () => {
  const f = await workspace({})
  const { adapter, spawns } = harness(f.tempDir)
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    assert.equal(spawns[0]?.plugins, undefined)
    await f.write({ 'deploy.md': 'Deploy.' })
    await drain(await adapter.sendTurn(f.turn('turn_2')))
    assert.equal(spawns.length, 2)
    assert.equal(spawns[1]?.resume, 'native')
    const staged = pluginsOf(spawns[1])[0]!.path
    assert.deepEqual(await readdir(join(staged, 'commands')), ['deploy.md'])
  } finally {
    await adapter.disposeAll()
  }
})

test('a Claude Code that cannot reload its plugins is replaced with one that has the new commands', async () => {
  const f = await workspace({ 'deploy.md': 'Deploy.' })
  const { adapter, spawns } = harness(f.tempDir, { reloads: false })
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    await f.write({ 'deploy.md': 'Deploy to staging.' })
    await drain(await adapter.sendTurn(f.turn('turn_2')))
    assert.equal(spawns.length, 2)
    const staged = pluginsOf(spawns[1])[0]!.path
    assert.equal(await readFile(join(staged, 'commands', 'deploy.md'), 'utf8'), 'Deploy to staging.')
    // The first child's folder went with it.
    assert.equal((await readdir(f.tempDir)).length, 1)
  } finally {
    await adapter.disposeAll()
  }
})
