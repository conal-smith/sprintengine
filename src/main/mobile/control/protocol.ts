// The mobile-control wire: what the companion phone reads from this desktop and
// the commands it may send back.
//
// The phone reaches it only over the tailnet gateway — `workspace.snapshot`
// returns a `MobileControlSnapshot`, and `workspace.mobile_command` takes the
// fields of a `MobileControlCommand` — so these shapes cross to software this
// repository does not ship. A change here is a compatibility decision, not a
// local edit: `docs/compatibility.md` is the policy.
//
// The phone app keeps its own copy of these types. Nothing compares the two
// automatically, so an edit that changes what crosses the wire has to be made
// on the phone's side as well.

import { isRecord } from '../../../shared/records'

export const mobileControlProtocolVersion = 4 as const

/**
 * Every protocol version this desktop still accepts from a phone, oldest first.
 *
 * The desktop and the phone are two separately installed apps, and the phone's
 * update goes through a store review this repository does not control. Exact
 * equality meant the hour between shipping a desktop bump and the phone's build
 * clearing review was an hour in which every paired phone was refused outright,
 * with `unsupported_protocol_version` and no way for its owner to act on it.
 *
 * One version of slack is the smallest window that survives that, and the
 * largest that does not ask this code to remember two wire shapes indefinitely.
 *
 * Outbound traffic is unaffected: this desktop always STAMPS
 * `mobileControlProtocolVersion`. The window governs only what it will read.
 */
export const mobileControlSupportedProtocolVersions = [3, 4] as const

export type MobileControlProtocolVersion = (typeof mobileControlSupportedProtocolVersions)[number]

/**
 * The window has to END at the version this build speaks, or the desktop would
 * be advertising a version it does not itself accept back. A compile error here
 * means a bump changed `mobileControlProtocolVersion` and left the window behind.
 */
type _AssertWindowEndsAtCurrent = typeof mobileControlSupportedProtocolVersions extends readonly [
  ...unknown[],
  typeof mobileControlProtocolVersion,
]
  ? true
  : ['mobileControlSupportedProtocolVersions must end at mobileControlProtocolVersion']
const _windowEndsAtCurrent: _AssertWindowEndsAtCurrent = true
void _windowEndsAtCurrent

/** The oldest phone this desktop will still talk to. */
export const mobileControlMinSupportedProtocolVersion = mobileControlSupportedProtocolVersions[0]

export function isSupportedMobileControlProtocolVersion(value: unknown): value is MobileControlProtocolVersion {
  return (mobileControlSupportedProtocolVersions as readonly unknown[]).includes(value)
}

/**
 * Why a payload was refused, naming both the version seen and the window.
 *
 * Both, because either alone is undiagnosable: the phone's owner cannot act on
 * "unsupported version" without knowing which side is behind.
 */
export function unsupportedMobileControlProtocolVersion(
  seen: unknown,
  accepts: 'window' | 'current' = 'window',
): string {
  // What the READER accepts, which is not always the window — a payload the
  // desktop sends is read at the current version only. Collapses to a single
  // number once the window narrows to one.
  const speaks =
    accepts === 'current'
      ? String(mobileControlProtocolVersion)
      : [...new Set<number>([mobileControlMinSupportedProtocolVersion, mobileControlProtocolVersion])].join('-')
  const saw = typeof seen === 'number' ? String(seen) : 'no readable version'
  return `mobile-control protocol version ${saw} is not supported; this build speaks ${speaks}`
}

export type MobileControlCommandType =
  | 'snapshot.request'
  | 'backlog.update'
  | 'backlog.create'
  | 'pullRequest.read'
  | 'pullRequest.diff'

/**
 * The commands that only read: a pull request, and a page of one of its
 * files' diffs (2026-10-30). Additive, with no version bump: a desktop that
 * predates them refuses either as `invalid_payload` or `command_not_supported`,
 * and the phone then opens the pull request in the browser as it always did.
 * A desktop that serves them lists them in its snapshot's `commands`.
 *
 * They ride `workspace.mobile_command` like every command, but are answered
 * afresh each time: a read is not remembered under its idempotency key, so a
 * diff page is never held in memory after it is sent.
 */
