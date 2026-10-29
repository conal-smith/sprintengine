import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SshPromptKind, SshPromptRequest } from '../../../shared/ssh-environments'
import type { SshAskpassEnv } from './ssh-command'

// Where ssh's questions go (phase 8 spec, 5.5). ssh runs `SSH_ASKPASS` with
// the question as its one argument and reads the answer from its stdout; with
// `SSH_ASKPASS_REQUIRE=force` it does so even with no terminal and no display.
//
// The program is a tiny shim this module writes into a private directory: it
// runs the app's own binary as Node on a script beside it, which connects to
// a socket in the same directory (0700, so only this user can reach it),
// presents the token this spawn was issued, sends the question, and prints
// what comes back. The answer never sits in an environment variable, a file
// or a log, and lives in this process only until it is written to the shim.
//
// The question is classified from ssh's own fixed strings. A keyboard-
// interactive question is the remote's text, and OpenSSH (8.4 and later)
// prefixes it with `(user@host) `: anything so prefixed, or that matches none
// of ssh's own questions, is shown as the remote's, verbatim, in a frame that
// names the machine, so a server cannot dress a question up as a Studio or a
// passphrase prompt. An older ssh (Windows 10's own is 8.1) marks nothing, so
// there a passphrase or password question is shown verbatim too, saying that
// Studio cannot tell who asks.

export const ASKPASS_TIMEOUT_MS = 3 * 60_000

/** A question classified: which dialog, and for a new host, its key. */
export type ClassifiedPrompt = {
  kind: SshPromptKind
  text: string
  hostKey?: SshPromptRequest['hostKey']
  /** A passphrase or password question this ssh cannot tell from one the remote wrote (before OpenSSH 8.4). */
  unverified?: boolean
}

/**
 * Whether this ssh marks the remote's own questions with `(user@host) `:
 * OpenSSH 8.4 and later. Read from `ssh -V`; anything else is taken as not.
 */
export function marksRemotePrompts(version: string): boolean {
  const match = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/u.exec(version)
  if (!match) return false
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major > 8 || (major === 8 && minor >= 4)
}

/**
 * `SSH_ASKPASS_PROMPT`: `confirm` for a yes/no, `none` for a notice ssh takes
 * down itself. `remoteMarked`: whether this ssh prefixes the remote's
 * questions (`marksRemotePrompts`). Where it does not, a remote can write
 * "Enter passphrase for key …" word for word, so a passphrase or password
 * question is shown as one Studio cannot vouch for.
 */
export function classifyPrompt(
  prompt: string,
  askpassPrompt = '',
  options: { remoteMarked?: boolean } = {},
): ClassifiedPrompt {
  const classified = classifyText(prompt, askpassPrompt)
  if (options.remoteMarked === false && (classified.kind === 'passphrase' || classified.kind === 'password'))
    return { ...classified, unverified: true }
  return classified
}

function classifyText(prompt: string, askpassPrompt: string): ClassifiedPrompt {
  const text = prompt.replace(/\r/gu, '').replace(/\s+$/u, '')
  // The remote's own text (keyboard-interactive), whatever it says after the prefix.
  if (/^\([^()\s]+@[^()\s]+\) /u.test(text)) return { kind: 'remote', text }
  const authenticity = /^The authenticity of host '([^']+)' can't be established\./u.exec(text)
  if (authenticity) {
    // OpenSSH 10.0 writes "… key fingerprint is SHA256:….", the build Ubuntu
    // 26.04 ships "… key fingerprint is: SHA256:…" with no full stop.
    const key = /^(\S+) key fingerprint is:? (SHA256:[A-Za-z0-9+/=]+)\.?$/mu.exec(text)
    if (key && /Are you sure you want to continue connecting \(yes\/no(\/\[fingerprint\])?\)\?$/u.test(text))
      return { kind: 'host-key', text, hostKey: { host: authenticity[1]!, keyType: key[1]!, fingerprint: key[2]! } }
  }
  if (askpassPrompt === 'none' || text.startsWith('Confirm user presence for key ')) return { kind: 'touch', text }
  if (/^Enter passphrase for (key )?'?[^\n]*'?: ?$/u.test(text) || text.startsWith('Enter PIN for '))
    return { kind: 'passphrase', text }
  if (/^[^\s@()]+@[^\s']+'s password: ?$/u.test(text)) return { kind: 'password', text }
  if (askpassPrompt === 'confirm' || /^Allow use of key .*\?/u.test(text)) return { kind: 'confirm', text }
  return { kind: 'remote', text }
}

