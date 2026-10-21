// Copying a selection out of a rendered conversation, as the markdown it was.
//
// The browser's own copy flattens a reply to its visible text: a heading loses
// its level, a list its markers, a code block its fence and language, a table
// its columns, and the header chrome of every code block and table comes along
// as stray words. What a person pastes a reply into — an issue, a document, the
// composer of another chat — reads markdown, so the plain-text flavour is the
// selected DOM written back as markdown. The HTML flavour is the same fragment
// with the app's chrome, classes and handlers stripped, for a rich editor.
//
// The HTML takes the same inline styles a copy button's does
// (`pasteStyles.ts`), so a selection and a button paste alike.
//
// Chrome is anything marked `data-copy-exclude`, plus what is never content:
// hidden and screen-reader-only nodes, glyphs, form controls, timestamps, and a
// button that is not set inside prose. A button inside prose stays, because the
// conversation renders a file path as one and its text is the path.

import { pasteCellStyle, PASTE_STYLES, pasteTaskBox } from './pasteStyles'

export type SelectionClipboard = { text: string; html: string }

const ELEMENT_NODE = 1
const TEXT_NODE = 3

// A code block's root: the kit's block marks itself, and its language is read
// from the root first, then from a `language-*` class on the code inside.
const CODE_BLOCK_ROOT = '[data-code-block], [data-code-language], .ds-code-block'
const PLAIN_LANGUAGES = new Set(['', 'text', 'plaintext', 'plain', 'txt'])

// Never content, whatever surrounds them.
const DROPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'TEXTAREA',
  'SELECT',
  'INPUT',
  // A message's time is row chrome that happens to be text.
  'TIME',
])
const HIDDEN_CLASSES = ['sr-only', 'visually-hidden', 'select-none']

// Elements whose children flow as text: a button directly inside one of these
// is part of a sentence (a file path), anywhere else it is a control. A bare
// `span` is not among them — it is what a tooltip wraps its trigger in.
const PHRASING_PARENTS = new Set([
  'P',
  'LI',
  'TD',
  'TH',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'A',
  'STRONG',
  'B',
  'EM',
  'I',
  'DEL',
  'S',
  'STRIKE',
  'CODE',
  'SUMMARY',
])

// Containers whose whitespace-only text is the renderer's formatting between
// blocks, not a space the reader sees.
const BLOCK_CONTAINERS = new Set([
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'NAV',
  'FIGURE',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'DETAILS',
])

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

function isChrome(element: Element, parentTag: string): boolean {
  if (DROPPED_TAGS.has(element.tagName) || element.localName === 'svg') return true
  if (element.hasAttribute('data-copy-exclude') || element.hasAttribute('hidden')) return true
  if (element.getAttribute('aria-hidden') === 'true') return true
  if (HIDDEN_CLASSES.some((name) => element.classList.contains(name))) return true
  return element.tagName === 'BUTTON' && !PHRASING_PARENTS.has(parentTag)
}

function isCodeBlockRoot(element: Element): boolean {
  return element.tagName === 'PRE' || element.matches(CODE_BLOCK_ROOT)
}

function codeBlockLanguage(root: Element): string {
  const declared =
    root.getAttribute('data-code-language') ??
    root.getAttribute('data-language') ??
    /(?:^|\s)language-(\S+)/u.exec(root.querySelector('code')?.getAttribute('class') ?? '')?.[1] ??
    ''
  return PLAIN_LANGUAGES.has(declared.toLowerCase()) ? '' : declared
}

// The code itself: the `pre`'s text, never the header's label or a note under
// the block. A block with no `pre` left in it (a range that ended in the
// header) has no code to give.
function codeBlockText(root: Element): string {
  const pre = root.tagName === 'PRE' ? root : root.querySelector('pre')
  return (pre?.textContent ?? '').replace(/\n$/u, '')
}

