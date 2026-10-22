// What a palette result SOURCE is, so that adding one is not editing an
// 800-line component.
//
// CommandPalette grew six hardcoded groups, one bespoke async path (ripgrep,
// with its own debounce, its own sequence guard and its own cancel), and a
// second, differently-shaped async path for skills that had neither. A third
// source — every skill and plugin in every configured source — could not be
// added to that without a fourth shape. So the shape is named once here, and
// the three real sources are its three implementations:
//
//   • the disk provider  — asks the main process per keystroke, debounced,
//     superseded runs discarded, the ripgrep child cancelled;
//   • the skills provider — warms the installed inventory once when the
//     palette opens, then filters it in memory per keystroke;
//   • the extensions provider — the same, over every source's cached scan and
//     the first-party registry.
//
// Nothing here renders. The palette renders `PaletteCommand`s; this module
// decides when to ask for them, which run wins, and who says "Searching…".

import { useEffect, useMemo, useRef, useState } from 'react'

import type { PaletteCommandGroup, PaletteScope } from '../commandPaletteSearch'
import type { Workspace } from '../../types/workspace'
import { errorMessage } from '../../../../shared/errors'

/**
 * The mark a row that is not a file or an extension wears — named, not drawn,
 * because this module renders nothing. The palette maps each to the glyph the
 * rest of the product already uses for the same thing: the compose mark the
 * sidebar's "New chat" wears, the generic file tile, the search glyph, the
 * settings gear, the remote-machine glyph, and for a chat the agent CLI's
 * mark in the sidebar's round chip (or the workspace type's icon when no
 * agent has run in it). A panel or git command wears none: the verb is the
 * whole row.
 */
export type PaletteRowMark =
  | { kind: 'new-chat' }
  | { kind: 'go-to-file' }
  | { kind: 'search' }
  | { kind: 'settings' }
  | { kind: 'remote' }
  | { kind: 'chat'; workspaceId: string; mode: Workspace['mode'] }

/** A chat's matching message, as its row carries it (`PaletteCommand.conversationMatch`). */
export type PaletteConversationMatch = {
  snippet: string
  from?: 'person' | 'agent' | 'studio'
  count: number
}

/** The artwork a row wears, in the props `ExtensionIcon` takes. */
export type PaletteRowIcon = {
  glyph?: string
  icon?: string
  iconPlated?: boolean
}

/**
 * One row of the palette.
 *
 * The three fields beyond the original launcher row — `icon`, `badge`,
 * `installed` — are what a search across sources needs a row to say: what the
 * thing looks like, where it came from, and whether you already have it. They
 * are optional, so every existing row is unchanged.
 */
export interface PaletteCommand {
  id: string
  label: string
  /**
   * The row's own name when the label wraps it in one of the palette's verbs
   * ("Switch to: <workspace>"). Ranked, never displayed — see
   * `CommandSearchFields.searchLabel` in commandPaletteSearch.ts for why.
   */
  searchLabel?: string
  description?: string
  /** Searched, never displayed: a workspace's mode terms, a plugin's keywords. */
  keywords?: string
  shortcut?: string
  group: PaletteCommandGroup
  /** The mark beside the name, for rows that have one. */
  icon?: PaletteRowIcon
  /**
   * The file this row is about, by name, for the rows that are about one — a
   * file match, an open editor, a line of text in a file. The palette draws
   * the kind glyph the File Explorer and the Git changes list wear for the
   * same name (`FileTypeGlyph`), so a `.ts` row is recognised by the same
   * blue tile everywhere the product names a file. Never an icon of ours:
   * this module renders nothing, so it says WHICH file and the palette draws.
   */
  file?: string
  /**
   * Where a line of text was found: the file's workspace-relative path and
   * the line number. Only a `content` row carries them, and it is what lets
   * the palette draw the hits the way a search tool does — grouped under
   * the file, each line with its number in the gutter — rather than as one
   * flat list restating the path on every row.
   */
  path?: string
  line?: number
  /** The row's glyph, for the rows that are neither a file nor an extension. */
  mark?: PaletteRowMark
  /**
   * For a chat found by what was said in it: the message the row shows, who
   * wrote it, and how many of the chat's messages matched. The palette draws
   * the message under the title, with the query in it marked.
   */
  conversationMatch?: PaletteConversationMatch
  /** A short chip after the name: the source's name, "Installed", "Available". */
  badge?: string
  /** Tri-state on purpose — see `PaletteRankable` in commandPaletteSearch.ts. */
  installed?: boolean
  run: () => void
}

/** What every provider is given: where it is, and how to dismiss the palette. */
export interface PaletteProviderContext {
  /** The active workspace's folder, or null when none is open. */
  workspaceRoot: string | null
  workspaceId: string | null
  /** The scope the palette is showing — a provider may cap harder when broad. */
  scope: PaletteScope
  /** Close the overlay. Every row that navigates calls it. */
  close: () => void
}

/**
 * A source of palette rows.
 *
 * `load` may be synchronous — an in-memory filter over what `warm` fetched —
 * or a promise, and the runner treats both the same. Throwing is how a
 * provider reports a failure the person would otherwise read as "no matches";
 * returning an empty list is how it reports nothing found.
 */
