// `cards:run` — the one channel behind `Go` on the Extensions home (item 2469).
//
// It is shaped like the skills and MCP install channels beside it: one handler,
// one envelope in, one report out, and the service objects bound here rather
// than reached for inside the executor. `src/main/cards/run-card.ts` takes its
// installers as dependencies precisely so that this file is the only place that
// knows which real service each one is, and so the executor's own test can
// watch the order without a workspace, a network or a machine with a CLI on it.
//
// **The envelope is re-parsed, not trusted.** The actions were validated once
// already, by `parseHostedCardFeed` in the main process, but they have been to
// the renderer and back since — so every action is put through the shared
// parser again here, and a card that fails is refused whole rather than run in
// part. That is the same rule the feed parser applies to a card with one bad
// action, for the same reason: half of Go is worse than none of it.
//
// The fields the request carries that a card does not — the workspace, the
// parent directory clones go into, the MCP servers this machine has configured
// and whether MCP sync is on — are the app's own facts, and they never came
// from the feed. They are still checked here, because "the renderer sent it" is
// a claim about a process, not about a shape: the two paths are checked for
// shape and rejected when relative, every server is put through
// `normalizeMcpServerConfig` — the same normalizer the settings store uses —
// rather than cast, and the picker row's three launch axes (item 2473) are
// checked the same way. The header claimed the checking until 2026-09-06 while
// `raw.mcpServers` went through untouched, which would have let a malformed row
// reach a sync and be written into every CLI's config.

import { app, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CardRunInput, CardRunResult, McpServerConfig } from '../../shared/electron-api'
import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { parseCardAction, type CardAction } from '../../shared/hosted-card-feed'
import { normalizeMcpServerConfig } from '../../shared/mcp/normalize-server'
import { detectCli } from '../cli-runtime-install'
import { cloneRepository } from '../git-clone'
import { githubRepoFromRemote } from '../git-github'
import { runGit } from '../git-utils'
import { isAppSender } from './ipc-sender'
import type { GitHubTokenStore } from '../github-token-store'
import {
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipts,
} from '../marketplace/plugin-lifecycle'
import type { McpConfigService } from '../mcp-config-service'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import type { SkillsService } from '../skills'
import { createMarketplacePluginPipeline } from './marketplace-plugin-ipc'
import { createDefaultMarketplaceRegistryClient } from './marketplace-registry-ipc'
import { installedSkillCopies } from '../skills/sync'
import { runCard, type CardRunDeps } from '../cards/run-card'
import { isRecord } from '../../shared/records'

export type CardsIpcServices = {
  skillsService: SkillsService
  mcpConfigService: McpConfigService
  githubTokenStore: GitHubTokenStore
}

