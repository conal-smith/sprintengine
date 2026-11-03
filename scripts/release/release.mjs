#!/usr/bin/env node
// The GitHub-facing half of .github/workflows/release.yml. One file, four
// subcommands, each run by one workflow step:
//
//   resolve                 decide what this run builds: channel, version, commit
//   notes <out-file>        write the release body
//   merge-mac <dir> <ch>    fold the two macOS manifests into one
//   verify                  prove the published release is installable, and
//                           reachable by an updater holding no credentials
//
// Inputs arrive as environment variables set by the workflow, outputs go to
// $GITHUB_OUTPUT. The pure logic is in release-lib.mjs.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isOnMain, resolveNightly, resolvePromotion, resolveTagRelease } from './main-release.mjs'
import { lastNightly, nightlyGate } from './nightly-gate.mjs'

import {
  anonymousGet,
  buildReleaseNotes,
  channelForVersion,
  checkManifest,
  compareCore,
  manifestNames,
  mergeMacManifests,
  missingInstallers,
  NIGHTLIES_KEPT,
  nightliesToPrune,
  parseVersion,
  prereleaseVersion,
  sourceShaFromBody,
  updaterUrls,
  utcDateStamp,
  verifyPublicRelease,
} from './release-lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
// The releases repository is whatever electron-builder is configured to publish
// to, so the workflow and app-update.yml cannot disagree about it.
const RELEASES_REPO = `${packageJson.build.publish.owner}/${packageJson.build.publish.repo}`

// The self-hosted Mac only while the source is private: GitHub-hosted macOS
// minutes bill at 10x there and are free once public. On a public repository a
// fork's pull request can rewrite a workflow to run on any self-hosted runner,
// so nothing may depend on it after the switch.
const SELF_HOSTED_MAC = ['self-hosted', 'macOS', 'ARM64']
const HOSTED_MAC_ARM64 = 'macos-15'

function env(name, { required = true } = {}) {
  const value = process.env[name] ?? ''
  if (required && value === '') throw new Error(`${name} is not set`)
  return value
}

function setOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) console.log(line)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

async function github(apiPath, token, { accept = 'application/vnd.github+json', allow404 = false } = {}) {
  const headers = { accept, 'user-agent': 'sprintengine-release', 'x-github-api-version': '2022-11-28' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`https://api.github.com${apiPath}`, { headers })
  if (allow404 && response.status === 404) return null
  if (!response.ok) throw new Error(`GET ${apiPath} answered ${response.status}: ${await response.text()}`)
  return accept.includes('json') ? response.json() : response.text()
}

async function listPublishedReleases(token) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const batch = await github(`/repos/${RELEASES_REPO}/releases?per_page=100&page=${page}`, token)
    releases.push(...batch)
    if (batch.length < 100) break
  }
  return releases.filter((release) => !release.draft && release.published_at)
}

function versionOf(release) {
  try {
    return { version: parseVersion(release.tag_name), raw: release.tag_name.replace(/^v/, '') }
  } catch {
    return null
  }
}

function latestStable(releases) {
  return releases
    .map(versionOf)
    .filter((entry) => entry && entry.version.pre === null)
    .map((entry) => entry.raw)
    .sort((a, b) => compareCore(b, a))[0] ?? null
}

function latestRelease(releases, predicate) {
  return releases
    .filter((release) => {
      const entry = versionOf(release)
      return entry && predicate(entry.raw)
    })
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0] ?? null
}

const isTrain = (train) => (raw) => {
  try {
    return channelForVersion(raw) === train
  } catch {
    return false
  }
}

