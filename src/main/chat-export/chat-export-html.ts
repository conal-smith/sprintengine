import katex from 'katex'

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
  isExportableHref,
  MESSAGE_HEADING_LEVEL,
  messageHeading,
} from './chat-export-format'
import { lightTokenValue, solidTokenColor, tokensCss } from './chat-export-tokens'

// A chat as the page its PDF is printed from, written from the export's model.
//
// Everything in it that came from the chat is escaped where it is written, so
// a reply holding `<script>` prints the word. The page loads nothing: its
// stylesheet is inline, its pictures are data URLs, its policy allows no other
// source, and the window that prints it runs no script and answers no request
// (chat-export-pdf.ts). A link to the web stays a link in the PDF; a picture a
// reply points at on the web is printed as that link, never fetched.
//
// It is set in the app's own type and colours, in light mode, from the design
// system's tokens: the token sheet is carried whole and the rules below read
// only its `--sem-*` names.

/** The pictures a page may carry, by the types Chromium draws and the export writes. */
const PRINTABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

// Math is set as MathML, which Chromium lays out itself: no script, and no
// font files for the window to load. `trust: false` refuses `\href` and raw
// HTML, so KaTeX's output is its own markup around escaped text, as the chat's
// typesetter relies on (renderer/src/lib/math/typesetMath.ts).
const KATEX_OPTIONS = {
  output: 'mathml' as const,
  throwOnError: true,
  trust: false,
  strict: 'ignore' as const,
  maxExpand: 1000,
  maxSize: 20,
}

const STYLE = `
@page { size: auto; }
:root { color-scheme: light; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  background: var(--sem-color-bg-surface);
  color: var(--sem-color-text-default);
  font-family: var(--sem-font-family-ui);
  font-size: var(--sem-font-size-heading);
  line-height: var(--sem-font-line-relaxed);
  overflow-wrap: break-word;
}
header.document { padding-bottom: var(--sem-space-xl); border-bottom: 1px solid var(--sem-color-border-default); }
header.document h1 {
  margin: 0 0 var(--sem-space-sm);
  color: var(--sem-color-text-primary);
  font-size: var(--sem-font-size-display);
  font-weight: var(--sem-font-weight-emphasis);
  line-height: var(--sem-font-line-tight);
  letter-spacing: var(--sem-font-tracking-tight);
}
header.document dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--sem-space-3xs) var(--sem-space-lg); margin: 0; }
header.document dt { color: var(--sem-color-text-muted); }
header.document dd { margin: 0; color: var(--sem-color-text-primary); }
header.document p.generator { margin: var(--sem-space-sm) 0 0; color: var(--sem-color-text-muted); font-size: var(--sem-font-size-meta); }
article.message { padding-top: var(--sem-space-2xl); }
article.message + article.message { border-top: 1px solid var(--sem-color-border-subtle); margin-top: var(--sem-space-2xl); }
h2.author {
  margin: 0 0 var(--sem-space-sm);
  color: var(--sem-color-text-muted);
  font-size: var(--sem-font-size-meta);
  font-weight: var(--sem-font-weight-medium);
  break-after: avoid;
}
article.user .body {
  padding: var(--sem-space-sm) var(--sem-space-lg);
  border: 1px solid var(--sem-color-border-subtle);
  border-radius: var(--sem-radius-control);
  background: var(--sem-color-bg-well);
  color: var(--sem-color-text-primary);
}
.body > :first-child { margin-top: 0; }
.body > :last-child { margin-bottom: 0; }
p, ul, ol, table, pre, blockquote, figure, .math { margin: 0 0 var(--sem-space-md); }
h3, h4, h5, h6 { color: var(--sem-color-text-primary); font-weight: var(--sem-font-weight-emphasis); line-height: var(--sem-font-line-tight); margin: var(--sem-space-xl) 0 var(--sem-space-xs); break-after: avoid; }
h3 { font-size: var(--sem-font-size-title); }
h4, h5, h6 { font-size: var(--sem-font-size-heading); }
strong { color: var(--sem-color-text-primary); font-weight: var(--sem-font-weight-emphasis); }
a { color: var(--sem-color-accent-primary); }
ul, ol { padding-left: var(--sem-space-3xl); }
li > ul, li > ol, li > p { margin-bottom: var(--sem-space-2xs); }
li.task { list-style: none; }
li.task > .box { font-family: var(--sem-font-family-mono); margin-left: calc(-1 * var(--sem-space-xl)); margin-right: var(--sem-space-2xs); }
code, pre { font-family: var(--sem-font-family-mono); font-size: var(--sem-font-size-body); }
:not(pre) > code { padding: 0 var(--sem-space-3xs); border-radius: var(--sem-radius-chip); background: var(--sem-color-bg-well); color: var(--sem-color-text-primary); }
figure.code { border: 1px solid var(--sem-color-border-subtle); border-radius: var(--sem-radius-control); background: var(--sem-color-bg-well); }
figure.code figcaption { padding: var(--sem-space-2xs) var(--sem-space-md); border-bottom: 1px solid var(--sem-color-border-subtle); color: var(--sem-color-text-muted); font-family: var(--sem-font-family-mono); font-size: var(--sem-font-size-meta); }
figure.code pre { margin: 0; padding: var(--sem-space-sm) var(--sem-space-md); line-height: var(--sem-font-line-code); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--sem-color-text-primary); }
table { border-collapse: collapse; width: 100%; font-size: var(--sem-font-size-body); break-inside: auto; }
th, td { border: 1px solid var(--sem-color-border-default); padding: var(--sem-space-2xs) var(--sem-space-sm); vertical-align: top; text-align: left; }
th { background: var(--sem-color-bg-well); color: var(--sem-color-text-primary); font-weight: var(--sem-font-weight-emphasis); }
tr { break-inside: avoid; }
blockquote { padding-left: var(--sem-space-lg); border-left: 2px solid var(--sem-color-border-default); color: var(--sem-color-text-muted); }
blockquote .alert { color: var(--sem-color-text-primary); font-weight: var(--sem-font-weight-emphasis); }
hr { border: 0; border-top: 1px solid var(--sem-color-border-default); margin: var(--sem-space-xl) 0; }
.math.display { text-align: center; }
figure.image { margin-top: var(--sem-space-md); break-inside: avoid; }
figure.image img { display: block; max-width: 100%; max-height: 120mm; border: 1px solid var(--sem-color-border-subtle); border-radius: var(--sem-radius-control); }
figure.image figcaption, p.missing, p.files { color: var(--sem-color-text-muted); font-size: var(--sem-font-size-meta); }
p.steps, p.agent, p.note { color: var(--sem-color-text-muted); font-size: var(--sem-font-size-body); margin-bottom: var(--sem-space-xs); }
p.steps .failed, p.note.error { color: var(--sem-color-status-danger); }
`

