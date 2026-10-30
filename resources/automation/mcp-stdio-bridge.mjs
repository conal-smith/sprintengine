#!/usr/bin/env node
// SprintEngine Studio MCP stdio bridge.
//
// SprintEngine Studio listens on a Unix domain socket / Windows named pipe speaking MCP's stdio
// framing (newline-delimited JSON-RPC 2.0). Stock MCP clients speak stdio, so
// this script is the adapter: it finds the running server and carries
// stdin/stdout to it line for line. The one piece of protocol it knows is
// what a reconnect needs: when the Studio server restarts under a running
// agent, the bridge reconnects and replays the client's `initialize`, so the
// agent keeps its Studio tools (runLocal).
//
// Two transports, one behaviour on stdio:
//
//   LOCAL (default) — the Unix socket / named pipe on this machine.
//
//     claude mcp add sprintengine-studio -- node /path/to/mcp-stdio-bridge.mjs
//
//   REMOTE — a Studio on another tailnet machine, over the opt-in tailnet
//   listener. Frames are the same; the transport underneath is a
//   WebSocket, because that is the channel that holds connection state (the
//   `sprintengine.studio/connect` declaration) and carries server-initiated
//   notifications such as `notifications/tools/list_changed`.
//
//     # once, on this machine, with the pairing URL from the other machine's
//     # Settings → Remote (QR or "copy pairing link"):
//     node mcp-stdio-bridge.mjs pair \
//       --pairing-url 'sprintengine-tailnet://pair?endpoint=100.x.y.z:8471&token=mcpair_...' \
//       --token-file ~/.sprintengine/mac-mini.json
//
//     # then register the remote Studio like any other MCP server:
//     claude mcp add sprintengine-studio-mac-mini -- \
//       node /path/to/mcp-stdio-bridge.mjs --token-file ~/.sprintengine/mac-mini.json
//
// The device token is read from a file (or `SPRINTENGINE_TAILNET_TOKEN`) and never
// from argv: process arguments are visible to every user on the machine via
// `ps`, and MCP clients echo the command they launched into their own logs.
//
// Resolution order for the canonical discovery file in LOCAL mode (with a
// legacy filename fallback):
//   1. --info-path <file>          explicit override (tests, extra profiles)
//   2. $SPRINTENGINE_USER_DATA_DIR the same override the dev app honors
//   3. the default studio userData dir for this platform
//
// Dev instances launched with SPRINTENGINE_USER_DATA_DIR must pass the same env
// var (or --info-path) to the bridge; the default dir is the packaged app's.
//
// Standalone by design: only node: builtins, runs on any recent Node.

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

// The app's own variables. An empty value counts as unset, which is what every
// call site here already assumed.
const studioEnv = (name) => process.env[name] || ''

const INFO_FILENAMES = ['sprintengine-studio-mcp-info.json', 'automation-server-info.json']

// Kept in step with src/main/automation/tailnet/tailnet-gateway-server.ts.
const TAILNET_ROUTE_PREFIX = '/tailnet/v1'
const TAILNET_PAIR_PATH = `${TAILNET_ROUTE_PREFIX}/pair`
const TAILNET_WS_TICKET_PATH = `${TAILNET_ROUTE_PREFIX}/ws-ticket`
const TAILNET_STREAM_PATH = `${TAILNET_ROUTE_PREFIX}/stream`
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** The listener's per-message cap; refuse locally rather than have the socket killed mid-session. */
const MAX_MESSAGE_BYTES = 1024 * 1024
/** Private-range close code the listener sends when a device is revoked mid-stream. */
const WEBSOCKET_CLOSE_REVOKED = 4401
/**
 * How long the pairing, ticket, and handshake exchanges may take.
 *
 * It applies to CONNECTING only, never to the established session: an MCP
 * session is idle most of its life, so an idle timeout on the stream would
 * kill healthy connections. A wrong port that accepts TCP and then says
 * nothing would otherwise hang a stock MCP client at startup with no output
 * at all, which is the worst failure this script can produce.
 */
const CONNECT_TIMEOUT_MS = 15_000
const PAIRING_URL_SCHEME = 'sprintengine-tailnet:'

const USAGE = [
  'Usage:',
  '  mcp-stdio-bridge.mjs [--info-path <sprintengine-studio-mcp-info.json>]',
  '  mcp-stdio-bridge.mjs [--remote <host:port>] --token-file <path>',
  "  mcp-stdio-bridge.mjs pair --pairing-url '<sprintengine-tailnet://pair?...>' --token-file <path> [--device-name <name>]",
].join('\n')

