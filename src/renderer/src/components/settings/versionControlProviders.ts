// The version-control settings sections, as data. DOM-free and
// component-free so the probe → row mapping is unit-tested without a renderer.
//
// Two things live here, and both exist to stop the sections from drifting into
// fiction:
//
//  1. **The spec table is the row universe.** Sections are built by walking
//     `VERSION_CONTROL_PROVIDER_IDS` (the ids the main-process probe actually
//     answers for) and picking up each id's spec. A forge the product does not
//     integrate has no id, therefore no spec, therefore no row — there is no
//     path here that renders a placeholder or disabled row for something the
//     app cannot detect or talk to.
//  2. **The row view is a closed set of states.** Every probe outcome maps onto
//     exactly one `VersionControlRowView`, so "resolved but not logged in" and
//     "we never got an answer" cannot collapse into the same row as "missing".

import {
  VERSION_CONTROL_PROVIDER_IDS,
  type VersionControlProviderId,
  type VersionControlProviderProbe,
} from '../../../../shared/version-control'
import type { StatusTone } from '../ui/tokens'

// Two genuinely different groups, which is what earns them titles: the version
// control system itself, then the hosting provider it pushes to.
type VersionControlSectionId = 'vcs' | 'forge'

export type VersionControlProviderSpec = {
  id: VersionControlProviderId
  /** Row name. */
  label: string
  /** The binary, named on a state line that has to say what is missing. */
  binary: string
  /** Mono mark. The repo ships no brand logo for any provider, and a two-or
   *  three-letter mono monogram is the house stand-in (see `Monogram` in
   *  TrackerConnectionsTab); it reads as the binary's own name rather than as a
   *  decorative glyph. */
  monogram: string
  section: VersionControlSectionId
  /** The one command that installs it, keyed by `window.api.platform`. A
   *  platform whose package manager cannot be named honestly (Linux: apt, dnf,
   *  pacman, and the rest) is absent rather than guessed — the row then names
   *  the missing binary instead of printing a command that would fail. */
  installCommand: Partial<Record<string, string>>
  /** Set only for a provider that carries its own auth, which is what makes
   *  "installed but not logged in" a state it can be in. */
  authCommand?: string
}

const PROVIDER_SPECS: Record<VersionControlProviderId, VersionControlProviderSpec> = {
  git: {
    id: 'git',
    label: 'Git',
    binary: 'git',
    monogram: 'git',
    section: 'vcs',
    installCommand: { darwin: 'brew install git', win32: 'winget install Git.Git' },
  },
  gh: {
    id: 'gh',
    label: 'GitHub',
    binary: 'gh',
    monogram: 'gh',
    section: 'forge',
    installCommand: { darwin: 'brew install gh', win32: 'winget install GitHub.cli' },
    authCommand: 'gh auth login',
  },
  glab: {
    id: 'glab',
    label: 'GitLab',
    binary: 'glab',
    monogram: 'gl',
    section: 'forge',
    installCommand: { darwin: 'brew install glab', win32: 'winget install glab.glab' },
    authCommand: 'glab auth login',
  },
  // tea answers for Forgejo and Codeberg too, which share Gitea's API. No
  // Windows command: tea ships there as a download, not a package.
  tea: {
    id: 'tea',
    label: 'Gitea and Forgejo',
    binary: 'tea',
    monogram: 'tea',
    section: 'forge',
    installCommand: { darwin: 'brew install tea' },
    authCommand: 'tea login add',
  },
}

const SECTION_TITLES: Record<VersionControlSectionId, string> = {
  vcs: 'Version control',
  forge: 'Source control providers',
}

export type VersionControlSection = {
  id: VersionControlSectionId
  title: string
  providers: VersionControlProviderSpec[]
}

/** The sections to render, in order, containing only providers the probe
 *  answers for. A section that resolves to no provider is dropped: a heading
 *  over nothing groups nothing. */
