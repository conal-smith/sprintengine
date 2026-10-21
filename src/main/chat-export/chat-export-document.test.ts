import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  EXPORT_CHAT_IMAGE_REF,
  EXPORT_CHAT_PNG,
  EXPORT_CHAT_WORKSPACE_ROOT,
  exportChatEvents,
} from '../../../tests/fixtures/conversations/export-chat'
import {
  buildChatExportDocument,
  chatExportHasMessages,
  type ChatExportDocument,
  type ChatExportMeta,
  type ExportMessage,
  type ExportPart,
} from './chat-export-document'

const META: ChatExportMeta = {
  title: 'Release SprintEngine Studio',
  project: 'acme-app',
  engine: 'Claude Code',
  model: 'default',
  workspaceRoot: EXPORT_CHAT_WORKSPACE_ROOT,
  exportedAt: Date.UTC(2026, 9, 20, 11, 0, 0),
  locale: 'en-GB',
  timeZone: 'UTC',
}

function exported(): ChatExportDocument {
  return buildChatExportDocument(
    {
      events: exportChatEvents(),
      attachments: new Map([[EXPORT_CHAT_IMAGE_REF, { mediaType: 'image/png', data: EXPORT_CHAT_PNG }]]),
    },
    META,
  )
}

function assistantParts(message: ExportMessage | undefined): ExportPart[] {
  assert.equal(message?.kind, 'assistant')
  return message.kind === 'assistant' ? message.parts : []
}

test('the header names the chat, its project, its agent and model, and when it ran', () => {
  const document = exported()
  assert.equal(document.title, 'Release SprintEngine Studio')
  assert.equal(document.project, 'acme-app')
  assert.equal(document.engine, 'Claude Code')
  // The model the turns ran on, not the chat's "default" setting.
  assert.equal(document.model, 'claude-sonnet-4-5')
  assert.equal(document.startedAt, Date.UTC(2026, 9, 20, 9, 12, 1))
  assert.equal(document.endedAt, Date.UTC(2026, 9, 20, 9, 13, 15))
  assert.equal(document.generator, 'SprintEngine Studio')
})

test('the messages are the two from the person and the two replies, in order', () => {
  const document = exported()
  assert.deepEqual(
    document.messages.map((message) => [message.kind, message.author]),
    [
      ['user', 'You'],
      ['assistant', 'Claude Code'],
      ['user', 'You'],
      ['assistant', 'Claude Code'],
    ],
  )
  assert.ok(chatExportHasMessages(document))
})

test('a message keeps its Markdown, its time, its picture and its attached file', () => {
  const [first] = exported().messages
  assert.equal(first?.kind, 'user')
  if (first?.kind !== 'user') return
  assert.equal(first.at, Date.UTC(2026, 9, 20, 9, 12, 1))
  assert.deepEqual(first.blocks, [
    {
      kind: 'paragraph',
      content: [
        { kind: 'text', text: 'Can you make the ' },
        { kind: 'strong', children: [{ kind: 'text', text: 'release script' }] },
        { kind: 'text', text: ' check the tag first?' },
      ],
    },
  ])
  assert.equal(first.images.length, 1)
  assert.equal(first.images[0]?.name, 'screenshot.png')
  assert.equal(first.images[0]?.mediaType, 'image/png')
  assert.deepEqual(first.images[0]?.data, EXPORT_CHAT_PNG)
  assert.deepEqual(first.files, [`${EXPORT_CHAT_WORKSPACE_ROOT}/scripts/release.mjs`])
})