function fail(message) {
  process.stderr.write(`sprintengine-studio-mcp-bridge: ${message}\n`)
  process.exit(1)
}

const KNOWN_FLAGS = ['--info-path', '--remote', '--token-file', '--device-name', '--pairing-url']

/** Parse argv into an optional command plus flag values. Unknown arguments are refused, never ignored. */
function parseArgs(argv) {
  const values = {}
  let command = 'serve'
  let index = 0
  if (argv[0] === 'pair') {
    command = 'pair'
    index = 1
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index]
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (!KNOWN_FLAGS.includes(name)) fail(`Unknown argument "${arg}".\n${USAGE}`)
    let value
    if (equals === -1) {
      value = argv[index + 1]
      index += 1
    } else {
      value = arg.slice(equals + 1)
    }
    if (!value) fail(`${name} needs a value.\n${USAGE}`)
    values[name] = value
  }
  return { command, values }
}

// Electron derives userData from package.json's `name` ("sprintengine-studio").
// The productName spelling is kept as a fallback for case-sensitive
// filesystems in case a future release promotes productName to the app name.
function defaultUserDataDirs() {
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support')
    return [join(base, 'sprintengine-studio'), join(base, 'SprintEngine Studio')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? [join(appData, 'sprintengine-studio'), join(appData, 'SprintEngine Studio')] : []
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return [join(configHome, 'sprintengine-studio'), join(configHome, 'SprintEngine Studio')]
}

function resolveInfoPath(explicit) {
  if (explicit) return explicit
  const envDir = studioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim()
  if (envDir) {
    const candidates = INFO_FILENAMES.map((filename) => join(envDir, filename))
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
  }
  const candidates = defaultUserDataDirs().flatMap((dir) => INFO_FILENAMES.map((filename) => join(dir, filename)))
  if (candidates.length === 0) fail('Could not resolve the SprintEngine Studio data directory; pass --info-path.')
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function readServerInfo(infoPath) {
  let raw
  try {
    raw = readFileSync(infoPath, 'utf8')
  } catch {
    fail(`No Studio MCP discovery file at ${infoPath}. ` + 'SprintEngine Studio is not running yet.')
  }
  let info
  try {
    info = JSON.parse(raw)
  } catch {
    fail(`Discovery file ${infoPath} is not valid JSON; restart SprintEngine Studio to rewrite it.`)
  }
  if (typeof info.socketPath !== 'string' || info.socketPath.length === 0) {
    fail(`Discovery file ${infoPath} has no socketPath; restart SprintEngine Studio to rewrite it.`)
  }
  return info
}

function appearsAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not ours to signal.
    return error && error.code === 'EPERM' ? true : false
  }
}

/**
 * The connection metadata both transports accept, identical on each. The ids
 * are a claim; the launch token beside them is the proof: Studio issued it to
 * the launch that started this agent, and takes the agent's identity from it.
 * Only the local socket is sent it — a token means nothing on another machine.
 */
function connectFrameBody({ withLaunchToken = false } = {}) {
  const launchToken = withLaunchToken ? studioEnv(CHANNEL_TOKEN_ENV).trim() : ''
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'sprintengine.studio/connect',
    params: {
      workspaceId: studioEnv('SPRINTENGINE_WORKSPACE_ID'),
      agentId: studioEnv('SPRINTENGINE_AGENT_ID'),
      agentName: studioEnv('SPRINTENGINE_AGENT_NAME'),
      cliId: studioEnv('SPRINTENGINE_AGENT_CLI'),
      ...(launchToken ? { launchToken } : {}),
    },
  })
}

// Inside a WSL distribution the socket is the app's helper, which opens a
// channel to the app only for a bridge started by one of the app's own live
// launches: that launch's token, inherited from the CLI, goes first. A bridge
// started any other way has none and is told so, rather than being dropped
// without a word.
const CHANNEL_TOKEN_ENV = 'SPRINTENGINE_MCP_CHANNEL_TOKEN'

