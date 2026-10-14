// The fixture has the shape of Claude Code 2.1.284's `supportedCommands()`
// answer and its `reloadSkills()` names, with made-up rows: one of each kind
// the mapping treats differently (built-ins, the ones a chat drops, a user
// command, a plugin's command, skills with and without a qualified alias).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  claudeCommandsFromInit,
  mapClaudeCommands,
  probeClaudeConversationCommands,
  sameCommandNames,
  type ClaudeCommandsProbeDeps,
} from './claude'

const FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), 'src', 'main', 'conversation-commands', '__fixtures__', 'claude-supported-commands.json'),
    'utf8',
  ),
) as { commands: Array<Record<string, unknown>>; skills: string[] }

const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name)

test('a chat is not offered what would leave, reset or fight its session, or what only a terminal shows', () => {
  const offered = new Set(names(mapClaudeCommands(FIXTURE.commands, { skills: FIXTURE.skills })))
  for (const dropped of [
    'clear',
    'model',
    'effort',
    'color',
    'focus',
    'doctor',
    'reload-plugins',
    '__internal-sync',
    'workflow-launch-exec',
    'agents',
    'extra-usage',
  ])
    expect(offered.has(dropped), dropped).toBe(false)
  for (const kept of ['compact', 'context', 'usage', 'init', 'review', 'mcp', 'release-notes', 'acme:deploy'])
    expect(offered.has(kept), kept).toBe(true)
  expect(offered.size).toBe(FIXTURE.commands.length - 11)
})

test("Claude Code's own rows read as the CLI's, the others as skills or custom commands", () => {
  const commands = mapClaudeCommands(FIXTURE.commands, { skills: FIXTURE.skills })
  const byName = new Map(commands.map((command) => [command.name, command]))
  expect(byName.get('compact')).toEqual({
    name: 'compact',
    description: 'Summarise the conversation so far to free context',
    argumentHint: '[instructions]',
    source: 'cli',
  })
  expect(byName.get('usage')?.aliases).toEqual(['cost', 'stats'])
  // A bundled skill is still the CLI's own.
  expect(byName.get('simplify')?.source).toBe('cli')
  // A plugin's skill keeps the name the CLI runs it by, qualified or not.
  expect(byName.get('release-notes')).toMatchObject({ source: 'skill', aliases: ['acme:release-notes'] })
  expect(byName.get('acme:lint-rules')?.source).toBe('skill')
  // A user's or a plugin's command that is no skill is custom.
  expect(byName.get('changelog')?.source).toBe('custom')
  expect(byName.get('acme:deploy')).toMatchObject({ source: 'custom', argumentHint: '[env]' })
  // No empty hints or descriptions ride along.
  expect(byName.get('context')).toEqual({
    name: 'context',
    description: 'Show how much context is in use',
    source: 'cli',
  })
})

test('without the builtin marker or a skill list, a row reads as custom', () => {
  expect(
    mapClaudeCommands([{ name: 'deploy', description: 'Ship it', argumentHint: '[env]' }, { name: 'pdf' }], {
      skills: ['pdf'],
    }),
  ).toEqual([
    { name: 'deploy', description: 'Ship it', argumentHint: '[env]', source: 'custom' },
    { name: 'pdf', source: 'skill' },
  ])
})

test("of two rows sharing a name, the CLI's own is the one kept", () => {
  expect(
    mapClaudeCommands([
      { name: 'review', description: 'A user command' },
      { name: 'review', description: 'Built in', builtin: true },
      { name: 'review', description: 'A plugin command' },
    ]),
  ).toEqual([{ name: 'review', description: 'Built in', source: 'cli' }])
})

test('a name with a slash or whitespace in front or inside is cleaned or dropped', () => {
  expect(names(mapClaudeCommands([{ name: '/compact' }, { name: 'two words' }, { name: '' }, null, 'x']))).toEqual([
    'compact',
  ])
})