// A typeset formula is drawn twice over — MathML for a screen reader, HTML for
// the eye — and neither reads back as what was written. The renderer keeps the
// TeX on the formula's root (`markdownMath.tsx`).
function typesetMath(element: Element): { tex: string; display: boolean } | null {
  const kind = element.getAttribute('data-math')
  const tex = element.getAttribute('data-tex')
  return kind && tex !== null ? { tex, display: kind === 'display' } : null
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let current = 0
  for (const ch of text) {
    current = ch === char ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}

function fencedCode(code: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1))
  return `${fence}${language}\n${code}\n${fence}`
}

// A backtick run inside the code needs a longer fence around it, and code that
// starts or ends with a backtick (or is padded on both sides) needs a space the
// parser strips again.
function inlineCode(code: string): string {
  const fence = '`'.repeat(longestRun(code, '`') + 1)
  const pad = /^`|`$/u.test(code) || (/^ .*[^ ].* $/u.test(code) && code.length > 2) ? ' ' : ''
  return `${fence}${pad}${code}${pad}${fence}`
}

// Emphasis markers hug the words: `** bold **` does not parse, so the spaces a
// selection took with it go outside the markers.
function wrapInline(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(content)
  const core = match?.[2] ?? ''
  if (!core) return content
  return `${match?.[1] ?? ''}${marker}${core}${marker}${match?.[3] ?? ''}`
}

function block(content: string): string {
  const trimmed = content.trim()
  return trimmed ? `\n\n${trimmed}\n\n` : ''
}

function isSafeHref(href: string): boolean {
  return /^(?:https?:|mailto:)/iu.test(href)
}

function linkMarkdown(anchor: Element, label: string): string {
  const href = anchor.getAttribute('href') ?? ''
  const text = label.trim()
  if (!text) return ''
  if (!isSafeHref(href)) return label
  if (text === href) return href
  const target = /[\s()<>]/u.test(href) ? `<${href}>` : href
  return `[${text.replace(/([[\]])/gu, '\\$1')}](${target})`
}

function imageMarkdown(image: Element): string {
  const alt = image.getAttribute('alt') ?? ''
  const src = image.getAttribute('src') ?? ''
  if (isSafeHref(src)) return `![${alt}](${src})`
  return alt
}

