/**
 * The GitHub repository the app's releases are published to, as `owner/repo`.
 *
 * `package.json` `build.publish` is the source of truth: electron-builder reads
 * it to write `app-update.yml`, which is the file electron-updater actually
 * follows. This constant exists because the main bundle should not carry the
 * whole of package.json, and `electron.vite.config.ts` FAILS THE BUILD if the
 * two disagree — so this is a second spelling, never a second decision.
 *
 * Worth the ceremony: builds up to 0.1.7 pointed the in-app link at a private
 * repository, which answers an unauthenticated read with 404, so they silently
 * never saw an update. A wrong value here is invisible at runtime, which is
 * exactly the kind that has to be caught at build time.
 */
export const RELEASES_REPO = 'conal-smith/sprintengine'

export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`
