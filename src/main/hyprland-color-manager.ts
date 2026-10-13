import { execFileSync } from 'node:child_process'
import type { App } from 'electron'

/**
 * Hyprland 0.48.0 added the wp-color-manager-v1 Wayland protocol advertising
 * FEATURE_SET_PRIMARIES while rejecting set_primaries outside its debug mode.
 * Chromium treats the rejection as a fatal protocol error, so on those releases
 * the window opens and the app dies a moment later. 0.51.0 accepts the call.
 * Chromium's own use of the protocol is behind a feature, and turning it off
 * before the app is ready is the whole workaround.
 */
const COLOR_MANAGER_FEATURE = 'WaylandWpColorManagerV1'

// Only stock builds of the affected releases count. Matching the commit as
// well as the tag keeps a later development build that still reports an old
// version (a distribution packaging from git) on the default.
const AFFECTED_RELEASE_COMMITS: ReadonlyMap<string, string> = new Map([
  ['0.48.0', '5ee35f914f921e5696030698e74fb5566a804768'],
  ['0.48.1', '29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc'],
  ['0.49.0', '9958d297641b5c84dcff93f9039d80a5ad37ab00'],
  ['0.50.0', 'c4a4c341568944bd4fb9cd503558b2de602c0213'],
  ['0.50.1', '4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc'],
])

export type ColorManagerSwitchInput = {
  env: NodeJS.ProcessEnv
  /** The resolved `--ozone-platform`, which Electron fills in before app code runs. */
  ozonePlatform: string
  enableFeatures: string
  disableFeatures: string
  readHyprctlVersion: () => string
}

// Chromium feature entries look like `*Name<Trial.Group:param/value`.
function featureNames(list: string): string[] {
  return list.split(',').flatMap((entry) => entry.trim().match(/^\*?([^<:]+)/)?.[1] ?? [])
}

// A stale HYPRLAND_INSTANCE_SIGNATURE is often inherited into other desktops,
// so only the session's desktop names are trusted.
function isHyprlandSession(env: NodeJS.ProcessEnv): boolean {
  const desktops = env.XDG_CURRENT_DESKTOP?.trim() || env.XDG_SESSION_DESKTOP?.trim() || ''
  return desktops.split(':').some((name) => name.trim().toLowerCase() === 'hyprland')
}

function isAffectedRelease(readHyprctlVersion: () => string): boolean {
  try {
    const parsed: unknown = JSON.parse(readHyprctlVersion())
    if (!parsed || typeof parsed !== 'object') return false
    const { version, tag, commit, dirty } = parsed as Record<string, unknown>
    return (
      typeof version === 'string' &&
      AFFECTED_RELEASE_COMMITS.get(version) === commit &&
      tag === `v${version}` &&
      dirty === false
    )
  } catch {
    return false
  }
}

/**
 * The `--disable-features` value to set before the app is ready, or null to
 * leave the command line alone. Any probe failure, or a person who named the
 * feature themselves, keeps Chromium's default.
 */
export function colorManagerDisableFeatures(input: ColorManagerSwitchInput): string | null {
  if (input.ozonePlatform !== 'wayland' || !isHyprlandSession(input.env)) return null
  if (featureNames(input.enableFeatures).includes(COLOR_MANAGER_FEATURE)) return null
  if (featureNames(input.disableFeatures).includes(COLOR_MANAGER_FEATURE)) return null
  if (!isAffectedRelease(input.readHyprctlVersion)) return null
  return input.disableFeatures ? `${input.disableFeatures},${COLOR_MANAGER_FEATURE}` : COLOR_MANAGER_FEATURE
}

/** Must run before `ready`; a no-op everywhere but a native Wayland Hyprland session. */
export function avoidHyprlandColorManagerCrash(app: Pick<App, 'commandLine'>): void {
  if (process.platform !== 'linux') return
  const { commandLine } = app
  const disableFeatures = colorManagerDisableFeatures({
    env: process.env,
    ozonePlatform: commandLine.getSwitchValue('ozone-platform'),
    enableFeatures: commandLine.getSwitchValue('enable-features'),
    disableFeatures: commandLine.getSwitchValue('disable-features'),
    // Reached only on a Hyprland Wayland session, and bounded: a hung
    // compositor socket must not hold up the app's start.
    readHyprctlVersion: () =>
      execFileSync('hyprctl', ['version', '-j'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        maxBuffer: 64 * 1024,
      }),
  })
  // Chromium keeps only the last --disable-features, so the merged list goes in.
  if (disableFeatures !== null) commandLine.appendSwitch('disable-features', disableFeatures)
}
