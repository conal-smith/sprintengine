import type { ReactNode } from 'react'
import { create } from 'zustand'

import type { Tone } from '../components/ui/tokens'

// The transient-report store behind the app's ONE toast region
// (design-system/components/toast — MC: remote-sessions-ux / toast-host-region).
//
// Deliberately not persisted and deliberately tiny: a toast is the answer to
// "did it work?" in one line, and whatever it announces must also be readable
// somewhere persistent — the row's status, the detail pane, the notification
// bell. A person who missed a toast lost nothing they cannot find, so nothing
// here survives a reload.
//
// Auto-dismiss stays the PRIMITIVE's policy (polite tones 5s, warn/error 10s)
// — the store only holds what is showing and removes what was dismissed.

// A button on a toast. SIX producers carry these: the CLI-update toast (owner
// ruling 2026-09-04 — "Update available: Codex 0.153.3" with Settings and
// Update), the app-update toast (owner ruling 2026-09-23 — Later and Restart
// to update), "Started in the background" after ⌘⏎ in New chat (Open), a
// capability module's `RendererHost.toast` with its one optional action
// (components/workspace/moduleToasts.ts), "Prompt stashed" after ⌘S in a
// composer (Undo; agentChat/promptStashPicker.tsx), and "Chat exported" after
// Export chat (Reveal in Finder; agentChat/chatExport.ts). Every other toast
// stays button-free; the design-system toast spec names all six consumers.
type ToastAction = {
  id: string
  label: string
  primary?: boolean
  /** The press went through and its work is running: disabled, with a spinner. */
  busy?: boolean
  run: () => void
}

type AppToast = {
  id: string
  tone: Tone
  title: string
  description?: string
  /** True when the producer supplied the id (it may retract); such toasts never title-dedupe. */
  stableId?: boolean
  actions?: ToastAction[]
  /** An agent CLI's glyph in place of the tone dot (the CLI-update toast). */
  cli?: string
  /** The acting body, under the description: the pair-request toast's code
   *  field and its two answers, and nothing else (see `ShowToastInput`). */
  content?: ReactNode
  /** Override the tone's auto-dismiss: `false` keeps the toast until acted on. */
  autoDismissMs?: number | false
  /** The person pressed Dismiss (never the timer) — see `ShowToastInput`. */
  onDismissPressed?: () => void
}

export type ShowToastInput = {
  tone: Tone
  title: string
  description?: string
  /**
   * A stable identity for a toast that a producer will later RETRACT
   * (`pair-request:<id>`, `mesh:<connectionId>`). Showing again under the
   * same id replaces the toast in place and keeps the id, so the producer's
   * handle never goes stale. Id-less toasts dedupe on (tone, title) instead.
   * A replaced toast keeps its React key, so a polite tone's auto-dismiss
   * clock is NOT restarted by a re-show.
   */
  id?: string
  actions?: ToastAction[]
  cli?: string
  /**
   * A rendered body between the description and the action row. ONE producer
   * has one (owner ruling 2026-09-05, recorded in the design system's toast
   * spec): the incoming pair request, whose whole answer is six digits typed
   * while looking at the screen that shows them — sending the person to
   * another surface to type them was the friction the ruling spent. A second
   * consumer is a design decision to record there, not a styling choice; a
   * toast is still not a form.
   */
  content?: ReactNode
  autoDismissMs?: number | false
  /**
   * Called when the person presses the toast's Dismiss, and only then: a toast
   * that timed out, was shed or was replaced was not dismissed by anyone. The
   * two update toasts use it to clear the update's badges (owner ruling
   * 2026-09-25) — Dismiss on "Update available" means "not now".
   */
  onDismissPressed?: () => void
}

interface ToastStore {
  /** Oldest first: the region renders top-to-bottom, so newest lands at the bottom (spec). */
  toasts: AppToast[]
  showToast: (input: ShowToastInput) => string
  dismissToast: (id: string) => void
}

let nextToastId = 0

/**
 * The stack stays a report, not a backlog: a repeat of the SAME report
 * (the same stable id, or for id-less toasts the same tone + title) replaces
 * its predecessor in place — a drag that fails five times is one "File
 * action failed", freshly worded, exactly what the old self-replacing inline
 * toast did — and the region holds at most this many,
 * shedding the OLDEST polite toast first. Warn and error are only ever shed
 * by another of their kind arriving, so an error cannot be pushed out by a
 * parade of successes before its own clock runs.
 */
const MAX_TOASTS = 6
const PROTECTED_TONES: ReadonlySet<AppToast['tone']> = new Set(['warn', 'error'])

export const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],

  showToast: (input) => {
    const id = input.id ?? `toast-${++nextToastId}`
    set((state) => {
      // A stable id replaces ONLY its own predecessor and keeps the id — a
      // producer holding it must still be able to retract. Title-dedupe is
      // for id-less reports alone, so two machines' "Connection lost" never
      // collapse into one.
      const replaced = input.id
        ? state.toasts.find((toast) => toast.id === input.id)
        : state.toasts.find((toast) => !toast.stableId && toast.tone === input.tone && toast.title === input.title)
      const stableId = input.id !== undefined
      // Replaced, not merged: a field the new input leaves out is gone. The
      // CLI-update toast re-shown as "Codex updated to 0.155.0" used to keep
      // the question's Update button and its never-dismiss from the toast it
      // replaced, so a finished update still offered to run itself.
      let toasts = replaced
        ? state.toasts.map((toast) => (toast === replaced ? { ...input, id, stableId } : toast))
        : [...state.toasts, { ...input, id, stableId }]
      if (toasts.length > MAX_TOASTS) {
        const shed = toasts.find((toast) => !PROTECTED_TONES.has(toast.tone)) ?? toasts[0]
        toasts = toasts.filter((toast) => toast !== shed)
      }
      return { toasts }
    })
    return id
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))

/** Imperative door for non-component producers (event bridges, utilities). */
export function showToast(input: ShowToastInput): string {
  return useToastStore.getState().showToast(input)
}
