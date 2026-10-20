import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'

import { test } from 'vitest'

import {
  EXPORT_CHAT_IMAGE_REF,
  EXPORT_CHAT_PNG,
  EXPORT_CHAT_WORKSPACE_ROOT,
  exportChatEvents,
} from '../../../tests/fixtures/conversations/export-chat'
import { buildChatExportDocument } from './chat-export-document'
import { writeChatExportDocx } from './chat-export-docx'
import { fitImage, readExportImageInfo } from './chat-export-image'

// The Word file is opened as Word would open it: unzipped, and its parts read.

/** The entries of a zip, by name: enough of the format to read what `docx` writes. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'a zip ends with its central directory')
  let offset = zip.readUInt32LE(end + 16)
  const count = zip.readUInt16LE(end + 10)
  for (let index = 0; index < count; index += 1) {
    const method = zip.readUInt16LE(offset + 10)
    const size = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const local = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + size)
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function written(): Promise<Map<string, Buffer>> {
  const document = buildChatExportDocument(
    {
      events: exportChatEvents(),
      attachments: new Map([[EXPORT_CHAT_IMAGE_REF, { mediaType: 'image/png', data: EXPORT_CHAT_PNG }]]),
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
  return unzip(await writeChatExportDocx(document, { paper: 'A4' }))
}

// The text of each paragraph of `word/document.xml` with the style it is in.
function paragraphs(xml: string): { style: string | null; text: string }[] {
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p [^>]*>([\s\S]*?)<\/w:p>/gu)].map((match) => {
    const body = match[1] ?? match[2] ?? ''
    return {
      style: /<w:pStyle w:val="([^"]+)"/u.exec(body)?.[1] ?? null,
      text: [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/gu)].map((text) => text[1]).join(''),
    }
  })
}

test('it is a Word document: its parts are where Word looks for them', async () => {
  const parts = await written()
  for (const name of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
  ])
    assert.ok(parts.has(name), name)
})

test('the title, the facts and each message are Word headings and paragraphs', async () => {
  const xml = (await written()).get('word/document.xml')!.toString('utf8')
  const found = paragraphs(xml)
  const styled = (style: string) => found.filter((paragraph) => paragraph.style === style).map((p) => p.text)
  assert.deepEqual(styled('Title'), ['Release SprintEngine Studio'])
  assert.deepEqual(styled('Heading2'), [
    'You · 20 Oct 2026, 09:12',
    'Claude Code · 20 Oct 2026, 09:12',
    'You · 20 Oct 2026, 09:13',
    'Claude Code · 20 Oct 2026, 09:13',
  ])
  // The reply's `##` sits under the message heading.
  assert.deepEqual(styled('Heading4'), ['Release checklist'])
  assert.ok(found.some((paragraph) => paragraph.text === 'Project: acme-app'))
  assert.ok(found.some((paragraph) => paragraph.text === 'Can you make the release script check the tag first?'))
  assert.ok(styled('ExportStep').includes('Read 1 file and ran 1 command'))
  assert.ok(styled('ExportStep').includes('Explore agent: Find where the tag is created · Done in 9s · 1 step'))
  assert.ok(!xml.includes('SECRET-REASONING') && !xml.includes('FULL-TOOL-OUTPUT'))
})

test('code is in the code style, in a monospace face, with its language above it', async () => {
  const parts = await written()
  const found = paragraphs(parts.get('word/document.xml')!.toString('utf8'))
  const code = found.filter((paragraph) => paragraph.style === 'ExportCode').map((p) => p.text)
  assert.ok(code.includes('const tag = `v${version}`'))
  assert.ok(code.includes('graph TD; build --&gt; test'))
  assert.deepEqual(
    found.filter((paragraph) => paragraph.style === 'ExportCodeLabel').map((p) => p.text),
    ['ts', 'mermaid'],
  )
  const styles = parts.get('word/styles.xml')!.toString('utf8')
  assert.match(styles, /<w:style [^>]*w:styleId="ExportCode"[\s\S]*?w:ascii="Consolas"/u)
  // Inline code is a monospace run.
  assert.match(
    parts.get('word/document.xml')!.toString('utf8'),
    /w:ascii="Consolas"[\s\S]*?<w:t[^>]*>package\.json<\/w:t>/u,
  )
})

test('lists, the table and the link are Word’s own', async () => {
  const xml = (await written()).get('word/document.xml')!.toString('utf8')
  assert.match(xml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/u)
  assert.match(xml, /<w:numPr><w:ilvl w:val="1"\/>/u, 'the nested list is a level down')
  assert.match(xml, /<w:tbl>[\s\S]*<w:tblHeader\/>[\s\S]*<w:t[^>]*>build<\/w:t>[\s\S]*<\/w:tbl>/u)
  assert.match(xml, /<w:hyperlink [^>]*r:id="[^"]+"[\s\S]*?<w:t[^>]*>the release guide<\/w:t>/u)
  const rels = (await written()).get('word/_rels/document.xml.rels')!.toString('utf8')
  assert.match(rels, /Target="https:\/\/example\.com\/release" TargetMode="External"/u)
})

test('the attached picture is in the document, placed at its size', async () => {
  const parts = await written()
  const media = [...parts.keys()].filter((name) => name.startsWith('word/media/') && !name.endsWith('/'))
  assert.equal(media.length, 1, media.join(', '))
  assert.deepEqual(parts.get(media[0]!), EXPORT_CHAT_PNG)
  const xml = parts.get('word/document.xml')!.toString('utf8')
  // 4 x 3 pixels, in EMUs.
  assert.match(xml, /<wp:extent cx="38100" cy="28575"\/>/u)
  assert.match(xml, /descr="screenshot\.png"/u)
})

test('a picture’s size is read from its header, and only shrunk to fit', () => {
  assert.deepEqual(readExportImageInfo(EXPORT_CHAT_PNG), { kind: 'png', width: 4, height: 3 })
  assert.equal(readExportImageInfo(Buffer.from('not a picture')), null)
  assert.deepEqual(fitImage({ width: 1200, height: 600 }, { width: 600, height: 720 }), { width: 600, height: 300 })
  assert.deepEqual(fitImage({ width: 40, height: 30 }, { width: 600, height: 720 }), { width: 40, height: 30 })
})
