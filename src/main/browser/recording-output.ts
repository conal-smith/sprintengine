import { createReadStream, createWriteStream } from 'node:fs'
import { access, appendFile, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { isAbsolute, join } from 'node:path'

import { distroOfUncPath, toWslPath } from '../../shared/host-paths'
import { isMachinePath, parseMachinePath } from '../../shared/machine-paths'
import { ensureWorkspaceStoreDir } from '../workspace-store'
import type { RecordingFailure, RecordingOutput, RecordingOutputs } from './browser-recorder'
import { webmDurationPatch } from './webm-duration'

// Where a browser recording is saved: in the project's store in the person's
// home, `~/.sprintengine/workspaces/<project>/browser/recordings/`
// (workspace-store.ts), never in the project's folder, where it was one more
// file the person had to teach git to ignore.
//
// One store per project, so a chat in a worktree (a New chat leases one from
// the pool) records into the same folder as one in the checkout: a pool slot
// is reused by the next chat and removed over the idle and disk limits, and a
// video kept with the slot would linger under someone else's chat or vanish
// with it. The answer's `path` is absolute, so the agent opens it from its
// worktree all the same.
//
// A project in WSL keeps its store in the distribution's home, reached from
// here through the `\\wsl.localhost\…` path this computer opens it by, so the
// answer names the file as the agent there spells it.
//
// A workspace on an SSH machine is refused before anything is captured.
// Studio has no way yet to write a file into a folder on that machine (its
// server takes reads, and writes of canvas boards only), and a recording kept
// on this computer would be a path the agent there cannot open. The design
// for carrying it there is in docs/design/browser-recording.md.

/** The store's folder for the pane's captures; recordings sit in a folder inside it. */
const BROWSER_FOLDER = 'browser'
const RECORDINGS_FOLDER = 'recordings'
const EXTENSION = '.webm'
/** A file still being written: renamed to its final name when the recording ends. */
const PARTIAL_SUFFIX = '.part'
/** How many names a recording tries before giving up: a folder this full is not one to add to. */
const MAX_NAME_ATTEMPTS = 1_000
/** How much of a recording is read to set its length: Chromium writes Info in its first few hundred bytes. */
const HEAD_BYTES = 64 * 1024

// Every check is asynchronous: a WSL workspace is a `\\wsl.localhost\…` share,
// and a synchronous call on it would hold main while the distribution answers.
export type RecordingFs = {
  exists(path: string): Promise<boolean>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  /** Make an empty file, or answer false when one is already there. */
  createNew(path: string): Promise<boolean>
  appendFile(path: string, data: Uint8Array): Promise<void>
  /** Up to `length` bytes from the start of a file. */
  readHead(path: string, length: number): Promise<Uint8Array>
  /** Append `from`'s bytes from `start` on to `to`, streamed rather than read whole. */
  appendFrom(from: string, start: number, to: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  size(path: string): Promise<number>
}

const nodeFs: RecordingFs = {
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  writeFile: (path, data) => writeFile(path, data),
  createNew: (path) =>
    writeFile(path, new Uint8Array(0), { flag: 'wx' }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false
        throw error
      },
    ),
  appendFile: (path, data) => appendFile(path, data),
  readHead: async (path, length) => {
    const handle = await open(path, 'r')
    try {
      const buffer = new Uint8Array(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  },
  appendFrom: (from, start, to) => pipeline(createReadStream(from, { start }), createWriteStream(to, { flags: 'a' })),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
  size: async (path) => (await stat(path)).size,
}

export type WorkspaceRecordingOutputsDeps = {
  /** A workspace's project folder (the checkout, for a chat in a worktree); null when it has none. */
  resolveWorkspaceRoot(workspaceId: string): string | null
  /** An SSH machine's name for its saved id, for the refusal's wording. */
  machineLabel?(id: string): string | null
  fs?: RecordingFs
}

/** The file as the agent's machine spells it: a WSL distribution reads a `\\wsl…` share's file by its Linux path. */
export function agentPathOf(file: string): string {
  return distroOfUncPath(file) !== null ? toWslPath(file) : file
}

export function createWorkspaceRecordingOutputs(deps: WorkspaceRecordingOutputsDeps): RecordingOutputs {
  const fs = deps.fs ?? nodeFs
  const fail = (code: string, message: string): RecordingFailure => ({ ok: false, code, message })

  return {
    async create({ workspaceId, stem }) {
      const root = deps.resolveWorkspaceRoot(workspaceId)
      if (!root) return fail('no_workspace_folder', 'This workspace has no folder to save a recording in.')
      if (isMachinePath(root)) {
        const machine = parseMachinePath(root)
        const name = (machine && deps.machineLabel?.(machine.id)) || 'an SSH machine'
        return fail(
          'recording_unavailable',
          `Recordings are kept on the machine a workspace is on, and Studio cannot write files on ${name} yet. ` +
            'Recording works for workspaces on this computer and in WSL.',
        )
      }
      if (!isAbsolute(root) || !(await fs.exists(root))) {
        return fail('no_workspace_folder', 'The workspace folder is not available to save a recording in.')
      }

      let directory: string
      let name: string | null = null
      try {
        directory = await ensureWorkspaceStoreDir(root, BROWSER_FOLDER, RECORDINGS_FOLDER)
        // A second recording in the same second takes the next free name. The
        // partial file is made exclusively, so two recordings starting
        // together never both take one name.
        for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && name === null; attempt += 1) {
          const candidate = attempt === 1 ? `${stem}${EXTENSION}` : `${stem}-${attempt}${EXTENSION}`
          if (await fs.exists(join(directory, candidate))) continue
          if (await fs.createNew(join(directory, candidate + PARTIAL_SUFFIX))) name = candidate
        }
      } catch (error) {
        return fail(
          'write_failed',
          `The recording could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (name === null) return fail('write_failed', 'The recording could not be saved: no free file name was left.')
      const file = join(directory, name)
      const partial = file + PARTIAL_SUFFIX

      const output: RecordingOutput = {
        path: agentPathOf(file),
        append: (bytes) => fs.appendFile(partial, bytes),
        async finish(durationMs) {
          // The length goes into the header; a file this edit does not
          // understand is kept as it is, playable without one. Only the head
          // is read: the rest, up to 60 MB of it, is copied across as it is.
          const patch = webmDurationPatch(await fs.readHead(partial, HEAD_BYTES), await fs.size(partial), durationMs)
          let patched = false
          if (patch) {
            try {
              await fs.writeFile(file, patch.head)
              await fs.appendFrom(partial, patch.replaces, file)
              patched = true
            } catch {
              // A half-written copy is not kept; the recording itself is.
              await fs.remove(file)
            }
          }
          if (patched) await fs.remove(partial)
          else await fs.rename(partial, file)
          return { bytes: await fs.size(file) }
        },
        async discard() {
          await fs.remove(partial)
        },
      }
      return { ok: true, output }
    },
  }
}
