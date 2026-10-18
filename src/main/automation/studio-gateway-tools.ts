import { BROWSER_MUTATION_TOOL_NAMES } from './browser-tools'
import { CANVAS_MUTATION_TOOL_NAMES } from './canvas-tools'
import { EDITOR_MUTATION_TOOL_NAMES } from './editor-tools'
import type { McpToolContribution } from '../module-host/main-host'
import { CONVERSATION_MUTATION_TOOL_NAMES } from './conversation-tools'
import { CONVERSATION_PULL_REQUEST_MUTATION_TOOL_NAMES } from './conversation-pull-request-tools'
import { CONVERSATION_COMMAND_TOOL_NAMES } from './tailnet/tailnet-conversation-stream'
import { TAILNET_MUTATION_TOOL_NAMES } from './tailnet/tailnet-tools'
import { TOUR_MUTATION_TOOL_NAMES } from './tour-tools'
import { ARTIFACTS_MUTATION_TOOL_NAMES } from '../artifacts/artifacts-tools'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import {
  mcpToolWireName,
  toolError,
  type McpConnectionContext,
  type McpToolRegistration,
} from '../../shared/modules/mcp-tools'
import { runAsModuleToolCall } from '../module-host/module-tool-caller'

const APP_MUTATION_TOOLS = new Set([
  ...BROWSER_MUTATION_TOOL_NAMES,
  // Drawing on a board writes a file in the person's project, so every one of
  // these is audited and needs `<family>:operate` from a remote caller.
  // `canvas.describe`, `canvas.find`, `canvas.list` and `canvas.screenshot`
  // only look, and stay on the read scope.
  ...CANVAS_MUTATION_TOOL_NAMES,
  // Putting a file or a diff in front of the person changes their screen, so
  // `editor.open` and `editor.open_diff` are audited and need
  // `workspace:operate` from a paired device. `editor.state` only looks.
  ...EDITOR_MUTATION_TOOL_NAMES,
  'agent.launch',
  'schedule.create',
  'schedule.delete',
  'schedule.run',
  'backlog.assign',
  'backlog.repair',
  'backlog.update',
  'backlog.work',
  // A paired device's commands on a conversation socket: send, stop, answer,
  // approve, change the permission preset or the model. They are not MCP tools, but they
  // act on this machine for a remote device exactly as one does, so each
  // attempt lands in the same audit with the device that made it.
  ...CONVERSATION_COMMAND_TOOL_NAMES,
  // Starting a chat on this machine, on the same `conversation:operate` grant
  // as the commands above, and audited with the device that asked.
  ...CONVERSATION_MUTATION_TOOL_NAMES,
  // A paired desktop's Create PR on a chat here: drafting runs a CLI, and the
  // push and the creation reach the forge. Reading whether it may show is not
  // among them.
  ...CONVERSATION_PULL_REQUEST_MUTATION_TOOL_NAMES,
  // Configuring who may drive this machine. Classified as mutations so every
  // one of them is audited — minting a pairing code is the most consequential
  // write on this surface. The tailnet listener never serves them at all
  // (`localOnlyGatewayToolReason`), so unlike every other entry here their
  // scope mapping is never consulted.
  ...TAILNET_MUTATION_TOOL_NAMES,
  // Starting an agent terminal on this machine, the same act as `agent.launch`
  // above, so it lands in the same audit. It is served on the local socket
  // only (`localOnlyGatewayToolReason`); a paired device that asks anyway is
  // refused, and being a mutation is what puts that attempt in the audit with
  // the device that made it.
  'terminal.create',
  // Diff tours: each one writes a tour file in the app's data folder, docks a
  // tab in the person's window, or types a question into an agent's terminal
  // on the owner's behalf. `tour.status` only reads.
  ...TOUR_MUTATION_TOOL_NAMES,
  'workspace.create',
  // Publishing, changing or removing an artifact writes to the person's
  // artifacts site with this machine's credentials. Served on the local
  // socket only (`localOnlyGatewayToolReason`); listing and reading stay reads.
  ...ARTIFACTS_MUTATION_TOOL_NAMES,
  // The mobile companion's command envelope over the gateway. A mutation for both of its consequences: a
  // paired phone needs `workspace:operate` to drive it, and every dispatch —
  // including a refused one — lands in the audit with the device identity.
  // `workspace.snapshot` deliberately is NOT here: it is the phone's read
  // model and maps to `workspace:read` like every other read.
  'workspace.mobile_command',
])

