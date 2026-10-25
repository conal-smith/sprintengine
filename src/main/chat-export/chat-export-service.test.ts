import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  EXPORT_CHAT_IMAGE_REF,
  EXPORT_CHAT_PNG,
  EXPORT_CHAT_WORKSPACE_ROOT,
  exportChatEvents,
} from '../../../tests/fixtures/conversations/export-chat'
import type { ChatExportAction } from '../../shared/chat-export'
import type { ConversationEvent } from '../../shared/conversation-runtime'
import { chatExportChatOf } from './chat-export-electron'
import { chatExportFileName, sanitizeExportTitle } from './chat-export-filename'
import { runChatExport, type ChatExportDeps } from './chat-export-service'
import { readChatExportSource } from './chat-export-source'

// Export chat from end to end, with the dialog, the disk, the clipboard and
// the print window as stand-ins: which chat is read, what is asked, what is
// written where, and what is answered.

type Recorded = {
  dialogs: { defaultPath: string; format: string }[]
  files: Map<string, Uint8Array | string>
  folders: string[]
  clipboard: { text: string; html?: string }[]
  pdfHtml: string[]
  read: unknown[]
}

function harness(options: { savePath?: string | null; events?: ConversationEvent[]; region?: string } = {}): {
  deps: ChatExportDeps
  recorded: Recorded
} {
  const recorded: Recorded = { dialogs: [], files: new Map(), folders: [], clipboard: [], pdfHtml: [], read: [] }
  const events = options.events ?? exportChatEvents()
  const deps: ChatExportDeps = {
    chat: (workspaceId, agentId) =>
      chatExportChatOf(
        [
          {
            id: 'workspace-1',
            name: 'acme-app',
            folderPath: EXPORT_CHAT_WORKSPACE_ROOT,
            agents: {
              'agent-1': {
                name: 'Release: SprintEngine Studio?',
                runtimeKind: 'conversation',
                conversation: { providerId: 'claude-agent', modelId: 'default' },
                execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
              },
              'terminal-1': { name: 'zsh', runtimeKind: 'terminal' },
            } as never,
          },
        ],
        workspaceId,
        agentId,
      ),
    readSource: async (key) => {
      recorded.read.push(key)
      return readChatExportSource(
        {
          readTranscript: async () => ({ ok: true, events }),
          readAttachment: async (ref) =>
            ref === EXPORT_CHAT_IMAGE_REF
              ? { ok: true, mediaType: 'image/png', dataBase64: EXPORT_CHAT_PNG.toString('base64') }
              : { ok: false, message: 'missing' },
        },
        key,
      )
    },
    engineName: (providerId) => (providerId === 'claude-agent' ? 'Claude Code' : null),
    pickSavePath: async (input) => {
      recorded.dialogs.push(input)
      return options.savePath === undefined
        ? `/Users/dev/Downloads/${input.defaultPath.split('/').at(-1)}`
        : options.savePath
    },
    defaultDirectory: () => '/Users/dev/Downloads',
    renderPdf: async (html, paper) => {
      recorded.pdfHtml.push(html)
      return Buffer.from(`%PDF-1.7 ${paper}`)
    },
    writeFile: async (path, data) => {
      recorded.files.set(path, data)
    },
    makeDirectory: async (path) => {
      recorded.folders.push(path)
    },
    writeClipboard: async (data) => {
      recorded.clipboard.push(data)
    },
    now: () => Date.UTC(2026, 9, 20, 11, 0, 0),
    locale: () => 'en-GB',
    timeZone: () => 'UTC',
    region: () => options.region ?? 'GB',
  }
  return { deps, recorded }
}

const run = (action: ChatExportAction, deps: ChatExportDeps, agentId = 'agent-1') =>
  runChatExport({ workspaceId: 'workspace-1', agentId, action }, deps)

test('a PDF is offered under the chat’s name and the day, in Downloads, and printed from the page', async () => {
  const { deps, recorded } = harness({ region: 'US' })
  const result = await run('pdf', deps)
  const name = 'Release SprintEngine Studio – 2026-10-20.pdf'
  assert.deepEqual(recorded.dialogs, [{ defaultPath: `/Users/dev/Downloads/${name}`, format: 'pdf' }])
  assert.deepEqual(result, { ok: true, kind: 'saved', path: `/Users/dev/Downloads/${name}`, fileName: name })
  assert.equal(String(recorded.files.get(`/Users/dev/Downloads/${name}`)), '%PDF-1.7 Letter')
  assert.match(recorded.pdfHtml[0]!, /<h1>Release: SprintEngine Studio\?<\/h1>/u)
  // The transcript was read from where the chat keeps it.
  assert.deepEqual(recorded.read, [
    { workspaceRoot: EXPORT_CHAT_WORKSPACE_ROOT, workspaceId: 'workspace-1', agentId: 'agent-1' },
  ])
})

test('a Word document is a zip written where the person chose', async () => {
  const { deps, recorded } = harness({ savePath: '/Users/dev/Documents/notes.docx' })
  const result = await run('docx', deps)
  assert.deepEqual(result, { ok: true, kind: 'saved', path: '/Users/dev/Documents/notes.docx', fileName: 'notes.docx' })
  const data = recorded.files.get('/Users/dev/Documents/notes.docx') as Uint8Array
  assert.equal(Buffer.from(data).subarray(0, 2).toString('latin1'), 'PK')
})

