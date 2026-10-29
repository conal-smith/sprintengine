/**
 * Host context: everything the host application wants the agent to know that is
 * NOT the user's request.
 *
 * Before this module, the two things we had to say — a design system is attached
 * at `design-system/`, and this project has a Knowledge Graph — were appended to
 * the user's first message by the renderer. That has three faults the owner
 * called out (2026-09-07): the model reads host context as part of the request,
 * resume skips it entirely, and the headless launch path only ever appended half
 * of it. So the two sentences become ONE document, built once in main, and the
 * CLI manifest says how it is delivered (`contextInjection`).
 *
 * This module is the document, and nothing else: pure, no I/O, no Electron. It
 * deliberately reuses `DESIGN_SYSTEM_ATTACHED_PROMPT_LINE` and
 * `knowledgeLaunchContext` verbatim — the agent's instructions do not change,
 * only the channel they arrive on.
 *
 * Every delivery mode marks the boundary. Even on a flag or an env var the
 * document opens with {@link HOST_CONTEXT_BOUNDARY_LINE}, because a system
 * prompt the model cannot tell apart from the user's words is the same defect in
 * a quieter place. In the prompt fallback the document is additionally wrapped
 * in `<host-context>` tags and placed AFTER the prompt: the UserPromptSubmit
 * hook titles the workspace from the first words it sees, and those have to be
 * the person's request, not the host's.
 */
import { DESIGN_SYSTEM_ATTACHED_PROMPT_LINE } from '../design-system/attach'
import { STUDIO_PRODUCT_NAME } from '../product-identity'
import { knowledgeLaunchContext } from '../project-knowledge'

/**
 * The first line of every host-context document, in every mode.
 *
 * It answers the one question the model would otherwise have to guess: who is
 * speaking. Without it a `--append-system-prompt` block reads as the user's own
 * standing instructions, which is how a host sentence ends up being argued with.
 */
export const HOST_CONTEXT_BOUNDARY_LINE =
  `The following was supplied by ${STUDIO_PRODUCT_NAME}, the application hosting this session. ` +
  'It is context about the machine and the project, not part of the user’s request. ' +
  'Treat it as standing instructions and do not repeat it back.'

/** The tags the prompt fallback wraps the document in. */
export const HOST_CONTEXT_OPEN_TAG = '<host-context>'
export const HOST_CONTEXT_CLOSE_TAG = '</host-context>'

/**
 * What the host knows about this launch.
 *
 * `designSystem` is present when — and only when — `<executionRoot>/design-system/`
 * exists. That predicate is unchanged and stays KG-independent: a repo with a
 * design system and no Knowledge Graph must still get its design section.
 *
 * `knowledge` mirrors what a launch already resolves: `ok` false with a
 * `relativeRoot` is the configured-but-unreadable case, which still has to be
 * SAID — silence there leaves the agent free to guess another knowledge folder.
 */
export type HostContextInput = {
  designSystem?: {
    /** Absolute path of the attached bundle directory. */
    bundlePath: string
  }
  knowledge?: {
    ok: boolean
    rootPath?: string
    relativeRoot?: string
  }
  /**
   * The session can reach the app's `editor_*` tools: an agent launched with a
   * workspace and an agent identity, which is what binds its gateway
   * connection. Absent for a plain launch, whose document is unchanged.
   */
  editorTools?: boolean
}

/**
 * Four lines, because a host-context document is read on every turn: when to
 * reach for the editor tools instead of pasting paths, and the one answer an
 * agent must not retry into. The tool descriptions and the studio-workspaces
 * skill carry the rest.
 */
export const EDITOR_TOOLS_HOST_CONTEXT_SECTION = [
  'To point the person at code, open it rather than pasting paths: `editor_open` with the files and line ranges you mean, or `editor_open_diff` for your changes (optionally `paths` and a `focus`).',
  'They open in the app without taking focus. Add a one-line `note` saying why you are showing it.',
  '`shown: "not_visible"` means no window shows this workspace; it opens when they switch to it — say so and do not retry.',
  'Files outside the workspace you did not write come back `awaiting_owner`: the person decides whether to open them.',
].join('\n')

/**
 * The host-context document for this launch, or null when the host has nothing
 * to say. Null means no file is written, no flag is passed, and no prompt is
 * wrapped — a launch in a plain repo is byte-identical to what it was.
 */