test('an init keeps the known rows it names, adds the ones it alone names, and drops terminal-bound ones', () => {
  const known = mapClaudeCommands(FIXTURE.commands, { skills: FIXTURE.skills })
  const next = claudeCommandsFromInit(
    {
      slash_commands: ['context', 'compact', 'mcp__docs__summarise', 'fresh-skill', 'statusline', 'clear'],
      terminal_slash_commands: ['statusline'],
      skills: ['fresh-skill'],
    },
    known,
  )
  expect(next).toEqual([
    {
      name: 'compact',
      description: 'Summarise the conversation so far to free context',
      argumentHint: '[instructions]',
      source: 'cli',
    },
    { name: 'context', description: 'Show how much context is in use', source: 'cli' },
    { name: 'mcp__docs__summarise', source: 'custom' },
    { name: 'fresh-skill', source: 'skill' },
  ])
  expect(claudeCommandsFromInit({}, known)).toBeNull()
})

test('the same names in the same order are the same list', () => {
  const list = [
    { name: 'a', source: 'cli' as const },
    { name: 'b', source: 'cli' as const },
  ]
  expect(sameCommandNames(list, [...list])).toBe(true)
  expect(sameCommandNames(list, [...list].reverse())).toBe(false)
})

// ── Probe ──────────────────────────────────────────────────────────────────

type FakeSession = { options: Record<string, unknown> | null; prompt: AsyncIterable<unknown> | null; closed: number }

function fakeSdk(answer: () => Promise<unknown[]>, skills?: () => Promise<{ skills?: Array<{ name: string }> }>) {
  const session: FakeSession = { options: null, prompt: null, closed: 0 }
  const deps: ClaudeCommandsProbeDeps = {
    resolveExecutable: async () => '/Users/dev/.local/bin/claude',
    env: () => ({ PATH: '/usr/bin', HOME: '/Users/dev' }),
    loadQuery: async () =>
      ((input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
        session.options = input.options
        session.prompt = input.prompt
        return {
          supportedCommands: answer,
          ...(skills ? { reloadSkills: skills } : {}),
          close: () => {
            session.closed += 1
          },
        }
      }) as never,
  }
  return { deps, session }
}

test("the probe asks with a chat's settings and folder, no turn, no hooks and no MCP servers, and closes", async () => {
  const { deps, session } = fakeSdk(
    async () => FIXTURE.commands,
    async () => ({ skills: FIXTURE.skills.map((name) => ({ name })) }),
  )
  const commands = await probeClaudeConversationCommands({ cwd: '/Users/dev/app' }, deps)
  expect(commands.find((command) => command.name === 'release-notes')?.source).toBe('skill')
  expect(session.options).toMatchObject({
    cwd: '/Users/dev/app',
    pathToClaudeCodeExecutable: '/Users/dev/.local/bin/claude',
    settingSources: ['user'],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    env: {
      PATH: '/usr/bin',
      HOME: '/Users/dev',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    },
  })
  expect((session.options?.abortController as AbortController).signal.aborted).toBe(true)
  expect(session.closed).toBe(1)
  // The input stream sends nothing, and ends once the probe is torn down.
  const iterator = (session.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

test('a CLI that cannot say which rows are skills still lists every command', async () => {
  const { deps } = fakeSdk(
    async () => [{ name: 'docs', description: 'Docs', argumentHint: '' }],
    async () => {
      throw new Error('Unsupported control request')
    },
  )
  expect(await probeClaudeConversationCommands({ cwd: '/Users/dev/app' }, deps)).toEqual([
    { name: 'docs', description: 'Docs', source: 'custom' },
  ])
})

test('a probe the CLI never answers gives up at its deadline and still closes the child', async () => {
  const { deps, session } = fakeSdk(() => new Promise(() => undefined))
  await expect(probeClaudeConversationCommands({ cwd: '/Users/dev/app' }, { ...deps, timeoutMs: 20 })).rejects.toThrow(
    /did not list its commands within/,
  )
  expect(session.closed).toBe(1)
})

test('a Claude Code set to run inside WSL is not probed', async () => {
  const { deps, session } = fakeSdk(async () => [])
  await expect(
    probeClaudeConversationCommands(
      { cwd: '/Users/dev/app', cliRuntimes: { 'claude-code': { hostId: 'wsl:Ubuntu' } } },
      deps,
    ),
  ).rejects.toThrow(/WSL/)
  expect(session.options).toBeNull()
})
