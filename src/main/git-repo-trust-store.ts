// The person's answers about repositories whose own git config names programs
// (git-repo-programs.ts): trusted, or set aside with Not now. One file under
// userData, keyed by the repository's path, each answer for one hash of the
// settings it was given for. A changed setting has a hash nobody answered, so
// the repository is asked about again, and is not trusted meanwhile.
//
// Both of the app's processes read it (main for the banner and its own git, the
// Studio server for the git a chat's checkpoints run), so the file is read
// again whenever it changed, and an answer given in one is seen by the other.
//
// Absent, unreadable or malformed reads as "no answers", which trusts nothing:
// the cost of a lost file is a banner shown again, never a program run that
// nobody agreed to.

import { readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { comparablePath } from '../shared/host-paths'
import type { GitRepoTrustDecision } from '../shared/ipc/git-repo-trust'
import { isRecord } from '../shared/records'
import { writeFileAtomic } from '../server/platform/atomic-file'

const FILE_NAME = 'git-repo-trust.json'
const VERSION = 1
/** The most repositories remembered; past it the oldest answers go first. */
const MAX_REPOSITORIES = 2_000
const RECHECK_MS = 1_000

type Answer = { path: string; hash: string; decision: GitRepoTrustDecision; at: number }

export type GitRepoTrustStore = {
  /** The answer on record for this repository and these settings, or null. */
  decisionFor(repoPath: string, hash: string): GitRepoTrustDecision | null
  record(repoPath: string, hash: string, decision: GitRepoTrustDecision): Promise<void>
}

function parse(text: string): Map<string, Answer> {
  const answers = new Map<string, Answer>()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return answers
  }
  if (!isRecord(value) || value.version !== VERSION || !isRecord(value.repositories)) return answers
  for (const entry of Object.values(value.repositories)) {
    if (!isRecord(entry)) continue
    const { path, hash, decision, at } = entry
    if (typeof path !== 'string' || !path || typeof hash !== 'string' || !hash) continue
    if (decision !== 'trusted' && decision !== 'dismissed') continue
    answers.set(comparablePath(path), { path, hash, decision, at: typeof at === 'number' ? at : 0 })
  }
  return answers
}

export function createGitRepoTrustStore(deps: {
  resolveUserDataDir: () => string
  now?: () => number
  log?: (line: string) => void
}): GitRepoTrustStore {
  const now = deps.now ?? Date.now
  let answers: Map<string, Answer> | null = null
  let stamp = ''
  let checkedAt = -Infinity
  // Writes are chained so two quick answers land in the order they were given.
  let writing: Promise<unknown> = Promise.resolve()

  const filePath = () => join(deps.resolveUserDataDir(), FILE_NAME)

  const stampOf = (): string => {
    try {
      const info = statSync(filePath())
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return '-'
    }
  }

  // Asked on every git the app starts in a repository that names programs, so
  // the file is looked at no more than once a second.
  const all = (): Map<string, Answer> => {
    if (answers && now() - checkedAt < RECHECK_MS) return answers
    checkedAt = now()
    const current = stampOf()
    if (answers && current === stamp) return answers
    stamp = current
    try {
      answers = parse(readFileSync(filePath(), 'utf8'))
    } catch {
      answers = new Map()
    }
    return answers
  }

  return {
    decisionFor(repoPath, hash) {
      const answer = all().get(comparablePath(repoPath))
      return answer && answer.hash === hash ? answer.decision : null
    },
    async record(repoPath, hash, decision) {
      const held = all()
      const key = comparablePath(repoPath)
      held.delete(key)
      held.set(key, { path: repoPath, hash, decision, at: now() })
      while (held.size > MAX_REPOSITORIES) {
        const oldest = held.keys().next().value
        if (oldest === undefined) break
        held.delete(oldest)
      }
      const text = `${JSON.stringify(
        {
          version: VERSION,
          repositories: Object.fromEntries([...held.values()].map((answer) => [answer.path, answer])),
        },
        null,
        2,
      )}\n`
      const path = filePath()
      writing = writing.then(async () => {
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFileAtomic(path, text)
          stamp = stampOf()
        } catch (error) {
          // The answer stands until the app quits; only the record failed.
          deps.log?.(`could not save repository trust: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      await writing
    },
  }
}
