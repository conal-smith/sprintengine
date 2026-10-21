/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const compiled = path.resolve(__dirname, "../../../.mobile-test-build/src/features/dictation/useDictation.js");
const localRequire = createRequire(compiled);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const { joinDictation, messageWithDictation, SEND_FINISH_MS } = localRequire("./dictationLogic");

/**
 * The hook's production closures over a fake React and a fake recogniser: one
 * module (one recogniser, one owner), any number of composers using it. Timers
 * are the test's: `after(ms)` runs those set for that delay.
 */
function harness() {
  const timers = new Set();
  const fakeSetTimeout = (fn, ms) => {
    const timer = { fn, ms };
    timers.add(timer);
    return timer;
  };
  const fakeClearTimeout = (timer) => timers.delete(timer);
  const after = (ms) => {
    for (const timer of [...timers]) {
      if (timer.ms !== ms) continue;
      timers.delete(timer);
      timer.fn();
    }
  };
  const calls = [];
  const asks = [];
  let active = null;
  const composers = [];
  const react = {
    useRef(value) {
      const i = active.cursor++;
      return (active.slots[i] ??= { current: value });
    },
    useState(value) {
      const i = active.cursor++;
      const slot = (active.slots[i] ??= { value: typeof value === "function" ? value() : value });
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useCallback(callback, deps) {
      const i = active.cursor++;
      const old = active.slots[i];
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index])))
        active.slots[i] = { value: callback, deps };
      return active.slots[i].value;
    },
    useEffect(callback, deps) {
      const i = active.cursor++;
      const old = active.slots[i];
      const owner = active;
      if (!old || deps.some((value, index) => !Object.is(value, old.deps[index])))
        owner.effects.push(() => {
          old?.cleanup?.();
          owner.slots[i] = { deps, cleanup: callback() };
        });
    },
  };
  const speech = {
    ExpoSpeechRecognitionModule: {
      requestPermissionsAsync: () =>
        new Promise((resolve) => {
          asks.push(resolve);
        }),
      isRecognitionAvailable: () => true,
      supportsOnDeviceRecognition: () => true,
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
      abort: () => calls.push("abort"),
    },
    useSpeechRecognitionEvent(name, handler) {
      active.handlers[name] = handler;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(compiled, "utf8"),
    {
      exports: module.exports,
      module,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      Date,
      require(name) {
        if (name === "react") return react;
        if (name === "react-native") return { Platform: { OS: "ios" } };
        if (name === "expo-speech-recognition") return speech;
        return localRequire(name);
      },
    },
    { filename: compiled },
  );
  const composer = () => {
    // `draft` is the composer's box as the screens keep it: dictation only
    // ever adds to it. `sent` is every message its Send has made.
    const entry = { slots: [], effects: [], handlers: {}, cursor: 0, said: [], draft: "", sent: [], mounted: true, result: null };
    entry.render = () => {
      active = entry;
      entry.cursor = 0;
      entry.result = module.exports.useDictation((text) => {
        entry.said.push(text);
        entry.draft = joinDictation(entry.draft, text);
      });
      active = null;
      while (entry.effects.length) entry.effects.shift()();
      return entry.result;
    };
    entry.unmount = () => {
      entry.mounted = false;
      for (const slot of entry.slots) slot?.cleanup?.();
    };
    // Send as the screens make it: mid-dictation it waits for the words still
    // being heard, then sends the draft with them as one message.
    entry.send = async () => {
      let message = entry.draft;
      if (entry.render().state !== "idle") {
        const spoken = await entry.result.finishForSend();
        if (spoken === null) return;
        message = messageWithDictation(entry.draft, spoken);
      }
      entry.sent.push(message);
      entry.draft = "";
    };
    entry.render();
    composers.push(entry);
    return entry;
  };
  // The recogniser's events reach every mounted composer, as the module's do.
  const emit = (name, event = {}) => {
    for (const entry of composers) if (entry.mounted) entry.handlers[name]?.(event);
  };
  const allow = async (granted = true) => {
    asks.shift()({ granted });
    await settle();
  };
  return { calls, composer, emit, allow, after };
}

test("a second tap while the phone asks for the microphone calls the start off", async () => {
  const h = harness();
  const chat = h.composer();
  chat.result.toggle();
  assert.equal(chat.render().state, "starting");
  chat.result.toggle();
  assert.equal(chat.render().state, "idle");
  await h.allow();
  assert.equal(h.calls.includes("start"), false, "the microphone never opens");
  assert.equal(chat.render().state, "idle");
});

