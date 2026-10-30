// The extension guide: how to build, test and ship an extension, as topics an
// agent reads one at a time. The topics are the Markdown files in this
// package's `guide/` folder; this list says which ones there are, in reading
// order, and what each answers.
//
// Subpath export `@sprintengine/module-sdk/guide`. Node-only (it reads the
// files), like `./scaffold`. SprintEngine Studio serves the same topics to
// agents with its `extension.guide` tool, and `extension.create` answers with
// the `start` topic, so an agent working on an extension never needs a copy of
// the guide inside the project.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ExtensionGuideTopic = {
  /** The topic's id, and its file's name without `.md`. */
  id: string
  /** When to read it, in a line. */
  summary: string
}

/** Every topic, in the order a newcomer reads them. `start` is the first. */
export const EXTENSION_GUIDE_TOPICS: readonly ExtensionGuideTopic[] = [
  {
    id: 'start',
    summary:
      'Read first: what an extension is, the project layout, the first steps, the build-install-trust loop, testing without Studio, and what done means.',
  },
  {
    id: 'surfaces',
    summary: 'Which API adds what to Studio (panel, door, command, MCP tool, chat, …), and its permission.',
  },
  { id: 'manifest', summary: 'module/manifest.json and plugin.json, field by field.' },
  { id: 'permissions', summary: 'Every permission, what it allows, and which the host enforces.' },
  {
    id: 'rules',
    summary: 'The mistakes that cost earlier extensions time: styling, bundle shape, trust, storage, untrusted input.',
  },
  { id: 'api-renderer', summary: 'The renderer host: contributions, module state, openChat.' },
  { id: 'api-main', summary: 'The main host: services, storage, IPC, notifications, MCP tools, skills.' },
  { id: 'conversations', summary: "The extension's own chats, and one-shot text generation." },
  { id: 'brokers', summary: 'API keys and GitHub through the host, never a token in the module.' },
  { id: 'ui-kit', summary: '@sprintengine/module-sdk/ui and /surface, theme tokens, styling your own CSS.' },
  {
    id: 'troubleshooting',
    summary: 'Studio does not list, trust or run the module: what it shows, the cause, the fix.',
  },
  { id: 'publishing', summary: 'Signing, installing from GitHub, and the marketplace.' },
]

/**
 * The `guide/` folder of this package. dist/guide.js (published) and
 * src/guide.ts (in the repository) both sit one level below the package root.
 * Worked out when asked, not when the module loads: an app that bundles this
 * file into CommonJS (Studio's server) has no `import.meta.url`, and always
 * passes the folder it ships the guide in instead.
 */
export function defaultGuideRoot(): string {
  return join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'guide')
}

export function isExtensionGuideTopic(id: unknown): id is string {
  return typeof id === 'string' && EXTENSION_GUIDE_TOPICS.some((topic) => topic.id === id)
}

/**
 * One topic's Markdown, or null for an id that is not a topic. Only ids from
 * `EXTENSION_GUIDE_TOPICS` are read, so the id never names a path. Throws when
 * a listed topic's file is missing: that is a packaging bug.
 */
export function readExtensionGuideTopic(id: string, guideRoot: string = defaultGuideRoot()): string | null {
  if (!isExtensionGuideTopic(id)) return null
  return readFileSync(join(guideRoot, `${id}.md`), 'utf8')
}
