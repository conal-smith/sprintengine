import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  EXPORT_CHAT_IMAGE_REF,
  EXPORT_CHAT_PNG,
  EXPORT_CHAT_WORKSPACE_ROOT,
  exportChatEvents,
} from '../../../tests/fixtures/conversations/export-chat'
import { buildChatExportDocument, type ChatExportDocument } from './chat-export-document'
import { writeChatExportMarkdown } from './chat-export-markdown'
import { parseExportMarkdown } from './chat-export-markdown-parse'

function exported(attachments = true): ChatExportDocument {
  return buildChatExportDocument(
    {
      events: exportChatEvents(),
      attachments: new Map(
        attachments ? [[EXPORT_CHAT_IMAGE_REF, { mediaType: 'image/png', data: EXPORT_CHAT_PNG }]] : [],
      ),
    },
    {
      title: 'Release SprintEngine Studio',
      project: 'acme-app',
      engine: 'Claude Code',
      model: null,
      workspaceRoot: EXPORT_CHAT_WORKSPACE_ROOT,
      exportedAt: Date.UTC(2026, 9, 20, 11, 0, 0),
      locale: 'en-GB',
      timeZone: 'UTC',
    },
  )
}

const FOLDER = 'Release SprintEngine Studio – 2026-10-20-files'

test('the document opens with its title, the facts and where it came from', () => {
  const { markdown } = writeChatExportMarkdown(exported(), FOLDER)
  assert.ok(
    markdown.startsWith(
      [
        '# Release SprintEngine Studio',
        '',
        '**Project:** acme-app  ',
        '**Agent:** Claude Code · claude-sonnet-4-5  ',
        '**Date:** 20 Oct 2026, 09:12–09:13  ',
        '*Exported from SprintEngine Studio on 20 Oct 2026, 11:00*',
      ].join('\n'),
    ),
    markdown.slice(0, 400),
  )
})

test('each message is headed by who wrote it and when', () => {
  const { markdown } = writeChatExportMarkdown(exported(), FOLDER)
  assert.ok(
    markdown.includes('---\n\n## You · 20 Oct 2026, 09:12\n\nCan you make the **release script** check the tag first?'),
  )
  assert.ok(markdown.includes('## Claude Code · 20 Oct 2026, 09:12'))
  assert.ok(markdown.includes('## You · 20 Oct 2026, 09:13\n\nShip it'))
})

test('the reply is GitHub-flavoured Markdown again, its headings under the message’s', () => {
  const { markdown } = writeChatExportMarkdown(exported(), FOLDER)
  for (const expected of [
    '#### Release checklist',
    'The release script now **checks the tag** before it builds:',
    '1. Read the version from `package.json`\n2. Compare it with the tag\n   - fail when they differ',
    '| Step | Time |\n| :--- | ---: |\n| build | 42s |\n| test | 1m 3s |',
    '```ts\nconst tag = `v${version}`\n```',
    '```mermaid\ngraph TD; build --> test\n```',
    'Energy is $$E = mc^2$$, and it costs \\$5 a month.',
    '[the release guide](https://example.com/release)',
    // Text that looks like markup is escaped to stay text.
    '\\<script>alert("x")\\</script> is only text.',
  ])
    assert.ok(markdown.includes(expected), `has ${JSON.stringify(expected)}\n---\n${markdown}`)
})

test('steps, agents and decisions are one quiet line each, and the hidden parts are gone', () => {
  const { markdown } = writeChatExportMarkdown(exported(), FOLDER)
  for (const line of [
    '*Read 1 file and ran 1 command*',
    '*Edited scripts/release.mjs*',
    '*Explore agent: Find where the tag is created · Done in 9s · 1 step*',
    '*Which channel should it go to? — nightly*',
    '*Interrupted*',
  ])
    assert.ok(markdown.includes(line), line)
  for (const hidden of ['SECRET-REASONING', 'FULL-TOOL-OUTPUT', 'STUDIO-NOTICE']) assert.ok(!markdown.includes(hidden))
})

test('an attached picture is written beside the document and linked by its relative path', () => {
  const { markdown, files } = writeChatExportMarkdown(exported(), FOLDER)
  assert.deepEqual(files, [{ path: `${FOLDER}/image-1.png`, data: EXPORT_CHAT_PNG }])
  assert.ok(
    markdown.includes('![screenshot.png](Release%20SprintEngine%20Studio%20%E2%80%93%202026-10-20-files/image-1.png)'),
  )
  assert.ok(markdown.includes('Attached files: `/Users/dev/acme-app/scripts/release.mjs`'))
})

test('a picture that could not be read is named instead, and no file is written for it', () => {
  const { markdown, files } = writeChatExportMarkdown(exported(false), FOLDER)
  assert.deepEqual(files, [])
  assert.ok(markdown.includes('*Attached image not available: screenshot.png*'))
})

test('what the writer escapes reads back as the same words', () => {
  const tricky = 'Use *stars*, `ticks`, [brackets], a_b, _under_, #hash, <tag> & $$ dollars'
  const document = exported()
  const first = document.messages[0]
  assert.equal(first?.kind, 'user')
  if (first?.kind !== 'user') return
  first.blocks = [{ kind: 'paragraph', content: [{ kind: 'text', text: tricky }] }]
  first.images = []
  first.files = []
  const { markdown } = writeChatExportMarkdown({ ...document, messages: [first] }, FOLDER)
  const body = markdown.split('## You · 20 Oct 2026, 09:12\n\n')[1]!.trim()
  assert.deepEqual(parseExportMarkdown(body), [{ kind: 'paragraph', content: [{ kind: 'text', text: tricky }] }])
})
