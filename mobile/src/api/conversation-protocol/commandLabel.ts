export type CommandKind =
  | 'run'
  | 'read'
  | 'search'
  | 'list'
  | 'edit'
  | 'write'
  | 'git'
  | 'test'
  | 'build'
  | 'install'
  | 'lint'
  | 'format'
  | 'network'
  | 'script'
export type CommandLabel = { label: string; program: string; kind: CommandKind; target?: string }

// `redirect` marks `>`, `2>`, `>&`, `<`, `<<` and the like: the word after one
// is where a stream goes, never an argument of the command.
type Token = { value: string; operator: boolean; redirect?: boolean }
const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])
const SETUP = new Set(['cd', 'pushd', 'export', 'set', 'source', '.', 'unset', 'ulimit', 'umask'])
// The shell's own grammar and no-op builtins, which are never the program that
// ran: "Ran if" or "Ran [" says nothing, so a command led by one is a command.
const SHELL_SYNTAX = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  '[',
  '[[',
  '((',
  'test',
  ':',
  'true',
  'false',
])
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl'])
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'ack'])
const LISTERS = new Set(['ls', 'tree', 'exa', 'eza'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'tsx', 'ts-node'])
// Package manager subcommands that are the manager's own, not package scripts.
const INSTALLS = new Set(['install', 'i', 'in', 'ci', 'add', 'clean-install', 'isntall', 'update', 'up', 'upgrade'])
const REMOVALS = new Set(['uninstall', 'remove', 'rm', 'un', 'r', 'unlink'])
const BUILTINS = new Set(['exec', 'x', 'dlx', 'init', 'create', 'publish', 'pack', 'link', 'outdated', 'audit'])

const REDIRECTS = new Set(['>', '>>', '<', '<<', '<<<', '>&', '<&', '>|', '<>', '&>', '&>>'])

function tokenize(input: string): Token[] {
  const result: Token[] = []
  let word = ''
  let quoted = false
  // `ansi` is bash's $'…', whose backslash escapes are expanded.
  let quote: "'" | '"' | 'ansi' | null = null
  const push = () => {
    if (word || quoted) result.push({ value: word, operator: false })
    word = ''
    quoted = false
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quote === 'ansi') {
      if (char === "'") quote = null
      else if (char === '\\' && i + 1 < input.length) {
        const next = input[++i]
        word += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
      } else word += char
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && i + 1 < input.length) {
        word += input[++i]
      } else word += char
      continue
    }
    if (char === '\\' && i + 1 < input.length) {
      word += input[++i]
      continue
    }
    if (char === '$' && input[i + 1] === "'") {
      quote = 'ansi'
      i++
      quoted = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoted = true
      continue
    }
    if (/\s/u.test(char)) {
      push()
      if (char === '\n') result.push({ value: '\n', operator: true })
      continue
    }
    if (';&|<>'.includes(char)) {
      // A file descriptor written against its redirect (`2>`) belongs to it.
      const fd = (char === '<' || char === '>') && !quoted && /^\d+$/u.test(word) ? word : ''
      if (fd) word = ''
      push()
      let operator = char
      for (const candidate of ['&>>', '<<<', '&&', '||', '>>', '<<', '>&', '<&', '>|', '<>', '&>']) {
        if (input.startsWith(candidate, i)) {
          operator = candidate
          break
        }
      }
      i += operator.length - 1
      result.push({ value: fd + operator, operator: true, ...(REDIRECTS.has(operator) ? { redirect: true } : {}) })
      continue
    }
    word += char
  }
  push()
  return result
}

function basename(path: string): string {
  const name = path.split(/[\\/]/u).at(-1) ?? path
  return name || path
}

function programName(path: string): string {
  return basename(path).replace(/\.(?:exe|cmd|bat|sh|ps1)$/iu, '')
}

function shorten(value: string, max = 60): string {
  if (value.length <= max) return value
  const left = Math.ceil((max - 1) / 2)
  return `${value.slice(0, left)}…${value.slice(-(max - left - 1))}`
}

function labeled(label: string, program: string, kind: CommandKind, target?: string): CommandLabel {
  return { label: shorten(label), program, kind, ...(target ? { target } : {}) }
}

function inferScriptKind(script: string): CommandKind {
  if (/test|spec|check/u.test(script)) return 'test'
  if (/build|compile|bundle/u.test(script)) return 'build'
  if (/lint/u.test(script)) return 'lint'
  if (/format|prettier/u.test(script)) return 'format'
  return 'script'
}

// The command's own words: a redirect's target (`2>/dev/null`, `> out.txt`,
// `2>&1`, a heredoc's delimiter) is not an argument.
function commandWords(segment: Token[]): string[] {
  const words: string[] = []
  for (let index = 0; index < segment.length; index++) {
    const token = segment[index]
    if (token.redirect) {
      if (!segment[index + 1]?.operator) index++
    } else if (!token.operator) words.push(token.value)
  }
  return words
}

