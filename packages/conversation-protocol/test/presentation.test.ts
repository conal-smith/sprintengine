import assert from 'node:assert/strict'
import { test } from 'vitest'

import { presentToolItem, toolActionVerb } from '../src/presentation'

test('an MCP call reads as its server and tool, made readable from the wire name', () => {
  const title = (name: string) => presentToolItem({ name, status: 'ok' }).title
  assert.equal(title('mcp__claude_ai_Gmail__search_threads'), 'Gmail: search threads')
  assert.equal(title('mcp__sprintengine-studio__browser_open'), 'sprintengine studio: browser open')
  assert.equal(title('mcp__linear__list-issues'), 'linear: list issues')
  // A name with no server part is the tool alone.
  assert.equal(title('mcp__search'), 'search')
})

test('an MCP call prefers the title and server name its provider reported', () => {
  const item = {
    name: 'mcp__claude_ai_Gmail__search_threads',
    status: 'running' as const,
    displayTitle: 'Search threads',
    serverName: 'Gmail',
  }
  assert.equal(presentToolItem(item).title, 'Gmail: Search threads')
  assert.equal(presentToolItem({ ...item, serverName: undefined }).title, 'Gmail: Search threads')
  // A title that already names its server is not prefixed twice.
  assert.equal(presentToolItem({ ...item, displayTitle: 'Gmail search' }).title, 'Gmail search')
  // Whitespace a server sent is folded; a blank title falls back to the wire name.
  assert.equal(presentToolItem({ ...item, displayTitle: '  Search\n threads ' }).title, 'Gmail: Search threads')
  assert.equal(presentToolItem({ ...item, displayTitle: ' ', serverName: '' }).title, 'Gmail: search threads')
})

test('an MCP title stays within the row’s bound', () => {
  const long = presentToolItem({ name: 'mcp__acme__run', displayTitle: 'x'.repeat(200), status: 'ok' })
  assert.ok(long.title.length <= 72)
})

test('a Skill step names the skill it used', () => {
  assert.equal(
    presentToolItem({ name: 'Skill', input: { skill: 'studio-ship' }, status: 'ok' }).title,
    'Used studio-ship skill',
  )
  assert.equal(
    presentToolItem({ name: 'Skill', input: { skill: 'studio-ship' }, status: 'running' }).title,
    'Using studio-ship skill',
  )
  // A call that names it as a slash command.
  assert.equal(
    presentToolItem({ name: 'Skill', input: { command: '/release-notes' }, status: 'ok' }).title,
    'Used release-notes skill',
  )
  // A call that names none still reads as the tool.
  assert.equal(presentToolItem({ name: 'Skill', input: {}, status: 'ok' }).title, 'Skill')
})

test('a Skill step’s verb says it used a skill', () => {
  assert.equal(toolActionVerb('Skill', true), 'Using skill')
  assert.equal(toolActionVerb('Skill', false), 'Used skill')
})
