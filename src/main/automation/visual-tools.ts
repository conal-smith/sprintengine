import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { MAX_VISUAL_SOURCE } from '../../shared/visual-document'
import {
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewVisual,
  type VisualPreviewDeps,
} from '../visual/visual-preview'

// `visual.preview`: an agent draws a ```visual block the way the chat will
// before it posts it, and reads back the picture, the height and the console.

function failure(code: string, message: string): McpToolResult {
  const structured = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError: true,
  }
}

/** Strips a ```visual fence an agent passed whole, so the markup inside is what is drawn. */
export function visualSourceOf(input: string): string {
  const fenced = /^\s*(`{3,}|~{3,})\s*(?:studio-)?visual[^\n]*\n([\s\S]*?)\n?\s*\1\s*$/u.exec(input)
  return fenced ? (fenced[2] ?? '') : input
}

export function createVisualTools(deps: VisualPreviewDeps): McpToolRegistration[] {
  return [
    {
      name: 'visual.preview',
      description:
        'Draw a ```visual block exactly as the chat will, before you post it: the same sealed frame, sandbox and policy, in the app’s current light or dark theme. Returns a picture of it, the height its frame will take (clipped past 900px), whether it loaded, and its console: what its script printed, the errors it threw, and every load the policy refused. Use it for a visual with a script, or a drawing you are not sure of; fix what it shows, then post. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: `The visual's markup: what goes inside the \`\`\`visual fence (a whole fence is accepted too). At most ${MAX_VISUAL_SOURCE / 1024} KB.`,
          },
          width: {
            type: 'number',
            description: `The frame's width in CSS pixels, ${PREVIEW_MIN_WIDTH}–${PREVIEW_MAX_WIDTH}. Default ${PREVIEW_DEFAULT_WIDTH}, about a chat column.`,
          },
        },
        required: ['source'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const raw = args.source
        if (typeof raw !== 'string' || !raw.trim()) return failure('invalid_arguments', 'Pass the visual as `source`.')
        const width = typeof args.width === 'number' ? args.width : undefined
        const outcome = await previewVisual(deps, {
          source: visualSourceOf(raw),
          ...(width !== undefined ? { width } : {}),
        })
        if (!outcome.ok) return failure(outcome.code, outcome.message)
        const { image, ...report } = outcome.value
        const errors = report.console.filter((line) => line.level === 'error').length
        const structured = {
          ...report,
          ...(image ? { mimeType: image.mimeType } : {}),
          caption: `${report.title}: ${report.width}x${report.frameHeight}${report.clipped ? ' (clipped)' : ''}, ${errors} console error(s).`,
        }
        // The picture rides in the content block only: the result is
        // serialised twice on the wire, and base64 twice is a lot.
        return {
          content: [
            { type: 'text', text: JSON.stringify(structured, null, 2) },
            ...(image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : []),
          ],
          structuredContent: structured,
        }
      },
    },
  ]
}
