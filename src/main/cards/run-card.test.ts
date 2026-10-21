/**
 * What `Go` does, and what it refuses to do (item 2469).
 *
 * Every installer is injected, so this suite is about the EXECUTOR and not
 * about installing anything: there is no workspace on disk, no MCP catalogue,
 * no source store and no git. What is asserted is the four things only this
 * module can be wrong about.
 *
 *   1. The order. A card is an ordered list and the whole point of `open.chat`
 *      being last is that the chat opens onto tools that are already there, so
 *      the happy path asserts a call LOG rather than a set of calls.
 *   2. The first failure stops the rest, and says which ones did not run. A
 *      toast that named only what broke would leave the person guessing how
 *      much of the card had happened.
 *   3. A second press is a no-op. Pressing Go twice must not install twice,
 *      and "already there" is a success, not an error.
 *   4. `open.chat` is the last action or the card is refused before anything
 *      runs — a chat attached to a server that failed to install is worse than
 *      no chat.
 *
 * Plus the boundary: an id a feed made up resolves against nothing this app
 * holds, and a repository name is re-checked here rather than taken on the
 * parser's word.
 *
 * And, since item 2473, the pass-through: `Go` opens the model picker and
 * choosing a row is what runs the card, so the row's model, effort and
 * permission preset ride the request. The executor must hand all three back
 * untouched — it is an installer, and none of the three means anything to one.
 */
import assert from 'node:assert/strict'

import type { McpServerConfig, SkillInstalledPluginsOutcome, SkillScanOutcome } from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import type { CardAction } from '../../shared/hosted-card-feed'
import type { ScanResult, ScannedPlugin, ScannedSkill, SkillSource } from '../../shared/skills'
import { refuseCard, runCard, type CardRunDeps } from './run-card'
import { test } from 'vitest'