// Blank lines outside fenced code collapse to one — or to none, for a tight
// list item whose nested list must stay on the next line. Fenced code keeps
// every line it had.
function normaliseBlankLines(markdown: string, keepBlank: boolean): string {
  const out: string[] = []
  let fence: string | null = null
  let pendingBlank = false
  for (const raw of markdown.split('\n')) {
    const bare = raw.replace(/^[\s>]*/u, '')
    if (fence !== null) {
      out.push(raw)
      if (bare.startsWith(fence) && /^`+\s*$/u.test(bare)) fence = null
      continue
    }
    const line = raw.replace(/[ \t]+$/u, '')
    if (!line.trim()) {
      pendingBlank = out.length > 0
      continue
    }
    if (pendingBlank && keepBlank) out.push('')
    pendingBlank = false
    out.push(line)
    const opening = /^(`{3,})/u.exec(bare)?.[1]
    if (opening) fence = opening
  }
  return out.join('\n')
}

function checkboxState(item: Element): boolean | null {
  const box = Array.from(item.querySelectorAll('input[type="checkbox"]')).find((input) => input.closest('li') === item)
  if (!box) return null
  return (box as HTMLInputElement).checked === true || box.getAttribute('aria-checked') === 'true'
}

function listItem(item: Element, marker: string): string {
  const task = checkboxState(item)
  const loose = Array.from(item.children).some((child) => child.tagName === 'P')
  const content = normaliseBlankLines(children(item), loose).trim()
  if (!content && task === null) return ''
  const lead = `${marker}${task === null ? '' : task ? '[x] ' : '[ ] '}`
  const indent = ' '.repeat(marker.length)
  const [first = '', ...rest] = content.split('\n')
  return [`${lead}${first}`.trimEnd(), ...rest.map((line) => (line ? `${indent}${line}` : line))].join('\n')
}

function list(element: Element): string {
  const ordered = element.tagName === 'OL'
  let next = Number.parseInt(element.getAttribute('start') ?? '1', 10)
  if (!Number.isFinite(next)) next = 1
  const items: string[] = []
  const loose = Array.from(element.children).some((item) =>
    Array.from(item.children).some((child) => child.tagName === 'P'),
  )
  for (const item of Array.from(element.children)) {
    if (item.tagName !== 'LI') continue
    const value = Number.parseInt(item.getAttribute('value') ?? '', 10)
    if (Number.isFinite(value)) next = value
    const written = listItem(item, ordered ? `${next}. ` : '- ')
    next += 1
    if (written) items.push(written)
  }
  return block(items.join(loose ? '\n\n' : '\n'))
}

function quote(content: string, first?: string): string {
  const body = normaliseBlankLines(content, true).trim()
  const lines = [...(first ? [first] : []), ...(body ? body.split('\n') : [])]
  if (!lines.length) return ''
  return block(lines.map((line) => (line ? `> ${line}` : '>')).join('\n'))
}

function cell(element: Element): string {
  return children(element)
    .replace(/\s*\n\s*/gu, ' ')
    .trim()
    .replace(/\|/gu, '\\|')
}

function alignmentMarker(element: Element | undefined): string {
  const align = (
    element?.getAttribute('align') ??
    (element as HTMLElement | undefined)?.style?.textAlign ??
    ''
  ).toLowerCase()
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

function table(element: Element): string {
  const rows = Array.from(element.querySelectorAll('tr')).filter((row) => row.closest('table') === element)
  const cells = rows
    .map((row) => Array.from(row.children).filter((child) => child.tagName === 'TH' || child.tagName === 'TD'))
    .filter((row) => row.length > 0)
  if (!cells.length) return ''
  const width = Math.max(...cells.map((row) => row.length))
  const line = (row: Element[]) =>
    `| ${Array.from({ length: width }, (_, index) => (row[index] ? cell(row[index]) : '')).join(' | ')} |`
  const header = cells[0]
  const separator = `| ${Array.from({ length: width }, (_, index) => alignmentMarker(header[index])).join(' | ')} |`
  return block([line(header), separator, ...cells.slice(1).map(line)].join('\n'))
}

function children(node: Node): string {
  const parentTag = isElement(node) ? node.tagName : 'DIV'
  let out = ''
  for (const child of Array.from(node.childNodes)) out += serialise(child, parentTag)
  return out
}

function serialise(node: Node, parentTag: string): string {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent ?? ''
    if (!text.trim() && text.includes('\n') && BLOCK_CONTAINERS.has(parentTag)) return ''
    return text
  }
  if (!isElement(node) || isChrome(node, parentTag)) return ''
  const element = node

  if (isCodeBlockRoot(element)) {
    const code = codeBlockText(element)
    return code ? block(fencedCode(code, codeBlockLanguage(element))) : ''
  }

  const math = typesetMath(element)
  if (math) return math.display ? block(`$$\n${math.tex}\n$$`) : `$$${math.tex}$$`

  const heading = /^H([1-6])$/u.exec(element.tagName)?.[1]
  if (heading) {
    const text = children(element)
      .replace(/\s*\n\s*/gu, ' ')
      .trim()
    return text ? block(`${'#'.repeat(Number(heading))} ${text}`) : ''
  }

  // A GitHub alert is drawn as a titled box; its first line is that title.
  const alert = element.getAttribute('data-alert')
  if (alert) {
    const title = element.firstElementChild?.tagName === 'P' ? element.firstElementChild : null
    const body = Array.from(element.childNodes)
      .filter((child) => child !== title)
      .map((child) => serialise(child, element.tagName))
      .join('')
    return quote(body, `[!${alert.toUpperCase()}]`)
  }

  switch (element.tagName) {
    case 'BR':
      return '\n'
    case 'HR':
      return block('---')
    case 'P':
      return block(children(element))
    case 'CODE':
      return inlineCode(plainText(element))
    case 'STRONG':
    case 'B':
      return wrapInline(children(element), '**')
    case 'EM':
    case 'I':
      return wrapInline(children(element), '*')
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrapInline(children(element), '~~')
    case 'A':
      return linkMarkdown(element, children(element))
    case 'IMG':
      return imageMarkdown(element)
    case 'UL':
    case 'OL':
      return list(element)
    case 'LI':
      // An item whose list fell outside the range: its text, as a line.
      return block(children(element))
    case 'BLOCKQUOTE':
      return quote(children(element))
    case 'TABLE':
      return table(element)
    default:
      return BLOCK_CONTAINERS.has(element.tagName) ? `\n${children(element)}\n` : children(element)
  }
}

// Text with chrome left out: inline code's own content, where a file path set
// as a link inside the code is still the code.
function plainText(node: Node): string {
  const parentTag = isElement(node) ? node.tagName : 'DIV'
  let out = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) out += child.textContent ?? ''
    else if (isElement(child) && !isChrome(child, parentTag)) out += plainText(child)
  }
  return out
}