// Every entry point, and what it builds:
//
//   push of a tag vX.Y.Z      that commit, as stable vX.Y.Z (the hotfix route)
//   schedule                  main's head as a nightly, when the gate allows
//   dispatch nightly          main's head as a nightly, gate skipped
//   dispatch stable           the commit the latest nightly shipped, as stable
//   dispatch preview          main's head, once, on the retired preview train
//
// A push to main is not an entry point: merging publishes nothing.
async function resolve() {
  const eventName = env('EVENT_NAME')
  const sha = env('SHA')
  const sourceRepo = env('SOURCE_REPO')
  const sourceToken = env('SOURCE_TOKEN')
  const dispatchChannel = env('DISPATCH_CHANNEL', { required: false }) || 'nightly'
  const publish = eventName !== 'workflow_dispatch' || env('DISPATCH_PUBLISH', { required: false }) !== 'false'

  const source = await github(`/repos/${sourceRepo}`, sourceToken)
  const releases = await listPublishedReleases(sourceToken)
  const stable = latestStable(releases)
  const lastStableRelease = latestRelease(releases, isTrain('latest'))
  const date = utcDateStamp(env('RUN_STARTED_AT', { required: false }) || new Date().toISOString())

  if (eventName === 'workflow_dispatch' && (env('REF_TYPE') !== 'branch' || env('REF_NAME') !== 'main')) {
    throw new Error(`Run release dispatches from main, not ${env('REF_NAME')}.`)
  }

  let version
  let ref = sha
  let shouldBuild = true
  let previous = null

  if (eventName === 'push') {
    // A pushed tag builds exactly that commit as that stable (the hotfix
    // route). package.json is not consulted: it stays at the development
    // baseline, and the build stamps the tag's version.
    if (env('REF_TYPE') !== 'tag') throw new Error('A push to a branch publishes nothing. Release from a tag or a dispatch.')
    version = resolveTagRelease({
      refName: env('REF_NAME'),
      latestStable: stable,
      publishedTags: releases.map((release) => release.tag_name),
    })
    previous = lastStableRelease
  } else if (eventName === 'schedule' || dispatchChannel === 'nightly') {
    if (RELEASES_REPO !== sourceRepo) throw new Error(`Nightlies must publish to the source repository: package.json build.publish names ${RELEASES_REPO}, but this run is ${sourceRepo}.`)
    const last = lastNightly(releases)
    previous = last
    if (eventName === 'schedule') {
      const comparison = await compareWithMain(sourceRepo, sourceToken, last, sha)
      // Throws when main was rewritten under the last nightly: the run fails
      // and says so rather than skipping every tick without a word.
      const gate = nightlyGate({ releases, comparison, now: new Date() })
      console.log(gate.reason)
      shouldBuild = gate.publish
    }
    if (shouldBuild) {
      const plan = resolveNightly({
        sha,
        releases,
        packageVersion: packageJson.version,
        date,
        runNumber: env('RUN_NUMBER'),
        cwd: repoRoot,
      })
      if (!plan.shouldBuild) {
        const message = `${sha} is already shipped by stable v${plan.base}; a nightly of it would sort below that stable.`
        if (eventName !== 'schedule') throw new Error(message)
        console.log(`${message} Skipping.`)
        shouldBuild = false
      }
      version = plan.version ?? plan.base
    } else {
      version = last.tag_name.replace(/^v/, '')
    }
    if (shouldBuild) console.log(`Cutting a nightly of main ${sha} as ${version}.`)
  } else if (dispatchChannel === 'stable') {
    // Stable ships the exact commit the latest nightly shipped, so a stable
    // build is always one nightly users have already run, and merges that land
    // while a maintainer checks that nightly never reach it.
    const nightly = lastNightly(releases)
    if (!nightly) throw new Error('No published nightly to promote. Dispatch a nightly first.')
    ref = sourceShaFromBody(nightly.body)
    if (!ref) throw new Error(`${nightly.tag_name} does not record its source commit, so it cannot be promoted.`)
    if (!isOnMain({ sha: ref, mainSha: sha, cwd: repoRoot })) {
      throw new Error(`${nightly.tag_name} shipped ${ref}, which is not on main. Cut a new nightly and promote that.`)
    }
    version = resolvePromotion({
      nightlyTag: nightly.tag_name,
      override: env('DISPATCH_VERSION', { required: false }),
      latestStable: stable,
      tags: gitTags(),
    })
    previous = lastStableRelease
    console.log(`Promoting ${nightly.tag_name} (${ref}) to ${version}.`)
  } else if (dispatchChannel === 'preview') {
    // The bridge off the retired preview train. Builds installed from it follow
    // preview*.yml and nothing else, and electron-updater only offers them a
    // release whose tag starts -preview. This is one: main's head, versioned
    // just under the latest stable, so the app it installs (which reads its
    // channel from its version and finds no -nightly.) is offered that stable
    // at its next check.
    if (!stable) throw new Error('There is no stable release for preview installs to move to yet.')
    version = prereleaseVersion(stable, 'preview', date, env('RUN_NUMBER'))
    previous = lastStableRelease
    console.log(`Bridging preview installs to stable with ${version} (${sha}).`)
  } else {
    throw new Error(`Unknown release channel ${dispatchChannel}`)
  }

  const channel = channelForVersion(version)
  const tag = `v${version}`
  if (shouldBuild && channel === 'latest' && stable && compareCore(version, stable) <= 0) {
    throw new Error(`${tag} cannot replace the newer or equal stable v${stable}.`)
  }
  if (shouldBuild && releases.some((release) => release.tag_name === tag)) {
    throw new Error(`${tag} is already published on ${RELEASES_REPO}.`)
  }

  setOutputs({
    should_build: String(shouldBuild),
    publish: String(publish),
    version,
    tag,
    channel,
    prerelease: String(channel !== 'latest'),
    ref,
    previous_sha: sourceShaFromBody(previous?.body) ?? '',
    source_private: String(source.private),
    mac_arm64_runner: JSON.stringify(source.private ? SELF_HOSTED_MAC : HOSTED_MAC_ARM64),
  })
}