function channelAuthLine(info) {
  if (info.channelAuth !== 'launch-token') return ''
  const token = studioEnv(CHANNEL_TOKEN_ENV).trim()
  if (!token) {
    fail(
      `This MCP bridge was not started by a SprintEngine Studio launch (${CHANNEL_TOKEN_ENV} is not set), ` +
        'so the app will not accept it. Start the agent from SprintEngine Studio.',
    )
  }
  return `${JSON.stringify({ t: 'auth', token })}\n`
}

// How often a bridge looks for Studio again after its gateway goes: soon at
// first (the Studio server is supervised, and usually back within seconds),
// then less often, never giving up. The app may have crashed or quit and be
// started again minutes later; an MCP client marks a stdio server that exits
// "not connected" for the rest of its session, so the bridge stays for as
// long as its client does (stdin open) and picks Studio up whenever it is back.
const RECONNECT_POLL_MS = 250
const RECONNECT_POLL_MAX_MS = 5_000
// The id the bridge's own replayed `initialize` carries, so its answer is
// recognised and kept from the client, which already had one.
const REPLAY_ID_PREFIX = '__studio_reinitialize_'

/**
 * Local mode: the gateway's socket, and across a restart of the Studio server
 * a new one. The MCP client sees one session throughout:
 *
 *   1. the bridge keeps the client's `initialize` and the
 *      `notifications/initialized` after it;
 *   2. when the socket closes, every request still waiting is answered with
 *      an error ("Studio restarted; retry"), and so is anything sent before
 *      Studio is back;
 *   3. it reconnects once the discovery file names a new process, or the
 *      socket answers again, however long that takes: it leaves only when
 *      the client closes its stdin;
 *   4. on the new socket it says who it is again, replays `initialize`
 *      (swallowing the answer) and `initialized`, then tells the client the
 *      tool list may have changed.
 */
