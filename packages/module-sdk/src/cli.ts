#!/usr/bin/env node
// sprintengine-module — packaging and signing CLI for SprintEngine Studio
// capability module authors. Runs without repo access: everything it needs
// ships in the @sprintengine/module-sdk tarball.
//
//   init             create an extension project from one of the templates
//   add              add a part (main, mcp, settings, door) to an extension project
//   keygen           generate an ed25519 signing keypair (private key PEM)
//   pack             validate a module directory and assemble an installable copy
//   sign             write a detached ed25519 signature into manifest.json
//   verify           check a module directory the way the studio will
//   plugin scaffold  create a plugin bundle skeleton
//   plugin pack      validate and assemble an installable plugin bundle
//   plugin sign      write a detached ed25519 signature into plugin.json
//   plugin verify    check a plugin bundle the way the studio will
//
// sign/verify operate on the VALIDATED manifest shape (the same shape the app
// verifies), and sign writes that normalized manifest back to disk so the
// signed bytes on disk are exactly what the app checks. sign also records the
// digest of every file the module ships (`files`), so the signature covers the
// code; the app trusts a module by its publisher key only when those match.

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { checkHostApiCompatibility, HOST_API_VERSION } from './host-api.js'
import { BUNDLED_MODULE_IDS, type CapabilityManifest } from './index.js'
import { parseThirdPartyModuleManifest, type ThirdPartyManifestIssue } from './manifest-validate.js'
import { computeModuleFileDigestsSync, moduleFileDigestIssuesSync } from './module-files.js'
import {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  validateMarketplacePluginAuthoringManifest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
} from './plugin-manifest.js'
import {
  computeMarketplacePluginComponentsWithDigestsSync,
  marketplaceComponentDigestMismatchIssuesSync,
} from './plugin-component-digests.js'
import { generateModuleSigningKeyPair, signManifest, verifyModuleSignature } from './signing.js'

const USAGE = `sprintengine-module — pack, sign, and verify SprintEngine Studio capability modules

Usage:
  sprintengine-module init <dir> --template <id> [--with <part,...>] [--id <module-id>] [--name <name>] [--sdk-tarball <file>] [--force]
  sprintengine-module add <part>... [--project <dir>] [--force]
  sprintengine-module keygen [--out <file>] [--force]
  sprintengine-module pack <module-dir> [--out <dir>] [--force] [--allow-reserved-id]
  sprintengine-module sign <module-dir> --key <private-key.pem>
  sprintengine-module verify <module-dir>
  sprintengine-module plugin scaffold <plugin-id> [--out <dir>] [--component <kind>]... [--force]
  sprintengine-module plugin pack <plugin-dir> [--out <dir>] [--force]
  sprintengine-module plugin sign <plugin-dir> --key <private-key.pem>
  sprintengine-module plugin verify <plugin-dir>

init creates an extension project in <dir> from a template: the module, its
build and dev-loop scripts, and the agent instructions that send whichever agent
works on it to the extension guide. --id defaults to the folder name, --name to the id title-cased;
--sdk-tarball depends on a local SDK tarball instead of the npm release. Run it
with an unknown --template to list the templates. --with adds parts on top of
the template, as add does.

add puts a part into an existing project (--project, default the current
folder): main (src/main.ts, entry.main and its build), mcp (MCP tools from
entry.main), settings (a Settings section), door (a full-page surface). It
copies the part's files and test, merges its entry, permissions and dependsOn
into module/manifest.json and plugin.json, adds its build script, and wires
its registration into src/renderer.tsx or src/main.ts. A part that needs an
entry the project lacks brings that entry too. Run it with no part to list
them.

keygen writes an ed25519 private key (PKCS#8 PEM) to --out
(default module-signing.key); a leading ~ is your home folder, on Windows too.
Keep it out of the module directory and out of version control; sign derives
the public key from it.

pack validates <module-dir>/manifest.json and copies the module into --out
(default packed/<id>) as an installable module directory. node_modules, .git,
and key files (*.key, *.pem) are never copied.

sign validates manifest.json, records the sha256 of every file the module ships
in its "files" field (everything pack copies, manifest.json aside), signs the
normalized manifest with --key, and writes it back to manifest.json. Sign
again after any change to the module's files.

verify validates manifest.json, checks its signature, and checks that the files
pack would copy are exactly the ones "files" lists, byte for byte: exit 0 with
the signer fingerprint when all of that holds, exit 1 when the module is
unsigned, carries no "files", or was changed after signing.

plugin scaffold creates plugin.json plus component placeholders for mcp, skills
and module by default. Pass --component repeatedly to scaffold
only the kinds you want.

plugin sign writes component file digests into the normalized plugin.json bundle
manifest before signing it. plugin pack validates plugin.json through the
marketplace plugin validator, verifies the signature and component digests, and
copies the bundle while excluding key material.`

