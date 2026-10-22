// A generated HTML document shown with its scripts off loads nothing from
// anywhere: a picture, a stylesheet or a font it names on the network would
// otherwise be fetched the moment it is drawn, telling whoever serves it that
// the file was opened, and from where. Its own inline styles, and the pictures
// and fonts carried in it as data, still draw.
//
// With scripts on, the person has asked for the page to run as written, and
// it is left as it is.

export const INERT_HTML_POLICY = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${INERT_HTML_POLICY}">`

/**
 * `html` with a policy that refuses every load from elsewhere put first. After
 * a doctype, when it has one, so the page keeps the rendering mode it asked for.
 */
export function inertHtml(html: string): string {
  const doctype = /^﻿?\s*<!doctype[^>]*>/iu.exec(html)
  if (!doctype) return `${POLICY_META}${html}`
  return `${doctype[0]}${POLICY_META}${html.slice(doctype[0].length)}`
}
