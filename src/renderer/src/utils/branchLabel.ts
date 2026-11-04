// What a checkout's branch is called where a person reads it. Git names a
// detached HEAD "(HEAD detached at 8b9f1eeff)" in the slot where a branch
// name goes, and the header and the composer strip printed that verbatim, in
// monospace, parentheses and all — git's own words reading as a branch that
// happened to be called that. A detached checkout says so in the app's voice
// with the short commit, the length the rest of the app shows a commit at.
const DETACHED = /^\(HEAD detached (at|from) ([^)\s]+)\)$/u
const SHORT_COMMIT = /^[0-9a-f]{8,40}$/u

export function displayBranchName(name: string): string {
  const match = DETACHED.exec(name.trim())
  if (!match) return name
  const [, how, target] = match
  const shown = SHORT_COMMIT.test(target) ? target.slice(0, 7) : target
  return `detached ${how} ${shown}`
}
