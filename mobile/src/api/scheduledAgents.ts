import type { ApiResult } from "./types";
import { createGatewayToolCaller } from "./tailnetWorkspaces";

// A desktop's scheduled agents, from the phone: the gateway's `schedule.*`
// tools over the same stateless JSON-RPC POST `workspace.list` rides. A
// scheduled agent is a prompt and a schedule; each time it comes round the
// desktop starts a chat with that prompt, whether or not this phone is awake,
// and the chat is one more in the list. Listing needs `workspace:read`; Run
// now, Pause, Resume, Close and making one need `workspace:operate`.
//
// The phone makes a repeating schedule with the arguments `schedule.create`
// always took, so that needs nothing the desktop advertises beyond the tools.
// A one-time schedule (`once`) is offered only where the desktop advertises
// `scheduled-agents`: an older handler refuses an argument it does not
// declare, rather than making a different schedule.
//
// What is sent and what an answer means are pure and exported, so the
// regression suite reads the same rules the screens run.

const LIST_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;
/** A run waits on the chat starting on the desktop, a CLI and all. */
const RUN_TIMEOUT_MS = 60_000;

export type ScheduledAgentAction = "run" | "pause" | "resume" | "delete";

export interface PhoneScheduledAgent {
  id: string;
  /** Its name, else its prompt's first line, as the desktop's sidebar titles it. */
  title: string;
  prompt: string;
  /** The schedule in the desktop's words ("Every weekday at 9:00 AM"); the cron where it had none. */
  scheduleWords: string;
  /** The project each run starts in: the last segment of its folder. */
  projectName: string;
  cli: string;
  paused: boolean;
  /** When it runs next, epoch ms; null while paused, or when it never will again. */
  nextRunAt: number | null;
  /** Why its last run did not start, while the desktop has not been told it was seen; null otherwise. */
  lastFailure: string | null;
}

export interface PhoneScheduledAgents {
  agents: PhoneScheduledAgent[];
  /** Every scheduled agent on the desktop is paused, and until when (null: until resumed). */
  pausedAll: { until: number | null } | null;
}

/**
 * The cron naming the same minute as a one-time instant, in this phone's
 * zone, as the desktop's own `cronForInstant` writes it: `schedule.create`
 * still requires a cron, and whatever reads the cron alone reads a true one.
 */
export function cronForInstant(at: Date): string {
  return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
}

export interface ScheduleDraft {
  workspaceId: string;
  prompt: string;
  cron: string;
  timezone: string;
  /** The agent CLI; null leaves it to the desktop's last-picked one, as New chat's Desktop default does. */
  cli?: string | null;
  model?: string | null;
  /** Run once at this instant (epoch ms) rather than repeating; offered only where `scheduled-agents` is advertised. */
  once?: number | null;
  /** Each run in a fresh worktree of its own, as New chat's Worktree switch. */
  worktree?: boolean;
  /** The access New chat picked; absent, each run takes its CLI's at run time. */
  permissionPreset?: string | null;
}

/** Whether this phone's grant may run, pause, resume, close or make them there. */
export function canOperateSchedules(session: { tailnetScopes: string[] }): boolean {
  return session.tailnetScopes.includes("workspace:operate");
}

/** The tool each action is. */
export function scheduledAgentActionTool(action: ScheduledAgentAction): string {
  return `schedule.${action}`;
}

/**
 * `schedule.create`'s arguments: the draft trimmed, and a CLI, a model, a
 * one-time instant, a worktree and an access each only where one was picked,
 * so a repeating schedule sends nothing an older desktop does not declare.
 */
export function buildCreateScheduleArgs(draft: ScheduleDraft): Record<string, unknown> {
  return {
    workspaceId: draft.workspaceId,
    prompt: draft.prompt.trim(),
    cron: draft.once != null ? cronForInstant(new Date(draft.once)) : draft.cron,
    timezone: draft.timezone,
    ...(draft.cli ? { cli: draft.cli } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.once != null ? { once: new Date(draft.once).toISOString() } : {}),
    ...(draft.worktree ? { worktree: true } : {}),
    ...(draft.permissionPreset ? { permissionPreset: draft.permissionPreset } : {}),
  };
}