test("leaving the chat while the phone asks for the microphone leaves it off", async () => {
  const h = harness();
  const chat = h.composer();
  chat.result.toggle();
  chat.render();
  chat.unmount();
  await h.allow();
  assert.equal(h.calls.includes("start"), false);
});

test("taking the microphone from another composer keeps its words and ignores its run's end", async () => {
  const h = harness();
  const under = h.composer();
  const top = h.composer();
  under.result.toggle();
  await h.allow();
  h.emit("start");
  assert.equal(under.render().state, "listening");
  h.emit("result", { isFinal: false, results: [{ transcript: "check the gateway" }] });

  top.render().toggle();
  assert.deepEqual(under.said, ["check the gateway"], "the words heard stay in the draft they were said into");
  assert.equal(under.render().state, "idle");
  // The aborted run ends while the new composer still waits on the prompt.
  h.emit("end");
  assert.equal(top.render().state, "starting");
  await h.allow();
  assert.equal(h.calls.filter((call) => call === "start").length, 2);
  h.emit("start");
  assert.equal(top.render().state, "listening");
  top.unmount();
  under.unmount();
});

const listening = async (h, chat) => {
  chat.result.toggle();
  await h.allow();
  h.emit("start");
  assert.equal(chat.render().state, "listening");
};
const heard = (transcript, isFinal = false) => ({ isFinal, results: [{ transcript }] });

test("a send mid-sentence stops the microphone, waits for the last words, and sends everything once", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("Run the tests.", true));
  assert.equal(chat.draft, "Run the tests.");
  // The box shows the words still being heard; the voice is ahead of them.
  h.emit("result", heard("then deploy"));
  assert.equal(chat.render().interim, "then deploy");

  const sending = chat.send();
  await settle();
  assert.ok(h.calls.includes("stop"), "the recogniser is asked for its final result");
  assert.equal(h.calls.includes("abort"), false, "the words still being heard are not thrown away");
  assert.deepEqual(chat.sent, [], "nothing goes until the last words settle");
  // The stop's final result has the words the box had not caught up with.
  h.emit("result", heard("then deploy it to staging", true));
  assert.equal(chat.render().interim, "then deploy it to staging", "the box shows them while the send waits");
  h.emit("end");
  await sending;

  assert.deepEqual(chat.sent, ["Run the tests. Then deploy it to staging"]);
  assert.equal(chat.draft, "");
  assert.equal(chat.render().state, "idle", "the microphone is off");
  assert.equal(chat.result.interim, "");
  chat.unmount();
});

test("a result the recogniser gives after the send is neither put back in the box nor sent", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("check the gateway"));
  const sending = chat.send();
  await settle();
  h.emit("result", heard("check the gateway logs", true));
  h.emit("end");
  await sending;
  assert.deepEqual(chat.sent, ["Check the gateway logs"]);

  h.emit("result", heard("check the gateway logs please", true));
  h.emit("result", heard("and more"));
  h.emit("end");
  assert.equal(chat.draft, "");
  assert.equal(chat.render().interim, "");
  assert.equal(chat.result.state, "idle");
  assert.deepEqual(chat.sent, ["Check the gateway logs"]);
  assert.equal(h.calls.filter((call) => call === "start").length, 1, "the microphone is not opened again");
  chat.unmount();
});

test("a recogniser that never settles sends the words last shown, cuts the microphone off, and drops what comes late", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("open a pull request"));
  const sending = chat.send();
  await settle();
  assert.deepEqual(chat.sent, []);
  h.after(SEND_FINISH_MS);
  await sending;
  assert.deepEqual(chat.sent, ["Open a pull request"]);
  assert.ok(h.calls.includes("abort"), "the microphone does not listen on");
  assert.equal(chat.render().state, "idle");

  h.emit("result", heard("open a pull request for it", true));
  h.emit("end");
  assert.equal(chat.draft, "");
  assert.deepEqual(chat.sent, ["Open a pull request"]);
  chat.unmount();
});

test("a second tap of Send while it waits makes no second message", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("fix the build"));
  const first = chat.result.finishForSend();
  const second = chat.result.finishForSend();
  assert.equal(first, second, "the second tap joins the wait the first began");
  assert.equal(h.calls.filter((call) => call === "stop").length, 1);
  h.emit("result", heard("fix the build now", true));
  h.emit("end");
  assert.deepEqual(await first, ["fix the build now"]);
  chat.unmount();
});

