/**
 * Derive a workspace title from the first prompt a user actually sent.
 *
 * A new chat opens as "Chat 44" and stays that way, so a sidebar of forty of
 * them says nothing about what any of them was for. This module turns the first
 * real prompt into a few words that do.
 *
 * The summariser is a LOCAL HEURISTIC by deliberate choice, not a model call:
 * it has to work for every CLI, offline, with no provider configured and no
 * per-chat API spend. The cost is quality — a rambling dictated prompt titles
 * worse than a model would. That trade is contained here: the capture pipeline,
 * the once-only freeze, and the tab hover all treat this as an opaque
 * `string | null`, so swapping in a model-backed summariser later replaces this
 * function and touches nothing else.
 *
 * Pure: no I/O, no Electron, no DOM. Imported by both main and renderer.
 */

/**
 * Name stems the APP mints for a fresh chat, never a person. The sidebar's New
 * chat button names a workspace "Chat" / "Chat 63" (a per-folder ordinal); a
 * headless create names it after its layout template ("Solo 12", "New chat 3").
 */
const DEFAULT_WORKSPACE_NAME_STEMS = ['chat', 'new chat']

/**
 * True when `name` is one the app minted rather than one a person chose: the
 * stem alone or the stem followed by an ordinal ("Chat", "Chat 63", "Solo 4").
 * `templateName` adds the layout template's own stem, since a headless create
 * numbers off that.
 *
 * This is THE test for "is this workspace still a candidate for auto-titling".
 * It has to be a shape test, not an equality test against whatever ordinal the
 * caller would have minted: the New chat button numbers per folder while the
 * store numbers globally, and comparing the two locked every new chat at birth
 * so the first prompt never renamed anything.
 */
export function isDefaultWorkspaceName(name: string, templateName?: string | null): boolean {
  const trimmed = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (!trimmed) return false
  const stems = [...DEFAULT_WORKSPACE_NAME_STEMS]
  const template = typeof templateName === 'string' ? templateName.trim().toLowerCase() : ''
  if (template) stems.push(template)
  return stems.some((stem) => trimmed === stem || new RegExp(`^${escapeRegExp(stem)} \\d+$`).test(trimmed))
}

/**
 * The name New chat gives a chat in a folder: "Chat", then "Chat 2", "Chat 3"
 * and on, the first that none of the folder's workspaces holds. A shape
 * `isDefaultWorkspaceName` reads as app-minted, so the first prompt names it.
 */
export function nextNewChatName(namesInFolder: Iterable<string>): string {
  const taken = new Set(Array.from(namesInFolder, (name) => name.trim().toLowerCase()))
  if (!taken.has('chat')) return 'Chat'
  for (let index = 2; index < 1000; index += 1) {
    const name = `Chat ${index}`
    if (!taken.has(name.toLowerCase())) return name
  }
  return `Chat ${Date.now()}`
}

/**
 * Hard cap on a derived title. Sized to the sidebar row, which truncates around
 * here anyway — a longer title buys no information, only an ellipsis.
 */
export const MAX_WORKSPACE_TITLE_LENGTH = 42

/** Word cap applied before the character cap. Titles read as labels, not lines. */
const MAX_TITLE_WORDS = 6

/**
 * Below this many characters the result is noise rather than a title (a bare
 * "yes", a stray token left after stripping), so it is rejected and the caller
 * waits for the next prompt.
 */
const MIN_TITLE_LENGTH = 3

/**
 * Openers that carry no topic. Stripped from the FRONT of the prompt, repeatedly
 * (dictated prompts stack them: "so right now basically I want you to ...").
 *
 * Ordered longest-first within the matcher below so "i want you to" wins over
 * "i" — a shorter alternative matching first would strip one word and strand the
 * rest of the filler in the title.
 */
const LEADING_FILLER = [
  'i was wondering if you could',
  'i was wondering whether you could',
  "i'd like you to",
  'id like you to',
  'i would like you to',
  'i want you to',
  'i need you to',
  'i want to',
  'i need to',
  'we need to',
  'we should',
  'you should',
  'can you please',
  'could you please',
  'would you please',
  'can you',
  'could you',
  'would you',
  'please can you',
  'help me',
  'lets',
  "let's",
  'right now',
  'at the moment',
  'currently',
  'basically',
  'actually',
  'essentially',
  'please',
  'hey there',
  'hey',
  'hi there',
  'hi',
  'hello',
  'ok so',
  'okay so',
  'ok',
  'okay',
  'so',
  'well',
  'um',
  'uh',
  'just',
]

