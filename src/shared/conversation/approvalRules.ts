import { inferConversationToolKind } from './toolKind'
import type { ConversationToolKind } from '../conversation-runtime'
import { STUDIO_MCP_SERVER_ID } from '../product-identity'

export type ConversationApprovalDecision = 'once' | 'conversation' | 'always' | 'deny'
export type ApprovalRuleRequest = {
  action: string
  input?: unknown
  toolKind?: ConversationToolKind
  requestKind?: string
  defaultToNo?: boolean
  suppressAlwaysAllowRule?: boolean
}
/**
 * `subcommand` absent means any arguments to a program whose arguments are
 * data (`rg`, `ls`); an empty string means the bare program with no arguments.
 */
type ApprovalCommandMatcher = { type: 'command'; program: string; subcommand?: string }
export type ConversationApprovalRule = {
  id: string
  workspaceRoot: string
  toolKind: ConversationToolKind
  toolName: string
  matcher: ApprovalCommandMatcher | { type: 'path'; prefix: string } | { type: 'mcp'; server: string; tool: string }
  label: string
  createdAt: number
}
export function approvalInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Programs whose arguments are data rather than an action, so one grant for
// the program cannot widen into a different kind of operation.
const ARGUMENT_PROGRAMS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'which',
  'echo',
  'printf',
  'diff',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'date',
  'uname',
  'vitest',
  'jest',
  'pytest',
  'mocha',
  'eslint',
  'oxlint',
  'prettier',
  'tsc',
])
// Shells, interpreters, privilege and process wrappers, package runners, and
// tools that write or move arbitrary paths or reach the network: a grant for
// any of these is a grant for arbitrary code or arbitrary files.
const NEVER_PROGRAMS =
  /^(?:sudo|doas|su|rm|rmdir|del|erase|format|diskpart|diskutil|fdisk|sfdisk|parted|mkfs(?:\..*)?|dd|shred|wipefs|mount|umount|shutdown|reboot|eval|exec|env|command|builtin|time|timeout|nice|nohup|stdbuf|chroot|busybox|xargs|find|bash|sh|zsh|fish|dash|ksh|csh|tcsh|powershell|pwsh|cmd|python[\d.]*|node|deno|tsx|ts-node|ruby|perl|php|lua|osascript|npx|bunx|pnpx|uvx|pipx|cp|mv|ln|chmod|chown|chgrp|touch|tee|install|rsync|scp|sftp|ssh|curl|wget|nc|ncat|socat|telnet|open|xdg-open|start|kill|killall|pkill|launchctl|systemctl|defaults|crontab|at|tar|unzip|zip|gzip|gunzip|sed|awk|gawk|sort|security|sqlite3|vi|vim|nvim|nano|emacs|less|more|man|watch|parallel|script|expect)$/u
// Flags that load or run code, rewrite configuration, or write a file chosen
// by the caller, on whichever program accepts them.
const NEVER_LONG_FLAGS = [
  'exec',
  'exec-path',
  'upload-pack',
  'receive-pack',
  'config',
  'config-env',
  'output',
  'output-file',
  'out-file',
  'pre',
  'to-command',
  'checkpoint-action',
  'compress-program',
  'use-compress-program',
  'rsh',
  'script-shell',
  'node-options',
  'require',
  'import',
  'loader',
  'eval',
  'template',
  'git-dir',
  'work-tree',
  'open-files-in-pager',
  'extcmd',
]

/**
 * Programs built on getopt_long, git's option parser among them, accept any
 * unambiguous prefix of a long option, so `--ev=` is `--eval=` wherever no
 * other option starts the same way. A word that could be such a prefix is
 * refused along with the full name.
 */
function isNeverLongFlag(word: string): boolean {
  if (!word.startsWith('--')) return false
  const name = word.slice(2).split('=')[0].toLowerCase()
  return name.length > 0 && NEVER_LONG_FLAGS.some((flag) => flag.startsWith(name))
}

type Scope = { program: string; subcommand?: string }

