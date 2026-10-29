// What a code block's header says and offers, decided from the fence alone. Pure,
// so a transcript of a hundred blocks can call it per render, and so the rules —
// which tag reads as which language, what counts as a filename, which lines of a
// shell block are the command — are tested without mounting anything.

import { fileTypeKind, type FileTypeKind } from './FileTypeGlyph'

type LanguageEntry = {
  /** The name a person calls it, not the tag a fence uses. */
  name: string
  /** The file-type glyph for it, where the vocabulary has one. */
  kind?: FileTypeKind
  /** The tag the highlighter knows it by, where that differs from the fence's. */
  highlight?: string
}

const TYPESCRIPT: LanguageEntry = { name: 'TypeScript', kind: 'typescript' }
const JAVASCRIPT: LanguageEntry = { name: 'JavaScript', kind: 'javascript' }
const JSON_LANGUAGE: LanguageEntry = { name: 'JSON', kind: 'json', highlight: 'json' }
const SHELL: LanguageEntry = { name: 'Shell', kind: 'shell' }
const PLAIN_TEXT: LanguageEntry = { name: 'Plain text' }

// Keyed by the lowercased fence tag. The highlighter's own aliases (ts, sh, yml,
// …) are listed too, because the label has to name them the same way the
// highlighter colours them; `highlight` is set only for the tags the highlighter
// would otherwise not recognise, so a `.mjs` read or a ```jsonc block still gets
// colour.
const LANGUAGES: Record<string, LanguageEntry> = {
  typescript: TYPESCRIPT,
  ts: TYPESCRIPT,
  mts: { ...TYPESCRIPT, highlight: 'typescript' },
  cts: { ...TYPESCRIPT, highlight: 'typescript' },
  tsx: { name: 'TSX', kind: 'react' },
  javascript: JAVASCRIPT,
  js: JAVASCRIPT,
  mjs: { ...JAVASCRIPT, highlight: 'javascript' },
  cjs: { ...JAVASCRIPT, highlight: 'javascript' },
  jsx: { name: 'JSX', kind: 'react' },
  json: JSON_LANGUAGE,
  jsonc: JSON_LANGUAGE,
  json5: JSON_LANGUAGE,
  bash: { name: 'Bash', kind: 'shell' },
  sh: SHELL,
  shell: SHELL,
  shellscript: { ...SHELL, highlight: 'bash' },
  zsh: { name: 'Zsh', kind: 'shell' },
  fish: { name: 'Fish', kind: 'shell' },
  // A transcript of a session: prompts, commands and their output interleaved.
  // Left uncoloured, because a shell grammar reads the output as commands.
  console: { name: 'Terminal', kind: 'shell' },
  'shell-session': { name: 'Terminal', kind: 'shell' },
  powershell: { name: 'PowerShell', kind: 'shell' },
  ps1: { name: 'PowerShell', kind: 'shell' },
  python: { name: 'Python', kind: 'python' },
  py: { name: 'Python', kind: 'python' },
  ruby: { name: 'Ruby' },
  rb: { name: 'Ruby' },
  go: { name: 'Go', kind: 'go' },
  golang: { name: 'Go', kind: 'go', highlight: 'go' },
  rust: { name: 'Rust', kind: 'rust' },
  rs: { name: 'Rust', kind: 'rust' },
  java: { name: 'Java', kind: 'java' },
  kotlin: { name: 'Kotlin' },
  kt: { name: 'Kotlin' },
  swift: { name: 'Swift' },
  c: { name: 'C' },
  cpp: { name: 'C++' },
  'c++': { name: 'C++' },
  csharp: { name: 'C#' },
  cs: { name: 'C#' },
  php: { name: 'PHP' },
  yaml: { name: 'YAML', kind: 'yaml' },
  yml: { name: 'YAML', kind: 'yaml' },
  toml: { name: 'TOML', kind: 'config' },
  ini: { name: 'INI', kind: 'config' },
  xml: { name: 'XML', kind: 'config' },
  html: { name: 'HTML', kind: 'html' },
  htm: { name: 'HTML', kind: 'html', highlight: 'html' },
  css: { name: 'CSS', kind: 'css' },
  scss: { name: 'SCSS', kind: 'css' },
  markdown: { name: 'Markdown', kind: 'markdown' },
  md: { name: 'Markdown', kind: 'markdown' },
  mdx: { name: 'MDX', kind: 'markdown' },
  diff: { name: 'Diff' },
  patch: { name: 'Diff', highlight: 'diff' },
  sql: { name: 'SQL' },
  graphql: { name: 'GraphQL' },
  gql: { name: 'GraphQL' },
  dockerfile: { name: 'Dockerfile', kind: 'config' },
  docker: { name: 'Dockerfile', kind: 'config' },
  makefile: { name: 'Makefile', kind: 'config' },
  make: { name: 'Makefile', kind: 'config' },
  mermaid: { name: 'Mermaid' },
  mmd: { name: 'Mermaid' },
  // A chart or table a reply draws, written as HTML: its source reads as HTML.
  visual: { name: 'Visual', kind: 'html', highlight: 'html' },
  'studio-visual': { name: 'Visual', kind: 'html', highlight: 'html' },
  math: { name: 'Math' },
  latex: { name: 'LaTeX' },
  tex: { name: 'TeX' },
  text: PLAIN_TEXT,
  txt: PLAIN_TEXT,
  plain: PLAIN_TEXT,
  plaintext: PLAIN_TEXT,
}