function runLocal(infoPathArg) {
  const infoPath = resolveInfoPath(infoPathArg)
  const firstInfo = readServerInfo(infoPath)
  // Read here, once: a bridge with no launch token for a helper fails at
  // start, as before, rather than on the first reconnect.
  channelAuthLine(firstInfo)

  let socket = null
  // Lines the client sent before the first socket connected: they follow the
  // connect frame, which has to be first on the wire.
  const early = []
  let live = false
  let connectedOnce = false
  let stdinEnded = false
  let reconnecting = false
  let replays = 0
  let saidNotBack = false
  let initializeLine = null
  let initializedLine = null
  const swallow = new Set()
  /** Requests the gateway has not answered yet, by their JSON id. */
  const waiting = new Map()
  let clientBuffer = ''
  let serverBuffer = ''

  const toClient = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  const answerRestarted = (id) =>
    toClient({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: 'SprintEngine Studio restarted; retry the request.' },
    })
  // Sent while Studio is away: the client's request never reached it.
  const answerAway = (id) =>
    toClient({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message:
          'SprintEngine Studio is restarting or not running; retry the request. This MCP server reconnects on its own once Studio is back.',
      },
    })

  function fromClient(line) {
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      // Not JSON: passed on as it came, for the gateway to refuse.
    }
    if (message && typeof message === 'object') {
      if (message.method === 'initialize' && initializeLine === null) initializeLine = message
      if (message.method === 'notifications/initialized' && initializedLine === null) initializedLine = line
      if ('id' in message && typeof message.method === 'string') {
        if (reconnecting) {
          answerAway(message.id)
          return
        }
        waiting.set(JSON.stringify(message.id), message.id)
      }
    }
    if (reconnecting) return
    if (live && socket) socket.write(`${line}\n`)
    else early.push(line)
  }

  function fromServer(line) {
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      // Passed through as it came.
    }
    if (message && typeof message === 'object' && 'id' in message && !('method' in message)) {
      const key = JSON.stringify(message.id)
      if (swallow.has(key)) {
        swallow.delete(key)
        return
      }
      waiting.delete(key)
    }
    process.stdout.write(`${line}\n`)
  }

  // `retry` is the reconnect an attempt belongs to: an attempt that never
  // connects (a new discovery file written before its socket listens, a
  // socket that answered the probe and then went) goes back to waiting,
  // carrying its backoff on, rather than leaving the bridge marked as
  // reconnecting with nothing to reconnect it.
  function open(info, replay, retry = null) {
    const next = connect(info.socketPath)
    socket = next
    let connected = false
    next.on('connect', () => {
      connected = true
      connectedOnce = true
      reconnecting = false
      saidNotBack = false
      const authLine = channelAuthLine(info)
      if (authLine) next.write(authLine)
      // Attribution, proven by the launch token where the launch issued one;
      // the ids beside it are only a claim. Sent first on every connection, the
      // first and each after a restart, with the same token: the restarted
      // server takes the agent's identity from it as the first one did. The
      // server serializes frames per connection, so initialize (replayed or
      // the client's) cannot overtake it.
      next.write(`${connectFrameBody({ withLaunchToken: true })}\n`)
      if (replay) {
        if (initializeLine) {
          const id = `${REPLAY_ID_PREFIX}${++replays}`
          swallow.add(JSON.stringify(id))
          next.write(`${JSON.stringify({ ...initializeLine, id })}\n`)
        }
        if (initializedLine) next.write(`${initializedLine}\n`)
        toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
      live = true
      for (const line of early.splice(0)) next.write(`${line}\n`)
    })
    next.setEncoding('utf8')
    next.on('data', (chunk) => {
      serverBuffer += chunk
      let newline = serverBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = serverBuffer.slice(0, newline)
        serverBuffer = serverBuffer.slice(newline + 1)
        if (line.trim()) fromServer(line)
        newline = serverBuffer.indexOf('\n')
      }
    })
    next.on('error', (error) => {
      if (connected || connectedOnce) return // 'close' follows; it decides.
      const alive = appearsAlive(info.pid)
      if (alive === false) {
        fail(
          `Could not connect to ${info.socketPath} and the recorded app process (pid ${info.pid}) is gone — ` +
            'the discovery file is stale (the app likely crashed). Start SprintEngine Studio.',
        )
      }
      fail(`Could not connect to ${info.socketPath}: ${error.message}`)
    })
    next.on('close', () => {
      if (socket !== next) return
      socket = null
      live = false
      serverBuffer = ''
      // The client went first: this is the end of the session.
      if (stdinEnded) process.exit(0)
      if (!connected) {
        if (!retry) return
        // Said once per reconnect: an MCP client keeps a server's stderr in its log.
        if (!saidNotBack)
          process.stderr.write('sprintengine-studio-mcp-bridge: Studio is not answering yet; still waiting.\n')
        saidNotBack = true
        void reconnect(retry.previous, retry.attempt)
        return
      }
      for (const id of waiting.values()) answerRestarted(id)
      waiting.clear()
      void reconnect(info)
    })
  }

  async function reconnect(previous, attempt = 0) {
    reconnecting = true
    while (!stdinEnded) {
      const delay = Math.min(RECONNECT_POLL_MS * 2 ** Math.min(attempt, 8), RECONNECT_POLL_MAX_MS)
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (stdinEnded) break
      let info = null
      try {
        info = JSON.parse(readFileSync(infoPath, 'utf8'))
      } catch {
        continue // Removed while the server stopped; written again when it is back.
      }
      if (!info || typeof info.socketPath !== 'string') continue
      const restarted = info.pid !== previous.pid
      if (!restarted && !(await socketAnswers(info.socketPath))) continue
      open(info, true, { previous, attempt })
      return
    }
    // The client closed its end while Studio was away: the session is over.
    process.exit(0)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    clientBuffer += chunk
    let newline = clientBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = clientBuffer.slice(0, newline)
      clientBuffer = clientBuffer.slice(newline + 1)
      if (line.trim()) fromClient(line)
      newline = clientBuffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    stdinEnded = true
    if (socket) socket.end()
    else process.exit(0)
  })
  // A client that went without closing stdin shows up as a broken stdout.
  process.stdout.on('error', () => process.exit(0))
  open(firstInfo, false)
}

