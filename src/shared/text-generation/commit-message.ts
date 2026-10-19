/**
 * The commit-message job, provider-agnostic: what the person's own agent CLI
 * is asked when the Git panel's "Write commit message" drafts one, the JSON
 * shape it answers in, and the guardrail the answer passes before it lands in
 * the commit message box. It is a draft: it lands in the box for the person to
 * edit, and nothing is committed until they press Commit.
 *
 * The input is exactly what the commit would hold — the index, because the
 * panel's checkboxes are the index and its Commit runs `git commit` on it —
 * cut to size, the repository's recent subjects as examples of its voice, the
 * branch, and the writing style the person chose (`writing-style.ts`).
 *
 * Pure: no I/O. The main process gathers the inputs; tests drive the rest.
 */

import { limitSection, namesSomething } from './chat-title'
import {
  isConventionalCommitSubject,
  writesConventionalCommits,
  writingStyleGuideSection,
  writingStyleRule,
  type TextGenerationWritingStyle,
} from './writing-style'

/** How much of each input the model sees. The summary says what changed; the patch says how. */
export const MAX_COMMIT_DIFF_STAT_CHARS = 8_000
export const MAX_COMMIT_PATCH_CHARS = 40_000
export const MAX_COMMIT_SUBJECTS_CHARS = 4_000
/** How many recent subjects are shown as examples: enough to read a voice from. */
export const MAX_COMMIT_SUBJECT_EXAMPLES = 20

/**
 * The subject length the prompt asks for: what a one-line log and a forge's
 * commit list show without cutting.
 */
export const PREFERRED_COMMIT_SUBJECT_LENGTH = 72
/**
 * The longest subject a draft may carry. Past the preferred length a subject
 * is long but still a subject; past this it is a paragraph on one line, and
 * it is cut at a word.
 */
export const MAX_COMMIT_SUBJECT_LENGTH = 100
/** The longest body a draft may carry. */
export const MAX_COMMIT_BODY_LENGTH = 8_000

const MAX_BRANCH_NAME_LENGTH = 200

/** The JSON Schema every backend is asked to satisfy. */
export const COMMIT_MESSAGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
  additionalProperties: false,
} as const

export type CommitMessageInput = {
  /** The branch the commit lands on; null on a detached HEAD. */
  branch: string | null
  /** `git diff --cached --stat`. */
  diffStat: string
  /** `git diff --cached`. */
  patch: string
  /** The repository's recent commit subjects, newest first. */
  recentSubjects: readonly string[]
  /** The repository's history follows Conventional Commits. */
  conventionalCommits: boolean
  style: TextGenerationWritingStyle
}

/** The drafted message: `subject`, a blank line and `body`, or the subject alone when there is no body. */
export type CommitMessageText = { subject: string; body: string; message: string }

/** Whether this draft must be a Conventional Commit: what the prompt asks for and what the reader holds it to. */
export function commitMessageIsConventional(input: Pick<CommitMessageInput, 'conventionalCommits' | 'style'>): boolean {
  return writesConventionalCommits(input.style, input.conventionalCommits)
}

/**
 * The full prompt. Instructions first, so a diff or a commit subject carrying
 * instructions reads as quoted material; the person's style guide, when they
 * wrote one, straight after them and fenced off from them.
 */
export function buildCommitMessagePrompt(input: CommitMessageInput): string {
  const branch = input.branch?.trim().slice(0, MAX_BRANCH_NAME_LENGTH)
  const rules = [
    branch
      ? `Write the commit message for the staged changes below, which are committed on the branch "${branch}".`
      : 'Write the commit message for the staged changes below.',
    'Return JSON with exactly two keys: subject and body.',
    '',
    'Rules:',
    `- The subject is one line of at most ${PREFERRED_COMMIT_SUBJECT_LENGTH} characters that says what the change does, with no trailing full stop.`,
    writingStyleRule(input.style, input.conventionalCommits, {
      line: 'subject',
      examples:
        'recent commit subjects below (their tense, capitalisation and any prefix); with none, use the imperative',
    }),
    '- The body is optional: leave it empty when the subject says enough. Otherwise say what changed and why in short plain paragraphs, with lines under 72 characters.',
    '- Describe only what the diff shows. Do not invent issues, tests or results.',
    '- Plain text: no markdown headings, no code fences, no quotes around the subject, no preamble, no sign-off, and no trailers such as Co-authored-by.',
  ]
  const guide = writingStyleGuideSection(input.style)
  const subjects = input.recentSubjects
    .map((subject) => subject.trim())
    .filter(Boolean)
    .slice(0, MAX_COMMIT_SUBJECT_EXAMPLES)
    .join('\n')
  return [
    rules.join('\n'),
    ...(guide ? [guide] : []),
    `Recent commit subjects:\n${limitSection(subjects || '(none)', MAX_COMMIT_SUBJECTS_CHARS)}`,
    `Files changed:\n${limitSection(input.diffStat.trim() || '(none)', MAX_COMMIT_DIFF_STAT_CHARS)}`,
    `Diff:\n${limitSection(input.patch.trim() || '(not available: work from the files changed)', MAX_COMMIT_PATCH_CHARS)}`,
  ].join('\n\n')
}

