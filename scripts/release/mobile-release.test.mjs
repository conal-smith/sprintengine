// node --test scripts/release/mobile-release.test.mjs  (npm run test:release)
//
// The phone app's Android build is published by ci.yml's android-publish job
// as the assets of one prerelease, tag `mobile-android`, on the same repository
// the desktop publishes to. These pin that it stays invisible to everything on
// the desktop's side: the installed app's updater (the real electron-updater
// GitHubProvider, fed a releases feed with the phone's release on top) and the
// release workflow's own scripts.

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { lastNightly, nightlyGate } from './nightly-gate.mjs'
import { channelForVersion, nightliesToPrune } from './release-lib.mjs'

const require = createRequire(import.meta.url)
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider')

const MOBILE_TAG = 'mobile-android'
const REPO = { owner: 'sprintengine', repo: 'sprintengine' }
const NIGHTLY = 'v0.11.0-nightly.20261104.244'
const STABLE = 'v0.10.0'
const SHA = 'a'.repeat(40)

// GitHub's feed, newest first. The phone's release is put at the very top: the
// worst case, the moment after it was first created.
function atomFeed(tags) {
  const entries = tags
    .map(
      (tag) => `<entry><id>tag:github.com,2008:Repository/1/${tag}</id>` +
        `<link rel="alternate" type="text/html" href="https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/${tag}"/>` +
        `<title>${tag}</title><content type="html">notes</content></entry>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`
}

const manifest = (version) => `version: ${version}
files:
  - url: SprintEngine-Studio-${version}-mac-arm64.zip
    sha512: abc
    size: 10
path: SprintEngine-Studio-${version}-mac-arm64.zip
sha512: abc
releaseDate: '2026-11-04T00:00:00.000Z'
`

function providerFor({ allowPrerelease, channel, currentVersion }) {
  const requested = []
  const responses = {
    [`/${REPO.owner}/${REPO.repo}/releases.atom`]: atomFeed([MOBILE_TAG, NIGHTLY, STABLE]),
    [`/${REPO.owner}/${REPO.repo}/releases/latest`]: JSON.stringify({ tag_name: STABLE }),
    [`/${REPO.owner}/${REPO.repo}/releases/download/${NIGHTLY}/nightly-mac.yml`]: manifest(NIGHTLY.slice(1)),
    [`/${REPO.owner}/${REPO.repo}/releases/download/${STABLE}/latest-mac.yml`]: manifest(STABLE.slice(1)),
  }
  const executor = {
    async request(options) {
      requested.push(options.path)
      if (!(options.path in responses)) {
        const error = new Error(`404 ${options.path}`)
        throw error
      }
      return responses[options.path]
    },
  }
  const updater = { allowPrerelease, channel, currentVersion, fullChangelog: false }
  const provider = new GitHubProvider({ provider: 'github', ...REPO }, updater, { executor, platform: 'darwin' })
  return { provider, requested }
}

test('an installed nightly build skips the phone release and takes the newest nightly', async () => {
  // update-service.ts: allowPrerelease and channel "nightly" on the nightly track.
  const { provider, requested } = providerFor({
    allowPrerelease: true,
    channel: 'nightly',
    currentVersion: '0.11.0-nightly.20261103.240',
  })
  const info = await provider.getLatestVersion()
  assert.equal(info.tag, NIGHTLY)
  assert.equal(info.version, NIGHTLY.slice(1))
  assert.ok(!requested.some((path) => path.includes(MOBILE_TAG)), requested.join('\n'))
})

test('an installed stable build resolves through /releases/latest and never sees the phone release', async () => {
  const { provider, requested } = providerFor({ allowPrerelease: false, channel: 'latest', currentVersion: '0.9.0' })
  const info = await provider.getLatestVersion()
  assert.equal(info.tag, STABLE)
  assert.ok(!requested.some((path) => path.includes(MOBILE_TAG)), requested.join('\n'))
})

test('the phone tag is no release version, so the release scripts never count it as one', () => {
  assert.throws(() => channelForVersion(MOBILE_TAG), /Not a release version/)
  // release.yml triggers on `v*` tags and reads only vX.Y.Z tags.
  assert.ok(!MOBILE_TAG.startsWith('v'))
})

test('"Delete the older nightly releases" never selects the phone release, however new it is', () => {
  const at = (tag_name, day) => ({ tag_name, published_at: `2026-11-0${day}T12:00:00Z`, draft: false, prerelease: true })
  const releases = [
    at(MOBILE_TAG, 9),
    at('v0.11.0-nightly.20261104.244', 4),
    at('v0.11.0-nightly.20261103.240', 3),
    at('v0.11.0-nightly.20261102.236', 2),
    at('v0.11.0-nightly.20261101.230', 1),
  ]
  assert.deepEqual(nightliesToPrune(releases), ['v0.11.0-nightly.20261101.230'])
  assert.deepEqual(nightliesToPrune(releases, 1).includes(MOBILE_TAG), false)
})

test('the nightly gate and a stable promotion read the newest nightly, not the phone release', () => {
  const releases = [
    { tag_name: MOBILE_TAG, draft: false, published_at: '2026-11-04T12:00:00Z', body: 'phone' },
    { tag_name: NIGHTLY, draft: false, published_at: '2026-11-04T01:00:00Z', body: `<!-- source-sha: ${SHA} -->` },
  ]
  assert.equal(lastNightly(releases).tag_name, NIGHTLY)
  const gate = nightlyGate({ releases, comparison: { status: 'identical' }, now: new Date('2026-11-04T13:00:00Z') })
  assert.equal(gate.publish, false)
})

// release.yml's own public check, with the phone release on top of the feed,
// is in release-lib.test.mjs beside the other feed cases.