type CliIssue = ThirdPartyManifestIssue | MarketplaceManifestIssue

function fail(message: string, issues?: CliIssue[]): never {
  console.error(message)
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'manifest' : issue.path}: ${issue.message}`)
  }
  process.exit(1)
}

function readManifest(moduleDir: string): { manifestPath: string; manifest: CapabilityManifest } {
  const manifestPath = join(moduleDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    fail(`No manifest.json in ${moduleDir}.`)
  }
  const result = parseThirdPartyModuleManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid module manifest at ${manifestPath}:`, result.issues)
  }
  // The studio refuses a module built for a host API it does not provide, so
  // the author hears it here rather than from a module that never loads.
  const hostApi = checkHostApiCompatibility(result.manifest)
  if (!hostApi.ok)
    fail(`Invalid module manifest at ${manifestPath}:`, [{ path: 'engines.hostApi', message: hostApi.message }])
  return { manifestPath, manifest: result.manifest }
}

function readPluginAuthoringManifest(pluginDir: string): {
  manifestPath: string
  manifest: MarketplacePluginAuthoringManifest
} {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`No plugin.json in ${pluginDir}.`)
  }
  const result = parseMarketplacePluginAuthoringManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid plugin manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function readPluginManifest(pluginDir: string): { manifestPath: string; manifest: MarketplacePluginManifest } {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    fail(`No plugin.json in ${pluginDir}.`)
  }
  const result = parseMarketplacePluginManifest(readFileSync(manifestPath, 'utf8'))
  if (!result.ok) {
    fail(`Invalid plugin manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function componentId(pluginId: string, suffix: string): string {
  const maxBaseLength = 63 - suffix.length - 1
  const base = pluginId.slice(0, maxBaseLength).replace(/-+$/g, '') || 'plugin'
  return `${base}-${suffix}`
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pluginComponentsFromKinds(kinds: MarketplaceComponentKind[], id: string): MarketplacePluginComponents {
  const components: MarketplacePluginComponents = {}
  for (const kind of kinds) {
    switch (kind) {
      case 'mcp':
        components.mcp = { path: 'mcp/server.json' }
        break
      case 'skills':
        components.skills = { path: `skills/${id}` }
        break
      case 'module':
        components.module = { path: 'module' }
        break
    }
  }
  return components
}

function parseComponentKinds(raw: unknown): MarketplaceComponentKind[] {
  const requested = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [...MARKETPLACE_COMPONENT_KINDS]
  const kinds: MarketplaceComponentKind[] = []
  const issues: MarketplaceManifestIssue[] = []
  for (const [index, value] of requested.entries()) {
    if (typeof value !== 'string' || !MARKETPLACE_COMPONENT_KINDS.includes(value as MarketplaceComponentKind)) {
      issues.push({
        path: `component[${index}]`,
        message: `must be one of: ${MARKETPLACE_COMPONENT_KINDS.join(', ')}.`,
      })
      continue
    }
    if (!kinds.includes(value as MarketplaceComponentKind)) kinds.push(value as MarketplaceComponentKind)
  }
  if (issues.length > 0) fail('Invalid --component value:', issues)
  // Canonical order, whatever order the flags were typed in (G13). See
  // `canonicalComponentOrder` for why this is not cosmetic.
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => kinds.includes(kind))
}

/**
 * The plugin's components, keyed in `MARKETPLACE_COMPONENT_KINDS` order (G13).
 *
 * This looks cosmetic and is not. A registry entry's `provides` array must
 * equal the kinds of the bundle it points at, and the app derives that list by
 * filtering `MARKETPLACE_COMPONENT_KINDS` — so `provides` is ALWAYS in canonical
 * order on the app's side, while an author reading their own plugin.json copies
 * whatever order they happen to see there. `["skills","mcp"]` against a bundle
 * the downloader reads as `mcp, skills` is a registry mismatch that fails at
 * install, on the user's machine, with a message about a list that looks
 * identical to the one they wrote. Writing plugin.json in the canonical order is
 * how the two are kept from disagreeing at the only point an author looks.
 */
function canonicalComponentOrder(components: MarketplacePluginComponents): MarketplacePluginComponents {
  const ordered: MarketplacePluginComponents = {}
  for (const kind of MARKETPLACE_COMPONENT_KINDS) {
    const component = components[kind]
    if (component !== undefined) ordered[kind] = component
  }
  return ordered
}

/** The `provides` list a registry entry for this bundle must carry, verbatim. */
function providesForComponents(components: MarketplacePluginComponents): MarketplaceComponentKind[] {
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => components[kind] !== undefined)
}

function assertPluginComponentDigestsMatch(pluginDir: string, manifest: MarketplacePluginManifest): void {
  const issues = marketplaceComponentDigestMismatchIssuesSync(pluginDir, manifest, {
    bytesLabel: 'current bytes',
    blockedFileMessage: (path) => `component file "${path}" cannot be signed or packed.`,
  })
  if (issues.length > 0) fail(`Plugin component digests do not match ${pluginDir}:`, issues)
}

function uniqueSiblingPath(parent: string, name: string): string {
  let attempt = 0
  while (true) {
    const candidate = join(parent, `.${name}.${process.pid}.${Date.now()}.${attempt}`)
    if (!existsSync(candidate)) return candidate
    attempt += 1
  }
}

function publishPackedDirectory(tempDir: string, outDir: string): void {
  const outParent = dirname(outDir)
  const previousDir = existsSync(outDir) ? uniqueSiblingPath(outParent, `${basename(outDir)}.previous`) : null
  if (previousDir) renameSync(outDir, previousDir)
  try {
    renameSync(tempDir, outDir)
  } catch (error) {
    if (previousDir) {
      try {
        renameSync(previousDir, outDir)
      } catch {
        // Best effort rollback; the original error is more useful to callers.
      }
    }
    throw error
  }
  if (previousDir) rmSync(previousDir, { recursive: true, force: true })
}

// A leading `~` is the home folder. The templates' `keygen` script quotes it,
// so no shell expands it: npm runs scripts in cmd.exe on Windows, which
// expands neither `~` nor `$HOME`.
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : path
}

function keygen(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
  })
  const outPath = resolve(expandHome(values.out ?? 'module-signing.key'))
  if (existsSync(outPath) && !values.force) {
    fail(`${outPath} already exists. Pass --force to overwrite it.`)
  }
  const keyPair = generateModuleSigningKeyPair()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, keyPair.privateKeyPem, { mode: 0o600 })
  console.log(`Wrote ed25519 private key to ${outPath}`)
  console.log(`Public key fingerprint: ${keyPair.fingerprint}`)
  console.log('Keep this key out of the module directory and out of version control.')
}

function pack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' }, 'allow-reserved-id': { type: 'boolean' } },
    allowPositionals: true,
  })
  const moduleDir = positionals[0]
  if (!moduleDir) fail(`pack requires a module directory.\n\n${USAGE}`)
  const sourceDir = resolve(moduleDir)
  const { manifest } = readManifest(sourceDir)

  if (BUNDLED_MODULE_IDS.includes(manifest.id) && values['allow-reserved-id'] !== true) {
    fail(
      `id "${manifest.id}" is a reserved id, publisher-locked to the first-party signing key — ` +
        `the app only installs it when the manifest is signed by a first-party marketplace publisher. ` +
        `Choose a different module id, or pass --allow-reserved-id if you are the first-party publisher.`,
    )
  }
  const missingEntries: ThirdPartyManifestIssue[] = []
  for (const [key, relPath] of Object.entries(manifest.entry ?? {})) {
    if (typeof relPath === 'string' && !existsSync(join(sourceDir, relPath))) {
      missingEntries.push({ path: `entry.${key}`, message: `declared file "${relPath}" does not exist.` })
    }
  }
  if (missingEntries.length > 0) {
    fail(`Module entry files are missing in ${sourceDir}:`, missingEntries)
  }

  // A pack whose files no longer match the signed digests would install as
  // tampered; say so here, where re-signing is one command away.
  if (manifest.files) {
    const drift = moduleFileDigestIssuesSync(sourceDir, manifest.files, { walk: 'pack' })
    if (drift.length > 0) {
      fail(`Module files changed after signing in ${sourceDir}; run \`sprintengine-module sign\` again:`, drift)
    }
  }

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (outDir === sourceDir || outDir.startsWith(sourceDir + '/')) {
    fail('The pack output directory must be outside the module directory.')
  }

  const skipped: string[] = []
  cpSync(sourceDir, outDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = basename(src)
      if (name === 'node_modules' || name === '.git') return false
      if (name.endsWith('.key') || name.endsWith('.pem')) {
        skipped.push(name)
        return false
      }
      return true
    },
  })
  for (const name of skipped) {
    console.warn(`Skipped ${name}: key material is never packed into a module.`)
  }
  const signedNote = !manifest.signature
    ? 'UNSIGNED — run `sprintengine-module sign` before distributing'
    : manifest.files
      ? 'signed'
      : 'signed WITHOUT file digests — run `sprintengine-module sign` again before distributing'
  console.log(`Packed ${manifest.id} (${signedNote}) to ${outDir}`)
}

function signCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const moduleDir = positionals[0]
  if (!moduleDir) fail(`sign requires a module directory.\n\n${USAGE}`)
  if (!values.key) fail('sign requires --key <private-key.pem> (create one with `sprintengine-module keygen`).')
  const keyPath = resolve(values.key)
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const moduleRoot = resolve(moduleDir)
  const { manifestPath, manifest } = readManifest(moduleRoot)
  // The pack view: node_modules, .git and key files are left out here exactly
  // as pack leaves them out, so the packed copy matches what was signed.
  const digests = computeModuleFileDigestsSync(moduleRoot, { walk: 'pack' })
  if (!digests.ok) fail(`Module files in ${moduleRoot} cannot be signed:`, digests.issues)
  const unlistedEntries: ThirdPartyManifestIssue[] = []
  for (const [key, relPath] of Object.entries(manifest.entry ?? {})) {
    if (typeof relPath === 'string' && digests.files[relPath] === undefined) {
      unlistedEntries.push({ path: `entry.${key}`, message: `declared file "${relPath}" is not in the module.` })
    }
  }
  if (unlistedEntries.length > 0) fail(`Module entry files are missing in ${moduleRoot}:`, unlistedEntries)
  // Sign the validated manifest minus any prior signature (re-signing replaces
  // it), with the digests just taken in place of any earlier ones.
  const { signature: _prior, files: _priorFiles, ...declared } = manifest
  const unsigned: CapabilityManifest = { ...declared, files: digests.files }
  let signature
  try {
    signature = signManifest(unsigned, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signed: CapabilityManifest = { ...unsigned, signature }
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + '\n')
  const { fingerprint } = verifyModuleSignature(signed)
  console.log(`Signed ${manifest.id} and ${Object.keys(digests.files).length} file(s); wrote ${manifestPath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function verifyCommand(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const moduleDir = positionals[0]
  if (!moduleDir) fail(`verify requires a module directory.\n\n${USAGE}`)
  const { manifest } = readManifest(resolve(moduleDir))
  if (!manifest.signature) {
    fail(`${manifest.id} is unsigned. The app will show it as 'unsigned'; sign it with \`sprintengine-module sign\`.`)
  }
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (manifest changed after signing, or wrong key). ` +
        'The app will refuse to trust it. Re-sign the module.',
    )
  }
  if (!manifest.files) {
    fail(
      `${manifest.id} is signed, but its manifest carries no "files" digests, so the signature does not cover its ` +
        'code and the app will not trust it by its publisher key. Sign it again with `sprintengine-module sign`.',
    )
  }
  const drift = moduleFileDigestIssuesSync(resolve(moduleDir), manifest.files, { walk: 'pack' })
  if (drift.length > 0) {
    fail(
      `${manifest.id} does not match the file digests its manifest signs (changed after signing?). ` +
        'The app will refuse it as tampered. Sign it again with `sprintengine-module sign`.',
      drift,
    )
  }
  console.log(`${manifest.id}: signature valid; ${Object.keys(manifest.files).length} file(s) match`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function pluginScaffold(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean' },
      component: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  })
  const id = positionals[0]
  if (!id) fail(`plugin scaffold requires a plugin id.\n\n${USAGE}`)
  const displayName = displayNameFromId(id)
  const components = pluginComponentsFromKinds(parseComponentKinds(values.component), id)
  const outDir = resolve(values.out ?? id)
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to scaffold into it.`)
  }
  const draft = {
    id,
    displayName,
    version: 1,
    publisher: 'Your Name',
    category: 'dev-tools',
    summary: `${displayName} marketplace plugin.`,
    defaultEnabled: false,
    permissions: ['network'],
    components,
  }
  const draftValidation = validateMarketplacePluginAuthoringManifest(draft)
  if (!draftValidation.ok) {
    fail('plugin scaffold cannot create a valid plugin.json from those inputs:', draftValidation.issues)
  }
  mkdirSync(outDir, { recursive: true })

  writeJson(join(outDir, 'plugin.json'), {
    ...draftValidation.manifest,
    components: canonicalComponentOrder(draftValidation.manifest.components),
  })

  if (components.mcp) {
    writeJson(join(outDir, components.mcp.path), {
      servers: [
        {
          id: componentId(id, 'mcp'),
          name: `${displayName} MCP`,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          clients: ['codex'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
        },
      ],
    })
  }
  if (components.skills) {
    const skillDir = join(outDir, components.skills.path)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${displayName} skill placeholder.\n---\n\nDescribe when and how this skill should be used.\n`,
    )
  }
  if (components.module) {
    const moduleDir = join(outDir, components.module.path)
    mkdirSync(moduleDir, { recursive: true })
    writeJson(join(moduleDir, 'manifest.json'), {
      id: componentId(id, 'module'),
      displayName: `${displayName} Module`,
      version: 1,
      defaultEnabled: false,
      permissions: ['network'],
      engines: { hostApi: HOST_API_VERSION },
      entry: { main: 'main.cjs' },
    })
    writeFileSync(join(moduleDir, 'main.cjs'), 'exports.registerMain = () => {}\n')
  }

  console.log(`Scaffolded marketplace plugin ${id} at ${outDir}`)
  console.log(`Registry entry "provides": ${JSON.stringify(providesForComponents(components))}`)
  console.log(
    'Run `sprintengine-module keygen`, then `sprintengine-module plugin sign`, then `sprintengine-module plugin verify`.',
  )
}

function pluginPack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin pack requires a plugin directory.\n\n${USAGE}`)
  const sourceDir = resolve(pluginDir)
  const { manifest } = readPluginManifest(sourceDir)
  const { valid } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(`${manifest.id} has an INVALID signature. Re-sign the plugin before packing it.`)
  }
  assertPluginComponentDigestsMatch(sourceDir, manifest)

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (isInsideOrEqual(sourceDir, outDir)) {
    fail('The plugin pack output directory must be outside the plugin directory.')
  }

  const skipped: string[] = []
  const outParent = dirname(outDir)
  mkdirSync(outParent, { recursive: true })
  const tempDir = uniqueSiblingPath(outParent, `${basename(outDir)}.tmp`)
  try {
    cpSync(sourceDir, tempDir, {
      recursive: true,
      force: true,
      filter: (src) => {
        const name = basename(src)
        if (name === 'node_modules' || name === '.git') return false
        if (name.endsWith('.key') || name.endsWith('.pem')) {
          skipped.push(name)
          return false
        }
        return true
      },
    })
    publishPackedDirectory(tempDir, outDir)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    fail(`Could not pack plugin to ${outDir}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  for (const name of skipped) {
    console.warn(`Skipped ${name}: key material is never packed into a plugin.`)
  }
  console.log(`Packed ${manifest.id} (signature valid) to ${outDir}`)
}

function pluginSign(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin sign requires a plugin directory.\n\n${USAGE}`)
  if (!values.key) fail('plugin sign requires --key <private-key.pem> (create one with `sprintengine-module keygen`).')
  const keyPath = resolve(values.key)
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const pluginRoot = resolve(pluginDir)
  const { manifestPath, manifest } = readPluginAuthoringManifest(pluginRoot)
  const { signature: _prior, ...unsigned } = manifest
  const componentsWithDigests = computeMarketplacePluginComponentsWithDigestsSync(pluginRoot, unsigned.components, {
    blockedFileMessage: (path) => `component file "${path}" cannot be signed or packed.`,
  })
  if (!componentsWithDigests.ok) {
    fail(`Plugin component files are not packable in ${pluginRoot}:`, componentsWithDigests.issues)
  }
  const unsignedWithDigests: MarketplacePluginAuthoringManifest = {
    ...unsigned,
    // G13: the signed manifest is written back in canonical component order, so
    // the `provides` an author copies out of it is the one the registry
    // mismatch gate computes.
    components: canonicalComponentOrder(componentsWithDigests.components),
  }
  let signature
  try {
    signature = signManifest(unsignedWithDigests, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signed: MarketplacePluginManifest = { ...unsignedWithDigests, signature }
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + '\n')
  const { fingerprint } = verifyModuleSignature(signed)
  console.log(`Signed plugin ${manifest.id}; wrote normalized manifest to ${manifestPath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
  console.log(`Registry entry "provides": ${JSON.stringify(providesForComponents(unsignedWithDigests.components))}`)
}

function pluginVerify(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const pluginDir = positionals[0]
  if (!pluginDir) fail(`plugin verify requires a plugin directory.\n\n${USAGE}`)

  const sourceDir = resolve(pluginDir)
  const authoring = readPluginAuthoringManifest(sourceDir)
  if (!authoring.manifest.signature) {
    fail(
      `${authoring.manifest.id} is unsigned. The app will refuse to install it; sign it with \`sprintengine-module plugin sign\`.`,
    )
  }
  const { manifest } = readPluginManifest(sourceDir)
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (plugin.json changed after signing, or wrong key). ` +
        'The app will refuse to install it. Re-sign the plugin.',
    )
  }
  assertPluginComponentDigestsMatch(sourceDir, manifest)
  console.log(`${manifest.id}: plugin signature valid`)
  console.log(`Signer fingerprint: ${fingerprint}`)
  console.log(`Registry entry "provides": ${JSON.stringify(providesForComponents(manifest.components))}`)
}

function pluginCommand(args: string[]): void {
  const [command, ...rest] = args
  switch (command) {
    case 'scaffold':
      pluginScaffold(rest)
      break
    case 'pack':
      pluginPack(rest)
      break
    case 'sign':
      pluginSign(rest)
      break
    case 'verify':
      pluginVerify(rest)
      break
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE)
      break
    default:
      fail(`Unknown plugin command "${command}".\n\n${USAGE}`)
  }
}

// The scaffolder is loaded only for `init`: it finds its templates relative to
// its own file, which a bundle of this CLI need not preserve for the other
// commands.
async function init(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      template: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      'sdk-tarball': { type: 'string' },
      with: { type: 'string', multiple: true },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const { listModuleTemplates, scaffoldModuleProject, sdkPackageVersion } = await import('./scaffold.js')
  const parts = (values.with ?? [])
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  const templates = (): string =>
    listModuleTemplates()
      .map((template) => `  ${template.id.padEnd(20)} ${template.summary}`)
      .join('\n')
  const dir = positionals[0]
  if (!dir) fail(`init requires a project directory.\n\n${USAGE}`)
  if (!values.template) fail(`init requires --template <id>. The templates:\n${templates()}`)
  const target = resolve(dir)
  const id =
    values.id ??
    basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const tarball = values['sdk-tarball'] ? resolve(values['sdk-tarball']) : undefined
  if (tarball && !existsSync(tarball)) fail(`SDK tarball not found: ${tarball}`)
  const result = await scaffoldModuleProject({
    dir: target,
    templateId: values.template,
    id,
    displayName: values.name ?? displayNameFromId(id),
    sdkVersion: sdkPackageVersion(),
    ...(tarball ? { sdkTarballPath: tarball } : {}),
    ...(values.force ? { force: true } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  })
  if (!result.ok) {
    fail(result.code === 'unknown_template' ? `${result.message}\n\n${templates()}` : result.message)
  }
  const withParts = parts.length > 0 ? ` with ${parts.join(', ')}` : ''
  console.log(
    `Created ${id} from the ${values.template} template${withParts} in ${target} (${result.files.length} files).`,
  )
  for (const note of result.notes ?? []) console.log(`To do: ${note}`)
  console.log('Next: npm install, then npm run check; npm run dev:install side-loads it into Studio.')
}

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const { addModuleParts, listModuleParts } = await import('./scaffold.js')
  const parts = (): string =>
    listModuleParts()
      .map((part) => `  ${part.id.padEnd(12)} ${part.summary}`)
      .join('\n')
  const requested = positionals
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  if (requested.length === 0) fail(`add requires a part. The parts:\n${parts()}`)
  const dir = resolve(values.project ?? '.')
  const result = await addModuleParts({ dir, parts: requested, ...(values.force ? { force: true } : {}) })
  if (!result.ok) fail(result.code === 'unknown_part' ? `${result.message}\n\n${parts()}` : result.message)
  console.log(`Added ${result.added.join(', ')} to ${dir}:`)
  for (const file of result.files) console.log(`  ${file}`)
  for (const note of result.notes) console.log(`To do: ${note}`)
  console.log('Next: npm install (a part may add dependencies), then npm run check.')
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'init':
    init(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    break
  case 'add':
    add(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    break
  case 'keygen':
    keygen(rest)
    break
  case 'pack':
    pack(rest)
    break
  case 'sign':
    signCommand(rest)
    break
  case 'verify':
    verifyCommand(rest)
    break
  case 'plugin':
    pluginCommand(rest)
    break
  case 'plugin-scaffold':
    pluginScaffold(rest)
    break
  case 'plugin-pack':
    pluginPack(rest)
    break
  case 'plugin-sign':
    pluginSign(rest)
    break
  case 'plugin-verify':
    pluginVerify(rest)
    break
  case undefined:
  case '--help':
  case '-h':
    console.log(USAGE)
    break
  default:
    fail(`Unknown command "${command}".\n\n${USAGE}`)
}
