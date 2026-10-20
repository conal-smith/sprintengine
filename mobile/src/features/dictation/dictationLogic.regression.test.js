const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  DICTATION_LIMIT_MS,
  SEND_FINISH_MS,
  dictationErrorMessage,
  dictationErrorTone,
  dictationSourceLabel,
  dictatedDraft,
  dictationPlaceholder,
  dictationTail,
  freshTranscript,
  isDictationSilence,
  joinDictation,
  messageWithDictation,
  runWithSettled,
  settledTranscript,
  shouldKeepDictating,
  tailHeard,
  tailShown,
  tailWords,
} = require("../../../.mobile-test-build/src/features/dictation/dictationLogic.js");

test("dictation starts an empty draft as a sentence", () => {
  assert.equal(joinDictation("", "check the gateway tests"), "Check the gateway tests");
  assert.equal(joinDictation("   ", "check it"), "Check it");
});

test("dictation carries on the sentence in progress, with a space", () => {
  assert.equal(joinDictation("Run the tests", "and then the lint"), "Run the tests and then the lint");
  assert.equal(joinDictation("Run the tests ", "and the lint"), "Run the tests and the lint");
});

test("dictation after a finished sentence starts a new one", () => {
  assert.equal(joinDictation("Run the tests.", "then commit"), "Run the tests. Then commit");
  assert.equal(joinDictation("Two things:\n", "first the header"), "Two things:\nFirst the header");
});

test("nothing heard leaves the draft as it was", () => {
  assert.equal(joinDictation("Keep this", "   "), "Keep this");
});

test("the composer says where the audio went", () => {
  assert.equal(dictationSourceLabel(true, "android"), "on this phone");
  assert.equal(dictationSourceLabel(false, "android"), "by Google");
  assert.equal(dictationSourceLabel(false, "ios"), "by Apple");
});

test("a stop says nothing, a silence says so gently, the rest say why", () => {
  assert.equal(dictationErrorMessage("aborted", "android"), null);
  assert.match(dictationErrorMessage("no-speech", "ios"), /catch/);
  assert.match(dictationErrorMessage("speech-timeout", "android"), /catch/);
  assert.match(dictationErrorMessage("not-allowed", "ios"), /speech recognition/);
  assert.match(dictationErrorMessage("not-allowed", "android"), /microphone/);
  assert.match(dictationErrorMessage("service-not-allowed", "android"), /Google app/);
  assert.match(dictationErrorMessage("network", "android"), /connection/);
  assert.match(dictationErrorMessage("something-new", "android"), /Try again/);
});

test("a silence is told in the resting ink, a failure in the error's", () => {
  assert.equal(dictationErrorTone("no-speech"), "quiet");
  assert.equal(dictationErrorTone("speech-timeout"), "quiet");
  assert.equal(dictationErrorTone("not-allowed"), "error");
  assert.equal(dictationErrorTone("network"), "error");
});

test("the words heard so far are typed into the draft, and leave it untouched when there are none", () => {
  assert.equal(dictatedDraft("", "check the gateway"), "Check the gateway");
  assert.equal(dictatedDraft("Run the tests.", "then the lint"), "Run the tests. Then the lint");
  assert.equal(dictatedDraft("Run the tests", "  "), "Run the tests");
});

test("an empty composer says it is listening and where the audio goes, and nothing at rest", () => {
  assert.equal(dictationPlaceholder("listening", "on this phone"), "Listening on this phone…");
  assert.equal(dictationPlaceholder("listening", null), "Listening…");
  assert.equal(dictationPlaceholder("starting", "on this phone"), "Starting the microphone…");
  assert.equal(dictationPlaceholder("idle", "on this phone"), null);
});

test("a final that settles on less than it showed keeps the words that were said", () => {
  assert.equal(
    settledTranscript("and then run the tests and commit it", "and then run the tests"),
    "and then run the tests and commit it",
  );
  assert.equal(settledTranscript("the last sentence", ""), "the last sentence", "an empty final keeps the interim");
  assert.equal(settledTranscript("", " next segment"), "next segment", "a segment's leading space is not kept");
  assert.equal(settledTranscript("I want to", "I want two"), "I want two", "a revision is taken as it is");
  assert.equal(settledTranscript("", ""), "");
});