/** The markdown a rendered fragment was written in: the children of `root`. */
export function renderedMarkdown(root: Node): string {
  return normaliseBlankLines(children(root), true).trim()
}

// ---- What a range copies -------------------------------------------------

// The one code block a fragment holds, when it holds nothing else a reader
// would see — a drag that ran onto a block's last line pulls the whole block
// into the range, but what the person selected was code.
function soleCodeBlock(root: Node): Element | null {
  let found: Element | null = null
  let other = false
  const visit = (node: Node, parentTag: string) => {
    for (const child of Array.from(node.childNodes)) {
      if (other) return
      if (child.nodeType === TEXT_NODE) {
        if ((child.textContent ?? '').trim()) other = true
        continue
      }
      if (!isElement(child) || isChrome(child, parentTag)) continue
      if (isCodeBlockRoot(child)) {
        if (found) other = true
        else found = child
        continue
      }
      // An item or a row carries a marker of its own even when it wraps the
      // block, so it is more than the block.
      if (['LI', 'TR', 'IMG', 'HR'].includes(child.tagName)) {
        other = true
        continue
      }
      visit(child, child.tagName)
    }
  }
  visit(root, isElement(root) ? root.tagName : 'DIV')
  return other ? null : found
}

// The range's contents inside the structure they need to mean anything: items
// cut out of a list go back into a list that numbers from where the range
// started, cells cut out of a row go back into a table, and paragraphs cut out
// of a quote stay quoted. Anything else sits in a plain box that remembers
// what it was cut from, so a file link inside a paragraph is still prose.
function contextualFragment(range: Range, ancestor: Element): Element {
  const doc = ancestor.ownerDocument
  const tag = ancestor.tagName
  let content: Node = range.cloneContents()
  if (tag === 'UL' || tag === 'OL' || tag === 'BLOCKQUOTE') {
    const wrapper = ancestor.cloneNode(false) as Element
    if (tag === 'OL') {
      const items = Array.from(ancestor.children).filter((child) => child.tagName === 'LI')
      const startItem = items.find((item) => item.contains(range.startContainer))
      const start = Number.parseInt(ancestor.getAttribute('start') ?? '1', 10) || 1
      if (startItem) wrapper.setAttribute('start', String(start + items.indexOf(startItem)))
    }
    wrapper.appendChild(content)
    content = wrapper
  } else if (['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'].includes(tag)) {
    let inner = content
    if (tag === 'TR') {
      const row = doc.createElement('tr')
      row.appendChild(inner)
      inner = row
    }
    if (tag !== 'TABLE') {
      const body = doc.createElement('tbody')
      body.appendChild(inner)
      inner = body
    }
    const tableElement = doc.createElement('table')
    tableElement.appendChild(inner)
    content = tableElement
  }
  // A box of the ancestor's own kind when it is prose, so a file-path button
  // cut out of a sentence is still read as part of one.
  const box = doc.createElement(PHRASING_PARENTS.has(tag) ? tag.toLowerCase() : 'div')
  box.appendChild(content)
  return box
}

