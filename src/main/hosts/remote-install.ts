// The install steps every POSIX host shares: a WSL distribution (phase 7)
// and an SSH machine (phase 8), whichever shell and tools it has.
//
// What a remote may lack, from the phase 8 probes (spec E3): macOS has no
// `flock`, no `setsid`, no `mv -T` and no `/proc`; busybox has a `ps` without
// `-axo`; a minimal Ubuntu has no `xz`, `curl` or `wget`. So everything here
// is written against plain POSIX `sh` and the tools every one of those has:
//
// - **The lock** is a directory, `mkdir "$base/.install.lock"`, which is
//   atomic on every file system, NFS included, where `flock` semantics vary.
//   The holder writes its pid inside; a lock whose pid is gone (`kill -0`), or
//   one that never got a pid and is minutes old (its maker died between the
//   `mkdir` and the write), or one older than half an hour (a pid reused by
//   something else of the same user) is reclaimed. A lock is made and
//   reclaimed only under a second directory, `.install.lock.guard`, so two
//   waiters never reclaim and make at once. A waiter gives up after 120 s, in
//   words.
// - **Liveness** (is a tree still in use?) reads `/proc/*/cmdline` where
//   there is a `/proc`, and `ps`'s command lines elsewhere. The `ps` output is
//   read into a variable first, so the `grep` looking for a path is never
//   itself the process that names it.
// - **The move** into place is `mv -T` where it exists, and a plain `mv` into
//   a path checked not to exist otherwise (so a directory is never moved
//   *into* an older one of the same name).
//
// A tree some process still runs from is set aside, not removed, and pruned
// by a later install once nothing names its original path.

import { WSL_NODE_VERSION } from './wsl-node-runtime'

/** The data root, relative to the remote home. One layout for WSL and SSH. */
export const REMOTE_DATA_REL = '.local/share/sprintengine-studio'

export const FAIL_MARKER = '@@SPRINTENGINE_FAIL'
export const COMMITTED_MARKER = '@@SPRINTENGINE_COMMITTED'

/** How long a waiter waits for the install lock, in seconds. */
export const INSTALL_LOCK_WAIT_S = 120

const TOKEN = /^[A-Za-z0-9._+-]+$/u
const HEX = /^[a-f0-9]+$/u

export function plainToken(value: string, what: string): string {
  if (!TOKEN.test(value)) throw new Error(`${what} is not a plain token: ${JSON.stringify(value)}`)
  return value
}

export function hexToken(value: string, what: string): string {
  if (!HEX.test(value)) throw new Error(`${what} is not hex.`)
  return value
}

/** The server tree's directory under the data root, for one app version. */
export function serverTreeName(appVersion: string): string {
  return `server-${plainToken(appVersion, 'The app version')}`
}

/** The pinned Node's directory under the data root. */
export const NODE_RUNTIME_REL = `runtime/node-${WSL_NODE_VERSION}`

/**
 * The shell functions an install uses, defined once per script: `live`,
 * `lock_stale`, `lock_take`, `lock_drop`, `owned` and `place`. They read `$base` (the data root) and
 * `$id` (this install's stage id), which the script sets first.
 */