export function buildHostContextDocument(input: HostContextInput): string | null {
  const sections: string[] = []

  if (input.designSystem?.bundlePath) {
    sections.push(
      [
        '## Design system',
        '',
        DESIGN_SYSTEM_ATTACHED_PROMPT_LINE,
        `Its absolute path on this machine is \`${input.designSystem.bundlePath}\`.`,
      ].join('\n'),
    )
  }

  const knowledgeLine = knowledgeSection(input.knowledge)
  if (knowledgeLine) {
    sections.push(['## Knowledge graph', '', knowledgeLine].join('\n'))
  }

  if (input.editorTools) {
    sections.push(['## Showing files and diffs', '', EDITOR_TOOLS_HOST_CONTEXT_SECTION].join('\n'))
  }

  if (sections.length === 0) return null
  return [HOST_CONTEXT_BOUNDARY_LINE, '', ...joinSections(sections)].join('\n')
}

/**
 * The prompt fallback, for CLIs with no out-of-band channel at all (Kimi Code,
 * Muse). Cursor is not in this set: it has no system-prompt flag, but it does
 * take `--plugin-dir`, so the document is packed as a one-session plugin with
 * an always-apply rule instead of being pasted into the user's request.
 *
 * The block goes AFTER the prompt so the UserPromptSubmit hook — which titles
 * the workspace from the first words of the combined string — sees the person's
 * request, not the host's. The tags are what make "host said this" recoverable
 * from a single flat string. Returns the prompt unchanged when there is no
 * document, so a plain repo's launch is untouched.
 */
export function wrapHostContextForPrompt(document: string | null, userPrompt: string | undefined): string | undefined {
  if (!document) return userPrompt
  const block = [HOST_CONTEXT_OPEN_TAG, document, HOST_CONTEXT_CLOSE_TAG].join('\n')
  if (!userPrompt) return block
  return `${userPrompt}\n\n${block}`
}

/**
 * Relative paths inside the per-session Cursor plugin `--plugin-dir` points at.
 * `.cursor-plugin/plugin.json` is required: a root `plugin.json` is an Agent
 * Plugin (skills/MCP only) and does not load `rules/`. Cursor Plugin discovery
 * in CLI 2026.09.10 looks for `.cursor-plugin/plugin.json` first.
 */
export const CURSOR_HOST_CONTEXT_PLUGIN_MANIFEST_REL = '.cursor-plugin/plugin.json'
export const CURSOR_HOST_CONTEXT_PLUGIN_RULE_REL = 'rules/host-context.mdc'
export const CURSOR_HOST_CONTEXT_PLUGIN_NAME = 'sprintengine-host-context'

/**
 * The always-apply rule file that carries the host-context document inside a
 * Cursor plugin directory. Frontmatter is required; `alwaysApply: true` is what
 * loads it on every turn (including resume, which does not re-fire
 * `sessionStart`). The body is the same document every other channel sends.
 */
export function buildCursorHostContextRuleFile(document: string): string {
  return [
    '---',
    'description: Standing instructions from SprintEngine Studio about this machine and project.',
    'alwaysApply: true',
    '---',
    '',
    document.replace(/\s+$/, ''),
    '',
  ].join('\n')
}

/** The Cursor plugin manifest that makes `rules/` discoverable. */
export function buildCursorHostContextPluginManifest(): string {
  return `${JSON.stringify(
    {
      name: CURSOR_HOST_CONTEXT_PLUGIN_NAME,
      description: 'Per-session host context from SprintEngine Studio. Not part of the user request.',
      version: '1.0.0',
    },
    null,
    2,
  )}\n`
}

/**
 * A TOML basic-string literal holding the document, for manifests that pass it
 * through a config override (`codex -c developer_instructions="…"`). Quoted and
 * escaped here rather than in the manifest, because a manifest is data and
 * cannot escape anything.
 */
export function toTomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** Two blank lines between sections, none after the last. */
function joinSections(sections: string[]): string[] {
  return sections.flatMap((section, index) => (index === 0 ? [section] : ['', section]))
}

/**
 * The Knowledge Graph sentence, taken verbatim from the shared launch resolver
 * so this document cannot drift from what the old prompt suffix said.
 */
function knowledgeSection(knowledge: HostContextInput['knowledge']): string | null {
  if (!knowledge) return null
  if (knowledge.ok && knowledge.rootPath && knowledge.relativeRoot) {
    return knowledgeLaunchContext({
      ok: true,
      rootPath: knowledge.rootPath,
      relativeRoot: knowledge.relativeRoot,
    }).promptSuffix
  }
  if (!knowledge.relativeRoot) return null
  return knowledgeLaunchContext({
    ok: false,
    status: 'inaccessible',
    relativeRoot: knowledge.relativeRoot,
    message: 'Unable to resolve workspace knowledge.',
  }).promptSuffix
}