export interface PaletteResultProvider {
  /** Stable across renders — it keys the runner's per-provider state. */
  id: string
  /** The group its rows land in. Used for the runner's own bookkeeping only. */
  group: PaletteCommandGroup
  /**
   * Fetch once when the palette opens. Failures are the provider's to swallow.
   *
   * `refresh` asks the runner to re-run this provider's `load` now, before the
   * warm has settled — for a warm with a fast leg and a slow one, so the rows
   * the fast leg produced are on screen while the slow one is still out. The
   * runner asks again on its own when the whole warm settles.
   */
  warm?: (context: PaletteProviderContext, refresh: () => void) => void | Promise<void>
  load: (
    query: string,
    context: PaletteProviderContext,
    publish?: (commands: PaletteCommand[]) => void,
  ) => PaletteCommand[] | Promise<PaletteCommand[]>
  /** Below this many characters the provider is not asked at all. Default 0. */
  minQueryLength?: number
  /** Wait for a pause before asking. Default 0 — an in-memory filter needs none. */
  debounceMs?: number
  /** Stop work already in flight, when a run is superseded or the palette closes. */
  cancel?: () => void
  /**
   * True when the provider has something to say with no query at all. The disk
   * providers do not: with an empty query there is nothing to have searched
   * for, and the resting palette stays the launcher it was.
   */
  respondsToEmptyQuery?: boolean
}

/** What the runner knows about every provider at once. */
export interface PaletteProviderResults {
  commands: PaletteCommand[]
  /** True while any provider that is not instant is working. */
  loading: boolean
  /** The first failure worth showing instead of "No results"; null otherwise. */
  error: string | null
}

type ProviderState = {
  commands: PaletteCommand[]
  loading: boolean
  error: string | null
}

const IDLE: ProviderState = { commands: [], loading: false, error: null }

/**
 * Run every provider against the query and merge what they say.
 *
 * The context is read through a ref rather than passed as a dependency: it
 * carries `close`, which a parent re-creates on most renders, and re-running a
 * ripgrep search because a callback got a new identity is the bug the sequence
 * guard exists to paper over. What a run depends on is the provider (memoized
 * by its own real inputs) and the query — nothing else.
 */
export function usePaletteProviders(
  providers: readonly PaletteResultProvider[],
  query: string,
  context: PaletteProviderContext,
): PaletteProviderResults {
  const contextRef = useRef(context)
  contextRef.current = context

  const [states, setStates] = useState<Record<string, ProviderState>>({})
  // Bumped when a warm finishes. A provider whose rows arrive after the first
  // keystroke has to be ASKED again — otherwise the palette holds the empty
  // list `load` returned while the fetch was still in flight, and the person
  // watches a search box that has the answer and will not show it.
  const [warmTick, setWarmTick] = useState(0)

  // Warm once per palette lifetime, per provider. A provider that appears
  // later warms when it first does; the set is static today.
  const warmed = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    providers.forEach((provider) => {
      if (!provider.warm || warmed.current.has(provider.id)) return
      warmed.current.add(provider.id)
      const done = (): void => {
        if (mounted.current) setWarmTick((tick) => tick + 1)
      }
      try {
        void Promise.resolve(provider.warm(contextRef.current, done)).then(done, done)
      } catch {
        // A provider that cannot even start warming lists nothing rather than
        // taking the palette down with it.
      }
    })
  }, [providers])

  const trimmed = query.trim()

  // One effect for the whole set rather than one per provider: the set is
  // static for a palette's lifetime, and a single effect keyed on [providers,
  // query] is what makes "supersede every run when the query changes" one
  // statement instead of N races. The cleanup IS the sequence guard the disk
  // search used to hand-roll — a superseded run's `live` is false before its
  // successor starts, so a slow answer can never overwrite a fresh one.
  useEffect(() => {
    let live = true
    const timers: number[] = []
    const started: PaletteResultProvider[] = []

    const put = (id: string, patch: (previous: ProviderState) => ProviderState): void => {
      if (!live) return
      setStates((current) => ({ ...current, [id]: patch(current[id] ?? IDLE) }))
    }

    providers.forEach((provider) => {
      const tooShort = trimmed.length < (provider.minQueryLength ?? 0)
      if ((!trimmed && !provider.respondsToEmptyQuery) || tooShort) {
        put(provider.id, () => IDLE)
        return
      }
      const run = (): void => {
        started.push(provider)
        let pending = false
        try {
          const produced = provider.load(trimmed, contextRef.current, (commands) => {
            put(provider.id, () => ({ commands, loading: true, error: null }))
          })
          if (Array.isArray(produced)) {
            put(provider.id, () => ({ commands: produced, loading: false, error: null }))
          } else {
            pending = true
            void produced
              .then((commands) => put(provider.id, () => ({ commands, loading: false, error: null })))
              .catch((error: unknown) =>
                put(provider.id, () => ({ commands: [], loading: false, error: errorMessage(error) })),
              )
          }
        } catch (error) {
          put(provider.id, () => ({ commands: [], loading: false, error: errorMessage(error) }))
        }
        // Only a provider still in flight says it is working: a synchronous
        // filter must never flash "Searching…" for a frame.
        if (pending) put(provider.id, (previous) => ({ ...previous, loading: true, error: null }))
      }
      const debounce = provider.debounceMs ?? 0
      if (debounce > 0) {
        // The previous rows stay on screen while the pause is waited out —
        // clearing them would blank the list between every two keystrokes.
        put(provider.id, (previous) => ({ ...previous, loading: true, error: null }))
        timers.push(window.setTimeout(run, debounce))
      } else {
        run()
      }
    })

    return () => {
      live = false
      timers.forEach((timer) => window.clearTimeout(timer))
      // Superseded or unmounted: stop the work rather than let it run for a
      // query nobody is waiting on.
      started.forEach((provider) => provider.cancel?.())
    }
  }, [providers, trimmed, warmTick])

  return useMemo(() => {
    const commands: PaletteCommand[] = []
    let loading = false
    let error: string | null = null
    providers.forEach((provider) => {
      const state = states[provider.id] ?? IDLE
      commands.push(...state.commands)
      if (state.loading) loading = true
      if (!error && state.error) error = state.error
    })
    return { commands, loading, error }
  }, [providers, states])
}
