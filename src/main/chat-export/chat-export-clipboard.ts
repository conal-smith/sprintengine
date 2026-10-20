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
import { escapeHtml } from './chat-export-html'
import { lightTokenValue, exportPalette, type ExportPalette } from './chat-export-tokens'

// A chat as the HTML a paste into an email or a document keeps: "Copy chat"
// puts it on the clipboard beside the Markdown, and the app that takes the
// paste chooses. Written from the export's model, as the files are.
//
// Mail is the reader to please, and mail is strict. A `<style>` block is
// dropped by webmail, a class means nothing outside the page that defined it,
// and a custom property is not read at all, so every rule is an inline style
// on plain tags (`h1`, `p`, `ul`, `table`, `pre`, `a`), with the design
// system's light colours as their values. No script, no frame, no form. A
// picture would be a data URL, which webmail strips from a paste or blocks as
// a tracking risk, so an attached picture is named in brackets instead:
// `[image: screenshot.png]`. Math is its TeX in a code span: mail has no
// MathML.
//
// Everything from the chat is escaped where it is written, as on the PDF's page.

type Styles = ReturnType<typeof inlineStyles>

function inlineStyles(colors: ExportPalette) {
  const ui = cssList(lightTokenValue('--sem-font-family-ui') ?? 'sans-serif')
  const mono = cssList(lightTokenValue('--sem-font-family-mono') ?? 'monospace')
  const hex = (value: string) => `#${value}`
  return {
    root: `font-family: ${ui}; font-size: 14px; line-height: 1.5; color: ${hex(colors.text)}; background: ${hex(colors.surface)};`,
    title: `margin: 0 0 8px; font-size: 22px; line-height: 1.25; color: ${hex(colors.strong)};`,
    fact: `margin: 0; color: ${hex(colors.text)};`,
    label: `color: ${hex(colors.muted)};`,
    generator: `margin: 8px 0 0; font-size: 12px; color: ${hex(colors.muted)};`,
    rule: `border: 0; border-top: 1px solid ${hex(colors.border)}; margin: 20px 0;`,
    author: `margin: 0 0 8px; font-size: 12px; font-weight: 600; color: ${hex(colors.muted)};`,
    heading: `margin: 16px 0 6px; line-height: 1.25; color: ${hex(colors.strong)};`,
    paragraph: 'margin: 0 0 10px;',
    list: 'margin: 0 0 10px; padding-left: 24px;',
    code: `font-family: ${mono}; font-size: 13px; background: ${hex(colors.well)}; color: ${hex(colors.strong)}; padding: 0 2px;`,
    pre: `margin: 0 0 10px; padding: 8px 10px; font-family: ${mono}; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; background: ${hex(colors.well)}; color: ${hex(colors.strong)}; border: 1px solid ${hex(colors.border)};`,
    caption: `margin: 0; font-family: ${mono}; font-size: 12px; color: ${hex(colors.muted)};`,
    table: 'border-collapse: collapse; margin: 0 0 10px;',
    th: `border: 1px solid ${hex(colors.border)}; padding: 4px 8px; text-align: left; background: ${hex(colors.well)}; color: ${hex(colors.strong)};`,
    td: `border: 1px solid ${hex(colors.border)}; padding: 4px 8px; text-align: left; vertical-align: top;`,
    quote: `margin: 0 0 10px; padding-left: 12px; border-left: 2px solid ${hex(colors.border)}; color: ${hex(colors.muted)};`,
    link: `color: ${hex(colors.accent)};`,
    step: `margin: 0 0 6px; font-size: 13px; font-style: italic; color: ${hex(colors.muted)};`,
    error: `color: ${hex(colors.danger)};`,
  }
}

