import { expect, test } from 'vitest'

import { mapSdkMessage } from './claude-agent-provider'
import type { SaveToolResultImages } from './tool-result-images'

// A picture a tool hands back (a browser screenshot) is kept to show under its
// step, not reduced to its size: written by the saver, named on the step's
// `tool_output` as `images`. A file read's picture is the file, already shown
// by its path, and is not kept twice.

const PNG = 'iVBORw0KGgo='

function session(): Parameters<typeof mapSdkMessage>[0] {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude',
    modelId: 'sonnet',
    providerSessionId: 'sdk-1',
    turn: { turnId: 'turn-1' },
    workspaceRoot: '/Users/dev/app',
  }
}

function recordingSaver() {
  const saved: Parameters<SaveToolResultImages>[0][] = []
  const save: SaveToolResultImages = (input) => {
    saved.push(input)
    return {
      paths: input.images.map(
        (_, index) => `/Users/dev/Studio/conversation-images/c1/${input.toolUseId}-${index + 1}.png`,
      ),
      written: Promise.resolve(),
    }
  }
  return { saved, save }
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }
}

function toolResult(id: string, content: unknown[]) {
  return {
    type: 'user',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  }
}

test("a screenshot a tool returns is written to disk and named on its step's output", () => {
  const state = session()
  const { saved, save } = recordingSaver()
  mapSdkMessage(state, toolUse('shot', 'mcp__sprintengine-studio__browser_screenshot'))
  const [output] = mapSdkMessage(
    state,
    toolResult('shot', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: '{"width":1280,"height":800}' },
    ]),
    { saveToolImages: save },
  )
  expect(saved).toEqual([
    {
      key: { workspaceRoot: '/Users/dev/app', workspaceId: 'workspace', agentId: 'agent' },
      toolUseId: 'shot',
      images: [{ mediaType: 'image/png', base64: PNG }],
    },
  ])
  expect(output?.type).toBe('tool_output')
  expect(output?.payload?.images).toEqual(['/Users/dev/Studio/conversation-images/c1/shot-1.png'])
  expect(state.toolImageWrites, 'the write is handed to the caller to wait on').toHaveLength(1)
  expect(output?.payload?.output, 'the words stay; the bytes are not in them').toBe('{"width":1280,"height":800}')
})

test('a step with more pictures than are kept says how many more, and its words are not blanked as a binary', () => {
  const state = session()
  const { saved, save } = recordingSaver()
  mapSdkMessage(state, toolUse('shots', 'mcp__sprintengine-studio__browser_screenshot'))
  const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
  const [output] = mapSdkMessage(
    state,
    toolResult('shots', [{ type: 'text', text: 'Captured 10 pages.' }, ...Array.from({ length: 10 }, () => shot)]),
    { saveToolImages: save },
  )
  expect(saved[0]?.images).toHaveLength(8)
  expect(output?.payload?.images).toHaveLength(8)
  expect(output?.payload?.output).toBe('Captured 10 pages.\n[2 more images not shown]')
  // A `mime` would have the runtime show the result as a binary, with no words.
  expect('mime' in (output?.payload ?? {})).toBe(false)
})

test("a file read's picture is not kept twice, and a step with no picture carries no images", () => {
  const state = session()
  const { saved, save } = recordingSaver()
  mapSdkMessage(state, toolUse('read', 'Read', { file_path: '/Users/dev/app/logo.png' }))
  const [read] = mapSdkMessage(
    state,
    toolResult('read', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]),
    { saveToolImages: save },
  )
  mapSdkMessage(state, toolUse('ls', 'Bash', { command: 'ls' }))
  const [ls] = mapSdkMessage(state, toolResult('ls', [{ type: 'text', text: 'a.ts' }]), { saveToolImages: save })
  expect(saved).toEqual([])
  expect('images' in (read?.payload ?? {})).toBe(false)
  expect('images' in (ls?.payload ?? {})).toBe(false)
})

test('an import keeps no pictures', () => {
  const state = session()
  const { saved, save } = recordingSaver()
  mapSdkMessage(state, toolUse('shot', 'mcp__sprintengine-studio__browser_screenshot'))
  const [output] = mapSdkMessage(
    state,
    toolResult('shot', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]),
    { saveToolImages: false },
  )
  void save
  expect(saved).toEqual([])
  expect('images' in (output?.payload ?? {})).toBe(false)
})
