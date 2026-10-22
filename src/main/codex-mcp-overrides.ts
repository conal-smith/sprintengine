// An MCP server handed to Codex as a `-c mcp_servers.<id>=<table>` override
// rides Codex's command line, which every user of the machine can read (`ps`).
// A server's `env` values and HTTP headers are where its secrets sit, so they
// travel in Codex's environment instead, which only the same user can read, and
// the table names the variables that hold them: `env_vars` for a stdio server
// (Codex hands the named variables from its own environment to the server) and
// `env_http_headers` for an HTTP one (header name to the variable holding its
// value). Both keys are Codex's own (codex-cli 0.161.0 config schema).

import type { ConversationMcpServer } from '../shared/conversation-runtime'
import { MCP_SECRET_ENV_PREFIX } from '../shared/studio-env'

/** The fields of a server this file renders; both the chat and the terminal launch shapes have them. */
export type CodexMcpServerFields = Pick<
  ConversationMcpServer,
  'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'envVarNames'
>

/**
 * What one launch's servers put in the child's environment. `base` is the
 * environment the child starts from: a server variable it already sets to
 * something else stays in the table, since overriding it would change what
 * the CLI itself, and every server it starts, sees.
 */
export type CodexMcpEnv = {
  readonly base: Readonly<Record<string, string | undefined>>
  readonly env: Record<string, string>
}

export function codexMcpEnv(base: Readonly<Record<string, string | undefined>>): CodexMcpEnv {
  return { base, env: {} }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

// Variables that steer how a process runs, or that Studio or Codex set
// themselves. A server value under one of these names stays in its table: in
// the CLI's own environment it would change the CLI, not just the server.
const STEERING_ENV =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|TERM|COLORTERM|FORCE_HYPERLINK|TMPDIR|TMP|TEMP|LANG|WSLENV|COMSPEC|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA)$|^(?:LC_|NODE_|NPM_|LD_|DYLD_|ELECTRON_|SPRINTENGINE_|CODEX_|OPENAI_|RUST_|GIT_|SSL_|XDG_)|_PROXY$/iu

/** A value the environment can carry: one line (a WSL child reads each from stdin) with no NUL. */
function carriable(value: string): boolean {
  return !/[\r\n\0]/u.test(value)
}

/** Puts `value` in the environment under `key`, unless that would change a variable already set. */
function carryServerEnv(carrier: CodexMcpEnv, key: string, value: string): boolean {
  if (!ENV_NAME.test(key) || STEERING_ENV.test(key) || !carriable(value)) return false
  const already = carrier.base[key]
  if (already !== undefined && already !== value) return false
  const taken = carrier.env[key]
  if (taken !== undefined && taken !== value) return false
  carrier.env[key] = value
  return true
}

/** Puts a header value in the environment under a fresh name of Studio's own; null when it cannot go there. */
function carryHeader(carrier: CodexMcpEnv, value: string): string | null {
  if (!carriable(value)) return null
  let index = 1
  while (`${MCP_SECRET_ENV_PREFIX}${index}` in carrier.env) index += 1
  const name = `${MCP_SECRET_ENV_PREFIX}${index}`
  carrier.env[name] = value
  return name
}

/** A TOML basic string. JSON's escapes are a subset TOML reads the same way. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function tomlInlineTable(entries: ReadonlyArray<readonly [string, string]>): string {
  return `{ ${entries.map(([key, value]) => `${tomlString(key)} = ${value}`).join(', ')} }`
}

function tomlList(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

/**
 * The fields of one server's Codex table, each `[key, TOML value]`, with its
 * env values and header values moved into `carrier.env`. Anything that cannot
 * move (a multi-line value, a name the CLI itself reads) is written inline as
 * before.
 */
export function codexMcpServerFields(server: CodexMcpServerFields, carrier: CodexMcpEnv): Array<[string, string]> {
  const fields: Array<[string, string]> = []
  if (server.transport === 'stdio') {
    fields.push(['command', tomlString(server.command ?? '')])
    if (server.args?.length) fields.push(['args', tomlList(server.args)])
    const names = [...(server.envVarNames ?? [])]
    const inline: Array<[string, string]> = []
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (carryServerEnv(carrier, key, value)) {
        if (!names.includes(key)) names.push(key)
      } else inline.push([key, tomlString(value)])
    }
    if (names.length > 0) fields.push(['env_vars', tomlList(names)])
    if (inline.length > 0) fields.push(['env', tomlInlineTable(inline)])
    return fields
  }
  fields.push(['url', tomlString(server.url ?? '')])
  if (server.envVarNames?.length) fields.push(['bearer_token_env_var', tomlString(server.envVarNames[0])])
  const inline: Array<[string, string]> = []
  const byName: Array<[string, string]> = []
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (server.envVarNames?.length && key.toLowerCase() === 'authorization') continue
    const name = carryHeader(carrier, value)
    if (name) byName.push([key, tomlString(name)])
    else inline.push([key, tomlString(value)])
  }
  if (inline.length > 0) fields.push(['http_headers', tomlInlineTable(inline)])
  if (byName.length > 0) fields.push(['env_http_headers', tomlInlineTable(byName)])
  return fields
}