function gitTags() {
  return execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean)
}

// The comparison the nightly gate reads: the commit the last nightly shipped
// against main's head. Null when there is nothing to compare against.
async function compareWithMain(sourceRepo, token, last, sha) {
  const shipped = sourceShaFromBody(last?.body)
  if (!shipped) return null
  if (shipped === sha) return { status: 'identical' }
  return github(`/repos/${sourceRepo}/compare/${shipped}...${sha}?per_page=1`, token, { allow404: true })
}

async function notes(outFile) {
  const sourceRepo = env('SOURCE_REPO')
  const sourcePrivate = env('SOURCE_PRIVATE') === 'true'
  const sha = env('REF')
  const previousSha = env('PREVIOUS_SHA', { required: false })
  let commits = []
  if (!sourcePrivate && previousSha) {
    const comparison = await github(`/repos/${sourceRepo}/compare/${previousSha}...${sha}`, env('SOURCE_TOKEN'), { allow404: true })
    commits = (comparison?.commits ?? [])
      .map((commit) => ({ sha: commit.sha, subject: commit.commit.message.split('\n')[0] }))
      .reverse()
  }
  writeFileSync(
    outFile,
    buildReleaseNotes({ version: env('VERSION'), channel: env('CHANNEL'), sourceRepo, sha, sourcePrivate, commits }),
  )
}

function mergeMac(dir, channel) {
  const arm64Path = path.join(dir, `${channel}-mac.yml`)
  const x64Path = path.join(dir, `${channel}-mac-x64.yml`)
  const merged = mergeMacManifests(readFileSync(arm64Path, 'utf8'), readFileSync(x64Path, 'utf8'))
  writeFileSync(arm64Path, merged)
  rmSync(x64Path)
  console.log(merged)
}