test('a reply is its prose and its steps in order, each run of steps one line, its agent one line', () => {
  const parts = assistantParts(exported().messages[1])
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['steps', 'prose', 'steps', 'agent', 'prose'],
  )
  // The read and the test run before the first prose: the summary their group shows.
  assert.deepEqual(parts[0], { kind: 'steps', text: 'Read 1 file and ran 1 command', failed: 0 })
  assert.deepEqual(parts[1], {
    kind: 'prose',
    blocks: [
      {
        kind: 'paragraph',
        content: [{ kind: 'text', text: 'The tests pass. I will ask an agent where the tag is made.' }],
      },
    ],
  })
  // One step alone is its own label, its file named where it is in the project.
  assert.deepEqual(parts[2], { kind: 'steps', text: 'Edited scripts/release.mjs', failed: 0 })
  assert.deepEqual(parts[3], {
    kind: 'agent',
    text: 'Explore agent: Find where the tag is created · Done in 9s · 1 step',
  })
})

test('the final reply keeps its headings, list, table, code, math, diagram and link as Markdown structure', () => {
  const parts = assistantParts(exported().messages[1])
  const reply = parts.at(-1)
  assert.equal(reply?.kind, 'prose')
  if (reply?.kind !== 'prose') return
  const kinds = reply.blocks.map((block) => block.kind)
  assert.deepEqual(kinds, ['heading', 'paragraph', 'list', 'table', 'code', 'code', 'paragraph', 'paragraph'])
  const [heading, , list, table, code, diagram, math, link] = reply.blocks
  assert.deepEqual(heading, { kind: 'heading', level: 2, content: [{ kind: 'text', text: 'Release checklist' }] })
  assert.equal(list?.kind === 'list' && list.ordered, true)
  assert.equal(list?.kind === 'list' && list.items[1]?.blocks[1]?.kind, 'list', 'the nested list stays nested')
  assert.deepEqual(table?.kind === 'table' && table.align, ['left', 'right'])
  assert.deepEqual(code, { kind: 'code', language: 'ts', text: 'const tag = `v${version}`' })
  // A diagram is exported as the code it is written in.
  assert.deepEqual(diagram, { kind: 'code', language: 'mermaid', text: 'graph TD; build --> test' })
  // `$$…$$` is math; a lone dollar is a price.
  assert.ok(
    math?.kind === 'paragraph' && math.content.some((inline) => inline.kind === 'math' && inline.tex === 'E = mc^2'),
  )
  assert.ok(
    math?.kind === 'paragraph' && math.content.some((inline) => inline.kind === 'text' && inline.text.includes('$5')),
  )
  assert.ok(
    link?.kind === 'paragraph' &&
      link.content.some((inline) => inline.kind === 'link' && inline.href === 'https://example.com/release'),
  )
  // Raw HTML is the words it is.
  assert.ok(
    link?.kind === 'paragraph' &&
      link.content.some((inline) => inline.kind === 'text' && inline.text.includes('<script>alert("x")</script>')),
  )
})

test('the second reply answers its question and says it was stopped', () => {
  const parts = assistantParts(exported().messages[3])
  assert.deepEqual(parts, [
    { kind: 'note', text: 'Which channel should it go to? — nightly' },
    { kind: 'prose', blocks: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Publishing to nightly.' }] }] },
    { kind: 'note', text: 'Interrupted' },
  ])
})

test('reasoning, step output, Studio notices, compactions and usage are not in it', () => {
  const text = JSON.stringify(exported())
  for (const hidden of [
    'SECRET-REASONING',
    'FULL-TOOL-OUTPUT',
    'STUDIO-NOTICE',
    '90000',
    'inputTokens',
    'apiKeySource',
  ])
    assert.ok(!text.includes(hidden), `${hidden} is left out`)
})

test('a picture that could not be read back is named without its bytes', () => {
  const document = buildChatExportDocument({ events: exportChatEvents(), attachments: new Map() }, META)
  const first = document.messages[0]
  assert.ok(first?.kind === 'user' && first.images[0]?.data === undefined && first.images[0]?.name === 'screenshot.png')
})

test('a chat with no messages has nothing to export', () => {
  const document = buildChatExportDocument(
    { events: exportChatEvents().filter((event) => event.type === 'session_started'), attachments: new Map() },
    META,
  )
  assert.equal(chatExportHasMessages(document), false)
  assert.equal(document.title, 'Release SprintEngine Studio')
})