test('run-card', async () => {
  // The registry entry a card's `install.module` names: first-party, signed, and
  // verified — the only tier the executor installs from a card, because every
  // other tier ends in a trust prompt a person has to read.
  const VERIFIED_MODULE_ENTRY: MarketplacePluginEntry = {
    id: 'review',
    name: 'Reviews',
    publisher: { name: 'SprintEngine Labs', verified: true },
    summary: 'Guided, human-led review of a pull request, branch, or patch.',
    category: 'Code Quality',
    icon: 'icons/review.svg',
    latest: 1,
    provides: ['module'],
    source: 'https://github.com/sprintengine/studio-releases/tree/main/plugins/review',
    signature: { algorithm: 'ed25519', publicKey: 'YWJj', signature: 'ZGVm' },
  }

  const WORKSPACE = '/tmp/workspace'
  const PARENT = '/tmp/projects'

  // `install.mcp` no longer installs: the bundled catalogue it resolved ids
  // against was retired with the third-party ruling (2026-09-08), so the
  // verb can only honour a server this workspace's settings already hold. These
  // two are the same server, installed and not.
  const MCP_SERVER = {
    id: 'io-github-playwright-mcp',
    name: 'Playwright',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['@playwright/mcp'],
    clients: ['claude-code'],
    riskLevel: 'local-command' as const,
  }
  const INSTALLED_SERVER = {
    ...MCP_SERVER,
    enabled: true,
    scope: 'workspace',
    source: 'custom',
  } as McpServerConfig

  const SKILL: ScannedSkill = {
    id: 'studio-skills/skills/browser',
    name: 'Browser',
    description: 'Drive a browser.',
    group: '',
    files: [{ path: 'SKILL.md', size: 10, blobSha: '', isEntry: true }],
    allowedTools: [],
    hasExecutables: false,
  }

  const SOURCE: SkillSource = {
    id: 'github:sprintengine/studio-skills',
    kind: 'github',
    name: 'studio-skills',
    repo: 'sprintengine/studio-skills',
    monogram: 'SS',
    blurb: '',
    commitSha: 'abc',
    scannedAt: '2026-09-06T00:00:00.000Z',
  }

  // Only the fields the executor reads. `scanPlugins` completes the rest, which
  // is exactly what it exists for, so the cast is a fixture shortcut and not a
  // claim about the shape.
  const PLUGIN = {
    id: 'playwright',
    name: 'Playwright',
    origin: { kind: 'in-tree', path: 'plugins/playwright' },
  } as unknown as ScannedPlugin

  function scan(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
      skills: [SKILL],
      groups: [],
      groupingSignal: 'none',
      fileCount: 1,
      commitSha: 'abc',
      plugins: [PLUGIN],
      ...overrides,
    }
  }

  type Recorder = { calls: string[]; deps: CardRunDeps }

  /**
   * Every dependency records itself before answering, so a test can read the run
   * as a sentence. The defaults are the "nothing is installed yet" machine; each
   * case overrides only the fact it is about.
   */
  function recorder(overrides: Partial<CardRunDeps> = {}): Recorder {
    const calls: string[] = []
    const deps: CardRunDeps = {
      syncMcp: (input) => {
        calls.push(`syncMcp ${Object.keys(input.settings.servers).join(',')}`)
        return { ok: true, targets: [], issues: [] }
      },
      getSkillScan: async (input): Promise<SkillScanOutcome> => {
        calls.push(`getSkillScan ${input.sourceId}`)
        return input.sourceId === SOURCE.id
          ? { ok: true, source: SOURCE, scan: scan() }
          : { ok: false, message: 'That source is not in your list.' }
      },
      installSkill: async (input) => {
        calls.push(`installSkill ${input.skillId}`)
        return { ok: true, dirName: 'browser', harnesses: ['claude'], paths: [], fileCount: 1, scope: 'workspace' }
      },
      installPlugin: async (input) => {
        calls.push(`installPlugin ${input.pluginId}`)
        return {
          ok: true,
          plugin: PLUGIN,
          harnesses: [],
          mcpServers: [],
          claudePluginKey: '',
          pluginRoot: '',
          pluginFileCount: 0,
          warnings: [],
        }
      },
      listInstalledPlugins: async (): Promise<SkillInstalledPluginsOutcome> => {
        calls.push('listInstalledPlugins')
        return { ok: true, plugins: [] }
      },
      installedSkillCopies: async () => {
        calls.push('installedSkillCopies')
        return new Map<string, readonly { sourceId: string }[]>()
      },
      listAgentCliIds: () => ['claude-code', 'codex'],
      detectCli: async (cli) => {
        calls.push(`detectCli ${cli}`)
        return { installed: true }
      },
      cloneRepo: async (input) => {
        calls.push(`cloneRepo ${input.url} -> ${input.parentDir}/${input.folderName}`)
        return { ok: true, path: `${input.parentDir}/${input.folderName}` }
      },
      pathExists: () => false,
      repoOriginName: async (dir) => {
        calls.push(`repoOriginName ${dir}`)
        return null
      },
      joinPath: (...segments) => segments.join('/'),
      readMarketplaceRegistry: async () => {
        calls.push('readMarketplaceRegistry')
        return {
          ok: true,
          state: 'ok',
          registryUrl: 'https://registry.test/marketplace.json',
          source: 'bundled',
          stale: false,
          fetchedAt: '2026-09-10T00:00:00.000Z',
          marketplace: { schemaVersion: 1, plugins: [VERIFIED_MODULE_ENTRY] },
        }
      },
      listMarketplaceReceipts: async () => {
        calls.push('listMarketplaceReceipts')
        return { ok: true, receipts: [] }
      },
      installMarketplaceEntry: async (input) => {
        calls.push(`installMarketplaceEntry ${input.entry.id} granted=${String(Boolean(input.grant))}`)
        return {
          ok: true,
          id: input.entry.id,
          displayName: input.entry.name,
          version: input.entry.latest,
          trust: 'trusted',
          loadEligible: true,
          installed: [{ kind: 'module', id: input.entry.id }],
          restartRequired: true,
          classification: 'verified',
          sourceUrl: 'https://example.test/plugins/review',
          updated: false,
        }
      },
      ...overrides,
    }
    return { calls, deps }
  }

  function run(actions: CardAction[], deps: CardRunDeps, mcpServers: McpServerConfig[] = [], mcpSyncEnabled = false) {
    return runCard(
      { slug: 'browser', actions, workspaceRoot: WORKSPACE, cloneParentDir: PARENT, mcpServers, mcpSyncEnabled },
      deps,
    )
  }

  const HAPPY: CardAction[] = [
    { verb: 'require.cli', cli: 'claude-code' },
    { verb: 'install.mcp', id: MCP_SERVER.id },
    { verb: 'install.skill', source: SOURCE.id, id: SKILL.id },
    { verb: 'open.chat', prompt: 'Open example.com and read the headline.', skills: ['browser'], send: true },
  ]

  async function main(): Promise<void> {
    // ── 1. The happy path, in the card's own order ───────────────────────────────
    {
      const { calls, deps } = recorder()
      const result = await run(HAPPY, deps, [INSTALLED_SERVER], true)
      assert.equal(result.ok, true, 'a card whose every action succeeds is a run that succeeded')
      assert.deepEqual(
        result.outcomes.map((outcome) => `${outcome.verb}:${outcome.status}`),
        ['require.cli:already', 'install.mcp:already', 'install.skill:done', 'open.chat:done'],
        'one outcome per action, in the card’s order, with what was already there reported as a no-op',
      )
      assert.deepEqual(
        calls,
        [
          'detectCli claude-code',
          `syncMcp ${MCP_SERVER.id}`,
          `getSkillScan ${SOURCE.id}`,
          'installedSkillCopies',
          `installSkill ${SKILL.id}`,
        ],
        'the installers ran in the card’s order — the MCP server is in before the skill, and both before the chat',
      )
      assert.deepEqual(
        result.chat,
        {
          prompt: 'Open example.com and read the headline.',
          send: true,
          skills: ['browser'],
          // The CLI `require.cli` verified, so the chat opens on the harness the
          // skill was installed into rather than on whatever the renderer's
          // template resolver would otherwise pick.
          cli: 'claude-code',
          // The picker row, when the request carried none: null everywhere, which
          // means "the app's own defaults" on the far side rather than "no model".
          model: null,
          reasoning: null,
          permissionPreset: null,
        },
        'the chat is handed back for the renderer to open, and it carries `send` (R4: Go goes)',
      )
      assert.equal(result.surface, null, 'a card that named no door hands back no door')
      assert.deepEqual(
        result.mcpServers,
        [],
        'and nothing goes back to the store, because this run added no server — it could not',
      )
      assert.equal(result.workspaceRoot, WORKSPACE, 'nothing cloned, so the workspace is the one it started in')
    }

    // ── 2. The first failure stops the rest, and names what did not run ──────────
    {
      const { calls, deps } = recorder()
      const result = await run(HAPPY, deps)
      assert.equal(result.ok, false)
      assert.match(
        result.message ?? '',
        /is not a server this build can install/,
        'the toast leads with what actually broke — and says where MCP servers come from now',
      )
      assert.deepEqual(
        result.outcomes.map((outcome) => `${outcome.verb}:${outcome.status}`),
        ['require.cli:already', 'install.mcp:failed', 'install.skill:skipped', 'open.chat:skipped'],
        'everything after the failure is reported as not run, so the toast can say how much did not happen',
      )
      assert.ok(
        !calls.some((call) => call.startsWith('installSkill')),
        'and nothing after the failure ran — no skill was installed behind a server that is not there',
      )
      assert.equal(result.chat, null, 'a failed run opens no chat')
    }

    // ── 3. A second press installs nothing ───────────────────────────────────────
    {
      const { calls, deps } = recorder({
        installedSkillCopies: async () => {
          calls.push('installedSkillCopies')
          return new Map<string, readonly { sourceId: string }[]>([['browser', [{ sourceId: SOURCE.id }]]])
        },
      })
      const result = await run(HAPPY, deps, [INSTALLED_SERVER], true)
      assert.equal(result.ok, true, 'pressing Go a second time succeeds — already satisfied is a no-op, not an error')
      assert.deepEqual(
        result.outcomes.map((outcome) => `${outcome.verb}:${outcome.status}`),
        ['require.cli:already', 'install.mcp:already', 'install.skill:already', 'open.chat:done'],
        'every install reports itself already done',
      )
      assert.ok(!calls.some((call) => call.startsWith('installSkill')), 'and no skill was copied a second time')
      // But the SYNC runs, and this assertion is the one that used to say the
      // opposite. The settings row is app-wide and the sync is per-workspace, so
      // "already installed" answered a question nobody asked: install Playwright
      // in project A, open project B, press Go, and the old code reported
      // `already`, wrote no `.mcp.json` into B, and opened a chat there with no
      // tools and nothing said. Right after a `clone.repo` it was guaranteed —
      // a fresh clone has never been synced to anything.
      assert.ok(
        calls.includes(`syncMcp ${MCP_SERVER.id}`),
        'a second press still syncs, because THIS workspace is the thing that may not have it yet',
      )
      assert.deepEqual(result.mcpServers, [], 'and the store is asked to write nothing, because nothing was added')
      assert.ok(result.chat, 'the person still lands in the chat, which is what makes a second press useful')
    }

    // ── The server the person already edited is not overwritten by the catalogue ─
    {
      const edited = { ...INSTALLED_SERVER, env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers' } } as McpServerConfig
      let synced: McpServerConfig | undefined
      const { deps } = recorder({
        syncMcp: (input) => {
          synced = input.settings.servers[MCP_SERVER.id]
          return { ok: true, targets: [], issues: [] }
        },
      })
      await run([{ verb: 'install.mcp', id: MCP_SERVER.id }], deps, [edited], true)
      assert.deepEqual(
        synced?.env,
        { PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers' },
        'a second Go syncs the config the person has, and nothing else can overwrite their edits',
      )
    }

    // ── The app's MCP sync switch is carried, not assumed ────────────────────────
    {
      // The executor synced with `syncEnabled: true` hardcoded, which turned a
      // setting back on for somebody who had turned it off. Since `install.mcp`
      // can no longer add a server, it may never flip the switch at all.
      const flags: boolean[] = []
      const { deps } = recorder({
        syncMcp: (input) => {
          flags.push(input.settings.syncEnabled)
          return { ok: true, targets: [], issues: [] }
        },
      })
      await run([{ verb: 'install.mcp', id: MCP_SERVER.id }], deps, [INSTALLED_SERVER], false)
      assert.deepEqual(flags, [false], 'a run that adds nothing syncs under the setting as the person left it')
    }

    // ── An id nothing installed is refused by name ───────────────────────────────
    // The one thing `install.mcp` can still do wrong is pretend. A card naming a
    // server this workspace does not hold must say so — and say where servers
    // come from now — rather than silently syncing nothing and opening a chat
    // with no tools in it.
    {
      const other = {
        id: 'io-github-other',
        name: 'Other',
        transport: 'stdio',
        command: 'npx',
        args: [],
        clients: ['claude-code'],
        enabled: true,
        scope: 'workspace',
        source: 'custom',
        riskLevel: 'local-command',
      } as McpServerConfig
      const { calls, deps } = recorder()
      const result = await run([{ verb: 'install.mcp', id: MCP_SERVER.id }], deps, [other], true)
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /MCP servers arrive inside plugins now/)
      assert.deepEqual(result.mcpServers, [], 'nothing goes back to the store')
      assert.deepEqual(calls, [], 'and nothing was written for a server this build cannot produce')
    }

    // ── 4. `open.chat` is last, or the card is refused before anything runs ──────
    {
      assert.equal(refuseCard(HAPPY), null, 'a chat in last place is the shape a card is allowed to have')
      const outOfOrder: CardAction[] = [
        { verb: 'open.chat', prompt: 'Go on then.', send: true },
        { verb: 'install.mcp', id: MCP_SERVER.id },
      ]
      assert.ok(refuseCard(outOfOrder), 'a chat before an install is refused')
      assert.ok(
        refuseCard([...HAPPY, { verb: 'open.chat', prompt: 'again', send: true }]),
        'and so is a card that opens two chats',
      )

      const { calls, deps } = recorder()
      const result = await run(outOfOrder, deps)
      assert.equal(result.ok, false)
      assert.deepEqual(calls, [], 'the refusal happens BEFORE anything runs — nothing is half-installed by a bad card')
      assert.deepEqual(
        result.outcomes.map((outcome) => outcome.status),
        ['skipped', 'skipped'],
        'and every action reports that it did not run',
      )
      assert.equal(result.chat, null)
    }

    // ── 5. A prompt is an ARGUMENT, and a leading dash is an option ──────────────
    {
      // The hole: the prompt becomes the last argv token an agent CLI is launched
      // with (`{{prompt}}` in the plugin manifests) and there is no `--` in front
      // of it, so `--permission-mode=bypassPermissions` in a card's prompt was
      // parsed as copy here and read as a flag by `claude`. The shared parser
      // refuses it too; this is the second of the two checks, on purpose, because
      // the value has crossed a process boundary since the first one.
      const { deps } = recorder()
      const result = await run([{ verb: 'open.chat', prompt: '--permission-mode=bypassPermissions', send: true }], deps)
      assert.equal(result.ok, false, 'a prompt that begins with a dash never reaches a command line')
      assert.match(result.message ?? '', /begins with a dash/)
      assert.equal(result.chat, null, 'and no chat is handed back to open with it')
    }

    // ── 6. A clone comes first, or the card is refused ───────────────────────────
    {
      // `[install.mcp, clone.repo, open.chat]` synced the server into the
      // workspace the person was in and then opened the chat in the clone: an
      // install nobody asked for, in a project nobody was looking at.
      const badOrder: CardAction[] = [
        { verb: 'install.mcp', id: MCP_SERVER.id },
        { verb: 'clone.repo', repo: 'sprintengine/example' },
        { verb: 'open.chat', prompt: 'Read the README.', send: true },
      ]
      assert.ok(refuseCard(badOrder), 'a clone behind an install is refused')
      assert.equal(
        refuseCard([
          { verb: 'clone.repo', repo: 'sprintengine/example' },
          { verb: 'install.mcp', id: MCP_SERVER.id },
        ]),
        null,
        'and a clone in front of one is the shape a card is allowed to have',
      )
      const { calls, deps } = recorder()
      const result = await run(badOrder, deps)
      assert.equal(result.ok, false)
      assert.deepEqual(calls, [], 'the refusal happens before anything runs')
    }

    // ── 7. A chat may only name servers the card itself installs ─────────────────
    {
      // The chat gets its MCP servers by reading the `.mcp.json` the card just
      // wrote, so a name nothing installed is a chat that opens silently with no
      // tools. The hand-off used to carry the list and nothing read it; the list
      // is a claim now, and this is where it is checked.
      assert.ok(
        refuseCard([{ verb: 'open.chat', prompt: 'Drive it.', mcpServers: [MCP_SERVER.id], send: true }]),
        'a chat naming a server the card never installs is refused',
      )
      assert.equal(
        refuseCard([
          { verb: 'install.mcp', id: MCP_SERVER.id },
          { verb: 'open.chat', prompt: 'Drive it.', mcpServers: [MCP_SERVER.id], send: true },
        ]),
        null,
        'and one naming a server it installs first is fine',
      )
    }

    // ── The workspace is the app's, and only `clone.repo` moves it ───────────────
    {
      const { calls, deps } = recorder()
      const result = await run(
        [
          { verb: 'clone.repo', repo: 'sprintengine/example', folderName: 'example' },
          { verb: 'install.skill', source: SOURCE.id, id: SKILL.id },
        ],
        deps,
      )
      assert.equal(result.ok, true)
      assert.ok(
        calls.includes(`cloneRepo https://github.com/sprintengine/example.git -> ${PARENT}/example`),
        'the URL is BUILT from a fixed host and the validated owner/name — a card names a repository, never a URL',
      )
      assert.equal(result.workspaceRoot, `${PARENT}/example`, 'the clone becomes the workspace the run ends in')
    }

    {
      // The same card twice: the folder is already there AND it is that
      // repository, so the clone is a no-op and the run adopts it as its
      // workspace.
      const { calls, deps } = recorder({
        pathExists: () => true,
        repoOriginName: async () => 'SprintEngine/Example',
      })
      const result = await run([{ verb: 'clone.repo', repo: 'sprintengine/example' }], deps)
      assert.equal(result.outcomes[0]?.status, 'already', 'a clone target that is already that repository is a no-op')
      assert.ok(!calls.some((call) => call.startsWith('cloneRepo')), 'and git is never run a second time')
      assert.equal(result.workspaceRoot, `${PARENT}/example`, 'the folder name defaults to the repository’s own name')
    }

    // ── A folder that is NOT the card's repository is never adopted ──────────────
    {
      // The hole this closes: `parentDir` is the parent of the person's own
      // projects and the folder name is the repository's leaf, so a card naming
      // `x/my-other-project` used to adopt `~/code/my-other-project` — installing
      // into it and scoping the chat to it — purely because the directory
      // existed. `cloneGitHubRepo` refuses an occupied path; this branch was
      // overriding that refusal.
      for (const origin of ['someone-else/my-other-project', null]) {
        const { calls, deps } = recorder({
          pathExists: () => true,
          repoOriginName: async () => origin,
        })
        const result = await run(
          [
            { verb: 'clone.repo', repo: 'sprintengine/my-other-project' },
            { verb: 'install.skill', source: SOURCE.id, id: SKILL.id },
          ],
          deps,
        )
        assert.equal(result.ok, false, 'an occupied folder that is not the card’s repository fails the action')
        assert.match(
          result.message ?? '',
          /my-other-project is already a folder here/,
          'and the message names the directory it refused to take',
        )
        assert.equal(result.workspaceRoot, WORKSPACE, 'the run stays in the workspace it started in')
        assert.ok(!calls.some((call) => call.startsWith('cloneRepo')), 'nothing is cloned over it')
        assert.ok(!calls.some((call) => call.startsWith('installSkill')), 'and nothing is installed into it')
      }
    }

    // ── Nothing a feed says is trusted as a path, an id or a host ────────────────
    {
      const { calls, deps } = recorder()
      // `..` passes the owner/name character class on its own, which is exactly why
      // the check is repeated at this boundary rather than assumed upstream.
      const traversal = await run([{ verb: 'clone.repo', repo: '../../etc' }], deps)
      assert.equal(traversal.ok, false, 'a repository name that is a relative path is refused')
      assert.ok(!calls.some((call) => call.startsWith('cloneRepo')), 'and git never sees it')

      const escape = await run([{ verb: 'clone.repo', repo: 'owner/name', folderName: '../elsewhere' }], deps)
      assert.equal(escape.ok, false, 'a folder name with a separator in it never reaches a path join')
    }

    {
      const { calls, deps } = recorder()
      const unknownSource = await run([{ verb: 'install.skill', source: 'github:someone/else', id: 'x' }], deps)
      assert.equal(unknownSource.ok, false, 'a source this app does not hold resolves to nothing')
      assert.ok(!calls.some((call) => call.startsWith('installSkill')), 'and no install is attempted against it')

      const unknownSkill = await run([{ verb: 'install.skill', source: SOURCE.id, id: 'not/in/the/scan' }], deps)
      assert.equal(unknownSkill.ok, false, 'an id that is not in the source’s scan is refused')

      const unknownServer = await run([{ verb: 'install.mcp', id: 'made-up' }], deps)
      assert.equal(unknownServer.ok, false, 'an MCP id that is not in the bundled catalogue is refused')

      const unknownCli = await run([{ verb: 'require.cli', cli: '/usr/bin/anything' }], deps)
      assert.equal(unknownCli.ok, false, 'a `cli` that is not a registered agent-CLI plugin id never reaches a probe')
      assert.ok(!calls.some((call) => call.startsWith('detectCli /usr/bin')), 'the probe was never called with it')
    }

    // ── A missing CLI is a refusal with somewhere to go, never a silent install ──
    {
      const { calls, deps } = recorder({
        detectCli: async (cli) => {
          calls.push(`detectCli ${cli}`)
          return { installed: false }
        },
      })
      const result = await run(HAPPY, deps)
      assert.equal(result.ok, false)
      assert.match(
        result.message ?? '',
        /Settings → Agents/,
        "Go says which CLI is missing and where to install it — one destination, the app's, never a second door of the card path's own",
      )
      assert.deepEqual(calls, ['detectCli claude-code'], 'and it stops there')
    }

    // ── A plugin already in the receipts is not installed again ──────────────────
    {
      const { calls, deps } = recorder({
        listInstalledPlugins: async (): Promise<SkillInstalledPluginsOutcome> => {
          calls.push('listInstalledPlugins')
          return {
            ok: true,
            plugins: [
              {
                workspaceRoot: WORKSPACE,
                sourceId: SOURCE.id,
                pluginId: PLUGIN.id,
                pluginName: PLUGIN.name,
                marketplaceName: '',
                claudePluginKey: '',
                skillDirNames: [],
                mcpServerIds: [],
                commitSha: '',
                installedAt: '2026-09-06T00:00:00.000Z',
              },
            ],
          }
        },
      })
      const result = await run([{ verb: 'install.plugin', source: SOURCE.id, id: PLUGIN.id }], deps)
      assert.equal(result.outcomes[0]?.status, 'already')
      assert.ok(!calls.some((call) => call.startsWith('installPlugin')), 'the receipt is what makes a second Go free')
    }

    // ── A plugin whose hooks nobody has read is refused, not acknowledged ────────
    {
      const { deps } = recorder({
        installPlugin: async () => ({
          ok: false,
          needsHookAcknowledgement: true,
          message: 'Playwright runs 2 hook commands on your machine. Review them, then install.',
        }),
      })
      const result = await run([{ verb: 'install.plugin', source: SOURCE.id, id: PLUGIN.id }], deps)
      assert.equal(result.ok, false)
      assert.match(
        result.message ?? '',
        /Plugins/,
        'a card may not answer a hooks disclosure on the person’s behalf — it sends them to the surface that shows it',
      )
    }

    // ── A door is a hand-off too ─────────────────────────────────────────────────
    {
      const { deps } = recorder()
      const result = await run([{ verb: 'open.surface', view: 'skills', installed: true }], deps)
      assert.equal(result.ok, true)
      assert.deepEqual(result.surface, { view: 'skills', installed: true })
    }

    // ── With no workspace open, an install says so rather than guessing one ──────
    {
      const { calls, deps } = recorder()
      const result = await runCard(
        {
          slug: 'browser',
          actions: [{ verb: 'install.mcp', id: MCP_SERVER.id }],
          workspaceRoot: null,
          cloneParentDir: PARENT,
          mcpServers: [],
          mcpSyncEnabled: false,
        },
        deps,
      )
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /Open a project/, 'a card carries no workspace, so the app has to have one')
      assert.deepEqual(calls, [], 'and nothing was reached for without one')
    }

    // ── The picker row rides through, untouched (item 2473) ─────────────────────
    // `Go` opens the model picker and choosing a row is what runs the card (R4b),
    // so the row's model, effort and permission preset travel with the request.
    // The executor reads none of them — they mean something to a launcher and
    // nothing to an installer — and hands all three back on the chat, beside the
    // cli, so ONE object on the far side describes the whole launch.
    {
      const { deps } = recorder()
      const result = await runCard(
        {
          slug: 'browser',
          actions: HAPPY,
          workspaceRoot: WORKSPACE,
          cloneParentDir: PARENT,
          mcpServers: [INSTALLED_SERVER],
          mcpSyncEnabled: true,
          model: 'claude-opus-5',
          reasoning: 'high',
          permissionPreset: 'bypass',
        },
        deps,
      )
      assert.equal(result.ok, true)
      assert.deepEqual(
        result.chat,
        {
          prompt: 'Open example.com and read the headline.',
          send: true,
          skills: ['browser'],
          cli: 'claude-code',
          model: 'claude-opus-5',
          reasoning: 'high',
          permissionPreset: 'bypass',
        },
        'the chosen row comes back whole — the runtime the card required, and the three axes the person picked',
      )
    }

    // A card that requires no CLI hands back no CLI, and the row still travels:
    // the renderer then launches on the row it was given, which is the whole of
    // "the last-used row leads" (R4b).
    {
      const { deps } = recorder()
      const result = await runCard(
        {
          slug: 'browser',
          actions: [{ verb: 'open.chat', prompt: 'Draw me a design system.', send: true }],
          workspaceRoot: WORKSPACE,
          cloneParentDir: PARENT,
          mcpServers: [],
          mcpSyncEnabled: false,
          model: null,
          reasoning: null,
          permissionPreset: 'none',
        },
        deps,
      )
      assert.equal(result.chat?.cli, null, 'no require.cli is no override — the picked row is the runtime')
      assert.equal(result.chat?.model, null, 'and its own default model row is null, not a missing field')
      assert.equal(result.chat?.permissionPreset, 'none', 'the preset the row carried is the preset handed back')
    }

    // --- install.module (G4) --------------------------------------------------

    // The happy path: the id resolves in the app's own registry, the receipts say
    // it is not there, and the install goes through the storefront's lifecycle
    // with NO trust grant — a verified entry never asks for one, and passing one
    // would be the executor answering a prompt on somebody's behalf.
    {
      const { calls, deps } = recorder()
      const result = await run([{ verb: 'install.module', id: 'review' }], deps)
      assert.equal(result.ok, true, result.message ?? '')
      assert.deepEqual(calls, [
        'readMarketplaceRegistry',
        'listMarketplaceReceipts',
        'installMarketplaceEntry review granted=false',
      ])
      assert.equal(result.outcomes[0].status, 'done')
      // A module loads at app launch, so the outcome says what is left to do.
      assert.equal(result.outcomes[0].message, 'Reviews installed. Restart SprintEngine Studio to use it.')
    }

    // A second press is a no-op, and it is decided by the receipts BEFORE the
    // trust tier — so an installed module never turns a repeat Go into a
    // refusal about trust.
    {
      const { calls, deps } = recorder({
        listMarketplaceReceipts: async () => ({ ok: true, receipts: [{ id: 'review' }] }),
      })
      const result = await run([{ verb: 'install.module', id: 'review' }], deps)
      assert.equal(result.ok, true)
      assert.equal(result.outcomes[0].status, 'already')
      assert.equal(result.outcomes[0].message, 'Reviews is already installed.')
      assert.equal(calls.includes('installMarketplaceEntry review granted=false'), false, 'nothing was installed twice')
    }

    // An id nothing in this build's registry carries is refused by name, and
    // nothing is downloaded.
    {
      const { calls, deps } = recorder()
      const result = await run([{ verb: 'install.module', id: 'not-a-module' }], deps)
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /not-a-module is not in this build's marketplace/)
      assert.deepEqual(calls, ['readMarketplaceRegistry'])
    }

    // An entry that is in the registry but carries no module component cannot be
    // installed by this verb — the executor would be installing something else.
    {
      const { deps } = recorder({
        readMarketplaceRegistry: async () => ({
          ok: true,
          state: 'ok',
          registryUrl: 'https://registry.test/marketplace.json',
          source: 'bundled',
          stale: false,
          fetchedAt: '2026-09-10T00:00:00.000Z',
          marketplace: {
            schemaVersion: 1,
            plugins: [{ ...VERIFIED_MODULE_ENTRY, provides: ['skills'] }],
          },
        }),
      })
      const result = await run([{ verb: 'install.module', id: 'review' }], deps)
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /is not a module/)
    }

    // Every tier below `verified` needs a trust prompt, which is a disclosure a
    // person reads and answers. The card is refused, by name, pointing at the one
    // surface that can show it — the same rule `require.cli` follows for a CLI
    // install command.
    for (const untrusted of [
      { ...VERIFIED_MODULE_ENTRY, publisher: { name: 'Somebody', verified: false } },
      { ...VERIFIED_MODULE_ENTRY, signature: undefined },
    ]) {
      const { calls, deps } = recorder({
        readMarketplaceRegistry: async () => ({
          ok: true,
          state: 'ok',
          registryUrl: 'https://registry.test/marketplace.json',
          source: 'bundled',
          stale: false,
          fetchedAt: '2026-09-10T00:00:00.000Z',
          marketplace: { schemaVersion: 1, plugins: [untrusted as MarketplacePluginEntry] },
        }),
      })
      const result = await run([{ verb: 'install.module', id: 'review' }], deps)
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /asks you to trust it before it installs/)
      assert.match(result.message ?? '', /Extensions → Plugins/)
      assert.equal(
        calls.some((call) => call.startsWith('installMarketplaceEntry')),
        false,
      )
    }

    // A registry that cannot be read fails the action rather than reporting that
    // the module is missing — "could not check" is never "not there".
    {
      const { deps } = recorder({
        readMarketplaceRegistry: async () => ({
          ok: false,
          state: 'fetch-error',
          registryUrl: 'https://registry.test/marketplace.json',
          stale: false,
          message: 'The marketplace could not be reached.',
        }),
      })
      const result = await run([{ verb: 'install.module', id: 'review' }], deps)
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /could not be reached/)
    }

    // A failed install is the lifecycle's own sentence, never a fabricated one.
    {
      const { deps } = recorder({
        installMarketplaceEntry: async () => ({ ok: false, message: 'Plugin bundle signature is invalid.' }),
      })
      const result = await run([{ verb: 'install.module', id: 'review' }], deps)
      assert.equal(result.ok, false)
      assert.equal(result.message, 'Plugin bundle signature is invalid.')
    }

    // And it is an INSTALL verb for the whole-card rules: a clone that comes
    // after it would install into the project the person was already in and then
    // move the run somewhere else.
    assert.match(
      refuseCard([
        { verb: 'install.module', id: 'review' },
        { verb: 'clone.repo', repo: 'sprintengine/studio-releases' },
      ]) ?? '',
      /clones a project after it has already installed something/,
    )

    console.log('run-card.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