/** Whether something is listening on the socket now. */
function socketAnswers(socketPath) {
  return new Promise((resolve) => {
    const probe = connect(socketPath)
    const done = (answer) => {
      probe.removeAllListeners()
      probe.destroy()
      resolve(answer)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}

// ---------------------------------------------------------------------------
// Remote mode: the tailnet listener on another machine.
// ---------------------------------------------------------------------------

/** `host:port`, with an IPv6 literal bracketed the way the listener formats it. */
function parseEndpoint(value, source) {
  const trimmed = String(value).trim()
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(trimmed)
  const plain = /^([^:]+):(\d+)$/.exec(trimmed)
  const match = bracketed ?? plain
  if (!match) {
    fail(
      `${source} is not a "host:port" endpoint: "${trimmed}". An IPv6 literal must be bracketed, e.g. [fd7a:115c:a1e0::1]:8471.`,
    )
  }
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`${source} names an invalid port: "${match[2]}".`)
  return { host: match[1], port }
}

function formatEndpoint(endpoint) {
  return endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
}

/**
 * The stored device credential.
 *
 * A file written by `pair` is JSON and carries its endpoint; a file a person
 * pasted a token into is the bare token. Which one it is comes from the first
 * character, not from a guess about the contents.
 */
function readTokenFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    fail(`Could not read the device token file ${path}: ${error.message}. Run "mcp-stdio-bridge.mjs pair" first.`)
  }
  const trimmed = raw.trim()
  if (!trimmed) fail(`The device token file ${path} is empty. Run "mcp-stdio-bridge.mjs pair" to write one.`)
  if (!trimmed.startsWith('{')) {
    if (/\s/.test(trimmed)) fail(`The device token file ${path} is neither pairing JSON nor a single token line.`)
    return { token: trimmed, endpoint: null }
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    fail(`The device token file ${path} starts as JSON but is not valid JSON; re-run "mcp-stdio-bridge.mjs pair".`)
  }
  if (typeof parsed.deviceToken !== 'string' || !parsed.deviceToken) {
    fail(`The device token file ${path} has no deviceToken; re-run "mcp-stdio-bridge.mjs pair".`)
  }
  return { token: parsed.deviceToken, endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : null }
}

function resolveRemoteCredential(values) {
  const envToken = studioEnv('SPRINTENGINE_TAILNET_TOKEN')?.trim()
  const tokenFilePath = values['--token-file'] ?? studioEnv('SPRINTENGINE_TAILNET_TOKEN_FILE')?.trim()
  let token = null
  let storedEndpoint = null
  if (tokenFilePath) {
    const stored = readTokenFile(tokenFilePath)
    token = stored.token
    storedEndpoint = stored.endpoint
  } else if (envToken) {
    token = envToken
  }
  if (!token) {
    fail(
      'Remote mode needs a device token. Pass --token-file <path> (written by "mcp-stdio-bridge.mjs pair") ' +
        'or set SPRINTENGINE_TAILNET_TOKEN. The token is never accepted as a command-line argument.',
    )
  }
  const endpointValue = values['--remote'] ?? storedEndpoint
  if (!endpointValue) {
    fail(
      'Remote mode needs an endpoint: pass --remote <host:port>, or use a token file written by "pair", which records one.',
    )
  }
  return {
    token,
    endpoint: parseEndpoint(endpointValue, values['--remote'] ? '--remote' : "The token file's endpoint"),
  }
}

function requestJson(endpoint, method, path, options = {}) {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8')
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        method,
        path,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body = null
          try {
            body = text ? JSON.parse(text) : null
          } catch {
            body = null
          }
          resolve({ status: response.statusCode ?? 0, body, text })
        })
      },
    )
    request.on('error', reject)
    request.setTimeout(CONNECT_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`no answer within ${CONNECT_TIMEOUT_MS / 1000}s (is this the tailnet listener's port?)`),
      )
    })
    if (payload) request.write(payload)
    request.end()
  })
}

/** The listener's own error message when it sent one, so the client never invents a reason. */
function errorMessageOf(answer, fallback) {
  const message = answer.body && answer.body.error && answer.body.error.message
  return typeof message === 'string' && message ? message : fallback
}

// --- WebSocket client codec (RFC 6455, the slice this transport uses) -------