test("a pause ends a run, not the dictation", () => {
  assert.equal(isDictationSilence("no-speech"), true);
  assert.equal(isDictationSilence("speech-timeout"), true);
  assert.equal(isDictationSilence("nomatch"), true);
  assert.equal(isDictationSilence("not-allowed"), false);
  assert.equal(isDictationSilence("network"), false);
  assert.equal(isDictationSilence("aborted"), false);
});

test("dictation listens on until it is stopped, for up to ten minutes", () => {
  const session = { stopping: false, startedAt: 0, now: 5_000, quickEnds: 0 };
  assert.equal(DICTATION_LIMIT_MS, 10 * 60_000);
  assert.equal(shouldKeepDictating(session), true, "a run ended at a pause is followed by another");
  assert.equal(shouldKeepDictating({ ...session, now: 9 * 60_000 }), true);
  assert.equal(shouldKeepDictating({ ...session, stopping: true }), false, "the person's stop is final");
  assert.equal(shouldKeepDictating({ ...session, now: DICTATION_LIMIT_MS }), false, "ten minutes is the limit");
  assert.equal(shouldKeepDictating({ ...session, quickEnds: 3 }), false, "a recogniser that cannot listen stops");
});

test("a send's wait settles the words being heard and keeps every stretch", () => {
  let tail = dictationTail("then deploy");
  assert.deepEqual(tailWords(tail), ["then deploy"], "the words shown, if nothing settles them");
  tail = tailHeard(tail, "then deploy it to staging", true);
  assert.deepEqual(tailWords(tail), ["then deploy it to staging"]);
  tail = tailHeard(tail, "and tell me", false);
  assert.equal(tailShown(tail), "then deploy it to staging and tell me");
  // A final that settles on less than it showed keeps the words that were said.
  tail = tailHeard(tail, "and tell", true);
  assert.deepEqual(tailWords(tail), ["then deploy it to staging", "and tell me"]);
  assert.deepEqual(tailWords(dictationTail("  ")), []);
});

test("a send's message is the draft with the settled words joined as dictation would type them", () => {
  assert.equal(messageWithDictation("Run the tests.", ["then deploy it"]), "Run the tests. Then deploy it");
  assert.equal(messageWithDictation("", ["check it.", "then ship"]), "Check it. Then ship");
  assert.equal(messageWithDictation("Typed", []), "Typed");
});

test("a send waits a moment, not long, for the last words", () => {
  assert.ok(SEND_FINISH_MS >= 1_500 && SEND_FINISH_MS <= 2_000);
});

test("a result that reads the whole run again gives only the words after what was settled", () => {
  // iOS keeps the run in every result, yet marks one final at each pause.
  assert.equal(freshTranscript("Let's test this one.", " Let's test this one. And see"), "And see");
  assert.equal(freshTranscript("", "Let's test this one."), "Let's test this one.");
  // A revision of the settled words is the run read again, not new words.
  assert.equal(
    freshTranscript("Let's test this one and see how it comes through", "Let's test this one, and see how it comes through. Also the send"),
    "Also the send",
  );
  assert.equal(
    freshTranscript("Check the gateway and then their logs today", "Check the gateway and then there logs today please"),
    "please",
  );
});

test("a final that only says the settled words again adds nothing", () => {
  const run = "Let's test this one and see how it comes through.";
  // The stop's final result: the whole run again, or the last stretch again.
  assert.equal(freshTranscript(run, " Let's test this one and see how it comes through."), "");
  assert.equal(freshTranscript("First this. Then that.", "Then that."), "");
});

test("a stretch the recogniser starts afresh is all new", () => {
  assert.equal(freshTranscript("First this.", "then that"), "then that");
  assert.equal(freshTranscript("Run the tests.", "then deploy it to staging"), "then deploy it to staging");
});

test("a run's settled words grow by each stretch", () => {
  assert.equal(runWithSettled("", "First this."), "First this.");
  assert.equal(runWithSettled("First this.", " then that "), "First this. then that");
  assert.equal(runWithSettled("First this.", "  "), "First this.");
});
