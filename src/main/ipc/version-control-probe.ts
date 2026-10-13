// Maps probe outcomes onto the version-control provider contract the renderer
// reads. Kept free of Electron and of the gh runner so the mapping is
// unit-testable without spawning anything; version-control-ipc.ts wires the
// real probes in.

import {
  VERSION_CONTROL_PROVIDER_IDS,
  type VersionControlProviderId,
  type VersionControlProviderProbe,
} from '../../shared/version-control'
import { isRecord } from '../../shared/records'
import type { BinaryVersionProbe } from '../cli-runtime-install'

export type VersionControlProbeDeps = {
  // Each provider id is also the binary it probes, so the only values that ever
  // reach a spawn are the frozen ids above — nothing from the renderer.
  probeVersion(binary: VersionControlProviderId): Promise<BinaryVersionProbe>
  // The login gh's own auth resolves to, or null when gh is not authenticated.
  readGhLogin(): Promise<string | null>
  // The same for GitLab's `glab` and Gitea's `tea`: the account their own
  // auth resolves to, or null when they hold none.
  readForgeLogin(binary: 'glab' | 'tea'): Promise<string | null>
  // The other machines on this computer that run their own git (the enabled
  // WSL machines on Windows), each with its own probe. Absent or empty on
  // macOS and Linux, where this machine is the only one.
  listGitMachines?(): Promise<Array<{ hostId: string; label: string; probeGit(): Promise<BinaryVersionProbe> }>>
}

export async function probeVersionControlProviders(
  deps: VersionControlProbeDeps,
): Promise<VersionControlProviderProbe[]> {
  const machines = (await deps.listGitMachines?.().catch(() => [])) ?? []
  const [own, others] = await Promise.all([
    Promise.all(VERSION_CONTROL_PROVIDER_IDS.map((id) => probeProvider(id, deps))),
    Promise.all(
      machines.map(async (machine): Promise<VersionControlProviderProbe> => {
        const probe = await machine.probeGit().catch((): BinaryVersionProbe => ({ outcome: 'probe_failed' }))
        const at = { hostId: machine.hostId, label: machine.label }
        return probe.outcome === 'resolved'
          ? { id: 'git', resolved: true, version: probe.version, machine: at }
          : { id: 'git', resolved: false, reason: probe.outcome, machine: at }
      }),
    ),
  ])
  return [...own, ...others]
}

async function probeProvider(
  id: VersionControlProviderId,
  deps: VersionControlProbeDeps,
): Promise<VersionControlProviderProbe> {
  const probe = await deps.probeVersion(id)
  if (probe.outcome !== 'resolved') return { id, resolved: false, reason: probe.outcome }
  // git has no auth of its own to report; the forge CLIs do.
  if (id === 'git') return { id, resolved: true, version: probe.version }
  const login = id === 'gh' ? await deps.readGhLogin() : await deps.readForgeLogin(id)
  return login
    ? { id, resolved: true, version: probe.version, auth: { login } }
    : { id, resolved: true, version: probe.version }
}

// Reads the login out of `gh auth status`. gh has printed this line two ways
// ("Logged in to <host> as <login>" before v2.40, "… account <login>" after),
// and gh has moved the report between stdout and stderr across versions, so
// callers pass both streams. The first login reported wins; gh lists the active
// host first. Only the login is extracted — the token gh masks in the same
// report is never read.
export function parseGhAuthLogin(output: string): string | null {
  const match = /Logged in to \S+ (?:account|as) ([^\s(]+)/.exec(output)
  return match ? match[1] : null
}

// glab words its `auth status` as gh did before v2.40 ("✓ Logged in to
// gitlab.com as dev (…)"), so the same reading serves. Its exit code is not
// read: glab fails the whole report when any one configured host is signed
// out, while another still names an account.
export const parseGlabAuthLogin = parseGhAuthLogin

// The account `tea logins list --output=json` names: the default login's
// user, else the first login's. The listing carries no token.
export function parseTeaLogin(output: string): string | null {
  let rows: unknown
  try {
    rows = JSON.parse(output)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const logins = rows.filter(isRecord).filter((row) => typeof row.user === 'string' && row.user !== '')
  const chosen = logins.find((login) => String(login.default) === 'true') ?? logins[0]
  return chosen ? (chosen.user as string) : null
}