export function posixInstallFunctions(): string[] {
  return [
    // Anything a running process names in its command line (a server, a
    // hook's Node) is still in use, and is not removed or replaced under it.
    'live() {',
    '  seen=0',
    '  for c in /proc/[0-9]*/cmdline; do',
    // No `/proc` (macOS): the glob stays as written, and `ps` is asked instead.
    // Told by the pattern itself, not by the entry being missing: a process
    // that exits between the glob and the read takes its entry with it, and
    // stopping there read every process after it as not running — a busy
    // host pruned a tree still in use. A vanished entry just fails the grep.
    `    [ "$c" = '/proc/[0-9]*/cmdline' ] && break`,
    '    seen=1',
    '    grep -qF -- "$1/" "$c" 2>/dev/null && return 0',
    '  done',
    '  [ "$seen" = 1 ] && return 1',
    '  procs="$(ps -axo command= 2>/dev/null || ps -o args= 2>/dev/null || ps -ef 2>/dev/null)"',
    // No way to tell is read as in use: a tree is never removed on a guess.
    '  [ -n "$procs" ] || return 0',
    '  case "$procs" in *"$1/"*) return 0 ;; esac',
    '  return 1',
    '}',
    // Whether the lock at `$lk` belongs to an install that is gone: its pid
    // names no process, or it never got a pid and is minutes old, or it is
    // older than any install takes (a pid reused by something else).
    'lock_stale() {',
    '  holder="$(cat "$lk/pid" 2>/dev/null)"',
    '  if [ -n "$holder" ]; then kill -0 "$holder" 2>/dev/null || return 0',
    '  elif [ -n "$(find "$lk" -prune -mmin +2 2>/dev/null)" ]; then return 0; fi',
    '  [ -n "$(find "$lk" -prune -mmin +30 2>/dev/null)" ]',
    '}',
    // A lock is made, and a stale one removed, only under `$lk.guard`, held for
    // the few commands that takes. So no waiter ever sees a lock half made (no
    // pid yet), and a waiter that judged a holder gone judges again under the
    // guard, where nobody else can have put a lock of their own in its place.
    // Taking over by renaming the stale lock away could catch the lock another
    // waiter had just made, before it wrote its pid in it: that write then
    // failed, and the lock was put back with no pid, for everyone to wait on.
    // A guard left by an install killed inside it is a minute old, and cleared.
    'lock_take() {',
    '  lk="$base/.install.lock"',
    '  waited=0',
    '  while :; do',
    '    if mkdir "$lk.guard" 2>/dev/null; then',
    '      if mkdir "$lk" 2>/dev/null; then',
    '        echo "$$" > "$lk/pid" || { rm -rf "$lk"; rmdir "$lk.guard"; return 1; }',
    '        rmdir "$lk.guard"',
    '        return 0',
    '      fi',
    '      if lock_stale; then',
    '        rm -rf "$lk"',
    '        rmdir "$lk.guard"',
    '        continue',
    '      fi',
    '      rmdir "$lk.guard"',
    '    elif [ -n "$(find "$lk.guard" -prune -mmin +1 2>/dev/null)" ]; then',
    '      rmdir "$lk.guard" 2>/dev/null',
    '      continue',
    '    fi',
    `    [ "$waited" -ge ${INSTALL_LOCK_WAIT_S} ] && return 1`,
    '    sleep 1',
    '    waited=$((waited + 1))',
    '  done',
    '}',
    'lock_drop() { rm -rf "$base/.install.lock"; }',
    // Whether this user owns a directory and nobody else can write in it
    // (`test -O` is not POSIX; `find -user` is). `$1/.` is the directory a
    // symlink points at, not the link, which is the creator's whoever owns
    // the target; and a directory anyone may write in lets another user swap
    // the tree a program is run from even when this user owns it.
    'owned() { [ -n "$(find "$1/." -prune -user "$(id -u)" ! -perm -0002 2>/dev/null)" ]; }',
    // $1: the staged tree; $2: where it goes.
    'place() {',
    '  if [ -e "$2" ]; then',
    '    if live "$2"; then mv "$2" "$2.old-$id" || return 1; else rm -rf "$2" || return 1; fi',
    '  fi',
    '  mv -T "$1" "$2" 2>/dev/null && return 0',
    '  [ -e "$2" ] && return 1',
    '  mv "$1" "$2"',
    '}',
  ]
}

/** What each kind of install may prune: its own older trees, and nothing else. */
export const PRUNE_GLOBS = {
  node: '"$base"/runtime/node-*',
  app: '"$base"/[0-9]*',
  server: '"$base"/server-*',
} as const

/**
 * Prunes `glob`'s older trees that nothing runs from, keeping `$final` and
 * anything named by `keep` (a shell word list, such as the tree a running
 * server's record names).
 */
