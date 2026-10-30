// What New chat's schedule holds and what it reads as: the desktop picker's
// model (`schedule/SchedulePicker.tsx`), ported so the tag, the readout and
// the run times under it say what the desktop's say. The cron is read by the
// desktop's own `cron.ts`, mirrored into `src/shared/cron`.

import { describeCronSchedule, nextCronRuns, parseCronSchedule } from "../../shared/cron/cron";
import { formatRunTimes, type ScheduleTime } from "./scheduleEditor";
import { sendTimeWords } from "./sendTime";

/**
 * What the picker holds: a repeating schedule's cron, or one time to run at.
 * The cron is kept while Once is picked, so going back to a repeat finds the
 * one that was there.
 */
export interface PickedSchedule {
  cron: string;
  once: number | null;
}

/** The desktop's default repeat: every weekday at 9:00 AM. */
export const DEFAULT_SCHEDULE_CRON = "0 9 * * 1-5";

const PREVIEW_RUNS = 3;

export type ScheduleReading = { ok: true; words: string; next: string[] } | { ok: false; message: string; field?: string };

/** What the schedule says and when it next runs, or why it cannot be read. */
export function readSchedule(cron: string, timezone: string, now: number): ScheduleReading {
  const parsed = parseCronSchedule(cron);
  if (!parsed.ok) return { ok: false, message: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) };
  let runs: number[] = [];
  try {
    runs = nextCronRuns(parsed.schedule, timezone, now, PREVIEW_RUNS);
  } catch {
    runs = [];
  }
  if (runs.length === 0) return { ok: false, message: "That schedule never comes round — no calendar has that day." };
  return { ok: true, words: describeCronSchedule(parsed.schedule), next: formatRunTimes(runs, timezone, now) };
}

/** What a picked schedule says and when it next runs, or why it cannot be read. */
export function readPickedSchedule(schedule: PickedSchedule, timezone: string, now: number): ScheduleReading {
  if (schedule.once === null) return readSchedule(schedule.cron, timezone, now);
  if (schedule.once <= now) return { ok: false, message: "That time has passed" };
  const when = sendTimeWords(schedule.once, now);
  return { ok: true, words: `Once, ${when}`, next: [when] };
}

/**
 * A time the list does not have yet: an hour after the last one, wrapping at
 * midnight, so "+ Time" never adds a duplicate a person then has to fix.
 */
export function nextFreeTime(times: readonly ScheduleTime[]): ScheduleTime {
  let candidate = ((times[times.length - 1] ?? 8 * 60) + 60) % (24 * 60);
  while (times.includes(candidate)) candidate = (candidate + 60) % (24 * 60);
  return candidate;
}