export function registerCardsIpc(
  ipcMain: IpcMain,
  services: CardsIpcServices,
  overrides: Partial<CardRunDeps> = {},
): void {
  let registryReader: ReturnType<typeof createDefaultMarketplaceRegistryClient> | undefined
  let pipeline: ReturnType<typeof createMarketplacePluginPipeline> | undefined
  const marketplacePipeline = () =>
    (pipeline ??= createMarketplacePluginPipeline({ mcpConfigService: services.mcpConfigService }))
  const deps: CardRunDeps = {
    syncMcp: (input) => services.mcpConfigService.sync(input),
    getSkillScan: (input) => services.skillsService.getScan(input),
    installSkill: (input) => services.skillsService.install(input),
    installPlugin: (input) => services.skillsService.installPlugin(input),
    listInstalledPlugins: (input) => services.skillsService.listInstalledPlugins(input),
    installedSkillCopies: (workspaceRoot) => installedSkillCopies(workspaceRoot),
    // Only the agent CLIs this build registers as plugins, which is the same
    // list the availability slice probes. A `require.cli` naming anything else
    // never reaches a probe, let alone a spawn.
    listAgentCliIds: () => listPluginRegistryEntries().map((entry) => entry.id),
    detectCli: async (cli) => {
      const detected = await detectCli(cli)
      // A probe that errored decided nothing, and "decided nothing" is not
      // "installed" — `cli-availability.ts` drops such a CLI from its map for
      // the same reason. Here it means Go says the CLI is missing, which is the
      // reading that installs nothing on a guess.
      return { installed: detected.error === null && detected.installed }
    },
    // The token never crosses IPC: it is resolved on this side, exactly as
    // `github-repos-ipc.ts` does for the clone picker.
    cloneRepo: async (input) => cloneRepository(input, { token: await services.githubTokenStore.resolveToken() }),
    pathExists: (path) => existsSync(path),
    // Strictly `origin`, and strictly GitHub. `getGitHubRepoRef` would answer
    // from any remote it can parse, which is the wrong question here: a
    // directory whose `origin` is somebody's fork and whose `upstream` happens
    // to be the card's repository is not the card's clone, and adopting it as
    // the workspace is the hole this check exists to close.
    repoOriginName: async (dir) => {
      try {
        const ref = githubRepoFromRemote(await runGit(dir, ['remote', 'get-url', 'origin']))
        return ref ? `${ref.owner}/${ref.repo}` : null
      } catch {
        // No origin, not a repository, or no git on the machine. All three mean
        // the same thing to the caller: this directory is not known to be the
        // card's clone, so it does not get adopted.
        return null
      }
    },
    joinPath: (...segments) => join(...segments),
    // `install.module` (G4) goes through the SAME marketplace lifecycle the
    // storefront does — same trust gate, same receipts, same rollback. Built
    // lazily: a card that installs no module must not pay for a registry client
    // or a receipt-store path, and the executor's own suite injects all three.
    readMarketplaceRegistry: () => (registryReader ??= createDefaultMarketplaceRegistryClient()).read(),
    listMarketplaceReceipts: () =>
      readMarketplacePluginInstallReceipts(defaultMarketplacePluginInstallStorePath(app.getPath('userData'))),
    installMarketplaceEntry: (input) => marketplacePipeline().lifecycle.install(input),
    ...overrides,
  }

  ipcMain.handle('cards:run', async (event: IpcMainInvokeEvent, raw: unknown): Promise<CardRunResult> => {
    // A card installs modules and writes MCP servers into agent CLIs' configs,
    // so only the app's own window may press Go.
    if (!isAppSender(event)) {
      return {
        ok: false,
        outcomes: [],
        workspaceRoot: null,
        mcpServers: [],
        chat: null,
        surface: null,
        message: 'This request did not come from a SprintEngine Studio window.',
      }
    }
    const request = parseRequest(raw)
    if (!request.ok) {
      return {
        ok: false,
        outcomes: [],
        workspaceRoot: null,
        mcpServers: [],
        chat: null,
        surface: null,
        message: request.message,
      }
    }
    try {
      return await runCard(request.input, deps)
    } catch (error) {
      return {
        ok: false,
        outcomes: [],
        workspaceRoot: request.input.workspaceRoot,
        mcpServers: [],
        chat: null,
        surface: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

type ParsedRequest = { ok: true; input: CardRunInput } | { ok: false; message: string }

function parseRequest(raw: unknown): ParsedRequest {
  if (!isRecord(raw)) return { ok: false, message: 'That card could not be read, so nothing ran.' }
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : ''
  if (!slug) return { ok: false, message: 'That card could not be read, so nothing ran.' }
  if (!Array.isArray(raw.actions)) return { ok: false, message: 'That card has nothing to run.' }

  const actions: CardAction[] = []
  for (const entry of raw.actions) {
    const parsed = parseCardAction(entry)
    // One unreadable action refuses the whole card. A partially run card is the
    // state nobody can see and nobody can undo.
    if (!parsed.ok)
      return { ok: false, message: `That card asks for something this build cannot do: ${parsed.message}` }
    actions.push(parsed.action)
  }

  const permissionPreset = parseCliPermissionPreset(raw.permissionPreset)
  return {
    ok: true,
    input: {
      slug,
      actions,
      workspaceRoot: absolutePathOrNull(raw.workspaceRoot),
      cloneParentDir: absolutePathOrNull(raw.cloneParentDir),
      mcpServers: mcpServersOf(raw.mcpServers),
      // Absent reads as off. The executor turns it on when a card actually adds
      // a server, so the only thing a missing field can do is leave a setting
      // alone.
      mcpSyncEnabled: raw.mcpSyncEnabled === true,
      // The picker row (item 2473), checked for shape like the two paths above
      // and for the same reason: "the renderer sent it" is a claim about a
      // process, not about a shape. A model id and an effort level are strings
      // or they are absent, and a preset is one this build can read (a retired
      // spelling keeps its nearest meaning) — anything else is dropped rather than refused, because a malformed
      // launch axis must not be why a card's installs do not run. What that
      // costs is the app's own default on the far side, which is what an absent
      // field means anyway.
      model: text(raw.model),
      reasoning: text(raw.reasoning),
      ...(permissionPreset ? { permissionPreset } : {}),
    },
  }
}

/** A non-empty string, or null. Null is "the app's own default", never "no model". */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The MCP servers as the renderer's settings store holds them, put through the
 * shared normalizer rather than cast. A row that does not normalize is dropped
 * rather than refused: these are the app's existing servers, and one bad row in
 * a long-lived settings file must not be the reason a card cannot run — it is
 * left out of the sync, which is where the settings store would leave it too.
 */
function mcpServersOf(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return []
  const servers: McpServerConfig[] = []
  for (const entry of value) {
    const normalized = normalizeMcpServerConfig(entry)
    if (normalized) servers.push(normalized)
  }
  return servers
}

/**
 * The app's own two paths, checked for shape rather than for provenance: both
 * are chosen by the shell (the open workspace, the projects directory) and
 * neither has ever been in the feed. A relative one is treated as absent, so a
 * malformed shell state cannot turn into a join against the process cwd.
 */
function absolutePathOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (path.length === 0) return null
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null
}
