import { randomUUID } from 'node:crypto'

import { HTML_PREVIEW_SCHEME } from '../shared/desktop-csp'

// An HTML artifact shown with its scripts on (HtmlArtifactFrame's interactive
// toggle). As a `srcdoc` frame it would take the app window's
// Content-Security-Policy with it, which runs no inline script; so the window
// hands main the document and frames it from `studio-preview://doc/<id>`, a
// document of its own with no policy of the app's. The frame stays sandboxed
// without `allow-same-origin`, as it was: an opaque origin that can reach
// nothing of the app's.
//
// Only what a window registered is served, to the default session (the app's
// windows; the browser pane's guests are on a partition of their own, where
// the scheme is not handled), and only while that window lives.

const HOST = 'doc'
const MAX_DOCUMENTS = 16
const MAX_BYTES = 8 * 1024 * 1024

type Entry = { html: string; owner: number }

export type HtmlPreviewStore = {
  /** A URL for `html`, owned by the window `owner` (its WebContents id). */
  open(html: string, owner: number): string
  close(url: string, owner: number): void
  /** Forget every document a window registered: it closed. */
  release(owner: number): void
  /** What the scheme answers for `url`. */
  respond(url: string): Response
}

export function createHtmlPreviewStore(): HtmlPreviewStore {
  const documents = new Map<string, Entry>()
  const idOf = (url: string): string | null => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== `${HTML_PREVIEW_SCHEME}:` || parsed.host !== HOST) return null
      return parsed.pathname.replace(/^\//, '')
    } catch {
      return null
    }
  }
  return {
    open(html, owner) {
      if (typeof html !== 'string') throw new Error('An HTML preview is a string.')
      if (html.length > MAX_BYTES) throw new Error('That page is too large to preview.')
      const id = randomUUID()
      documents.set(id, { html, owner })
      // Oldest first, as a Map keeps them.
      while (documents.size > MAX_DOCUMENTS) documents.delete(documents.keys().next().value!)
      return `${HTML_PREVIEW_SCHEME}://${HOST}/${id}`
    },
    close(url, owner) {
      const id = idOf(url)
      if (id && documents.get(id)?.owner === owner) documents.delete(id)
    },
    release(owner) {
      for (const [id, entry] of documents) if (entry.owner === owner) documents.delete(id)
    },
    respond(url) {
      const id = idOf(url)
      const entry = id ? documents.get(id) : undefined
      if (!entry) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
      return new Response(entry.html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      })
    },
  }
}

/** The process's previews: the IPC registers into it and the scheme answers from it. */
export const htmlPreviews: HtmlPreviewStore = createHtmlPreviewStore()
