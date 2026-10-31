// Snooze on the phone, as rules: the wake times on offer, which chats are
// asleep, the countdown a sleeping row wears, and how a snooze this phone has
// asked for is drawn before the desktop's list says the same.
//
// Ported from the desktop's `utils/workspaceSnooze.ts`, so a chat snoozed
// here offers the same choices and lands on the same instant as one snoozed
// from its row menu there. The desktop owns the snooze (`conversation.snooze`,
// on a desktop that advertises `chat-row-menu`); this phone only asks for one
// and reads the `snoozedUntil` the list carries back. Kept free of React
// Native so the regression suite runs the same rules the list does.

import { formatScheduleTime } from "../scheduled/scheduleEditor";
import { minutesOfDay, sendTimeWords } from "../scheduled/sendTime";
import type { ConversationThread } from "../../api/conversationWire";
import { chatWorkspaceKey, type ChatListRow } from "./conversationListLogic";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Wake hour for "This evening". */
const EVENING_HOUR = 18;
/** Wake hour for the calendar presets ("Tomorrow", "Next week"). */
const MORNING_HOUR = 9;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  id: SnoozePresetId;
  /** The choice, as the person makes it: "In 1 hour", "Tomorrow". */
  label: string;
  /** When it lands, beside the label rather than repeating it: "Tomorrow" pairs with "9:00 AM". */
  whenLabel: string;
  wakeAt: number;
}

function timeOfDay(at: number): string {
  const { clock, meridiem } = formatScheduleTime(minutesOfDay(at));
  return `${clock} ${meridiem}`;
}

function atHour(base: number, hour: number): number {
  const date = new Date(base);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

// Calendar days, not `+ n * DAY_MS`: a fixed offset lands on the wrong local
// day across a daylight-saving change.
function addDays(base: number, days: number): number {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * The wake times on offer at `now`, as the desktop's row menu offers them.
 * "This evening" only while evening is more than an hour off, and "Next week"
 * only when it is not the same instant as "Tomorrow" (every Sunday).
 */
export function resolveSnoozePresets(now: number): SnoozePreset[] {
  const presets: SnoozePreset[] = [
    { id: "hour", label: "In 1 hour", whenLabel: timeOfDay(now + HOUR_MS), wakeAt: now + HOUR_MS },
    { id: "three-hours", label: "In 3 hours", whenLabel: timeOfDay(now + 3 * HOUR_MS), wakeAt: now + 3 * HOUR_MS },
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening - now > HOUR_MS)
    presets.push({ id: "evening", label: "This evening", whenLabel: timeOfDay(evening), wakeAt: evening });
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({ id: "tomorrow", label: "Tomorrow", whenLabel: timeOfDay(tomorrow), wakeAt: tomorrow });
  // The coming Monday; on a Monday, the one after.
  const daysUntilMonday = (1 - new Date(now).getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek !== tomorrow)
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${WEEKDAY_SHORT[new Date(nextWeek).getDay()]} ${timeOfDay(nextWeek)}`,
      wakeAt: nextWeek,
    });
  return presets;
}

/** Asleep right now: the wake time is still ahead. The clock is the whole test, as on the desktop. */
export function isChatSnoozed(thread: Pick<ConversationThread, "snoozedUntil">, now: number): boolean {
  return typeof thread.snoozedUntil === "number" && thread.snoozedUntil > now;
}

/**
 * The countdown a sleeping row wears: "42m", "2h", "3d". Minutes round up, so
 * a row still asleep never reads "0m".
 */
export function snoozeWakeLabel(wakeAt: number, now: number): string {
  const remaining = wakeAt - now;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

/** When a snooze ends, for a sentence: "today at 3:00 PM", "tomorrow at 9:00 AM", "Mon 2 Nov, 9:00 AM". */
export function snoozeWakeWords(wakeAt: number, now: number): string {
  return sendTimeWords(wakeAt, now).replace(/^(Today|Tomorrow) /, (_match, day: string) => `${day.toLowerCase()} at `);
}

/**
 * Whether Snooze is offered on a chat now. Not while an agent in it works: the
 * desktop ends a snoozed chat's processes, so it refuses one then, and a
 * choice that is always refused is not one to offer.
 */
export function snoozeOffered(row: Pick<ChatListRow, "snoozable" | "thread">): boolean {
  if (!row.snoozable) return false;
  const { phase, backgroundWork } = row.thread;
  return phase !== "running" && phase !== "starting" && !backgroundWork;
}

/**
 * The listed chats split as the desktop's sidebar splits them: the awake ones,
 * in the order given, and the sleeping ones, soonest to wake first, which the
 * list puts on a Snoozed shelf of their own.
 */
export function splitSnoozed<T extends Pick<ChatListRow, "thread">>(
  rows: readonly T[],
  now: number,
): { awake: T[]; asleep: T[] } {
  const awake: T[] = [];
  const asleep: T[] = [];
  for (const row of rows) (isChatSnoozed(row.thread, now) ? asleep : awake).push(row);
  asleep.sort((a, b) => (a.thread.snoozedUntil ?? 0) - (b.thread.snoozedUntil ?? 0));
  return { awake, asleep };
}

/**
 * Snoozes and wakes this phone has asked for, by `chatWorkspaceKey`, until a
 * list read says the same. `until` is what the chat is drawn with meanwhile
 * (null: awake). `confirmedAt` is when the desktop answered; a read that set
 * out after then lists the chat as it is, and ends the entry.
 */
export type PendingSnooze = { until: number | null; confirmedAt: number | null };
export type PendingSnoozes = Readonly<Record<string, PendingSnooze>>;

export function beginSnooze(pending: PendingSnoozes, key: string, until: number | null): PendingSnoozes {
  return { ...pending, [key]: { until, confirmedAt: null } };
}

export function confirmSnooze(pending: PendingSnoozes, key: string, until: number | null, at: number): PendingSnoozes {
  if (!pending[key]) return pending;
  return { ...pending, [key]: { until, confirmedAt: at } };
}

export function failSnooze(pending: PendingSnoozes, key: string): PendingSnoozes {
  if (!pending[key]) return pending;
  const { [key]: _failed, ...rest } = pending;
  return rest;
}

/** The pending snoozes once a list read that set out at `readStartedAt` has landed. */
export function snoozesAfterRead(pending: PendingSnoozes, readStartedAt: number): PendingSnoozes {
  let next: Record<string, PendingSnooze> | null = null;
  for (const [key, entry] of Object.entries(pending)) {
    if (entry.confirmedAt !== null && entry.confirmedAt <= readStartedAt) {
      next ??= { ...pending };
      delete next[key];
    }
  }
  return next ?? pending;
}

/** The rows as drawn: each chat with a snooze this phone asked for, until the list carries it. */
export function withPendingSnoozes<T extends Pick<ChatListRow, "deviceId" | "thread">>(
  rows: readonly T[],
  pending: PendingSnoozes,
): T[] {
  if (!Object.keys(pending).length) return [...rows];
  return rows.map((row) => {
    const entry = pending[chatWorkspaceKey(row)];
    if (!entry) return row;
    const { snoozedUntil: _listed, ...thread } = row.thread;
    return { ...row, thread: entry.until === null ? thread : { ...thread, snoozedUntil: entry.until } };
  });
}