export function pruneLines(glob: string, keep = ''): string[] {
  return [
    `for d in ${glob}; do`,
    '  [ -d "$d" ] || continue',
    '  [ "$d" = "$final" ] && continue',
    ...(keep ? [`  case " ${keep} " in *" $d "*) continue ;; esac`] : []),
    '  live "$d" && continue',
    // A tree set aside while live is still named, by the processes running
    // from it, under the path it had before the move; nothing names the
    // `.old-` path. It goes only once nothing names the original path either,
    // which is the one reading that cannot mistake it for unused.
    '  case "$d" in *.old-*) live "${d%.old-*}" && continue ;; esac',
    '  rm -rf "$d"',
    'done',
  ]
}

/** What a staged tree must pass before it is moved into place. */
export function checkLines(
  kind: 'node' | 'server',
  input: { appVersion?: string; nodeBin?: string; stageVar?: string },
): string[] {
  const stage = input.stageVar ?? '$stage'
  if (kind === 'node')
    return [
      `out="$("${stage}/bin/node" --version 2>&1)" || fail "node-run $out"`,
      `[ "$out" = '${WSL_NODE_VERSION}' ] || fail "node-version $out"`,
    ]
  const version = plainToken(input.appVersion ?? '', 'The app version')
  return [
    `{ [ -f "${stage}/server.cjs" ] && [ -f "${stage}/bridge.mjs" ]; } || fail "payload incomplete"`,
    // A bundle that cannot load on this machine (a glibc below Node's floor,
    // a noexec mount) fails here, with the reason, rather than on first chat.
    `out="$("${input.nodeBin ?? `$base/${NODE_RUNTIME_REL}/bin/node`}" "${stage}/server.cjs" --version 2>&1)" || fail "server-run $out"`,
    `[ "$out" = '${version}' ] || fail "server-version $out"`,
  ]
}

/** The reason a failed install printed, or the script's own last words. */
export function commitFailure(stdout: string, stderr: string): string {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith(FAIL_MARKER))
  return (line ? line.slice(FAIL_MARKER.length) : (stderr.split(/\r?\n/u).filter(Boolean).at(-1) ?? '')).trim()
}

// ── One session, one archive (SSH) ──────────────────────────────────────────
//
// WSL installs in three steps (stage, `tar` alone, commit) because `wsl.exe
// --exec tar` takes an archive with no shell in the way. Over SSH every step
// costs an authentication, so an install is one `sh -s` session (spec E2):
// the script is one `{ …; exit; }` compound command, which the shell parses
// whole before it runs a line of it, so it never reads its stdin as script
// again. The script says `@@SPRINTENGINE_SEND`; only then does the client
// write the decision line and, after it, the archive, which is the last
// thing on the session's stdin (spec E6). `tar` reads it to the end.
//
// The marker matters for more than the archive: anything the client writes
// before it reaches a shell still parsing the script, and is run as a command
// (spec E4.3a, E5). That is a security rule, not an optimisation.

/** What a script says when it is ready for the client's next line; nothing may be written before it. */
export const SEND_MARKER = '@@SPRINTENGINE_SEND'

/** Wrap a script's lines in one compound command that ends the shell, so nothing after it is read as script. */
export function compoundScript(lines: readonly string[]): string {
  return ['{', ...lines, 'exit 0', '}', ''].join('\n')
}

const INSTALL_DIR = /^\/[A-Za-z0-9._/-]+$/u

/**
 * The data root as a shell word: under the home by default, or an absolute
 * directory the person chose for a home mounted `noexec`, which must be a
 * plain path (no spaces, quotes or `$`) so it needs no quoting to be safe.
 */
export function remoteBase(installDir?: string | null): string {
  if (!installDir) return `"$HOME/${REMOTE_DATA_REL}"`
  if (!INSTALL_DIR.test(installDir) || installDir.split('/').includes('..'))
    throw new Error(`The install directory must be an absolute path of plain characters: ${JSON.stringify(installDir)}`)
  return `'${installDir.replace(/\/+$/u, '')}'`
}

export type StreamInstallInput = {
  stageId: string
  appVersion: string
  /** The server tree's payload digest, written in its marker. */
  serverDigest: string
  /**
   * The pinned Node archive's digest the binary came from, written in the
   * runtime's marker; or `{ shellVar }`, a variable the script set from
   * `uname` (an SSH connect, which learns the target only as it runs).
   */
  nodeDigest: string | { shellVar: string }
}

