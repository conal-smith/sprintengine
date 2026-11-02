/**
 * Main-owned mirror of Settings ▸ Settled chats: whether a merge settles a
 * chat, whether an open pull request keeps one from the idle rule, and how
 * many quiet days settle one.
 *
 * Same one-way push contract as the model-written titles setting: the
 * renderer owns the preference (`appSettings`) and pushes it on change and
 * when a window mounts; main persists a copy under its data directory and
 * reads it synchronously. Main's rest sweep reads it
 * (`automation/workspace-settlement-sweep.ts`), with or without a window open.
 *
 * Absent or unreadable reads as the renderer's own defaults
 * (`normalizeSettledChatsSettings`, shared so the two cannot drift): merges
 * settle, an open pull request keeps a chat, three quiet days.
 *
 * Deliberately carries no revision counter: main never writes this value and
 * never broadcasts it back, so there is no echo to order.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from '../shared/records'
import { normalizeSettledChatsSettings, type SettledChatsSettings } from '../shared/workspace-settlement'

const FILE_NAME = 'settled-chats.json'

export type SettledChatsSettingsStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type SettledChatsSettingsStore = ReturnType<typeof createSettledChatsSettingsStore>

export function createSettledChatsSettingsStore(deps: SettledChatsSettingsStoreDeps) {
  let cached: SettledChatsSettings | null = null
  const listeners = new Set<() => void>()

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  function read(value: unknown): SettledChatsSettings {
    return normalizeSettledChatsSettings(isRecord(value) ? (value as Partial<SettledChatsSettings>) : undefined)
  }

  function get(): SettledChatsSettings {
    if (cached !== null) return cached
    try {
      cached = read(JSON.parse(readFileSync(filePath(), 'utf8')))
    } catch {
      cached = read(undefined)
    }
    return cached
  }

  return {
    /** The settings the sweep reads on each pass. Never throws. */
    get,

    /** Adopt a renderer push. Idempotent: an unchanged value never rewrites the file or tells anyone. */
    set(value: unknown): void {
      const next = read(value)
      if (JSON.stringify(get()) === JSON.stringify(next)) return
      cached = next
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}`
      try {
        writeFileSync(tmp, `${JSON.stringify(next)}\n`, 'utf8')
        renameSync(tmp, target)
      } catch (error) {
        try {
          unlinkSync(tmp)
        } catch {
          // The temp file may never have been created; nothing to clean up.
        }
        // In memory it still applies, so the choice takes effect now; it just
        // will not survive a restart, which is what the warning says.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Settled chats settings not saved',
          message:
            'The Settled chats settings could not be written to disk. They apply for this session but will not survive a restart.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
      for (const listener of [...listeners]) listener()
    },

    /** Hear each change a push makes. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
