// Scaffold a new extension project from one of the templates this package
// ships (`templates/<id>/`).
//
// Subpath export `@sprintengine/module-sdk/scaffold`. Node-only (it reads and
// writes the file system), so it is kept out of the root index, which must
// stay loadable in a renderer. The `sprintengine-module init` command and the
// app's "Build your own extension" flow both call it, so a project made from
// the command line and one made from the app are the same project.
//
// A template is a folder holding `template.json` (what the picker shows) and
// the project files. `templates/_shared/` holds the files every project gets —
// the dev-loop scripts, the smoke test, the agent instructions — and a
// template's own file of the same path wins over the shared one. Text files
// carry `{{placeholder}}` tokens (see `placeholderValues`), and a file named
// `gitignore` is written as `.gitignore`: npm drops dot-gitignore files from a
// published tarball, so the template cannot ship one under its real name.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUNDLED_MODULE_IDS } from './index.js'

export type ModuleTemplateInfo = {
  id: string
  title: string
  summary: string
  /** The permissions the template's manifest declares, as the consent prompt will show them. */
  permissions: string[]
  /** What the template contributes or relies on (e.g. 'panel', 'conversations'), for a picker's tags. */
  capabilities: string[]
}

export type ScaffoldModuleOptions = {
  /** The project folder. Created when missing; must be empty unless `force`. */
  dir: string
  templateId: string
  /** The module id: lowercase letters, digits and hyphens, and not a reserved bundled id. */
  id: string
  /**
   * The name people see. Quotes, backslashes, braces, angle brackets, `$` and
   * backticks are dropped and an apostrophe becomes a typographic one (see
   * `sanitizeDisplayText`); an empty result falls back to the id, title-cased.
   */
  displayName: string
  publisher?: string
  /** The SDK version the project depends on, as `^<sdkVersion>`. */
  sdkVersion: string
  /** A local SDK tarball to depend on instead of the npm release; copied into the project's `vendor/`. */
  sdkTarballPath?: string
  /** Defaults to the `templates/` folder beside this package's `dist/`. */
  templatesRoot?: string
  /** Written as the project's IDEA.md in place of the template's placeholder brief. */
  ideaMarkdown?: string
  /** Scaffold into a folder that already has files in it, overwriting the ones the template writes. */
  force?: boolean
  /**
   * Parts to add on top of the template (`listModuleParts`): `main`, `mcp`,
   * `settings`, `door`. The same as running `sprintengine-module add` on the
   * new project.
   */
  parts?: readonly string[]
}

export type ScaffoldModuleResult =
  | {
      ok: true
      files: string[]
      /** Steps left to do by hand, when a part could not wire itself in. */
      notes?: string[]
    }
  | {
      ok: false
      code: 'unknown_template' | 'invalid_id' | 'dir_not_empty' | 'io_error' | 'unknown_part' | 'already_present'
      message: string
    }

const SHARED_TEMPLATE_DIR = '_shared'
const TEMPLATE_MANIFEST = 'template.json'
const SDK_PACKAGE = '@sprintengine/module-sdk'
const DEFAULT_PUBLISHER = 'Local developer'

// The same id rule the manifest validator applies, so a scaffolded project's
// manifest validates the moment it is written.
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

// The picker order: the empty starting point first, then the surfaces a person
// is most likely to be asking for. A template missing here sorts after these.
const TEMPLATE_ORDER = [
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

// dist/scaffold.js (published) and src/scaffold.ts (in the repository) both sit
// one level below the package root, so one relative step finds the folders.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function defaultTemplatesRoot(): string {
  return join(PACKAGE_ROOT, 'templates')
}

/** This package's own version: what a project scaffolded by its CLI depends on. */
export function sdkPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`${join(PACKAGE_ROOT, 'package.json')} carries no version.`)
  }
  return pkg.version
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