/** Client frames MUST be masked (RFC 6455 §5.1); the listener refuses unmasked ones. */
function encodeClientFrame(opcode, payload) {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

function encodeClientText(text) {
  return encodeClientFrame(0x1, Buffer.from(text, 'utf8'))
}

function encodeClientClose(code, reason = '') {
  const payload = Buffer.concat([Buffer.alloc(2), Buffer.from(reason, 'utf8').subarray(0, 123)])
  payload.writeUInt16BE(code, 0)
  return encodeClientFrame(0x8, payload)
}

/**
 * Decode frames the listener sends. Server frames are never masked, but the
 * mask bit is honoured anyway because that is what decoding a frame means.
 * Fragmented and binary frames are refused rather than half-handled — the
 * listener sends neither, so receiving one means we are not talking to it.
 */
function createFrameDecoder() {
  let buffer = Buffer.alloc(0)
  return {
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const frames = []
      for (;;) {
        if (buffer.length < 2) return { frames }
        const first = buffer[0]
        const second = buffer[1]
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let length = second & 0x7f
        let offset = 2
        if ((first & 0x70) !== 0)
          return { frames, error: 'The server set reserved frame bits but no extension was negotiated.' }
        if (length === 126) {
          if (buffer.length < offset + 2) return { frames }
          length = buffer.readUInt16BE(offset)
          offset += 2
        } else if (length === 127) {
          if (buffer.length < offset + 8) return { frames }
          const extended = buffer.readBigUInt64BE(offset)
          if (extended > BigInt(MAX_MESSAGE_BYTES))
            return { frames, error: `A server frame exceeds the ${MAX_MESSAGE_BYTES}-byte limit.` }
          length = Number(extended)
          offset += 8
        }
        if (length > MAX_MESSAGE_BYTES)
          return { frames, error: `A server frame exceeds the ${MAX_MESSAGE_BYTES}-byte limit.` }
        const maskLength = masked ? 4 : 0
        if (buffer.length < offset + maskLength + length) return { frames }
        const mask = masked ? buffer.subarray(offset, offset + 4) : null
        offset += maskLength
        const payload = Buffer.from(buffer.subarray(offset, offset + length))
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x0 || !fin)
          return {
            frames,
            error: 'The server sent a fragmented message; this transport carries one JSON-RPC message per frame.',
          }
        if (opcode === 0x1) frames.push({ kind: 'text', text: payload.toString('utf8') })
        else if (opcode === 0x8) {
          frames.push({
            kind: 'close',
            code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
            reason: payload.length > 2 ? payload.subarray(2).toString('utf8') : '',
          })
          return { frames }
        } else if (opcode === 0x9) frames.push({ kind: 'ping', payload })
        else if (opcode === 0xa) frames.push({ kind: 'pong' })
        else
          return {
            frames,
            error: `The server sent opcode 0x${opcode.toString(16)}, which this transport does not carry.`,
          }
      }
    },
  }
}

/** Open the stream socket and complete the RFC 6455 handshake. Resolves with the socket and any bytes already past the header. */
function openStream(endpoint, ticket) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let head = Buffer.alloc(0)
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      // Hand the socket over with no handshake listeners left on it: the
      // stream loop installs its own, and a stale one would answer for it.
      // The connect timeout goes with them — an established MCP session is
      // idle most of the time and must never be timed out for it.
      socket.setTimeout(0)
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        resolve(value)
      }
    }
    const onError = (error) => settle(error)
    const onClose = () => settle(new Error('The server closed the connection during the stream handshake.'))
    const onTimeout = () =>
      settle(new Error(`the stream handshake got no answer within ${CONNECT_TIMEOUT_MS / 1000}s.`))
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const boundary = head.indexOf('\r\n\r\n')
      if (boundary === -1) {
        if (head.length > 64 * 1024) settle(new Error('The server sent an oversized handshake response.'))
        return
      }
      const header = head.subarray(0, boundary).toString('utf8')
      const rest = head.subarray(boundary + 4)
      const [statusLine, ...headerLines] = header.split('\r\n')
      const status = Number(statusLine.split(' ')[1])
      const headers = new Map(
        headerLines.map((line) => {
          const colon = line.indexOf(':')
          return colon === -1
            ? [line.toLowerCase(), '']
            : [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
        }),
      )
      if (status !== 101) {
        const code = headers.get('x-tailnet-error')
        settle(new Error(`The Studio tailnet listener refused the stream (HTTP ${status}${code ? `, ${code}` : ''}).`))
        return
      }
      if (headers.get('sec-websocket-accept') !== expectedAccept) {
        settle(new Error('The stream handshake key did not verify; this endpoint is not the Studio tailnet listener.'))
        return
      }
      settle(null, { socket, leftover: rest })
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.on('timeout', onTimeout)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(ticket)} HTTP/1.1`,
          `Host: ${formatEndpoint(endpoint)}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
  })
}