test("a send after a pause carries every stretch the wait settles, in order", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("first this"));
  const sending = chat.send();
  await settle();
  h.emit("result", heard("first this.", true));
  h.emit("result", heard("then that"));
  h.emit("result", heard("then that.", true));
  h.emit("end");
  await sending;
  assert.deepEqual(chat.sent, ["First this. Then that."]);
});

test("nothing is sent on a pause: the words heard across it only fill the draft", async () => {
  const h = harness();
  const chat = h.composer();
  chat.draft = "Two things:";
  await listening(h, chat);
  h.emit("result", heard("the header"));
  h.emit("result", heard("the header is wrong.", true));
  // The phone gives up on the silence and ends the run; another follows.
  h.emit("error", { error: "no-speech" });
  h.emit("end");
  h.after(250);
  assert.equal(h.calls.filter((call) => call === "start").length, 2, "it listens on through the pause");
  h.emit("start");
  h.emit("result", heard("and the footer", true));
  assert.equal(chat.render().state, "listening");
  assert.equal(chat.draft, "Two things: The header is wrong. And the footer");
  assert.deepEqual(chat.sent, []);
  assert.equal(h.calls.includes("stop"), false);
  chat.unmount();
});

test("a tap of the mic still stops it and keeps the last words in the draft", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("rename the screen"));
  chat.result.toggle();
  assert.ok(h.calls.includes("stop"));
  h.emit("result", heard("rename the screen to New", true));
  h.emit("end");
  assert.equal(chat.draft, "Rename the screen to New");
  assert.equal(chat.render().state, "idle");
  assert.deepEqual(chat.sent, []);
  chat.unmount();
});

test("leaving the chat while a send waits calls the send off and the microphone with it", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("half a thought"));
  const sending = chat.send();
  await settle();
  chat.unmount();
  await sending;
  assert.deepEqual(chat.sent, []);
  assert.ok(h.calls.includes("abort"));
});

test("a send while the phone still asks for the microphone calls the start off and sends the draft", async () => {
  const h = harness();
  const chat = h.composer();
  chat.draft = "Ship it";
  chat.result.toggle();
  assert.equal(chat.render().state, "starting");
  await chat.send();
  assert.deepEqual(chat.sent, ["Ship it"]);
  await h.allow();
  assert.equal(h.calls.includes("start"), false, "the microphone never opens");
  assert.equal(chat.render().state, "idle");
});

test("a run that reads itself again at every pause puts each word in the draft once", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("Let's test this one"));
  h.emit("result", heard("Let's test this one and see how it comes through.", true));
  assert.equal(chat.draft, "Let's test this one and see how it comes through.");
  // The next stretch arrives with the first one still in it.
  h.emit("result", heard(" Let's test this one and see how it comes through. And also"));
  assert.equal(chat.render().interim, "And also");
  h.emit("result", heard(" Let's test this one and see how it comes through. And also the send.", true));
  assert.equal(chat.draft, "Let's test this one and see how it comes through. And also the send.");
  // The mic is tapped: the stop's final result says the whole run again.
  chat.result.toggle();
  h.emit("result", heard(" Let's test this one and see how it comes through. And also the send.", true));
  h.emit("end");
  assert.equal(chat.draft, "Let's test this one and see how it comes through. And also the send.");
  assert.equal(chat.render().state, "idle");
  chat.unmount();
});

test("a send after a pause makes one message without the settled words twice", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("Let's test this one and see how it comes through.", true));
  const sending = chat.send();
  await settle();
  // The stop's final result repeats the stretch the pause already settled.
  h.emit("result", heard(" Let's test this one and see how it comes through.", true));
  h.emit("end");
  await sending;
  assert.deepEqual(chat.sent, ["Let's test this one and see how it comes through."]);
  chat.unmount();
});

test("a send mid-stretch, on a recogniser that reads the run again, carries only the new words", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("Check the gateway.", true));
  h.emit("result", heard("Check the gateway. Then the logs"));
  const sending = chat.send();
  await settle();
  h.emit("result", heard("Check the gateway. Then the logs on the desktop.", true));
  h.emit("end");
  await sending;
  assert.deepEqual(chat.sent, ["Check the gateway. Then the logs on the desktop."]);
  chat.unmount();
});

test("a stretch the last run settled is not taken for a repeat in the next run", async () => {
  const h = harness();
  const chat = h.composer();
  await listening(h, chat);
  h.emit("result", heard("Yes.", true));
  h.emit("error", { error: "no-speech" });
  h.emit("end");
  h.after(250);
  h.emit("start");
  h.emit("result", heard("Yes.", true));
  assert.equal(chat.draft, "Yes. Yes.");
  chat.unmount();
});
