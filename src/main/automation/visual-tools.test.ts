import { expect, test } from 'vitest'
import type { VisualPreviewDeps } from '../visual/visual-preview'
import { createVisualTools, visualSourceOf } from './visual-tools'

const context = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1' } }

function tool(deps: Partial<VisualPreviewDeps> = {}) {
  const calls: string[] = []
  const surface = {
    run: async (script: string) => {
      calls.push(script)
      if (script.includes('__visualPreviewFrame = frame')) return { loaded: true, height: 120 }
      if (script.includes('readVisualParts')) return { head: '', body: '<svg></svg>', title: 'Bars', empty: false }
      return true
    },
    consoleLines: () => [{ level: 'error' as const, message: 'Uncaught ReferenceError: d3 is not defined' }],
    resize: () => {},
    capture: async () => ({ width: 640, height: 120, png: () => Buffer.from('png'), jpeg: () => Buffer.from('jpg') }),
    close: () => {},
  }
  const [registration] = createVisualTools({
    open: async () => surface,
    theme: async () => ({ theme: { variables: {} }, background: null }),
    ...deps,
  })
  return { registration: registration!, calls }
}

test('a whole ```visual fence is unwrapped to its markup; anything else is drawn as given', () => {
  expect(visualSourceOf('```visual\n<svg></svg>\n```')).toBe('<svg></svg>')
  expect(visualSourceOf('  ~~~~studio-visual\n<p>a</p>\n~~~~  ')).toBe('<p>a</p>')
  expect(visualSourceOf('<p>```visual</p>')).toBe('<p>```visual</p>')
})

test('visual.preview answers with the picture in an image block and the report beside it', async () => {
  const { registration } = tool()
  expect(registration.name).toBe('visual.preview')
  expect(registration.mutates).toBeUndefined()
  const result = await registration.handler({ source: '```visual\n<svg></svg>\n```', width: 500 }, context)
  expect(result.isError).toBeUndefined()
  expect(result.content[1]).toEqual({
    type: 'image',
    data: Buffer.from('png').toString('base64'),
    mimeType: 'image/png',
  })
  expect(result.structuredContent).toMatchObject({
    title: 'Bars',
    width: 500,
    frameHeight: 120,
    console: [{ level: 'error', message: 'Uncaught ReferenceError: d3 is not defined' }],
    caption: 'Bars: 500x120, 1 console error(s).',
  })
  // The pixels are in the image block only.
  expect(JSON.stringify(result.structuredContent)).not.toContain(Buffer.from('png').toString('base64'))
})

test('visual.preview refuses a call without a source', async () => {
  const { registration } = tool()
  const result = await registration.handler({ source: '  ' }, context)
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toMatchObject({ error: { code: 'invalid_arguments' } })
})