async function runRemote(values) {
  const { token, endpoint } = resolveRemoteCredential(values)

  let ticketAnswer
  try {
    ticketAnswer = await requestJson(endpoint, 'POST', TAILNET_WS_TICKET_PATH, { token, body: {} })
  } catch (error) {
    fail(`Could not reach the Studio tailnet listener at ${formatEndpoint(endpoint)}: ${error.message}`)
  }
  if (ticketAnswer.status === 401) {
    fail(
      `${formatEndpoint(endpoint)} rejected this device token: ` +
        `${errorMessageOf(ticketAnswer, 'it is not a paired device.')} ` +
        'If the device was revoked in Settings → Remote, pair again to get a new token.',
    )
  }
  if (ticketAnswer.status !== 200 || !ticketAnswer.body || typeof ticketAnswer.body.ticket !== 'string') {
    fail(
      `${formatEndpoint(endpoint)} did not issue a stream ticket (HTTP ${ticketAnswer.status}): ${errorMessageOf(ticketAnswer, 'no reason given')}.`,
    )
  }

  let stream
  try {
    stream = await openStream(endpoint, ticketAnswer.body.ticket)
  } catch (error) {
    fail(`Could not open the MCP stream to ${formatEndpoint(endpoint)}: ${error.message}`)
  }
  const { socket, leftover } = stream

  // Same advisory declaration the local socket gets, and sent first for the
  // same reason: the listener serializes messages per connection, so nothing
  // can overtake it.
  socket.write(encodeClientText(connectFrameBody()))

  const decoder = createFrameDecoder()
  let closing = false

  const finish = (code, message) => {
    if (closing) return
    closing = true
    if (message) process.stderr.write(`sprintengine-studio-mcp-bridge: ${message}\n`)
    socket.destroy()
    // A response frame decoded in the same tick as the close must still reach
    // the client: exiting on a pipe with bytes still queued would drop it. The
    // timer is the backstop for a reader that has stopped draining — a stalled
    // client must not turn a disconnect into a hung process.
    process.stdout.write('', () => process.exit(code))
    setTimeout(() => process.exit(code), 2000).unref()
  }

  const consume = (chunk) => {
    const decoded = decoder.push(chunk)
    for (const frame of decoded.frames) {
      if (frame.kind === 'text') process.stdout.write(`${frame.text}\n`)
      else if (frame.kind === 'ping') socket.write(encodeClientFrame(0xa, frame.payload))
      else if (frame.kind === 'close') {
        // 1000/1001 is the app shutting down: a normal MCP disconnect. Anything
        // else — revocation above all — is a failure the client must see.
        if (frame.code === 1000 || frame.code === 1001) finish(0)
        else if (frame.code === WEBSOCKET_CLOSE_REVOKED) {
          finish(
            1,
            `${formatEndpoint(endpoint)} revoked this device: ${frame.reason || 'access was withdrawn in Settings → Remote.'} Pair again to get a new token.`,
          )
        } else
          finish(
            1,
            `The Studio tailnet listener closed the stream (code ${frame.code})${frame.reason ? `: ${frame.reason}` : '.'}`,
          )
        return
      }
    }
    if (decoded.error) finish(1, decoded.error)
  }

  if (leftover.length) consume(leftover)
  socket.on('data', consume)
  socket.on('error', (error) => finish(1, `The MCP stream to ${formatEndpoint(endpoint)} failed: ${error.message}`))
  // A stream that ends without a close frame is the app going away, which is
  // the same clean disconnect the local socket produces.
  socket.on('close', () => finish(0))

  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line) {
        const bytes = Buffer.byteLength(line, 'utf8')
        if (bytes > MAX_MESSAGE_BYTES) {
          finish(1, `A ${bytes}-byte request exceeds the listener's ${MAX_MESSAGE_BYTES}-byte message limit.`)
          return
        }
        socket.write(encodeClientText(line))
      }
      newline = pending.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    if (closing || socket.destroyed) return
    socket.write(encodeClientClose(1000, 'Client closed stdin.'))
    socket.end()
  })
}

// ---------------------------------------------------------------------------
// Pairing: exchange a one-time pairing URL for a stored device token.
// ---------------------------------------------------------------------------

function parsePairingUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`--pairing-url is not a URL. Copy the pairing link from the other machine's Settings → Remote.`)
  }
  if (url.protocol !== PAIRING_URL_SCHEME) {
    fail(
      `--pairing-url must be a ${PAIRING_URL_SCHEME}//pair link from the other machine's Settings → Remote, not "${url.protocol}//".`,
    )
  }
  const endpointValue = url.searchParams.get('endpoint')
  const pairingToken = url.searchParams.get('token')
  if (!endpointValue || !pairingToken) fail('--pairing-url is missing its endpoint or code; copy the whole link.')
  return { endpoint: parseEndpoint(endpointValue, "The pairing link's endpoint"), pairingToken }
}

