// A scheduled agent: a prompt and a schedule. When the schedule comes round, a
// new chat starts in the project with that prompt as its first message — the
// same chat New chat would start, in a workspace of its own, on the machine
// and with the model, permissions, skills, MCP servers and worktree picked when
// it was scheduled. Nothing carries from one run to the next, and nothing about
// a run is kept here but whether the last one started: each run's chat carries
// this record's id (`Workspace.scheduledAgentId`) instead, so the chats are
// where the runs are listed from. A run never makes, removes or fires a
// scheduled agent (the MCP tools refuse a run's chat), so the schedule a person
// set up is the one long-lived thing, and its runs come and go under it.
//
// Scheduled agents live in the app's own data on this computer, never in the
// project, so a commit someone else pushes can never schedule anything here.
//
// This module is the pure half both processes share: the record, its draft,
// validation, and the words and times every surface reads off the schedule.

import type { CliPermissionPreset } from './cli-permission-preset'
import { parseCliPermissionPreset } from './cli-permission-preset'
import { describeCronSchedule, nextCronRun, nextCronRuns, parseCronSchedule } from './cron'
import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import { isRecord } from './records'

export type ScheduledAgentSchedule = {
  /** Five-field cron; several expressions separated by `;`. */
  cron: string
  /** The IANA zone the cron's wall-clock is read in: the machine it runs on. */
  timezone: string
  /**
   * One run, at this instant (epoch ms), instead of the cron's repeats: a
   * message to start a chat with later, once. The cron then names the same
   * minute (`cronForInstant`), so whatever reads the cron alone still reads
   * a true schedule. A one-time schedule that has run is done: the scheduler
   * closes it once its chat has started, and keeps one whose run failed, with
   * no next run, so the failure is seen.
   */
  once?: number
}

/** A skill or an installed MCP server, by id, with the name its chip shows. */
export type ScheduledAgentAttachment = { id: string; name: string }

/**
 * Whether the last run started its chat, and where. `agentId` is the run's
 * chat agent in `workspaceId`; absent on a run recorded before it was kept.
 */
export type ScheduledAgentLastRun =
  { at: number; ok: true; workspaceId: string; agentId?: string } | { at: number; ok: false; message: string }

/** A run whose chat started: when, and the chat it started (workspace and agent). */
export type ScheduledAgentRun = { at: number; workspaceId: string; agentId: string }

export type ScheduledAgent = {
  id: string
  /**
   * The scheduled agent's title in the sidebar and its editor. Absent, the
   * prompt's first line is.
   */
  name?: string
  /**
   * The creator's own label for it, carried onto each run's chat (the agent
   * record's `scheduledAgentTag`) so whoever made it can tell which of its
   * schedules a chat came from. Never shown to the person.
   */
  tag?: string
  /** The first message each run's chat is sent. Its first line is the scheduled agent's title. */
  prompt: string
  schedule: ScheduledAgentSchedule
  /** The project each run starts in. */
  folderPath: string
  /**
   * The machine on this computer each run starts on. Null is this machine,
   * or the distribution a folder inside one lives in; `local` is this machine
   * for such a folder (owner ruling 2026-10-03).
   */
  hostId: ExecutionHostId | null
  cli: string
  cliModel: string | null
  /** Absent, the preset chosen for that CLI at run time. */
  permissionPreset: CliPermissionPreset | null
  skills: ScheduledAgentAttachment[]
  mcpServers: ScheduledAgentAttachment[]
  /** A fresh worktree per run, named from this; null runs in the project's checkout. */
  worktree: { name: string } | null
  /** The extension that created it, when one did. */
  ownerModuleId: string | null
  createdAt: number
  updatedAt: number
  lastRun: ScheduledAgentLastRun | null
  /** When a failed last run was last looked at; the card says "Failed" until then. */
  lastFailureSeenAt: number | null
  /**
   * When the person paused it; absent while it runs on its schedule. A paused
   * schedule starts nothing at its times, and the times that pass while it is
   * paused are not made up when it resumes: it runs next at the first time
   * after that. Run now still runs it, and pausing leaves a run already going
   * alone.
   */
  pausedAt?: number
}

/**
 * Every scheduled agent paused at once, apart from each one's own pause:
 * since when, and until when (null until the person resumes them). Resuming
 * them all leaves a schedule paused on its own still paused.
 */
export type ScheduledAgentsPause = { since: number; until: number | null }

/**
 * What a person (or an extension, or an agent) writes: everything but the
 * bookkeeping. A draft without `name` or `tag` keeps the ones the scheduled
 * agent has, so the New chat panel editing an extension's schedule does not
 * drop them; an empty one clears it.
 */
export type ScheduledAgentDraft = Pick<
  ScheduledAgent,
  | 'name'
  | 'tag'
  | 'prompt'
  | 'schedule'
  | 'folderPath'
  | 'hostId'
  | 'cli'
  | 'cliModel'
  | 'permissionPreset'
  | 'skills'
  | 'mcpServers'
  | 'worktree'
