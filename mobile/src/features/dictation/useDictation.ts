import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import type { ExpoSpeechRecognitionOptions } from "expo-speech-recognition";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import {
  DICTATION_LIMIT_MS,
  SEND_FINISH_MS,
  dictationErrorMessage,
  dictationErrorTone,
  dictationSourceLabel,
  dictationTail,
  freshTranscript,
  isDictationSilence,
  runWithSettled,
  settledTranscript,
  shouldKeepDictating,
  tailHeard,
  tailShown,
  tailWords,
  type DictationTail,
} from "./dictationLogic";

export type DictationState = "idle" | "starting" | "listening";

// The recogniser is one per phone and its events reach every listener, so the
// composer that started it owns it until it ends; any other mounted composer
// (a chat under New, say) ignores what it hears. A composer that takes it over
// tells the last owner, which keeps what it heard and goes back to rest.
type Owner = { yield: () => void };
let owner: Owner | null = null;

// A run that ends sooner than this with nothing heard is the recogniser
// refusing to listen, not a pause; a few in a row end the dictation.
const QUICK_END_MS = 1_000;
// Android answers a start made straight after an end with "busy".
const RESTART_DELAY_MS = 250;

type Session = {
  options: ExpoSpeechRecognitionOptions;
  startedAt: number;
  runStartedAt: number;
  heardInRun: boolean;
  quickEnds: number;
  stopping: boolean;
};

// A send made while the microphone listens: the recogniser has been asked to
// stop, and the send waits for the words it settles.
type Finishing = {
  tail: DictationTail;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<string[] | null>;
  resolve: (words: string[] | null) => void;
};

/**
 * Speak into a composer through the phone's own recogniser: Google's on
 * Android, Apple's on iOS (expo-speech-recognition wraps both).
 *
 * One tap listens until the mic is tapped again, through the pauses in a
 * message, for up to ten minutes (`DICTATION_LIMIT_MS`). Recognition is
 * continuous, and where a phone still ends a run on its own — at a pause on
 * older Android, after a minute on iOS's server recogniser — the next run
 * starts and the words carry on. Each settled stretch goes to `onText` for the
 * composer to add to its draft, and so does whatever was still being heard
 * when a run ended: a run that ends without a final result keeps its words.
 * Nothing is sent. While it listens, `interim` is what it thinks it has heard
 * since the last settled stretch, still being revised.
 *
 * A send made while it listens calls `finishForSend`, which stops the
 * recogniser, waits for the words still being heard to settle, and hands them
 * to the send instead of the draft; nothing the recogniser says after that
 * reaches the composer.
 *
 * On-device recognition is asked for where the phone has it, and `source`
 * says which ran, so a voice never leaves the phone without the composer
 * saying so.
 */
