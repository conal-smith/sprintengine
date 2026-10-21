import type {
  ChatExportDocument,
  ExportBlock,
  ExportImage,
  ExportInline,
  ExportListItem,
  ExportPart,
} from './chat-export-document'
import {
  contentHeadingLevel,
  exportedFromLine,
  exportHeaderLines,
  exportImageFileName,
  MESSAGE_HEADING_LEVEL,
  messageHeading,
} from './chat-export-format'

// A chat as GitHub-flavoured Markdown, written from the export's model.
//
// Pictures the person attached are written as files in a folder beside the
// document, named after it (`Release notes – 2026-10-20-files/image-1.png`),
// and the document links to each by its relative path, so the folder and the
// file travel together and a viewer that renders Markdown shows them in
// place. One that could not be read back is named in a line instead.

export type MarkdownExport = {
  markdown: string
  /** The pictures to write, by their path relative to the document. */
  files: { path: string; data: Uint8Array }[]
}

/**
 * `assetFolder` is the folder's name, beside the document. Null for Markdown
 * that goes on the clipboard, which has no folder beside it: each picture is
 * named in brackets instead, `[image: screenshot.png]`.
 */
export function writeChatExportMarkdown(document: ChatExportDocument, assetFolder: string | null): MarkdownExport {
  const files: MarkdownExport['files'] = []
  const sections: string[] = [`# ${escapeText(document.title)}`]
  const facts = exportHeaderLines(document).map((line) => `**${line.label}:** ${escapeText(line.value)}`)
  sections.push([...facts, `*${escapeText(exportedFromLine(document))}*`].join('  \n'))
  for (const message of document.messages) {
    sections.push('---')
    sections.push(`${'#'.repeat(MESSAGE_HEADING_LEVEL)} ${escapeText(messageHeading(message, document))}`)
    if (message.kind === 'user') {
      if (message.blocks.length) sections.push(blocks(message.blocks))
      const pictures = message.images.map((image) => picture(image, files, assetFolder))
      if (pictures.length) sections.push(pictures.join('\n\n'))
      if (message.files.length) sections.push(`Attached files: ${message.files.map((path) => code(path)).join(', ')}`)
    } else {
      for (const part of message.parts) sections.push(partOf(part))
    }
  }
  return { markdown: `${sections.filter(Boolean).join('\n\n')}\n`, files }
}

function picture(image: ExportImage, files: MarkdownExport['files'], assetFolder: string | null): string {
  // Brackets with no link after them are the words they are, in Markdown and in mail.
  if (assetFolder === null) return `[image: ${escapeText(image.name)}]`
  if (!image.data) return `*Attached image not available: ${escapeText(image.name)}*`
  const path = `${assetFolder}/${exportImageFileName(image, files.length)}`
  files.push({ path, data: image.data })
  return `![${escapeText(image.name)}](${encodePath(path)})`
}

function partOf(part: ExportPart): string {
  switch (part.kind) {
    case 'prose':
      return blocks(part.blocks)
    case 'steps':
      return `*${escapeText(part.text)}${part.failed ? ` · ${part.failed} failed` : ''}*`
    case 'agent':
      return `*${escapeText(part.text)}*`
    case 'note':
      return part.tone === 'error' ? `**${escapeText(part.text)}**` : `*${escapeText(part.text)}*`
  }
}

function blocks(list: readonly ExportBlock[]): string {
  return list.map(block).join('\n\n')
}

function block(node: ExportBlock): string {
  switch (node.kind) {
    case 'heading':
      return `${'#'.repeat(contentHeadingLevel(node.level))} ${inlines(node.content)}`
    case 'paragraph':
      return inlines(node.content)
    case 'list':
      return node.items
        .map((item, index) => listItem(item, node.ordered ? `${(node.start ?? 1) + index}.` : '-'))
        .join('\n')
    case 'code': {
      const fence = '`'.repeat(Math.max(3, longestRun(node.text, '`') + 1))
      return `${fence}${node.language ?? ''}\n${node.text}\n${fence}`
    }
    case 'math':
      return `$$\n${node.tex}\n$$`
    case 'table':
      return table(node)
    case 'quote': {
      const body = blocks(node.blocks)
      const lead = node.alert ? `[!${node.alert.toUpperCase()}]\n` : ''
      return `${lead}${body}`
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')
    }
    case 'rule':
      return '***'
  }
}

function listItem(item: ExportListItem, marker: string): string {
  const task = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] '
  const indent = ' '.repeat(marker.length + 1)
  // A nested list follows its line directly, so a tight list stays tight; any
  // other block after the first is a paragraph of its own.
  const body = item.blocks
    .map((child, index) => (index === 0 ? '' : child.kind === 'list' ? '\n' : '\n\n') + block(child))
    .join('')
  const [first = '', ...rest] = body.split('\n')
  return [`${marker} ${task}${first}`, ...rest.map((line) => (line ? `${indent}${line}` : ''))].join('\n')
}

function table(node: Extract<ExportBlock, { kind: 'table' }>): string {
  const cell = (content: readonly ExportInline[]) => inlines(content).replace(/\|/gu, '\\|').replace(/\n/gu, '<br>')
  const row = (cells: readonly ExportInline[][]) =>
    `| ${node.align.map((_, index) => cell(cells[index] ?? [])).join(' | ')} |`
  const rule = `| ${node.align
    .map((align) => (align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---'))
    .join(' | ')} |`
  return [row(node.head), rule, ...node.rows.map(row)].join('\n')
}

function inlines(content: readonly ExportInline[]): string {
  return content.map(inline).join('')
}

function inline(node: ExportInline): string {
  switch (node.kind) {
    case 'text':
      return escapeText(node.text)
    case 'strong':
      return `**${inlines(node.children)}**`
    case 'emphasis':
      return `*${inlines(node.children)}*`
    case 'delete':
      return `~~${inlines(node.children)}~~`
    case 'code':
      return code(node.text)
    case 'math':
      return `$$${node.tex}$$`
    case 'link':
      return `[${inlines(node.children)}](${destination(node.href)})`
    case 'image':
      return `![${escapeText(node.alt)}](${destination(node.src)})`
    case 'break':
      return '\\\n'
  }
}

function code(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

// Text as text: every character Markdown would read as a mark is escaped, so
// a reply that wrote `\*` gets its star back as a star. Only where it would be
// read as one: an underscore inside a word is not a mark in GitHub's Markdown,
// so `snake_case` stays as written, and `>` and `#` are marks only at the
// start of a line. A dollar is escaped because GitHub reads `$…$` as math.
function escapeText(text: string): string {
  return text
    .replace(/[\\`*[\]<~$]/gu, '\\$&')
    .replace(/&(?=#?[\p{L}\p{N}]+;)/gu, '\\&')
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (match) => match.replace('_', '\\_'))
    .replace(/^([ \t]*)>/gmu, '$1\\>')
    .replace(/^([ \t]*)([#+-]|\d+[.)])(?=[ \t]|$)/gmu, '$1\\$2')
}

function destination(href: string): string {
  return /[\s()<>]/u.test(href) ? `<${href.replace(/[<>]/gu, encodeURIComponent)}>` : href
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const each of text) {
    run = each === char ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}