async function runPair(values) {
  const urlValue = values['--pairing-url'] ?? studioEnv('SPRINTENGINE_TAILNET_PAIRING_URL')?.trim()
  if (!urlValue) fail(`pair needs --pairing-url (or SPRINTENGINE_TAILNET_PAIRING_URL).\n${USAGE}`)
  const tokenFilePath = values['--token-file'] ?? studioEnv('SPRINTENGINE_TAILNET_TOKEN_FILE')?.trim()
  if (!tokenFilePath)
    fail(`pair needs --token-file <path>: the device token it receives is written there and nowhere else.\n${USAGE}`)
  const { endpoint, pairingToken } = parsePairingUrl(urlValue)
  const deviceName = (values['--device-name'] ?? hostname() ?? '').trim()
  if (!deviceName)
    fail("Could not determine this machine's name; pass --device-name so the pairing is identifiable in Settings.")

  let answer
  try {
    answer = await requestJson(endpoint, 'POST', TAILNET_PAIR_PATH, { body: { pairingToken, deviceName } })
  } catch (error) {
    fail(`Could not reach the Studio tailnet listener at ${formatEndpoint(endpoint)}: ${error.message}`)
  }
  if (answer.status !== 200 || !answer.body || typeof answer.body.deviceToken !== 'string') {
    fail(
      `Pairing with ${formatEndpoint(endpoint)} failed (HTTP ${answer.status}): ${errorMessageOf(answer, 'no reason given')}`,
    )
  }

  const record = {
    version: 1,
    endpoint: formatEndpoint(endpoint),
    deviceId: answer.body.deviceId,
    deviceName: answer.body.deviceName,
    deviceToken: answer.body.deviceToken,
    scopes: Array.isArray(answer.body.scopes) ? answer.body.scopes : [],
    pairedAt: new Date().toISOString(),
  }
  try {
    mkdirSync(dirname(tokenFilePath), { recursive: true, mode: 0o700 })
    writeFileSync(tokenFilePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tokenFilePath, 0o600)
  } catch (error) {
    // The device exists on the desktop now; saying "paired" while the token is
    // unrecoverable would be the worst of both. Say what happened and how to
    // undo it.
    fail(
      `Paired with ${formatEndpoint(endpoint)}, but the device token could not be written to ${tokenFilePath}: ${error.message}. ` +
        'Revoke this device in Settings → Remote and pair again to a writable path.',
    )
  }

  // Never the token itself: this is a terminal a person is looking at, and
  // scrollback is a log.
  process.stdout.write(
    [
      `Paired with ${formatEndpoint(endpoint)} as "${record.deviceName}" (${record.deviceId}).`,
      `Scopes: ${record.scopes.length ? record.scopes.join(', ') : '(none)'}`,
      `Device token written to ${tokenFilePath} (mode 0600).`,
      '',
      'Register the remote Studio with an MCP client:',
      `  claude mcp add sprintengine-studio-remote -- node ${process.argv[1]} --token-file ${tokenFilePath}`,
      '',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------

const { command, values } = parseArgs(process.argv.slice(2))

// An argument that belongs to the other command is refused, not ignored: a
// silently dropped flag is a person believing they configured something.
const PAIR_ONLY_FLAGS = ['--pairing-url', '--device-name']
const SERVE_ONLY_FLAGS = ['--info-path', '--remote']
for (const flag of command === 'pair' ? SERVE_ONLY_FLAGS : PAIR_ONLY_FLAGS) {
  if (values[flag]) fail(`${flag} does not apply to "${command === 'pair' ? 'pair' : 'serving stdio'}".\n${USAGE}`)
}

if (command === 'pair') {
  await runPair(values)
} else if (
  values['--remote'] ||
  values['--token-file'] ||
  studioEnv('SPRINTENGINE_TAILNET_TOKEN') ||
  studioEnv('SPRINTENGINE_TAILNET_TOKEN_FILE')
) {
  if (values['--info-path'])
    fail(`--info-path is local-socket mode and --remote/--token-file is tailnet mode; pass one.\n${USAGE}`)
  await runRemote(values)
} else {
  runLocal(values['--info-path'])
}
