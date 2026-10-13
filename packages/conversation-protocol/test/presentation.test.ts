import assert from 'node:assert/strict'
import { test } from 'vitest'

import { presentToolItem } from '../src/presentation'

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
