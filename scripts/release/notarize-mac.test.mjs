import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STAPLE_RETRY_DELAYS_MS,
  afterSign,
  isNetworkFailure,
  notarizeAndStaple,
  notarizeCredentials,
  runStapler,
} from './notarize-mac.mjs'

const APP = '/Users/dev/build/dist/mac-arm64/SprintEngine Studio.app'

// What stapler printed on the release runs that failed, trimmed.
const CONNECTION_LOST = {
  code: 68,
  output:
    'Processing: SprintEngine Studio.app\nCloudKit query for SprintEngine Studio.app failed due to ' +
    '"Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."".\n' +
    'Could not establish secure connection to api.apple-cloudkit.com\nThe staple and validate action failed! Error 68.',
}
const NOT_SIGNED = { code: 65, output: 'SprintEngine Studio.app does not have a ticket stapled to it.' }
const OK = { code: 0, output: 'The staple and validate action worked!' }

// A stand-in for xcrun that answers each call from a script and records it.
function fakeXcrun(results) {
  const calls = []
  const run = async (args, options) => {
    calls.push({ args, cwd: options.cwd })
    const next = results.shift()
    if (!next) throw new Error(`unexpected xcrun ${args.join(' ')}`)
    return next
  }
  return { run, calls }
}

function recorder() {
  const waits = []
  const lines = []
  return { sleep: async (ms) => void waits.push(ms), log: (line) => void lines.push(line), waits, lines }
}

test('a dropped connection is a network failure; a missing ticket is not', () => {
  assert.equal(isNetworkFailure(CONNECTION_LOST), true)
  assert.equal(isNetworkFailure({ code: 1, output: 'NSURLErrorDomain Code=-1001 "The request timed out."' }), true)
  assert.equal(isNetworkFailure(NOT_SIGNED), false)
  assert.equal(isNetworkFailure({ code: 73, output: 'not signed' }), false)
})

test('a staple that succeeds first time neither waits nor retries', async () => {
  const xcrun = fakeXcrun([OK])
  const clock = recorder()
  assert.equal(await runStapler('staple', APP, { run: xcrun.run, ...clock }), 1)
  assert.deepEqual(xcrun.calls, [
    { args: ['stapler', 'staple', '-v', 'SprintEngine Studio.app'], cwd: '/Users/dev/build/dist/mac-arm64' },
  ])
  assert.deepEqual(clock.waits, [])
})

test('a staple that loses its connection is retried after 30s, 60s and 120s', async () => {
  const xcrun = fakeXcrun([CONNECTION_LOST, CONNECTION_LOST, CONNECTION_LOST, OK])
  const clock = recorder()
  assert.equal(await runStapler('staple', APP, { run: xcrun.run, ...clock }), 4)
  assert.deepEqual(STAPLE_RETRY_DELAYS_MS, [30_000, 60_000, 120_000])
  assert.deepEqual(clock.waits, [30_000, 60_000, 120_000])
  assert.equal(xcrun.calls.length, 4)
  assert.match(clock.lines[0], /code 68, attempt 1 of 4\); trying again in 30s/)
})

test('a staple still failing after four attempts fails with what stapler said', async () => {
  const xcrun = fakeXcrun([CONNECTION_LOST, CONNECTION_LOST, CONNECTION_LOST, CONNECTION_LOST])
  const clock = recorder()
  await assert.rejects(runStapler('staple', APP, { run: xcrun.run, ...clock }), (error) => {
    assert.match(error.message, /xcrun stapler staple failed with code 68 on attempt 4 of 4/)
    assert.match(error.message, /The network connection was lost/)
    return true
  })
  assert.deepEqual(clock.waits, [30_000, 60_000, 120_000])
})

test('a failure that is not the network fails at once', async () => {
  const xcrun = fakeXcrun([NOT_SIGNED])
  const clock = recorder()
  await assert.rejects(runStapler('staple', APP, { run: xcrun.run, ...clock }), /code 65 on attempt 1 of 4/)
  assert.deepEqual(clock.waits, [])
})