// Where standard output is sent to a file, if anywhere.
function stdoutTarget(tokens: Token[]): string | undefined {
  const index = tokens.findIndex(
    (token) => token.redirect && ['>', '>>', '1>', '1>>', '>|', '&>'].includes(token.value),
  )
  const target = index >= 0 ? tokens[index + 1] : undefined
  return target && !target.operator && target.value !== '/dev/null' ? target.value : undefined
}

function firstSegment(tokens: Token[]): Token[] {
  let current: Token[] = []
  const segments: Token[][] = []
  for (const token of tokens) {
    if (token.operator && SEPARATORS.has(token.value)) {
      if (current.length) segments.push(current)
      current = []
    } else current.push(token)
  }
  if (current.length) segments.push(current)
  return (
    segments.find((segment) => {
      const words = commandWords(segment)
      const first = words.find((word) => !/^[A-Za-z_][A-Za-z_0-9]*=/u.test(word))
      return first && !SETUP.has(programName(first))
    }) ?? []
  )
}

function stripWrappers(words: string[]): string[] {
  let args = words
  for (let loops = 0; loops < 12 && args.length; loops++) {
    const first = programName(args[0])
    if (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0])) {
      args = args.slice(1)
      continue
    }
    if (first === 'env') {
      args = afterLeadingOptions(args.slice(1), ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'])
      while (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0] ?? '')) args = args.slice(1)
      continue
    }
    if (['sudo', 'time', 'nohup', 'command', 'exec', 'caffeinate'].includes(first)) {
      args = args.slice(1)
      if (first === 'sudo')
        args = afterLeadingOptions(args, [
          '-u',
          '--user',
          '-g',
          '--group',
          '-h',
          '--host',
          '-p',
          '--prompt',
          '-C',
          '--close-from',
          '-T',
          '--command-timeout',
          '-R',
          '--chroot',
          '-D',
          '--chdir',
        ])
      else if (first === 'caffeinate') args = afterLeadingOptions(args, ['-t', '-w'])
      continue
    }
    if (first === 'nice') {
      args = args.slice(1)
      if (args[0] === '-n') args = args.slice(2)
      else if (args[0]?.startsWith('-')) args = args.slice(1)
      continue
    }
    if (first === 'timeout') {
      args = afterLeadingOptions(args.slice(1), ['-k', '--kill-after', '-s', '--signal']).slice(1)
      continue
    }
    if (first === 'arch') {
      args = args[1]?.startsWith('-') ? args.slice(2) : args.slice(1)
      continue
    }
    if (first === 'stdbuf') {
      args = afterLeadingOptions(args.slice(1), ['-i', '-o', '-e', '--input', '--output', '--error'])
      continue
    }
    break
  }
  return args
}

function afterLeadingOptions(args: string[], valueOptions: string[]): string[] {
  let index = 0
  while (args[index]?.startsWith('-')) {
    const flag = args[index++]
    if (flag === '--') break
    if (valueOptions.includes(flag)) index++
  }
  return args.slice(index)
}

function targetAfterOptions(args: string[], valueOptions: string[] = []): string[] {
  const targets: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') return [...targets, ...args.slice(index + 1)]
    if (valueOptions.includes(arg)) {
      index++
      continue
    }
    if (!arg.startsWith('-')) targets.push(arg)
  }
  return targets
}

