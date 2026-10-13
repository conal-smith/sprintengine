import assert from 'node:assert/strict'

import { VERSION_CONTROL_PROVIDER_IDS } from '../../../../shared/version-control'
import {
  resolveVersionControlRow,
  versionControlProviderSpec,
  versionControlSections,
  versionControlStateWords,
} from './versionControlProviders'
import { test } from 'vitest'

test('versionControlProviders', async () => {
  const git = versionControlProviderSpec('git')
  const gh = versionControlProviderSpec('gh')

  // --- Sections are the probe's id list, nothing more -------------------------

  {
    const sections = versionControlSections()
    assert.deepEqual(
      sections.map((section) => section.title),
      ['Version control', 'Source control providers'],
    )
    const rendered = sections.flatMap((section) => section.providers.map((spec) => spec.id))
    // The row universe IS the probe's id list: a forge the product does not
    // integrate (Bitbucket, Azure DevOps) has no id, so no row can appear for it
    // without the probe contract changing first.
    assert.deepEqual([...rendered].sort(), [...VERSION_CONTROL_PROVIDER_IDS].sort())
    assert.deepEqual(
      sections.map((section) => section.providers.map((spec) => spec.label)),
      [['Git'], ['GitHub', 'GitLab', 'Gitea and Forgejo']],
    )
    // Every section that renders has something in it — a title over nothing
    // groups nothing.
    assert.ok(sections.every((section) => section.providers.length > 0))
  }

  // --- Resolved -------------------------------------------------------------

  {
    const view = resolveVersionControlRow(
      git,
      { id: 'git', resolved: true, version: 'git version 2.50.1 (Apple Git-155)' },
      'ready',
      'darwin',
    )
    assert.equal(view.kind, 'available')
    assert.equal(view.tone, 'good')
    // The binary's own output, verbatim — never re-formatted into a bare semver.
    assert.equal(view.version, 'git version 2.50.1 (Apple Git-155)')
    assert.equal(versionControlStateWords(view), 'Available')
  }

  {
    const view = resolveVersionControlRow(
      gh,
      { id: 'gh', resolved: true, version: 'gh version 2.95.0', auth: { login: 'octocat' } },
      'ready',
      'darwin',
    )
    assert.equal(view.kind, 'authenticated')
    assert.equal(view.tone, 'good')
    assert.equal(versionControlStateWords(view), 'Authenticated as octocat')
  }

  {
    // Installed but not logged in is its own state: the version is real, so the
    // row must not read as missing, and the fix is an auth command, not an install.
    const view = resolveVersionControlRow(
      gh,
      { id: 'gh', resolved: true, version: 'gh version 2.95.0' },
      'ready',
      'darwin',
    )
    assert.equal(view.kind, 'unauthenticated')
    assert.equal(view.tone, 'warn')
    assert.equal(view.version, 'gh version 2.95.0')
    assert.equal(versionControlStateWords(view), 'Not authenticated — gh auth login')
  }

  // --- Not installed: the one-command fix path -------------------------------

  {
    const view = resolveVersionControlRow(gh, { id: 'gh', resolved: false, reason: 'not_installed' }, 'ready', 'darwin')
    assert.equal(view.kind, 'not-installed')
    assert.equal(view.tone, 'warn')
    assert.equal(view.version, null)
    assert.equal(versionControlStateWords(view), 'Not installed — brew install gh, then authenticate')
  }

  {
    const view = resolveVersionControlRow(
      git,
      { id: 'git', resolved: false, reason: 'not_installed' },
      'ready',
      'win32',
    )
    // git carries no auth of its own, so the line ends at the install command.
    assert.equal(versionControlStateWords(view), 'Not installed — winget install Git.Git')
  }

  {
    // A platform whose package manager cannot be named honestly gets no invented
    // command; the line names the missing binary instead.
    const view = resolveVersionControlRow(gh, { id: 'gh', resolved: false, reason: 'not_installed' }, 'ready', 'linux')
    assert.equal(view.kind === 'not-installed' && view.command, null)
    assert.equal(versionControlStateWords(view), 'Not installed — no gh on PATH')
  }

  // --- Non-answers are never rendered as absent ------------------------------

  {
    const view = resolveVersionControlRow(gh, { id: 'gh', resolved: false, reason: 'probe_failed' }, 'ready', 'darwin')
    assert.equal(view.kind, 'probe-failed')
    assert.equal(view.tone, 'error')
    assert.equal(view.version, null)
    assert.equal(versionControlStateWords(view), 'Availability unknown — the check did not complete')
  }

  {
    // No entry yet, first load in flight.
    const view = resolveVersionControlRow(git, undefined, 'loading', 'darwin')
    assert.equal(view.kind, 'checking')
    assert.equal(view.tone, 'neutral')
    assert.equal(versionControlStateWords(view), 'Checking…')
  }

  {
    // The round-trip itself failed: absent entries are unknown, not missing, so no
    // Install path is ever offered off a broken check.
    const view = resolveVersionControlRow(git, undefined, 'error', 'darwin')
    assert.equal(view.kind, 'probe-failed')
  }

  {
    // A settled row stays settled while a re-check is in flight — a background
    // re-probe must not flip a decided row back to "Checking…".
    const view = resolveVersionControlRow(
      git,
      { id: 'git', resolved: true, version: 'git version 2.50.1' },
      'loading',
      'darwin',
    )
    assert.equal(view.kind, 'available')
    assert.equal(view.version, 'git version 2.50.1')
  }

  console.log('versionControlProviders tests passed')
})
