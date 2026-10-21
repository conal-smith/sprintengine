import type { ChatExportDocument, ExportImage, ExportInline } from './chat-export-document'

// What the three writers say the same way: the header's lines, how a time is
// written, how deep a reply's own headings sit, and what an attached picture
// is called on disk.

/** Letter in the countries that print on it; A4 everywhere else. */
const LETTER_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'CL',
  'CO',
  'VE',
  'CR',
  'GT',
  'PA',
  'SV',
  'DO',
  'NI',
  'PR',
  'BZ',
])

/** The paper a document is laid out on, by the region the app's locale names. */
export function paperSizeForRegion(region: string | null | undefined): 'A4' | 'Letter' {
  return region && LETTER_REGIONS.has(region.toUpperCase()) ? 'Letter' : 'A4'
}

/** The level a message's author heading takes; the title is the level above. */
export const MESSAGE_HEADING_LEVEL = 2

/** A reply's own heading, pushed under its message's, and never past the deepest. */
export function contentHeadingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, level + MESSAGE_HEADING_LEVEL)) as 1 | 2 | 3 | 4 | 5 | 6
}

function dateTimeFormat(document: Pick<ChatExportDocument, 'locale' | 'timeZone'>): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(document.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: document.timeZone,
    })
  } catch {
    // A locale or zone this runtime does not know still writes a date.
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
  }
}

/** A moment as the document writes it: "20 Oct 2026, 09:12". */
export function formatExportTime(at: number, document: Pick<ChatExportDocument, 'locale' | 'timeZone'>): string {
  return dateTimeFormat(document).format(at)
}

/** The span a chat covers: one day's times share its date ("20 Oct 2026, 09:12 – 10:03"). */
export function formatExportRange(document: ChatExportDocument): string | null {
  const { startedAt, endedAt } = document
  if (startedAt === undefined) return endedAt === undefined ? null : formatExportTime(endedAt, document)
  if (endedAt === undefined || endedAt <= startedAt) return formatExportTime(startedAt, document)
  return dateTimeFormat(document).formatRange(startedAt, endedAt)
}

export type ExportHeaderLine = { label: string; value: string }

/** The facts under the title, in order, each only when known. */
export function exportHeaderLines(document: ChatExportDocument): ExportHeaderLine[] {
  const lines: ExportHeaderLine[] = []
  if (document.project) lines.push({ label: 'Project', value: document.project })
  const agent = [document.engine, document.model].filter(Boolean).join(' · ')
  if (agent) lines.push({ label: 'Agent', value: agent })
  const range = formatExportRange(document)
  if (range) lines.push({ label: 'Date', value: range })
  return lines
}

/** The line that says where the document came from. */
export function exportedFromLine(document: ChatExportDocument): string {
  return `Exported from ${document.generator} on ${formatExportTime(document.exportedAt, document)}`
}

/** A message's heading: who said it, and when. */
export function messageHeading(
  message: { author: string; at?: number },
  document: Pick<ChatExportDocument, 'locale' | 'timeZone'>,
): string {
  return message.at === undefined ? message.author : `${message.author} · ${formatExportTime(message.at, document)}`
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

/** The file name an attached picture is written under, numbered in the order the chat shows them. */
export function exportImageFileName(image: ExportImage, index: number): string {
  return `image-${index + 1}.${EXTENSIONS[image.mediaType.toLowerCase()] ?? 'bin'}`
}

/** The words of some inline content, without its marks: a table cell's fallback, an image's name. */
export function plainText(content: readonly ExportInline[]): string {
  return content
    .map((inline) => {
      switch (inline.kind) {
        case 'text':
        case 'code':
          return inline.text
        case 'math':
          return inline.tex
        case 'break':
          return '\n'
        case 'image':
          return inline.alt
        default:
          return plainText(inline.children)
      }
    })
    .join('')
}

/** A link a document may carry as a link: the web and mail. A file path or a script is written as words. */
export function isExportableHref(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}