export function versionControlSections(): VersionControlSection[] {
  const order: VersionControlSectionId[] = ['vcs', 'forge']
  return order
    .map((id) => ({
      id,
      title: SECTION_TITLES[id],
      providers: VERSION_CONTROL_PROVIDER_IDS.map((providerId) => PROVIDER_SPECS[providerId]).filter(
        (spec) => spec.section === id,
      ),
    }))
    .filter((section) => section.providers.length > 0)
}

export function versionControlProviderSpec(id: VersionControlProviderId): VersionControlProviderSpec {
  return PROVIDER_SPECS[id]
}

/** Where the tab's single probe round-trip currently stands. Mirrors the agent
 *  CLI list's `CliProbeStatus` so the two surfaces reason about an in-flight
 *  check the same way. */
export type VersionControlProbeStatus = 'loading' | 'ready' | 'error'

export type VersionControlRowView =
  | { kind: 'checking'; tone: StatusTone; version: null }
  /** Resolved, and it has no auth of its own to report (git). */
  | { kind: 'available'; tone: StatusTone; version: string }
  | { kind: 'authenticated'; tone: StatusTone; version: string; login: string }
  /** Resolved, carries auth, and that auth resolved to no login. */
  | { kind: 'unauthenticated'; tone: StatusTone; version: string; command: string }
  | {
      kind: 'not-installed'
      tone: StatusTone
      version: null
      binary: string
      /** Null on a platform whose install command cannot be named honestly. */
      command: string | null
      /** True where installing is only half the job, so the line ends on the
       *  work that remains rather than implying one command finishes it. */
      thenAuthenticate: boolean
    }
  | { kind: 'probe-failed'; tone: StatusTone; version: null }

/**
 * The one reading of "what is true about this provider right now".
 *
 * A provider with a probe result is decided, whatever the batch is doing now: a
 * re-check must not flip a settled row back to "Checking…" (the same rule the
 * agent CLI rows follow). Only a provider with no result yet reads from
 * `status`, and a failed round-trip is `probe-failed` — never `not-installed`,
 * because "we could not ask" and "it is not there" lead to different actions.
 */
export function resolveVersionControlRow(
  spec: VersionControlProviderSpec,
  probe: VersionControlProviderProbe | undefined,
  status: VersionControlProbeStatus,
  platform: string,
): VersionControlRowView {
  if (probe?.resolved === true) {
    if (!spec.authCommand) return { kind: 'available', tone: 'good', version: probe.version }
    return probe.auth
      ? { kind: 'authenticated', tone: 'good', version: probe.version, login: probe.auth.login }
      : {
          kind: 'unauthenticated',
          tone: 'warn',
          version: probe.version,
          command: spec.authCommand,
        }
  }
  if (probe?.resolved === false && probe.reason === 'not_installed') {
    return {
      kind: 'not-installed',
      tone: 'warn',
      version: null,
      binary: spec.binary,
      command: spec.installCommand[platform] ?? null,
      thenAuthenticate: Boolean(spec.authCommand),
    }
  }
  if (probe) return { kind: 'probe-failed', tone: 'error', version: null }
  if (status === 'loading') return { kind: 'checking', tone: 'neutral', version: null }
  // Ready or errored with no entry for this id: the round-trip did not answer
  // for it, which is the same non-answer a failed probe is.
  return { kind: 'probe-failed', tone: 'error', version: null }
}

/**
 * The state line in words, with no markup. The row renders the identifiers mono
 * (see `VersionControlStateLine`), so this exists for tests and for anywhere the
 * line has to be a plain string — and it is what keeps the state readable when
 * the dot's colour is unavailable.
 */
export function versionControlStateWords(view: VersionControlRowView): string {
  switch (view.kind) {
    case 'checking':
      return 'Checking…'
    case 'available':
      return 'Available'
    case 'authenticated':
      return `Authenticated as ${view.login}`
    case 'unauthenticated':
      return `Not authenticated — ${view.command}`
    case 'not-installed':
      return view.command
        ? `Not installed — ${view.command}${view.thenAuthenticate ? ', then authenticate' : ''}`
        : `Not installed — no ${view.binary} on PATH`
    case 'probe-failed':
      return 'Availability unknown — the check did not complete'
  }
}
