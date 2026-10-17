// A CLI that is handed its hook at launch (Codex's `-c hooks…`, OpenCode's
// config content) or from user-level config (Cursor, Grok) takes back out the
// registration an earlier build wrote into the repository — only the app's
// part, and never a file the project committed.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { AGENT_STATE_TOML_END, AGENT_STATE_TOML_START, removeWorkspaceAgentStateRegistration } from './agent-state'
import { runGitCommand } from './git-utils'

const COMMAND = "/bin/sh '/Users/dev/.sprintengine/bin/studio-run' agent-state --socket '/tmp/s.sock'"

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'se-agent-state-tidy-'))
  assert.ok((await runGitCommand(root, ['init', '-q'])).ok)
  return root
}

function codexBlock(): string {
  return [
    AGENT_STATE_TOML_START,
    '[[hooks.Stop]]',
    '[[hooks.Stop.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(COMMAND)}`,
    AGENT_STATE_TOML_END,
  ].join('\n')
}

test("Codex's managed hook block leaves the repository's config, and the person's settings stay", async () => {
  const root = await repository()
  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.codex', 'config.toml'), `model = "gpt-5"\n\n${codexBlock()}\n`)
  const changed = await removeWorkspaceAgentStateRegistration(root, { kind: 'toml-block', path: '.codex/config.toml' })
  assert.deepEqual(changed, ['.codex/config.toml'])
  assert.equal(await readFile(join(root, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-5"\n')
})

test('a config that held only the block goes with its folder; a committed one is only emptied', async () => {
  const root = await repository()
  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.codex', 'config.toml'), `${codexBlock()}\n`)
  await removeWorkspaceAgentStateRegistration(root, { kind: 'toml-block', path: '.codex/config.toml' })
  assert.equal(existsSync(join(root, '.codex')), false)

  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.codex', 'config.toml'), `${codexBlock()}\n`)
  for (const args of [
    ['add', '.codex/config.toml'],
    ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-q', '-m', 'codex'],
  ]) {
    assert.ok((await runGitCommand(root, args)).ok)
  }
  await removeWorkspaceAgentStateRegistration(root, { kind: 'toml-block', path: '.codex/config.toml' })
  assert.equal(existsSync(join(root, '.codex', 'config.toml')), true, 'a tracked file is edited, never deleted')
})

test("OpenCode's plugin file and Grok's hook file go when they are recognisably the app's", async () => {
  const root = await repository()
  await mkdir(join(root, '.opencode', 'plugin'), { recursive: true })
  await writeFile(
    join(root, '.opencode', 'plugin', 'sprintengine-agent-state.js'),
    'process.env.SPRINTENGINE_AGENT_STATE_SOCKET\n',
  )
  await removeWorkspaceAgentStateRegistration(root, {
    kind: 'plugin-file',
    path: '.opencode/plugin/sprintengine-agent-state.js',
    template: 'opencode-agent-state.mjs',
  })
  assert.equal(existsSync(join(root, '.opencode')), false)

  await mkdir(join(root, '.grok', 'hooks'), { recursive: true })
  const theirs = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
  await writeFile(join(root, '.grok', 'hooks', 'sprintengine-agent-state.json'), theirs)
  await removeWorkspaceAgentStateRegistration(root, {
    kind: 'owned-json',
    path: '.grok/hooks/sprintengine-agent-state.json',
  })
  assert.equal(
    await readFile(join(root, '.grok', 'hooks', 'sprintengine-agent-state.json'), 'utf8'),
    theirs,
    'not ours: kept',
  )
})
