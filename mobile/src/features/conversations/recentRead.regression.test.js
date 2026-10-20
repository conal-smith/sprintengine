const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRecentRead } = require("../../../.mobile-test-build/src/features/conversations/recentRead.js");

function desktop() {
  let clock = 0;
  const calls = [];
  const answers = [];
  const read = createRecentRead(
    () =>
      new Promise((resolve) => {
        calls.push(resolve);
      }),
    () => clock,
  );
  return {
    read,
    calls,
    answers,
    advance(ms) {
      clock += ms;
    },
    answer(index, value) {
      calls[index](value);
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a chat opened from the list takes the workspace list the list just read", async () => {
  const d = desktop();
  const listed = d.read.fresh();
  d.answer(0, { ok: true, data: ["w"] });
  await listed;
  d.advance(5_000);
  assert.deepEqual(await d.read.recent(), { ok: true, data: ["w"] });
  assert.equal(d.calls.length, 1, "one request for the list and the chat, where there were two");
});

test("an old answer, a failed one, or an explicit refresh asks the desktop again", async () => {
  const d = desktop();
  const first = d.read.fresh();
  d.answer(0, { ok: true, data: ["old"] });
  await first;
  d.advance(60_001);
  const stale = d.read.recent();
  assert.equal(d.calls.length, 2);
  d.answer(1, { ok: false, message: "offline" });
  assert.equal((await stale).ok, false);
  const afterFailure = d.read.recent();
  assert.equal(d.calls.length, 3, "a failed answer is not kept");
  d.answer(2, { ok: true, data: ["new"] });
  await afterFailure;
  const refreshed = d.read.fresh();
  assert.equal(d.calls.length, 4, "a refresh never takes the kept answer");
  d.answer(3, { ok: true, data: ["newer"] });
  assert.deepEqual(await refreshed, { ok: true, data: ["newer"] });
});

test("reads made while one is in flight join it", async () => {
  const d = desktop();
  const a = d.read.fresh();
  const b = d.read.fresh();
  const c = d.read.recent();
  assert.equal(d.calls.length, 1);
  d.answer(0, { ok: true, data: [] });
  assert.deepEqual(await Promise.all([a, b, c]), [{ ok: true, data: [] }, { ok: true, data: [] }, { ok: true, data: [] }]);
  await settle();
  d.read.fresh();
  assert.equal(d.calls.length, 2, "once answered, the next refresh is its own request");
});
