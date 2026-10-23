import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import {
  MAX_TOOL_RESULT_IMAGE_BYTES,
  MAX_TOOL_RESULT_IMAGES,
  saveToolResultImagesUnder,
  toolImageFolder,
  toolImagesNotShown,
  toolResultImages,
} from './tool-result-images'
import { ConversationAttachmentStore } from '../conversation-attachment-store'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

test('pictures are read from a Claude content block and from an MCP content item alike', () => {
  expect(
    toolResultImages([
      { type: 'text', text: 'Captured.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'image', data: PNG, mimeType: 'image/jpeg' },
    ]),
  ).toEqual([
    { mediaType: 'image/png', base64: PNG },
    { mediaType: 'image/jpeg', base64: PNG },
  ])
})

test('only the four formats are kept, never a picture by URL or an SVG', () => {
  expect(
    toolResultImages([
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image', data: PNG, mimeType: 'image/svg+xml' },
      { type: 'image', data: '', mimeType: 'image/png' },
      'not a block',
    ]),
  ).toEqual([])
  expect(toolResultImages('text')).toEqual([])
})

test('a step keeps at most eight pictures, and no more bytes than the bound, in order', () => {
  const many = Array.from({ length: 12 }, () => ({ type: 'image', data: PNG, mimeType: 'image/png' }))
  expect(toolResultImages(many)).toHaveLength(MAX_TOOL_RESULT_IMAGES)
  // Each a little over a third of the bound: the third would pass it.
  const big = 'A'.repeat(Math.ceil(((MAX_TOOL_RESULT_IMAGE_BYTES / 3) * 4) / 3) + 8)
  const large = Array.from({ length: 4 }, () => ({ type: 'image', data: big, mimeType: 'image/webp' }))
  expect(toolResultImages(large)).toHaveLength(2)
})

test("a step's output says how many of its pictures are past the eight kept", () => {
  const shots = (count: number) =>
    Array.from({ length: count }, () => ({ type: 'image', data: PNG, mimeType: 'image/png' }))
  const note = (content: unknown[]) => toolImagesNotShown(content, toolResultImages(content).length)
  expect(toolResultImages(shots(10))).toHaveLength(8)
  expect(note(shots(10))).toBe('[2 more images not shown]')
  expect(note(shots(9))).toBe('[1 more image not shown]')
  expect(note(shots(8))).toBe('')
  expect(note([{ type: 'text', text: 'Captured.' }, ...shots(1)])).toBe('')
})

test('a picture past the byte bound or in a format not kept is counted, and a step that keeps none says nothing', () => {
  const big = 'A'.repeat(Math.ceil(((MAX_TOOL_RESULT_IMAGE_BYTES / 3) * 4) / 3) + 8)
  const content = [
    { type: 'image', data: PNG, mimeType: 'image/svg+xml' },
    ...Array.from({ length: 3 }, () => ({ type: 'image', data: big, mimeType: 'image/webp' })),
  ]
  expect(toolResultImages(content)).toHaveLength(2)
  expect(toolImagesNotShown(content, 2)).toBe('[2 more images not shown]')
  expect(toolImagesNotShown([{ type: 'image', data: PNG, mimeType: 'image/svg+xml' }], 0)).toBe('')
  expect(toolImagesNotShown('text', 0)).toBe('')
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-images-'))
  dirs.push(dir)
  return dir
}

const KEY = { workspaceRoot: '/Users/dev/app', workspaceId: 'workspace', agentId: 'agent' }

test("a step's pictures are written in the conversation's folder, named for the step, before they are named", async () => {
  const root = dataDir()
  const write = saveToolResultImagesUnder(root)({
    key: KEY,
    toolUseId: 'toolu:9',
    images: [
      { mediaType: 'image/png', base64: PNG },
      { mediaType: 'image/jpeg', base64: PNG },
    ],
  })
  const folder = toolImageFolder(root, KEY)
  expect(folder).toBe(join(root, 'conversation-images', ConversationAttachmentStore.folderFor(KEY)))
  expect(write.paths).toEqual([join(folder, 'toolu_9-1.png'), join(folder, 'toolu_9-2.jpg')])
  await write.written
  expect(readFileSync(write.paths[0]!).toString('base64')).toBe(PNG)
})

test('a step id can never name a file outside the folder: dots and separators are not kept', async () => {
  const root = dataDir()
  for (const toolUseId of ['..', '.', '../../escape', 'a/../../b', '']) {
    const write = saveToolResultImagesUnder(root)({
      key: KEY,
      toolUseId,
      images: [{ mediaType: 'image/png', base64: PNG }],
    })
    await write.written
    for (const path of write.paths) {
      expect(path.startsWith(toolImageFolder(root, KEY) + sep), toolUseId).toBe(true)
      expect(existsSync(path)).toBe(true)
    }
  }
  expect(readdirSync(join(root, 'conversation-images'))).toEqual([ConversationAttachmentStore.folderFor(KEY)])
})

test('deleting the conversation takes the pictures its steps returned', async () => {
  const root = dataDir()
  const write = saveToolResultImagesUnder(root)({
    key: KEY,
    toolUseId: 'shot',
    images: [{ mediaType: 'image/png', base64: PNG }],
  })
  await write.written
  const other = { ...KEY, agentId: 'other' }
  const kept = saveToolResultImagesUnder(root)({
    key: other,
    toolUseId: 'shot',
    images: [{ mediaType: 'image/png', base64: PNG }],
  })
  await kept.written
  await new ConversationAttachmentStore(root).deleteConversation(KEY)
  expect(existsSync(toolImageFolder(root, KEY))).toBe(false)
  expect(existsSync(kept.paths[0]!), "another conversation's are left").toBe(true)
})
