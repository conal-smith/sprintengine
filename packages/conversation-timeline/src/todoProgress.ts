// Where the agent is in its own checklist, read off the transcript: the latest
// todo write of the current (or last) turn is the whole list, since every write
// replaces the one before it. Pure, so the strip above the composer and its
// tests share one reading.

import type { TranscriptEntry } from './conversationProjection.js'

export type TodoStepStatus = 'pending' | 'in_progress' | 'completed'

export type TodoStep = { label: string; status: TodoStepStatus }

export type TodoProgress = {
  steps: TodoStep[]
  completed: number
  total: number
  // The step being worked on — the first in progress, else the next one due,
  // else the last one finished — worded as the agent worded it while running.
  current: string
  // The turn that wrote the list is still running.
  live: boolean
}

// Null for a step the agent dropped. OpenCode marks one `cancelled` and keeps it
// in the list; it is not work left to do, so it is left out rather than read as
// pending, which would keep a list whose other steps are done from finishing.
function readStatus(value: unknown): TodoStepStatus | null {
  const status = typeof value === 'string' ? value.toLowerCase().replace(/[\s-]/gu, '_') : ''
  if (status === 'cancelled' || status === 'canceled') return null
  if (status === 'completed' || status === 'done') return 'completed'
  if (status === 'in_progress' || status === 'inprogress' || status === 'active') return 'in_progress'
  return 'pending'
}

function readText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// The list a todo write carries, less the steps the agent cancelled. A provider
// that reports its plan as free text rather than as items has no steps to
// count, so it yields none.
export function readTodoSteps(input: unknown): (TodoStep & { activeLabel?: string })[] {
  const todos =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).todos : undefined
  if (!Array.isArray(todos)) return []
  return todos.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    const label = readText(record, 'content', 'description', 'step', 'title')
    const status = readStatus(record.status)
    if (!label || !status) return []
    const activeLabel = readText(record, 'activeForm')
    return [{ label, status, ...(activeLabel ? { activeLabel } : {}) }]
  })
}

// The list only speaks for the turn that wrote it: a message sent after that
// turn starts a new one, and until it writes a list of its own there is none to
// show. A finished list is hidden once its turn ends — nothing is left to track
// — while an unfinished one stays, since the work it names was not done.
export function deriveTodoProgress(entries: readonly TranscriptEntry[], activeTurn: boolean): TodoProgress | null {
  let latest: Extract<TranscriptEntry, { kind: 'tool' }> | undefined
  let turn: Extract<TranscriptEntry, { kind: 'assistant' }> | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind === 'user') return null
    if (entry.kind === 'assistant') {
      turn = entry
      break
    }
    if (!latest && entry.kind === 'tool' && (entry.toolKind === 'todo' || entry.name === 'TodoWrite')) latest = entry
  }
  if (!turn || !latest) return null
  const read = readTodoSteps(latest.input)
  if (read.length === 0) return null
  const completed = read.filter((step) => step.status === 'completed').length
  const live = activeTurn && turn.status === 'streaming'
  if (!live && completed === read.length) return null
  const focus =
    read.find((step) => step.status === 'in_progress') ?? read.find((step) => step.status === 'pending') ?? read.at(-1)!
  return {
    steps: read.map(({ label, status }) => ({ label, status })),
    completed,
    total: read.length,
    current: focus.status === 'in_progress' ? (focus.activeLabel ?? focus.label) : focus.label,
    live,
  }
}