// ---- The HTML flavour ------------------------------------------------------

const KEPT_ATTRIBUTES: Record<string, readonly string[]> = {
  A: ['href'],
  IMG: ['src', 'alt'],
  TH: ['align', 'colspan', 'rowspan'],
  TD: ['align', 'colspan', 'rowspan'],
  OL: ['start'],
  LI: ['value'],
}

function keepMeaningfulAttributes(element: Element): void {
  // A column's alignment drawn as a style is meaning too: it is kept as the
  // attribute, before the style goes, for the paste style to read.
  const styledAlign = (element as HTMLElement).style?.textAlign
  if ((element.tagName === 'TH' || element.tagName === 'TD') && styledAlign && !element.hasAttribute('align'))
    element.setAttribute('align', styledAlign)
  const kept = KEPT_ATTRIBUTES[element.tagName] ?? []
  for (const attribute of Array.from(element.attributes)) {
    if (!kept.includes(attribute.name)) element.removeAttribute(attribute.name)
  }
  for (const name of ['href', 'src']) {
    const value = element.getAttribute(name)
    if (value !== null && !isSafeHref(value)) element.removeAttribute(name)
  }
}

// A code block as the clipboard holds it: the code in a styled `pre > code`.
// No language class: a class means nothing to the editor it lands in.
function pasteCodeBlock(doc: Document, text: string): Element {
  const pre = doc.createElement('pre')
  pre.setAttribute('style', PASTE_STYLES.pre)
  const code = doc.createElement('code')
  code.setAttribute('style', PASTE_STYLES.codeBlock)
  code.textContent = text
  pre.appendChild(code)
  return pre
}

// The paste styles on what is left: inline code in a monospace face, tables
// ruled, quotes barred. A code block was styled as it was rebuilt.
function stylePaste(root: Element): void {
  for (const element of Array.from(root.querySelectorAll('code, table, th, td, blockquote'))) {
    const tag = element.tagName
    if (tag === 'CODE' && element.parentElement?.tagName !== 'PRE') element.setAttribute('style', PASTE_STYLES.code)
    else if (tag === 'TABLE') element.setAttribute('style', PASTE_STYLES.table)
    else if (tag === 'TH' || tag === 'TD') element.setAttribute('style', pasteCellStyle(element.getAttribute('align')))
    else if (tag === 'BLOCKQUOTE') element.setAttribute('style', PASTE_STYLES.blockquote)
  }
}

// The fragment as a rich editor should receive it: content elements with the
// attributes that carry meaning and the paste styles, and nothing of the app —
// no classes, handlers, ids or ARIA, no controls, no chrome. A code block
// becomes a plain `pre > code`; a file-path button becomes its text.
function sanitisedHtml(root: Element): string {
  const doc = root.ownerDocument
  const copy = root.cloneNode(true) as Element
  // A task item's box, as the character a paste keeps (`pasteStyles.ts`). The
  // kit draws it inside a wrapper the pointer cannot select, which is chrome to
  // everything else.
  const taskBox = (input: Element, next: Node | null) =>
    doc.createTextNode(
      pasteTaskBox((input as HTMLInputElement).checked || input.getAttribute('aria-checked') === 'true') +
        (/^\s/u.test(next?.textContent ?? '') ? '' : ' '),
    )
  // Each box replaces only what was drawn around it — the wrappers that hold
  // nothing but the box — so the item's words, its paragraphs and a list
  // nested under it all stay where they were.
  for (const input of Array.from(copy.querySelectorAll('input[type="checkbox"]'))) {
    let drawn: Element = input
    for (
      let parent = drawn.parentElement;
      parent && parent !== copy && parent.tagName !== 'LI' && parent.tagName !== 'P' && !parent.textContent?.trim();
      parent = parent.parentElement
    )
      drawn = parent
    drawn.replaceWith(taskBox(input, drawn.nextSibling))
  }
  const clean = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (isChrome(child, element.tagName)) {
        child.remove()
        continue
      }
      const math = typesetMath(child)
      if (math) {
        // As the source a rich editor can keep: a display formula as a code
        // block of its TeX, an inline one as the text it was written as.
        child.replaceWith(math.display ? pasteCodeBlock(doc, math.tex) : doc.createTextNode(`$$${math.tex}$$`))
        continue
      }
      if (isCodeBlockRoot(child)) {
        child.replaceWith(pasteCodeBlock(doc, codeBlockText(child)))
        continue
      }
      clean(child)
      if (child.tagName === 'BUTTON') child.replaceWith(...Array.from(child.childNodes))
      else keepMeaningfulAttributes(child)
    }
  }
  keepMeaningfulAttributes(copy)
  clean(copy)
  stylePaste(copy)
  return `<meta charset="utf-8">${copy.innerHTML}`
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