export function useDictation(onText: (text: string) => void) {
  const me = useRef<Owner>({ yield: () => {} }).current;
  const [state, setState] = useState<DictationState>("idle");
  const [interim, setInterim] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"quiet" | "error">("error");
  const deliver = useRef(onText);
  deliver.current = onText;
  // The handlers read these as they are now, not as they were at render.
  const heard = useRef("");
  // What this run of the recogniser has settled so far, which a result may
  // read again; only the words after it are new.
  const runSettled = useRef("");
  const session = useRef<Session | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every start, stop and unmount: a start still waiting on the
  // permission prompt goes on only if nothing has happened since it began.
  const attempt = useRef(0);
  // Between a tap and the first run, nothing of this composer's is listening
  // yet: what the recogniser reports then is the end of someone else's run.
  const pending = useRef(false);
  const finishing = useRef<Finishing | null>(null);
  const mine = () => owner === me;

  const hear = useCallback((text: string) => {
    heard.current = text;
    setInterim(text);
  }, []);

  // Whatever was still being heard is kept: a run can end with no final result
  // (a stop, a silence, iOS's empty final), and those words were said.
  const settle = useCallback(() => {
    const words = heard.current.trim();
    hear("");
    if (words) deliver.current(words);
  }, [hear]);

  const clearTimers = useCallback(() => {
    if (limitTimer.current) clearTimeout(limitTimer.current);
    if (restartTimer.current) clearTimeout(restartTimer.current);
    limitTimer.current = null;
    restartTimer.current = null;
  }, []);

  // The microphone is no longer this composer's: what the recogniser reports
  // from here on reaches no draft.
  const release = useCallback(() => {
    clearTimers();
    session.current = null;
    pending.current = false;
    if (owner === me) owner = null;
    setState("idle");
  }, [clearTimers, me]);

  const finish = useCallback(() => {
    settle();
    release();
  }, [release, settle]);

  // The wait a send made mid-sentence is over: the recogniser ended, or failed,
  // or the wait ran out (then it is cut off), or the composer went (then the
  // send is called off). The words go to the send, never to the draft.
  const finishSend = useCallback(
    (how: "ended" | "timeout" | "gone") => {
      const current = finishing.current;
      if (!current) return;
      finishing.current = null;
      clearTimeout(current.timer);
      const mineNow = owner === me;
      hear("");
      release();
      if (how !== "ended" && mineNow) ExpoSpeechRecognitionModule.abort();
      current.resolve(how === "gone" ? null : tailWords(current.tail));
    },
    [hear, me, release],
  );

  // Another composer took the microphone: what was heard stays in this draft,
  // or goes with the send that was waiting on it.
  me.yield = () => {
    attempt.current++;
    if (finishing.current) finishSend("ended");
    else finish();
  };

  useSpeechRecognitionEvent("start", () => {
    if (mine()) setState("listening");
  });
  useSpeechRecognitionEvent("result", (event) => {
    if (!mine() || !session.current) return;
    const said = event.results[0]?.transcript ?? "";
    if (said.trim()) session.current.heardInRun = true;
    const transcript = freshTranscript(runSettled.current, said);
    const waiting = finishing.current;
    if (waiting) {
      const before = waiting.tail.settled.length;
      waiting.tail = tailHeard(waiting.tail, transcript, event.isFinal);
      for (const words of waiting.tail.settled.slice(before)) runSettled.current = runWithSettled(runSettled.current, words);
      hear(tailShown(waiting.tail));
      return;
    }
    if (event.isFinal) {
      const words = settledTranscript(heard.current, transcript);
      hear("");
      runSettled.current = runWithSettled(runSettled.current, words);
      if (words) deliver.current(words);
    } else {
      hear(transcript);
    }
  });
  useSpeechRecognitionEvent("error", (event) => {
    if (!mine() || (!session.current && pending.current)) return;
    if (finishing.current) {
      // A silence or the abort is the stop's to report; "end" follows. A
      // failure ends the wait with the words already heard.
      if (event.error !== "aborted" && !isDictationSilence(event.error)) finishSend("ended");
      return;
    }
    // A pause the recogniser gave up on ends this run; "end" follows and the
    // next run starts. The person stopping it is not worth a word either.
    if (isDictationSilence(event.error) && session.current && !session.current.stopping) return;
    if (event.error === "aborted" || (isDictationSilence(event.error) && session.current?.stopping)) return;
    setErrorTone(dictationErrorTone(event.error));
    setError(dictationErrorMessage(event.error, Platform.OS));
    finish();
  });
  useSpeechRecognitionEvent("end", () => {
    if (!mine()) return;
    if (finishing.current) {
      finishSend("ended");
      return;
    }
    settle();
    const current = session.current;
    if (!current) {
      if (!pending.current) finish();
      return;
    }
    const now = Date.now();
    const quick = !current.heardInRun && now - current.runStartedAt < QUICK_END_MS;
    current.quickEnds = quick ? current.quickEnds + 1 : 0;
    if (!shouldKeepDictating({ ...current, now })) {
      finish();
      return;
    }
    restartTimer.current = setTimeout(() => {
      restartTimer.current = null;
      if (!mine() || session.current !== current || current.stopping) return;
      current.runStartedAt = Date.now();
      current.heardInRun = false;
      runSettled.current = "";
      try {
        ExpoSpeechRecognitionModule.start(current.options);
      } catch {
        setError(dictationErrorMessage("unknown", Platform.OS));
        finish();
      }
    }, RESTART_DELAY_MS);
  });

  // A line about the last attempt is not a standing notice: it clears after
  // a few seconds, as a toast does, or at the next tap of the mic.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6_000);
    return () => clearTimeout(timer);
  }, [error]);

  // Leaving the screen mid-sentence drops the sentence rather than leaving
  // the microphone open behind it.
  useEffect(
    () => () => {
      attempt.current++;
      finishSend("gone");
      clearTimers();
      session.current = null;
      pending.current = false;
      if (owner === me) {
        owner = null;
        ExpoSpeechRecognitionModule.abort();
      }
    },
    [clearTimers, finishSend, me],
  );

  // Stop asks for the final result, which arrives as one more "result" event
  // before "end"; it is not thrown away, and "end" keeps whatever it left out.
  const stop = useCallback(() => {
    if (owner !== me || finishing.current) return;
    // Still asking for the microphone: the start that is waiting is called off.
    if (!session.current) {
      attempt.current++;
      finish();
      return;
    }
    session.current.stopping = true;
    // Between runs there is no recogniser to stop: end here.
    if (restartTimer.current) {
      finish();
      return;
    }
    ExpoSpeechRecognitionModule.stop();
  }, [finish, me]);

  /**
   * Ends the dictation for a send made while the microphone listens, and
   * resolves to the words the send carries: the words being heard, settled by
   * the final result the stop asks for, or as last shown if the recogniser has
   * not answered within `SEND_FINISH_MS`. They go with the message and never
   * to the draft; whatever the recogniser says afterwards is dropped. Resolves
   * to null if the composer goes while it waits. A second call joins the wait
   * the first began.
   */
  const finishForSend = useCallback((): Promise<string[] | null> => {
    if (finishing.current) return finishing.current.promise;
    if (owner !== me) return Promise.resolve([]);
    const words = heard.current.trim() ? [heard.current.trim()] : [];
    // Still asking for the microphone: the start is called off. Between runs
    // there is no recogniser to wait on.
    if (!session.current || restartTimer.current) {
      attempt.current++;
      hear("");
      release();
      return Promise.resolve(words);
    }
    session.current.stopping = true;
    let resolve: (words: string[] | null) => void = () => {};
    const promise = new Promise<string[] | null>((done) => {
      resolve = done;
    });
    finishing.current = {
      tail: dictationTail(heard.current),
      timer: setTimeout(() => finishSend("timeout"), SEND_FINISH_MS),
      promise,
      resolve,
    };
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      finishSend("timeout");
    }
    return promise;
  }, [finishSend, hear, me, release]);

  const start = useCallback(async () => {
    setError(null);
    if (owner && owner !== me) {
      const previous = owner;
      owner = null;
      previous.yield();
      ExpoSpeechRecognitionModule.abort();
    }
    owner = me;
    const run = ++attempt.current;
    pending.current = true;
    hear("");
    setState("starting");
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      // Stopped, left or taken over while the phone asked: the microphone
      // stays off.
      if (owner !== me || attempt.current !== run) return;
      if (!permission.granted) {
        setError(dictationErrorMessage("not-allowed", Platform.OS));
        finish();
        return;
      }
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        setError(dictationErrorMessage("service-not-allowed", Platform.OS));
        finish();
        return;
      }
      const onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
      setSource(dictationSourceLabel(onDevice, Platform.OS));
      const options: ExpoSpeechRecognitionOptions = {
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: onDevice,
        // Android 12 and below cannot run continuously; the module asks those
        // for long silences itself, and a run they end anyway is restarted.
        iosTaskHint: "dictation",
      };
      const now = Date.now();
      session.current = { options, startedAt: now, runStartedAt: now, heardInRun: false, quickEnds: 0, stopping: false };
      pending.current = false;
      runSettled.current = "";
      clearTimers();
      limitTimer.current = setTimeout(stop, DICTATION_LIMIT_MS);
      ExpoSpeechRecognitionModule.start(options);
    } catch {
      if (owner !== me || attempt.current !== run) return;
      setError(dictationErrorMessage("unknown", Platform.OS));
      finish();
    }
  }, [clearTimers, finish, hear, me, stop]);

  const toggle = useCallback(() => {
    if (state === "idle") void start();
    else stop();
  }, [start, state, stop]);

  return { state, interim, source, error, errorTone, toggle, stop, finishForSend, dismissError: () => setError(null) };
}
