// Markdown as a rich editor should receive it: the `text/html` flavour written
// beside a copied reply, message, plan or report, so a paste into an email or a
// document keeps its bold, lists, headings, tables and code while a paste into
// a terminal still gets the markdown.
//
// It is rendered from the markdown, never read off the page. Part of a reply
// may be folded out of the page, and a rich flavour built from what happened to
// be drawn would disagree with the plain one. Rendering from the source keeps
// the two flavours the same words. The parse is the page's own
// (`markdownPlugins.ts`); only the drawing differs.
//
// What lands in the other editor has to survive its paste filter and read
// there, not here: plain semantic tags, the few inline styles those editors
// keep (`pasteStyles.ts`), and nothing of the app — no classes, no custom
// properties, no ids, no handlers. HTML written in the markdown stays the text
// it was, as on the page.
//
// Math is written as its TeX. The typeset form needs the typesetter's
// stylesheet and fonts, which no paste brings along, and its MathML is dropped
// by most mail clients, leaving the formula's letters run together; the source
// reads everywhere, and it is what a copied selection writes too. Code is not
// highlighted, for the same reason: the page's colours are its theme's.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import { isMathLanguage } from './markdownMath'
import { MATH_PLUGINS, repairReplyMarkdown, USER_TEXT_PLUGINS } from './markdownPlugins'
import { pasteCellStyle, PASTE_STYLES, pasteTaskBox } from './pasteStyles'

// React wants a style as an object; the shared styles are written as the
// attribute they become, which is what the selection's DOM path sets.
function styleObject(css: string): React.CSSProperties {
  const style: Record<string, string> = {}
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim()
    style[name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = declaration.slice(colon + 1).trim()
  }
  return style
}

const SAFE_URL = /^(?:https?:|mailto:)/iu
// A link the editor could follow: the web and mail. A local file link, an
// in-page heading link, anything else is its words.
const clipboardUrl: UrlTransform = (url) => (SAFE_URL.test(url) ? url : '')

const ALERT_TITLES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

type Props = { children?: React.ReactNode } & ExtraProps

// A tag with nothing on it but its content: the page's classes, ids and data
// attributes are the page's.
function bare(tag: string) {
  return ({ children }: Props) => React.createElement(tag, null, children)
}

function codeText(node: ExtraProps['node']): string {
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  if (code?.type !== 'element') return ''
  return code.children
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('')
    .replace(/\n$/u, '')
}

function codeLanguage(node: ExtraProps['node']): string | undefined {
  const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const language = Array.isArray(classes) ? classes.find((value) => String(value).startsWith('language-')) : undefined
  return language === undefined ? undefined : String(language).slice('language-'.length)
}

function cellAlign(props: Props & { style?: React.CSSProperties; align?: string }): string | undefined {
  return (props.style?.textAlign as string | undefined) ?? props.align
}

const COMPONENTS: Components = {
  p: bare('p'),
  strong: bare('strong'),
  em: bare('em'),
  del: bare('del'),
  sup: bare('sup'),
  sub: bare('sub'),
  ul: bare('ul'),
  li: bare('li'),
  h1: bare('h1'),
  h2: bare('h2'),
  h3: bare('h3'),
  h4: bare('h4'),
  h5: bare('h5'),
  h6: bare('h6'),
  thead: bare('thead'),
  tbody: bare('tbody'),
  tr: bare('tr'),
  div: bare('div'),
  span: bare('span'),
  // The footnotes' section: its words, without the page's landmark.
  section: bare('div'),
  hr: () => <hr />,
  br: () => <br />,
  ol: ({ children, start }: Props & { start?: number }) => (
    <ol start={start !== undefined && start !== 1 ? start : undefined}>{children}</ol>
  ),
  a: ({ children, href, node }: Props & { href?: string }) => {
    // A footnote's way back up is a control on the page, not a word.
    if (node?.properties.dataFootnoteBackref !== undefined) return null
    // design-tokens-allow: clipboard markup for another app's editor, never rendered here, so it has no focus to ring
    return href ? <a href={href}>{children}</a> : <>{children}</>
  },
  img: ({ src, alt }: Props & { src?: string; alt?: string }) =>
    src && SAFE_URL.test(src) ? <img src={src} alt={alt ?? ''} /> : <>{alt ?? ''}</>,
  input: ({ checked, type }: Props & { checked?: boolean; type?: string }) =>
    type === 'checkbox' ? <>{pasteTaskBox(checked === true)}</> : null,
  table: ({ children }: Props) => <table style={styleObject(PASTE_STYLES.table)}>{children}</table>,
  th: (props: Props & { style?: React.CSSProperties; align?: string }) => (
    <th style={styleObject(pasteCellStyle(cellAlign(props)))}>{props.children}</th>
  ),
  td: (props: Props & { style?: React.CSSProperties; align?: string }) => (
    <td style={styleObject(pasteCellStyle(cellAlign(props)))}>{props.children}</td>
  ),
  blockquote: ({ children, node }: Props) => {
    const alert = node?.properties.dataAlert
    const title = typeof alert === 'string' ? ALERT_TITLES[alert] : undefined
    return (
      <blockquote style={styleObject(PASTE_STYLES.blockquote)}>
        {title ? (
          <p>
            <strong>{title}</strong>
          </p>
        ) : null}
        {children}
      </blockquote>
    )
  },
  code: ({ children, className }: Props & { className?: string }) =>
    // Inline math as it was written, as a copied selection gives it back.
    className?.split(' ').includes('math-inline') ? (
      <>{`$$${String(children ?? '').trim()}$$`}</>
    ) : (
      <code style={styleObject(PASTE_STYLES.code)}>{children}</code>
    ),
  pre: ({ node }: Props) => {
    const text = codeText(node)
    const math = isMathLanguage(codeLanguage(node))
    return (
      <pre style={styleObject(PASTE_STYLES.pre)}>
        <code style={styleObject(PASTE_STYLES.codeBlock)}>{math ? text.trim() : text}</code>
      </pre>
    )
  },
}

export type MarkdownClipboardOptions = {
  /**
   * The text is a message a person typed: every newline is a line break, HTML
   * shows as the text it is, and a `$$` is not math — as the page draws it.
   * Off for an agent's reply, a plan or a report, which are read as agents
   * write them, file links repaired and math found.
   */
  userText?: boolean
}

/**
 * The `text/html` flavour for `markdown`: a fragment of plain, inline-styled
 * HTML a rich editor keeps, led by the charset a clipboard reader needs to
 * read anything past ASCII. Pure — no page, no DOM.
 */
export function markdownClipboardHtml(markdown: string, options: MarkdownClipboardOptions = {}): string {
  const source = options.userText ? markdown : repairReplyMarkdown(markdown)
  const body = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={options.userText ? USER_TEXT_PLUGINS : MATH_PLUGINS}
      components={COMPONENTS}
      urlTransform={clipboardUrl}
    >
      {source}
    </ReactMarkdown>,
  )
  return `<meta charset="utf-8">${body}`
}
