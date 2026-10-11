import React from 'react'

import type { AgentCli } from '../../types/workspace'

// Starred runtimes, kept in localStorage so they survive a restart, and shared
// by every mounted picker through one subscription — two open pickers must
// never disagree about what is starred.
//
// The store is a flat list of "<cli>:<model>" keys (the CLI's own default model
// is the empty model part). Ids, not labels: a catalog that relabels a model
// keeps the star, and a model that leaves the catalog simply stops matching
// any row rather than resurrecting as a ghost entry.
//
// An older build could also star a model composed with a role, stored as the
// plain key plus a `:role:<id>` suffix. Roles are gone, so such a key is simply
// never shown (see isLegacyCompositionKey); it stays in the store untouched.

const STORAGE_KEY = 'sprintengine.model-favourites'

const ROLE_MARKER = ':role:'

export function modelFavouriteKey(cli: AgentCli, model: string | null | undefined): string {
  return `${cli}:${model ?? ''}`
}

/** True for a star an older build saved as a model composed with a role. */
export function isLegacyCompositionKey(key: string): boolean {
  const at = key.lastIndexOf(ROLE_MARKER)
  return at >= 0 && key.length > at + ROLE_MARKER.length
}

/** The stored list; null when localStorage itself cannot be read. */
function readStored(): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch (error) {
    // A hand-corrupted value must not take the picker down with it. No stars
    // is the honest fallback: every model is still reachable through its
    // provider.
    if (error instanceof SyntaxError) return []
    // localStorage can throw in restricted contexts.
    return null
  }
}

let cache: string[] | null = null
const listeners = new Set<() => void>()

function snapshot(): string[] {
  if (cache === null) cache = readStored() ?? []
  return cache
}

function publish(next: string[]): void {
  cache = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The in-memory list still updates, so the session behaves; only the
    // survival across restarts is lost, which is exactly what a blocked
    // localStorage means.
  }
  for (const listener of listeners) listener()
}

// Every Studio window keeps its own copy of the list, and the browser tells
// every OTHER window when one of them writes it — exactly the set of windows
// whose copy just went stale. Without this a second window never saw a star set
// in the first. Installed once, on the first subscriber, and kept: a picker
// that mounts later must not start from a copy that missed a write.
let followingOtherWindows = false

function followOtherWindows(): void {
  if (followingOtherWindows || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  followingOtherWindows = true
  window.addEventListener('storage', (event) => {
    // A null key is the whole of localStorage being cleared.
    if (event.key !== STORAGE_KEY && event.key !== null) return
    cache = null
    for (const listener of listeners) listener()
  })
}

function subscribe(listener: () => void): () => void {
  followOtherWindows()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function toggleModelFavourite(key: string): void {
  // The write replaces the whole list, so it starts from what is stored now:
  // another window may have starred something since this one last looked, and
  // toggling from the copy here would erase that star. The copy stands in only
  // when localStorage cannot be read at all.
  const current = readStored() ?? snapshot()
  publish(current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])
}

/** Test seam: drops the shared cache so a suite can start from a known store. */
export function __resetModelFavouritesForTest(): void {
  cache = null
  for (const listener of listeners) listener()
}

export function useModelFavourites(): string[] {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot)
}
