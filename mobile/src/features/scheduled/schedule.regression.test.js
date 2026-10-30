/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// New chat's schedule is the desktop's picker. Its cron reader and its tab
// model are the desktop's own files, mirrored; these tests hold the mirrors
// to their sources and the ported pieces to what the desktop's say.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const repoRoot = path.resolve(__dirname, "../../../..");
const { cronFromEditorState, editorStateFromCron, switchTab } = require(
  path.join(buildRoot, "src/features/scheduled/scheduleEditor.js"),
);
const { DEFAULT_SCHEDULE_CRON, nextFreeTime, readPickedSchedule, readSchedule } = require(
  path.join(buildRoot, "src/features/scheduled/schedulePick.js"),
);
const {
  defaultSendAt,
  onOrBeforeToday,
  quickSendTimes,
  sendDayWords,
  sendTimeFromNow,
  sendTimeWords,
  withDayOffset,
} = require(path.join(buildRoot, "src/features/scheduled/sendTime.js"));

const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

test("the cron reader is the desktop's, byte for byte", () => {
  assert.equal(read("mobile/src/shared/cron/cron.ts"), read("src/shared/cron.ts"));
});

test("the picker's tab model is the desktop's, but for where it finds the cron reader", () => {
  const desktop = read("src/renderer/src/components/workspace/agentComposer/schedule/scheduleEditor.ts");
  const phone = read("mobile/src/features/scheduled/scheduleEditor.ts");
  assert.equal(phone, desktop.replace("'../../../../../../shared/cron'", "'../../shared/cron/cron'"));
});

test("the tabs write the everyday repeats, and read them back", () => {
  const weekdays = editorStateFromCron(DEFAULT_SCHEDULE_CRON);
  assert.equal(weekdays.tab, "weekly");
  assert.deepEqual(weekdays.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(cronFromEditorState({ ...weekdays, times: [9 * 60, 13 * 60 + 30] }), "0 9 * * 1,2,3,4,5; 30 13 * * 1,2,3,4,5");
  assert.equal(cronFromEditorState(switchTab(weekdays, "daily")), "0 9 * * *");
  assert.equal(switchTab(weekdays, "cron").cronText, "0 9 * * 1,2,3,4,5");
  assert.equal(nextFreeTime([9 * 60]), 10 * 60);
  assert.equal(nextFreeTime([23 * 60, 0]), 60);
});

test("a schedule reads as words and its next runs, or says what is wrong", () => {
  const now = new Date(2026, 9, 30, 10, 0).getTime();
  const daily = readSchedule("0 9 * * *", "UTC", now);
  assert.equal(daily.ok, true);
  assert.equal(daily.next.length, 3);
  const bad = readSchedule("0 25 * * *", "UTC", now);
  assert.equal(bad.ok, false);
  assert.equal(bad.field, "hour");
  const later = new Date(2026, 9, 30, 15, 0).getTime();
  assert.deepEqual(readPickedSchedule({ cron: DEFAULT_SCHEDULE_CRON, once: later }, "UTC", now), {
    ok: true,
    words: "Once, Today 3:00 PM",
    next: ["Today 3:00 PM"],
  });
  assert.equal(readPickedSchedule({ cron: DEFAULT_SCHEDULE_CRON, once: now - 1 }, "UTC", now).ok, false);
});

test("Once opens on the desktop's default and offers its quick times", () => {
  const now = new Date(2026, 9, 30, 10, 47).getTime();
  assert.equal(defaultSendAt(now), new Date(2026, 9, 30, 12, 0).getTime(), "the next whole hour at least half an hour off");
  assert.equal(defaultSendAt(new Date(2026, 9, 30, 10, 10).getTime()), new Date(2026, 9, 30, 11, 0).getTime());
  assert.deepEqual(
    quickSendTimes(now).map((choice) => choice.label),
    ["In 1 hour", "In 3 hours", "In 5 hours", "Tomorrow 9 AM"],
  );
  assert.equal(quickSendTimes(now)[0].at, new Date(2026, 9, 30, 11, 50).getTime());
  assert.equal(quickSendTimes(now)[3].at, new Date(2026, 9, 31, 9, 0).getTime());
});

test("the day steps, never back past today, and is said as the desktop says it", () => {
  const now = new Date(2026, 9, 30, 10, 0).getTime();
  const noon = new Date(2026, 9, 30, 12, 0).getTime();
  assert.equal(onOrBeforeToday(noon, now), true);
  const tomorrow = withDayOffset(noon, 1);
  assert.equal(onOrBeforeToday(tomorrow, now), false);
  assert.equal(sendDayWords(tomorrow, now), "Tomorrow");
  assert.equal(sendTimeWords(noon, now), "Today 12:00 PM");
  assert.equal(sendTimeWords(withDayOffset(noon, 3), now), "Mon 2 Nov, 12:00 PM");
  assert.equal(sendTimeFromNow(noon, now), "in 2h");
  assert.equal(sendTimeFromNow(now - 1, now), null);
});
