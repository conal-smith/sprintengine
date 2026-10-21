// Read-only version-control provider facts. The version-control
// settings sections render what the local machine actually has: the probed
// `git`, `gh`, `glab` and `tea` binaries and, for each forge CLI, the login
// its own auth resolves to.
// Nothing here is a stored setting, and there is no partially-filled shape —
// a provider we could not resolve says so, and says why.

// The providers the product integrates. A provider the product does not
// integrate has no id here and therefore no row to render — the renderer draws
// exactly what this list resolves to.
// `glab` and `tea` are here because the chat's Create PR drives them, on
// GitLab and on Gitea, Forgejo and Codeberg (`main/forge-pull-request.ts`).
export const VERSION_CONTROL_PROVIDER_IDS = ['git', 'gh', 'glab', 'tea'] as const

export type VersionControlProviderId = (typeof VERSION_CONTROL_PROVIDER_IDS)[number]

// Why a provider carries no version. `not_installed` is a definitive verdict
// the settings row can pair with an install path; `probe_failed` means no
// verdict was reached at all (the probe timed out, could not be spawned, or
// produced output with no version in it) and must not be rendered as either
// installed or missing.
export type VersionControlProbeFailure = 'not_installed' | 'probe_failed'

/**
 * The machine a probe ran on, when it is not this one. On Windows each WSL
 * machine runs its own git (a WSL workspace's git is the distribution's), so
 * the Git row is one row per machine; a probe without this is this machine's.
 */
export type VersionControlProbeMachine = { hostId: string; label: string }

export type VersionControlProviderProbe = (
  | {
      id: VersionControlProviderId
      resolved: true
      // The binary's own `--version` line, verbatim.
      version: string
      // Only for a provider that carries its own auth (the forge CLIs), and
      // only when that auth resolves to a login. Never any token material.
      auth?: { login: string }
    }
  | { id: VersionControlProviderId; resolved: false; reason: VersionControlProbeFailure }
) & { machine?: VersionControlProbeMachine }
