import { toolError, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { encodeUsageAnswer, fleetRowsOf } from './usage-mesh'
import type { UsageService } from './usage-service'

// `usage.report`: this machine's usage for the dashboard of a desktop paired
// with it over the tailnet (usage-mesh.ts), advertised as `usage-report`. A
// read, so `workspace:read` from a paired device, as the scope of any
// app-wide family is (tailnet-scopes.ts): every device paired here is the
// person's own, and seeing what their machines spent is reading this one.
//
// Served to paired devices only (`servedOnlyToPairedDevices`): its rows are
// counts by hashed session for another desktop to merge, which an agent here
// has no use for in its tool list.

export const USAGE_REPORT_TOOL = 'usage.report'

/** The longest window one call reads; the dashboard asks for ninety days at most. */
const MAX_WINDOW_MS = 400 * 24 * 3_600_000

export function createUsageTools(deps: { usage: () => Pick<UsageService, 'peerRows'> }): McpToolRegistration[] {
  return [
    {
      name: USAGE_REPORT_TOOL,
      description:
        "This machine's token usage over a window, for a paired desktop's usage dashboard: one row per hour, " +
        'agent, model, session and speed, each session by a hash of its id. Nothing names a chat, a folder or a ' +
        'workspace. `scanning` says the rows predate a read of the logs now running; ask again with `wait` to ' +
        'have the answer wait for it. A window too large for one answer ends early and says where to go on from ' +
        '(`nextFrom`).',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'number', description: 'Window start, epoch ms, inclusive.' },
          to: { type: 'number', description: 'Window end, epoch ms, exclusive.' },
          refresh: { type: 'boolean', description: 'Read the logs again now.' },
          wait: { type: 'boolean', description: 'Wait for a read of the logs that is running (up to 45 seconds).' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      mutates: false,
      handler: async (args) => {
        const { from, to, refresh, wait } = args
        if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !(to > from))
          return toolError('invalid_arguments', '"from" and "to" must be times in epoch ms, "from" first.')
        if (to - from > MAX_WINDOW_MS) return toolError('invalid_arguments', 'Ask for 400 days at most.')
        if (
          (refresh !== undefined && typeof refresh !== 'boolean') ||
          (wait !== undefined && typeof wait !== 'boolean')
        )
          return toolError('invalid_arguments', '"refresh" and "wait" are true or false.')
        const read = await deps.usage().peerRows({ from, to, refresh: refresh === true, wait: wait === true })
        const answer = encodeUsageAnswer({
          rows: fleetRowsOf(read.rows),
          scannedAt: read.scannedAt,
          scanning: read.scanning,
          sources: read.sources,
        })
        // The rows go once, as structured content; the text says what came.
        const text = `${answer.rows.length} usage rows over ${answer.sessions.length} sessions${answer.scanning ? ', logs still being read' : ''}${answer.nextFrom === null ? '' : `, continued from ${answer.nextFrom}`}.`
        return { content: [{ type: 'text', text }], structuredContent: answer }
      },
    },
  ]
}