export const mobileControlReadCommandTypes = ['pullRequest.read', 'pullRequest.diff'] as const

/**
 * The error codes this desktop emits. The phone validates the code against its
 * own closed list, so a new code here is a wire change: an already-paired phone
 * would fail to parse the rejection it should have shown.
 */
export type MobileControlErrorCode =
  | 'unsupported_protocol_version'
  | 'invalid_payload'
  | 'command_not_supported'
  | 'command_expired'
  | 'duplicate_idempotency_key'
  | 'stale_snapshot'
  | 'path_not_allowed'
  | 'internal_error'

export interface MobileControlError {
  protocolVersion: MobileControlProtocolVersion
  code: MobileControlErrorCode
  message: string
  retryable: boolean
  correlationId?: string
  detail?: Record<string, string | number | boolean | null>
}

export interface MobileControlCommandBase<Type extends MobileControlCommandType, Payload> {
  protocolVersion: MobileControlProtocolVersion
  commandId: string
  type: Type
  issuedAt: string
  deviceId: string
  idempotencyKey?: string
  expectedSnapshotVersion?: string
  payload: Payload
}

/** Snapshot collections a read may scope down to. Every one ships by default. */
export const mobileSnapshotCollections = ['backlog'] as const
export type MobileSnapshotCollection = (typeof mobileSnapshotCollections)[number]

/**
 * Collection names this wire no longer serves, still accepted in a read's
 * `include` and answered with nothing.
 *
 * Automations left the phone on 2026-09-29 (owner ruling), without a version
 * bump (docs/compatibility.md). Phones built before that ask for
 * `['backlog', 'automations']` on every read; refusing the retired name would
 * fail every one of those reads, which is exactly the break a bump exists to
 * announce. Accepting it and sending no `automations` member is a snapshot
 * those phones already read: the member was optional, and absent whenever a
 * desktop had no automations to show.
 */
export const retiredMobileSnapshotCollections = ['automations'] as const

export type SnapshotRequestCommand = MobileControlCommandBase<
  'snapshot.request',
  {
    /**
     * The `snapshotVersion` the client already holds; a matching read answers
     * `{ unchanged: true }` instead of the document. Skip-on-match, the opposite
     * of the base `expectedSnapshotVersion` (a reject-on-mismatch mutation
     * guard) — do not fold the two together.
     */
    knownSnapshotVersion?: string
    /** One project root, as the workspace token the phone holds as `projectKey`. */
    workspacePath?: string
    /** Restrict the payload to these collections. Absent means every collection. */
    include?: MobileSnapshotCollection[]
  }
>

export type BacklogUpdateCommand = MobileControlCommandBase<
  'backlog.update',
  {
    workspacePath: string
    relativePath: string
    status?: MobileControlBacklogItemStatus
    type?: MobileControlBacklogItemType
    difficulty?: MobileControlBacklogItemDifficulty
    criticality?: MobileControlBacklogItemCriticality
  }
>

export type BacklogCreateCommand = MobileControlCommandBase<
  'backlog.create',
  {
    workspacePath: string
    title: string
    description?: string
    type?: MobileControlBacklogItemType
    difficulty?: MobileControlBacklogItemDifficulty
    criticality?: MobileControlBacklogItemCriticality
  }
>

/** One pull request, by its GitHub URL. Answered with a `MobileControlPullRequestDetail`. */
export type PullRequestReadCommand = MobileControlCommandBase<'pullRequest.read', { url: string }>

/**
 * A page of one changed file's diff: the file's section of the pull request's
 * diff from line `offset` (0 when absent). Answered with a
 * `MobileControlPullRequestDiffPage`.
 */
export type PullRequestDiffCommand = MobileControlCommandBase<
  'pullRequest.diff',
  { url: string; path: string; offset?: number }
>

export type MobileControlCommand =
  | SnapshotRequestCommand
  | BacklogUpdateCommand
  | BacklogCreateCommand
  | PullRequestReadCommand
  | PullRequestDiffCommand