test('Markdown is written with its pictures in a folder named after the file', async () => {
  const { deps, recorded } = harness({ savePath: '/Users/dev/Documents/release.md' })
  await run('markdown', deps)
  assert.deepEqual(recorded.folders, ['/Users/dev/Documents/release-files'])
  assert.deepEqual(
    recorded.files.get('/Users/dev/Documents/release-files/image-1.png'),
    new Uint8Array(EXPORT_CHAT_PNG),
  )
  assert.match(
    String(recorded.files.get('/Users/dev/Documents/release.md')),
    /!\[screenshot\.png\]\(release-files\/image-1\.png\)/u,
  )
})

test('dismissing the dialog writes nothing and says nothing', async () => {
  const { deps, recorded } = harness({ savePath: null })
  assert.deepEqual(await run('pdf', deps), { ok: true, kind: 'cancelled' })
  assert.equal(recorded.files.size, 0)
  assert.equal(recorded.pdfHtml.length, 0)
})

test('Copy chat puts the Markdown and the HTML on the clipboard together', async () => {
  const { deps, recorded } = harness()
  assert.deepEqual(await run('copy', deps), { ok: true, kind: 'copied' })
  assert.equal(recorded.clipboard.length, 1)
  const [copied] = recorded.clipboard
  assert.ok(copied!.text.startsWith('# Release: SprintEngine Studio?\n'))
  assert.ok(copied!.text.includes('*Read 1 file and ran 1 command*'))
  assert.ok(copied!.html?.startsWith('<div style="'))
  assert.ok(!copied!.html!.includes('class=') && !copied!.html!.includes('var(--') && !copied!.html!.includes('<style'))
  assert.ok(copied!.html!.includes('&lt;script&gt;'))
  assert.equal(recorded.dialogs.length, 0, 'no dialog for a copy')
  assert.equal(recorded.files.size, 0)
})

test('Copy chat as Markdown puts the text alone', async () => {
  const { deps, recorded } = harness()
  await run('copy-markdown', deps)
  assert.equal(recorded.clipboard.length, 1)
  assert.deepEqual(Object.keys(recorded.clipboard[0]!), ['text'])
  // The pictures are named, not linked to files that were never written.
  assert.ok(recorded.clipboard[0]!.text.includes('[image: screenshot.png]'))
  assert.ok(!recorded.clipboard[0]!.text.includes('image-1.png'))
})

test('a chat that is not a conversation, or has no messages, is refused in words', async () => {
  const { deps } = harness()
  assert.deepEqual(await run('pdf', deps, 'terminal-1'), { ok: false, message: 'This chat could not be found.' })
  assert.deepEqual(await run('pdf', deps, 'missing'), { ok: false, message: 'This chat could not be found.' })
  const empty = harness({ events: exportChatEvents().filter((event) => event.type === 'session_started') })
  assert.deepEqual(await run('copy', empty.deps), { ok: false, message: 'This chat has no messages to export yet.' })
  assert.equal(empty.recorded.clipboard.length, 0)
  assert.equal(empty.recorded.dialogs.length, 0)
})

test('a disk that refuses the file is an error, not a success', async () => {
  const { deps } = harness()
  deps.writeFile = async () => {
    throw new Error('EACCES: permission denied')
  }
  assert.deepEqual(await run('docx', deps), { ok: false, message: 'EACCES: permission denied' })
})

test('the suggested name is the title made safe for every system, and the day', () => {
  assert.equal(sanitizeExportTitle('Release: SprintEngine Studio?'), 'Release SprintEngine Studio')
  assert.equal(sanitizeExportTitle('../../etc/passwd'), 'etc passwd')
  assert.equal(sanitizeExportTitle('  .hidden \u0007 name.  '), 'hidden name')
  assert.equal(sanitizeExportTitle('CON'), 'CON chat')
  assert.equal(sanitizeExportTitle('???'), 'Chat')
  assert.equal([...sanitizeExportTitle('a'.repeat(300))].length, 80)
  assert.equal(
    chatExportFileName('Release SprintEngine Studio', 'docx', Date.UTC(2026, 9, 20, 23, 30), 'Pacific/Auckland'),
    'Release SprintEngine Studio – 2026-10-21.docx',
  )
  assert.equal(chatExportFileName('Notes', 'markdown', Date.UTC(2026, 9, 20), 'UTC'), 'Notes – 2026-10-20.md')
})

test('a paired machine’s chat is exported from the transcript its window read from there', async () => {
  const { deps, recorded } = harness()
  const result = await runChatExport(
    {
      workspaceId: 'w-followed',
      agentId: 'agent-there',
      action: 'copy-markdown',
      remote: {
        events: exportChatEvents(),
        title: 'Parser review',
        project: 'parser',
        providerId: 'claude-agent',
        modelId: 'default',
        workspaceRoot: EXPORT_CHAT_WORKSPACE_ROOT,
      },
    },
    deps,
  )
  assert.deepEqual(result, { ok: true, kind: 'copied' })
  assert.deepEqual(recorded.read, [], 'nothing is read here: the transcript is on that machine')
  const text = recorded.clipboard[0]!.text
  assert.ok(text.startsWith('# Parser review\n'), text.slice(0, 80))
  // Its pictures stay on that machine, and are named.
  assert.ok(text.includes('[image: screenshot.png]'))
})
