const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  followUpAction,
  followUpSendLabel,
  readFollowUpBehavior,
  steerOffered,
} = require("../../../.mobile-test-build/src/features/conversations/followUp.js");

const offered = { declared: true, chatSteers: true, turnBusy: true, uploads: 0 };

test("only a stored steer reads as Steer; anything else is Queue, what the phone always did", () => {
  assert.equal(readFollowUpBehavior("steer"), "steer");
  for (const value of ["queue", null, undefined, "", "STEER", "true"]) assert.equal(readFollowUpBehavior(value), "queue");
});

test("Steer is offered only to a desktop and chat that take one, mid-turn, with no pictures", () => {
  assert.equal(steerOffered(offered), true);
  assert.equal(steerOffered({ ...offered, declared: false }), false, "an older desktop drops steer and refuses the send as busy");
  assert.equal(steerOffered({ ...offered, chatSteers: false }), false, "the chat's CLI cannot take one");
  assert.equal(steerOffered({ ...offered, chatSteers: undefined }), false, "unknown offers nothing");
  assert.equal(steerOffered({ ...offered, turnBusy: false }), false, "with no turn running a send starts one");
  assert.equal(steerOffered({ ...offered, uploads: 1 }), false, "a held message is its words alone, so pictures never steer");
});

test("with no turn running the send is a plain send, whatever the setting or press", () => {
  for (const behavior of ["queue", "steer"])
    for (const alternate of [false, true])
      assert.equal(followUpAction({ turnBusy: false, steerable: false, behavior, alternate }), "send");
});

test("mid-turn the send does the default and a long press the other", () => {
  assert.equal(followUpAction({ turnBusy: true, steerable: true, behavior: "queue", alternate: false }), "queue");
  assert.equal(followUpAction({ turnBusy: true, steerable: true, behavior: "queue", alternate: true }), "steer");
  assert.equal(followUpAction({ turnBusy: true, steerable: true, behavior: "steer", alternate: false }), "steer");
  assert.equal(followUpAction({ turnBusy: true, steerable: true, behavior: "steer", alternate: true }), "queue");
});

test("where Steer is not on offer everything queues, the long press and a Steer default too", () => {
  for (const behavior of ["queue", "steer"])
    for (const alternate of [false, true])
      assert.equal(followUpAction({ turnBusy: true, steerable: false, behavior, alternate }), "queue");
});

test("the send names what it does, and the long press only where there is another action", () => {
  assert.deepEqual(followUpSendLabel({ action: "send", steerable: false, behavior: "queue" }), { label: "Send" });
  assert.deepEqual(followUpSendLabel({ action: "queue", steerable: false, behavior: "steer" }), { label: "Queue", hint: "Sends when this turn ends." });
  const queue = followUpSendLabel({ action: "queue", steerable: true, behavior: "queue" });
  assert.equal(queue.label, "Queue");
  assert.match(queue.hint, /Long-press to steer/);
  const steer = followUpSendLabel({ action: "steer", steerable: true, behavior: "steer" });
  assert.equal(steer.label, "Steer");
  assert.match(steer.hint, /Long-press to queue/);
});
