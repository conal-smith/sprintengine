import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  conversationCommandsFolderKey,
  type ConversationCommand,
  type ConversationCommandCatalog,
} from '../../../../../shared/conversation/commands'
import type { ChatCommandSource } from './chatServices'
import { windowChatServices } from './conversationTransport'

// The command list a chat's `/` menu offers: what its CLI reported for the
// chat's folder, with the few commands Studio answers itself put first.
//
// The list is kept per (CLI, folder) in this module rather than in the view,
// so reopening a chat — or a second chat on the same CLI and folder — shows
// the last list at once instead of a spinner. Main pushes every new list it
// hears (a session's init, an ACP update, a probe), and those pushes land here
// for every key, not just the one on screen, so a background chat's list is
// already current when it is opened.

/**
 * The window's command lists, read at call time: over its IPC or the Studio
 * protocol, whichever the window chose. A build whose preload does not list a
 * CLI's commands leaves the menu with Studio's own rather than throwing.
 */
const commandsApi = (): ChatCommandSource => (typeof window === 'undefined' ? {} : windowChatServices().commands)

/**
 * How old a list may be before opening the menu asks the CLI again. A CLI's
 * list changes when the person adds a command file or a plugin, which is rare
 * enough that asking on every `/` would be probe churn for nothing.
 */
export const COMMANDS_STALE_MS = 5 * 60_000
/**
 * How soon opening the menu asks again when the last ask brought no list — an
 * ACP CLI reports its commands only once a session exists, and a failed ask is
 * worth retrying, but not on every keystroke that reopens the menu.
 */
export const COMMANDS_RETRY_MS = 10_000

// Main keys its lists by the same normalised folder, so a push published under
// the session's spelling of the folder lands on the key this chat reads.
const keyOf = (cli: string, cwd: string) => `${cli}\u0000${conversationCommandsFolderKey(cwd)}`
const catalogCache = new Map<string, ConversationCommandCatalog>()
const inFlight = new Map<string, Promise<void>>()
const peeking = new Map<string, Promise<void>>()
const requestedAt = new Map<string, number>()
// Per (CLI, folder), so a list arriving for one folder re-renders only the
// chats reading that folder's list.
const cacheListeners = new Map<string, Set<() => void>>()

function notify(key: string): void {
  for (const listener of cacheListeners.get(key) ?? []) listener()
}

function remember(catalog: ConversationCommandCatalog): void {
  const key = keyOf(catalog.cli, catalog.cwd)
  catalogCache.set(key, catalog)
  notify(key)
}

// One subscription to main for the whole renderer, held while any chat reads
// a list, so a push reaches the cache once however many chats are open.
let unsubscribeMain: (() => void) | null = null
function retainMainSubscription(): () => void {
  if (!unsubscribeMain) unsubscribeMain = commandsApi().onChanged?.(remember) ?? (() => undefined)
  let released = false
  return () => {
    if (released) return
    released = true
    queueMicrotask(() => {
      if (cacheListeners.size > 0 || !unsubscribeMain) return
      unsubscribeMain()
      unsubscribeMain = null
    })
  }
}

