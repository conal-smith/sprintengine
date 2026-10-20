// A question the agent asks in several parts is answered one part at a time,
// as the desktop asks it: the part, "1 of 3", Back once past the first, Next,
// and on the last part Submit. Every answer goes back together, in one
// `answerQuestion`, keyed by each part's whole question text.

/** One part's answer: its picks in the order picked, then the typed words. */
export function questionAnswer(picks: readonly string[] | undefined, freeText: string | undefined): string {
  const typed = freeText?.trim();
  return [...(picks ?? []), ...(typed ? [typed] : [])].join(", ");
}

/** Every part's answer, keyed by the part's question text, as the desktop takes them. */
export function questionAnswers(
  labels: readonly string[],
  picks: Readonly<Record<string, readonly string[]>>,
  freeText: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(labels.map((label) => [label, questionAnswer(picks[label], freeText[label])]));
}

export type QuestionStep = {
  /** The part shown, held inside the questions there are. */
  index: number;
  /** "2 of 3" (after the part's header, where it has one); none for a lone question. */
  meta: string | null;
  back: boolean;
  /** The last part submits; any before it moves on. */
  primary: "next" | "submit";
  label: "Next" | "Submit answers";
  /** Next once this part is answered; Submit once every part is. */
  primaryEnabled: boolean;
};

/**
 * Where the card is among the parts. `answers` is each part's answer in
 * order; a part with nothing picked and nothing typed is unanswered.
 */
export function questionStep(input: {
  step: number;
  answers: readonly string[];
  header?: string;
}): QuestionStep {
  const count = input.answers.length;
  const index = Math.max(0, Math.min(Math.floor(input.step) || 0, count - 1));
  const last = index >= count - 1;
  const answered = (answer: string | undefined) => !!answer?.trim();
  const header = input.header?.trim();
  return {
    index,
    meta: count > 1 ? `${header ? `${header} · ` : ""}${index + 1} of ${count}` : null,
    back: index > 0,
    primary: last ? "submit" : "next",
    label: last ? "Submit answers" : "Next",
    primaryEnabled: count > 0 && (last ? input.answers.every(answered) : answered(input.answers[index])),
  };
}
