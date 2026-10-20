import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BrowserWindow, session } from 'electron'

import { chatExportPrintOptions } from './chat-export-html'

// A chat's PDF: its page (chat-export-html.ts) printed by the app's own
// Chromium, in a window nobody sees.
//
// The page is the chat's words, and a chat can hold anything an agent or a
// pasted message wrote, so the window gives the page nothing: no script at
// all, a sandbox, no Node, a session of its own kept in memory that answers no
// request but the page's own file and the pictures inside it, no navigating
// away, no pop-ups, no permissions. The page is written to a folder of its own
// in the temp directory, because a data URL that big is refused, and the
// folder goes when the print is done.

const PRINT_PARTITION = 'chat-export-print'
const LOAD_TIMEOUT_MS = 30_000

let sessionGuarded = false

/** The print session refuses every request but a page file of ours and the data URLs in it. */
function printSession(): Electron.Session {
  const printing = session.fromPartition(PRINT_PARTITION)
  if (!sessionGuarded) {
    sessionGuarded = true
    printing.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !mayLoad(details.url) })
    })
    printing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    printing.setPermissionCheckHandler(() => false)
  }
  return printing
}

const pages = new Set<string>()

/** Whether the print window may load `url`: a page this module wrote, or data inside it. */
export function mayLoad(url: string, allowed: ReadonlySet<string> = pages): boolean {
  if (url.startsWith('data:')) return true
  return allowed.has(url)
}

export async function renderChatExportPdf(html: string, paper: 'A4' | 'Letter'): Promise<Buffer> {
  const folder = await mkdtemp(join(tmpdir(), 'sprintengine-chat-export-'))
  const file = join(folder, `${randomUUID()}.html`)
  await writeFile(file, html, 'utf8')
  const pageUrl = pathToFileURL(file).toString()
  pages.add(pageUrl)
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      javascript: false,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      webgl: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      session: printSession(),
    },
  })
  try {
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (url !== pageUrl) event.preventDefault()
    })
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.setAudioMuted(true)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      window.loadURL(pageUrl),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The page for the PDF did not load.')), LOAD_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    return await contents.printToPDF(chatExportPrintOptions(paper))
  } finally {
    pages.delete(pageUrl)
    if (!window.isDestroyed()) window.destroy()
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}
