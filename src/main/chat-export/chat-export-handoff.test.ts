import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  EXPORT_CHAT_REPLY,
  EXPORT_CHAT_WORKSPACE_ROOT,
  exportChatEventsWithDecisions,
} from '../../../tests/fixtures/conversations/export-chat'
import { writeHandoffMarkdown } from './chat-export-handoff'

const META = {
  title: 'Release checks',
  project: 'acme-app',
  engine: 'Claude Code',
  model: null,
  workspaceRoot: EXPORT_CHAT_WORKSPACE_ROOT,
  exportedAt: Date.UTC(2026, 9, 20, 11, 0, 0),
  locale: 'en-GB',
  timeZone: 'UTC',
}

function handoff(options: { truncated?: boolean; maxBytes?: number } = {}) {
  return writeHandoffMarkdown(exportChatEventsWithDecisions(), META, {
    truncated: options.truncated ?? false,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
  })
}

test('the handoff file holds the words: the person’s messages, the replies, and what the person answered', () => {
  const { markdown, truncated } = handoff()
  assert.equal(truncated, false)
  assert.match(markdown, /^# Release checks\n\nThis is the text of an earlier session of this conversation/u)
  assert.match(markdown, /release script\*\* check the tag first\?/u)
  assert.match(markdown, /The tests pass\. I will ask an agent where the tag is made\./u)
  // The reply as written, its Markdown kept.
  assert.match(markdown, /Release checklist/u)
  assert.ok(markdown.includes('checks the tag'), EXPORT_CHAT_REPLY.slice(0, 20))
  // A question answered and a plan approved are the person's words.
  assert.match(markdown, /Which channel should it go to\? — nightly/u)
  assert.match(markdown, /PLAN-STEP tag the release/u)
  assert.match(markdown, /Plan approved/u)
  assert.match(markdown, /The build is green\./u)
})

test('the handoff file leaves out every step, its output, the agents sent off, permissions and commands', () => {
  const { markdown } = handoff()
  // No step line ("Ran npm script test", "Read scripts/release.mjs") and no output.
  assert.doesNotMatch(markdown, /FULL-TOOL-OUTPUT/u)
  assert.doesNotMatch(markdown, /\bRan\b/u)
  assert.doesNotMatch(markdown, /Read scripts\/release\.mjs|Edited scripts\/release\.mjs/u)
  // No agent line.
  assert.doesNotMatch(markdown, /Explore/u)
  // No permission given for a step.
  assert.doesNotMatch(markdown, /PERMISSION-STEP/u)
  // No command the CLI ran, nor what it printed: the person's `/context` is
  // their message, and stays as they wrote it.
  assert.doesNotMatch(markdown, /COMMAND-OUTPUT/u)
  assert.doesNotMatch(markdown, /Ran \/context/u)
  // Nor reasoning, nor Studio's own notice.
  assert.doesNotMatch(markdown, /SECRET-REASONING|STUDIO-NOTICE/u)
})

test('a transcript read as its newest part says so in the file’s header', () => {
  const { markdown, truncated } = handoff({ truncated: true })
  assert.equal(truncated, true)
  const header = markdown.slice(0, markdown.indexOf('---'))
  assert.match(header, /too long to keep whole, so this file holds its most recent part/u)
})

test('a file over its budget drops its oldest messages and says so', () => {
  const whole = handoff()
  const cut = handoff({ maxBytes: Buffer.byteLength(whole.markdown) - 200 })
  assert.ok(cut.messages < whole.messages)
  assert.equal(cut.truncated, true)
  assert.ok(Buffer.byteLength(cut.markdown) <= Buffer.byteLength(whole.markdown) - 200)
  // The newest message stays.
  assert.match(cut.markdown, /The build is green\./u)
})