function readTemplateInfo(templateDir: string): ModuleTemplateInfo {
  const path = join(templateDir, TEMPLATE_MANIFEST)
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const { id, title, summary, permissions, capabilities } = value
  if (
    typeof id !== 'string' ||
    id !== basename(templateDir) ||
    typeof title !== 'string' ||
    typeof summary !== 'string' ||
    !isStringArray(permissions) ||
    !isStringArray(capabilities)
  ) {
    // A template ships inside this package; a malformed one is a packaging bug,
    // so it fails loudly rather than disappearing from the picker.
    throw new Error(
      `${path} must be { id (the folder name), title, summary, permissions: string[], capabilities: string[] }.`,
    )
  }
  return { id, title, summary, permissions: [...permissions], capabilities: [...capabilities] }
}

function templateDirs(templatesRoot: string): string[] {
  return readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => join(templatesRoot, entry.name))
    .filter((dir) => existsSync(join(dir, TEMPLATE_MANIFEST)))
}

function templateRank(id: string): number {
  const index = TEMPLATE_ORDER.indexOf(id)
  return index === -1 ? TEMPLATE_ORDER.length : index
}

/** Every template under `templatesRoot`, in picker order. */
export function listModuleTemplates(templatesRoot: string = defaultTemplatesRoot()): ModuleTemplateInfo[] {
  return templateDirs(templatesRoot)
    .map(readTemplateInfo)
    .sort((a, b) => templateRank(a.id) - templateRank(b.id) || a.id.localeCompare(b.id))
}