export function buildChatExportHtml(document: ChatExportDocument): string {
  const facts = exportHeaderLines(document)
    .map((line) => `<dt>${escapeHtml(line.label)}</dt><dd>${escapeHtml(line.value)}</dd>`)
    .join('')
  const header = `<header class="document"><h1>${escapeHtml(document.title)}</h1>${facts ? `<dl>${facts}</dl>` : ''}<p class="generator">${escapeHtml(exportedFromLine(document))}</p></header>`
  const messages = document.messages
    .map((message) => {
      const heading = `<h${MESSAGE_HEADING_LEVEL} class="author">${escapeHtml(messageHeading(message, document))}</h${MESSAGE_HEADING_LEVEL}>`
      if (message.kind === 'user') {
        const files = message.files.length
          ? `<p class="files">Attached files: ${message.files.map((path) => `<code>${escapeHtml(path)}</code>`).join(', ')}</p>`
          : ''
        const body = message.blocks.length ? `<div class="body">${blocks(message.blocks)}</div>` : ''
        return `<article class="message user">${heading}${body}${message.images.map(image).join('')}${files}</article>`
      }
      return `<article class="message assistant">${heading}<div class="body">${message.parts.map(part).join('')}</div></article>`
    })
    .join('')
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(document.locale)}">`,
    '<head>',
    '<meta charset="utf-8">',
    // Nothing may load: no script, no frame, no fetch, and pictures only from
    // the page itself.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(document.title)}</title>`,
    `<style>${tokensCss}\n${STYLE}</style>`,
    '</head>',
    `<body>${header}<main>${messages}</main></body>`,
    '</html>',
  ].join('\n')
}

function image(picture: ExportImage): string {
  const type = picture.mediaType.toLowerCase()
  if (!picture.data || !PRINTABLE_IMAGE_TYPES.has(type))
    return `<p class="missing">Attached image not shown: ${escapeHtml(picture.name)}</p>`
  const source = `data:${type};base64,${Buffer.from(picture.data).toString('base64')}`
  return `<figure class="image"><img src="${source}" alt="${escapeHtml(picture.name)}"><figcaption>${escapeHtml(picture.name)}</figcaption></figure>`
}