function classify(
  words: string[],
  operators: Token[],
  depth: number,
  shell: 'posix' | 'powershell' | 'cmd',
): CommandLabel {
  const args = stripWrappers(words)
  if (!args.length) return labeled('Ran command', '', 'run')
  const program = programName(args[0])
  const lower = program.toLowerCase()
  // `name() { …; }` defines a function; nothing ran yet.
  if (SHELL_SYNTAX.has(lower) || program.endsWith('()')) return labeled('Ran command', '', 'run')
  if (depth < 3 && lower === 'eval' && args.length > 1)
    return labelCommandInner(args.slice(1).join(' '), depth + 1, shell)

  if (depth < 3 && ['bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh'].includes(lower)) {
    const flag = args.findIndex((arg) => ['-c', '-lc', '-Command', '-command'].includes(arg))
    if (flag >= 0 && args[flag + 1])
      return labelCommandInner(
        args[flag + 1],
        depth + 1,
        lower === 'pwsh' || lower === 'powershell' ? 'powershell' : shell,
      )
  }

  // A package runner's own options (`npx -y`, `uvx --from x`) come before the
  // tool it runs.
  let runnerArgs: string[] | undefined
  if (lower === 'npx' || lower === 'bunx')
    runnerArgs = afterLeadingOptions(args.slice(1), ['-p', '--package', '-c', '--call'])
  else if (lower === 'uvx') runnerArgs = afterLeadingOptions(args.slice(1), ['--from', '--with', '--python', '-p'])
  else if (lower === 'pipx' && args[1] === 'run') runnerArgs = afterLeadingOptions(args.slice(2), ['--spec'])
  else if (['pnpm', 'yarn'].includes(lower) && args[1] === 'dlx')
    runnerArgs = afterLeadingOptions(args.slice(2), ['-p', '--package'])
  // A package manager's `exec` runs a tool the same way; the tool is what ran.
  else if (
    (lower === 'npm' && (args[1] === 'exec' || args[1] === 'x')) ||
    (['pnpm', 'yarn'].includes(lower) && args[1] === 'exec') ||
    (lower === 'bun' && args[1] === 'x')
  )
    runnerArgs = afterLeadingOptions(args.slice(2), ['-p', '--package', '-c', '--call', '-w', '--workspace'])
  if (runnerArgs?.length) {
    const tool = runnerArgs[0].replace(/@[^@/]+$/u, '')
    return classify([tool, ...runnerArgs.slice(1)], operators, depth + 1, shell)
  }

  if (lower === 'bun' && /\.[A-Za-z0-9]+$/u.test(args[1] ?? '') && args[1] !== 'run') {
    return labeled(`Ran ${basename(args[1])}`, lower, 'script', args[1])
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(lower)) {
    const subcommand = args[1]
    const script = subcommand === 'run' || subcommand === 'run-script' ? args[2] : subcommand
    // Bare `yarn`, options and all, is yarn's install.
    const bareYarn = lower === 'yarn' && (!subcommand || subcommand.startsWith('-'))
    if (bareYarn || (subcommand && INSTALLS.has(subcommand))) {
      const packages = targetAfterOptions(args.slice(2), ['--filter', '-F', '-w', '--workspace'])
      return labeled(
        packages.length > 1 ? `Installed ${packages.length} packages` : `Installed ${packages[0] ?? 'dependencies'}`,
        lower,
        'install',
        packages[0],
      )
    }
    if (subcommand && REMOVALS.has(subcommand)) {
      const packages = targetAfterOptions(args.slice(2))
      return labeled(`Removed ${packages[0] ?? 'packages'}`, lower, 'install', packages[0])
    }
    if (script && (script !== subcommand || !BUILTINS.has(script))) {
      return labeled(`Ran ${lower} script ${script}`, lower, inferScriptKind(script), script)
    }
  }

  if (lower === 'git') {
    // Global options (`--no-pager`, `-C dir`, `--git-dir=…`) precede the subcommand.
    let i = 1
    while (i < args.length && args[i].startsWith('-')) {
      i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[i]) ? 2 : 1
    }
    return labeled(`git ${args[i] ?? 'command'}`, 'git', 'git', args[i])
  }

  if (['echo', 'printf'].includes(lower)) {
    const target = stdoutTarget(operators)
    if (target) return labeled(`Wrote ${basename(target)}`, lower, 'write', target)
  }

  if (INTERPRETERS.has(lower)) {
    const offset = lower === 'deno' && args[1] === 'run' ? 2 : 1
    if (args[offset] === '-e' || args[offset] === '-c') return labeled(`Ran ${lower} snippet`, lower, 'script')
    if (operators.some((token) => token.value === '<<')) return labeled(`Ran ${lower} script`, lower, 'script')
    const file = targetAfterOptions(args.slice(offset))[0]
    return file ? labeled(`Ran ${basename(file)}`, lower, 'script', file) : labeled(`Ran ${lower}`, lower, 'run')
  }

  if ((lower === 'cat' || lower === 'tee') && operators.some((token) => token.value === '<<')) {
    const target = lower === 'tee' ? args[1] : stdoutTarget(operators)
    if (target) return labeled(`Wrote ${basename(target)}`, lower, 'write', target)
  }

  const powershellMap: Record<string, [CommandKind, string]> = {
    'get-content': ['read', 'Read'],
    gc: ['read', 'Read'],
    'set-content': ['write', 'Wrote'],
    'out-file': ['write', 'Wrote'],
    'add-content': ['write', 'Wrote'],
    'get-childitem': ['list', 'Listed'],
    gci: ['list', 'Listed'],
    'select-string': ['search', 'Searched for'],
    sls: ['search', 'Searched for'],
    'remove-item': ['edit', 'Deleted'],
    ri: ['edit', 'Deleted'],
  }
  if (shell === 'powershell' || powershellMap[lower]) {
    const mapped = powershellMap[lower]
    if (mapped) {
      const target = targetAfterOptions(args.slice(1))[0] ?? '.'
      return labeled(`${mapped[1]} ${basename(target)}`, program, mapped[0], target)
    }
  }

  if (READERS.has(lower) || (lower === 'sed' && args[1] === '-n')) {
    const valueOptions =
      lower === 'head' || lower === 'tail'
        ? ['-n', '--lines', '-c', '--bytes', '-s', '--sleep-interval']
        : lower === 'bat'
          ? ['-l', '--language', '-r', '--line-range', '--theme', '--style', '--tabs']
          : lower === 'nl'
            ? [
                '-w',
                '--number-width',
                '-i',
                '--line-increment',
                '-v',
                '--starting-line-number',
                '-s',
                '--number-separator',
                '-b',
                '--body-numbering',
              ]
            : []
    // `cat a > b` copies into b: what it does is write b.
    const written = stdoutTarget(operators)
    if (written) return labeled(`Wrote ${basename(written)}`, program, 'write', written)
    const files = targetAfterOptions(args.slice(lower === 'sed' ? 3 : 1), valueOptions)
    if (files.length > 1) return labeled(`Read ${files.length} files`, program, 'read')
    return labeled(`Read ${basename(files[0] ?? 'input')}`, program, 'read', files[0])
  }
  if (SEARCHERS.has(lower)) {
    const explicitIndex = args.findIndex((arg) => arg === '-e' || arg === '--regexp')
    const explicit =
      explicitIndex >= 0 ? args[explicitIndex + 1] : args.find((arg) => arg.startsWith('--regexp='))?.slice(9)
    const patterns =
      explicit !== undefined
        ? [explicit]
        : targetAfterOptions(args.slice(1), [
            '-g',
            '--glob',
            '--iglob',
            '-t',
            '--type',
            '-T',
            '--type-not',
            '-m',
            '--max-count',
            '-A',
            '--after-context',
            '-B',
            '--before-context',
            '-C',
            '--context',
            '-f',
            '--file',
            '--include',
            '--exclude',
            '--exclude-dir',
            '--ignore-file',
            '--encoding',
            ...(lower === 'rg' ? ['-E'] : []),
            '--max-depth',
            '--max-filesize',
            '--sort',
            '--sortr',
          ])
    const pattern = shorten(patterns[0] ?? '', 40)
    return labeled(pattern ? `Searched for "${pattern}"` : 'Searched files', program, 'search', patterns[0])
  }
  if (lower === 'find' || lower === 'fd') return labeled('Searched files', program, 'search')
  if (LISTERS.has(lower)) {
    const dir = targetAfterOptions(args.slice(1))[0] ?? '.'
    return labeled(`Listed ${dir}`, program, 'list', dir)
  }
  if (['curl', 'wget', 'fetch'].includes(lower)) return labeled(`Ran ${program}`, program, 'network')
  if (['vitest', 'jest', 'pytest', 'mocha'].includes(lower)) return labeled(`Ran ${program}`, program, 'test')
  if (['eslint', 'oxlint'].includes(lower)) return labeled(`Ran ${program}`, program, 'lint')
  if (['prettier'].includes(lower)) return labeled(`Ran ${program}`, program, 'format')
  return labeled(`Ran ${program || 'command'}`, program, 'run')
}