/** The shim's script: one line in, one line out, nothing kept. */
const SHIM_SCRIPT = `import { connect } from 'node:net'
const socketPath = process.env.SPRINTENGINE_ASKPASS_SOCKET
const token = process.env.SPRINTENGINE_ASKPASS_TOKEN
if (!socketPath || !token) process.exit(1)
const socket = connect(socketPath)
let buffer = ''
socket.on('connect', () => {
  socket.write(JSON.stringify({ token, prompt: process.argv[2] ?? '', askpass: process.env.SSH_ASKPASS_PROMPT ?? '' }) + '\\n')
})
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  const newline = buffer.indexOf('\\n')
  if (newline === -1) return
  let answer = null
  try {
    answer = JSON.parse(buffer.slice(0, newline)).answer
  } catch {}
  socket.destroy()
  if (typeof answer !== 'string') process.exit(1)
  process.stdout.write(answer + '\\n', () => process.exit(0))
})
socket.on('error', () => process.exit(1))
socket.on('close', () => process.exit(1))
`

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

export type AskpassRequest = ClassifiedPrompt & { label: string }

export type AskpassBrokerOptions = {
  /** Show the question; resolves to the answer, or null for Cancel. `signal` aborts when ssh gave up. */
  ask(request: AskpassRequest, signal: AbortSignal): Promise<string | null>
  /** The Node that runs the shim: the app's own binary (run as Node) by default. */
  nodePath?: string
  /** Extra environment for that Node (`ELECTRON_RUN_AS_NODE=1` for the app's binary). */
  runAsNode?: boolean
  timeoutMs?: number
  /** Whether this ssh marks the remote's questions (`marksRemotePrompts`); true when not said. */
  remoteMarked?: () => boolean
  platform?: NodeJS.Platform
  tempDir?: string
  log?: (message: string) => void
}

export type AskpassBroker = {
  /** A token for one ssh spawn; its questions are asked about `label`. Revoked once the spawn ends. */
  issue(label: string): { env: SshAskpassEnv; revoke(): void }
  close(): void
}

/** The broker: the private directory with the shim and the socket, and the tokens it honours. */
export async function createAskpassBroker(options: AskpassBrokerOptions): Promise<AskpassBroker> {
  const platform = options.platform ?? process.platform
  const log = options.log ?? (() => undefined)
  const timeoutMs = options.timeoutMs ?? ASKPASS_TIMEOUT_MS
  // The system temp directory (per user on macOS), short enough for the 104
  // bytes macOS allows a socket path.
  const dir = mkdtempSync(join(options.tempDir ?? tmpdir(), 'se-ask-'))
  chmodSync(dir, 0o700)
  const script = join(dir, 'askpass.mjs')
  writeFileSync(script, SHIM_SCRIPT, { mode: 0o600 })
  const node = options.nodePath ?? process.execPath
  const runAsNode = options.runAsNode ?? Boolean(process.versions.electron)
  let program: string
  if (platform === 'win32') {
    program = join(dir, 'askpass.cmd')
    writeFileSync(
      program,
      `@echo off\r\n${runAsNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}"${node}" "${script}" %*\r\n`,
      { mode: 0o700 },
    )
  } else {
    program = join(dir, 'askpass')
    writeFileSync(
      program,
      `#!/bin/sh\n${runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`,
      { mode: 0o700 },
    )
  }
  const socketPath =
    platform === 'win32' ? `\\\\.\\pipe\\sprintengine-askpass-${randomBytes(8).toString('hex')}` : join(dir, 'a.sock')

  const tokens = new Map<string, string>()
  const open = new Set<Socket>()
  const server: Server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => undefined)
    let buffer = ''
    const controller = new AbortController()
    socket.on('close', () => controller.abort())
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 16_384) {
        socket.destroy()
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.off('data', onData)
      let message: { token?: unknown; prompt?: unknown; askpass?: unknown }
      try {
        message = JSON.parse(buffer.slice(0, newline)) as typeof message
      } catch {
        socket.destroy()
        return
      }
      const label = typeof message.token === 'string' ? tokens.get(message.token) : undefined
      if (!label || typeof message.prompt !== 'string') {
        log('An askpass request came with no token this app issued; refused.')
        socket.destroy()
        return
      }
      const classified = classifyPrompt(message.prompt, typeof message.askpass === 'string' ? message.askpass : '', {
        remoteMarked: options.remoteMarked?.() ?? true,
      })
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      void options
        .ask({ ...classified, label }, controller.signal)
        .catch(() => null)
        .then((answer) => {
          clearTimeout(timer)
          if (socket.destroyed) return
          socket.end(`${JSON.stringify({ answer: controller.signal.aborted ? null : answer })}\n`)
        })
    }
    socket.on('data', onData)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  if (platform !== 'win32') chmodSync(socketPath, 0o600)

  return {
    issue(label) {
      const token = randomBytes(32).toString('base64url')
      tokens.set(token, label)
      return { env: { program, socket: socketPath, token }, revoke: () => tokens.delete(token) }
    },
    close() {
      tokens.clear()
      for (const socket of open) socket.destroy()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