>

/** A scheduled agent as the renderer lists it: the record plus when it runs next. */
export type ScheduledAgentView = ScheduledAgent & { nextRunAt: number | null }

export type ScheduledAgentWriteResult = { ok: true; agent: ScheduledAgentView } | { ok: false; message: string }

export const SCHEDULED_AGENTS_CHANGED_CHANNEL = 'scheduled-agents:changed'
/** Every scheduled agent paused, or not: the `ScheduledAgentsPause`, or null. */
export const SCHEDULED_AGENTS_PAUSE_CHANGED_CHANNEL = 'scheduled-agents:pause-changed'

export const SCHEDULED_AGENTS_IPC = {
  list: 'scheduled-agents:list',
  create: 'scheduled-agents:create',
  update: 'scheduled-agents:update',
  remove: 'scheduled-agents:remove',
  runNow: 'scheduled-agents:run-now',
  markSeen: 'scheduled-agents:mark-seen',
  pause: 'scheduled-agents:pause',
  resume: 'scheduled-agents:resume',
  pauseState: 'scheduled-agents:pause-state',
  pauseAll: 'scheduled-agents:pause-all',
  resumeAll: 'scheduled-agents:resume-all',
} as const

/** Whether a pause of every scheduled agent holds at `now`: set, and its until not yet come. */
export function scheduledAgentsPauseHolds(pause: ScheduledAgentsPause | null, now: number): boolean {
  return pause !== null && (pause.until === null || pause.until > now)
}

/** The schedule a new scheduled agent starts on before anyone changes it: weekdays at 9 AM. */
export const DEFAULT_SCHEDULED_AGENT_CRON = '0 9 * * 1-5'

const MAX_TITLE_LENGTH = 80
const MAX_NAME_LENGTH = 120
const MAX_TAG_LENGTH = 200

/** The sidebar's name for a scheduled agent: the name it was given, else its prompt's first line. */
export function scheduledAgentTitle(prompt: string, name?: string): string {
  const firstLine =
    name?.trim() ||
    prompt
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ||
    ''
  if (!firstLine) return 'Scheduled agent'
  return firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : firstLine
}

/** The schedule in words, or null when the cron does not parse. */
export function scheduledAgentScheduleWords(
  schedule: Pick<ScheduledAgentSchedule, 'cron'> & Partial<Pick<ScheduledAgentSchedule, 'timezone' | 'once'>>,
): string | null {
  if (schedule.once !== undefined) return `Once, ${onceWords(schedule.once, schedule.timezone)}`
  const parsed = parseCronSchedule(schedule.cron)
  return parsed.ok ? describeCronSchedule(parsed.schedule) : null
}

/** "Wed 7 Oct at 3:00 PM", in the schedule's zone. */
function onceWords(at: number, timeZone: string | undefined): string {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).formatToParts(new Date(at))
  } catch {
    return new Date(at).toISOString()
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')}`.trim()
}

/**
 * The cron that names `at`'s minute in `timeZone`: "30 15 7 10 *". What a
 * one-time schedule carries as its cron, so a reader of the cron alone reads
 * the right day and time.
 */
export function cronForInstant(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return `${get('minute')} ${get('hour') % 24} ${get('day')} ${get('month')} *`
}

/**
 * When a one-time schedule is due: its instant, until a run has gone at or
 * after it — a Run now before the time does not use it up. Null once run,
 * and for a repeating schedule.
 */
export function scheduledAgentOnceDue(agent: Pick<ScheduledAgent, 'schedule' | 'lastRun'>): number | null {
  const once = agent.schedule.once
  if (once === undefined) return null
  return agent.lastRun && agent.lastRun.at >= once ? null : once
}

export function nextScheduledAgentRun(schedule: ScheduledAgentSchedule, after: number): number | null {
  if (schedule.once !== undefined) return schedule.once > after ? schedule.once : null
  const parsed = parseCronSchedule(schedule.cron)
  if (!parsed.ok) return null
  try {
    return nextCronRun(parsed.schedule, schedule.timezone, after)
  } catch {
    return null
  }
}

