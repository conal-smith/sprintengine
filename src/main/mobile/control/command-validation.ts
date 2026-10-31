// Straight from the protocol module rather than through `./command`, which
// re-exports it: this is a value import, and `./command` imports this file back.
import {
  isSupportedMobileControlProtocolVersion,
  mobileControlProtocolVersion,
  unsupportedMobileControlProtocolVersion,
} from './protocol'
import type { MobileControlCommand, MobileControlCommandType, MobileControlError } from './command'

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: MobileControlError }

// Every command type on the wire. The nine the Sprint Engine took with it
// were carried here for one release so a phone that still sent one got
// `command_not_supported` from the command service rather than `invalid_payload`
// from the envelope validator. Protocol v3 removed them from the wire, so a
// sender of one is outside the version window and is refused at the handshake
// instead — which is where a version mismatch belongs.
//
// `automations.control` left on 2026-09-29 without a bump, and with no grace
// entry here: nothing had served it since the hosted relay went (2026-09-27).
// The gateway's `workspace.mobile_command` allowlist never named it and the
// tailnet never advertised it, so a phone that sends it there is refused as
// `command_not_supported` before this validator runs, exactly as it was.
//
// The two pull request reads joined on 2026-10-30, additively (see
// `mobileControlReadCommandTypes`).
const commandTypes = new Set<MobileControlCommandType>([
  'snapshot.request',
  'backlog.update',
  'backlog.create',
  'pullRequest.read',
  'pullRequest.diff',
])

/** A pull request URL the phone may name: GitHub's own shape, checked again where it is read. */
const MAX_PULL_REQUEST_URL_CHARS = 500
/** A changed file's path, as git names it; longer than any a repository holds. */
const MAX_DIFF_PATH_CHARS = 1000

export function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: buildError('invalid_payload', 'command must be an object', false) }
  }

  const command = input as Record<string, unknown>
  // The window, not equality: a phone one release behind still drives this
  // desktop. The refusal outside it is unchanged, and still names the code a
  // client branches on.
  if (!isSupportedMobileControlProtocolVersion(command.protocolVersion)) {
    return {
      ok: false,
      error: buildError(
        'unsupported_protocol_version',
        unsupportedMobileControlProtocolVersion(command.protocolVersion),
        false,
      ),
    }
  }

  const baseError =
    requireString(command, 'commandId') ??
    requireString(command, 'issuedAt') ??
    requireIsoDate(command, 'issuedAt') ??
    requireString(command, 'deviceId') ??
    optionalString(command, 'idempotencyKey') ??
    optionalString(command, 'expectedSnapshotVersion')
  if (baseError) {
    return { ok: false, error: buildError('invalid_payload', baseError, false) }
  }

  if (!commandTypes.has(command.type as MobileControlCommandType)) {
    return {
      ok: false,
      error: buildError('invalid_payload', 'command.type must be a supported mobile-control command', false),
    }
  }

  if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
    return { ok: false, error: buildError('invalid_payload', 'command.payload must be an object', false) }
  }

  const payload = command.payload as Record<string, unknown>
  const payloadError = validateCommandPayload(command.type as MobileControlCommandType, payload)
  if (payloadError) {
    return { ok: false, error: buildError('invalid_payload', payloadError, false) }
  }

  return { ok: true, value: input as MobileControlCommand }
}

export function buildError(code: MobileControlError['code'], message: string, retryable: boolean): MobileControlError {
  return {
    protocolVersion: mobileControlProtocolVersion,
    code,
    message,
    retryable,
  }
}

function validateCommandPayload(type: MobileControlCommandType, payload: Record<string, unknown>): string | null {
  switch (type) {
    // Every field on a snapshot request is optional, and the only one this
    // desktop acts on is checked where it is resolved (workspacePath, against
    // the allowed roots). There is nothing to require here.
    case 'snapshot.request':
      return optionalString(payload, 'workspacePath')
    case 'backlog.update':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'relativePath') ??
        optionalString(payload, 'status') ??
        optionalString(payload, 'type') ??
        optionalString(payload, 'difficulty') ??
        optionalString(payload, 'criticality')
      )
    case 'backlog.create':
      return (
        requireString(payload, 'workspacePath') ??
        requireString(payload, 'title') ??
        optionalString(payload, 'description') ??
        optionalString(payload, 'type') ??
        optionalString(payload, 'difficulty') ??
        optionalString(payload, 'criticality')
      )
    case 'pullRequest.read':
      return requireBoundedString(payload, 'url', MAX_PULL_REQUEST_URL_CHARS)
    case 'pullRequest.diff':
      return (
        requireBoundedString(payload, 'url', MAX_PULL_REQUEST_URL_CHARS) ??
        requireBoundedString(payload, 'path', MAX_DIFF_PATH_CHARS) ??
        optionalLineOffset(payload, 'offset')
      )
  }
}

function requireBoundedString(record: Record<string, unknown>, field: string, max: number): string | null {
  return requireString(record, field) ?? ((record[field] as string).length > max ? `${field} is too long` : null)
}

function optionalLineOffset(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    ? null
    : `${field} must be a whole number of lines when provided`
}

function requireString(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'string' && record[field].length > 0 ? null : `${field} must be a non-empty string`
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  return record[field] === undefined || (typeof record[field] === 'string' && record[field].length > 0)
    ? null
    : `${field} must be a non-empty string when provided`
}

function requireIsoDate(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return `${field} must be an ISO 8601 timestamp`
  }
  return null
}
