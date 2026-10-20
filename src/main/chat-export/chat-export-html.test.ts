import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  EXPORT_CHAT_IMAGE_REF,
  EXPORT_CHAT_PNG,
  EXPORT_CHAT_WORKSPACE_ROOT,
  exportChatEvents,
} from '../../../tests/fixtures/conversations/export-chat'
import { writeChatClipboardHtml } from './chat-export-clipboard'
import { buildChatExportDocument, type ChatExportDocument } from './chat-export-document'
import { paperSizeForRegion } from './chat-export-format'
import { buildChatExportHtml, chatExportPrintOptions } from './chat-export-html'
import { mayLoad } from './chat-export-pdf'

// The PDF's page and the HTML "Copy chat" pastes: both written from the
// export's model, both escaping everything the chat said.

function exported(): ChatExportDocument {
  return buildChatExportDocument(
    {
      events: exportChatEvents(),
      attachments: new Map([[EXPORT_CHAT_IMAGE_REF, { mediaType: 'image/png', data: EXPORT_CHAT_PNG }]]),
    },
    {
      title: 'Release <b>SprintEngine</b> Studio',
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

test('the PDF page is the chat as one document: header, then each message under its author', () => {
  const html = buildChatExportHtml(exported())
  assert.ok(html.startsWith('<!doctype html>'))
  assert.match(html, /<h1>Release &lt;b&gt;SprintEngine&lt;\/b&gt; Studio<\/h1>/u)
  assert.match(html, /<dt>Project<\/dt><dd>acme-app<\/dd><dt>Agent<\/dt><dd>Claude Code · claude-sonnet-4-5<\/dd>/u)
  assert.match(html, /Exported from SprintEngine Studio on 20 Oct 2026, 11:00/u)
  assert.equal(html.match(/<article class="message user">/gu)?.length, 2)
  assert.equal(html.match(/<article class="message assistant">/gu)?.length, 2)
  assert.match(html, /<h2 class="author">You · 20 Oct 2026, 09:12<\/h2>/u)
  assert.match(html, /<h4>Release checklist<\/h4>/u)
  assert.match(html, /<ol><li><p>Read the version from <code>package\.json<\/code><\/p><\/li>/u)
  assert.match(html, /<th style="text-align: left">Step<\/th><th style="text-align: right">Time<\/th>/u)
  assert.match(
    html,
    /<figure class="code"><figcaption>ts<\/figcaption><pre><code>const tag = `v\$\{version\}`<\/code><\/pre><\/figure>/u,
  )
  assert.match(html, /<a href="https:\/\/example\.com\/release">the release guide<\/a>/u)
  assert.match(html, /<p class="steps">Read 1 file and ran 1 command<\/p>/u)
  // Math is set as MathML: no script and no font files.
  assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML">/u)
  // The picture is inside the page.
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo[^"]*" alt="screenshot\.png">/u)
  for (const hidden of ['SECRET-REASONING', 'FULL-TOOL-OUTPUT', 'STUDIO-NOTICE']) assert.ok(!html.includes(hidden))
})

test('a script in a message is printed as the words it is', () => {
  const html = buildChatExportHtml(exported())
  assert.ok(!html.includes('<script'), 'no script element anywhere')
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; is only text.'))
})

test('the page loads nothing: its policy allows only its own pictures and styles', () => {
  const html = buildChatExportHtml(exported())
  assert.match(
    html,
    /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/u,
  )
  // Its type and colours are the design system's: the token sheet, then rules on its names.
  assert.match(html, /--sem-font-family-ui:/u)
  assert.match(html, /font-family: var\(--sem-font-family-ui\)/u)
  // Code wraps rather than running off the page.
  assert.match(html, /white-space: pre-wrap; overflow-wrap: anywhere/u)
  // A link into the project is words, not a link the PDF would try to open.
  const document = exported()
  const first = document.messages[0]!
  if (first.kind === 'user')
    first.blocks = [
      {
        kind: 'paragraph',
        content: [{ kind: 'link', href: 'javascript:alert(1)', children: [{ kind: 'text', text: 'run' }] }],
      },
    ]
  assert.ok(!buildChatExportHtml(document).includes('javascript:'))
})

test('the print window answers only its own page and what is inside it', () => {
  const pages = new Set(['file:///tmp/sprintengine-chat-export-x/page.html'])
  assert.equal(mayLoad('file:///tmp/sprintengine-chat-export-x/page.html', pages), true)
  assert.equal(mayLoad('data:image/png;base64,AAAA', pages), true)
  assert.equal(mayLoad('https://example.com/pixel.png', pages), false)
  assert.equal(mayLoad('file:///etc/passwd', pages), false)
})

test('the PDF is printed on the locale’s paper, with margins and a page number at its foot', () => {
  assert.equal(paperSizeForRegion('US'), 'Letter')
  assert.equal(paperSizeForRegion('ca'), 'Letter')
  assert.equal(paperSizeForRegion('GB'), 'A4')
  assert.equal(paperSizeForRegion(null), 'A4')
  const options = chatExportPrintOptions('A4')
  assert.equal(options.pageSize, 'A4')
  assert.equal(options.printBackground, true)
  assert.deepEqual(options.margins, { top: 0.7, bottom: 0.8, left: 0.7, right: 0.7 })
  assert.equal(options.displayHeaderFooter, true)
  assert.match(options.footerTemplate, /<span class="pageNumber"><\/span> \/ <span class="totalPages"><\/span>/u)
  // The footer's ink is the muted text token's value: the footer cannot read the page's sheet.
  assert.match(options.footerTemplate, /color: #646C78;/u)
  assert.equal(chatExportPrintOptions('Letter').pageSize, 'Letter')
})

test('the pasted HTML is plain tags with inline styles, which mail keeps', () => {
  const html = writeChatClipboardHtml(exported())
  assert.ok(!html.includes('class='), 'no classes')
  assert.ok(!html.includes('var(--'), 'no custom properties')
  assert.ok(!html.includes('<style'), 'no style block')
  assert.ok(!html.includes('<script'), 'no script element')
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; is only text.'))
  assert.match(html, /<h1 style="[^"]+">Release &lt;b&gt;SprintEngine&lt;\/b&gt; Studio<\/h1>/u)
  assert.match(html, /<h2 style="[^"]+">You · 20 Oct 2026, 09:12<\/h2>/u)
  assert.match(html, /<h4 style="[^"]+">Release checklist<\/h4>/u)
  assert.match(html, /<strong>checks the tag<\/strong>/u)
  assert.match(html, /<ol style="[^"]+"><li>Read the version from <code style="[^"]+">package\.json<\/code><\/li>/u)
  assert.match(html, /<table style="[^"]+"><thead><tr><th style="[^"]+">Step<\/th>/u)
  assert.match(html, /<pre style="[^"]+"><code>const tag = `v\$\{version\}`<\/code><\/pre>/u)
  assert.match(html, /<a href="https:\/\/example\.com\/release" style="[^"]+">the release guide<\/a>/u)
  // Mail strips a picture's data URL from a paste, so the picture is named.
  assert.ok(html.includes('[image: screenshot.png]'))
  assert.ok(!html.includes('data:image'))
  for (const hidden of ['SECRET-REASONING', 'FULL-TOOL-OUTPUT', 'STUDIO-NOTICE']) assert.ok(!html.includes(hidden))
})