/**
 * Split a command the way a POSIX shell would for the simple cases, and refuse
 * everything else: any operator, redirection, substitution, glob, escape or
 * home expansion leaves the candidate unrememberable rather than guessed at.
 */
function commandWords(command: string): string[] | null {
  if (!command.trim() || /[\u0000-\u001f\u007f`$\\]/u.test(command)) return null
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '!') return null
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === ' ') {
      if (started) words.push(word)
      word = ''
      started = false
    } else if (/[\p{L}\p{N}_./:=@%+,-]/u.test(char)) {
      word += char
      started = true
    } else return null
  }
  if (quote) return null
  if (started) words.push(word)
  return words.length ? words : null
}

function touchesGitDirectory(word: string): boolean {
  // Case-insensitive because the default macOS and Windows file systems are.
  return word.split(/[/=:,]/u).some((part) => /^\.git[.\s]*$/iu.test(part))
}

function shortFlags(word: string): string {
  return /^-(?!-)([A-Za-z]+)/u.exec(word)?.[1] ?? ''
}

/**
 * The options a remembered git grant covers, per subcommand. Git accepts any
 * unambiguous prefix of a long option (`--forc` is `--force`, `--ex=` is
 * `--exec=`), so no list of dangerous spellings can be complete; a request
 * whose every option is named here, spelled in full, may reuse a grant, and
 * any other option asks again.
 *
 * `short` letters are flags; `valued` letters take the rest of their word as
 * a value (`-mwip`, `-n5`, `-M50%`). A `long` name ending in `=` takes a
 * value; one without accepts only the bare flag. A value written as the next
 * word is not skipped: it is checked like any other word, which can only
 * refuse more.
 */
type GitOptions = { short?: string; valued?: string; long?: string; counts?: boolean }

const GIT_DIFF_LONG =
  'patch no-patch stat= shortstat numstat name-only name-status summary raw patch-with-stat dirstat= ' +
  'cumulative unified= minimal patience histogram diff-algorithm= word-diff= word-diff-regex= color= ' +
  'no-color color-words= color-moved= no-color-moved abbrev= full-index binary no-renames find-renames= ' +
  'find-copies= find-copies-harder irreversible-delete diff-filter= text ignore-space-at-eol ' +
  'ignore-space-change ignore-all-space ignore-blank-lines ignore-cr-at-eol function-context exit-code ' +
  'quiet no-ext-diff no-textconv ignore-submodules= src-prefix= dst-prefix= no-prefix default-prefix ' +
  'relative= no-relative merge-base cc combined-all-paths'
const GIT_LOG_LONG =
  `${GIT_DIFF_LONG} oneline graph decorate= no-decorate all branches= tags= remotes= format= pretty= ` +
  'abbrev-commit no-abbrev-commit max-count= skip= since= until= after= before= author= committer= ' +
  'grep= all-match invert-grep regexp-ignore-case extended-regexp fixed-strings perl-regexp reverse ' +
  'first-parent no-merges merges min-parents= max-parents= follow full-history simplify-by-decoration ' +
  'ancestry-path left-right left-only right-only cherry-pick cherry-mark cherry boundary topo-order ' +
  'date-order author-date-order date= relative-date parents children walk-reflogs full-diff log-size ' +
  'no-walk= do-walk not source mailmap no-mailmap use-mailmap no-notes show-pulls dense sparse ' +
  'remove-empty exclude= glob= diff-merges= no-diff-merges'
const GIT_LOG: GitOptions = { short: 'pusczwbWRaiEFPgmctrD', valued: 'nSGLUMCBl', long: GIT_LOG_LONG, counts: true }
const GIT_DIFF: GitOptions = {
  short: 'pusczwbWRa',
  valued: 'UMCBSGl',
  long: `${GIT_DIFF_LONG} cached staged ours theirs base`,
}
const GIT_STASH_PUSH: GitOptions = {
  short: 'ukqaS',
  valued: 'm',
  long: 'message= include-untracked no-include-untracked keep-index no-keep-index all quiet staged',
}
const GIT_STASH_APPLY: GitOptions = { short: 'q', long: 'index quiet' }

const GIT_OPTIONS: Record<string, GitOptions> = {
  status: {
    short: 'sbvz',
    valued: 'u',
    long:
      'short branch porcelain= long verbose untracked-files= ignored= ignore-submodules= no-renames renames ' +
      'find-renames= column= no-column ahead-behind no-ahead-behind show-stash null',
  },
  log: GIT_LOG,
  show: GIT_LOG,
  shortlog: { ...GIT_LOG, short: `${GIT_LOG.short}nse`, long: `${GIT_LOG_LONG} numbered summary email group=` },
  diff: GIT_DIFF,
  blame: {
    short: 'lstewcpnfb',
    valued: 'LMC',
    long:
      'porcelain line-porcelain incremental root show-stats reverse first-parent show-name show-number ' +
      'show-email abbrev= date= color-lines color-by-age ignore-rev= progress no-progress minimal',
  },
  describe: {
    long: 'tags all long abbrev= always dirty= broken= exact-match first-parent match= exclude= contains candidates=',
  },
  'rev-parse': {
    short: 'q',
    long:
      'abbrev-ref= short= verify quiet symbolic symbolic-full-name all branches= tags= remotes= show-toplevel ' +
      'show-prefix show-cdup is-inside-work-tree is-inside-git-dir is-bare-repository is-shallow-repository ' +
      'absolute-git-dir git-common-dir show-object-format= show-superproject-working-tree revs-only no-revs ' +
      'flags no-flags default= sq',
  },
  'ls-files': {
    short: 'cdmoiskuzvtf',
    valued: 'x',
    long:
      'cached deleted modified others ignored stage unmerged killed directory no-empty-directory exclude= ' +
      'exclude-standard full-name recurse-submodules abbrev= error-unmatch eol deduplicate format= sparse',
  },
  'ls-tree': { short: 'drtlz', long: 'name-only name-status object-only long full-name full-tree abbrev= format=' },
  'cat-file': { short: 'tsep', long: 'batch= batch-check= batch-all-objects follow-symlinks' },
  'show-ref': { short: 'sdq', long: 'head heads tags branches verify hash= abbrev= quiet dereference exists' },
  'merge-base': { short: 'a', long: 'all octopus independent is-ancestor fork-point' },
  'name-rev': { long: 'tags refs= exclude= all name-only no-undefined always' },
  reflog: GIT_LOG,
  'reflog show': GIT_LOG,
  'reflog list': {},
  'reflog exists': {},
  grep: {
    short: 'nilwvLcHhEFPIWpoqrz',
    valued: 'eABCm',
    long:
      'line-number ignore-case word-regexp invert-match files-with-matches files-without-match count heading ' +
      'break cached untracked extended-regexp fixed-strings perl-regexp basic-regexp all-match and or not ' +
      'max-depth= only-matching column function-context show-function context= after-context= ' +
      'before-context= name-only recurse-submodules full-name no-color color= threads= null quiet ' +
      'max-count= exclude-standard no-exclude-standard',
    counts: true,
  },
  add: {
    short: 'nvuAN',
    long:
      'dry-run verbose update all no-all intent-to-add ignore-removal no-ignore-removal refresh ignore-errors ' +
      'ignore-missing renormalize chmod= sparse',
  },
  commit: {
    short: 'aqvsn',
    valued: 'm',
    long:
      'all message= quiet verbose signoff no-signoff no-verify verify amend no-edit allow-empty ' +
      'allow-empty-message dry-run short porcelain long author= date= fixup= squash= cleanup= no-status ' +
      'status trailer= only',
  },
  mv: { short: 'nvk', long: 'dry-run verbose' },
  fetch: {
    short: 'vqpPtn46',
    valued: 'j',
    long:
      'all prune prune-tags tags no-tags verbose quiet dry-run depth= deepen= shallow-since= shallow-exclude= ' +
      'unshallow jobs= multiple progress no-progress recurse-submodules= no-recurse-submodules atomic ' +
      'no-write-fetch-head write-fetch-head set-upstream show-forced-updates no-show-forced-updates ipv4 ipv6',
  },
  pull: {
    short: 'vqpt46',
    long:
      'verbose quiet rebase no-rebase ff no-ff ff-only autostash no-autostash stat no-stat no-edit commit ' +
      'no-commit prune tags no-tags all depth= unshallow progress no-progress signoff no-signoff no-verify ' +
      'ipv4 ipv6',
  },
  push: {
    short: 'vqun46',
    long:
      'verbose quiet set-upstream tags follow-tags no-follow-tags dry-run porcelain progress no-progress ' +
      'no-verify verify atomic no-atomic all branches thin no-thin ipv4 ipv6',
  },
  branch: {
    short: 'varlqdmct',
    valued: 'u',
    long:
      'list all remotes verbose quiet delete move copy show-current contains= no-contains= merged= no-merged= ' +
      'sort= format= points-at= track= no-track set-upstream-to= unset-upstream column= no-column color= ' +
      'no-color abbrev= no-abbrev create-reflog ignore-case omit-empty',
  },
  switch: {
    short: 'dqtm',
    valued: 'c',
    long: 'create= detach guess no-guess quiet track= no-track merge progress no-progress recurse-submodules',
  },
  stash: GIT_STASH_PUSH,
  'stash push': GIT_STASH_PUSH,
  'stash list': GIT_LOG,
  'stash show': { ...GIT_DIFF, long: `${GIT_DIFF_LONG} include-untracked only-untracked` },
  'stash pop': GIT_STASH_APPLY,
  'stash apply': GIT_STASH_APPLY,
  merge: {
    short: 'qvn',
    valued: 'm',
    long:
      'ff no-ff ff-only squash no-squash commit no-commit no-edit stat no-stat summary no-summary message= log= ' +
      'no-log autostash no-autostash no-verify verify allow-unrelated-histories quiet verbose progress ' +
      'no-progress continue signoff no-signoff',
  },
  rebase: {
    short: 'qvnm',
    long:
      'onto= continue abort skip quit autostash no-autostash update-refs no-update-refs keep-base root stat ' +
      'no-stat no-verify verify quiet verbose fork-point no-fork-point committer-date-is-author-date ' +
      'reset-author-date signoff merge apply',
  },
  'cherry-pick': {
    short: 'nxs',
    valued: 'm',
    long:
      'continue abort skip quit no-commit signoff ff allow-empty allow-empty-message keep-redundant-commits ' +
      'mainline= no-edit',
  },
  revert: {
    short: 'ns',
    valued: 'm',
    long: 'continue abort skip quit no-commit no-edit signoff mainline= reference',
  },
  tag: {
    short: 'la',
    valued: 'nm',
    long:
      'list annotate message= sort= contains= no-contains= merged= no-merged= points-at= format= column= ' +
      'no-column ignore-case create-reflog color=',
  },
  remote: { short: 'v', long: 'verbose' },
  'remote show': { short: 'n' },
  'remote get-url': { long: 'push all' },
  'remote add': { short: 'f', valued: 'tm', long: 'fetch tags no-tags track= master=' },
  'remote rename': { long: 'progress no-progress' },
  'remote remove': {},
  'remote rm': {},
  'remote set-url': { long: 'push add delete' },
  'remote set-head': { short: 'ad', long: 'auto delete' },
  'remote set-branches': { long: 'add' },
  'remote prune': { short: 'n', long: 'dry-run' },
  'remote update': { short: 'p', long: 'prune' },
  worktree: {},
  'worktree list': { short: 'vz', long: 'porcelain verbose expire=' },
  'worktree add': {
    short: 'dq',
    valued: 'b',
    long: 'detach track no-track guess-remote no-guess-remote checkout no-checkout lock reason= quiet',
  },
  'worktree remove': {},
  'worktree prune': { short: 'nv', long: 'dry-run verbose expire=' },
  'worktree lock': { long: 'reason=' },
  'worktree unlock': {},
  'worktree move': {},
  'worktree repair': {},
  reset: { short: 'qN', long: 'soft mixed quiet no-refresh refresh' },
}
// Subcommands whose own first word is a different operation (`stash drop`).
const GIT_NESTED = new Set(['stash', 'remote', 'worktree', 'reflog'])
// `+ref` forces and `:ref` deletes, written as a refspec rather than a flag.
const GIT_REFSPEC_SUBCOMMANDS = new Set(['push', 'fetch', 'pull'])

function isAllowedGitOption(arg: string, options: GitOptions): boolean {
  if (arg.startsWith('--')) {
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    const names = (options.long ?? '').split(' ')
    return names.includes(`${name}=`) || (equals === -1 && names.includes(name))
  }
  if (options.counts && /^-\d+$/u.test(arg)) return true
  for (const flag of arg.slice(1)) {
    if (options.valued?.includes(flag)) return true
    if (!/[A-Za-z0-9]/u.test(flag) || !options.short?.includes(flag)) return false
  }
  return true
}

function gitScope(args: string[]): Scope | null {
  // Options before the subcommand redirect the repository or its config.
  const rest = args[0] === '--no-pager' ? args.slice(1) : args
  const subcommand = rest[0]
  if (!subcommand || !Object.hasOwn(GIT_OPTIONS, subcommand) || subcommand.includes(' ')) return null
  const tail = rest.slice(1)
  let scope = subcommand
  if (GIT_NESTED.has(subcommand)) {
    const separator = tail.indexOf('--')
    const nested = (separator === -1 ? tail : tail.slice(0, separator)).find((arg) => !arg.startsWith('-'))
    if (nested) scope = `${subcommand} ${nested}`
    // An unknown nested word (`stash drop`, `reflog expire`) is an operation
    // this list has not vetted, so it is never remembered.
    if (!Object.hasOwn(GIT_OPTIONS, scope)) return null
  }
  const options = GIT_OPTIONS[scope]
  let positional = false
  for (const arg of tail) {
    if (!positional && (arg === '--' || arg === '--end-of-options')) positional = true
    else if (!positional && arg.startsWith('-') && arg !== '-') {
      if (!isAllowedGitOption(arg, options)) return null
    } else if (GIT_REFSPEC_SUBCOMMANDS.has(subcommand) && /^[+:]/u.test(arg)) return null
  }
  return { program: 'git', subcommand: scope }
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_RUN = new Set(['run', 'run-script', 'rum', 'urn'])
// Each runs a package or program named in its arguments, or rewrites the
// configuration that every later script inherits.
const PACKAGE_DENIED = new Set([
  'exec',
  'x',
  'dlx',
  'create',
  'init',
  'explore',
  'edit',
  'config',
  'c',
  'set',
  'pkg',
  'node',
])
const PACKAGE_INSTALL = /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|update|up|upgrade)$/u
const PACKAGE_FLAGS = new Set([
  '-s',
  '--silent',
  '--if-present',
  '--frozen-lockfile',
  '--immutable',
  '--prefer-offline',
  '--offline',
  '--no-audit',
  '--no-fund',
  '--ignore-scripts',
  '-r',
  '--recursive',
  '--parallel',
  '--stream',
])

function packageScope(program: string, args: string[]): Scope | null {
  const subcommand = args[0]
  if (!subcommand) return { program, subcommand: '' }
  if (subcommand.startsWith('-') || PACKAGE_DENIED.has(subcommand)) return null
  const separator = args.indexOf('--')
  const own = separator === -1 ? args.slice(1) : args.slice(1, separator)
  if (own.some((arg) => arg.startsWith('-') && !PACKAGE_FLAGS.has(arg))) return null
  const positional = own.filter((arg) => !arg.startsWith('-'))
  // Installing a named package runs that package's lifecycle scripts.
  if (PACKAGE_INSTALL.test(subcommand)) return positional.length ? null : { program, subcommand }
  if (PACKAGE_RUN.has(subcommand)) return { program, subcommand: positional[0] ? `run ${positional[0]}` : 'run' }
  return { program, subcommand }
}

// Arguments that never name a file, so where they point is not a question.
const TEXT_PROGRAMS = new Set(['echo', 'printf', 'pwd', 'which', 'basename', 'dirname', 'date', 'uname'])

/**
 * A grant for a program that reads, lists or checks files covers this
 * workspace: an absolute path elsewhere or a `..` that climbs out of it asks
 * again, so "always allow cat" never becomes a way to read the rest of the disk.
 */
function staysInWorkspace(args: string[], root: string | undefined): boolean {
  const normalizedRoot = root ? normalizedPath(root) : null
  return args.every((arg) => {
    const equals = arg.indexOf('=')
    // An option with its value attached in the same word (`-f/etc/x`) has no
    // reliable boundary between flag and path, so a path in one asks.
    if (arg.startsWith('-') && equals === -1) return !arg.includes('/') && !arg.includes('..')
    const value = arg.startsWith('-') ? arg.slice(equals + 1) : arg
    const absolute = /^(?:\/|[A-Za-z]:\/)/u.test(value)
    if (!absolute && !value.split(/[/=:,]/u).includes('..')) return true
    if (!normalizedRoot) return false
    const path = normalizedPath(absolute ? value : `${normalizedRoot}/${value}`)
    return Boolean(path && isPathWithinApprovalRoot(path, normalizedRoot))
  })
}

// Installers that fetch a package and run its build or install code, the
// same reason `npm install <name>` is never remembered.
const NEVER_SUBCOMMANDS: Record<string, RegExp> = {
  pip: /^install$/u,
  cargo: /^install$/u,
  gem: /^install$/u,
  go: /^install$/u,
  brew: /^(?:install|reinstall)$/u,
  // `uv run` and `uv tool` start whatever program they are given, like npx.
  uv: /^(?:add|run|tool)$/u,
}

function commandScope(command: string, root?: string): Scope | null {
  const words = commandWords(command)
  if (!words) return null
  const first = words[0]
  // A leading `NAME=value` sets the environment (`GIT_SSH_COMMAND=...`), and a
  // path or script extension names a repository-controlled executable.
  if (!/^[\w.-]+$/u.test(first) || /\.(?:cmd|bat|sh|ps1)$/iu.test(first)) return null
  const program = first.toLowerCase().replace(/\.exe$/u, '')
  if (NEVER_PROGRAMS.test(program)) return null
  const args = words.slice(1)
  if (args.some((arg) => isNeverLongFlag(arg) || touchesGitDirectory(arg))) return null
  if (program === 'git') return gitScope(args)
  if (PACKAGE_MANAGERS.has(program)) return packageScope(program, args)
  if (ARGUMENT_PROGRAMS.has(program)) {
    if (program === 'tree' && args.some((arg) => shortFlags(arg).includes('o'))) return null
    if (program === 'eslint' && args.some((arg) => arg === '-o')) return null
    if (!TEXT_PROGRAMS.has(program) && !staysInWorkspace(args, root)) return null
    return { program }
  }
  // Anything else is scoped to its first word; a leading option leaves the
  // action unknown, so that request can only be allowed once.
  const subcommand = args[0]
  if (subcommand === undefined) return { program, subcommand: '' }
  if (!/^[\w.:@-]+$/u.test(subcommand) || subcommand.startsWith('-')) return null
  const installer = program.replace(/^pip[\d.]*$/u, 'pip')
  if (NEVER_SUBCOMMANDS[installer]?.test(subcommand)) return null
  if (program === 'uv' && subcommand === 'pip' && args.includes('install')) return null
  return { program, subcommand }
}

/** Unknown shell structure fails closed. A remembered command is never a shell grant. */
export function isNeverAutoApprovableCommand(command: string, workspaceRoot?: string): boolean {
  return commandScope(command, workspaceRoot) === null
}

function commandText(matcher: ApprovalCommandMatcher): string {
  if (matcher.subcommand === undefined) return `"${matcher.program} …"`
  if (!matcher.subcommand) return `"${matcher.program}" with no arguments`
  return `"${matcher.program} ${matcher.subcommand} …"`
}

/** What a remembered rule grants, in the words the permission menu and Settings use. */
function approvalRuleScopeText(rule: Pick<ConversationApprovalRule, 'toolName' | 'matcher'>): string {
  const { matcher } = rule
  if (matcher.type === 'command') return commandText(matcher)
  if (matcher.type === 'path') return `${rule.toolName} on any file in this workspace except .git`
  return `${matcher.server} ${matcher.tool}`
}

/** Menu wording for the two remember choices of a permission request. */
export function approvalRememberLabels(rule: Pick<ConversationApprovalRule, 'toolName' | 'matcher'>): {
  conversation: string
  always: string
} {
  const scope = approvalRuleScopeText(rule)
  return { conversation: `Allow ${scope} for this conversation`, always: `Always allow ${scope} in this workspace` }
}

function normalizedPath(value: string): string | null {
  const path = value.replace(/\\/gu, '/')
  if (!path.startsWith('/') && !/^[A-Za-z]:\//u.test(path)) return null
  const prefix = path.startsWith('/') ? '/' : path.slice(0, 3).toLowerCase()
  const parts: string[] = []
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return prefix + parts.join('/')
}
export function approvalFilePath(request: ApprovalRuleRequest, workspaceRoot: string): string | null {
  const input = approvalInput(request.input)
  const raw = input.file_path ?? input.path ?? input.filePath
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.startsWith('~')) return null
  return normalizedPath(/^(?:\/|[A-Za-z]:[\\/])/u.test(raw) ? raw : `${workspaceRoot}/${raw}`)
}
export function isPathWithinApprovalRoot(path: string, root: string): boolean {
  const normalized = normalizedPath(root)
  return Boolean(normalized && (path === normalized || path.startsWith(`${normalized.replace(/\/$/u, '')}/`)))
}
/**
 * A file grant never reaches into a repository's git directory: a planted hook
 * or `core.hooksPath` runs on the user's next commit, outside any approval.
 */
export function isApprovalPathInGitDirectory(path: string, root: string): boolean {
  const normalizedRoot = normalizedPath(root)
  if (!normalizedRoot) return true
  return path
    .slice(normalizedRoot.length)
    .split('/')
    .some((part) => /^\.git[.\s]*$/iu.test(part))
}

// The gateway tools that start an agent, or give one a workspace to start in.
// Each call hands a prompt of the caller's choosing to an agent that then acts
// on its own, so a person who asks to be asked sees every one of them: no
// remembered grant covers them, and a rule saved before this is not honoured.
// Matched on any server named for the gateway (the plugin copy prefixes it)
// and on the tool as either spelling, since some CLIs rewrite the dot.
const AGENT_LAUNCHING_GATEWAY_TOOLS = new Set([
  'agent.launch',
  'backlog.work',
  'conversation.create',
  'schedule.create',
  'schedule.run',
  // A resumed schedule starts agents again at its times, on the prompt it was
  // made with: the same hand-off as making it. Pausing starts nothing.
  'schedule.resume',
  'terminal.create',
  'workspace.create',
])

export function isAgentLaunchingGatewayTool(server: string, tool: string): boolean {
  return server.includes(STUDIO_MCP_SERVER_ID) && AGENT_LAUNCHING_GATEWAY_TOOLS.has(tool.replace('_', '.'))
}

/** The server and tool an `mcp__<server>__<tool>` call names, or null for any other name. */
export function mcpCallOf(action: string): { server: string; tool: string } | null {
  const match = /^mcp__(?<server>[\w.-]+)__(?<tool>[\w.-]+)$/u.exec(action)
  return match?.groups ? { server: match.groups.server, tool: match.groups.tool } : null
}

export function approvalRuleCandidate(
  request: ApprovalRuleRequest,
  workspaceRoot: string,
): Omit<ConversationApprovalRule, 'id' | 'createdAt'> | null {
  if (request.requestKind && request.requestKind !== 'tool') return null
  if (request.defaultToNo || request.suppressAlwaysAllowRule) return null
  const kind = request.toolKind ?? inferConversationToolKind(request.action)
  const input = approvalInput(request.input)
  const base = { workspaceRoot, toolKind: kind, toolName: request.action }
  if (kind === 'command') {
    const command = input.command ?? input.cmd
    if (typeof command !== 'string') return null
    const scope = commandScope(command, workspaceRoot)
    if (!scope) return null
    const matcher: ApprovalCommandMatcher = { type: 'command', ...scope }
    return { ...base, matcher, label: `${request.action}: ${commandText(matcher)}` }
  }
  if (kind === 'file_read' || kind === 'file_edit' || kind === 'file_write') {
    const path = approvalFilePath(request, workspaceRoot)
    const prefix = normalizedPath(workspaceRoot)
    if (!path || !prefix || !isPathWithinApprovalRoot(path, prefix) || Array.isArray(input.edits)) return null
    if (isApprovalPathInGitDirectory(path, prefix)) return null
    const matcher = { type: 'path' as const, prefix }
    return { ...base, matcher, label: `${request.action}: files within ${prefix} except .git` }
  }
  if (kind === 'mcp') {
    const call = mcpCallOf(request.action)
    if (!call || isAgentLaunchingGatewayTool(call.server, call.tool)) return null
    return {
      ...base,
      matcher: { type: 'mcp', server: call.server, tool: call.tool },
      label: `${call.server}: ${call.tool}`,
    }
  }
  return null
}

export function matchesApprovalRule(
  rule: ConversationApprovalRule,
  request: ApprovalRuleRequest,
  workspaceRoot: string,
): boolean {
  const candidate = approvalRuleCandidate(request, workspaceRoot)
  if (
    !candidate ||
    rule.workspaceRoot !== workspaceRoot ||
    rule.toolKind !== candidate.toolKind ||
    rule.toolName !== candidate.toolName ||
    rule.matcher.type !== candidate.matcher.type
  )
    return false
  if (rule.matcher.type === 'command' && candidate.matcher.type === 'command')
    return (
      rule.matcher.program === candidate.matcher.program && rule.matcher.subcommand === candidate.matcher.subcommand
    )
  return JSON.stringify(rule.matcher) === JSON.stringify(candidate.matcher)
}

function isConversationApprovalRule(value: unknown): value is ConversationApprovalRule {
  const rule = approvalInput(value)
  const matcher = approvalInput(rule.matcher)
  if (
    typeof rule.id !== 'string' ||
    typeof rule.workspaceRoot !== 'string' ||
    typeof rule.toolName !== 'string' ||
    typeof rule.label !== 'string' ||
    typeof rule.createdAt !== 'number'
  )
    return false
  return (
    (rule.toolKind === 'command' &&
      matcher.type === 'command' &&
      typeof matcher.program === 'string' &&
      /^[\w.-]+$/u.test(matcher.program) &&
      (matcher.subcommand === undefined || typeof matcher.subcommand === 'string')) ||
    (['file_read', 'file_edit', 'file_write'].includes(String(rule.toolKind)) &&
      matcher.type === 'path' &&
      matcher.prefix === normalizedPath(rule.workspaceRoot)) ||
    (rule.toolKind === 'mcp' &&
      matcher.type === 'mcp' &&
      typeof matcher.server === 'string' &&
      typeof matcher.tool === 'string')
  )
}

/**
 * Rules saved before command grants named a subcommand matched every use of
 * the program. Keep only those whose program takes data rather than an action;
 * the rest cannot be narrowed without knowing what was approved, so they are
 * dropped and the next request asks again. Returns null for a rule to drop.
 */
export function migrateConversationApprovalRule(value: unknown): ConversationApprovalRule | null {
  if (isConversationApprovalRule(value)) return value
  const rule = approvalInput(value)
  const matcher = approvalInput(rule.matcher)
  if (rule.toolKind !== 'command' || matcher.type !== 'program' || typeof matcher.program !== 'string') return null
  const program = matcher.program.toLowerCase()
  if (!ARGUMENT_PROGRAMS.has(program) || typeof rule.toolName !== 'string') return null
  const next = {
    ...rule,
    matcher: { type: 'command', program },
    label: `${rule.toolName}: ${commandText({ type: 'command', program })}`,
  }
  return isConversationApprovalRule(next) ? next : null
}
