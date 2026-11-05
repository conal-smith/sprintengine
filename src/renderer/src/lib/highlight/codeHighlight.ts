import { createHighlighterCore, type HighlighterCore, type GrammarState, type ThemedToken } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

const languages = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  tex: () => import('shiki/langs/tex.mjs'),
} as const
type Language = keyof typeof languages
const aliases: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  py: 'python',
  md: 'markdown',
  rs: 'rust',
  kt: 'kotlin',
  'c++': 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  ps1: 'powershell',
  gql: 'graphql',
  docker: 'dockerfile',
  make: 'makefile',
}
export function normalizeCodeLanguage(language = ''): Language | null {
  const name = language.toLowerCase().trim()
  const normalized = aliases[name] ?? name
  return Object.hasOwn(languages, normalized) ? (normalized as Language) : null
}

const THEME = 'semantic-code'
export const HIGHLIGHT_LINE_LIMIT = 2000
let highlighter: Promise<HighlighterCore> | undefined
const loads = new Map<string, Promise<HighlighterCore>>()
export function loadCodeLanguage(language: Language): Promise<HighlighterCore> {
  let promise = loads.get(language)
  if (promise) return promise
  highlighter ??= createHighlighterCore({
    themes: [
      {
        name: THEME,
        fg: 'var(--sem-syntax-foreground)',
        bg: 'var(--sem-color-bg-surface-raised)',
        settings: [
          { scope: 'comment', settings: { foreground: 'var(--sem-syntax-comment)' } },
          { scope: ['keyword', 'storage'], settings: { foreground: 'var(--sem-syntax-keyword)' } },
          { scope: 'string', settings: { foreground: 'var(--sem-syntax-string)' } },
          { scope: ['constant.numeric', 'constant.language'], settings: { foreground: 'var(--sem-syntax-number)' } },
          {
            scope: ['entity.name.function', 'support.function'],
            settings: { foreground: 'var(--sem-syntax-function)' },
          },
          { scope: ['entity.name.type', 'support.type'], settings: { foreground: 'var(--sem-syntax-type)' } },
        ],
      },
    ],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })
  promise = highlighter.then(async (engine) => {
    await engine.loadLanguage(languages[language])
    return engine
  })
  loads.set(language, promise)
  return promise
}

export type CodeLine = { text: string; tokens: ThemedToken[] }
const settled = new Map<string, CodeLine[]>()
// Bound retained source as well as entry count: a small number of giant
// plain-text tails must not pin an entire transcript in the grammar cache.
const MAX_CACHED_SOURCE = 2_000_000
let cachedSourceSize = 0
function cacheKey(language: string, code: string): string {
  return `${language}\0${code}`
}
export function cachedCodeLines(language: string, code: string): CodeLine[] | undefined {
  const key = cacheKey(language, code)
  const value = settled.get(key)
  if (value) {
    settled.delete(key)
    settled.set(key, value)
  }
  return value
}

/** One tokenizer belongs to one block; only newly completed lines consume grammar work. */
export class IncrementalCodeTokenizer {
  private source = ''
  private lines: CodeLine[] = []
  private state: GrammarState | undefined
  constructor(
    private engine: HighlighterCore,
    private language: Language,
  ) {}

  update(code: string, complete: boolean): CodeLine[] {
    if (!code.startsWith(this.source)) {
      this.source = ''
      this.lines = []
      this.state = undefined
    }
    const remaining = code.slice(this.source.length)
    const chunks = remaining.split('\n')
    const finishedCount = complete ? chunks.length : chunks.length - 1
    const result = [...this.lines]
    for (let index = 0; index < finishedCount; index += 1) {
      const text = chunks[index] ?? ''
      const line: CodeLine = { text, tokens: [{ content: text, offset: 0 }] }
      if (result.length < HIGHLIGHT_LINE_LIMIT) {
        const tokens = this.engine.codeToTokensBase(text, {
          lang: this.language,
          theme: THEME,
          grammarState: this.state,
          tokenizeTimeLimit: 50,
        })
        line.tokens = tokens[0] ?? line.tokens
        if (index < chunks.length - 1) this.state = this.engine.getLastGrammarState(tokens)
      }
      result.push(line)
      // The final unterminated line is deliberately not committed to the
      // streaming state. A subsequent token may still extend that line.
      if (index < chunks.length - 1) {
        this.lines.push(line)
        this.source += `${text}\n`
      }
    }
    if (!complete) result.push({ text: chunks.at(-1) ?? '', tokens: [{ content: chunks.at(-1) ?? '', offset: 0 }] })
    if (complete) {
      const key = cacheKey(this.language, code)
      if (key.length <= MAX_CACHED_SOURCE) {
        if (settled.delete(key)) cachedSourceSize -= key.length
        settled.set(key, result)
        cachedSourceSize += key.length
        while (settled.size > 240 || cachedSourceSize > MAX_CACHED_SOURCE) {
          const oldest = settled.keys().next().value!
          settled.delete(oldest)
          cachedSourceSize -= oldest.length
        }
      }
    }
    return result
  }
}