// The trailing group also matches end-of-input, so a prompt that is NOTHING but
// filler ("please", "ok so") strips to empty and is rejected — rather than
// surviving as a title because it had no separator after it.
const LEADING_FILLER_PATTERN = new RegExp(
  `^(?:${LEADING_FILLER.map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|')})(?:[\\s,:;-]+|$)`,
  'i',
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The shapes an app-injected fragment takes inside a prompt, named once so the
 * two consumers cannot drift apart. `stripInjectedFragments` deletes all of
 * them; the conversation peek (`src/main/conversation-peek/text.ts`) deletes
 * some and shortens the path-shaped ones to their names — the same tokens
 * have to be recognised identically on both routes or a peek would quote a path
 * the title already knew was not part of the sentence.
 *
 * Every pattern carries the `g` flag and is therefore stateful; use them only
 * with `String.replace` (which resets `lastIndex` on completion) or
 * `String.matchAll` (which iterates a clone), never with a bare `.test()`.
 */
export const INJECTED_FRAGMENT_PATTERNS = {
  /** Fenced code and pasted blocks: their contents would supply plausible-looking words. */
  fencedBlock: /```[\s\S]*?```/g,
  /** Inline code spans. */
  inlineCode: /`[^`\n]*`/g,
  /**
   * A slash-command invocation, wherever it sits — a dropped skill pastes one at
   * the front, but a user can type one mid-sentence.
   */
  slashCommand: /(?:^|\s)\/[a-z0-9][a-z0-9._-]*/gi,
  /** @-mentions of files and agents. */
  mention: /(?:^|\s)@[^\s]+/g,
  /** URLs. */
  url: /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  /**
   * Path-shaped tokens that announce themselves with a leading `/`, `./`, `../`
   * or `~/`: absolute paths, repo-relative paths, dropped directories.
   */
  explicitPath: /(?:^|\s)~?\.{0,2}\/\S+/g,
  /** Path-shaped tokens with no leading marker ("src/main/app.ts"). */
  barePath: /(?:^|\s)[\w.-]+\/[\w./-]+/g,
  /** A bare commit hash pasted by a commit drop. */
  commitHash: /(?:^|\s)[0-9a-f]{7,64}(?=\s|$)/gi,
  /**
   * Placeholders Claude Code substitutes for a pasted image inside the
   * person's own text (`[Image #26] What happened?`) and the companion line it
   * writes for a dropped screenshot. A prompt that is only a pasted picture
   * reduces to nothing, so the chat keeps its name until a prompt with words.
   */
  imagePlaceholder: /\[Image(?:\s*#\d+|:[^\]\n]{0,200})\]/g,
} as const

/**
 * Strip the fragments the APP pastes into a terminal, so a title is never
 * derived from the studio's own injection instead of the person's request.
 *
 * A drop onto a terminal writes a skill invocation, an @-mention, a file path,
 * or a commit hash via bracketed paste (see `src/renderer/src/utils/terminalDrop.ts`);
 * the user then hits Enter, and the hook reports the combined text as their
 * prompt. Removing these leaves whatever the person typed alongside — and when
 * they typed nothing, leaves an empty string, which `deriveWorkspaceTitle`
 * rejects so the next prompt gets the chance instead.
 *
 * Prompt-fallback CLIs wrap the host-context document AFTER the request
 * (`wrapHostContextForPrompt`), so the first sentence this function reads is
 * still the person's words. Argv/env CLIs never put that document in the prompt
 * field at all.
 */
export function stripInjectedFragments(prompt: string): string {
  const patterns = INJECTED_FRAGMENT_PATTERNS
  return prompt
    .replace(patterns.fencedBlock, ' ')
    .replace(patterns.inlineCode, ' ')
    .replace(patterns.imagePlaceholder, ' ')
    .replace(patterns.slashCommand, ' ')
    .replace(patterns.mention, ' ')
    .replace(patterns.url, ' ')
    .replace(patterns.explicitPath, ' ')
    .replace(patterns.barePath, ' ')
    .replace(patterns.commitHash, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A few words naming what `prompt` is about, or `null` when the prompt carries
 * no usable topic — an empty prompt, one that was nothing but an app-injected
 * skill invocation or file drop, or one that reduces to fewer than
 * {@link MIN_TITLE_LENGTH} characters after filler is removed.
 *
 * `null` means "not a title", NOT "no title ever": the caller leaves the
 * workspace on its default name and tries again on the next prompt.
 */
export function deriveWorkspaceTitle(prompt: string): string | null {
  if (typeof prompt !== 'string') return null

  const stripped = stripInjectedFragments(prompt)
  if (!stripped) return null

  // First sentence only. A prompt's opening sentence is the request; what
  // follows is qualification, and folding it in makes the title longer without
  // making it more distinguishing.
  const firstSentence = stripped.split(/(?<=[.!?])\s+|\n+/)[0]?.trim() ?? ''
  if (!firstSentence) return null

  // Filler strips repeatedly: dictated prompts stack two or three openers before
  // reaching the topic.
  let core = firstSentence
  for (let pass = 0; pass < 4; pass += 1) {
    const next = core.replace(LEADING_FILLER_PATTERN, '')
    if (next === core) break
    core = next
  }
  core = core.trim()
  if (!core) return null

  const words = core.split(/\s+/).filter(Boolean).slice(0, MAX_TITLE_WORDS)
  if (words.length === 0) return null

  let title = words.join(' ')
  if (title.length > MAX_WORKSPACE_TITLE_LENGTH) {
    // Break on a word boundary rather than mid-word; fall back to a hard cut
    // when the very first word is longer than the cap.
    const cut = title.slice(0, MAX_WORKSPACE_TITLE_LENGTH)
    const lastSpace = cut.lastIndexOf(' ')
    title = lastSpace > MIN_TITLE_LENGTH ? cut.slice(0, lastSpace) : cut
  }

  // Trailing punctuation left by the word/character caps, and the commas that
  // survive a clause break.
  title = title.replace(/[\s,;:.\-–—]+$/, '').trim()

  // A title needs a letter in it: a residue of digits and symbols is not a name.
  if (title.length < MIN_TITLE_LENGTH || !/[a-z]/i.test(title)) return null

  // Sentence case only — the first character is lifted, and the rest is left
  // exactly as typed so identifiers survive ("git stash", "OAuth", "useEffect").
  // Title-casing every word would corrupt them.
  return title.charAt(0).toUpperCase() + title.slice(1)
}
