import { resolve } from 'path'
import {
  idempotencyKeyForCommand,
  rememberedCommandResult,
  rememberCommandResult,
  requestHashFor,
} from './command-cache'
import { validateMobileControlCommand } from './command-validation'
import { uniqueResolved } from './path-utils'
import { getMobileControlCommandErrorMessage, MobileControlCommandError } from './command-error'
import { MobileControlCommandResultRecorder } from './command-results'
import { validateMobileWorkspacePath } from './workspace'
import { assertBacklogRelativePath } from './backlog'
import { mobileControlReadCommandTypes } from './protocol'
import {
  ghPullRequestReader,
  readMobilePullRequest,
  readMobilePullRequestDiff,
  type MobileControlPullRequestReader,
} from './pull-request'
import { createBacklogItem, updateBacklogStatus, updateBacklogTriage, updateBacklogType } from '../../backlog-service'
import type {
  BacklogCriticalityPayload,
  BacklogDifficultyPayload,
  BacklogItemStatusPayload,
  BacklogMutationResult,
  BacklogObjectStorePayload,
  BacklogTypePayload,
} from '../../../shared/electron-api'

export { MobileControlCommandError } from './command-error'

// The wire schema is owned by ./protocol. Import the command types from there
// and re-export them so this module stays the public surface for consumers,
// without re-declaring (and risking drift from) the protocol.
export { mobileControlProtocolVersion } from './protocol'

import type { MobileControlCommand, MobileControlCommandType, MobileControlError } from './protocol'

export type { MobileControlCommand, MobileControlCommandType, MobileControlError }

const defaultCommandTtlMs = 30_000

/**
 * The mutations this service executes.
 *
 * The Sprint Engine's nine mobile commands left with the engine. They
 * are still members of the protocol's command union, and a phone that predates
 * the cut will keep sending them, so they are answered here — through the same
 * audited `command_not_supported` rejection every unexecutable command gets —
 * rather than being dropped on the floor or throwing.
 */
const allowedCommandTypes = new Set<MobileControlCommandType>([
  'backlog.update',
  'backlog.create',
  'pullRequest.read',
  'pullRequest.diff',
])

/** The commands that only read: answered afresh every time, never replayed from the idempotency cache. */
const readCommandTypes = new Set<MobileControlCommandType>(mobileControlReadCommandTypes)

type MobileControlCommandServiceOptions = {
  workspaceRoot?: string
  allowedWorkspaceRoots?: string[]
  commandTtlMs?: number
  now?: () => Date
  auditSink?: (entry: MobileControlCommandAuditEntry) => void
  /** Where the pull request reads come from; `gh` unless a test hands in a fake. */
  pullRequests?: MobileControlPullRequestReader
}

export type MobileControlCommandDispatchOptions = {
  allowedWorkspaceRoots?: string[]
}

type MobileControlCommandScope = {
  allowedWorkspaceRoots: string[]
}

export type MobileControlCommandAuditEntry = {
  auditId: string
  commandId: string
  commandType: MobileControlCommandType | 'unknown'
  deviceId: string | null
  idempotencyKey?: string
  status: 'accepted' | 'rejected'
  code?: MobileControlError['code']
  message: string
  recordedAt: string
  workspacePath?: string
}

export type MobileControlCommandResult =
  | {
      ok: true
      commandId: string
      commandType: MobileControlCommandType
      idempotencyKey?: string
      executedAt: string
      data: unknown
      stdout: string
      stderr: string
      audit: MobileControlCommandAuditEntry
    }
  | {
      ok: false
      commandId: string | null
      commandType: MobileControlCommandType | 'unknown'
      idempotencyKey?: string
      error: MobileControlError
      audit: MobileControlCommandAuditEntry
    }

export class MobileControlCommandService {
  private readonly workspaceRoot: string
  private readonly configuredAllowedWorkspaceRoots: string[]
  private readonly commandTtlMs: number
  private readonly now: () => Date
  private readonly resultRecorder: MobileControlCommandResultRecorder
  private readonly pullRequests: MobileControlPullRequestReader

  constructor(options: MobileControlCommandServiceOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
    this.configuredAllowedWorkspaceRoots = uniqueResolved([
      this.workspaceRoot,
      ...(options.allowedWorkspaceRoots ?? []),
    ])
    this.commandTtlMs = Math.max(1, options.commandTtlMs ?? defaultCommandTtlMs)
    this.now = options.now ?? (() => new Date())
    this.resultRecorder = new MobileControlCommandResultRecorder(this.now, options.auditSink)
    this.pullRequests = options.pullRequests ?? ghPullRequestReader
  }

  getAuditLog(): MobileControlCommandAuditEntry[] {
    return this.resultRecorder.getAuditLog()
  }