// Builds the gateway's per-request tool resolver. The app tools are merged once,
// failing fast at construction on a duplicate. Module-contributed tools are read
// from the host kernel on EVERY call — the gateway is constructed before modules
// load, and availability must follow module enablement live — and each
// one is gated on its owner's enablement: a disabled module's tools stay listed
// and answer an actionable enable error instead of running (re-homed from the renderer).
export function createStudioGatewayTools(options: {
  appTools: McpToolRegistration[]
  /** Module-contributed tools, from the host kernel; empty until modules load. */
  resolveModuleTools: () => ReadonlyArray<McpToolContribution>
  /** Live enablement of a contributing module; resolved per call, never captured. */
  isModuleEnabled: (moduleId: string) => boolean
  /**
   * The calling agent's launch ceiling (launch-permission-cap.ts), which a
   * module tool's handler runs under: an agent the module starts during the
   * call is held to it. Absent, module tools run uncapped.
   */
  callerPermissionCeiling?: (context: McpConnectionContext | undefined) => CliPermissionPreset | null
  warn?: (message: string) => void
}): StudioGatewayToolResolver {
  const coreNames = new Set<string>()
  const requireUnique = (name: string): void => {
    if (coreNames.has(name)) {
      throw new Error(`Duplicate SprintEngine Studio MCP tool registration: ${name}`)
    }
    coreNames.add(name)
  }
  for (const registration of options.appTools) requireUnique(registration.name)
  const coreWireNames = new Set([...coreNames].map(mcpToolWireName))
  // The resolver runs per request; a persistent shadowing module would emit the
  // same collision warning on every tools/list without this once-guard.
  const warnedCollisions = new Set<string>()

  const resolve = (): McpToolRegistration[] => {
    const merged = [...options.appTools]
    const names = new Set(coreNames)
    for (const contribution of options.resolveModuleTools()) {
      const { registration } = contribution
      // Module-vs-module collisions are already rejected at registration by
      // the kernel; this guards a module shadowing a CORE tool name, which the
      // kernel cannot know. First (core) wins so the gateway keeps serving.
      if (names.has(registration.name) || coreWireNames.has(mcpToolWireName(registration.name))) {
        const collisionKey = `${contribution.moduleId}:${registration.name}`
        if (!warnedCollisions.has(collisionKey)) {
          warnedCollisions.add(collisionKey)
          options.warn?.(
            `MCP tool "${registration.name}" from module "${contribution.moduleId}" collides with a core gateway tool and is not served.`,
          )
        }
        continue
      }
      names.add(registration.name)
      merged.push(gateOnModuleEnablement(contribution, options.isModuleEnabled, options.callerPermissionCeiling))
    }
    return merged
  }
  return Object.assign(resolve, { coreToolNames: (): ReadonlySet<string> => coreNames })
}

/**
 * The gateway's per-request tool resolver, plus the names of the core tools it
 * was built with: what the module host checks a module's tool names against
 * at registration, so a module that would shadow one hears it as an error
 * instead of being silently not served.
 */
export type StudioGatewayToolResolver = (() => McpToolRegistration[]) & {
  coreToolNames(): ReadonlySet<string>
}

// The user's module switch reaches the MCP surface (owner ruling): the
// tool keeps being advertised so an agent learns the capability exists, and a
// call while the owner is disabled answers one plain, actionable sentence as a
// normal MCP tool result — never a protocol error, never the orphaned handler.
//
// An enabled module's handler runs as its caller (module-tool-caller.ts), so a
// chat it starts for a capped agent is no looser than that agent.
function gateOnModuleEnablement(
  contribution: McpToolContribution,
  isModuleEnabled: (moduleId: string) => boolean,
  callerPermissionCeiling: ((context: McpConnectionContext | undefined) => CliPermissionPreset | null) | undefined,
): McpToolRegistration {
  const { moduleId, moduleDisplayName, registration } = contribution
  return {
    ...registration,
    handler: async (args, context) =>
      isModuleEnabled(moduleId)
        ? runAsModuleToolCall({ permissionCeiling: callerPermissionCeiling?.(context) ?? null }, () =>
            registration.handler(args, withVerifiedIdentity(context)),
          )
        : toolError(
            `${moduleId}_module_disabled`,
            `The ${moduleDisplayName} module is disabled. Enable it in Settings → Modules to use ${moduleId} tools.`,
          ),
  }
}

// A module tool always hears whether the caller's identity was proven: true
// only when a launch token or the tailnet transport established it. Core tools
// read the metadata as the transports wrote it; this is the module contract's
// promise that the flag is present, never left for the module to guess.
function withVerifiedIdentity(context: McpConnectionContext | undefined): McpConnectionContext | undefined {
  if (!context) return context
  return { ...context, metadata: { ...context.metadata, verified: context.metadata.verified === true } }
}

// Does this tool change state? Two decisions read it: the tailnet scope a
// remote caller must hold (`<family>:operate` rather than `<family>:read`) and
// whether the call lands in the gateway audit.
//
// Core tools are classified by the table above. A module-contributed tool
// classifies itself, by declaring `mutates: true` on its registration — core
// cannot know what a module's tool does, and a module that ships after this
// build must still be able to say. `resolveTools` is the gateway's own live
// tool resolver, called per question and never captured: a module enabled
// mid-session changes the answer. Callers with no resolver to hand (tests) get
// the core classification alone.
export function isStudioGatewayMutation(
  toolName: string,
  resolveTools?: () => ReadonlyArray<Pick<McpToolRegistration, 'name' | 'mutates'>>,
): boolean {
  if (APP_MUTATION_TOOLS.has(toolName)) return true
  if (!resolveTools) return false
  return resolveTools().some((tool) => tool.name === toolName && tool.mutates === true)
}
