import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

import type { DownloadItem } from 'electron'

// A download the agent sets off in the browser pane (a click on an export
// link, a navigation to a file) is saved without asking. Chromium's own Save
// dialog would open over the app, wait for a person who is not at the
// keyboard, and hold the agent's turn until someone noticed. The file goes to
// the workspace's browser sidecar, beside the agent's screenshots, under the
// name the page suggested made safe to write there; the path is put where the
// agent reads what happened to its tab. A download the person sets off is
// theirs and keeps the dialog.

/** The members of Electron's DownloadItem this file uses. */
export type AgentDownloadItem = Pick<DownloadItem, 'getFilename' | 'getURL' | 'setSavePath'> & {
  once(event: 'done', listener: (event: unknown, state: 'completed' | 'cancelled' | 'interrupted') => void): unknown
}

const MAX_NAME_LENGTH = 120
const MAX_EXTENSION_LENGTH = 16
// Names Windows will not create a file under, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

/**
 * The page's suggested name as one file name: no folder in it (a `../` or an
 * absolute path keeps only its last part), no control characters or
 * characters a file system refuses, no leading dot, at most
 * `MAX_NAME_LENGTH` characters with its extension kept.
 */
export function safeDownloadName(suggested: string): string {
  const leaf = suggested.split(/[\\/]/).at(-1) ?? ''
  let name = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '')
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  if (name.length > MAX_NAME_LENGTH) {
    const extension = extname(name)
    const kept = extension.length <= MAX_EXTENSION_LENGTH ? extension : ''
    name = name.slice(0, MAX_NAME_LENGTH - kept.length) + kept
  }
  return name || 'download'
}

/** Saves the agent's downloads into a folder, each under a name no other file or running download holds. */
export function createAgentDownloads(exists: (path: string) => boolean = existsSync) {
  // Chromium writes a download under a temporary name until it completes, so
  // two downloads of one name running together would both see the name free.
  const running = new Set<string>()

  return {
    /** Points `item` at a free name in `directory`, and returns that path. */
    save(item: AgentDownloadItem, directory: string): string {
      const name = safeDownloadName(item.getFilename())
      const extension = extname(name)
      const stem = name.slice(0, name.length - extension.length)
      let path = join(directory, name)
      for (let copy = 1; running.has(path) || exists(path); copy++) {
        path = join(directory, `${stem} (${copy})${extension}`)
      }
      running.add(path)
      item.setSavePath(path)
      item.once('done', () => running.delete(path))
      return path
    },
  }
}