  async dispatch(
    input: unknown,
    options: MobileControlCommandDispatchOptions = {},
  ): Promise<MobileControlCommandResult> {
    const validated = validateMobileControlCommand(input)
    if (!validated.ok) {
      return this.resultRecorder.rejectUnknown(validated.error)
    }

    const command = validated.value
    if (!allowedCommandTypes.has(command.type)) {
      return this.resultRecorder.reject(
        command,
        'command_not_supported',
        `Mobile command ${command.type} is not available on this desktop.`,
        false,
      )
    }

    // A read is answered as it is now. Remembering one under its key would
    // replay a stale pull request, and hold every diff page sent in memory.
    if (readCommandTypes.has(command.type)) {
      const ttlError = this.validateCommandTtl(command)
      if (ttlError) return this.resultRecorder.reject(command, 'command_expired', ttlError, false)
      try {
        return await this.executeRead(command)
      } catch (error) {
        return error instanceof MobileControlCommandError
          ? this.resultRecorder.reject(command, error.code, error.message, error.retryable)
          : this.resultRecorder.reject(command, 'internal_error', getMobileControlCommandErrorMessage(error), false)
      }
    }

    if (!command.idempotencyKey) {
      return this.resultRecorder.reject(
        command,
        'invalid_payload',
        'idempotencyKey is required for mobile mutation commands.',
        false,
      )
    }

    const idempotencyKey = idempotencyKeyForCommand(this.workspaceRoot, command)
    const requestHash = requestHashFor(command)
    const cachedResult = this.replayCachedResult(command, idempotencyKey, requestHash)
    if (cachedResult) {
      return cachedResult
    }

    const ttlError = this.validateCommandTtl(command)
    if (ttlError) {
      return this.resultRecorder.reject(command, 'command_expired', ttlError, false)
    }

    try {
      const scope = this.commandScope(options)
      const result = await this.executeCommand(command, scope)
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    } catch (error) {
      if (error instanceof MobileControlCommandError) {
        const result = this.resultRecorder.reject(command, error.code, error.message, error.retryable)
        rememberCommandResult(idempotencyKey, requestHash, result)
        return result
      }
      const result = this.resultRecorder.reject(
        command,
        'internal_error',
        getMobileControlCommandErrorMessage(error),
        false,
      )
      rememberCommandResult(idempotencyKey, requestHash, result)
      return result
    }
  }

  private async executeRead(command: MobileControlCommand): Promise<MobileControlCommandResult> {
    switch (command.type) {
      case 'pullRequest.read':
        return this.resultRecorder.acceptRead(
          command,
          await readMobilePullRequest(command.payload.url, this.pullRequests),
          'Pull request read.',
        )
      case 'pullRequest.diff':
        return this.resultRecorder.acceptRead(
          command,
          await readMobilePullRequestDiff(
            command.payload.url,
            command.payload.path,
            command.payload.offset ?? 0,
            this.pullRequests,
          ),
          'Pull request diff page read.',
        )
      default:
        return this.resultRecorder.reject(
          command,
          'command_not_supported',
          `Mobile command ${command.type} is not a read.`,
          false,
        )
    }
  }

  private async executeCommand(
    command: MobileControlCommand,
    scope: MobileControlCommandScope,
  ): Promise<MobileControlCommandResult> {
    switch (command.type) {
      // Answered by `executeRead` before the idempotency cache; restated so
      // the switch stays exhaustive over the protocol's union.
      case 'pullRequest.read':
      case 'pullRequest.diff':
        return this.executeRead(command)
      case 'backlog.update':
        return this.executeBacklogUpdateCommand(command, scope)
      case 'backlog.create':
        return this.executeBacklogCreateCommand(command, scope)
      // Already refused by `allowedCommandTypes`, restated so the switch stays
      // exhaustive over the protocol's union — the compiler, not a reader, is
      // what keeps a new command type from falling through here silently. A
      // snapshot is read through `workspace.snapshot`, never dispatched.
      case 'snapshot.request':
        return this.resultRecorder.reject(
          command,
          'command_not_supported',
          `Mobile command ${command.type} is not available on this desktop.`,
          false,
        )
    }
  }