/** The most of each list a pull request read carries; the totals say how many there are. */
export const mobilePullRequestLimits = {
  checks: 30,
  remarks: 5,
  remarkChars: 280,
  files: 100,
  /** Lines of one file's diff per page, cut back to a hunk's start where one falls inside it. */
  diffPageLines: 300,
  /** A diff line longer than this is cut, with an ellipsis. */
  diffLineChars: 500,
} as const

export type MobileControlPullRequestCheck = {
  name: string
  /** The workflow it runs in; empty for a commit status. */
  workflow: string
  status: 'pending' | 'passed' | 'failed'
  /** The base branch requires it; false also when that could not be read. */
  required: boolean
}

export type MobileControlPullRequestRemark = {
  kind: 'comment' | 'review'
  author: string
  /** A review's verdict; absent on a comment. */
  verdict?: 'approved' | 'changes-requested' | 'commented'
  /** The opening of what was written, at most `remarkChars`; empty for a review left only on lines. */
  excerpt: string
  /** When it was written, ms epoch; 0 when GitHub did not say. */
  at: number
}

export interface MobileControlPullRequestDetail {
  url: string
  number: number | null
  title: string | null
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  author: string | null
  baseRefName: string | null
  headRefName: string | null
  openedAt: number | null
  /** When it merged or closed; null while open. */
  endedAt: number | null
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** Every check on the head, counted; `items` is the failing ones first, then running, then passed. */
  checks: { passed: number; failed: number; pending: number; items: MobileControlPullRequestCheck[] }
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null
  reviews: { approved: number; changesRequested: number; commented: number }
  /** Comments and reviews together: how many, and the latest few, newest first. */
  remarks: { total: number; latest: MobileControlPullRequestRemark[] }
  /** The changed files. `total` is GitHub's count, which may be more than `items` lists. Null when they could not be read. */
  files: {
    total: number
    additions: number
    deletions: number
    items: { path: string; additions: number; deletions: number; change: string | null }[]
  } | null
}

export interface MobileControlPullRequestDiffPage {
  url: string
  path: string
  /** The page as unified diff text: the file's header on the first page, then whole hunks where they fit. */
  patch: string
  offset: number
  /** Where the next page starts, or null when this is the last. */
  nextOffset: number | null
  /** How many lines the file's section of the diff has. */
  totalLines: number
}

export type MobileControlBacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type MobileControlBacklogItemType = 'epic' | 'feature' | 'bug' | 'mockup' | 'spike'
export type MobileControlBacklogItemDifficulty = 'xs' | 's' | 'm' | 'l' | 'xl'
export type MobileControlBacklogItemCriticality = 'low' | 'normal' | 'high' | 'critical'

export interface MobileControlBacklogItemSnapshot {
  itemId: string
  relativePath: string
  title: string
  excerpt?: string
  status: MobileControlBacklogItemStatus
  type?: MobileControlBacklogItemType
  difficulty?: MobileControlBacklogItemDifficulty
  criticality?: MobileControlBacklogItemCriticality
  // The up-pointing epic slug (frontmatter `epic:`) when this item belongs to an
  // epic; absent otherwise. The epic -> children direction stays a derived query.
  epic?: string
  updatedAt?: string
}

// Per-workspace epic metadata. Items carry only the `epic` up-slug; the phone
// renders epic chips and colour bands, which need the epic's display id and
// colour. Kept as a per-workspace block rather than denormalized onto every item.
export interface MobileControlBacklogEpicSnapshot {
  /** The epic slug (matches an item's `epic` up-slug). */
  slug: string
  /** The epic's display id, when the epic file carries an `id`. */
  displayId?: string
  title?: string
  /** One of the desktop seven-colour highlight set, when the epic sets `color`. */
  color?: string
  /** Rollup over the epic's member items. */
  doneCount: number
  totalCount: number
}

