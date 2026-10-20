// Notarize the signed macOS app, then staple its ticket, retrying the staple
// when the connection to Apple drops.
//
// electron-builder's `afterSign` hook (package.json `build.afterSign`), in place
// of its own `mac.notarize`, which is off. Both go through @electron/notarize;
// the difference is what happens after Apple has accepted the app. Stapling
// fetches the ticket from Apple's CloudKit service, and on 2026-10-20 three
// release runs in a row failed there (`Failed to staple your application with
// code: 68`, NSURLErrorDomain -1005 "The network connection was lost") after
// notarization had passed. @electron/notarize asks promise-retry to retry the
// staple, but never calls its retry callback, so the first failure ends the
// build and the next run has to upload and wait for notarization all over
// again. Here a staple that fails on the network is retried after 30s, 60s and
// 120s, and notarization is never repeated.
//
// The hook runs between signing and the targets, so the DMG and the updater
// ZIP are both made from the stapled app. The DMG itself is neither notarized
// nor stapled, as before.

import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Waits before the second, third and fourth attempts.
export const STAPLE_RETRY_DELAYS_MS = [30_000, 60_000, 120_000]

// What @electron/notarize's stapleApp throws with: stapler's exit code, a blank
// line, then stapler's output. It is how a staple failure is told from a failed
// submission once notarize() rejects.
const STAPLE_FAILURE = /^Failed to staple your application with code: (-?\d+)\s*([\s\S]*)$/u

// stapler exits 68 when it cannot reach Apple's ticket service; its log names
// the NSURLError behind it. Anything else (an unsigned app, a ticket Apple does
// not have) fails the same way every time, so it is not retried.
export function isNetworkFailure({ code, output }) {
  return code === 68 || /NSURLErrorDomain|network connection was lost|timed out|offline/iu.test(output)
}

// The credentials electron-builder would notarize with, from the same variables
// it reads: an Apple ID trio, an App Store Connect API key trio, or a keychain
// profile. Null when none is set, which skips notarization as electron-builder
// does; a partial set is an error rather than a quiet skip.
export function notarizeCredentials(env) {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = env
  if (APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD) {
    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
      throw new Error('Notarizing with an Apple ID needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.')
    }
    return { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
  }
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = env
  if (APPLE_API_KEY || APPLE_API_KEY_ID || APPLE_API_ISSUER) {
    if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
      throw new Error('Notarizing with an API key needs APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.')
    }
    return { appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER }
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return env.APPLE_KEYCHAIN
      ? { keychainProfile: env.APPLE_KEYCHAIN_PROFILE, keychain: env.APPLE_KEYCHAIN }
      : { keychainProfile: env.APPLE_KEYCHAIN_PROFILE }
  }
  return null
}

/** Runs `xcrun <args>`, resolving to its exit code and its stdout and stderr together. */
export function xcrun(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('xcrun', args, { cwd })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

/**
 * Runs `xcrun stapler <action>` on the app until it succeeds, waiting `delays`
 * before each retry while it fails on the network. `attempted` counts attempts
 * already made and failed elsewhere: they use up the first waits. Resolves to
 * the attempt that succeeded; rejects with stapler's output otherwise.
 */
export async function runStapler(
  action,
  appPath,
  { run = xcrun, sleep = delay, delays = STAPLE_RETRY_DELAYS_MS, log = console.log, attempted = 0 } = {},
) {
  const attempts = delays.length + 1
  for (let attempt = attempted + 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(delays[attempt - 2])
    const result = await run(['stapler', action, '-v', basename(appPath)], { cwd: dirname(appPath) })
    if (result.code === 0) return attempt
    if (attempt === attempts || !isNetworkFailure(result)) {
      throw new Error(
        `xcrun stapler ${action} failed with code ${result.code} on attempt ${attempt} of ${attempts}.\n\n${result.output}`,
      )
    }
    log(
      `xcrun stapler ${action} lost its connection to Apple (code ${result.code}, attempt ${attempt} of ${attempts}); ` +
        `trying again in ${delays[attempt - 1] / 1000}s.`,
    )
  }
  throw new Error(`xcrun stapler ${action} was not run: all ${attempts} attempts were already used.`)
}

/**
 * Notarizes once, then staples and validates with retries. `notarize` is
 * @electron/notarize's: it uploads, waits for Apple's verdict, and staples
 * once. A staple that fails there on the network counts as the first attempt,
 * and the rest are made here without submitting the app again.
 */
export async function notarizeAndStaple(appPath, credentials, { notarize, log = console.log, ...stapler } = {}) {
  try {
    await notarize({ tool: 'notarytool', appPath, ...credentials })
  } catch (error) {
    const failed = STAPLE_FAILURE.exec(error instanceof Error ? error.message : String(error))
    if (!failed || !isNetworkFailure({ code: Number(failed[1]), output: failed[2] })) throw error
    log(`Notarized, but stapling lost its connection to Apple (code ${failed[1]}); retrying the staple alone.`)
    await runStapler('staple', appPath, { log, ...stapler, attempted: 1 })
  }
  await runStapler('validate', appPath, { log, ...stapler })
  log(`Notarized and stapled ${basename(appPath)}.`)
}

/** electron-builder's afterSign hook. */
export async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const credentials = notarizeCredentials(process.env)
  if (!credentials) {
    console.log('Skipping notarization: no APPLE_* credentials are set.')
    return
  }
  const { notarize } = await import('@electron/notarize')
  await notarizeAndStaple(appPath, credentials, { notarize })
}

export default afterSign