/** "in 12m", "in 5h", "Mon 09:00", "4 Oct": when it runs next, as the desktop's row says it. */
export function nextRunWords(nextRunAt: number | null, now: number): string | null {
  if (nextRunAt === null) return null;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const remaining = nextRunAt - now;
  if (remaining <= minute) return "now";
  if (remaining < hour) return `in ${Math.ceil(remaining / minute)}m`;
  if (remaining < day) return `in ${Math.round(remaining / hour)}h`;
  const at = new Date(nextRunAt);
  if (remaining < 7 * day) {
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getDay()];
    return `${weekday} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getMonth()];
  return `${at.getDate()} ${month}`;
}

/** The line under a row's title: what is true of the schedule now. */
export function scheduleStatusLine(agent: PhoneScheduledAgent, pausedAll: boolean): string {
  if (agent.lastFailure) return `Last run failed — ${agent.lastFailure}`;
  if (agent.paused) return `Paused · ${agent.scheduleWords}`;
  if (pausedAll) return `Paused with every scheduled agent · ${agent.scheduleWords}`;
  return agent.scheduleWords;
}

/** One row of `schedule.list`, or null when it lacks what a row needs. */
export function readScheduledAgent(value: unknown): PhoneScheduledAgent | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.prompt !== "string") return null;
  const schedule = isRecord(value.schedule) ? value.schedule : null;
  if (!schedule || typeof schedule.cron !== "string") return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const firstLine = value.prompt.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const folder = typeof value.folderPath === "string" ? value.folderPath : "";
  const lastRun = isRecord(value.lastRun) ? value.lastRun : null;
  const lastRunAt = instantOf(lastRun?.at);
  const seenAt = instantOf(value.lastFailureSeenAt) ?? 0;
  const lastFailure =
    lastRun && lastRun.ok === false && lastRunAt !== null && seenAt < lastRunAt
      ? typeof lastRun.message === "string" && lastRun.message
        ? lastRun.message
        : "The run did not start."
      : null;
  return {
    id: value.id,
    title: name || firstLine || "Scheduled agent",
    prompt: value.prompt,
    scheduleWords: typeof value.scheduleWords === "string" && value.scheduleWords ? value.scheduleWords : schedule.cron,
    projectName: folder.split(/[\\/]/u).filter(Boolean).pop() ?? folder,
    cli: typeof value.cli === "string" ? value.cli : "",
    paused: value.paused === true || instantOf(value.pausedAt) !== null,
    nextRunAt: instantOf(value.nextRunAt),
    lastFailure,
  };
}

/** `schedule.list`'s answer, kept to the rows this build can read. */
export function readScheduledAgents(data: unknown): PhoneScheduledAgents {
  const rows = isRecord(data) && Array.isArray(data.scheduledAgents) ? data.scheduledAgents : [];
  const pause = isRecord(data) && isRecord(data.pausedAll) ? data.pausedAll : null;
  return {
    agents: rows.flatMap((row) => readScheduledAgent(row) ?? []),
    pausedAll: pause ? { until: instantOf(pause.until) } : null,
  };
}

/** What the schedule screens need from the tools; a harness may supply a fake of the same shape. */
export interface ScheduledAgentsApi {
  list(): Promise<ApiResult<PhoneScheduledAgents>>;
  act(id: string, action: ScheduledAgentAction): Promise<ApiResult<{ id: string; action: ScheduledAgentAction }>>;
  create(draft: ScheduleDraft): Promise<ApiResult<PhoneScheduledAgent>>;
}

export function createScheduledAgentsApi(options: { baseUrl: string; deviceToken: string }): ScheduledAgentsApi {
  const callTool = createGatewayToolCaller(options);
  return {
    async list() {
      const result = await callTool("schedule.list", {}, LIST_TIMEOUT_MS);
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      return { ok: true as const, data: readScheduledAgents(result.data) };
    },
    async act(id, action) {
      const result = await callTool(
        scheduledAgentActionTool(action),
        { id },
        action === "run" ? RUN_TIMEOUT_MS : WRITE_TIMEOUT_MS,
      );
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      return { ok: true as const, data: { id, action } };
    },
    async create(draft) {
      const result = await callTool("schedule.create", buildCreateScheduleArgs(draft), WRITE_TIMEOUT_MS);
      if (!result.ok) return { ok: false as const, errorCode: result.errorCode, message: result.message };
      const agent = readScheduledAgent(isRecord(result.data) ? result.data.scheduledAgent : null);
      return agent
        ? { ok: true as const, data: agent }
        : { ok: false as const, errorCode: "invalid_payload" as const, message: "The desktop did not confirm the schedule." };
    },
  };
}

function instantOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
