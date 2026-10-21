const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  questionAnswer,
  questionAnswers,
  questionStep,
} = require("../../../.mobile-test-build/src/features/conversations/questionStepLogic.js");

test("a part's answer is its picks in order, then the typed words, trimmed", () => {
  assert.equal(questionAnswer(["Red", "Blue"], "  teal  "), "Red, Blue, teal");
  assert.equal(questionAnswer(["Red"], "   "), "Red");
  assert.equal(questionAnswer(undefined, "only words"), "only words");
  assert.equal(questionAnswer(undefined, undefined), "");
});

test("every part's answer goes back keyed by its whole question text", () => {
  assert.deepEqual(
    questionAnswers(
      ["Which colour?", "Which size?", "Anything else?"],
      { "Which colour?": ["Red"], "Which size?": ["S", "M"] },
      { "Anything else?": "no" },
    ),
    { "Which colour?": "Red", "Which size?": "S, M", "Anything else?": "no" },
  );
});

test("a lone question is asked as before: no count, no Back, just Submit once answered", () => {
  assert.deepEqual(questionStep({ step: 0, answers: [""] }), {
    index: 0,
    meta: null,
    back: false,
    primary: "submit",
    label: "Submit answers",
    primaryEnabled: false,
  });
  assert.equal(questionStep({ step: 0, answers: ["Red"] }).primaryEnabled, true);
  assert.equal(questionStep({ step: 0, answers: ["Red"], header: "Colour" }).meta, null);
});

test("several parts are asked one at a time, with Next until the last", () => {
  const first = questionStep({ step: 0, answers: ["", "", ""] });
  assert.equal(first.meta, "1 of 3");
  assert.equal(first.back, false);
  assert.equal(first.primary, "next");
  assert.equal(first.label, "Next");
  assert.equal(first.primaryEnabled, false, "Next waits for this part's answer");
  assert.equal(questionStep({ step: 0, answers: ["Red", "", ""] }).primaryEnabled, true, "later parts need not be answered yet");

  const middle = questionStep({ step: 1, answers: ["Red", "", ""], header: "Size" });
  assert.equal(middle.meta, "Size · 2 of 3", "the part's header leads the count, as on the desktop");
  assert.equal(middle.back, true);
  assert.equal(middle.primaryEnabled, false);
});

test("the last part submits, and only once every part has an answer", () => {
  const last = questionStep({ step: 2, answers: ["Red", "S", "no"] });
  assert.equal(last.meta, "3 of 3");
  assert.equal(last.back, true);
  assert.equal(last.primary, "submit");
  assert.equal(last.label, "Submit answers");
  assert.equal(last.primaryEnabled, true);
  assert.equal(questionStep({ step: 2, answers: ["Red", "  ", "no"] }).primaryEnabled, false, "an earlier part emptied on Back blocks the submit");
  assert.equal(questionStep({ step: 2, answers: ["Red", "S", ""] }).primaryEnabled, false);
});

test("a step outside the parts is held inside them, and no parts submit nothing", () => {
  assert.equal(questionStep({ step: 7, answers: ["a", "b"] }).index, 1);
  assert.equal(questionStep({ step: -1, answers: ["a", "b"] }).index, 0);
  assert.equal(questionStep({ step: Number.NaN, answers: ["a", "b"] }).index, 0);
  const none = questionStep({ step: 0, answers: [] });
  assert.equal(none.primary, "submit");
  assert.equal(none.primaryEnabled, false);
  assert.equal(none.meta, null);
});