/**
 * The command inside a subshell `( … )`, a group `{ …; }` or a negation `! …`,
 * which run what they hold: `(cd apps && npm test)` ran npm, not "(cd".
 * `(( … ))` is arithmetic, and is left for `SHELL_SYNTAX` to name.
 */
function unwrapGrouping(command: string): string {
  let text = command.trim()
  for (let loops = 0; loops < 4; loops++) {
    if (text.startsWith('(') && !text.startsWith('((') && text.endsWith(')')) text = text.slice(1, -1).trim()
    else if (/^\{\s/u.test(text) && /;\s*\}$/u.test(text))
      text = text
        .slice(1)
        .replace(/;\s*\}$/u, '')
        .trim()
    else if (/^!\s/u.test(text)) text = text.slice(1).trim()
    else break
  }
  return text
}

function labelCommandInner(
  input: string | string[],
  depth: number,
  shell: 'posix' | 'powershell' | 'cmd',
): CommandLabel {
  const tokens = Array.isArray(input)
    ? input.map((value) => ({ value, operator: false }))
    : tokenize(shell === 'posix' ? unwrapGrouping(input) : input)
  const segment = firstSegment(tokens)
  return classify(commandWords(segment), segment, depth, shell)
}

export function labelCommand(
  input: string | string[],
  opts: { shell?: 'posix' | 'powershell' | 'cmd' } = {},
): CommandLabel {
  try {
    return labelCommandInner(input, 0, opts.shell ?? 'posix')
  } catch {
    return labeled('Ran command', '', 'run')
  }
}
