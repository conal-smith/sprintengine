// A single moment to run at, as the one-time picker writes it: the Once tab of
// a scheduled agent. Ported from the desktop's `schedule/sendTime.ts`, so
// Once offers the same quick times and opens on the same default; read and
// written in this phone's own zone, which is the zone the schedule is sent in.
//
// Two things differ, both because a phone has no date field: the day is
// stepped (`withDayOffset`) rather than typed, and the words are built from
// fixed English names rather than the locale's, as `formatRunTimes` builds
// them, so every engine draws them alike.

import { formatScheduleTime } from "./scheduleEditor";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A minute-precise instant: a run time carries no seconds. */
function toMinute(at: number): number {
  const date = new Date(at);
  date.setSeconds(0, 0);
  return date.getTime();
}

/** Up to the next five minutes past the hour: "In 1 hour" at 14:22 reads 15:25, not 15:22. */
function upToFiveMinutes(at: number): number {
  const date = new Date(toMinute(at));
  const minutes = date.getMinutes();
  const nextFive = Math.ceil(minutes / 5) * 5;
  if (nextFive !== minutes) date.setMinutes(nextFive);
  return date.getTime();
}

/** The time the picker opens on: the next whole hour at least half an hour away. */
export function defaultSendAt(now: number): number {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  if (date.getTime() - now < 30 * MINUTE_MS) date.setHours(date.getHours() + 1);
  return date.getTime();
}

export interface SendTimeChoice {
  label: string;
  at: number;
}

/** The times most runs want, one press each, as the desktop's Once offers them. */
export function quickSendTimes(now: number): SendTimeChoice[] {
  const tomorrowMorning = new Date(now + DAY_MS);
  tomorrowMorning.setHours(9, 0, 0, 0);
  return [
    { label: "In 1 hour", at: upToFiveMinutes(now + HOUR_MS) },
    { label: "In 3 hours", at: upToFiveMinutes(now + 3 * HOUR_MS) },
    { label: "In 5 hours", at: upToFiveMinutes(now + 5 * HOUR_MS) },
    { label: "Tomorrow 9 AM", at: tomorrowMorning.getTime() },
  ];
}

/** `at` moved by whole days, at the same time of day. */
export function withDayOffset(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return toMinute(date.getTime());
}

/** Whether `at` falls on the same calendar day as `now`, or before it: no stepping back past today. */
export function onOrBeforeToday(at: number, now: number): boolean {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return day.getTime() <= today.getTime();
}

/** Minutes past midnight, as the time field holds them. */
export function minutesOfDay(at: number): number {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

/** `at` moved to another time of day, on the same day. */
export function withMinutesOfDay(at: number, minutes: number): number {
  const date = new Date(at);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

/** "Today", "Tomorrow", "Wed 14 Oct": the day alone, for the day stepper. */
export function sendDayWords(at: number, now: number): string {
  const date = new Date(at);
  const day = date.toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now + DAY_MS).toDateString()) return "Tomorrow";
  return `${WEEKDAY_SHORT[date.getDay()]} ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
}

/** "Today 3:00 PM", "Tomorrow 9:00 AM", "Wed 14 Oct, 9:00 AM". */
export function sendTimeWords(at: number, now: number): string {
  const { clock, meridiem } = formatScheduleTime(minutesOfDay(at));
  const day = sendDayWords(at, now);
  return day === "Today" || day === "Tomorrow" ? `${day} ${clock} ${meridiem}` : `${day}, ${clock} ${meridiem}`;
}

/** How far off it is, for the readout: "in 2h 13m"; null once it has passed. */
export function sendTimeFromNow(at: number, now: number): string | null {
  if (at <= now) return null;
  const ms = at - now;
  if (ms < MINUTE_MS) return "in under a minute";
  const minutes = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours > 0) return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  return `in ${mins}m`;
}
