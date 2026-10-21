import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

import { skillContentDigest } from '../../src/main/marketplace/skill-content'
import { test } from 'vitest'

test("verify-marketplace", async () => {
const workDir = mkdtempSync(join(tmpdir(), 'sprintengine-marketplace-publish-'))
const verifierBundle = join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'marketplace-registry-verify-for-test.cjs')
const seedRoot = join(process.cwd(), 'resources', 'marketplace')
const registryWorkflowPath = join(seedRoot, '.github', 'workflows', 'marketplace-registry.yml')

mkdirSync(join(process.cwd(), 'node_modules', '.cache', 'sprintengine'), { recursive: true })
buildSync({
  entryPoints: [join(process.cwd(), 'resources', 'marketplace', 'verify-marketplace.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: verifierBundle,
})

/**
 * The seed registry carries no signed bundle any more: the four first-party MCP
 * bundles left with the third-party retirement (2026-09-08), the automation
 * starters with automations (2026-09-30), and what remains is inline agent-CLI
 * rows and one signed capability module (Reviews).
 *
 * The signature gate is still the whole trust story for anything code-bearing,
 * so rather than delete the tests that cover it, they build their own signed
 * bundle: a throwaway ed25519 key signs a probe plugin inside the copied
 * registry, and the key's fingerprint is added to that copy's
 * trusted-publishers.json. The key itself is written to the work dir, never
 * inside a registry root — `assertNoKeyMaterial` rejects committed key material
 * and that check has to keep firing on real registries.
 */
const moduleCliBundle = join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'sprintengine-module-for-marketplace-test.cjs')
buildSync({
  entryPoints: [join(process.cwd(), 'packages', 'module-sdk', 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: moduleCliBundle,
})

const signingKeyPath = join(workDir, 'probe-signing.key')
assert.equal(
  spawnSync(process.execPath, [moduleCliBundle, 'keygen', '--out', signingKeyPath], { encoding: 'utf8' }).status,
  0,
  'sprintengine-module keygen must produce a throwaway signing key'
)

const SIGNED_PROBE_ID = 'signed-probe-mcp'
const SIGNED_PROBE_PUBLISHER = 'Probe Labs'

/**
 * Sign a probe MCP bundle into `root` and publish it in that copy's index and
 * trusted-publishers list. Returns the probe's registry entry as written.
 */
function addSignedProbeBundle(root: string): Record<string, unknown> {
  const pluginRoot = join(root, 'plugins', SIGNED_PROBE_ID)
  mkdirSync(join(pluginRoot, 'mcp'), { recursive: true })
  const server = {
    servers: [
      {
        id: 'probe',
        name: 'Probe',
        category: 'Development',
        description: 'A probe MCP server that exists only to exercise the signature gate.',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'probe-mcp@latest'],
        clients: ['codex', 'claude-code'],
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'local-command',
        auth: 'None',
        capabilities: ['Probing'],
        envVarNames: [],
      },
    ],
  }
  writeFileSync(join(pluginRoot, 'mcp', 'server.json'), `${JSON.stringify(server, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    `${JSON.stringify(
      {
        id: SIGNED_PROBE_ID,
        displayName: 'Signed Probe MCP',
        version: 1,
        defaultEnabled: false,
        source: 'third-party',
        permissions: ['network', 'process:spawn'],
        publisher: SIGNED_PROBE_PUBLISHER,
        category: 'Development',
        summary: 'A signed probe bundle that exists only to exercise the signature gate.',
        components: { mcp: { path: 'mcp/server.json' } },
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const signed = spawnSync(
    process.execPath,
    [moduleCliBundle, 'plugin', 'sign', pluginRoot, '--key', signingKeyPath],
    { encoding: 'utf8' }
  )
  assert.equal(signed.status, 0, signed.stderr)
  const fingerprint = /Signer fingerprint:\s*([a-f0-9]+)/i.exec(signed.stdout ?? '')?.[1]
  assert.ok(fingerprint, `plugin sign must report a signer fingerprint; got: ${signed.stdout}`)

  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8')) as {
    signature: Record<string, unknown>
  }

  const publishersPath = join(root, 'trusted-publishers.json')
  const publishers = JSON.parse(readFileSync(publishersPath, 'utf8')) as {
    publishers: Array<Record<string, unknown>>
  }
  publishers.publishers.push({
    name: SIGNED_PROBE_PUBLISHER,
    verified: true,
    publicKey: manifest.signature.publicKey,
    fingerprint,
    scope: 'Test-only probe bundle',
  })
  writeFileSync(publishersPath, `${JSON.stringify(publishers, null, 2)}\n`, 'utf8')

  const entry: Record<string, unknown> = {
    id: SIGNED_PROBE_ID,
    name: 'Signed Probe MCP',
    publisher: { name: SIGNED_PROBE_PUBLISHER, verified: true },
    summary: 'A signed probe bundle that exists only to exercise the signature gate.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    source: `https://github.com/sprintengine/studio-releases/tree/main/plugins/${SIGNED_PROBE_ID}`,
    provides: ['mcp'],
    signature: manifest.signature,
  }
  const marketplacePath = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as { plugins: Array<unknown> }
  marketplace.plugins.push(entry)
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  return entry
}

const UNSIGNED_PROBE_ID = 'unsigned-probe-mcp'

/**
 * Commit an unsigned MCP bundle into `root` and list it in that copy's index:
 * the declarative lane, where component digests stand in for a signature.
 * Returns the bundle's directory.
 */
function addUnsignedProbeBundle(root: string): string {
  const pluginRoot = join(root, 'plugins', UNSIGNED_PROBE_ID)
  mkdirSync(join(pluginRoot, 'mcp'), { recursive: true })
  const server = `${JSON.stringify(
    {
      servers: [
        {
          id: 'unsigned-probe',
          name: 'Unsigned Probe',
          category: 'Development',
          description: 'A probe MCP server that exists only to exercise the unsigned lane.',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'unsigned-probe-mcp@latest'],
          clients: ['codex', 'claude-code'],
          scope: 'workspace',
          source: 'custom',
          riskLevel: 'local-command',
          auth: 'None',
          capabilities: ['Probing'],
          envVarNames: [],
        },
      ],
    },
    null,
    2
  )}\n`
  writeFileSync(join(pluginRoot, 'mcp', 'server.json'), server, 'utf8')
  writeUnsignedProbeManifest(pluginRoot, {
    mcp: {
      path: 'mcp/server.json',
      files: [{ path: 'mcp/server.json', sha256: createHash('sha256').update(server, 'utf8').digest('hex') }],
    },
  })
  const marketplacePath = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8')) as { plugins: Array<unknown> }
  marketplace.plugins.push({
    id: UNSIGNED_PROBE_ID,
    name: 'Unsigned Probe MCP',
    publisher: { name: 'Probe Labs', verified: false },
    summary: 'An unsigned probe bundle that exists only to exercise the unsigned lane.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    source: `https://github.com/sprintengine/studio-releases/tree/main/plugins/${UNSIGNED_PROBE_ID}`,
    provides: ['mcp'],
  })
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  return pluginRoot
}

function writeUnsignedProbeManifest(pluginRoot: string, components: Record<string, unknown>): void {
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    `${JSON.stringify(
      {
        id: UNSIGNED_PROBE_ID,
        displayName: 'Unsigned Probe MCP',
        version: 1,
        defaultEnabled: false,
        source: 'third-party',
        permissions: ['network', 'process:spawn'],
        publisher: 'Probe Labs',
        category: 'Development',
        summary: 'An unsigned probe bundle that exists only to exercise the unsigned lane.',
        components,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

function readUnsignedProbeComponents(pluginRoot: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8')) as { components: Record<string, unknown> })
    .components
}

type VerifyRun = {
  status: number | null
  stdout: string
  stderr: string
}

function copySeedRegistry(name: string): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  return root
}

function runVerifier(root: string): VerifyRun {
  const result = spawnSync(process.execPath, [verifierBundle, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function testSampleRegistryPasses(): void {
  const root = copySeedRegistry('valid-registry')
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  const seed = JSON.parse(readFileSync(join(seedRoot, 'marketplace.json'), 'utf8')) as { plugins: unknown[] }
  assert.ok(seed.plugins.length >= 4, 'seed registry must carry the agent CLIs')
  assert.match(result.stdout, new RegExp(`marketplace registry verified \\(${seed.plugins.length} plugins\\)`))
}

/**
 * The registry keeps only what a Claude marketplace cannot carry.
 *
 * Until the frozen-snapshots retirement (2026-09-06) this index also held 256
 * `claude-plugin` entries — a months-old copy of
 * `anthropics/claude-plugins-official`, which the app now reads live at the
 * commits that marketplace pins. What is left is the three kinds a GitHub
 * marketplace genuinely cannot deliver, because `component-trust.ts` refuses
 * code-bearing components from any GitHub source unless they are signed: the
 * agent CLIs and the signed first-party bundles.
 *
 * Pinned as an exact multiset rather than a floor, because the failure this
 * guards against is the index GROWING a population that belongs in a
 * marketplace — a snapshot creeping back in one publish at a time, each one
 * individually defensible.
 */
function testRegistryHoldsOnlyWhatAMarketplaceCannotCarry(): void {
  const seed = JSON.parse(readFileSync(join(seedRoot, 'marketplace.json'), 'utf8')) as {
    plugins: Array<{ id: string; provides?: unknown }>
  }
  const kinds = new Map<string, number>()
  for (const plugin of seed.plugins) {
    const provided = Array.isArray(plugin.provides) ? plugin.provides : []
    const names = provided
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { type?: unknown }).type : entry))
      .map((type) => String(type))
      .sort()
      .join('+')
    assert.ok(
      ['cli', 'module'].includes(names),
      `${plugin.id} provides "${names}"; the registry carries agent CLIs and signed capability modules — anything a Claude marketplace can list belongs in one`
    )
    kinds.set(names, (kinds.get(names) ?? 0) + 1)
  }
  assert.deepEqual(
    [...kinds.entries()].sort(),
    [
      ['cli', 18],
      ['module', 1],
    ],
    'the registry is 18 agent CLI integrations and 1 capability module (Reviews)'
  )
}

function testUnsignedEntriesNeedNoLocalManifest(): void {
  // Unsigned source-bearing entries (the generated claude-plugins-official
  // population) verify without a plugins/<id>/ manifest dir and with a
  // data-URI icon; a signed entry with a missing manifest still fails.
  const root = copySeedRegistry('unsigned-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const unsigned = marketplace.plugins.filter((plugin) => plugin.signature === undefined)
  assert.ok(unsigned.length > 0, 'generated seed must carry unsigned entries')
  for (const plugin of unsigned) {
    assert.ok(plugin.mcp !== undefined || plugin.cli !== undefined || typeof plugin.source === 'string')
  }
  addSignedProbeBundle(root)
  assert.equal(runVerifier(root).status, 0, 'the signed probe must verify before its manifest is removed')
  rmSync(join(root, 'plugins', SIGNED_PROBE_ID), { recursive: true, force: true })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${SIGNED_PROBE_ID}/plugin.json`))
}

function testInlineCliVerifiedClaimIsBoundToTrustedPublisherNames(): void {
  // Inline-CLI entries may claim a verified publisher without a signature (the
  // referenced plugin ships inside the signed app bundle), but only under a
  // name listed as verified in trusted-publishers.json — an arbitrary name
  // must not wear the badge.
  const root = copySeedRegistry('inline-cli-publisher-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const inlineCli = marketplace.plugins.find((plugin) => plugin.cli !== undefined)
  assert.ok(inlineCli, 'generated seed must carry inline-CLI entries')
  ;(inlineCli.publisher as Record<string, unknown>).name = 'Unknown Author'
  writeFileSync(path, JSON.stringify(marketplace, null, 2))
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /publisher\.verified.*trusted-publishers\.json/)
}

function testInlineCliMustReferenceABundledPluginInTheAppRepoLayout(): void {
  // With a bundled plugin tree beside the registry root (the app repo layout),
  // every inline-CLI entry must reference an existing plugin manifest; a
  // dangling pluginId fails the publish. The plain copySeedRegistry roots have
  // no sibling plugins tree (the standalone registry repo case), where the
  // check deliberately does not apply.
  const appRepo = join(workDir, 'inline-cli-app-repo')
  const root = join(appRepo, 'marketplace')
  mkdirSync(appRepo, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  cpSync(join(process.cwd(), 'resources', 'plugins'), join(appRepo, 'plugins'), { recursive: true })
  assert.equal(runVerifier(root).status, 0, 'seed with the full bundled plugin tree must verify')
  rmSync(join(appRepo, 'plugins', 'claude-code'), { recursive: true, force: true })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /resources\/plugins\/claude-code\/plugin\.json/)
}

function testStrippedSignatureCannotKeepAVerifiedPublisher(): void {
  // Deleting the signature field from a signed entry must NOT leave it claiming
  // a verified publisher: the signature is the only thing that binds a bundle
  // to its publisher, so dropping it has to be visible on the shelf.
  const root = copySeedRegistry('stripped-signature-registry')
  addSignedProbeBundle(root)
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const signed = marketplace.plugins.find((plugin) => plugin.signature !== undefined)
  assert.ok(signed, 'the probe bundle must be the signed entry')
  delete signed.signature
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /publisher\.verified/)
  assert.match(result.stderr, /may not claim one/)
}

function testUnclaimedPayloadDirFails(): void {
  // A committed payload nothing in the index claims is verified by nothing, yet
  // the packaged-seed install path would still stage it.
  const root = copySeedRegistry('orphan-payload-registry')
  cpSync(join(root, 'plugins', 'review'), join(root, 'plugins', 'nobody-claims-me'), { recursive: true })

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\/nobody-claims-me/)
  assert.match(result.stderr, /no verified marketplace\.json entry/)
}

function testUnsignedPayloadIsDigestChecked(): void {
  // An unsigned bundle has no signature, so the digest walk is what stops its
  // committed bytes drifting from the manifest.
  const root = copySeedRegistry('unsigned-digest-registry')
  const pluginRoot = addUnsignedProbeBundle(root)
  assert.equal(runVerifier(root).status, 0, 'the unsigned probe must verify before it is changed')
  writeFileSync(join(pluginRoot, 'mcp', 'server.json'), '{"servers":[]}\n', 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${UNSIGNED_PROBE_ID}/plugin\\.json`))
  assert.match(result.stderr, /digest does not match committed bytes/)
}

function testRetiredAutomationComponentIsRefused(): void {
  // Automations became scheduled agents, which nothing ships as a file: a
  // bundle that still declares one is refused with the reason.
  const root = copySeedRegistry('retired-automation-registry')
  const pluginRoot = addUnsignedProbeBundle(root)
  const body = '{"name":"Nightly","trigger":{"kind":"schedule"},"action":{"kind":"spawn-agent"}}\n'
  mkdirSync(join(pluginRoot, 'automation'), { recursive: true })
  writeFileSync(join(pluginRoot, 'automation', 'automation.json'), body, 'utf8')
  writeUnsignedProbeManifest(pluginRoot, {
    ...readUnsignedProbeComponents(pluginRoot),
    automation: {
      path: 'automation/automation.json',
      files: [{ path: 'automation/automation.json', sha256: createHash('sha256').update(body, 'utf8').digest('hex') }],
    },
  })

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /components\.automation/)
  assert.match(result.stderr, /Automation components are no longer supported/)
}

function testUnsignedBundleMayNotCarryCode(): void {
  const root = copySeedRegistry('unsigned-code-registry')
  const pluginRoot = addUnsignedProbeBundle(root)
  writeUnsignedProbeManifest(pluginRoot, {
    ...readUnsignedProbeComponents(pluginRoot),
    module: { path: 'module/index.js' },
  })

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /may not carry a module or cli component/)
}

function testInlineIconMustMatchTheCommittedMark(): void {
  // The shipped mark is a base64 blob nobody can review; the committed SVG is
  // what a reviewer reads. They have to be the same bytes.
  const root = copySeedRegistry('icon-drift-registry')
  const markPath = join(root, 'icons', 'claude-code.svg')
  writeFileSync(markPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"/>\n', 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /does not match the committed mark/)
}

function testSchemaInvalidRegistryFailsClearly(): void {
  const root = copySeedRegistry('invalid-schema-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  marketplace.schemaVersion = 99
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /marketplace\.json\.schemaVersion/)
  assert.match(result.stderr, /schemaVersion must be 1/)
}

function testTamperedPluginFailsThroughCliVerify(): void {
  const root = copySeedRegistry('tampered-registry')
  addSignedProbeBundle(root)
  const path = join(root, 'plugins', SIGNED_PROBE_ID, 'plugin.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  manifest.displayName = 'Tampered Probe MCP'
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${SIGNED_PROBE_ID}/plugin\\.json`))
  assert.match(result.stderr, /sprintengine-module plugin verify failed/)
  assert.match(result.stderr, /INVALID signature/)
}

function testTamperedComponentFailsThroughCliVerify(): void {
  const root = copySeedRegistry('tampered-component-registry')
  addSignedProbeBundle(root)
  const path = join(root, 'plugins', SIGNED_PROBE_ID, 'mcp', 'server.json')
  const component = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  component.servers = []
  writeFileSync(path, `${JSON.stringify(component, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${SIGNED_PROBE_ID}/plugin\\.json`))
  assert.match(result.stderr, /sprintengine-module plugin verify failed/)
  assert.match(result.stderr, /component digests/i)
}