/** What the header shows on its left, and what the block is coloured as. */
export type CodeBlockTitle = {
  /** The visible label: a filename when one is known, else the language's name. */
  label: string
  /** Set when `label` is a file, so it can be set in mono and truncated from a tooltip. */
  filename?: string
  /** The language's name, even when the label is a filename — the block's accessible name uses it. */
  languageName: string
  /** The glyph beside the label; absent when the vocabulary has none for it. */
  kind?: FileTypeKind
  /** The tag to hand the highlighter; empty for a block it should leave plain. */
  highlightLanguage: string
  /**
   * The language as an attribute value for code outside this module that reads
   * the rendered block (the selection-to-markdown copy rebuilds the fence from
   * it): the fence's tag, lowercased, or empty when the fence had none.
   */
  languageTag: string
}

// A path-looking token: something with a slash, or a name with an extension.
// `{1-3}` line ranges and `key=value` pairs are fence meta of other kinds.
const PATH_LIKE = /^(?:[\w@~.-]+\/)*[\w@~.-]*[\w-]\.[A-Za-z0-9]+$|^(?:[\w@~.-]+\/)+[\w@~.-]+$/

function looksLikePath(token: string): boolean {
  return PATH_LIKE.test(token) && !/^\d/.test(token)
}

/**
 * The filename a fence's info string names after its language, if any. The forms
 * agents actually write: `title="src/app.ts"` (and single quotes), `file=` /
 * `filename=` / `path=`, and a bare path token (```ts src/app.ts). A `title`
 * that is not a path — ```bash title="Install" — is still returned: it is the
 * author's caption for the block, and the header shows it the same way.
 */
export function filenameFromFenceMeta(meta: string | undefined | null): string | undefined {
  if (!meta) return undefined
  const keyed = meta.match(/(?:^|\s)(?:title|file|filename|path)=(?:"([^"]+)"|'([^']+)'|([^\s"']+))/)
  if (keyed) return (keyed[1] ?? keyed[2] ?? keyed[3]).trim() || undefined
  return meta
    .split(/\s+/)
    .map((token) => token.trim())
    .find((token) => token && !token.includes('=') && looksLikePath(token))
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase()
}

/**
 * The header's left side. A fence tag that is itself a path (```src/app.ts,
 * which some agents write) is read as the filename, and the language comes
 * from its extension; so does a block that has a filename and no language.
 * An unknown tag is shown as written rather than as "Plain text": the author
 * said what it is, and the label is the one place that survives a missing
 * grammar.
 */