// A font stack inside a `style="…"` attribute: its quotes become single ones.
function cssList(stack: string): string {
  return stack.replace(/"/gu, "'")
}

export function writeChatClipboardHtml(document: ChatExportDocument): string {
  const styles = inlineStyles(exportPalette())
  const writer = new ClipboardHtml(styles)
  const facts = exportHeaderLines(document)
    .map(
      (line) =>
        `<p style="${styles.fact}"><span style="${styles.label}">${escapeHtml(line.label)}:</span> ${escapeHtml(line.value)}</p>`,
    )
    .join('')
  const header = `<h1 style="${styles.title}">${escapeHtml(document.title)}</h1>${facts}<p style="${styles.generator}">${escapeHtml(exportedFromLine(document))}</p>`
  const messages = document.messages
    .map((message) => {
      const heading = `<h${MESSAGE_HEADING_LEVEL} style="${styles.author}">${escapeHtml(messageHeading(message, document))}</h${MESSAGE_HEADING_LEVEL}>`
      const body =
        message.kind === 'user'
          ? [
              writer.blocks(message.blocks),
              ...message.images.map((image) => writer.image(image)),
              message.files.length
                ? `<p style="${styles.step}">Attached files: ${message.files.map((path) => `<code style="${styles.code}">${escapeHtml(path)}</code>`).join(', ')}</p>`
                : '',
            ].join('')
          : message.parts.map((part) => writer.part(part)).join('')
      return `<hr style="${styles.rule}">${heading}${body}`
    })
    .join('')
  return `<div style="${styles.root}">${header}${messages}</div>`
}

class ClipboardHtml {
  constructor(private readonly styles: Styles) {}

  image(image: ExportImage): string {
    return `<p style="${this.styles.step}">[image: ${escapeHtml(image.name)}]</p>`
  }

  part(node: ExportPart): string {
    switch (node.kind) {
      case 'prose':
        return this.blocks(node.blocks)
      case 'steps':
        return `<p style="${this.styles.step}">${escapeHtml(node.text)}${node.failed ? ` <span style="${this.styles.error}">· ${node.failed} failed</span>` : ''}</p>`
      case 'agent':
        return `<p style="${this.styles.step}">${escapeHtml(node.text)}</p>`
      case 'note':
        return `<p style="${this.styles.step}${node.tone === 'error' ? ` ${this.styles.error}` : ''}">${escapeHtml(node.text)}</p>`
    }
  }

  blocks(list: readonly ExportBlock[]): string {
    return list.map((block) => this.block(block)).join('')
  }

  private block(node: ExportBlock): string {
    const s = this.styles
    switch (node.kind) {
      case 'heading': {
        const level = contentHeadingLevel(node.level)
        return `<h${level} style="${s.heading}">${this.inlines(node.content)}</h${level}>`
      }
      case 'paragraph':
        return `<p style="${s.paragraph}">${this.inlines(node.content)}</p>`
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul'
        const start = node.ordered && node.start !== undefined ? ` start="${node.start}"` : ''
        return `<${tag}${start} style="${s.list}">${node.items.map((item) => this.listItem(item)).join('')}</${tag}>`
      }
      case 'code': {
        const caption = node.language ? `<p style="${s.caption}">${escapeHtml(node.language)}</p>` : ''
        return `${caption}<pre style="${s.pre}"><code>${escapeHtml(node.text)}</code></pre>`
      }
      case 'math':
        return `<pre style="${s.pre}"><code>${escapeHtml(node.tex)}</code></pre>`
      case 'table': {
        const align = (index: number) => (node.align[index] ? ` text-align: ${node.align[index]};` : '')
        const head = node.head
          .map((cell, index) => `<th style="${s.th}${align(index)}">${this.inlines(cell)}</th>`)
          .join('')
        const rows = node.rows
          .map(
            (row) =>
              `<tr>${node.align.map((_, index) => `<td style="${s.td}${align(index)}">${this.inlines(row[index] ?? [])}</td>`).join('')}</tr>`,
          )
          .join('')
        return `<table style="${s.table}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
      }
      case 'quote': {
        const label = node.alert
          ? `<p style="${s.paragraph}"><strong>${escapeHtml(ALERT_LABELS[node.alert])}</strong></p>`
          : ''
        return `<blockquote style="${s.quote}">${label}${this.blocks(node.blocks)}</blockquote>`
      }
      case 'rule':
        return `<hr style="${s.rule}">`
    }
  }

  private listItem(item: ExportListItem): string {
    const box = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] '
    // A list item's first paragraph sits on the marker's line, as it does in the chat.
    const [first, ...rest] = item.blocks
    const lead = first?.kind === 'paragraph' ? `${escapeHtml(box)}${this.inlines(first.content)}` : escapeHtml(box)
    return `<li>${lead}${this.blocks(first?.kind === 'paragraph' ? rest : item.blocks)}</li>`
  }

  private inlines(content: readonly ExportInline[]): string {
    return content.map((node) => this.inline(node)).join('')
  }

  private inline(node: ExportInline): string {
    const s = this.styles
    switch (node.kind) {
      case 'text':
        return escapeHtml(node.text)
      case 'strong':
        return `<strong>${this.inlines(node.children)}</strong>`
      case 'emphasis':
        return `<em>${this.inlines(node.children)}</em>`
      case 'delete':
        return `<del>${this.inlines(node.children)}</del>`
      case 'code':
        return `<code style="${s.code}">${escapeHtml(node.text)}</code>`
      case 'math':
        return `<code style="${s.code}">${escapeHtml(node.tex)}</code>`
      case 'link':
        return isExportableHref(node.href)
          ? `<a href="${escapeHtml(node.href)}" style="${s.link}">${this.inlines(node.children)}</a>`
          : this.inlines(node.children)
      case 'image': {
        const label = escapeHtml(node.alt || node.src)
        return isExportableHref(node.src) ? `<a href="${escapeHtml(node.src)}" style="${s.link}">${label}</a>` : label
      }
      case 'break':
        return '<br>'
    }
  }
}

const ALERT_LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }
