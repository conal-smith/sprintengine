// Dictation into a composer, as rules. Kept free of React Native and of the
// speech module so the regression suite runs the same rules the screens do.
//
// A composer is a draft: nothing reaches the agent until the person presses
// send, so a recogniser's revisions can land in it safely.

import { plainLineBreaks } from "../../api/conversationWire";

/**
 * The draft with what was just said added to it. A new utterance is a new
 * sentence when the draft already ends one, and otherwise carries on the
 * sentence in progress, so a second tap of the mic reads as more of the same
 * message rather than words glued on without a space.
 */
export function joinDictation(draft: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return draft;
  if (!draft.trim()) return capitalise(said);
  const trailing = /\s$/u.test(draft) ? "" : " ";
  const sentenceEnded = /[.!?:]\s*$/u.test(draft) || /\n\s*$/u.test(draft);
  return `${draft}${trailing}${sentenceEnded ? capitalise(said) : said}`;
}

/**
 * The composer's text while the microphone listens: the draft with the words
 * heard so far already in it, where they will land. The words are typed into
 * the box as they are heard, rather than held in a line above it until they
 * settle; the recogniser's revisions only ever touch the tail it is still
 * hearing, and the draft under it is the person's own.
 */
export function dictatedDraft(draft: string, interim: string): string {
  return interim.trim() ? joinDictation(draft, interim) : draft;
}

/**
 * The longest a single tap of the mic listens for. Dictation runs through the
 * pauses in a message until the person taps the mic again; this is only the
 * backstop for a microphone left on by mistake.
 */
export const DICTATION_LIMIT_MS = 10 * 60_000;

/**
 * Whether a recogniser's error is just silence: a pause the phone's
 * recogniser gave up on. Those end a run, not the dictation, which listens on
 * until the person stops it.
 */
export function isDictationSilence(code: string): boolean {
  return code === "no-speech" || code === "speech-timeout" || code === "nomatch";
}

/**
 * The words a run settled on. A final result is normally the words to keep,
 * but a recogniser can settle on less than it had shown — a final that is the
 * start of the interim it replaces — and the words it dropped were said, so
 * the longer reading stands. A final that revises the words is taken as it is.
 */
export function settledTranscript(interim: string, final: string): string {
  const heard = interim.trim();
  const settled = final.trim();
  if (!settled) return heard;
  return heard.length > settled.length && heard.startsWith(settled) ? heard : settled;
}

/**
 * What a result says that the run has not already settled.
 *
 * A run's results are not alike across phones. Android, and iOS 18.0, start
 * each stretch after a pause afresh. Other iOS releases keep the whole run in
 * every result, the stretches already settled included, yet still mark a
 * result final at each pause; and the final result a stop asks for can say
 * the last stretch, or the whole run, over again. Taken as they come, those
 * put words in the draft twice ("Let's test this. Let's test this."). So a
 * result that reads the run again from its start gives only the words after
 * what was settled, and one that only repeats the settled words' tail gives
 * nothing. A small revision of the settled words, a comma or a word changed,
 * is still the run read again; it does not reach the draft.
 */
export function freshTranscript(run: string, transcript: string): string {
  const text = plainLineBreaks(transcript).trim();
  const settled = wordKeys(run);
  if (!text || !settled.length) return text;
  const words = text.split(/\s+/u);
  const keys = words.map(wordKey);
  const after = rereadEnd(settled, keys);
  if (after !== null) return words.slice(after).join(" ");
  if (keys.length <= settled.length && keys.every((key, index) => key === settled[settled.length - keys.length + index]))
    return "";
  return text;
}

/** The run's settled words with another stretch settled after them. */
export function runWithSettled(run: string, words: string): string {
  const said = words.trim();
  if (!said) return run;
  return run ? `${run} ${said}` : said;
}

function wordKey(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function wordKeys(text: string): string[] {
  return plainLineBreaks(text)
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map(wordKey);
}

/**
 * Where a result that reads the settled words again ends them: the index of
 * its first word past them, or null when it does not start with them. It
 * starts with them when its opening words are the settled ones to within a
 * word in four (every word, under four), as an edit distance over words with
 * case and punctuation set aside.
 */
function rereadEnd(settled: readonly string[], keys: readonly string[]): number | null {
  const allowed = settled.length < 4 ? 0 : Math.floor(settled.length / 4);
  const widest = Math.min(keys.length, settled.length + allowed);
  if (widest < settled.length - allowed) return null;
  // row[j]: the edits between the settled words so far and the result's first j words.
  let row = Array.from({ length: widest + 1 }, (_, j) => j);
  for (let i = 1; i <= settled.length; i++) {
    const next = [i];
    for (let j = 1; j <= widest; j++) {
      const same = settled[i - 1] === keys[j - 1] ? 0 : 1;
      next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + same));
    }
    row = next;
  }
  let best: number | null = null;
  for (let j = 0; j <= widest; j++) {
    if (row[j] > allowed) continue;
    if (
      best === null ||
      row[j] < row[best] ||
      (row[j] === row[best] && Math.abs(j - settled.length) < Math.abs(best - settled.length))
    )
      best = j;
  }
  return best;
}

/**
 * The longest a send made while the microphone listens waits for the
 * recogniser to settle the words it is still hearing. The words shown lag the
 * voice, and the last of them come only in the final result that stopping the
 * recogniser asks for; a recogniser that never answers sends what it showed.
 */
export const SEND_FINISH_MS = 1_800;

/**
 * What a send made mid-sentence waits on: the stretches the recogniser has
 * settled since the send, and the words it is still hearing. Nothing here
 * reaches the draft until the wait is over, and then it goes with the message.
 */
export type DictationTail = { settled: string[]; hearing: string };

/** The wait a send begins, over the words the box was showing. */
export function dictationTail(hearing: string): DictationTail {
  return { settled: [], hearing };
}

/** A result that reached the wait: a final settles the words, an interim revises them. */
export function tailHeard(tail: DictationTail, transcript: string, isFinal: boolean): DictationTail {
  if (!isFinal) return { settled: tail.settled, hearing: transcript };
  const words = settledTranscript(tail.hearing, transcript);
  return { settled: words ? [...tail.settled, words] : tail.settled, hearing: "" };
}

/**
 * The words a send carries once the wait is over: every settled stretch, and
 * whatever was still being heard when the recogniser ended or the wait ran out.
 */
export function tailWords(tail: DictationTail): string[] {
  const hearing = tail.hearing.trim();
  return hearing ? [...tail.settled, hearing] : tail.settled;
}

/** The tail's words as the box shows them while the send waits. */
export function tailShown(tail: DictationTail): string {
  return tailWords(tail).join(" ");
}

/**
 * The one message a send makes: the draft as it stood, with the stretches the
 * dictation settled on joined to it as the microphone would have typed them.
 */
export function messageWithDictation(draft: string, spoken: readonly string[]): string {
  return spoken.reduce(joinDictation, draft);
}

/**
 * Whether a run the recogniser ended on its own should be followed by another.
 * Phones end a run at a pause (older Android, iOS's server recogniser after a
 * minute), so dictation starts the next one and carries on — unless the person
 * stopped it, the limit is up, or the recogniser keeps ending runs the moment
 * they start, which is a recogniser that cannot listen, not a pause.
 */
export function shouldKeepDictating(session: {
  stopping: boolean;
  startedAt: number;
  now: number;
  quickEnds: number;
}): boolean {
  if (session.stopping) return false;
  if (session.now - session.startedAt >= DICTATION_LIMIT_MS) return false;
  return session.quickEnds < 3;
}

/**
 * What an empty composer says while the microphone is on, in place of its
 * usual hint: that it is listening, and where the audio is going.
 */
export function dictationPlaceholder(state: "idle" | "starting" | "listening", source: string | null): string | null {
  if (state === "starting") return "Starting the microphone…";
  if (state === "listening") return `Listening${source ? ` ${source}` : ""}…`;
  return null;
}

function capitalise(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * Where the audio went, in the composer's placeholder while it listens.
 * Recognition on the phone keeps the voice on the phone; anything else is
 * Apple's or Google's service, and the person is told which rather than
 * finding out from a privacy policy.
 */
export function dictationSourceLabel(onDevice: boolean, platform: string): string {
  if (onDevice) return "on this phone";
  return platform === "ios" ? "by Apple" : "by Google";
}

/**
 * What the composer says when dictation stops without text, or null when
 * there is nothing worth saying. The person stopping it is not a failure; a
 * silence the recogniser gave up on is not either, but saying nothing then
 * left a microphone that had listened for five seconds looking as though it
 * never started. `dictationErrorTone` keeps that one in the resting ink, not
 * the error's.
 */
export function dictationErrorTone(code: string): "quiet" | "error" {
  return code === "no-speech" || code === "speech-timeout" ? "quiet" : "error";
}

export function dictationErrorMessage(code: string, platform: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "no-speech":
    case "speech-timeout":
      return "Didn’t catch that. Tap the mic and speak.";
    case "not-allowed":
      return platform === "ios"
        ? "Allow the microphone and speech recognition for Sprint Engine in Settings to dictate."
        : "Allow the microphone for Sprint Engine in Settings to dictate.";
    case "service-not-allowed":
    case "language-not-supported":
      return platform === "ios"
        ? "Dictation is off on this iPhone. Turn it on in Settings › General › Keyboard."
        : "This phone has no speech recogniser. Install or update the Google app to dictate.";
    case "network":
      return "Dictation needs a connection on this phone. Try again when it has one.";
    case "audio-capture":
      return "The microphone is in use by something else.";
    case "busy":
      return "Dictation is still finishing. Try again in a moment.";
    default:
      return "Dictation stopped. Try again.";
  }
}
