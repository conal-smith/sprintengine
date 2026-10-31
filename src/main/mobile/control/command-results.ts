import { randomUUID } from 'crypto'
import type {
  MobileControlCommand,
  MobileControlError,
  MobileControlCommandAuditEntry,
  MobileControlCommandResult,
} from './command'
import { buildError } from './command-validation'

type MobileControlCommandAuditStatus = 'accepted' | 'rejected'

type MobileControlCommandAuditInput = {
  command?: MobileControlCommand
  status: MobileControlCommandAuditStatus
  code?: MobileControlError['code']
  message: string
  workspacePath?: string
}

export class MobileControlCommandResultRecorder {
  private readonly auditLog: MobileControlCommandAuditEntry[] = []

  constructor(
    private readonly now: () => Date,
    private readonly auditSink?: (entry: MobileControlCommandAuditEntry) => void,
  ) {}

  getAuditLog(): MobileControlCommandAuditEntry[] {
    return [...this.auditLog]
  }

  acceptWorkspaceCommand(
    command: MobileControlCommand,
    data: unknown,
    workspacePath: string,
    message: string,
  ): MobileControlCommandResult {
    const audit = this.recordAudit({
      command,
      status: 'accepted',
      message,
      workspacePath,
    })

    return {
      ok: true,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      executedAt: audit.recordedAt,
      data,
      stdout: '',
      stderr: '',
      audit,
    }
  }

  /**
   * A read's answer. Not kept in the audit log or handed to its sink: a read
   * changes nothing, and a phone paging through a diff would otherwise fill
   * the log with one entry a page.
   */
  acceptRead(command: MobileControlCommand, data: unknown, message: string): MobileControlCommandResult {
    const audit = this.buildAudit({ command, status: 'accepted', message })
    return {
      ok: true,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      executedAt: audit.recordedAt,
      data,
      stdout: '',
      stderr: '',
      audit,
    }
  }

  reject(
    command: MobileControlCommand,
    code: MobileControlError['code'],
    message: string,
    retryable: boolean,
    workspacePath?: string,
  ): MobileControlCommandResult {
    const audit = this.recordAudit({
      command,
      status: 'rejected',
      code,
      message,
      workspacePath,
    })

    return {
      ok: false,
      commandId: command.commandId,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      error: buildError(code, message, retryable),
      audit,
    }
  }

  rejectUnknown(error: MobileControlError): MobileControlCommandResult {
    const audit = this.recordAudit({
      status: 'rejected',
      code: error.code,
      message: error.message,
    })

    return {
      ok: false,
      commandId: null,
      commandType: 'unknown',
      error,
      audit,
    }
  }

  recordAudit(input: MobileControlCommandAuditInput): MobileControlCommandAuditEntry {
    const entry = this.buildAudit(input)
    this.auditLog.unshift(entry)
    this.auditSink?.(entry)
    return entry
  }

  private buildAudit(input: MobileControlCommandAuditInput): MobileControlCommandAuditEntry {
    return {
      auditId: `msa_${randomUUID()}`,
      commandId: input.command?.commandId ?? 'unknown',
      commandType: input.command?.type ?? 'unknown',
      deviceId: input.command?.deviceId ?? null,
      ...(input.command?.idempotencyKey ? { idempotencyKey: input.command.idempotencyKey } : {}),
      status: input.status,
      ...(input.code ? { code: input.code } : {}),
      message: input.message,
      recordedAt: this.now().toISOString(),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    }
  }
}
