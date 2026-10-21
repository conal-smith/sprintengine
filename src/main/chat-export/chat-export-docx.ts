import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type INumberingOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx'

import type {
  ChatExportDocument,
  ExportBlock,
  ExportImage,
  ExportInline,
  ExportPart,
  ExportTableAlign,
} from './chat-export-document'
import {
  contentHeadingLevel,
  exportedFromLine,
  exportHeaderLines,
  isExportableHref,
  messageHeading,
} from './chat-export-format'
import { exportPalette, type ExportPalette } from './chat-export-tokens'
import { fitImage, readExportImageInfo } from './chat-export-image'

// A chat as a Word document, written from the export's model with the `docx`
// library: headings are Word's headings, lists its numbered and bulleted
// lists, tables its tables, code a paragraph style of its own in a monospace
// face, links its hyperlinks and attached pictures pictures in the text, so
// the document can be edited as one written in Word could.
//
// Colours are the design system's light ones, read from its tokens. Word takes
// one face per style, not a stack, so each style names the face from the
// token's stack that every Office install has.

const UI_FACE = 'Arial'
const MONO_FACE = 'Consolas'

/** Twips: the page and its margins, by the paper the locale prints on. */
const PAGES = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
} as const
const MARGIN = 1134 // 2 cm
/** Pixels at 96 to the inch: the widest and tallest a picture is placed. */
const IMAGE_BOX = { width: 600, height: 720 }

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

type Palette = ExportPalette

export async function writeChatExportDocx(
  document: ChatExportDocument,
  options: { paper: 'A4' | 'Letter' },
): Promise<Buffer> {
  const colors = exportPalette()
  const writer = new DocxWriter(colors)
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(document.title)] }),
    ...exportHeaderLines(document).map(
      (line) =>
        new Paragraph({
          children: [new TextRun({ text: `${line.label}: `, bold: true }), new TextRun(line.value)],
        }),
    ),
    new Paragraph({ style: 'ExportMeta', children: [new TextRun(exportedFromLine(document))] }),
  ]
  for (const message of document.messages) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(messageHeading(message, document))] }),
    )
    if (message.kind === 'user') {
      children.push(...writer.blocks(message.blocks, 0, {}))
      for (const image of message.images) children.push(writer.image(image))
      if (message.files.length)
        children.push(
          new Paragraph({
            style: 'ExportMeta',
            children: [
              new TextRun('Attached files: '),
              ...message.files.flatMap((path, index) => [
                ...(index ? [new TextRun(', ')] : []),
                new TextRun({ text: path, font: MONO_FACE }),
              ]),
            ],
          }),
        )
    } else {
      for (const part of message.parts) children.push(...writer.part(part))
    }
  }
  const page = PAGES[options.paper]
  const doc = new Document({
    creator: document.generator,
    title: document.title,
    description: exportedFromLine(document),
    styles: styles(colors),
    numbering: writer.numbering(),
    sections: [
      {
        properties: {
          page: {
            size: page,
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                style: 'ExportMeta',
                children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES] })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })
  return Packer.toBuffer(doc)
}

function styles(colors: Palette) {
  const heading = (size: number) => ({
    run: { font: UI_FACE, size, bold: true, color: colors.strong },
    paragraph: { spacing: { before: 240, after: 80 }, keepNext: true },
  })
  return {
    default: {
      document: {
        run: { font: UI_FACE, size: 21, color: colors.text },
        paragraph: { spacing: { after: 120, line: 288 } },
      },
      title: {
        run: { font: UI_FACE, size: 44, bold: true, color: colors.strong },
        paragraph: { spacing: { after: 160 } },
      },
      // The author line: quieter than the reply under it.
      heading1: heading(30),
      heading2: {
        run: { font: UI_FACE, size: 18, bold: true, color: colors.muted },
        paragraph: {
          spacing: { before: 360, after: 80 },
          keepNext: true,
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: colors.border, space: 8 } },
        },
      },
      heading3: heading(26),
      heading4: heading(23),
      heading5: heading(21),
      heading6: heading(21),
      hyperlink: { run: { color: colors.accent, underline: {} } },
    },
    paragraphStyles: [
      {
        id: 'ExportCode',
        name: 'Code',
        basedOn: 'Normal',
        run: { font: MONO_FACE, size: 18, color: colors.strong },
        paragraph: {
          spacing: { before: 0, after: 0, line: 252 },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: colors.well },
          indent: { left: 120, right: 120 },
        },
      },
      {
        id: 'ExportCodeLabel',
        name: 'Code Label',
        basedOn: 'ExportCode',
        run: { font: MONO_FACE, size: 16, color: colors.muted },
        paragraph: { spacing: { before: 120, after: 0 }, keepNext: true },
      },
      {
        id: 'ExportMeta',
        name: 'Export Meta',
        basedOn: 'Normal',
        run: { size: 18, color: colors.muted },
      },
      {
        id: 'ExportStep',
        name: 'Step',
        basedOn: 'Normal',
        run: { size: 19, italics: true, color: colors.muted },
        paragraph: { spacing: { after: 60 } },
      },
      {
        id: 'ExportQuote',
        name: 'Quote Block',
        basedOn: 'Normal',
        run: { color: colors.muted },
        paragraph: {
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: colors.border, space: 8 } },
        },
      },
    ],
  }
}

