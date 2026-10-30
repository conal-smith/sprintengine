/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A desktop's scheduled agents from the phone: listed on `schedule.list`,
// driven on the tool of each action's name, and made on `schedule.create`:
// a repeating one with only the arguments it always took, a one-time one
// with `once` where the desktop advertises `scheduled-agents`.

const buildRoot = path.resolve(__dirname, "../../.mobile-test-build");
const {
  buildCreateScheduleArgs,
  canOperateSchedules,
  cronForInstant,
  nextRunWords,
  readScheduledAgents,
  scheduleStatusLine,
  scheduledAgentActionTool,
} = require(path.join(buildRoot, "src/api/scheduledAgents.js"));

const listed = {
  id: "sa-1",
  prompt: "Triage new issues\nand label them",
  schedule: { cron: "0 9 * * 1-5", timezone: "Europe/London" },
  folderPath: "/Users/dev/app",
  cli: "claude-code",
  scheduleWords: "Every weekday at 9:00 AM",
  paused: false,
  pausedAt: null,
  nextRunAt: "2026-10-30T09:00:00.000Z",
  lastRun: { at: 3000, ok: false, message: "The CLI is not installed." },
  lastFailureSeenAt: null,
};

test("a listed schedule reads as the desktop's row does", () => {
  const read = readScheduledAgents({ scheduledAgents: [listed, { id: "broken" }], pausedAll: null });
  assert.equal(read.agents.length, 1, "a row without a prompt and a cron is left out");
  const [agent] = read.agents;
  assert.equal(agent.title, "Triage new issues", "untitled, its prompt's first line names it");
  assert.equal(agent.projectName, "app");
  assert.equal(agent.nextRunAt, Date.parse("2026-10-30T09:00:00.000Z"));
  assert.equal(agent.lastFailure, "The CLI is not installed.");
  assert.equal(scheduleStatusLine(agent, false), "Last run failed — The CLI is not installed.");
  assert.equal(read.pausedAll, null);
});

test("a failure the desktop has seen, and a pause, read as the schedule", () => {
  const read = readScheduledAgents({
    scheduledAgents: [{ ...listed, name: "Morning triage", paused: true, lastFailureSeenAt: 4000 }],
    pausedAll: { since: "2026-10-29T08:00:00.000Z", until: null },
  });
  const [agent] = read.agents;
  assert.equal(agent.title, "Morning triage");
  assert.equal(agent.lastFailure, null);
  assert.equal(scheduleStatusLine(agent, false), "Paused · Every weekday at 9:00 AM");
  assert.deepEqual(read.pausedAll, { until: null });
});

test("each action is the desktop's own schedule tool", () => {
  assert.deepEqual(
    ["run", "pause", "resume", "delete"].map(scheduledAgentActionTool),
    ["schedule.run", "schedule.pause", "schedule.resume", "schedule.delete"],
  );
});

test("a new schedule sends what schedule.create always took, and no model it was not given", () => {
  assert.deepEqual(
    buildCreateScheduleArgs({
      workspaceId: "ws-1",
      prompt: "  Check the deploy  ",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      cli: "claude-code",
      model: null,
    }),
    { workspaceId: "ws-1", prompt: "Check the deploy", cron: "0 9 * * 1-5", timezone: "UTC", cli: "claude-code" },
  );
  // New chat's Desktop default: the desktop's last-picked CLI, so none is sent.
  assert.equal("cli" in buildCreateScheduleArgs({ workspaceId: "ws-1", prompt: "x", cron: "0 9 * * *", timezone: "UTC", cli: null }), false);
});

test("only a grant that may operate the desktop drives its schedules", () => {
  assert.equal(canOperateSchedules({ tailnetScopes: ["workspace:read"] }), false);
  assert.equal(canOperateSchedules({ tailnetScopes: ["workspace:read", "workspace:operate"] }), true);
});

test("when it runs next is a time to come", () => {
  const now = Date.parse("2026-10-29T08:00:00.000Z");
  assert.equal(nextRunWords(null, now), null);
  assert.equal(nextRunWords(now + 30_000, now), "now");
  assert.equal(nextRunWords(now + 12 * 60_000, now), "in 12m");
  assert.equal(nextRunWords(now + 5 * 3_600_000, now), "in 5h");
});

test("a one-time schedule sends its instant, and a cron naming the same minute", () => {
  const once = new Date(2026, 9, 30, 15, 5);
  const args = buildCreateScheduleArgs({
    workspaceId: "ws-1",
    prompt: "Ping me about the release",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
    cli: "claude-code",
    once: once.getTime(),
  });
  assert.equal(args.once, once.toISOString());
  assert.equal(args.cron, "5 15 30 10 *");
  assert.equal(cronForInstant(new Date(2026, 0, 2, 0, 0)), "0 0 2 1 *");
});

test("New chat's worktree and access go with a schedule only where they were picked", () => {
  const base = { workspaceId: "ws-1", prompt: "Tidy", cron: "0 9 * * *", timezone: "UTC", cli: "codex" };
  assert.deepEqual(Object.keys(buildCreateScheduleArgs({ ...base, worktree: false, permissionPreset: null, once: null })), [
    "workspaceId",
    "prompt",
    "cron",
    "timezone",
    "cli",
  ]);
  const picked = buildCreateScheduleArgs({ ...base, model: "gpt-5", worktree: true, permissionPreset: "auto" });
  assert.equal(picked.model, "gpt-5");
  assert.equal(picked.worktree, true);
  assert.equal(picked.permissionPreset, "auto");
});
