import type { IncomingMessage, ServerResponse } from 'node:http'

// The headers the web listener answers with, and the cookies it reads (phase 9
// spec, 6.3 and 6.4; decision R20).
//
// The app page carries a Content-Security-Policy. So does the desktop app
// window, since the security hardening of 2026-10 (it had none after the
// owner's ruling of 2026-09-27): its policy is a `<meta>` in the document,
// built by src/shared/desktop-csp.ts, as a `file://` page has no response
// headers to carry one. The two differ where the clients do: the desktop's
// highlighter compiles WebAssembly, it frames scripted HTML previews from a
// scheme of its own, and it shows images from the web. Transcripts are
// agent-written; either policy is the second line behind `react-markdown`
// rendering no raw HTML.

export type CspInput = {
  /** The origin the page was served from, for `connect-src` (explicit for older WebKit). */
  origin: string
  /** Third-party renderer modules evaluate as `blob:` scripts; only when the owner turned them on (R61). */
  blobScripts: boolean
  /** Who may frame the page: nobody, unless it is an embed with registered origins. */
  frameAncestors?: readonly string[]
}

/** The policy for the app page, the pairing page and the embed page. */
export function contentSecurityPolicy(input: CspInput): string {
  const url = new URL(input.origin)
  const socket = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
  // A preview is on the same host and a port of its own (spec 3.6), framed by
  // the preview pane; nothing else is framed but sandboxed `blob:` documents.
  const previews = `${url.protocol}//${url.hostname}:*`
  const ancestors = input.frameAncestors && input.frameAncestors.length > 0 ? input.frameAncestors.join(' ') : "'none'"
  return [
    "default-src 'self'",
    `script-src 'self'${input.blobScripts ? ' blob:' : ''}`,
    // Monaco, the canvas editor and React's style props write inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "worker-src 'self' blob:",
    `frame-src 'self' blob: ${previews}`,
    `frame-ancestors ${ancestors}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
  ].join('; ')
}

/** The headers every page the listener renders carries. */
export function pageHeaders(input: CspInput): Record<string, string> {
  const framed = input.frameAncestors && input.frameAncestors.length > 0
  return {
    'Content-Security-Policy': contentSecurityPolicy(input),
    ...(framed ? {} : { 'X-Frame-Options': 'DENY' }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Cache-Control': 'no-store',
  }
}

/** The headers every authenticated, non-page response carries (bytes, JSON). */
export const AUTHENTICATED_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // A preview's page is the same site as Studio: it must not be able to embed
  // what Studio answers to the person's cookie as an image or a script.
  'Cross-Origin-Resource-Policy': 'same-origin',
}

/** Every `name=value` pair a request's cookies carry, in order, duplicates kept. */
export function parseCookies(header: string | undefined): Array<[string, string]> {
  if (!header) return []
  const pairs: Array<[string, string]> = []
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const name = part.slice(0, at).trim()
    let value = part.slice(at + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    if (name) pairs.push([name, value])
  }
  return pairs
}

/** Every value of one cookie a request carries. A page on another local port can add its own. */
export function cookieValues(request: IncomingMessage, name: string): string[] {
  return parseCookies(request.headers.cookie)
    .filter(([key]) => key === name)
    .map(([, value]) => value)
    .filter((value) => value.length > 0 && value.length <= 256)
}

export type CookieOptions = {
  /** Set on HTTPS, and on `http://localhost`, where current browsers accept it. */
  secure: boolean
  maxAgeSeconds?: number
  path?: string
}

/** A session-style cookie: `HttpOnly`, `SameSite=Strict`, no `Domain`. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${value}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
    ...(options.maxAgeSeconds !== undefined ? [`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`] : []),
  ].join('; ')
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    ...AUTHENTICATED_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(text)
}

export function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...AUTHENTICATED_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    ...headers,
  })
  response.end(text)
}

/** Read a small request body, refusing anything larger than `limit` bytes. */
export function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}