// The seed's one entry with a bundle `source` to point somewhere else.
const SOURCE_BEARING_ID = 'review'

function testEntrySourceOnNonAllowlistedHostFails(): void {
  const root = copySeedRegistry('evil-source-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<{ id: string; source?: string }> }
  const target = marketplace.plugins.find((plugin) => plugin.id === SOURCE_BEARING_ID)
  assert.ok(target, `seed registry must carry the ${SOURCE_BEARING_ID} entry`)
  target.source = `https://evil.example.com/plugins/${SOURCE_BEARING_ID}`
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins\\.${SOURCE_BEARING_ID}\\.source`))
  assert.match(result.stderr, /allowlist/)
}

function testEntrySourceOnAllowlistedNonCanonicalOwnerPasses(): void {
  const root = copySeedRegistry('non-canonical-owner-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<{ id: string; source?: string }> }
  const first = marketplace.plugins.find((plugin) => plugin.id === SOURCE_BEARING_ID)
  assert.ok(first, `seed registry must carry the ${SOURCE_BEARING_ID} entry`)
  first.source = `https://github.com/another-org/registry/tree/main/plugins/${first.id}`
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /marketplace registry verified/)
}

function testBundledSkillPayloadDigestsGateThePublish(): void {
  const root = copySeedRegistry('skill-payload-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<Record<string, unknown>> }
  const body = '---\nname: probe\n---\n'
  const files = [
    {
      path: 'SKILL.md',
      sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      size: Buffer.byteLength(body, 'utf8'),
    },
  ]
  marketplace.plugins.push({
    id: 'digest-probe',
    name: 'probe',
    publisher: { name: 'Probe', verified: false },
    summary: 'Digest gate probe.',
    category: 'Development',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    latest: 1,
    provides: ['skills'],
    tags: ['claude-plugin'],
    source: 'https://github.com/acme/probe',
    skills: [{ name: 'probe', description: 'Probe skill.', path: 'skills/probe', files, contentDigest: skillContentDigest(files) }],
  })
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')
  const payloadDir = join(root, 'skills', 'digest-probe', 'probe')
  mkdirSync(payloadDir, { recursive: true })
  writeFileSync(join(payloadDir, 'SKILL.md'), body, 'utf8')

  // Digest-bearing entry + matching payload verifies.
  const ok = runVerifier(root)
  assert.equal(ok.status, 0, ok.stderr)

  // Tampered payload bytes fail the publish.
  writeFileSync(join(payloadDir, 'SKILL.md'), '---\nname: evil\n---\n', 'utf8')
  const tampered = runVerifier(root)
  assert.equal(tampered.status, 1)
  assert.match(tampered.stderr, /skills\/digest-probe\/probe/)
  assert.match(tampered.stderr, /digest verification/)

  // A digest-bearing entry with no payload dir at all also fails.
  rmSync(join(root, 'skills', 'digest-probe'), { recursive: true, force: true })
  const missing = runVerifier(root)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /skills\/digest-probe/)
  assert.match(missing.stderr, /payload dir is missing/)
}