export interface MobileControlBacklogWorkspaceSnapshot {
  workspaceId: string
  workspacePath: string
  /** The repo this backlog group belongs to, as a workspace token. */
  projectKey?: string
  workspaceName: string
  updatedAt: string
  items: MobileControlBacklogItemSnapshot[]
  epics?: MobileControlBacklogEpicSnapshot[]
}

/**
 * A web page on this desktop that a phone can actually open.
 *
 * The pane's browser tab is not one of these: it holds a `localhost` URL, and
 * localhost on a phone is the phone. What a phone can open is a dev server the
 * desktop has published on the tailnet (`tailscale serve`), which is a real
 * HTTPS origin reachable from any device on the tailnet.
 *
 * Additive and optional, so a phone that predates it simply does not draw the
 * screen.
 */
export interface MobileControlWebTargetSnapshot {
  /** Stable within a desktop session: the HTTPS port publishing it. */
  id: string
  /** What a person recognises — the local port and the process serving it. */
  label: string
  /** `https://<node>.<tailnet>.ts.net[:port]/` — opened as-is, never rewritten. */
  url: string
  /** The loopback port on the desktop, for the label and for matching. */
  localPort: number
  /** The desktop publishing it, by MagicDNS name. */
  machine: string
}

export interface MobileControlSnapshot {
  protocolVersion: MobileControlProtocolVersion
  generatedAt: string
  desktopSessionId: string
  snapshotVersion?: string
  // Deliberately `string[]`, not MobileControlCommandType[]: the desktop may
  // advertise commands newer than the phone, which gates controls on them by raw
  // string. Rejecting unknown entries would turn every desktop command addition
  // into a phone that can no longer read snapshots at all.
  commands?: string[]
  backlog?: MobileControlBacklogWorkspaceSnapshot[]
  // Dev servers this desktop publishes on the tailnet, so the phone has a door
  // to them. Additive and omitted when there are none.
  webTargets?: MobileControlWebTargetSnapshot[]
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: MobileControlError }

/**
 * The check the phone runs on a snapshot it receives, kept here so the
 * desktop's tests can prove that what it sends — after path sanitizing — is a
 * document the phone accepts.
 *
 * Strict about the version: a snapshot is something this desktop SENDS, so only
 * the version it speaks is accepted. A window buys nothing there, and an older
 * snapshot can carry collections this wire has since retired.
 */
export function validateMobileControlSnapshot(input: unknown): ValidationResult<MobileControlSnapshot> {
  if (!isRecord(input)) return invalidPayload('snapshot must be an object')
  if (input.protocolVersion !== mobileControlProtocolVersion) {
    return {
      ok: false,
      error: buildError(
        'unsupported_protocol_version',
        unsupportedMobileControlProtocolVersion(input.protocolVersion, 'current'),
      ),
    }
  }

  const baseError =
    requireString(input, 'generatedAt') ??
    requireIsoDate(input, 'generatedAt') ??
    requireString(input, 'desktopSessionId') ??
    optionalString(input, 'snapshotVersion')
  if (baseError) return invalidPayload(baseError)

  if (input.commands !== undefined) {
    // Strings only, membership unchecked — see the field comment on
    // MobileControlSnapshot.commands.
    const commandError = validateStringArray(input.commands, 'snapshot.commands')
    if (commandError) return invalidPayload(commandError)
  }

  return { ok: true, value: input as unknown as MobileControlSnapshot }
}

function validateStringArray(input: unknown, fieldName: string): string | null {
  if (!Array.isArray(input)) return `${fieldName} must be an array`
  return input.every((value) => typeof value === 'string' && value.length > 0)
    ? null
    : `${fieldName} must contain only non-empty strings`
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? null : `${field} must be a non-empty string`
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  if (record[field] === undefined || requireString(record, field) === null) return null
  return `${field} must be a non-empty string when provided`
}

function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `${field} must be an ISO 8601 timestamp`
}

function invalidPayload(message: string): ValidationResult<never> {
  return { ok: false, error: buildError('invalid_payload', message) }
}

function buildError(code: MobileControlErrorCode, message: string): MobileControlError {
  return { protocolVersion: mobileControlProtocolVersion, code, message, retryable: false }
}