function request(cli: string, cwd: string, refresh: boolean, source: ChatCommandSource = commandsApi()): Promise<void> {
  const key = keyOf(cli, cwd)
  const pending = inFlight.get(key)
  if (pending) return pending
  const call = source.list
  if (!call) return Promise.resolve()
  requestedAt.set(key, Date.now())
  const promise = call({ cli, cwd, ...(refresh ? { refresh: true } : {}) })
    .then(remember)
    .catch((error: unknown) => {
      const previous = catalogCache.get(key)
      remember({
        cli,
        cwd,
        commands: previous?.commands ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      inFlight.delete(key)
      notify(key)
    })
  inFlight.set(key, promise)
  notify(key)
  return promise
}

// What main already holds for a folder, asked as a chat mounts. It never
// starts a probe — restoring a window full of chats would otherwise start a
// CLI process for each — and a failure leaves the cache as it was: the real
// ask comes when the menu opens.
function peek(cli: string, cwd: string): void {
  const key = keyOf(cli, cwd)
  const call = commandsApi().list
  if (!call || peeking.has(key) || inFlight.has(key)) return
  const promise = call({ cli, cwd, probe: false })
    .then((catalog) => {
      if (!catalogCache.has(key)) remember(catalog)
    })
    .catch(() => undefined)
    .finally(() => peeking.delete(key))
  peeking.set(key, promise)
}

/** Studio's own commands, answered in the view and never sent. */
export function studioAppCommands(input: {
  model: boolean
  effort: boolean
  terminal?: boolean
  sideQuestion?: boolean
}): ConversationCommand[] {
  return [
    ...(input.model
      ? [{ name: 'model', description: 'Choose the model, effort and permissions', source: 'app' as const }]
      : []),
    ...(input.effort
      ? [{ name: 'effort', description: 'Step to the next reasoning effort', source: 'app' as const }]
      : []),
    ...(input.terminal
      ? [{ name: 'terminal', description: 'Continue this conversation in a terminal', source: 'app' as const }]
      : []),
    ...(input.sideQuestion
      ? [{ name: 'btw', description: 'Ask a side question that stays out of the chat', source: 'app' as const }]
      : []),
  ]
}

/**
 * Studio's commands first, then the CLI's, one row per name. Studio's win a
 * clash: `/model` from the menu opens the picker here, which is what the
 * person chose it for, where the CLI's own `/model` would change the model
 * behind the chat's back.
 */
export function mergeConversationCommands(
  app: readonly ConversationCommand[],
  reported: readonly ConversationCommand[],
): ConversationCommand[] {
  const seen = new Set<string>()
  const merged: ConversationCommand[] = []
  for (const command of [...app, ...reported]) {
    const name = command.name.replace(/^\//u, '').trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    merged.push(name === command.name ? command : { ...command, name })
  }
  return merged
}

export type ConversationCommandsState = {
  /** Studio's commands and the CLI's, merged. */
  commands: ConversationCommand[]
  /** What the CLI last reported, or null before anything is known for this key. */
  catalog: ConversationCommandCatalog | null
  /** A request for this key is out and nothing has answered yet. */
  loading: boolean
  /** The menu opened: ask again when the list is older than `COMMANDS_STALE_MS`. */
  refreshIfStale: () => void
  /** Ask the CLI again now, however fresh the list: a skill or plugin was just installed. */
  refresh: () => void
}

/**
 * `discover: false` reads only what is already known — the cache and main's
 * pushes — and never asks main to list. A chat on another machine has no
 * folder here to probe; it shows a list only if one reaches it, or, with a
 * `source` of its own (that machine, asked for the chat's folder there), once
 * the menu opens and asks it: never as the chat mounts, since each ask may
 * start the CLI over there.
 */
export function useConversationCommands(
  cli: string | null,
  cwd: string | null,
  options: { appCommands?: readonly ConversationCommand[]; discover?: boolean; source?: ChatCommandSource } = {},
): ConversationCommandsState {
  const { appCommands, discover = true, source } = options
  const key = cli && cwd ? keyOf(cli, cwd) : null
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (!key) return
    const listener = () => setVersion((version) => version + 1)
    const listeners = cacheListeners.get(key) ?? new Set()
    listeners.add(listener)
    cacheListeners.set(key, listeners)
    const release = retainMainSubscription()
    return () => {
      listeners.delete(listener)
      if (!listeners.size) cacheListeners.delete(key)
      release()
    }
  }, [key])
  useEffect(() => {
    if (!cli || !cwd || !discover || source || catalogCache.has(keyOf(cli, cwd))) return
    peek(cli, cwd)
  }, [cli, cwd, discover, source])
  const catalog = key ? (catalogCache.get(key) ?? null) : null
  const loading = Boolean(key && inFlight.has(key) && !catalog?.fetchedAt)
  const reported = catalog?.commands
  const commands = useMemo(() => mergeConversationCommands(appCommands ?? [], reported ?? []), [appCommands, reported])
  const latest = useRef({ cli, cwd, discover, source })
  latest.current = { cli, cwd, discover, source }
  const refreshIfStale = useCallback(() => {
    const { cli: currentCli, cwd: currentCwd, discover: canDiscover, source: from } = latest.current
    if (!currentCli || !currentCwd || !canDiscover) return
    const key = keyOf(currentCli, currentCwd)
    const known = catalogCache.get(key)
    const now = Date.now()
    if (known && known.fetchedAt > 0 && !known.error && now - known.fetchedAt < COMMANDS_STALE_MS) return
    if (now - (requestedAt.get(key) ?? 0) < COMMANDS_RETRY_MS) return
    // `refresh` only over a list the CLI answered; an unanswered one is due anyway.
    void request(currentCli, currentCwd, Boolean(known?.fetchedAt), from)
  }, [])
  const refresh = useCallback(() => {
    const { cli: currentCli, cwd: currentCwd, discover: canDiscover, source: from } = latest.current
    if (!currentCli || !currentCwd || !canDiscover) return
    void request(currentCli, currentCwd, true, from)
  }, [])
  return { commands, catalog, loading, refreshIfStale, refresh }
}

/** Test seam: forget every list and subscription this module holds. */
export function resetConversationCommandsCache(): void {
  catalogCache.clear()
  inFlight.clear()
  peeking.clear()
  requestedAt.clear()
  unsubscribeMain?.()
  unsubscribeMain = null
}