export function codeBlockTitle(language: string | undefined, filename: string | undefined): CodeBlockTitle {
  let tag = (language ?? '').trim()
  let file = filename?.trim() || undefined
  if (tag && !LANGUAGES[tag.toLowerCase()] && looksLikePath(tag)) {
    file ??= tag
    tag = ''
  }
  if (!tag && file) tag = extensionOf(file)
  const entry = tag ? LANGUAGES[tag.toLowerCase()] : PLAIN_TEXT
  const languageName = entry?.name ?? (tag || PLAIN_TEXT.name)
  const fileKind = file && /[./]/.test(file) ? fileTypeKind(file) : undefined
  const kind = fileKind && fileKind !== 'generic' ? fileKind : entry?.kind
  return {
    label: file ?? languageName,
    filename: file,
    languageName,
    kind,
    highlightLanguage: entry?.highlight ?? (entry === PLAIN_TEXT ? '' : tag),
    languageTag: tag.toLowerCase(),
  }
}

// The shells a pasted block is written for. `fish` and PowerShell are left out
// on purpose: their syntax is not the login shell's, and a block pasted into the
// wrong one fails at the prompt in ways that look like the block's fault.
const PASTABLE_SHELLS = new Set(['bash', 'sh', 'zsh', 'shell', 'shellscript', 'console', 'shell-session'])

export function isShellLanguage(language: string | undefined): boolean {
  return PASTABLE_SHELLS.has((language ?? '').trim().toLowerCase())
}

// `$ ` and `% ` are the prompts docs and agents put before a command (bash's and
// zsh's defaults), at the start of the line. An indented one is output: curl's
// progress table opens `  % Total`. `#` is left alone: in a shell block it is far
// more often a comment than a root prompt, and stripping it would uncomment a
// line.
const PROMPT = /^[$%] /

// Where a command starts a here-document, the word that ends it: `<<EOF`,
// `<<-EOF` (tabs before the terminator allowed), `<<'EOF'`, `<<"EOF"` — and
// not a here-string, `<<<`, which ends on its own line.
const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/

// Blocks written as a session: prompts, commands and their output interleaved.
// Taken as written they would paste the output too, so they offer a paste only
// when they mark which lines are commands.
const SESSION_LANGUAGES = new Set(['console', 'shell-session'])

/**
 * The commands in a block that shows its prompts. When no line starts with a
 * prompt the block is taken as written. When some do, only those lines are the
 * command — the rest is output the author pasted beneath them — plus the lines a
 * trailing `\` continues onto and the body of a here-document the command
 * opens, neither of which carries a prompt of its own.
 */
export function stripShellPrompts(code: string): string {
  const lines = code.split('\n')
  if (!lines.some((line) => PROMPT.test(line))) return code
  const commands: string[] = []
  let continues = false
  let heredoc: { word: string; tabs: boolean } | null = null
  for (const line of lines) {
    if (heredoc) {
      commands.push(line)
      if ((heredoc.tabs ? line.replace(/^\t+/u, '') : line) === heredoc.word) heredoc = null
      continue
    }
    const prompted = PROMPT.test(line)
    if (!prompted && !continues) continue
    const command = prompted ? line.replace(PROMPT, '') : line
    commands.push(command)
    continues = command.trimEnd().endsWith('\\')
    const opens = HEREDOC.exec(command)
    if (opens) heredoc = { word: opens[3], tabs: opens[1] === '-' }
  }
  return commands.join('\n')
}

/**
 * What a shell block would put at a terminal's prompt, or null when it should
 * not be offered. Only a settled block: a streaming one may still be half a
 * command. Only one that ends where it looks like it ends — a trailing `\`
 * would leave the shell waiting for a line the block never had. Only a session
 * block that marks its commands with prompts, since the rest of it is output.
 * And never one carrying a control or invisible format character (a bidi
 * override, a zero-width joiner), which can make the text on screen differ
 * from what the shell would be handed.
 */
export function pastableShellCommand(code: string, language: string | undefined, streaming = false): string | null {
  if (streaming || !isShellLanguage(language)) return null
  if (
    SESSION_LANGUAGES.has((language ?? '').trim().toLowerCase()) &&
    !code.split('\n').some((line) => PROMPT.test(line))
  )
    return null
  const command = stripShellPrompts(code).trim()
  if (!command || command.endsWith('\\')) return null
  if (/[\p{Cc}\p{Cf}]/u.test(command.replace(/[\n\t]/gu, ''))) return null
  return command
}

/** Lines in a block's source, counted without splitting it — this runs on every streamed token. */
export function countLines(code: string): number {
  let lines = 1
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', index + 1)) lines += 1
  return lines
}