test('notarized and stapled first time: only validated', async () => {
  const xcrun = fakeXcrun([OK])
  const clock = recorder()
  const submissions = []
  const notarize = async (options) => void submissions.push(options)
  await notarizeAndStaple(APP, { appleId: 'dev@example.com', appleIdPassword: 'pw', teamId: 'TEAM' }, {
    notarize,
    run: xcrun.run,
    ...clock,
  })
  assert.deepEqual(submissions, [
    { tool: 'notarytool', appPath: APP, appleId: 'dev@example.com', appleIdPassword: 'pw', teamId: 'TEAM' },
  ])
  assert.deepEqual(
    xcrun.calls.map((call) => call.args[1]),
    ['validate'],
  )
})

test('a staple that fails inside notarize() is retried here, without notarizing again', async () => {
  const xcrun = fakeXcrun([CONNECTION_LOST, OK, OK])
  const clock = recorder()
  let submissions = 0
  const notarize = async () => {
    submissions += 1
    throw new Error(`Failed to staple your application with code: 68\n\n${CONNECTION_LOST.output}`)
  }
  await notarizeAndStaple(APP, { keychainProfile: 'studio' }, { notarize, run: xcrun.run, ...clock })
  assert.equal(submissions, 1)
  assert.deepEqual(
    xcrun.calls.map((call) => call.args[1]),
    ['staple', 'staple', 'validate'],
  )
  // notarize()'s own staple was the first attempt, so the next waits 30s.
  assert.deepEqual(clock.waits, [30_000, 60_000])
})

test('a staple inside notarize() that fails for another reason is not retried', async () => {
  const xcrun = fakeXcrun([])
  const notarize = async () => {
    throw new Error(`Failed to staple your application with code: 65\n\n${NOT_SIGNED.output}`)
  }
  await assert.rejects(
    notarizeAndStaple(APP, { keychainProfile: 'studio' }, { notarize, run: xcrun.run, ...recorder() }),
    /code: 65/,
  )
  assert.equal(xcrun.calls.length, 0)
})

test('attempts made elsewhere use up the first waits', async () => {
  const xcrun = fakeXcrun([CONNECTION_LOST, CONNECTION_LOST, CONNECTION_LOST])
  const clock = recorder()
  await assert.rejects(
    runStapler('staple', APP, { run: xcrun.run, ...clock, attempted: 1 }),
    /code 68 on attempt 4 of 4/,
  )
  assert.deepEqual(clock.waits, [30_000, 60_000, 120_000])
  assert.equal(xcrun.calls.length, 3)
})

test('a rejected submission fails the build and staples nothing', async () => {
  const xcrun = fakeXcrun([])
  const notarize = async () => {
    throw new Error('Failed to notarize via notarytool: status Invalid')
  }
  await assert.rejects(
    notarizeAndStaple(APP, { keychainProfile: 'studio' }, { notarize, run: xcrun.run, ...recorder() }),
    /status Invalid/,
  )
  assert.equal(xcrun.calls.length, 0)
})

test('credentials come from the same variables electron-builder reads', () => {
  assert.equal(notarizeCredentials({}), null)
  assert.deepEqual(
    notarizeCredentials({ APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAM' }),
    { appleId: 'dev@example.com', appleIdPassword: 'pw', teamId: 'TEAM' },
  )
  assert.deepEqual(
    notarizeCredentials({ APPLE_API_KEY: '/keys/AuthKey.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER' }),
    { appleApiKey: '/keys/AuthKey.p8', appleApiKeyId: 'KEY', appleApiIssuer: 'ISSUER' },
  )
  assert.deepEqual(notarizeCredentials({ APPLE_KEYCHAIN_PROFILE: 'studio' }), { keychainProfile: 'studio' })
  assert.throws(() => notarizeCredentials({ APPLE_ID: 'dev@example.com' }), /APPLE_APP_SPECIFIC_PASSWORD/)
  assert.throws(() => notarizeCredentials({ APPLE_API_KEY_ID: 'KEY' }), /APPLE_API_ISSUER/)
})

test('the hook leaves Windows and Linux builds alone', async () => {
  await afterSign({ electronPlatformName: 'win32', appOutDir: '/nowhere', packager: { appInfo: {} } })
  await afterSign({ electronPlatformName: 'linux', appOutDir: '/nowhere', packager: { appInfo: {} } })
})