function rangeClipboard(range: Range): SelectionClipboard | null {
  const common = range.commonAncestorContainer
  const ancestor = isElement(common) ? common : common.parentElement
  // A range inside a block's chrome (its header, say) is text the person
  // chose on purpose; the browser copies it as it is.
  if (!ancestor || ancestor.closest('[data-copy-exclude]')) return null

  // Inside one text node, or inside one code block: exactly the characters the
  // person selected, with no markers or fence around them.
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === TEXT_NODE) {
    const text = range.toString()
    return text ? { text, html: `<meta charset="utf-8">${escapeHtml(text)}` } : null
  }
  const codeRoot = ancestor.closest(`pre, ${CODE_BLOCK_ROOT}`)
  if (codeRoot) {
    const box = contextualFragment(range, ancestor)
    const text = (box.querySelector('pre') ? codeBlockText(box) : plainText(box)).replace(/\n$/u, '')
    return text
      ? { text, html: `<meta charset="utf-8">${pasteCodeBlock(ancestor.ownerDocument, text).outerHTML}` }
      : null
  }

  const box = contextualFragment(range, ancestor)
  const sole = soleCodeBlock(box)
  const text = sole ? codeBlockText(sole) : renderedMarkdown(box)
  if (!text) return null
  return { text, html: sanitisedHtml(box) }
}

/**
 * The clipboard flavours for a selection inside `container`, or null when the
 * copy is not this view's to rewrite: nothing selected, or a range that
 * reaches outside the container.
 */
export function selectionClipboard(selection: Selection | null, container: Element): SelectionClipboard | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const ranges: Range[] = []
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    if (!container.contains(range.commonAncestorContainer)) return null
    if (!range.collapsed) ranges.push(range)
  }
  const copies = ranges.map(rangeClipboard).filter((copy): copy is SelectionClipboard => copy !== null)
  if (!copies.length) return null
  return {
    text: copies.map((copy) => copy.text).join('\n\n'),
    html: `<meta charset="utf-8">${copies.map((copy) => copy.html.replace(/^<meta charset="utf-8">/u, '')).join('')}`,
  }
}

type CopyEventLike = {
  target: EventTarget | null
  clipboardData: Pick<DataTransfer, 'setData'> | null
  preventDefault: () => void
}

/**
 * A `copy` event on `container`: when the selection is rendered conversation
 * inside it, write the markdown and HTML flavours and keep the browser's own
 * copy from running. A copy from a field, or of a selection that is not the
 * container's, is left to the browser. Returns whether it took the copy.
 */
export function copySelectionAsMarkdown(event: CopyEventLike, container: Element): boolean {
  const target = event.target as Element | null
  if (target && isElement(target as Node) && target.closest('input, textarea, [contenteditable="true"]')) return false
  if (!event.clipboardData) return false
  const payload = selectionClipboard(container.ownerDocument.getSelection(), container)
  if (!payload) return false
  event.preventDefault()
  event.clipboardData.setData('text/plain', payload.text)
  event.clipboardData.setData('text/html', payload.html)
  return true
}
