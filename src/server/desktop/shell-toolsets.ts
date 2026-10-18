import { createAutomationTools, type AutomationBackends } from '../../main/automation/automation-tools'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'

/**
 * The toolsets the shell offers a server out of process (phase 6, 6.3,
 * decision R78): phase 5's browser and canvas, then the editor, tours,
 * terminals and agent launches, which act on a screen or a terminal the
 * shell holds.
 *
 * A toolset's tools are `<toolset>.<tool>` on the wire, so the terminal
 * family's `agent.launch` and `agent.status` ride an `agent` toolset beside
 * `terminal`, under the names agents already call. `backlog.work` stays the
 * server's: its family is, and no offer may shadow a family the server serves.
 * It starts its terminal through `ShellBridge.terminals`. The worktree pool's
 * `worktree` family is the shell's too: main keeps the pool, and a pool driven
 * from two processes would race over its slots. So is `artifacts`: a publish
 * reads the page from this machine's disk and signs in with its credentials,
 * and its clone of the site is one main keeps.
 */
export const SHELL_TOOLSETS = [
  'browser',
  'canvas',
  'editor',
  'tour',
  'terminal',
  'agent',
  'worktree',
  'artifacts',
] as const

/** Whether a gateway tool is one the shell offers, out of process, and not the server's. */
export function isShellToolName(name: string): boolean {
  const dot = name.indexOf('.')
  return dot > 0 && (SHELL_TOOLSETS as readonly string[]).includes(name.slice(0, dot))
}

/** The automation tools a server out of process serves itself: every one but the shell's. */
export function serverAutomationTools(backends: AutomationBackends): McpToolRegistration[] {
  return createAutomationTools(backends).filter((tool) => !isShellToolName(tool.name))
}

/** The automation tools the shell offers, as its `terminal` and `agent` toolsets. */
export function shellTerminalToolsets(
  backends: AutomationBackends,
): Array<{ name: 'terminal' | 'agent'; registrations: McpToolRegistration[] }> {
  const tools = createAutomationTools(backends)
  return (['terminal', 'agent'] as const).map((name) => ({
    name,
    registrations: tools.filter((tool) => tool.name.startsWith(`${name}.`)),
  }))
}
