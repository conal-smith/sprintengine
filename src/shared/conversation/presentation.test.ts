import { test, expect } from 'vitest'
import { presentToolItem, summarizeToolGroup, type PresentableTool } from './presentation'
import type { ConversationToolKind } from '../conversation-runtime'

const kinds: ConversationToolKind[] = [
  'command',
  'file_read',
  'file_edit',
  'file_write',
  'search',
  'list',
  'web',
  'mcp',
  'subagent',
  'todo',
  'other',
]
const states = ['running', 'ok', 'error', 'declined', 'stopped', 'done'] as const
for (const kind of kinds)
  for (const status of states) {
    test(`${kind} has a bounded deterministic title when ${status}`, () => {
      const item: PresentableTool = {
        kind,
        status,
        name: 'Example',
        input: { path: '/workspace/app.ts', command: 'npm test', query: 'hello' },
      }
      const presentation = presentToolItem(item)
      expect(presentation.title.length).toBeLessThanOrEqual(72)
      expect(presentation).toEqual(presentToolItem(item))
      expect(presentation.icon).toBe(kind)
      if (status === 'running') expect(presentation.tone).toBe('running')
    })
  }
test('groups largest counts first with natural plurals', () => {
  expect(
    summarizeToolGroup([
      ...Array.from({ length: 3 }, () => ({ name: 'Read' })),
      ...Array.from({ length: 2 }, () => ({ name: 'Bash' })),
      { name: 'Edit' },
    ]),
  ).toBe('Read 3 files, ran 2 commands and edited 1 file')
  expect(summarizeToolGroup([{ name: 'ls' }, { name: 'ls' }])).toBe('Listed 2 directories')
  expect(summarizeToolGroup([{ name: 'Grep' }, { name: 'Grep' }])).toBe('Searched 2 queries')
})
test('command failure is neutral with exit status, runtime failure is an error', () => {
  expect(presentToolItem({ name: 'Bash', status: 'error', exitCode: 1 })).toMatchObject({
    tone: 'neutral',
    subtitle: 'exit 1',
  })
  expect(presentToolItem({ name: 'Bash', status: 'error' }).tone).toBe('error')
})
test('malformed data and unknown names stay readable', () => {
  expect(presentToolItem(null as unknown as PresentableTool).title).toBe('Tool')
  expect(presentToolItem({ name: 'custom' }).title).toBe('custom')
  expect(presentToolItem({ name: 'Read', input: { file_path: '/very/long/parent/file.ts' } }).title).toBe(
    'Read file.ts',
  )
})

test('long directory titles retain their basename inside the title budget', () => {
  for (const suffix of ['', '/']) {
    const title = presentToolItem({
      kind: 'list',
      name: 'List',
      input: { path: `/workspace/${'parent/'.repeat(20)}source-files${suffix}` },
    }).title
    expect(title).toHaveLength(72)
    expect(title).toMatch(/^Listed /)
    expect(title).toContain('…')
    expect(title.endsWith(`source-files${suffix}`)).toBe(true)
  }
})

test('portable presentation uses the same command labels without a renderer callback', () => {
  for (const [command, title] of [
    ['cat README.md', 'Read README.md'],
    ['head -n 20 README.md', 'Read README.md'],
    ['rg -g "*.ts" needle src', 'Searched for "needle"'],
  ]) {
    expect(presentToolItem({ name: 'Bash', input: { command } }).title).toBe(title)
  }
  expect(presentToolItem({ name: 'Bash', input: { command: 'npm test' } }, () => 'Custom command').title).toBe(
    'Custom command',
  )
})

test('a wait and a generated picture say what they did rather than their tool name', () => {
  expect(presentToolItem({ name: 'Sleep', kind: 'other', input: { durationMs: 10_000 }, status: 'ok' }).title).toBe(
    'Waited 10s',
  )
  expect(
    presentToolItem({ name: 'Sleep', kind: 'other', input: { durationMs: 120_000 }, status: 'running' }).title,
  ).toBe('Waiting 2m')
  expect(presentToolItem({ name: 'GenerateImage', kind: 'other', input: {}, status: 'running' }).title).toBe(
    'Generating image',
  )
  expect(presentToolItem({ name: 'GenerateImage', kind: 'other', input: {}, status: 'ok' }).title).toBe(
    'Generated image',
  )
})

test('a Codex JavaScript tool reads as the title the model gave the call', () => {
  expect(
    presentToolItem({
      name: 'cua_repl.js',
      kind: 'other',
      input: { title: '  Open Settings  ', code: '' },
      status: 'ok',
    }).title,
  ).toBe('Open Settings')
  expect(presentToolItem({ name: 'js', kind: 'other', input: { title: 'x'.repeat(200) } }).title.length).toBe(72)
})

test('an untitled Codex JavaScript tool says whether it used the computer or ran a script', () => {
  expect(presentToolItem({ name: 'cua_repl.js', kind: 'other', input: {}, status: 'running' }).title).toBe(
    'Using the computer',
  )
  expect(
    presentToolItem({ name: 'js', kind: 'other', input: { code: 'await sky.click(10, 20)' }, status: 'ok' }).title,
  ).toBe('Used the computer')
  expect(
    presentToolItem({ name: 'node_repl.js', kind: 'other', input: { code: 'import "@oai/sky"' }, status: 'ok' }).title,
  ).toBe('Used the computer')
  expect(presentToolItem({ name: 'js', kind: 'other', input: { code: '1 + 1' }, status: 'running' }).title).toBe(
    'Running JavaScript',
  )
  expect(presentToolItem({ name: 'node_repl.js', kind: 'other', input: {}, status: 'ok' }).title).toBe('Ran JavaScript')
})