// v0.3.0 is why this exists. That run went green on every job and published
// nothing anyone could read: build.publish still named the PRIVATE source repo.
// A release that publishes to the wrong place, publishes half its files, or
// ships a manifest the updater cannot use must not report success.
//
// Two passes, and the second is the one that class of bug fails: the API pass
// proves the release is complete, the unauthenticated pass proves a user can
// get at it. A private releases repository passes the first perfectly.
async function verify() {
  const token = env('SOURCE_TOKEN')
  const tag = env('TAG')
  const version = env('VERSION')
  const channel = env('CHANNEL')
  const release = await github(`/repos/${RELEASES_REPO}/releases/tags/${tag}`, token, { allow404: true })
  if (!release) throw new Error(`No release ${tag} on ${RELEASES_REPO}.`)

  const problems = []
  if (release.draft) problems.push('the release is still a draft')
  if (release.prerelease !== (channel !== 'latest')) problems.push(`prerelease is ${release.prerelease}`)
  const assetNames = release.assets.map((asset) => asset.name)
  console.log(`Assets on ${tag}:\n${assetNames.map((name) => `  ${name}`).join('\n')}`)
  for (const missing of missingInstallers(assetNames)) problems.push(`missing ${missing}`)
  if (assetNames.some((name) => name.endsWith('-mac-x64.yml'))) problems.push('the Intel macOS manifest was not merged')

  for (const [platform, name] of Object.entries(manifestNames(channel))) {
    const asset = release.assets.find((candidate) => candidate.name === name)
    if (!asset) {
      problems.push(`missing ${name}`)
      continue
    }
    const text = await github(`/repos/${RELEASES_REPO}/releases/assets/${asset.id}`, token, { accept: 'application/octet-stream' })
    for (const problem of checkManifest(text, platform, { version, assetNames })) problems.push(`${name} ${problem}`)
  }

  if (problems.length > 0) throw new Error(`Release ${tag} is not installable:\n  - ${problems.join('\n  - ')}`)
  console.log(`Release ${tag} is complete on ${RELEASES_REPO}.`)

  // Everything above answered while holding the job's token, which is exactly
  // the credential no user has. Ask again with none, at the URLs the shipped
  // updater reads, so a releases repository that is private or misnamed fails
  // here rather than in the silence of an app that never finds an update.
  const urls = updaterUrls({ repo: RELEASES_REPO, tag, channel })
  console.log(`Checking without credentials:\n  ${[urls.feed, urls.latestPointer, ...Object.values(urls.manifests)].join('\n  ')}`)
  const unreachable = await verifyPublicRelease({
    repo: RELEASES_REPO,
    tag,
    channel,
    version,
    assetNames,
    get: anonymousGet(),
  })
  if (unreachable.length > 0) {
    throw new Error(`Release ${tag} is published but installed builds cannot reach it:\n  - ${unreachable.join('\n  - ')}`)
  }
  console.log(`Release ${tag} is readable on ${RELEASES_REPO} without credentials.`)
}

// Deletes the nightly releases past the newest few, never their tags: a tag is
// how a version stays in the history and in the numbering, and it costs
// nothing to keep. Run after a nightly is published and verified, so the
// newest is always the one just made.
async function pruneNightlies() {
  const token = env('GH_TOKEN')
  const releases = await listPublishedReleases(token)
  const tags = nightliesToPrune(releases)
  if (tags.length === 0) {
    console.log(`No nightly past the newest ${NIGHTLIES_KEPT} to delete.`)
    return
  }
  for (const tag of tags) {
    const { id } = releases.find((release) => release.tag_name === tag)
    const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/${id}`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'sprintengine-release',
        'x-github-api-version': '2022-11-28',
      },
    })
    // Already gone: another run pruned it first.
    if (!response.ok && response.status !== 404)
      throw new Error(`DELETE release ${tag} answered ${response.status}: ${await response.text()}`)
    console.log(`Deleted the ${tag} release; its tag stays.`)
  }
}

const [command, ...args] = process.argv.slice(2)
const commands = {
  resolve: () => resolve(),
  notes: () => notes(args[0] ?? 'release-notes.md'),
  'merge-mac': () => mergeMac(args[0], args[1]),
  verify: () => verify(),
  'prune-nightlies': () => pruneNightlies(),
}

if (!commands[command]) {
  console.error(`usage: release.mjs ${Object.keys(commands).join(' | ')}`)
  process.exit(2)
}
try {
  await commands[command]()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
