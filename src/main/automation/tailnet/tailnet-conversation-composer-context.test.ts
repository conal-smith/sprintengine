import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import type { ConversationCommandCatalog } from '../../../shared/conversation/commands'
import type { FileSearchResult } from '../../../shared/ipc/filesystem'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationRegistryLink } from './tailnet-conversation-host'

// A paired desktop's composer reaching a chat's folder here: what its @
// searches (`conversation-file-search`), the mentions its send names
// (`conversation-send-mentions`), and the `/` list (`conversation-commands`),
// each read in the chat's own folder and nowhere else.

async function fixture(options: { providerId?: string; start?: boolean; registry?: ConversationRegistryLink } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-composer-context-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = { ...createMockConversationProvider(), ...(options.providerId ? { id: options.providerId } : {}) }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    options.registry ?? {},
  )
  const started =
    options.start === false
      ? null
      : await runtime.startSession({
          ...key,
          providerId: adapter.id,
          modelId: adapter.listModels()[0]!,
          permissionPreset: 'bypass',
        })
  if (started) assert.ok(started.ok)
  return {
    key,
    host,
    runtime,
    workspaceRoot,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a search answers the chat folder's matches by their paths in it, and nothing outside it", async () => {
  const asked: Array<Parameters<NonNullable<ConversationRegistryLink['searchFiles']>>[0]> = []
  let root = ''
  const f = await fixture({
    registry: {
      searchFiles: async (input): Promise<FileSearchResult> => {
        asked.push(input)
        return {
          ok: true,
          truncated: false,
          engine: 'ripgrep',
          elapsedMs: 1,
          resultCount: 3,
          results: [
            { name: 'app.ts', path: join(root, 'src', 'app.ts'), parentPath: join(root, 'src'), isDir: false },
            { name: 'src', path: join(root, 'src'), parentPath: root, isDir: true },
            { name: 'secret', path: join(tmpdir(), 'elsewhere', 'secret'), parentPath: tmpdir(), isDir: false },
          ],
        }
      },
    },
  })
  root = f.workspaceRoot
  try {
    const found = await f.host.searchFiles!(f.key, 'phone', 'app', 10)
    assert.deepEqual(found, {
      ok: true,
      answer: {
        entries: [
          { path: 'src/app.ts', kind: 'file' },
          { path: 'src', kind: 'folder' },
        ],
        truncated: false,
      },
    })
    assert.deepEqual(asked, [
      { workspaceId: 'workspace', rootPath: f.workspaceRoot, query: 'app', limit: 10, channel: 'tailnet:phone' },
    ])
    // Never more than the contract's ceiling, whatever the device asked for.
    await f.host.searchFiles!(f.key, 'phone', 'app', 10_000)
    assert.equal(asked[1]!.limit, 50)
    const unknown = await f.host.searchFiles!({ ...f.key, agentId: 'nobody' }, 'phone', 'app')
    assert.equal(unknown.ok, false)
    assert.equal(!unknown.ok && unknown.code, 'unknown_conversation')
  } finally {
    await f.cleanup()
  }
})

test('a host with nothing to search or list offers neither read', async () => {
  const f = await fixture()
  try {
    assert.equal(f.host.searchFiles, undefined)
    assert.equal(f.host.listCommands, undefined)
  } finally {
    await f.cleanup()
  }
})

test("the `/` list is the chat CLI's own for the chat's folder, without Studio's commands", async () => {
  const asked: Array<{ cli: string; cwd: string; refresh?: boolean }> = []
  const f = await fixture({
    providerId: 'claude-agent',
    registry: {
      commandsOf: async (input): Promise<ConversationCommandCatalog> => {
        asked.push({ cli: input.cli, cwd: input.cwd, ...(input.refresh ? { refresh: true } : {}) })
        return {
          cli: input.cli,
          cwd: input.cwd,
          fetchedAt: 42,
          commands: [
            { name: 'review', description: 'Review a pull request', source: 'cli' },
            { name: 'model', source: 'app' },
            { name: 'acme:deploy', source: 'custom' },
          ],
        }
      },
    },
  })
  try {
    const listed = await f.host.listCommands!(f.key, true)
    assert.deepEqual(listed, {
      ok: true,
      answer: {
        cli: 'claude-code',
        fetchedAt: 42,
        commands: [
          { name: 'review', description: 'Review a pull request', source: 'cli' },
          { name: 'acme:deploy', source: 'custom' },
        ],
      },
    })
    assert.deepEqual(asked, [{ cli: 'claude-code', cwd: f.workspaceRoot, refresh: true }])
  } finally {
    await f.cleanup()
  }
})

test('a chat whose agent runs no slash commands says so', async () => {
  const f = await fixture({ registry: { commandsOf: async () => assert.fail('never asked') } })
  try {
    const listed = await f.host.listCommands!(f.key, false)
    assert.equal(listed.ok, false)
    assert.equal(!listed.ok && listed.code, 'unavailable')
  } finally {
    await f.cleanup()
  }
})

test("a send's mentions are resolved against the chat's folder here, and one outside it is refused", async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.workspaceRoot, 'docs'))
    await writeFile(join(f.workspaceRoot, 'docs', 'notes.md'), 'Remember the flaky test.')
    const sendTurn = vi.spyOn(f.runtime, 'sendTurn')
    const sent = await f.host.command(f.key, 'phone', 'send-1', {
      kind: 'send',
      message: 'Read this',
      mentions: [{ path: 'docs/notes.md', kind: 'file' }],
    })
    assert.equal(sent.ok, true, sent.message ?? '')
    assert.deepEqual(sendTurn.mock.calls[0]![0].mentions, [{ path: 'docs/notes.md', kind: 'file' }])
    // The wire refuses such a path before it gets here; the runtime refuses
    // it again, so nothing outside the folder is ever read into a turn.
    const outside = await f.host.command(f.key, 'phone', 'send-2', {
      kind: 'send',
      message: 'And this',
      mentions: [{ path: '../elsewhere.md', kind: 'file' }],
    })
    assert.equal(outside.ok, false)
    assert.match(outside.message ?? '', /outside the workspace/u)
  } finally {
    await f.cleanup()
  }
})

test('a steer with mentions that the turn cannot take is refused busy, never held as words alone', async () => {
  const held: string[] = []
  const f = await fixture({
    registry: {
      heldMessages: {
        hold: (_chat, text) => {
          held.push(text)
          return { ok: true }
        },
        cancel: () => ({ ok: true }),
        list: () => [],
        onChanged: () => () => undefined,
      },
    },
  })
  try {
    const listed = f.runtime.listSessions({ workspaceId: 'workspace', agentId: 'agent' })
    assert.ok(listed.ok)
    // A turn running on a provider that takes no steer.
    vi.spyOn(f.runtime, 'listSessions').mockReturnValue({
      ok: true,
      sessions: listed.sessions.map((session) => ({
        ...session,
        status: 'active' as const,
        capabilities: { ...session.capabilities!, steer: false },
      })),
    })
    const result = await f.host.command(f.key, 'phone', 'steer-1', {
      kind: 'send',
      message: 'Also read this',
      steer: true,
      mentions: [{ path: 'docs/notes.md', kind: 'file' }],
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'busy')
    assert.deepEqual(held, [])
  } finally {
    await f.cleanup()
  }
})