function testPublishScriptsTargetRegistryRoot(): void {
  const appPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const verifyScript = appPackage.scripts?.['verify:marketplace-registry'] ?? ''
  assert.match(verifyScript, /verify-marketplace\.ts/)
  assert.doesNotMatch(verifyScript, /--root resources\/marketplace/)

  const workflow = readFileSync(registryWorkflowPath, 'utf8')
  assert.match(workflow, /marketplace\.json/)
  assert.match(workflow, /plugins\/\*\*/)
  assert.match(workflow, /trusted-publishers\.json/)
  assert.match(workflow, /--root "\$GITHUB_WORKSPACE\/registry"/)
  assert.doesNotMatch(workflow, /resources\/marketplace/)
}

try {
  testSampleRegistryPasses()
  testRegistryHoldsOnlyWhatAMarketplaceCannotCarry()
  testUnsignedEntriesNeedNoLocalManifest()
  testInlineCliVerifiedClaimIsBoundToTrustedPublisherNames()
  testInlineCliMustReferenceABundledPluginInTheAppRepoLayout()
  testStrippedSignatureCannotKeepAVerifiedPublisher()
  testUnclaimedPayloadDirFails()
  testUnsignedPayloadIsDigestChecked()
  testRetiredAutomationComponentIsRefused()
  testUnsignedBundleMayNotCarryCode()
  testInlineIconMustMatchTheCommittedMark()
  testSchemaInvalidRegistryFailsClearly()
  testTamperedPluginFailsThroughCliVerify()
  testTamperedComponentFailsThroughCliVerify()
  testEntrySourceOnNonAllowlistedHostFails()
  testEntrySourceOnAllowlistedNonCanonicalOwnerPasses()
  testBundledSkillPayloadDigestsGateThePublish()
  testPublishScriptsTargetRegistryRoot()
  console.log('marketplace publish validation tests passed')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
})
