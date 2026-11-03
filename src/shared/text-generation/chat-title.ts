/**
 * The chat-title job, provider-agnostic: the prompt every backend sends, the
 * JSON shape it asks for, and the guardrail the answer passes through before
 * it becomes a workspace name.
 *
 * The editorial rule-set below is what earns the call: it is what turns a
 * rambling first prompt into "Sidebar flicker on workspace switch" rather
 * than the prompt's first six words. Deliberately absent: a regeneration
 * variant (a title the person disagrees with is renamed, which the rows
 * already offer) and any tool-use instruction, because every backend here
 * runs with tools off.
 *
 * Pure: no I/O, no Electron, no DOM. Imported by main (to build the request)
 * and by tests.
 */

import { MAX_WORKSPACE_TITLE_LENGTH } from '../workspace-title'
import { quotesToPlainText } from '../chat-quotes'

/**
 * How much of the first prompt the model sees. A title needs the request,
 * not the pasted stack trace after it.
 */
export const MAX_CHAT_TITLE_INPUT_CHARS = 8_000

/**
 * Below this many characters the answer is noise, not a title. Matches the
 * heuristic's own floor so both paths reject the same nothing.
 */
const MIN_CHAT_TITLE_LENGTH = 3

/** The JSON Schema every backend is asked to satisfy: one key, one string. */
export const CHAT_TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
} as const

/** Truncate a prompt section, marking the cut so the model knows it saw a prefix. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[truncated]`
}

const CHAT_TITLE_INSTRUCTIONS = `Generate a title that will help the user recognize this chat weeks later.
Return JSON with exactly one key: title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when the message reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.
- Local git history, branch names and commit messages are not the subject unless the user makes them so.
- If a linked PR or issue is the only clue, fall back to the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.`

/**
 * The full prompt for one first-prompt title. The message rides inside the
 * prompt rather than as a system/user pair because every CLI backend takes a
 * single stdin document; the instructions come first so a message that
 * happens to contain instructions of its own reads as quoted material.
 */
export function buildChatTitlePrompt(message: string): string {
  // A quoted passage is read as words, never as the token it rides in.
  const body = limitSection(quotesToPlainText(message).trim(), MAX_CHAT_TITLE_INPUT_CHARS)
  return `${CHAT_TITLE_INSTRUCTIONS}\n\nUser message:\n${body}`
}

/**
 * Pull the `title` string out of whatever the backend handed back: an object
 * already decoded from structured output, or raw text that may be that JSON
 * serialised, fenced, or just the bare title. Null when nothing there is a
 * string title.
 */
export function readChatTitleOutput(output: unknown): string | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const title = (output as { title?: unknown }).title
    return typeof title === 'string' ? title : null
  }
  if (typeof output !== 'string') return null
  const text = output.trim()
  if (!text) return null
  const candidates = [text, unfence(text), outermostObject(text)].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  )
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const title = readChatTitleOutput(parsed)
      if (title !== null) return title
    } catch {
      // not JSON; try the next shape
    }
  }
  return text
}

function unfence(text: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  return match?.[1]?.trim() ?? null
}

function outermostObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start !== -1 && end > start ? text.slice(start, end + 1) : null
}

/**
 * The guardrail between a model's answer and the sidebar. One line, no
 * wrapping quotes, whitespace collapsed, capped at the same length the
 * heuristic caps at (cut on a word, never mid-word), and rejected — null —
 * when what is left is too short or has no letters. A wrong title is worse
 * than the heuristic's, so a rejection here means the caller keeps what it had.
 */
export function sanitizeGeneratedChatTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const firstLine = raw.trim().split(/\r?\n/)[0] ?? ''
  let title = firstLine
    .trim()
    .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (title.length > MAX_WORKSPACE_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_WORKSPACE_TITLE_LENGTH)
    const lastSpace = cut.lastIndexOf(' ')
    title = lastSpace > MIN_CHAT_TITLE_LENGTH ? cut.slice(0, lastSpace) : cut
  }
  title = title.replace(/[\s,;:.\-–—]+$/, '').trim()
  if (!namesSomething(title)) return null
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/**
 * Whether a generated title says enough to name something: a letter of any
 * script (a title in Japanese or Cyrillic names a chat as well as one in
 * English), and at least three characters — or two where a character is a
 * word or a syllable (Han, kana, Hangul), as in 修正 ("fix"). Counted in code
 * points, so a character outside the basic plane counts once.
 */
export function namesSomething(title: string): boolean {
  if (!/\p{L}/u.test(title)) return false
  const length = [...title].length
  if (length >= MIN_CHAT_TITLE_LENGTH) return true
  return length === 2 && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(title)
}
