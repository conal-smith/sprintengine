import { describe, expect, it } from 'vitest'

import { deriveChatActivity, sharedEditFolder, studioToolName } from './chatActivity'
import { chatActivityRows } from './ChatActivityCard'
import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'

const user = (
  id: string,
  seq: number,
  extra: Partial<Extract<TranscriptEntry, { kind: 'user' }>> = {},
): TranscriptEntry => ({
  kind: 'user',
  id,
  seq,
  text: 'Fix the export dialog',
  ...extra,
})

const tool = (id: string, name: string, extra: Partial<TranscriptToolEntry> = {}): TranscriptToolEntry => ({
  kind: 'tool',
  id,
  turnId: 't1',
  name,
  status: 'done',
  ...extra,
})

describe('studioToolName', () => {
  it('reads every runtime spelling of a studio tool, and nothing else', () => {
    expect(studioToolName({ name: 'mcp__sprintengine-studio__browser_open' })).toBe('browser_open')
    expect(studioToolName({ name: 'sprintengine-studio.canvas_edit' })).toBe('canvas_edit')
    expect(studioToolName({ name: 'browser_open', serverName: 'sprintengine-studio' })).toBe('browser_open')
    expect(studioToolName({ name: 'mcp__playwright__browser_navigate' })).toBeNull()
  })
})

describe('deriveChatActivity', () => {
  it('says nothing for a chat that touched nothing', () => {
    expect(deriveChatActivity([user('u1', 1)]).order).toEqual([])
  })

  it('lists rows in the order they were first touched, with the Library last', () => {
    const activity = deriveChatActivity([
      user('u1', 1, {
        storedAttachments: [{ id: 'a1', mediaType: 'image/png', byteLength: 10, ref: 'c/a1.png', name: 'clipped.png' }],
      }),
      tool('e1', 'Edit', {
        toolKind: 'file_edit',
        input: { file_path: '/Users/dev/atlas/src/export/ExportDialog.tsx' },
      }),
      tool('s1', 'Task', { subagentLane: true, agent: { state: 'completed' } }),
      tool('b1', 'mcp__sprintengine-studio__browser_open', { input: { url: 'localhost:5173/export' } }),
      tool('b2', 'mcp__sprintengine-studio__browser_screenshot', {
        images: ['/tmp/shot-1.png'],
        summary: 'Footer at 1280×720',
      }),
      tool('e2', 'Write', {
        toolKind: 'file_write',
        input: { file_path: '/Users/dev/atlas/src/export/ExportFooter.tsx' },
      }),
      tool('c1', 'mcp__sprintengine-studio__canvas_edit', { status: 'running', input: { board: 'export-flow' } }),
    ])
    expect(activity.order).toEqual(['changes', 'files', 'agents', 'browser', 'canvas', 'library'])
    expect(activity.edits.paths).toEqual([
      '/Users/dev/atlas/src/export/ExportDialog.tsx',
      '/Users/dev/atlas/src/export/ExportFooter.tsx',
    ])
    expect(activity.browser).toEqual({ live: false, url: 'localhost:5173/export' })
    expect(activity.canvas).toEqual({ live: true, board: 'export-flow' })
    expect(activity.agents).toEqual({ total: 1, working: 0 })
    // Newest first: the screenshot, then the person's picture.
    expect(activity.images.map((image) => [image.from, image.caption, image.turnSeq])).toEqual([
      ['browser', 'Footer at 1280×720', 1],
      ['you', 'clipped.png', 1],
    ])
  })

  it('counts a spawned agent working until its lane ends, and reads its own steps', () => {
    const activity = deriveChatActivity([
      user('u1', 1),
      tool('s1', 'Task', {
        subagentLane: true,
        status: 'running',
        agent: { state: 'running' },
        children: [tool('e1', 'Edit', { toolKind: 'file_edit', status: 'running', input: { file_path: 'src/a.ts' } })],
      }),
    ])
    expect(activity.agents).toEqual({ total: 1, working: 1 })
    expect(activity.edits).toEqual({ live: true, paths: ['src/a.ts'] })
  })

  it('leaves another server’s browser tools out of the Browser row, but keeps their pictures', () => {
    const activity = deriveChatActivity([
      user('u1', 2),
      tool('p1', 'mcp__playwright__browser_take_screenshot', { images: ['/tmp/p.png'] }),
    ])
    expect(activity.order).toEqual(['library'])
    expect(activity.images[0]).toMatchObject({ from: 'agent', caption: 'p.png', turnSeq: 2 })
  })

  it('draws a live attachment rather than the stored copy of the same picture', () => {
    const attachment = { id: 'a1', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 3 }
    const activity = deriveChatActivity([
      user('u1', 1, {
        attachments: [attachment],
        storedAttachments: [{ id: 'a1', mediaType: 'image/png', byteLength: 3, ref: 'c/a1.png' }],
      }),
    ])
    expect(activity.images).toHaveLength(1)
    expect(activity.images[0]!.source).toEqual({ kind: 'attachment', attachment })
  })
})

describe('sharedEditFolder', () => {
  it('names the folder the edits share, under the workspace when it is inside it', () => {
    const paths = ['/Users/dev/atlas/src/export/a.tsx', '/Users/dev/atlas/src/export/b.css']
    expect(sharedEditFolder(paths, '/Users/dev/atlas')).toBe('src/export')
    expect(sharedEditFolder(paths, null)).toBe('/Users/dev/atlas/src/export')
    expect(sharedEditFolder(['/Users/dev/atlas/a.ts'], '/Users/dev/atlas')).toBe('.')
    expect(sharedEditFolder([], '/Users/dev/atlas')).toBeNull()
  })
})

describe('chatActivityRows', () => {
  it('says each row the way the card draws it', () => {
    const activity = deriveChatActivity([
      user('u1', 1),
      tool('e1', 'Edit', { toolKind: 'file_edit', input: { file_path: '/Users/dev/atlas/src/a.ts' } }),
      tool('s1', 'Task', { subagentLane: true, status: 'running', agent: { state: 'running' } }),
      tool('b1', 'mcp__sprintengine-studio__browser_open', {
        status: 'running',
        input: { url: 'http://localhost:5173/x' },
      }),
    ])
    const rows = chatActivityRows(activity, {
      diff: { added: 24, removed: 6 },
      workspaceRoot: '/Users/dev/atlas',
      seen: (kind) => kind === 'files',
    })
    expect(rows.map(({ kind, label, meta, live, unseen }) => ({ kind, label, meta, live, unseen }))).toEqual([
      { kind: 'changes', label: 'Changes · 1 file', meta: null, live: false, unseen: true },
      { kind: 'files', label: 'Files', meta: 'src', live: false, unseen: false },
      { kind: 'agents', label: 'Agents · 1', meta: '1 working', live: true, unseen: true },
      { kind: 'browser', label: 'Browser', meta: 'Agent here', live: true, unseen: true },
    ])
    expect(rows[0]!.diff).toEqual({ added: 24, removed: 6 })
  })
})