/** Every file under `dir`, as POSIX paths relative to it. */
function walkFiles(dir: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...walkFiles(join(dir, entry.name), relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

/** The name a template file is written under in the project. */
function projectPath(templatePath: string): string {
  const segments = templatePath.split('/')
  if (segments[segments.length - 1] === 'gitignore') segments[segments.length - 1] = '.gitignore'
  return segments.join('/')
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}

// A name lands in JSON strings, TS string and template literals, JSX text and
// attributes, CSS comments and Markdown. Rather than escape it five ways, keep
// it to characters that are literal in all of them: an apostrophe becomes a
// typographic one, and quotes, backslashes, braces, angle brackets, `$`,
// backticks and control characters are dropped.
export function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/'/g, '\u2019')
    .replace(/["`\\{}<>$\u0000-\u001f\u007f]/g, '')
    .trim()
}

function placeholderValues(options: ScaffoldModuleOptions, template: ModuleTemplateInfo): Record<string, string> {
  return {
    id: options.id,
    displayName: sanitizeDisplayText(options.displayName) || displayNameFromId(options.id),
    publisher: sanitizeDisplayText(options.publisher ?? '') || DEFAULT_PUBLISHER,
    sdkVersion: options.sdkVersion,
    templateId: template.id,
    templateTitle: sanitizeDisplayText(template.title),
  }
}

function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values[name] ?? token)
}

function isEmptyDir(dir: string): boolean {
  return readdirSync(dir).length === 0
}

/**
 * Create an extension project in `options.dir` from a template: the template's
 * files with the module id, name and SDK version filled in, and the shared
 * dev-loop files. Expected failures come back as a result, never a throw.
 */
export async function scaffoldModuleProject(options: ScaffoldModuleOptions): Promise<ScaffoldModuleResult> {
  if (!MODULE_ID_PATTERN.test(options.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      message: `"${options.id}" is not a module id: use lowercase letters, digits and hyphens (1–63 characters), starting with a letter or digit.`,
    }
  }
  if (BUNDLED_MODULE_IDS.includes(options.id)) {
    return {
      ok: false,
      code: 'invalid_id',
      message: `"${options.id}" is reserved for a module that ships with SprintEngine Studio; choose another id.`,
    }
  }

  const templatesRoot = resolve(options.templatesRoot ?? defaultTemplatesRoot())
  const templateDir = join(templatesRoot, options.templateId)
  if (
    options.templateId.startsWith('_') ||
    options.templateId.includes('/') ||
    !existsSync(join(templateDir, TEMPLATE_MANIFEST))
  ) {
    let known: string[] = []
    try {
      known = listModuleTemplates(templatesRoot).map((template) => template.id)
    } catch {
      // The listing is only for the message; the unknown id is the failure.
    }
    return {
      ok: false,
      code: 'unknown_template',
      message: `There is no "${options.templateId}" template${known.length > 0 ? `; the templates are ${known.join(', ')}` : ''}.`,
    }
  }

  // Parts are checked against the template before anything is written, so a
  // part the template already has fails the scaffold rather than leaving half
  // a project behind.
  if (options.parts && options.parts.length > 0) {
    try {
      const templateManifest = JSON.parse(readFileSync(join(templateDir, 'module', 'manifest.json'), 'utf8')) as {
        entry?: Record<string, string>
      }
      const planned = planParts(join(templatesRoot, PARTS_DIR), options.parts, templateManifest.entry ?? {})
      if (!planned.ok) return planned
    } catch (error) {
      return { ok: false, code: 'io_error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  const dir = resolve(options.dir)
  try {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) {
        return { ok: false, code: 'dir_not_empty', message: `${dir} exists and is not a folder.` }
      }
      if (!options.force && !isEmptyDir(dir)) {
        return {
          ok: false,
          code: 'dir_not_empty',
          message: `${dir} already has files in it. Choose an empty folder, or scaffold with force to write over them.`,
        }
      }
    }

    const template = readTemplateInfo(templateDir)
    const values = placeholderValues(options, template)
    // Shared first, template second: a template's file of the same path wins.
    const sources = new Map<string, string>()
    const sharedDir = join(templatesRoot, SHARED_TEMPLATE_DIR)
    if (existsSync(sharedDir)) {
      for (const path of walkFiles(sharedDir)) sources.set(projectPath(path), join(sharedDir, path))
    }
    for (const path of walkFiles(templateDir)) {
      if (path === TEMPLATE_MANIFEST) continue
      sources.set(projectPath(path), join(templateDir, path))
    }

    const written: string[] = []
    const write = (relativePath: string, content: string | Buffer): void => {
      const target = join(dir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      written.push(relativePath)
    }

    for (const [relativePath, source] of sources) {
      if (relativePath === 'IDEA.md' && options.ideaMarkdown !== undefined) {
        write(relativePath, options.ideaMarkdown.endsWith('\n') ? options.ideaMarkdown : `${options.ideaMarkdown}\n`)
        continue
      }
      let text = fillPlaceholders(readFileSync(source, 'utf8'), values)
      if (relativePath === 'package.json' && options.sdkTarballPath) {
        text = dependOnTarball(text, `file:vendor/${basename(options.sdkTarballPath)}`)
      }
      write(relativePath, text)
    }

    if (options.sdkTarballPath) {
      const tarball = resolve(options.sdkTarballPath)
      const target = `vendor/${basename(tarball)}`
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      copyFileSync(tarball, join(dir, target))
      written.push(target)
    }

    if (options.parts && options.parts.length > 0) {
      const added = await addModuleParts({ dir, parts: options.parts, templatesRoot, force: options.force })
      // The parts were planned against the template before anything was
      // written, so what is left to fail here is the file system.
      if (!added.ok) {
        return {
          ok: false,
          code: added.code === 'unknown_part' || added.code === 'already_present' ? added.code : 'io_error',
          message: added.message,
        }
      }
      return {
        ok: true,
        files: [...new Set([...written, ...added.files])].sort(),
        ...(added.notes.length > 0 ? { notes: added.notes } : {}),
      }
    }
    return { ok: true, files: written.sort() }
  } catch (error) {
    return {
      ok: false,
      code: 'io_error',
      message: `Could not scaffold into ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function dependOnTarball(packageJson: string, spec: string): string {
  const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string> }
  pkg.devDependencies = { ...pkg.devDependencies, [SDK_PACKAGE]: spec }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

// ── Parts: what `init --with` and `sprintengine-module add` put in a project ──
//
// A part is a folder under `templates/_parts/<id>/` holding `part.json` and
// the files it adds (placeholders as in a template). Adding one copies its
// files, merges its entry, permissions and `dependsOn` into
// module/manifest.json and plugin.json, adds its scripts and devDependencies
// to package.json, and wires its registration into the entry it extends by
// inserting an import and a call at the top of `registerRenderer` /
// `registerMain`. A part that needs an entry the project lacks brings that
// entry first (`renderer`, `main`).
//
// The build composes on its own: `npm run build` runs `build:renderer` and
// `build:main` when they exist, so adding `main` is adding its script.

const PARTS_DIR = '_parts'
const PART_MANIFEST = 'part.json'
// The order parts are listed and applied in.
const PART_ORDER = ['renderer', 'main', 'mcp', 'settings', 'door']
const ENTRY_KINDS = ['renderer', 'main'] as const
type EntryKind = (typeof ENTRY_KINDS)[number]
const ENTRY_SOURCES: Record<EntryKind, string> = { renderer: 'src/renderer.tsx', main: 'src/main.ts' }
const ENTRY_FUNCTIONS: Record<EntryKind, string> = { renderer: 'registerRenderer', main: 'registerMain' }

export type ModulePartInfo = {
  id: string
  title: string
  summary: string
  /** The entries it needs (`renderer`, `main`); added first when the project lacks them. */
  requires: string[]
  /** The permissions it adds to the manifest. */
  permissions: string[]
}

type PartDefinition = ModulePartInfo & {
  hidden: boolean
  /** Added only when the project has a renderer (the main entry's bridge). */
  permissionsWithRenderer: string[]
  dependsOn: string[]
  entry: Partial<Record<EntryKind, string>>
  scripts: Record<string, string>
  devDependencies: Record<string, string>
  register?: { in: EntryKind; import: string; call: string }
  dir: string
}

export type ModulePartsFailureCode = 'unknown_part' | 'already_present' | 'not_a_project' | 'file_exists' | 'io_error'

export type AddModulePartsOptions = {
  /** The project folder: the one holding package.json and module/manifest.json. */
  dir: string
  /** Part ids (`listModuleParts`). */
  parts: readonly string[]
  /** Defaults to the `templates/` folder beside this package's `dist/`. */
  templatesRoot?: string
  /** Write over files the parts add that already exist. */
  force?: boolean
}

export type AddModulePartsResult =
  | {
      ok: true
      /** The parts added, in order, including entries a part needed. */
      added: string[]
      /** Every file written or changed, relative to the project. */
      files: string[]
      /** Steps left to do by hand (a registration that could not be wired in). */
      notes: string[]
    }
  | { ok: false; code: ModulePartsFailureCode; message: string }

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function readPart(dir: string): PartDefinition {
  const path = join(dir, PART_MANIFEST)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  const register = raw.register as PartDefinition['register'] | undefined
  if (
    raw.id !== basename(dir) ||
    typeof raw.title !== 'string' ||
    typeof raw.summary !== 'string' ||
    !strings(raw.requires) ||
    !strings(raw.permissions) ||
    !strings(raw.dependsOn) ||
    !isStringRecord(raw.entry) ||
    !isStringRecord(raw.scripts) ||
    !isStringRecord(raw.devDependencies) ||
    (raw.permissionsWithRenderer !== undefined && !strings(raw.permissionsWithRenderer)) ||
    (register !== undefined &&
      (!ENTRY_KINDS.includes(register.in) || typeof register.import !== 'string' || typeof register.call !== 'string'))
  ) {
    // Parts ship inside this package; a malformed one is a packaging bug.
    throw new Error(
      `${path} must be { id (the folder name), title, summary, requires, permissions, dependsOn, entry, scripts, devDependencies, register? }.`,
    )
  }
  return {
    id: raw.id,
    title: raw.title,
    summary: raw.summary,
    requires: [...raw.requires],
    permissions: [...raw.permissions],
    hidden: raw.hidden === true,
    permissionsWithRenderer: strings(raw.permissionsWithRenderer) ? [...raw.permissionsWithRenderer] : [],
    dependsOn: [...raw.dependsOn],
    entry: { ...raw.entry },
    scripts: { ...raw.scripts },
    devDependencies: { ...raw.devDependencies },
    ...(register ? { register: { ...register } } : {}),
    dir,
  }
}

function readParts(partsRoot: string): Map<string, PartDefinition> {
  const parts = new Map<string, PartDefinition>()
  if (!existsSync(partsRoot)) return parts
  for (const entry of readdirSync(partsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(partsRoot, entry.name, PART_MANIFEST))) {
      parts.set(entry.name, readPart(join(partsRoot, entry.name)))
    }
  }
  return parts
}

const partRank = (id: string): number => {
  const index = PART_ORDER.indexOf(id)
  return index === -1 ? PART_ORDER.length : index
}

/** The parts `init --with` and `sprintengine-module add` take, in order. */
export function listModuleParts(templatesRoot: string = defaultTemplatesRoot()): ModulePartInfo[] {
  return [...readParts(join(templatesRoot, PARTS_DIR)).values()]
    .filter((part) => !part.hidden)
    .sort((a, b) => partRank(a.id) - partRank(b.id) || a.id.localeCompare(b.id))
    .map(({ id, title, summary, requires, permissions }) => ({ id, title, summary, requires, permissions }))
}

/**
 * The parts to apply, in order, for `requested` on a project whose manifest
 * declares `entry`: each requested part after the entries it needs. Refuses an
 * unknown part, and an entry part the project already has.
 */
function planParts(
  partsRoot: string,
  requested: readonly string[],
  entry: Record<string, string>,
): { ok: true; plan: PartDefinition[] } | { ok: false; code: 'unknown_part' | 'already_present'; message: string } {
  const parts = readParts(partsRoot)
  const known = [...parts.values()].filter((part) => !part.hidden).map((part) => part.id)
  const plan: PartDefinition[] = []
  const has = new Set<string>(ENTRY_KINDS.filter((kind) => entry[kind] !== undefined))
  const add = (id: string, explicit: boolean): string | null => {
    const part = parts.get(id)
    if (!part || (explicit && part.hidden)) return `There is no "${id}" part; the parts are ${known.join(', ')}.`
    if (plan.includes(part)) return null
    const entryKinds = ENTRY_KINDS.filter((kind) => part.entry[kind] !== undefined)
    if (entryKinds.some((kind) => has.has(kind))) {
      // An entry the project has already satisfies a part that needs it.
      if (!explicit) return null
      const kind = entryKinds[0]!
      return `The project already has entry.${kind} (${ENTRY_SOURCES[kind]}); the "${id}" part adds one.`
    }
    for (const needed of part.requires) {
      if (has.has(needed)) continue
      const problem = add(needed, false)
      if (problem) return problem
    }
    plan.push(part)
    for (const kind of entryKinds) has.add(kind)
    return null
  }
  const ordered = [...new Set(requested)].sort((a, b) => partRank(a) - partRank(b))
  for (const id of ordered) {
    const problem = add(id, true)
    if (problem) {
      return {
        ok: false,
        code: parts.has(id) && !parts.get(id)!.hidden ? 'already_present' : 'unknown_part',
        message: problem,
      }
    }
  }
  return { ok: true, plan }
}

/**
 * Insert `importLine` after the source's imports and `call` as the first
 * statement of its `registerRenderer` / `registerMain`. Null when the entry
 * function is not one of the shapes the templates write.
 */
function wireRegistration(source: string, kind: EntryKind, importLine: string, call: string): string | null {
  const fn = ENTRY_FUNCTIONS[kind]
  const opening = [
    new RegExp(
      `^export\\s+(?:const|let)\\s+${fn}\\b[^=\\n]*=\\s*(?:async\\s*)?\\(\\s*(\\w*)[^)]*\\)\\s*(?::[^=\\n]*)?=>\\s*\\{[ \\t]*$`,
      'm',
    ),
    new RegExp(`^export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(\\s*(\\w*)[^)]*\\)[^{\\n]*\\{[ \\t]*$`, 'm'),
  ]
    .map((pattern) => pattern.exec(source))
    .find((match) => match !== null)
  if (!opening) return null
  const lines = source.split('\n')
  const openingLine = source.slice(0, opening.index).split('\n').length - 1
  // An entry that took no host yet (the renderer part's) is given one.
  const param = opening[1] || 'host'
  if (!opening[1]) lines[openingLine] = lines[openingLine]!.replace(/\(\s*\)/, '(host)')
  const nextLine = lines.slice(openingLine + 1).find((line) => line.trim() !== '')
  const nextIndent = /^\s*/.exec(nextLine ?? '')?.[0] ?? ''
  const indent = nextIndent.length > 0 && nextLine?.trim() !== '}' ? nextIndent : '  '
  lines.splice(openingLine + 1, 0, `${indent}${call.replace(/\bhost\b/g, param)}`)

  if (!lines.some((line) => line.trim() === importLine.trim())) {
    let lastImport = -1
    let inImport = false
    for (const [index, line] of lines.entries()) {
      const text = line.trim()
      if (inImport) {
        if (/from\s+['"][^'"]+['"]/.test(text)) {
          inImport = false
          lastImport = index
        }
        continue
      }
      if (text.startsWith('import ')) {
        if (/from\s+['"][^'"]+['"]|^import\s+['"]/.test(text)) lastImport = index
        else inImport = true
        continue
      }
      if (text === '' || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) continue
      break
    }
    lines.splice(lastImport + 1, 0, ...(lastImport === -1 ? [importLine, ''] : [importLine]))
  }
  return lines.join('\n')
}

function displayNameOf(manifest: { id: string; displayName?: unknown }): string {
  return (
    (typeof manifest.displayName === 'string' && sanitizeDisplayText(manifest.displayName)) ||
    displayNameFromId(manifest.id)
  )
}

// `additions` the record lacks, placed before `anchor` (the `build` script, so
// a part's `build:main` sits beside `build:renderer`), the rest kept in order.
function withScripts(record: Record<string, string> | undefined, additions: Record<string, string>, anchor: string) {
  const missing = Object.entries(additions).filter(([key]) => record?.[key] === undefined)
  const entries = Object.entries(record ?? {})
  const at = entries.findIndex(([key]) => key === anchor)
  entries.splice(at === -1 ? entries.length : at, 0, ...missing)
  return Object.fromEntries(entries)
}

function unionInto(list: string[] | undefined, additions: readonly string[]): string[] {
  const result = [...(list ?? [])]
  for (const entry of additions) if (!result.includes(entry)) result.push(entry)
  return result
}

/**
 * Add parts to an existing extension project: their files, manifest entry,
 * permissions and `dependsOn`, build scripts and devDependencies, and the
 * call that registers them. Expected failures come back as a result, never a
 * throw.
 */
export async function addModuleParts(options: AddModulePartsOptions): Promise<AddModulePartsResult> {
  const dir = resolve(options.dir)
  const templatesRoot = resolve(options.templatesRoot ?? defaultTemplatesRoot())
  const manifestPath = join(dir, 'module', 'manifest.json')
  const pluginPath = join(dir, 'plugin.json')
  const packagePath = join(dir, 'package.json')
  if (!existsSync(manifestPath) || !existsSync(packagePath)) {
    return {
      ok: false,
      code: 'not_a_project',
      message: `${dir} is not an extension project: it needs package.json and module/manifest.json.`,
    }
  }
  try {
    type Manifest = {
      id: string
      displayName?: string
      publisher?: string
      permissions?: string[]
      dependsOn?: string[]
      entry?: Record<string, string>
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const plugin = existsSync(pluginPath)
      ? (JSON.parse(readFileSync(pluginPath, 'utf8')) as { permissions?: string[]; dependsOn?: string[] })
      : null
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const planned = planParts(join(templatesRoot, PARTS_DIR), options.parts, manifest.entry ?? {})
    if (!planned.ok) return planned

    const values: Record<string, string> = {
      id: manifest.id,
      displayName: displayNameOf(manifest),
      publisher: sanitizeDisplayText(manifest.publisher ?? '') || DEFAULT_PUBLISHER,
    }
    // Every file first, so a clash leaves the project untouched.
    const copies: Array<{ relativePath: string; source: string }> = []
    for (const part of planned.plan) {
      for (const path of walkFiles(part.dir)) {
        if (path === PART_MANIFEST) continue
        copies.push({ relativePath: projectPath(path), source: join(part.dir, path) })
      }
    }
    const clashes = copies.filter((copy) => existsSync(join(dir, copy.relativePath))).map((copy) => copy.relativePath)
    if (clashes.length > 0 && !options.force) {
      return {
        ok: false,
        code: 'file_exists',
        message: `These files are already in the project: ${clashes.join(', ')}. Move them aside, or add with force to write over them.`,
      }
    }

    const files = new Set<string>()
    for (const copy of copies) {
      const target = join(dir, copy.relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, fillPlaceholders(readFileSync(copy.source, 'utf8'), values))
      files.add(copy.relativePath)
    }

    const notes: string[] = []
    for (const part of planned.plan) {
      manifest.entry = { ...manifest.entry, ...part.entry }
      manifest.permissions = unionInto(manifest.permissions, part.permissions)
      if (part.dependsOn.length > 0) manifest.dependsOn = unionInto(manifest.dependsOn, part.dependsOn)
      pkg.scripts = withScripts(pkg.scripts, part.scripts, 'build')
      pkg.devDependencies = { ...part.devDependencies, ...pkg.devDependencies }
      if (part.register) {
        const sourcePath = ENTRY_SOURCES[part.register.in]
        const absolute = join(dir, sourcePath)
        const wired = existsSync(absolute)
          ? wireRegistration(readFileSync(absolute, 'utf8'), part.register.in, part.register.import, part.register.call)
          : null
        if (wired === null) {
          notes.push(
            `Call ${part.register.call} from ${ENTRY_FUNCTIONS[part.register.in]} in ${sourcePath}, ` +
              `after \`${part.register.import}\`; it could not be wired in automatically.`,
          )
        } else {
          writeFileSync(absolute, wired)
          files.add(sourcePath)
        }
      }
    }
    // The bridge permission follows the renderer, whichever was added first.
    if (manifest.entry?.renderer) {
      for (const part of planned.plan) {
        manifest.permissions = unionInto(manifest.permissions, part.permissionsWithRenderer)
      }
    }
    pkg.devDependencies = Object.fromEntries(
      Object.entries(pkg.devDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    )

    const writeJson = (path: string, value: unknown, relativePath: string): void => {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
      files.add(relativePath)
    }
    writeJson(manifestPath, manifest, 'module/manifest.json')
    if (plugin) {
      // The bundle discloses what the module declares, or an install refuses it.
      plugin.permissions = unionInto(plugin.permissions, manifest.permissions ?? [])
      if (manifest.dependsOn) plugin.dependsOn = unionInto(plugin.dependsOn, manifest.dependsOn)
      writeJson(pluginPath, plugin, 'plugin.json')
    }
    writeJson(packagePath, pkg, 'package.json')

    return { ok: true, added: planned.plan.map((part) => part.id), files: [...files].sort(), notes }
  } catch (error) {
    return {
      ok: false,
      code: 'io_error',
      message: `Could not add ${options.parts.join(', ')} to ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
