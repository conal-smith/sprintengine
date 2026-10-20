const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readEach } = require("../../.mobile-test-build/src/navigation/readEach.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const after = async (turns) => {
  for (let i = 0; i < turns; i++) await tick();
};

test("every desktop is asked at once, and an answer waits only for its own desktop", async () => {
  let turn = 0;
  let stop = false;
  void (async () => {
    while (!stop) {
      await tick();
      turn++;
    }
  })();
  const handled = {};
  // The first desktop is off and answers only at the read timeout.
  const latency = { off: 300, one: 10, two: 10 };
  await readEach(
    ["off", "one", "two"],
    async (desktop) => {
      await after(latency[desktop]);
      return desktop;
    },
    async (desktop) => {
      handled[desktop] = turn;
    },
  );
  stop = true;
  // One after another, "one" was handled after 310 turns and "two" after 320.
  assert.ok(handled.one < 20, `one handled at turn ${handled.one}`);
  assert.ok(handled.two < 20, `two handled at turn ${handled.two}`);
  assert.ok(handled.off >= 300);
});

test("answers are handled one at a time, so no write starts from a list another is changing", async () => {
  let running = 0;
  let most = 0;
  const order = [];
  await readEach(
    [3, 1, 2],
    async (item) => {
      await after(item);
      return item;
    },
    async (item) => {
      running++;
      most = Math.max(most, running);
      await after(5);
      order.push(item);
      running--;
    },
  );
  assert.equal(most, 1);
  assert.deepEqual(order, [1, 2, 3], "in the order the answers came");
});

test("a handler that fails does not stop the others", async () => {
  const handled = [];
  await assert.rejects(
    readEach(
      ["a", "b"],
      async (item) => item,
      async (item) => {
        if (item === "a") throw new Error("write failed");
        handled.push(item);
      },
    ),
    /write failed/,
  );
  await after(5);
  assert.deepEqual(handled, ["b"]);
});
