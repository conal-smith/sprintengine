// What the app sets for a CLI it starts in the background, for a check the
// person never asked for: `--version` detection, `grok models`, the handshake
// that lists `/` commands.
//
// Grok checks for a newer version of itself, and installs it, every time it
// starts, unless GROK_DISABLE_AUTOUPDATER is set. Started by a check, that
// update would run unseen, open npm's console window on Windows, and race the
// CLI's own Update action. A chat the person starts, and `grok update`, keep
// the person's environment, so Grok updates there as it is configured to.
const PROBE_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  grok: { GROK_DISABLE_AUTOUPDATER: '1' },
}

/** The variables a background check of `cli` sets on top of the environment it runs with; empty for most CLIs. */
export function cliProbeEnv(cli: string): Readonly<Record<string, string>> {
  return Object.hasOwn(PROBE_ENV, cli) ? PROBE_ENV[cli] : {}
}