export function nextScheduledAgentRuns(schedule: ScheduledAgentSchedule, after: number, count: number): number[] {
  if (schedule.once !== undefined) return schedule.once > after && count > 0 ? [schedule.once] : []
  const parsed = parseCronSchedule(schedule.cron)
  if (!parsed.ok) return []
  try {
    return nextCronRuns(parsed.schedule, schedule.timezone, after, count)
  } catch {
    return []
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export type ScheduledAgentDraftValidation = { ok: true; draft: ScheduledAgentDraft } | { ok: false; message: string }

/**
 * A draft from any door — the New chat panel, an extension, an agent's MCP
 * call — held to one bar. A schedule that never runs (the 30th of February) is
 * refused here rather than saved to sit silent, as is a one-time schedule for
 * a time already gone — except one read back from the file (`stored`), whose
 * time may well have passed while it ran, or while the app was closed.
 */
export function validateScheduledAgentDraft(
  input: unknown,
  now: number,
  options: { stored?: boolean } = {},
): ScheduledAgentDraftValidation {
  if (!isRecord(input)) return { ok: false, message: 'A scheduled agent must be an object.' }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return { ok: false, message: 'A scheduled agent needs a prompt.' }
  const folderPath = typeof input.folderPath === 'string' ? input.folderPath.trim() : ''
  if (!folderPath) return { ok: false, message: 'A scheduled agent needs a project folder to run in.' }
  const cli = typeof input.cli === 'string' ? input.cli.trim() : ''
  if (!cli) return { ok: false, message: 'A scheduled agent needs an agent CLI to run.' }

  const schedule = isRecord(input.schedule) ? input.schedule : null
  const timezone = typeof schedule?.timezone === 'string' ? schedule.timezone.trim() : ''
  if (!timezone || !isValidTimeZone(timezone)) {
    return { ok: false, message: `"${timezone}" is not a timezone this computer knows.` }
  }
  const rawOnce = schedule?.once
  let once: number | undefined
  if (rawOnce !== undefined && rawOnce !== null) {
    if (typeof rawOnce !== 'number' || !Number.isFinite(rawOnce) || rawOnce <= 0) {
      return { ok: false, message: 'A one-time schedule needs the time it runs at.' }
    }
    if (!options.stored && rawOnce <= now) return { ok: false, message: 'That time has already passed.' }
    once = Math.floor(rawOnce)
  }
  // A one-time schedule's cron is its minute, whatever was written beside it.
  const cron =
    once !== undefined ? cronForInstant(once, timezone) : typeof schedule?.cron === 'string' ? schedule.cron.trim() : ''
  const parsed = parseCronSchedule(cron)
  if (!parsed.ok) return { ok: false, message: parsed.error }
  if (once === undefined && nextCronRun(parsed.schedule, timezone, now) === null) {
    return { ok: false, message: 'That schedule never comes round — no calendar has that day.' }
  }

  const hostId = input.hostId === null || input.hostId === undefined ? null : normalizeExecutionHostId(input.hostId)
  if (hostId === null && input.hostId !== null && input.hostId !== undefined) {
    return { ok: false, message: 'A scheduled agent runs on this machine or one of its WSL distributions.' }
  }
  const permissionPreset =
    input.permissionPreset === null || input.permissionPreset === undefined
      ? null
      : parseCliPermissionPreset(input.permissionPreset)
  if (input.permissionPreset !== null && input.permissionPreset !== undefined && permissionPreset === null) {
    return { ok: false, message: `"${String(input.permissionPreset)}" is not a permission preset.` }
  }
  const worktreeName =
    isRecord(input.worktree) && typeof input.worktree.name === 'string' ? input.worktree.name.trim() : null
  // Left out when the draft does not name it, so an edit keeps the one there;
  // empty (or null) clears it.
  const name = optionalLabel(input, 'name', MAX_NAME_LENGTH)
  if (name === false)
    return { ok: false, message: `A scheduled agent's name is text of at most ${MAX_NAME_LENGTH} characters.` }
  const tag = optionalLabel(input, 'tag', MAX_TAG_LENGTH)
  if (tag === false)
    return { ok: false, message: `A scheduled agent's tag is text of at most ${MAX_TAG_LENGTH} characters.` }

  return {
    ok: true,
    draft: {
      ...(name !== undefined ? { name } : {}),
      ...(tag !== undefined ? { tag } : {}),
      prompt,
      schedule: { cron, timezone, ...(once !== undefined ? { once } : {}) },
      folderPath,
      hostId,
      cli,
      cliModel: typeof input.cliModel === 'string' && input.cliModel.trim() ? input.cliModel.trim() : null,
      permissionPreset,
      skills: attachments(input.skills),
      mcpServers: attachments(input.mcpServers),
      worktree: isRecord(input.worktree) ? { name: worktreeName ?? '' } : null,
    },
  }
}

// A name or tag in a draft: absent (undefined), cleared (''), the trimmed text,
// or false for something that is not text that short.
function optionalLabel(input: Record<string, unknown>, key: 'name' | 'tag', max: number): string | undefined | false {
  if (!(key in input) || input[key] === undefined) return undefined
  if (input[key] === null) return ''
  if (typeof input[key] !== 'string') return false
  const value = input[key].trim()
  return value.length > max ? false : value
}

/** A record's name and tag as stored: a cleared one is absent, never empty. */
export function withoutEmptyLabels<T extends { name?: string; tag?: string }>(record: T): T {
  const next = { ...record }
  if (next.name === '') delete next.name
  if (next.tag === '') delete next.tag
  return next
}

function attachments(input: unknown): ScheduledAgentAttachment[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: ScheduledAgentAttachment[] = []
  for (const entry of input) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) continue
    const id = entry.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id })
  }
  return out
}