function part(node: ExportPart): string {
  switch (node.kind) {
    case 'prose':
      return blocks(node.blocks)
    case 'steps':
      return `<p class="steps">${escapeHtml(node.text)}${node.failed ? ` <span class="failed">· ${node.failed} failed</span>` : ''}</p>`
    case 'agent':
      return `<p class="agent">${escapeHtml(node.text)}</p>`
    case 'note':
      return `<p class="note${node.tone === 'error' ? ' error' : ''}">${escapeHtml(node.text)}</p>`
  }
}

function blocks(list: readonly ExportBlock[]): string {
  return list.map(block).join('')
}

function block(node: ExportBlock): string {
  switch (node.kind) {
    case 'heading': {
      // A reply's `#` sits under its message's heading; past h6 is still h6.
      const level = contentHeadingLevel(node.level)
      return `<h${level}>${inlines(node.content)}</h${level}>`
    }
    case 'paragraph':
      return `<p>${inlines(node.content)}</p>`
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const start = node.ordered && node.start !== undefined ? ` start="${node.start}"` : ''
      return `<${tag}${start}>${node.items.map(listItem).join('')}</${tag}>`
    }
    case 'code': {
      const caption = node.language ? `<figcaption>${escapeHtml(node.language)}</figcaption>` : ''
      return `<figure class="code">${caption}<pre><code>${escapeHtml(node.text)}</code></pre></figure>`
    }
    case 'math':
      return `<div class="math display">${math(node.tex, true)}</div>`
    case 'table': {
      const align = (index: number) => {
        const value = node.align[index]
        return value ? ` style="text-align: ${value}"` : ''
      }
      const head = `<thead><tr>${node.head.map((cell, index) => `<th${align(index)}>${inlines(cell)}</th>`).join('')}</tr></thead>`
      const body = node.rows
        .map(
          (row) =>
            `<tr>${node.align.map((_, index) => `<td${align(index)}>${inlines(row[index] ?? [])}</td>`).join('')}</tr>`,
        )
        .join('')
      return `<table>${head}<tbody>${body}</tbody></table>`
    }
    case 'quote': {
      const label = node.alert ? `<p class="alert">${escapeHtml(ALERT_LABELS[node.alert])}</p>` : ''
      return `<blockquote>${label}${blocks(node.blocks)}</blockquote>`
    }
    case 'rule':
      return '<hr>'
  }
}

const ALERT_LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }

function listItem(item: ExportListItem): string {
  if (item.checked === undefined) return `<li>${blocks(item.blocks)}</li>`
  return `<li class="task"><span class="box">${item.checked ? '[x]' : '[ ]'}</span>${blocks(item.blocks)}</li>`
}

function inlines(content: readonly ExportInline[]): string {
  return content.map(inline).join('')
}

function inline(node: ExportInline): string {
  switch (node.kind) {
    case 'text':
      return escapeHtml(node.text)
    case 'strong':
      return `<strong>${inlines(node.children)}</strong>`
    case 'emphasis':
      return `<em>${inlines(node.children)}</em>`
    case 'delete':
      return `<del>${inlines(node.children)}</del>`
    case 'code':
      return `<code>${escapeHtml(node.text)}</code>`
    case 'math':
      return `<span class="math">${math(node.tex, false)}</span>`
    case 'link':
      return isExportableHref(node.href)
        ? `<a href="${escapeHtml(node.href)}">${inlines(node.children)}</a>`
        : inlines(node.children)
    case 'image': {
      const label = escapeHtml(node.alt || node.src)
      return isExportableHref(node.src) ? `<a href="${escapeHtml(node.src)}">${label}</a>` : label
    }
    case 'break':
      return '<br>'
  }
}

/** A formula as MathML; one that does not parse is its source, as the chat shows it. */
function math(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display })
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]!)
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** What the page is printed with: the paper, its margins, and the page number at its foot. */
export function chatExportPrintOptions(paper: 'A4' | 'Letter') {
  // The footer is a document of its own, outside the page's stylesheet, so it
  // takes the tokens' values rather than their names.
  const ink = `#${solidTokenColor('--sem-color-text-muted')}`
  const family = escapeHtml(lightTokenValue('--sem-font-family-ui') ?? 'sans-serif')
  return {
    pageSize: paper,
    printBackground: true,
    // Inches: about 18 mm at the sides, with room at the foot for the number.
    margins: { top: 0.7, bottom: 0.8, left: 0.7, right: 0.7 },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width: 100%; text-align: center; font-family: ${family}; font-size: 8px; color: ${ink};"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  }
}
