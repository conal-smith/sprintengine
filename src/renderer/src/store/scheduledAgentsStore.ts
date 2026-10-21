// The scheduled agents, as every surface in this window reads them: one fetch,
// then main's broadcast after every change — a write from any window, an
// extension or an agent, and each run's outcome. Main owns the list; this is
// its mirror. Beside it, the same for the pause of every scheduled agent at
// once, which main says with every change to the list.

import { useSyncExternalStore } from 'react'

import type { ScheduledAgentView, ScheduledAgentsPause } from '../../../shared/scheduled-agents'

const EMPTY: ScheduledAgentView[] = []
let agents: ScheduledAgentView[] = EMPTY
let pausedAll: ScheduledAgentsPause | null = null
let started = false
// Whether a broadcast has landed: main sends the whole list on every change,
// so one that arrives before the first fetch answers is newer than that answer.
let broadcastSeen = false
let pauseBroadcastSeen = false
const listeners = new Set<() => void>()

function publish(next: unknown): void {
  // Anything but a list is no list: an older main, or a stubbed bridge.
  agents = Array.isArray(next) ? (next as ScheduledAgentView[]) : EMPTY
  for (const listener of listeners) listener()
}

function publishPause(next: unknown): void {
  // Anything but a pause is none: an older main says nothing of one.
  const pause = next as Partial<ScheduledAgentsPause> | null | undefined
  pausedAll =
    pause && typeof pause.since === 'number' && (pause.until === null || typeof pause.until === 'number')
      ? { since: pause.since, until: pause.until }
      : null
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const bridge = typeof window === 'undefined' ? undefined : (window.api as Partial<Window['api']> | undefined)
  // An older preload, or a test that stubs none of this: no scheduled agents.
  if (typeof bridge?.listScheduledAgents !== 'function') return
  bridge.onScheduledAgentsChanged?.((next) => {
    broadcastSeen = true
    publish(next)
  })
  void bridge
    .listScheduledAgents()
    .then((listed) => {
      if (!broadcastSeen) publish(listed)
    })
    .catch(() => undefined)
  bridge.onScheduledAgentsPauseChanged?.((next) => {
    pauseBroadcastSeen = true
    publishPause(next)
  })
  void bridge
    .getScheduledAgentsPause?.()
    .then((pause) => {
      if (!pauseBroadcastSeen) publishPause(pause)
    })
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useScheduledAgents(): ScheduledAgentView[] {
  return useSyncExternalStore(subscribe, () => agents)
}

/** Every scheduled agent paused at once, and until when; null when they are not. */
export function useScheduledAgentsPause(): ScheduledAgentsPause | null {
  return useSyncExternalStore(subscribe, () => pausedAll)
}

/** Test seam: forget the mirror and its subscription. */
export function resetScheduledAgentsStoreForTests(): void {
  agents = EMPTY
  pausedAll = null
  started = false
  broadcastSeen = false
  pauseBroadcastSeen = false
  listeners.clear()
}
