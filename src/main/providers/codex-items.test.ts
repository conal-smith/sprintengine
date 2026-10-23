import assert from 'node:assert/strict'
import { test } from 'vitest'

import { codexTool, codexToolResult } from './codex-items'
import type { ThreadItem } from './codex-protocol'

test('a Codex file change that moves its file names the destination beside the file', () => {
  const item = {
    type: 'fileChange',
    id: 'patch',
    status: 'inProgress',
    changes: [
      { path: 'src/a.ts', kind: { type: 'update', move_path: '/Users/dev/.zshrc' }, diff: '' },
      { path: 'src/b.ts', kind: { type: 'update', move_path: null }, diff: '@@' },
      { path: 'src/c.ts', kind: { type: 'add' }, diff: '+c' },
    ],
  } as unknown as ThreadItem
  assert.deepEqual(codexTool(item)?.input, {
    edits: [
      { path: 'src/a.ts', patch: '', movePath: '/Users/dev/.zshrc' },
      { path: 'src/b.ts', patch: '@@' },
      { path: 'src/c.ts', patch: '+c' },
    ],
  })
})

function mcpCall(result: unknown): ThreadItem {
  return {
    type: 'mcpToolCall',
    id: 'shot',
    server: 'sprintengine-studio',
    tool: 'browser_screenshot',
    status: 'completed',
    arguments: {},
    result,
    error: null,
  } as unknown as ThreadItem
}

test("an MCP step's pictures are taken out of its output to be shown, and its words kept", () => {
  const result = codexToolResult(
    mcpCall({
      content: [
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'text', text: 'Captured 1280×800.' },
      ],
      structuredContent: null,
      _meta: null,
    }),
  )
  assert.equal(result.output, 'Captured 1280×800.', 'no base64 in the output')
  assert.deepEqual(result.images, [{ mediaType: 'image/png', base64: 'iVBORw0KGgo=' }])
  assert.equal(result.status, 'ok')
})

test('an MCP step with only a picture has no output words, and one without pictures is handed on whole', () => {
  const pictureOnly = codexToolResult(
    mcpCall({
      content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      structuredContent: null,
      _meta: null,
    }),
  )
  assert.equal(pictureOnly.output, '')
  const structured = { content: [], structuredContent: { rows: 3 }, _meta: null }
  const answer = codexToolResult(mcpCall(structured))
  assert.deepEqual(answer.output, structured)
  assert.equal('images' in answer, false)
  // Words alone: exactly the shape it had before pictures were read at all.
  const wordsOnly = { content: [{ type: 'text', text: '3 rows' }], structuredContent: null, _meta: null }
  assert.deepEqual(codexToolResult(mcpCall(wordsOnly)), { output: wordsOnly, status: 'ok' })
})

test('an MCP step with more pictures than are kept says how many more in its words', () => {
  const shot = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  const result = codexToolResult(
    mcpCall({
      content: [{ type: 'text', text: 'Captured 10 pages.' }, ...Array.from({ length: 10 }, () => ({ ...shot }))],
      structuredContent: null,
      _meta: null,
    }),
  )
  assert.equal(result.images?.length, 8)
  assert.equal(result.output, 'Captured 10 pages.\n[2 more images not shown]')
})