/**
 * The install itself, for a script whose `$base` is set and whose stdin's
 * next bytes are the archive: stage it, check each tree it holds, and move
 * each into place under the lock. The archive holds
 * `runtime/node-<v>/bin/node` when the runtime is needed, and
 * `server-<appVersion>/…` when the server is.
 */
export function streamInstallLines(input: StreamInstallInput & { beforeUnpack?: readonly string[] }): string[] {
  const id = plainToken(input.stageId, 'The stage id')
  const server = serverTreeName(input.appVersion)
  const nodeDigest =
    typeof input.nodeDigest === 'string'
      ? `'${hexToken(input.nodeDigest, 'The Node digest')}'`
      : `"$${plainToken(input.nodeDigest.shellVar, 'The digest variable')}"`
  const serverDigest = hexToken(input.serverDigest, 'The server digest')
  return [
    `id='${id}'`,
    'stage="$base/.stage/$id"',
    "final=''",
    'locked=0',
    `fail() { printf '${FAIL_MARKER} %s\\n' "$*"; rm -rf "$stage" "$stage.err"; [ "$locked" = 1 ] && lock_drop; exit 4; }`,
    'umask 077',
    'mkdir -p "$base/.stage" || fail "mkdir $base"',
    // Programs are run from here: a directory another user owns (a shared
    // install directory) could have them replaced under us.
    'owned "$base" || fail "base-owner $base"',
    'rm -rf "$stage"',
    'mkdir "$stage" || fail stage',
    // A staging directory older than a day belongs to an install that died.
    'find "$base/.stage" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null',
    ...(input.beforeUnpack ?? []),
    `tar -xzf - -C "$stage" 2>"$stage.err" || fail "unpack $(tail -n 2 "$stage.err" 2>/dev/null | tr '\\n' ' ')"`,
    'rm -f "$stage.err"',
    'lock_take || fail "lock timeout"',
    'locked=1',
    `if [ -d "$stage/${NODE_RUNTIME_REL}" ]; then`,
    `  final="$base/${NODE_RUNTIME_REL}"`,
    ...checkLines('node', { stageVar: `$stage/${NODE_RUNTIME_REL}` }).map((line) => `  ${line}`),
    `  printf '%s' ${nodeDigest} > "$stage/${NODE_RUNTIME_REL}/.ready" || fail marker`,
    '  mkdir -p "$base/runtime" || fail mkdir',
    `  place "$stage/${NODE_RUNTIME_REL}" "$final" || fail "move runtime"`,
    ...pruneLines(PRUNE_GLOBS.node).map((line) => `  ${line}`),
    'fi',
    `if [ -d "$stage/${server}" ]; then`,
    `  final="$base/${server}"`,
    ...checkLines('server', {
      appVersion: input.appVersion,
      stageVar: `$stage/${server}`,
      nodeBin: `$base/${NODE_RUNTIME_REL}/bin/node`,
    }).map((line) => `  ${line}`),
    `  printf '%s' '${serverDigest}' > "$stage/${server}/.ready" || fail marker`,
    `  place "$stage/${server}" "$final" || fail "move server"`,
    ...pruneLines(PRUNE_GLOBS.server).map((line) => `  ${line}`),
    'fi',
    'rm -rf "$stage"',
    'lock_drop',
    'locked=0',
    `echo ${COMMITTED_MARKER}`,
  ]
}

/**
 * A whole install session on its own: wait for the client's `install` line
 * after `@@SPRINTENGINE_SEND`, then the archive. Any other line ends it
 * having changed nothing. An SSH connect embeds the same lines as one branch
 * of its decision (`ssh-connect-script.ts`).
 */
export function buildStreamInstallScript(input: StreamInstallInput & { installDir?: string | null }): string {
  return compoundScript([
    'set -u',
    `base=${remoteBase(input.installDir)}`,
    ...posixInstallFunctions(),
    `printf '%s\\n' '${SEND_MARKER}'`,
    'IFS= read -r decision || exit 0',
    '[ "$decision" = install ] || exit 0',
    ...streamInstallLines(input),
  ])
}
