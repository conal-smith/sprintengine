import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Whether the tailnet listener runs, and on which port.
//
// Off by default, in every build. The local Unix-socket gateway is
// infrastructure and always on; this listener is the opposite — it
// opens a real TCP port carrying ~60 mutating tools, so it exists only after a
// person turns it on, and an unreadable or malformed settings file leaves it
// off rather than guessing an enabled state.

const TAILNET_SETTINGS_FILENAME = 'tailnet-remote-settings.json'

/**
 * Fixed default so peer discovery can probe a known port instead of
 * scanning. Configurable because a machine may already be using it.
 */
export const DEFAULT_TAILNET_LISTENER_PORT = 8471

/**
 * `notifications` (pair-from-the-scan-and-stay-paired, phase 3): whether a
 * pair request arriving, an answer to one this machine made, or a paired
 * machine revoking us raises an OS notification. On by default — the events
 * are rare and each is one a person is waiting on — and absent from an older
 * file reads as on.
 */
export type TailnetSettings = {
  enabled: boolean
  port: number
  notifications: boolean
  /**
   * Whether the listener is also published over HTTPS with Tailscale Serve
   * (`tailnet-gateway-https.ts`), for MCP clients that sign in with OAuth.
   * Off unless a person turned it on: it changes this machine's Serve
   * configuration, which outlives the app. Optional so an older caller's
   * settings object still type-checks; absent reads as off.
   */
  https?: boolean
}

export type TailnetSettingsReadResult = {
  settings: TailnetSettings
  /** Set when the file existed but could not be read or parsed; the listener stays off. */
  error: string | null
}

export function readTailnetSettings(userDataDir: string): TailnetSettingsReadResult {
  const defaults: TailnetSettings = {
    enabled: false,
    port: DEFAULT_TAILNET_LISTENER_PORT,
    notifications: true,
    https: false,
  }
  let raw: string
  try {
    raw = readFileSync(join(userDataDir, TAILNET_SETTINGS_FILENAME), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { settings: defaults, error: null }
    return { settings: defaults, error: `Could not read ${TAILNET_SETTINGS_FILENAME}: ${message(error)}` }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        settings: defaults,
        error: `${TAILNET_SETTINGS_FILENAME} is malformed; tailnet remote control stays off.`,
      }
    }
    const record = parsed as { enabled?: unknown; port?: unknown; notifications?: unknown; https?: unknown }
    return {
      settings: {
        enabled: record.enabled === true,
        port: isUsablePort(record.port) ? record.port : DEFAULT_TAILNET_LISTENER_PORT,
        notifications: record.notifications !== false,
        https: record.https === true,
      },
      error: null,
    }
  } catch (error) {
    return {
      settings: defaults,
      error: `${TAILNET_SETTINGS_FILENAME} is not valid JSON (${message(error)}); tailnet remote control stays off.`,
    }
  }
}

export function writeTailnetSettings(userDataDir: string, settings: TailnetSettings): void {
  const body = `${JSON.stringify(
    {
      enabled: settings.enabled === true,
      port: isUsablePort(settings.port) ? settings.port : DEFAULT_TAILNET_LISTENER_PORT,
      notifications: settings.notifications !== false,
      https: settings.https === true,
    },
    null,
    2,
  )}\n`
  writeFileSync(join(userDataDir, TAILNET_SETTINGS_FILENAME), body, { mode: 0o600 })
}

/** Port 0 is excluded: an ephemeral port cannot be discovered or written down. */
function isUsablePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
