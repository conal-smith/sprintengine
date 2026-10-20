const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  cancelRefusal,
  heldByDesktop,
  holdsOnDesktop,
  queuedBubbles,
  queuedLine,
  stillHanding,
} = require("../../../.mobile-test-build/src/features/conversations/queuedSends.js");

const base = { declared: true, turnBusy: true, uploads: 0, phoneQueued: 0 };

test("a message goes to the desktop to hold only behind a running turn, without pictures, and behind nothing the phone holds", () => {
  assert.equal(holdsOnDesktop(base), true);
  assert.equal(holdsOnDesktop({ ...base, declared: false }), false, "an older desktop: the phone holds it, as before");
  assert.equal(holdsOnDesktop({ ...base, turnBusy: false }), false, "no turn running: it goes straight into the chat");
  assert.equal(holdsOnDesktop({ ...base, uploads: 1 }), false, "pictures stay with their words, on the phone");
  assert.equal(holdsOnDesktop({ ...base, phoneQueued: 1 }), false, "it would overtake the message the phone holds");
});

test("the desktop's list has taken a message when one entry carries its words as whole lines", () => {
  const held = [{ id: "q1", text: "check the gateway\ndraft the phone side", createdAt: 1 }];
  assert.equal(heldByDesktop(held, "draft the phone side"), true);
  assert.equal(heldByDesktop(held, " check the gateway \n"), true);
  assert.equal(heldByDesktop(held, "draft the phone"), false);
  assert.equal(heldByDesktop([], "anything"), false);
});

test("what is still handing over drops what the list names and keeps its identity when nothing moved", () => {
  const handing = [{ commandId: "a", text: "first" }, { commandId: "b", text: "second" }];
  assert.equal(stillHanding(handing, []), handing, "unchanged, so nothing draws again");
  assert.deepEqual(stillHanding(handing, [{ id: "q", text: "first", createdAt: 1 }]), [{ commandId: "b", text: "second" }]);
});

test("the queued bubble lists the desktop's messages, then those on their way, then the phone's", () => {
  const bubbles = queuedBubbles({
    desktop: [{ id: "q1", text: "one\ntwo", createdAt: 1 }, { id: "q2", text: "refused", createdAt: 2, failure: "The chat is stopped." }],
    handing: [{ commandId: "h1", text: "three" }],
    phone: [{ commandId: "p1", text: "", uploads: ["img"] }],
  });
  assert.deepEqual(bubbles.map((bubble) => [bubble.where, bubble.key]), [
    ["desktop", "desktop:q1"], ["desktop", "desktop:q2"], ["handing", "handing:h1"], ["phone", "phone:p1"],
  ]);
  assert.equal(bubbles[0].text, "one\ntwo", "a turn's messages read as one entry, a line apiece");
  assert.equal(bubbles[1].failure, "The chat is stopped.");
  assert.deepEqual(bubbles[3].uploads, ["img"]);
});

test("each entry says where it waits, and a refused one says why", () => {
  const [desktop, refused, handing, phone] = queuedBubbles({
    desktop: [{ id: "q1", text: "a", createdAt: 1 }, { id: "q2", text: "b", createdAt: 2, failure: "The chat is stopped." }],
    handing: [{ commandId: "h", text: "c" }],
    phone: [{ commandId: "p", text: "d", uploads: [] }],
  });
  assert.equal(queuedLine(desktop, false), "Queued on the desktop · sends when this turn ends", "the desktop sends it with the phone away");
  assert.equal(queuedLine(refused, true), "Not sent: The chat is stopped.");
  assert.equal(queuedLine(handing, true), "Queuing on the desktop…");
  assert.equal(queuedLine(handing, false), "Queued · goes to the desktop when connected");
  assert.equal(queuedLine(phone, true), "Queued · sends when this turn ends");
  assert.equal(queuedLine(phone, false), "Queued · sends when connected");
});

test("a refused take-back says the desktop's words, or that the message is already on its way", () => {
  assert.equal(cancelRefusal("That message is already on its way into the chat."), "That message is already on its way into the chat.");
  assert.match(cancelRefusal(undefined), /already on its way/);
  assert.match(cancelRefusal("  "), /already on its way/);
});