type RunMarks = { bold?: boolean; italics?: boolean; strike?: boolean; style?: string }

/** Where a block sits: inside a quote, and how far in, in twips, under a list item. */
type Place = { quoted?: boolean; indent?: number }

class DocxWriter {
  private readonly starts = new Set<number>()
  private instance = 0

  constructor(private readonly colors: Palette) {}

  numbering(): INumberingOptions {
    const levels = (ordered: boolean, start: number): ILevelsOptions[] =>
      Array.from({ length: 9 }, (_, level) => ({
        level,
        format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
        text: ordered ? `%${level + 1}.` : BULLETS[level % BULLETS.length]!,
        alignment: AlignmentType.LEFT,
        start: level === 0 ? start : 1,
        style: { paragraph: { indent: { left: LIST_INDENT * (level + 1), hanging: 260 } } },
      }))
    return {
      config: [
        { reference: 'bullets', levels: levels(false, 1) },
        ...[1, ...[...this.starts].filter((start) => start !== 1)].map((start) => ({
          reference: `numbers-${start}`,
          levels: levels(true, start),
        })),
      ],
    }
  }

  part(node: ExportPart): Array<Paragraph | Table> {
    switch (node.kind) {
      case 'prose':
        return this.blocks(node.blocks, 0, {})
      case 'steps':
        return [
          new Paragraph({
            style: 'ExportStep',
            children: [
              new TextRun(node.text),
              ...(node.failed ? [new TextRun({ text: ` · ${node.failed} failed`, color: this.colors.danger })] : []),
            ],
          }),
        ]
      case 'agent':
        return [new Paragraph({ style: 'ExportStep', children: [new TextRun(node.text)] })]
      case 'note':
        return [
          new Paragraph({
            style: 'ExportStep',
            children: [new TextRun(node.tone === 'error' ? { text: node.text, color: this.colors.danger } : node.text)],
          }),
        ]
    }
  }

  blocks(list: readonly ExportBlock[], depth: number, place: Place): Array<Paragraph | Table> {
    return list.flatMap((block) => this.block(block, depth, place))
  }

