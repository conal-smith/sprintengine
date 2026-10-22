import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// An attached skill reaches the child as a copy in a plugin of its own. Claude
// Code's Skill tool refuses a skill marked `disable-model-invocation` unless
// the person typed `/<name>` in the message, which an attachment never is, so
// the copy goes without that key. The skill's own file stays as it was.

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// `files` go in the skill's folder, or with `link` beside the workspace, its
// SKILL.md a link to the one named.
async function stage(files: Record<string, string>, link?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'claude-attached-skills-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const tempDir = join(root, 'tmp')
  const skillDir = join(workspaceRoot, '.claude', 'skills', 'release')
  await mkdir(skillDir, { recursive: true })
  await mkdir(tempDir)
  for (const [name, text] of Object.entries(files)) await writeFile(join(link ? root : skillDir, name), text)
  if (link) await symlink(join(root, link), join(skillDir, 'SKILL.md'))
  const plugins: string[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    plugins.push(...(params.options.plugins as Array<{ path: string }>).map((plugin) => plugin.path))
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess_1' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    tempDir,
  })
  const turn: MockAdapterTurnInput = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot,
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'Cut the release',
    skills: ['release'],
  }
  await adapter.startSession(turn)
  for await (const _event of (await adapter.sendTurn(turn)) as AsyncIterable<ConversationEvent>) {
    // drained
  }
  const staged = await readFile(join(plugins[0]!, 'skills', 'release', 'SKILL.md'), 'utf8')
  await adapter.disposeAll()
  return staged
}

const BODY = '\n# Release\n\ndisable-model-invocation: true is how the key is spelled.\n'

test('an attached skill marked for the person only is staged without that mark, its body as it was', async () => {
  const original = `---\nname: release\ndisable-model-invocation: true\ndescription: Cut a release\n---${BODY}`
  const staged = await stage({ 'SKILL.md': original })
  expect(staged).toBe(`---\nname: release\ndescription: Cut a release\n---${BODY}`)
  expect(await readFile(join(roots[0]!, 'workspace', '.claude', 'skills', 'release', 'SKILL.md'), 'utf8')).toBe(
    original,
  )
})

test('a skill file with Windows line endings loses only the mark', async () => {
  const staged = await stage({
    'SKILL.md': '---\r\nname: release\r\ndisable-model-invocation: true\r\n---\r\nDo it.\r\n',
  })
  expect(staged).toBe('---\r\nname: release\r\n---\r\nDo it.\r\n')
})

test('an attached skill without the mark is staged unchanged', async () => {
  const original = `---\nname: release\ndescription: Cut a release\n---${BODY}`
  expect(await stage({ 'SKILL.md': original })).toBe(original)
})

test('a skill whose SKILL.md links elsewhere keeps the file it links to as it was', async () => {
  const original = `---\nname: release\ndisable-model-invocation: true\n---${BODY}`
  const staged = await stage({ 'shared.md': original }, 'shared.md')
  expect(staged).toBe(`---\nname: release\n---${BODY}`)
  expect(await readFile(join(roots[0]!, 'shared.md'), 'utf8')).toBe(original)
})
