import type { ConversationRow } from "./conversationLogic";

// What Copy puts on the clipboard from a chat, worked out here rather than in
// the rows that offer it, so what is copied is decided in one place and read
// by the tests. Always the Markdown as it was written: pasted into an editor,
// a notes app or a terminal, the source is what reads, and a rendered
// reply's drawing has nothing to give a plain-text clipboard.

/**
 * One piece of what was said, without the blank lines around it. A leading
 * line's indent is kept: in Markdown four spaces make a code block.
 */
function said(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/u, "").trimEnd();
}

/**
 * A turn's reply as "Copy reply" copies it: everything the agent said in the
 * turn, in the order it said it (the words between its steps, folded into the
 * turn's work, then the reply after them), a blank line apart. Its thinking,
 * its steps, its agents and its footer are the view's account of the turn,
 * not the reply, and are left out. Empty when the turn said nothing.
 */
export function replyCopyText(rows: readonly ConversationRow[], turn: string): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (row.kind === "fold" && row.turn === turn) {
      for (const part of row.parts) if (part.kind === "prose") parts.push(said(part.text));
    } else if (row.kind === "message" && row.role === "assistant" && row.turn === turn) parts.push(said(row.text));
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * A person's message as "Copy message" copies it: their words exactly as
 * they wrote them. Empty for a message of pictures or files alone, which has
 * no words to copy and so offers no Copy.
 */
export function messageCopyText(text: string): string {
  return text.trim() ? text : "";
}