  private block(node: ExportBlock, depth: number, place: Place): Array<Paragraph | Table> {
    const indent = place.indent ? { indent: { left: place.indent } } : {}
    switch (node.kind) {
      case 'heading':
        return [
          new Paragraph({
            heading: HEADINGS[contentHeadingLevel(node.level) - 1],
            ...indent,
            children: this.inlines(node.content),
          }),
        ]
      case 'paragraph':
        return [
          new Paragraph({
            ...(place.quoted ? { style: 'ExportQuote' } : {}),
            ...indent,
            children: this.inlines(node.content),
          }),
        ]
      case 'list':
        return this.list(node, depth, place)
      case 'code':
        return this.code(node.text, node.language, place.indent)
      case 'math':
        return this.code(node.tex, 'math', place.indent)
      case 'table':
        return [this.table(node)]
      case 'quote': {
        const label = node.alert
          ? [
              new Paragraph({
                style: 'ExportQuote',
                children: [new TextRun({ text: ALERT_LABELS[node.alert], bold: true })],
              }),
            ]
          : []
        return [...label, ...this.blocks(node.blocks, depth, { ...place, quoted: true })]
      }
      case 'rule':
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: this.colors.border, space: 1 } },
            children: [],
          }),
        ]
    }
  }

  private list(node: Extract<ExportBlock, { kind: 'list' }>, depth: number, place: Place): Array<Paragraph | Table> {
    const start = node.start ?? 1
    if (node.ordered) this.starts.add(start)
    const reference = node.ordered ? `numbers-${start}` : 'bullets'
    // Each list is a list of its own, so an ordered one counts from its own start.
    const instance = ++this.instance
    const level = Math.min(depth, 8)
    const under = { ...place, indent: LIST_INDENT * (level + 1) }
    const out: Array<Paragraph | Table> = []
    for (const item of node.items) {
      const box = item.checked === undefined ? [] : [new TextRun({ text: item.checked ? '☒ ' : '☐ ', font: MONO_FACE })]
      const marker = (children: ParagraphChild[]) =>
        new Paragraph({
          numbering: { reference, level, instance },
          ...(place.quoted ? { style: 'ExportQuote' } : {}),
          children,
        })
      const [first, ...rest] = item.blocks
      if (first?.kind === 'paragraph') out.push(marker([...box, ...this.inlines(first.content)]))
      else {
        out.push(marker(box))
        if (first) rest.unshift(first)
      }
      for (const block of rest) {
        if (block.kind === 'list') out.push(...this.list(block, depth + 1, place))
        else out.push(...this.block(block, depth + 1, under))
      }
    }
    return out
  }

  private code(text: string, language: string | undefined, indent: number | undefined): Paragraph[] {
    const left = (indent ?? 0) + 120
    const label = language
      ? [new Paragraph({ style: 'ExportCodeLabel', indent: { left, right: 120 }, children: [new TextRun(language)] })]
      : []
    const lines = text.replace(/\n$/u, '').split('\n')
    return [
      ...label,
      ...lines.map(
        (line, index) =>
          new Paragraph({
            style: 'ExportCode',
            indent: { left, right: 120 },
            // Room above a block that has no label, and under every block.
            spacing: { before: index === 0 && !label.length ? 120 : 0, after: index === lines.length - 1 ? 160 : 0 },
            children: [new TextRun({ text: line.replace(/\t/gu, '    ') || ' ' })],
          }),
      ),
    ]
  }

  private table(node: Extract<ExportBlock, { kind: 'table' }>): Table {
    const alignment = (align: ExportTableAlign) =>
      align === 'center' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT
    const row = (cells: readonly ExportInline[][], header: boolean) =>
      new TableRow({
        tableHeader: header,
        cantSplit: true,
        children: node.align.map(
          (align, index) =>
            new TableCell({
              ...(header ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: this.colors.well } } : {}),
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              children: [
                new Paragraph({
                  alignment: alignment(align),
                  spacing: { after: 0 },
                  children: this.inlines(cells[index] ?? [], header ? { bold: true } : {}),
                }),
              ],
            }),
        ),
      })
    const border = { style: BorderStyle.SINGLE, size: 4, color: this.colors.border }
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: border,
        bottom: border,
        left: border,
        right: border,
        insideHorizontal: border,
        insideVertical: border,
      },
      rows: [row(node.head, true), ...node.rows.map((cells) => row(cells, false))],
    })
  }

  image(image: ExportImage): Paragraph {
    const info = image.data ? readExportImageInfo(image.data) : null
    if (!image.data || !info)
      return new Paragraph({ style: 'ExportMeta', children: [new TextRun(`Attached image not shown: ${image.name}`)] })
    return new Paragraph({
      children: [
        new ImageRun({
          type: info.kind,
          data: image.data,
          transformation: fitImage(info, IMAGE_BOX),
          altText: { name: image.name, title: image.name, description: image.name },
        }),
      ],
    })
  }

  inlines(content: readonly ExportInline[], marks: RunMarks = {}): ParagraphChild[] {
    return content.flatMap((node) => this.inline(node, marks))
  }

  private inline(node: ExportInline, marks: RunMarks): ParagraphChild[] {
    const run = (options: IRunOptions) => new TextRun({ ...marks, ...options })
    switch (node.kind) {
      case 'text':
        return node.text.split('\n').map((line, index) => run({ text: line, ...(index ? { break: 1 } : {}) }))
      case 'strong':
        return this.inlines(node.children, { ...marks, bold: true })
      case 'emphasis':
        return this.inlines(node.children, { ...marks, italics: true })
      case 'delete':
        return this.inlines(node.children, { ...marks, strike: true })
      case 'code':
        return [
          run({
            text: node.text,
            font: MONO_FACE,
            size: 19,
            color: this.colors.strong,
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: this.colors.well },
          }),
        ]
      // Word has no TeX; the formula is its source, as the chat shows one it cannot set.
      case 'math':
        return [run({ text: node.tex, font: MONO_FACE, size: 19 })]
      case 'link': {
        if (!isExportableHref(node.href)) return this.inlines(node.children, marks)
        const children = this.inlines(node.children, { ...marks, style: 'Hyperlink' })
        return [
          new ExternalHyperlink({
            link: node.href,
            children: children.length ? children : [run({ text: node.href, style: 'Hyperlink' })],
          }),
        ]
      }
      case 'image': {
        const label = node.alt || node.src
        return isExportableHref(node.src)
          ? [new ExternalHyperlink({ link: node.src, children: [run({ text: label, style: 'Hyperlink' })] })]
          : [run({ text: label })]
      }
      case 'break':
        return [run({ break: 1 })]
    }
  }
}

const BULLETS = ['•', '◦', '▪']
/** Twips a list level steps in. */
const LIST_INDENT = 360
const ALERT_LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }
