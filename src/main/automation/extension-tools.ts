import { isAbsolute } from 'node:path'

import {
  EXTENSION_GUIDE_TOPICS,
  isExtensionGuideTopic,
  readExtensionGuideTopic,
} from '../../../packages/module-sdk/src/guide'
import {
  EXTENSION_START_TEMPLATE_ID,
  extensionBriefMarkdown,
  extensionIdProblem,
  type ExtensionScaffoldCreateInput,
} from '../../shared/extension-scaffold'
import { toolError, type McpToolRegistration, type McpToolResult } from '../../shared/modules/mcp-tools'
import type { createExtensionScaffoldHandlers } from '../ipc/extension-scaffold-ipc'

// How an agent builds a SprintEngine Studio extension: `extension.create`
// makes the project, and `extension.guide` is the manual, a topic at a time.
// They replace the extension-builder skill (owner ruling 2026-10-30). A skill
// had to be installed into a workspace before an agent could see it, and was
// then a standing instruction to every agent there; a tool is listed to every
// agent Studio serves, costs a line until it is called, and the project it
// makes is the same one the New chat door makes (the scaffold IPC's own
// handler, so a name the door refuses is refused here too).
//
// The guide is the SDK's (packages/module-sdk/guide), read from the copy that
// ships beside the app, so it describes the host API this build provides.

export const EXTENSION_CREATE_TOOL = 'extension.create'
export const EXTENSION_GUIDE_TOOL = 'extension.guide'

/** Writes a project to this machine's disk. */
export const EXTENSION_MUTATION_TOOL_NAMES: readonly string[] = [EXTENSION_CREATE_TOOL]

/**
 * The templates and parts the scaffolder takes, in its own order
 * (`listModuleTemplates`, `listModuleParts`). Listed here rather than read from
 * disk, so the tools' schemas are fixed for a build; a test holds them to the
 * SDK's folders.
 */
export const EXTENSION_TEMPLATE_IDS: readonly string[] = [
  'blank',
  'panel',
  'global-surface',
  'chat-companion',
  'workspace-type',
  'top-bar-item',
  'settings-section',
  'backlog-action',
  'file-action',
  'mcp-tools',
]
export const EXTENSION_PART_IDS: readonly string[] = ['main', 'mcp', 'settings', 'door']

const MAX_BRIEF_CHARS = 10_000

export type ExtensionToolsDeps = {
  scaffold: Pick<ReturnType<typeof createExtensionScaffoldHandlers>, 'create'>
  /** The folder holding the guide's topics: beside the app when packaged, the SDK's in a checkout. */
  guideRoot: () => string
}

function topicIndex() {
  return EXTENSION_GUIDE_TOPICS.map(({ id, summary }) => ({ id, summary }))
}

/** A summary for the agent to act on, and the guide topic as Markdown it reads as written. */
function withGuide(structured: Record<string, unknown>, markdown: string): McpToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(structured, null, 2) },
      { type: 'text', text: markdown },
    ],
    structuredContent: { ...structured, guide: markdown },
  }
}

function readTopic(deps: ExtensionToolsDeps, id: string): string | McpToolResult {
  try {
    return readExtensionGuideTopic(id, deps.guideRoot()) ?? toolError('unknown_topic', `"${id}" is not a topic.`)
  } catch (error) {
    return toolError(
      'guide_unavailable',
      `The extension guide could not be read from ${deps.guideRoot()}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function optionalAbsolutePath(
  args: Record<string, unknown>,
  key: 'folder' | 'parentDir',
): string | null | McpToolResult {
  const value = args[key]
  if (value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') {
    return toolError('invalid_arguments', `"${key}" is an absolute folder path when given.`)
  }
  if (!isAbsolute(value)) {
    return toolError(
      'invalid_arguments',
      `"${key}" must be an absolute path (got "${value}"); a relative path would be read from Studio's folder, not yours.`,
    )
  }
  return value
}

export function createExtensionTools(deps: ExtensionToolsDeps): McpToolRegistration[] {
  const create: McpToolRegistration = {
    name: EXTENSION_CREATE_TOOL,
    description:
      'Create a new SprintEngine Studio extension (a capability module that adds panels, pages, commands, ' +
      'Settings sections, MCP tools, chats and more to Studio) as a project ready to build: module/manifest.json, ' +
      'plugin.json, TypeScript source, tests against the SDK fake hosts, the build, validate and dev-install ' +
      'scripts, and IDEA.md holding the brief. Use it whenever you are asked to build an extension, plugin or ' +
      'module for SprintEngine Studio, rather than writing those files yourself. It never writes over anything: ' +
      'the folder must be new or empty, and one that already holds an extension is handed back untouched. The ' +
      'answer says where the project is and carries the guide’s `start` topic: how to install, check, try and ' +
      'finish it. Read the other topics with extension.guide.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'The extension’s id: lowercase letters, digits and single hyphens, e.g. "pr-radar". It is the module ' +
            'id, the new folder’s name, and the prefix of the extension’s commands and IPC channels.',
        },
        folder: {
          type: 'string',
          description:
            'Absolute path of the project folder itself, when one was chosen: one that does not exist yet (its ' +
            'parent must) or an empty one. Give this or parentDir, not both; with neither, the project goes in a ' +
            'new folder in this computer’s extensions home (Documents/SprintEngine/Extensions).',
        },
        parentDir: {
          type: 'string',
          description: 'Absolute path of an existing folder to make `<parentDir>/<name>` in.',
        },
        brief: {
          type: 'string',
          description:
            'What the extension should do, in the person’s own words where you have them. Written to IDEA.md, ' +
            'which the work starts from.',
        },
        template: {
          type: 'string',
          enum: [...EXTENSION_TEMPLATE_IDS],
          description:
            'What the project starts as. "blank" (the default) is the smallest project that runs: start there ' +
            'unless one of the others is plainly the surface asked for. The others: panel (a panel in a ' +
            'workspace), global-surface (a page of its own in the Extensions drawer), chat-companion (an agent ' +
            'working in chats it starts), workspace-type, top-bar-item, settings-section, backlog-action, ' +
            'file-action, mcp-tools (tools agents call).',
        },
        parts: {
          type: 'array',
          items: { type: 'string', enum: [...EXTENSION_PART_IDS] },
          description:
            'Parts to add on top of the template: main (a Node entry in Studio’s main process), mcp (MCP tools ' +
            'from it), settings (a Settings section), door (a page of its own). The same as running ' +
            '`npx sprintengine-module add <part>` in the project later.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    mutates: true,
    handler: async (args) => {
      const { name, brief, template, parts } = args
      if (typeof name !== 'string') return toolError('invalid_arguments', '"name" is the extension’s id.')
      const idProblem = extensionIdProblem(name)
      if (idProblem) return toolError('invalid_name', `"${name}": ${idProblem}`)
      const folder = optionalAbsolutePath(args, 'folder')
      if (folder !== null && typeof folder !== 'string') return folder
      const parentDir = optionalAbsolutePath(args, 'parentDir')
      if (parentDir !== null && typeof parentDir !== 'string') return parentDir
      if (folder !== null && parentDir !== null) {
        return toolError('invalid_arguments', 'Give "folder" or "parentDir", not both.')
      }
      if (brief !== undefined && (typeof brief !== 'string' || brief.length > MAX_BRIEF_CHARS)) {
        return toolError('invalid_arguments', `"brief" is text of at most ${MAX_BRIEF_CHARS} characters.`)
      }
      if (template !== undefined && (typeof template !== 'string' || !EXTENSION_TEMPLATE_IDS.includes(template))) {
        return toolError('invalid_arguments', `"template" is one of ${EXTENSION_TEMPLATE_IDS.join(', ')}.`)
      }
      if (
        parts !== undefined &&
        (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string' || !EXTENSION_PART_IDS.includes(part)))
      ) {
        return toolError('invalid_arguments', `"parts" lists parts from ${EXTENSION_PART_IDS.join(', ')}.`)
      }

      const input: ExtensionScaffoldCreateInput = {
        id: name,
        ...(folder !== null ? { folder } : {}),
        ...(parentDir !== null ? { parentDir } : {}),
        ...(typeof brief === 'string' && brief.trim() !== ''
          ? { ideaMarkdown: extensionBriefMarkdown(name, brief) }
          : {}),
      }
      const templateId = typeof template === 'string' ? template : EXTENSION_START_TEMPLATE_ID
      const made = await deps.scaffold.create(input, {
        templateId,
        ...(Array.isArray(parts) && parts.length > 0 ? { parts: parts as string[] } : {}),
      })
      if (!made.ok) return toolError(made.code, made.message)

      const start = readTopic(deps, 'start')
      if (typeof start !== 'string') return start
      return withGuide(
        {
          ok: true,
          id: name,
          folder: made.folder,
          ...(made.existing
            ? {
                existing: true,
                note: 'The folder already held an extension, so nothing was written: carry on with it as it is.',
              }
            : { template: templateId, ...(Array.isArray(parts) && parts.length > 0 ? { parts } : {}) }),
          ...(made.notes && made.notes.length > 0 ? { notes: made.notes } : {}),
          nextSteps: [
            `Work in ${made.folder}: read IDEA.md, then follow the guide below.`,
            'npm install, then node scripts/check-toolchain.mjs, then npm run check (a fresh project passes).',
            'Change the project toward the brief, running npm run check after every change.',
            'npm run dev:install, then tell the person to trust it in Studio: Settings → Modules.',
          ],
          topics: topicIndex(),
        },
        start,
      )
    },
  }

  const guide: McpToolRegistration = {
    name: EXTENSION_GUIDE_TOOL,
    description:
      'Read the guide to building SprintEngine Studio extensions with @sprintengine/module-sdk, one topic at a ' +
      'time: how to start and the build-install-trust loop (start), which API adds which surface (surfaces), the ' +
      'manifest, permissions, the rules that bite, the renderer and main host APIs, chats, brokers, the UI kit, ' +
      'troubleshooting a module Studio will not list, trust or run, and publishing. Read `start` before working ' +
      'on an extension project; without a topic the answer lists them all.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: EXTENSION_GUIDE_TOPICS.map((entry) => entry.id),
          description: 'The topic to read. Leave out to list the topics.',
        },
      },
      additionalProperties: false,
    },
    mutates: false,
    handler: async (args) => {
      if (args.topic === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  topics: topicIndex(),
                  note: 'Read `start` first. extension.create makes a new project. The same topics ship in an extension project as node_modules/@sprintengine/module-sdk/guide/<topic>.md.',
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: { topics: topicIndex() },
        }
      }
      if (!isExtensionGuideTopic(args.topic)) {
        return toolError(
          'unknown_topic',
          `"${String(args.topic)}" is not a topic; the topics are ${EXTENSION_GUIDE_TOPICS.map((entry) => entry.id).join(', ')}.`,
        )
      }
      const text = readTopic(deps, args.topic)
      if (typeof text !== 'string') return text
      return { content: [{ type: 'text', text }], structuredContent: { topic: args.topic, guide: text } }
    },
  }

  return [create, guide]
}
