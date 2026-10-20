// A message Studio sent a chat itself, rather than the person: news from an
// agent the chat launched (`agent-notice`), or a resume once a usage limit
// that stopped the chat has reset (`usage-resume`). The desktop records it as
// a `user_message` like any other, since the agent is handed it as a turn,
// and marks it with an `origin` on the payload (the desktop's
// `readConversationMessageOrigin`, conversation-protocol's events.ts).
//
// `origin` is an optional payload member the phone's pinned wire types do not
// name, so it is read here off the payload, defensively: anything but
// `{ kind: 'studio' }` is the person's message, as every message recorded
// before the member existed is. A reason this phone does not know is still
// Studio's; only the reason is dropped.
//
// Such a message is not the person's: the chat draws it as Studio's quiet row,
// not their bubble, and it is never "the person wrote" for anything that reads
// that (the desktop's `lastUserMessageAt`, which the list orders by, leaves it
// out the same way).

export type StudioMessageReason = "agent-notice" | "usage-resume";

/** Who a `user_message` came from when it was not the person. */
export type MessageOrigin = { kind: "studio"; reason?: StudioMessageReason };

const STUDIO_MESSAGE_REASONS: readonly string[] = ["agent-notice", "usage-resume"] satisfies StudioMessageReason[];

/** A `user_message` payload's `origin`, or null for the person's own message. */
export function readMessageOrigin(value: unknown): MessageOrigin | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const origin = value as { kind?: unknown; reason?: unknown };
  if (origin.kind !== "studio") return null;
  return typeof origin.reason === "string" && STUDIO_MESSAGE_REASONS.includes(origin.reason)
    ? { kind: "studio", reason: origin.reason as StudioMessageReason }
    : { kind: "studio" };
}

/** The name Studio's notice row is said under. */
export const STUDIO_NAME = "SprintEngine Studio";

/**
 * How a notice's text opens: the agent is handed it as plain text, which has
 * no field for who is speaking, so the desktop puts its name in the words
 * (`shared/studio-notice.ts` there). A row that already says it is Studio's
 * leaves it out.
 */
export const STUDIO_NOTICE_PREFIX = `[${STUDIO_NAME}]`;

/** The notice's words without the name they open with. */
export function withoutStudioNoticePrefix(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith(STUDIO_NOTICE_PREFIX) ? trimmed.slice(STUDIO_NOTICE_PREFIX.length).trimStart() : text;
}
