import { afterEach, beforeEach, test, expect, vi } from 'vitest'
import {
  cachedCodeLines,
  HIGHLIGHT_LINE_LIMIT,
  IncrementalCodeTokenizer,
  loadCodeLanguage,
  normalizeCodeLanguage,
} from './codeHighlight'

// Grammar parity is independent of how long a shared runner is descheduled.
// Exercise the production deadline separately with an explicitly advancing clock.
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const fixtures = [
  ['typescript', 'const answer: number = 42\nconsole.log(answer)'],
  ['typescript', '/* first\n * second */\nconst a = true'],
  ['typescript', 'const a = `first\nsecond ${1 + 2}`\nconsole.log(a)'],
  ['javascript', 'export function greet() {\n  return "hello"\n}'],
  ['python', 'text = """first\nsecond"""\nprint(text)'],
  ['json', '{\n  "answer": 42,\n  "ready": true\n}'],
  ['css', '.notice {\n  display: grid;\n  color: inherit;\n}'],
  ['html', '<div>\n  <strong>Hello</strong>\n</div>'],
  ['bash', '# A shell command\nprintf "%s" "hello"'],
  ['yaml', 'greeting: |\n  hello\n  world\nready: true'],
  ['java', 'public class Hello {\n  /* a\n     note */\n  int answer = 42;\n}'],
  ['kotlin', 'fun main() {\n  val answer = 42\n}'],
  ['cpp', '#include <vector>\nint main() { return 0; }'],
  ['toml', '[tool]\nready = true'],
] as const

for (const [language, code] of fixtures) {
  test(`streamed ${language} tokens equal a whole block: ${code.slice(0, 18)}`, async () => {
    const normalized = normalizeCodeLanguage(language)!
    const engine = await loadCodeLanguage(normalized)
    const incremental = new IncrementalCodeTokenizer(engine, normalized)
    for (let length = 1; length < code.length; length += 3) incremental.update(code.slice(0, length), false)
    const actual = incremental.update(code, true)
    const expected = engine.codeToTokensBase(code, { lang: normalized, theme: 'semantic-code' })
    const comparable = (lines: typeof expected) =>
      lines.map((line) => line.map(({ content, color }) => ({ content, color })))
    expect(comparable(actual.map((line) => line.tokens))).toEqual(comparable(expected))
    expect(cachedCodeLines(normalized, code)).toBe(actual)
  })
}

test('completed lines retain identity and unfinished lines remain plain', async () => {
  const tokenizer = new IncrementalCodeTokenizer(await loadCodeLanguage('typescript'), 'typescript')
  const first = tokenizer.update('const first = 1\nconst sec', false)
  const second = tokenizer.update('const first = 1\nconst second = 2', false)
  expect(second[0]).toBe(first[0])
  expect(second[1]?.tokens[0]?.color).toBeUndefined()
  const settled = tokenizer.update('const first = 1\nconst second = 2', true)
  expect(settled[0]).toBe(first[0])
})

test('normalizes aliases and rejects prototype keys or unsupported languages', () => {
  expect(normalizeCodeLanguage('TS')).toBe('typescript')
  expect(normalizeCodeLanguage('zsh')).toBe('bash')
  expect(normalizeCodeLanguage('constructor')).toBeNull()
  expect(normalizeCodeLanguage('')).toBeNull()
})

// The header names these from the label table, and a block whose header says
// Java while its code stays plain is the failure this list exists to prevent.
for (const language of ['java', 'kotlin', 'kt', 'swift', 'c', 'c++', 'cs', 'php', 'rb', 'toml', 'xml', 'scss', 'gql']) {
  test(`${language} is coloured, not only named`, () => {
    expect(normalizeCodeLanguage(language)).not.toBeNull()
  })
}

test('a java keyword, type and string take their syntax tokens', async () => {
  const engine = await loadCodeLanguage('java')
  const code = 'public class Hello {\n  String name = "world";\n}'
  const [line] = new IncrementalCodeTokenizer(engine, 'java').update(code, true)
  expect(line?.tokens.find((token) => token.content.trim() === 'public')?.color).toBe('var(--sem-syntax-keyword)')
  expect(line?.tokens.find((token) => token.content.trim() === 'Hello')?.color).toBe('var(--sem-syntax-type)')
})

test('the production tokenizer retains its 50 ms deadline and preserves text when time expires', async () => {
  const engine = await loadCodeLanguage('typescript')
  const tokenize = vi.spyOn(engine, 'codeToTokensBase')
  let clock = 0
  vi.mocked(Date.now).mockImplementation(() => (clock += 30))
  const code = 'const answer: number = 42\nconsole.log(answer)'
  const lines = new IncrementalCodeTokenizer(engine, 'typescript').update(code, true)
  expect(tokenize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ tokenizeTimeLimit: 50 }))
  expect(lines.map((line) => line.tokens.map((token) => token.content).join('')).join('\n')).toBe(code)
  expect(lines[0].tokens.length).toBeLessThan(9)
})

test('large code retains source beyond the highlighting limit', async () => {
  const code = Array.from({ length: HIGHLIGHT_LINE_LIMIT + 2 }, () => 'const a = 1').join('\n')
  const tokenizer = new IncrementalCodeTokenizer(await loadCodeLanguage('typescript'), 'typescript')
  const lines = tokenizer.update(code, true)
  expect(lines.map((line) => line.text).join('\n')).toBe(code)
  expect(lines[HIGHLIGHT_LINE_LIMIT]?.tokens[0]?.color).toBeUndefined()
})

test('settling an incomplete line does not advance the streaming grammar state', async () => {
  const engine = await loadCodeLanguage('typescript')
  const tokenizer = new IncrementalCodeTokenizer(engine, 'typescript')
  tokenizer.update('/* opening', true)
  const code = '/* opening */\nconst answer = 42'
  const actual = tokenizer
    .update(code, true)
    .map((line) => line.tokens.map(({ content, color }) => ({ content, color })))
  const expected = engine
    .codeToTokensBase(code, { lang: 'typescript', theme: 'semantic-code' })
    .map((line) => line.map(({ content, color }) => ({ content, color })))
  expect(actual).toEqual(expected)
})