  private async executeBacklogUpdateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.update' }>,
    scope: MobileControlCommandScope,
  ): Promise<MobileControlCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const relativePath = assertBacklogRelativePath(command.payload.relativePath)
    const { status, type, difficulty, criticality } = command.payload
    if (status === undefined && type === undefined && difficulty === undefined && criticality === undefined) {
      return this.resultRecorder.reject(
        command,
        'invalid_payload',
        'Backlog updates require at least one of status, type, difficulty, or criticality.',
        false,
        workspacePath,
      )
    }

    // The store mutations are sequential on purpose: each one is a full
    // read-modify-write of items.json, so running them concurrently would
    // race on the file.
    const mutations: Array<() => Promise<BacklogMutationResult>> = []
    if (status !== undefined) {
      mutations.push(() =>
        updateBacklogStatus({ workspaceRoot: workspacePath, relativePath, status: status as BacklogItemStatusPayload }),
      )
    }
    if (type !== undefined) {
      mutations.push(() =>
        updateBacklogType({ workspaceRoot: workspacePath, relativePath, type: type as BacklogTypePayload }),
      )
    }
    if (difficulty !== undefined || criticality !== undefined) {
      mutations.push(() =>
        updateBacklogTriage({
          workspaceRoot: workspacePath,
          relativePath,
          ...(difficulty !== undefined ? { difficulty: difficulty as BacklogDifficultyPayload } : {}),
          ...(criticality !== undefined ? { criticality: criticality as BacklogCriticalityPayload } : {}),
        }),
      )
    }

    let store: BacklogObjectStorePayload | null = null
    for (const mutation of mutations) {
      const result = await mutation()
      if (!result.ok) {
        return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, workspacePath)
      }
      store = result.store
    }

    const item =
      store?.items.find((record) => record.source.relativePath.toLowerCase() === relativePath.toLowerCase()) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { item },
      workspacePath,
      'Mobile backlog update was applied to the workspace backlog store.',
    )
  }

  private async executeBacklogCreateCommand(
    command: Extract<MobileControlCommand, { type: 'backlog.create' }>,
    scope: MobileControlCommandScope,
  ): Promise<MobileControlCommandResult> {
    const workspacePath = await validateMobileWorkspacePath({
      workspacePath: command.payload.workspacePath,
      allowedWorkspaceRoots: scope.allowedWorkspaceRoots,
      workspaceRootCandidates: this.workspaceRootCandidates(scope),
    })
    const title = command.payload.title.trim()
    if (!title) {
      return this.resultRecorder.reject(
        command,
        'invalid_payload',
        'Backlog item creation requires a non-empty title.',
        false,
        workspacePath,
      )
    }

    const result = await createBacklogItem({
      workspaceRoot: workspacePath,
      title,
      ...(command.payload.description !== undefined ? { description: command.payload.description } : {}),
      ...(command.payload.type !== undefined ? { type: command.payload.type } : {}),
      ...(command.payload.difficulty !== undefined ? { difficulty: command.payload.difficulty } : {}),
      ...(command.payload.criticality !== undefined ? { criticality: command.payload.criticality } : {}),
    })
    if (!result.ok) {
      return this.resultRecorder.reject(command, 'invalid_payload', result.message, false, workspacePath)
    }

    const item = result.store.items.find((record) => record.source.relativePath === result.relativePath) ?? null
    return this.resultRecorder.acceptWorkspaceCommand(
      command,
      { id: result.id, relativePath: result.relativePath, item },
      workspacePath,
      'Mobile backlog item was created in the workspace backlog store.',
    )
  }

  private commandScope(options: MobileControlCommandDispatchOptions): MobileControlCommandScope {
    const allowedWorkspaceRoots = uniqueResolved([
      ...this.configuredAllowedWorkspaceRoots,
      ...(options.allowedWorkspaceRoots ?? []),
    ])

    return { allowedWorkspaceRoots }
  }

  // Roots a phone-supplied workspace token may resolve to. Token resolution is
  // still re-validated against allowedWorkspaceRoots, so this set can never
  // relax the security boundary.
  private workspaceRootCandidates(scope: MobileControlCommandScope): string[] {
    return uniqueResolved(scope.allowedWorkspaceRoots)
  }

  private validateCommandTtl(command: MobileControlCommand): string | null {
    const issuedAt = Date.parse(command.issuedAt)
    const now = this.now().getTime()
    if (issuedAt > now + 5_000) {
      return 'Command issue time is too far in the future.'
    }
    if (now - issuedAt > this.commandTtlMs) {
      return 'Command has expired.'
    }
    return null
  }

  private replayCachedResult(
    command: MobileControlCommand,
    key: string,
    requestHash: string,
  ): MobileControlCommandResult | null {
    const remembered = rememberedCommandResult(key, requestHash)
    if (remembered.status === 'miss') return null

    if (remembered.status === 'conflict') {
      return this.resultRecorder.reject(
        command,
        'duplicate_idempotency_key',
        'This idempotency key was already used for a different command body.',
        false,
      )
    }

    const replayed = remembered.result
    const replayStatus = replayed.ok ? 'accepted' : replayed.audit.status
    const audit = this.resultRecorder.recordAudit({
      command,
      status: replayStatus,
      code: replayed.ok ? undefined : replayed.error.code,
      message: 'Mobile command result was replayed for a matching idempotency key.',
    })

    return replayed.ok
      ? {
          ...replayed,
          commandId: command.commandId,
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
          audit,
        }
      : {
          ...replayed,
          commandId: command.commandId,
          commandType: command.type,
          idempotencyKey: command.idempotencyKey,
          audit,
        }
  }
}
