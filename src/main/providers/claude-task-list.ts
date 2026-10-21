// Claude Code's task list, read off its task tools.
//
// A Claude Code that runs headless keeps its plan with TaskCreate, TaskUpdate,
// TaskList and TaskGet rather than TodoWrite (when the tools are on at all:
// `CLAUDE_CODE_ENABLE_TODO_TOOLS`). Unlike a todo write, no one call carries
// the whole list: a create adds one task and learns its id from the result, an
// update names a task by that id, and a listing is the list as it stands. The
// list is folded here from each call and its result, and a task tool's row is
// then stamped with it as `todos`, the shape a todo write carries, so the
// transcript, the todo strip and every other reader of a todo row read it
// without knowing these tools exist.

import { asRecord } from '../../shared/records'

/** The tools that read or change the list. TaskStop is not one: it stops a shell or an agent. */
const CLAUDE_TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])

export function isClaudeTaskTool(name: string): boolean {
  return CLAUDE_TASK_TOOLS.has(name)
}

type ClaudeTaskStatus = 'pending' | 'in_progress' | 'completed'

type ClaudeTask = { subject: string; status: ClaudeTaskStatus; activeForm?: string }

/** One session's tasks by Claude's own id, in the order they were made. */
export type ClaudeTaskList = ReadonlyMap<string, ClaudeTask>

/** A task as a todo write names it, which is what a todo row and the strip read. */
export type ClaudeTaskTodo = { content: string; status: ClaudeTaskStatus; activeForm?: string }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function taskStatus(value: unknown): ClaudeTaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined
}

/**
 * The list after one task tool call that did not fail, given what it was sent
 * and the structured result the CLI reported for it (`tool_use_result`).
 * Returns `tasks` itself when the call changed nothing, so a caller can tell.
 */
export function applyClaudeTaskTool(
  tasks: ClaudeTaskList,
  toolName: string,
  input: unknown,
  result: unknown,
): ClaudeTaskList {
  const sent = asRecord(input)
  const answer = asRecord(result)
  if (toolName === 'TaskList') {
    // The listing is the whole list, so it also mends one this app lost
    // track of (made before a restart, or by an agent).
    if (!Array.isArray(answer?.tasks)) return tasks
    const next = new Map<string, ClaudeTask>()
    for (const value of answer.tasks) {
      const listed = asRecord(value)
      const id = text(listed?.id)
      const subject = text(listed?.subject)
      const status = taskStatus(listed?.status)
      if (id && subject && status) next.set(id, { ...tasks.get(id), subject, status })
    }
    return sameTasks(tasks, next) ? tasks : next
  }
  if (toolName === 'TaskCreate') {
    const created = asRecord(answer?.task)
    const id = text(created?.id)
    const subject = text(created?.subject) ?? text(sent?.subject)
    if (!id || !subject) return tasks
    const activeForm = text(sent?.activeForm)
    return new Map(tasks).set(id, { subject, status: 'pending', ...(activeForm ? { activeForm } : {}) })
  }
  if (toolName === 'TaskGet') {
    // One task as it stands, the only word on one this app never saw made.
    const got = asRecord(answer?.task)
    const id = text(got?.id)
    const subject = text(got?.subject)
    const status = taskStatus(got?.status)
    if (!id || !subject || !status) return tasks
    const known = tasks.get(id)
    if (known?.subject === subject && known.status === status) return tasks
    return new Map(tasks).set(id, { ...known, subject, status })
  }
  if (toolName !== 'TaskUpdate' || answer?.success === false) return tasks
  const id = text(sent?.taskId) ?? text(answer?.taskId)
  const known = id === undefined ? undefined : tasks.get(id)
  if (id === undefined || !known) return tasks
  if (sent?.status === 'deleted') {
    const next = new Map(tasks)
    next.delete(id)
    return next
  }
  const activeForm = text(sent?.activeForm) ?? known.activeForm
  const updated: ClaudeTask = {
    subject: text(sent?.subject) ?? known.subject,
    status: taskStatus(sent?.status) ?? known.status,
    ...(activeForm ? { activeForm } : {}),
  }
  if (sameTask(known, updated)) return tasks
  return new Map(tasks).set(id, updated)
}

/**
 * What an agent's TaskCreate or TaskUpdate returned, read off the text of its
 * result: an agent's results reach the stream as text alone, with no
 * structured result beside them. Only a create or an update that went through
 * reads as one; anything else (an update a hook blocked, a task not found)
 * reads as a failed update, and a create that cannot be read as nothing.
 */
export function claudeTaskResultFromText(toolName: string, output: string): unknown {
  const said = output.trim()
  if (toolName === 'TaskCreate') {
    const created = /^Task #(\S+) created successfully: (.+)$/s.exec(said)
    return created ? { task: { id: created[1], subject: created[2]!.trim() } } : undefined
  }
  if (toolName === 'TaskUpdate') {
    const updated = /^Updated task #(\S+)/.exec(said)
    return updated ? { success: true, taskId: updated[1] } : { success: false }
  }
  return undefined
}

/** The list as a todo write's `todos`. */
export function claudeTaskTodos(tasks: ClaudeTaskList): ClaudeTaskTodo[] {
  return Array.from(tasks.values(), ({ subject, status, activeForm }) => ({
    content: subject,
    status,
    ...(activeForm ? { activeForm } : {}),
  }))
}

function sameTask(a: ClaudeTask | undefined, b: ClaudeTask | undefined): boolean {
  return a?.subject === b?.subject && a?.status === b?.status && a?.activeForm === b?.activeForm
}

function sameTasks(a: ClaudeTaskList, b: ClaudeTaskList): boolean {
  if (a.size !== b.size) return false
  const left = Array.from(a)
  const right = Array.from(b)
  return left.every(([id, task], index) => right[index]![0] === id && sameTask(task, right[index]![1]))
}