/**
 * The subject and body out of whatever the backend handed back: an object
 * decoded from structured output, or text that may be that JSON serialised or
 * fenced. Null when there is no usable subject — which, when the draft must be
 * a Conventional Commit, includes a subject that is not one.
 */
export function readCommitMessageOutput(output: unknown, options: { conventional: boolean }): CommitMessageText | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const { subject, body } = output as { subject?: unknown; body?: unknown }
    return sanitizeCommitMessage(
      typeof subject === 'string' ? subject : null,
      typeof body === 'string' ? body : '',
      options,
    )
  }
  if (typeof output !== 'string') return null
  const text = output.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  for (const candidate of [text, fenced, start !== -1 && end > start ? text.slice(start, end + 1) : null]) {
    if (!candidate) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return readCommitMessageOutput(parsed, options)
    } catch {
      // not JSON; try the next shape
    }
  }
  return null
}

const QUOTES = /^['"`“”‘’]+|['"`“”‘’]+$/g
const TRAILER = /^(?:co-authored-by|signed-off-by|reviewed-by|generated-by):/i

/**
 * One bounded subject line and a trimmed body, or null without a subject worth
 * showing.
 *
 * A subject the model spread over several lines keeps its first line, and the
 * rest becomes the body when the body is empty: that is what a person meant
 * who typed a message into one field. Under Conventional Commits a subject
 * that is not one is refused, never repaired into one, because the repair
 * would mean choosing its type — `chore` for a fix — and a draft that guessed
 * wrong is worse than no draft: the person keeps what they had and is told
 * why. The one repair made is spelling a recognised type in lower case
 * (`Fix:` to `fix:`) and the space after its colon, which changes nothing a
 * reader could disagree with.
 */
export function sanitizeCommitMessage(
  subject: string | null,
  body: string,
  options: { conventional: boolean },
): CommitMessageText | null {
  if (typeof subject !== 'string') return null
  const lines = unfence(subject)
    .split(/\r?\n/)
    .map((line) => line.trim())
  const first = lines.findIndex(Boolean)
  if (first === -1) return null
  let line = lines[first]
    .replace(/^subject:\s*/i, '')
    .replace(QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (options.conventional) line = spellConventionalType(line)
  if (line.length > MAX_COMMIT_SUBJECT_LENGTH) line = cutAtWord(line, MAX_COMMIT_SUBJECT_LENGTH)
  line = line.replace(/[\s.,;:]+$/, '')
  // Any script's letters: a subject written in Japanese or Greek is a subject.
  if (!namesSomething(line)) return null
  if (options.conventional && !isConventionalCommitSubject(line)) return null

  const spilled = lines
    .slice(first + 1)
    .join('\n')
    .trim()
  const kept = unfence(body).trim() || spilled
  const bodyLines = kept.split(/\r?\n/).map((entry) => entry.trimEnd())
  // A body that opens by repeating the subject says it twice in the log.
  if (bodyLines[0]?.trim().replace(/\.$/, '') === line) bodyLines.shift()
  const cleaned = bodyLines
    .filter((entry) => !TRAILER.test(entry.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const cleanBody = sliceWhole(cleaned, MAX_COMMIT_BODY_LENGTH).trimEnd()
  return { subject: line, body: cleanBody, message: cleanBody ? `${line}\n\n${cleanBody}` : line }
}

/** The text inside a code fence that wraps the whole value, or the value as it came. */
function unfence(text: string): string {
  const fenced = /^\s*```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/.exec(text)
  return fenced ? fenced[1] : text
}

function spellConventionalType(line: string): string {
  const match = /^([A-Za-z]+)(\([^)]+\))?(!)?:\s*(\S.*)$/.exec(line)
  if (!match) return line
  const [, type, scope = '', bang = '', description] = match
  const lower = type.toLowerCase()
  if (!isConventionalCommitSubject(`${lower}: x`)) return line
  return `${lower}${scope}${bang}: ${description}`
}

/**
 * The first `max` UTF-16 units of `text`, one fewer when the cut would split a
 * surrogate pair: half an emoji is not a character, and git stores it as U+FFFD.
 */
function sliceWhole(text: string, max: number): string {
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** Cut to `max` at the last word boundary that keeps most of the line, else at `max`. */
function cutAtWord(line: string, max: number): string {
  const cut = sliceWhole(line, max)
  const space = cut.lastIndexOf(' ')
  return (space >= max * 0.6 ? cut.slice(0, space) : cut).trimEnd()
}
