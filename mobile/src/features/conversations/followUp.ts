// What a message sent while a reply runs does: wait for the turn to end
// (Queue), or go into the turn now (Steer). The person picks the default in
// Settings; a long press on the send does the other one.

/** The default for a message sent while an agent is working. */
export type FollowUpBehavior = "queue" | "steer";

/** What the send does now: a plain send, or one of the two mid-turn kinds. */
export type FollowUpAction = "send" | "queue" | "steer";

/** Anything stored but `steer` reads as Queue, which is what the phone always did. */
export function readFollowUpBehavior(value: string | null | undefined): FollowUpBehavior {
  return value === "steer" ? "steer" : "queue";
}

/**
 * Whether a message sent now may steer the running turn.
 *
 * - Only to a desktop that takes a steer, and only into a chat whose CLI the
 *   desktop says can take one: an unknown answer offers no Steer.
 * - Only while a turn runs; with none running a send starts one.
 * - Never with pictures. Where the turn cannot take the message after all, the
 *   desktop holds it as a queued send, and a held message is its words alone.
 */
export function steerOffered(input: {
  declared: boolean;
  chatSteers: boolean | undefined;
  turnBusy: boolean;
  uploads: number;
}): boolean {
  return input.declared && input.chatSteers === true && input.turnBusy && input.uploads === 0;
}

/**
 * The send's action. With no turn running it is a plain send. Mid-turn it is
 * the default, or the other one for a long press, and Queue whenever Steer is
 * not on offer, so a long press never does something the chat cannot take.
 */
export function followUpAction(input: {
  turnBusy: boolean;
  steerable: boolean;
  behavior: FollowUpBehavior;
  alternate: boolean;
}): FollowUpAction {
  if (!input.turnBusy) return "send";
  if (!input.steerable) return "queue";
  const wanted = input.alternate ? (input.behavior === "steer" ? "queue" : "steer") : input.behavior;
  return wanted;
}

/**
 * What the send is called, and what a long press on it does, for a reader:
 * the hint names the other action only where there is one.
 */
export function followUpSendLabel(input: {
  action: FollowUpAction;
  steerable: boolean;
  behavior: FollowUpBehavior;
}): { label: string; hint?: string } {
  if (input.action === "send") return { label: "Send" };
  if (!input.steerable) return { label: "Queue", hint: "Sends when this turn ends." };
  return input.behavior === "steer"
    ? { label: "Steer", hint: "Goes into this turn now. Long-press to queue it for when the turn ends." }
    : { label: "Queue", hint: "Sends when this turn ends. Long-press to steer it into this turn now." };
}
