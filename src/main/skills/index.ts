// The skills service: sources in, skills out, installs into the workspace.
//
// This is the one module the IPC layer talks to. Later work (Sync, Discover)
// adds handlers inside these modules rather than widening the global IPC
// registration, so `register-core-ipc.ts` and `preload/index.ts` are wired once
// and left alone.

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import {
  DEFAULT_SKILL_REPO_HOST,
  describeUnreadPlugin,
  LOCAL_SKILL_SOURCE_ID_PREFIX,
  localSourceFolderName,
  parseSkillFrontmatter,
  pluginAliases,
  scanPluginRenames,
  scanPlugins,
  SKILL_ENTRY_FILE,
  skillSourceMonogram,
  splitSkillRepo,
  STUDIO_SKILL_SOURCE_ID,
  type ScanResult,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillFileRef,
  type SkillHarness,
  type SkillSource,
} from '../../shared/skills'
import type {
  SkillAddLocalSourceInput,
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillInstalledPluginsInput,
  SkillInstalledPluginsOutcome,
  SkillPluginInstallInput,
  SkillPluginInstallOutcome,
  SkillPluginScanLinkedInput,
  SkillPluginScanLinkedOutcome,
  SkillPluginUninstallInput,
  SkillPluginUninstallOutcome,
  SkillPopularReposOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSearchInput,
  SkillSearchOutcome,
  SkillSourceUpdateCheck,
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
} from '../../shared/electron-api'
import { MARKETPLACE_EXTRA_HOSTS_ENV, parseMarketplaceExtraHosts } from '../../shared/marketplace/source-policy'
import { pluginNeedsOwnFiles } from '../../shared/mcp/plugin-root'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import { createSkillDiscoveryClient, type SkillDiscoveryOptions } from './discover'
import {
  fetchSkillRepoFile,
  fetchSkillRepoTree,
  parseSkillRepoRef,
  resolveSkillRepoCommit,
  SkillFetchError,
  skillRepoName,
  type SkillGithubOptions,
  type SkillRepoRef,
} from './github-tree'
import { installSkill, uninstallSkill } from './install'
import { installPlugin, readEnabledClaudePlugins, selectPluginItems, uninstallPlugin } from './install-plugin'
import { listLocalTree, scanLocalSkillSource } from './local-source'
import type { PluginDirectoryFile } from './plugin-directory'
import { createPluginInstallStore, mergeInstalledPluginRecord, type PluginInstallStore } from './plugin-install-store'
import type { SkillRepoReader, SkillRepoTransport } from './repo-reader'
import { scanSkillTree, SKILL_MARKETPLACE_MANIFEST_PATH } from './scan'
import {
  dedupeScannedMcpServers,
  followLinkedPlugins,
  linkedRepositoryBudget,
  LinkedPluginReadError,
  readPluginComponents,
  scanPluginTree,
  type LinkedPluginRepoReader,
} from './scan-plugins'
import { createSkillSourceStore, isRemovableSkillSource, skillSourceLog, type SkillSourceStore } from './source-store'
import { createSourceUpdateChecker } from './source-updates'
import { STUDIO_MARKETPLACE_RESOURCE_DIR } from './studio-plugin'
import {
  diffScannedSkills,
  installedSkillCopies,
  refreshInstalledSkills,
  refreshSourceMcpServers,
  type SkillSyncCopyResult,
} from './sync'
import { readStudioEnv } from '../../shared/studio-env'

// How many entry documents a scan reads to fill in names and descriptions. The
// listing is what makes a source browsable, so this runs at scan time and the
// result is cached; beyond the cap a skill keeps its directory name rather than
// the scan turning into thousands of requests.
const MAX_ENRICHED_SKILLS = 400
const ENRICHMENT_CONCURRENCY = 8

export type SkillsServiceDeps = {
  resolveToken: () => Promise<string>
  /**
   * The bundled seed of our own marketplace — `resources/studio-plugin`, the
   * same tree `sprintengine/studio-releases` publishes. Overridden in tests;
   * production reads the packaged resource dir.
   */
  studioMarketplaceSeedRoot?: () => string | null
  listHarnesses?: () => Promise<SkillHarness[]>
  github?: SkillGithubOptions
  discovery?: SkillDiscoveryOptions
  /** CLI ids the MCP servers a plugin ships are written for; defaults to the normaliser's own. */
  mcpClients?: () => Promise<string[]>
  pluginInstallStore?: PluginInstallStore
  /** Where a check's result goes besides the caller — every window, in production. */
  broadcastSourceUpdates?: (check: SkillSourceUpdateCheck) => void
  /**
   * The one reader every repository read here goes through (git-transport
   * ruling, owner 2026-09-08). Production injects the git reader when this
   * machine has git; with none given the service builds the GitHub-API reader
   * out of `github-tree.ts` and behaves exactly as it always did.
   */
  repoReader?: SkillRepoReader
  /** What that reader speaks. Defaults to 'git' when a reader is given, 'api' otherwise. */
  repoTransport?: SkillRepoTransport
  /**
   * False when git is not installed on this machine, which is what the copy
   * names as the remedy instead of the token once the transport is the API
   * fallback. Absent means yes.
   */
  gitInstalled?: boolean
  /**
   * Re-ask whether git is usable before a read or a listing. The integrator
   * probes git after the app is ready and again when it was missing, so a
   * person who installs git and presses Sync is read over git on that press —
   * not after a restart. Awaited before the three deps above are read.
   */
  refreshTransport?: () => Promise<void>
  /**
   * The folder a `global` install writes under — its `.claude/skills`,
   * `.codex/skills`, `.agents/skills` and the rest are what every agent reads
   * in every project. The user's home folder in production.
   */
  homeDir?: string
}

export type SkillsService = {
  listSources(): Promise<SkillSourcesResult>
  addSource(input: SkillAddSourceInput): Promise<SkillAddSourceResult>
  addLocalSource(input: SkillAddLocalSourceInput): Promise<SkillAddSourceResult>
  removeSource(input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult>
  getScan(input: SkillScanInput): Promise<SkillScanOutcome>
  readFile(input: SkillReadFileInput): Promise<SkillReadFileResult>
  install(input: SkillInstallInput): Promise<SkillInstallOutcome>
  uninstall(input: SkillUninstallInput): Promise<SkillUninstallOutcome>
  syncSource(input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome>
  search(input: SkillSearchInput): Promise<SkillSearchOutcome>
  listPopularRepos(): Promise<SkillPopularReposOutcome>
  scanLinkedPlugin(input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome>
  installPlugin(input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome>
  uninstallPlugin(input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome>
  listInstalledPlugins(input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome>
  /** The hourly update check (source-updates.ts), also run on demand. Broadcasts its result. */
  checkSourceUpdates(): Promise<SkillSourceUpdateCheck>
}

export function createSkillsService(
  userDataDir: string,
  deps: SkillsServiceDeps,
  store: SkillSourceStore = createSkillSourceStore(userDataDir),
): SkillsService {
  const studioSeedRoot = deps.studioMarketplaceSeedRoot ?? defaultStudioMarketplaceSeedRoot
  const listHarnesses = deps.listHarnesses ?? (() => resolveInstalledSkillHarnesses())
  const globalRoot = (): string => deps.homeDir ?? homedir()
  /**
   * The folders whose installed copies a call touches: the workspace's when
   * one is open, and always the home folder's. A workspace opened on the home
   * folder is one root, not two.
   */
  const installRoots = (workspaceRoot: string): string[] => {
    const roots = workspaceRoot && existsSync(workspaceRoot) ? [resolve(workspaceRoot)] : []
    const home = resolve(globalRoot())
    if (!roots.includes(home)) roots.push(home)
    return roots
  }
  /** Re-copy what each root holds from this source, out of the scan just read. */
  const refreshCopies = async (
    workspaceRoot: string,
    sourceId: string,
    scan: ScanResult,
    readFile: (skill: ScannedSkill, file: SkillFileRef) => Promise<Buffer>,
  ): Promise<SkillSyncCopyResult> => {
    const refreshed: SkillSyncCopyResult['refreshed'] = []
    const failures: SkillSyncCopyResult['failures'] = []
    for (const root of installRoots(workspaceRoot)) {
      const copied = await refreshInstalledSkills({
        workspaceRoot: root,
        sourceId,
        scan,
        installedCopies: await installedSkillCopies(root),
        readFile,
      })
      refreshed.push(...copied.refreshed)
      failures.push(...copied.failures)
    }
    return { refreshed, failures }
  }
  /** The bundled marketplace seed, read at most once: undefined until asked. */
  let studioSeed: ScanResult | null | undefined
  const discovery = createSkillDiscoveryClient(deps.discovery)
  const installs = deps.pluginInstallStore ?? createPluginInstallStore(userDataDir)
  const mcpClients = deps.mcpClients ?? (async () => ['claude-code', 'codex'])
  // Read at call time, never captured: the integrator hands these in as
  // getters that change once git is probed (after the app is ready) or found
  // (after the person installs it). A reader is only ever present because this
  // machine has git, so its presence IS the transport unless told otherwise.
  const transportNow = (): SkillRepoTransport => deps.repoTransport ?? (deps.repoReader ? 'git' : 'api')
  const gitInstalledNow = (): boolean => deps.gitInstalled ?? true
  const refreshTransport = async (): Promise<void> => {
    await deps.refreshTransport?.()
  }
  const updateChecker = createSourceUpdateChecker({
    store,
    resolveToken: deps.resolveToken,
    github: deps.github,
    get repoReader() {
      return deps.repoReader
    },
    get transport() {
      return transportNow()
    },
    refreshTransport,
  })

  /**
   * The reader this call reads through, and what one pass may spend.
   *
   * One place decides both, so nothing below can quietly reach past the reader
   * to `github-tree.ts` (git-transport ruling, owner 2026-09-08). The budget is
   * gone on git: a tree listing over git's protocol is not a REST request and
   * is not counted by the 60-an-hour limit the budget exists to protect, so a
   * Sync reads every plugin the marketplace lists rather than twenty of them.
   */
  async function repoContext(): Promise<RepoContext> {
    await refreshTransport()
    const token = await deps.resolveToken()
    const transport = transportNow()
    return {
      reader: deps.repoReader ?? apiSkillRepoReader({ ...deps.github, token }),
      transport,
      linkedBudget: transport === 'git' ? Number.POSITIVE_INFINITY : linkedRepositoryBudget(token),
    }
  }

  const localRootFor = (id: string): string | null =>
    id.startsWith(LOCAL_SKILL_SOURCE_ID_PREFIX) ? id.slice(LOCAL_SKILL_SOURCE_ID_PREFIX.length) : null

  /**
   * The scan a source is currently listed from.
   *
   * `seed: false` is what `getScan` passes, and the distinction is the whole of
   * the remote-first rule: everything DOWNSTREAM of a listing — locating a
   * skill, reading a file, installing — has to work against whatever is on
   * screen, seed included, or the offline tab would list rows that refuse to
   * open. The listing read itself must not take the seed as a cache hit, or it
   * would stop going to the repository the moment one was produced.
   */
  async function scanFor(sourceId: string, options: { seed?: boolean } = {}): Promise<ScanResult | null> {
    const cached = await store.getScan(sourceId)
    if (cached) return cached
    if (sourceId === STUDIO_SKILL_SOURCE_ID && options.seed !== false) return studioMarketplaceSeed()
    return null
  }

  /**
   * Our own marketplace as the build shipped it: the seed the tab falls back to
   * when the repository cannot be reached (studio-marketplace ruling,
   * 2026-09-06), which is `registry-client.ts`'s rule for the signed index —
   * remote wins, bundled answers when there is no remote to be had.
   *
   * Marked `bundled` so the surface can say which of the two it is showing, and
   * deliberately never handed to `store.putSource`: a seed cached as though it
   * were a scan would be a build's-worth of staleness that no Sync could
   * distinguish from a real read, and the next launch would stop trying.
   */
  async function studioMarketplaceSeed(): Promise<ScanResult | null> {
    if (studioSeed !== undefined) return studioSeed
    const root = studioSeedRoot()
    if (!root || !existsSync(root)) {
      studioSeed = null
      return null
    }
    try {
      const scan = await scanLocalSkillSource(root, {
        maxEntries: Number.POSITIVE_INFINITY,
        plugins: true,
      })
      studioSeed = { ...scan, bundled: true }
    } catch {
      // A build whose resources did not ship is a tab that says why it is
      // empty, not a throw on the way to drawing it.
      studioSeed = null
    }
    return studioSeed
  }

  return {
    async listSources() {
      // The transport rides the list because every sentence about a cadence or
      // an unread plugin depends on it, and the renderer has no other way to
      // learn which reader this build wired (git-transport ruling, owner
      // 2026-09-08).
      await refreshTransport()
      return {
        ok: true,
        sources: await store.listSources(),
        transport: transportNow(),
        gitInstalled: gitInstalledNow(),
      }
    },

    async addSource(input) {
      const ref = parseSkillRepoRef(input.repo ?? '')
      if (!ref) {
        skillSourceLog('source-add', { repo: input.repo ?? '', outcome: 'not-a-repository' })
        return {
          ok: false,
          message:
            'Enter a repository: owner/name on GitHub, or the https or ssh address of any git repository, like the one its Clone button gives.',
        }
      }
      const repoName = skillRepoName(ref)
      const id = `github:${repoName}`
      // Pasting one of the always-present repositories is not an add: the store
      // keeps a single record per id, so the paste lands in the Anthropic or
      // SprintEngine Studio tab and no row appears in the list. It used to
      // report a plain success and leave the person hunting for a source that
      // was never going to be there.
      const mergedIntoBuiltin = !isRemovableSkillSource(id)
      const existing = await store.getSource(id)
      if (existing && input.replace !== true && !mergedIntoBuiltin) {
        skillSourceLog('source-add', { id, outcome: 'already-in-list' })
        return { ok: false, message: `${repoName} is already one of your sources.` }
      }
      try {
        const context = await repoContext()
        // Re-adding a repository already in the list carries its cached scan
        // in, so the linked plugins it already read are not read again.
        const { source, scan } = await scanGithubSource(ref, id, context, await store.getScan(id))
        await store.putSource(source, scan)
        skillSourceLog('source-add', {
          id,
          outcome: mergedIntoBuiltin ? 'merged-into-builtin' : 'added',
          skills: scan.skills.length,
        })
        return mergedIntoBuiltin ? { ok: true, source, scan, mergedIntoBuiltin: true } : { ok: true, source, scan }
      } catch (error) {
        const message = describeFetchError(error)
        skillSourceLog('source-add', { id, outcome: 'failed', message })
        return { ok: false, message }
      }
    },

    /**
     * A folder on this machine as a source. It scans with the same rule a
     * repository does — walk to SKILL.md, take the directory whole — over a
     * filesystem listing instead of a git tree, which is exactly what the two
     * bundled sources already do. It carries no commit, so nothing about it
     * can claim an update is available and Sync re-reads the folder rather
     * than fetching anything.
     */
    async addLocalSource(input) {
      const path = input.path?.trim() ?? ''
      if (!path) return { ok: false, message: 'Choose a folder to add as a source.' }
      // A file passes existsSync and then scans as a folder holding nothing, so
      // the honest answer to "this is not a folder" would have been "No skills
      // here" — a source that reads as empty rather than as refused.
      let entry
      try {
        entry = statSync(path)
      } catch {
        return { ok: false, message: `${path} does not exist.` }
      }
      if (!entry.isDirectory()) return { ok: false, message: 'That is a file, not a folder.' }
      const id = `${LOCAL_SKILL_SOURCE_ID_PREFIX}${path}`
      // Re-adding a folder already in the list re-scans it, which is what
      // someone who picks it twice means; `replace: false` is the caller that
      // wants to be told instead.
      if (input.replace !== true && (await store.getSource(id))) {
        return { ok: false, message: `${path} is already one of your sources.` }
      }
      try {
        const scan = await scanLocalSkillSource(path)
        const name = localSourceFolderName(path)
        const source: SkillSource = {
          id,
          kind: 'local',
          name,
          repo: '',
          path,
          monogram: skillSourceMonogram(name),
          blurb: path,
          commitSha: '',
          scannedAt: new Date().toISOString(),
        }
        await store.putSource(source, scan)
        return { ok: true, source, scan }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async removeSource(input) {
      const id = input.sourceId ?? ''
      if (!isRemovableSkillSource(id)) {
        skillSourceLog('source-remove', { id, outcome: 'refused-always-present' })
        return { ok: false, message: 'This source is part of SprintEngine and cannot be removed.' }
      }
      // The store now refuses to write over a file it could not read (a
      // permission error, a busy volume) and says so by throwing. Here that is
      // an answer for the person, not a rejected IPC call: the modal and the
      // tab's Remove both await this result and read `message` from it.
      let removed: boolean
      try {
        removed = await store.removeSource(id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        skillSourceLog('source-remove', { id, outcome: 'failed', message })
        return { ok: false, message }
      }
      skillSourceLog('source-remove', { id, outcome: removed ? 'removed' : 'not-in-list' })
      return removed ? { ok: true, sourceId: id } : { ok: false, message: 'That source is not in your list.' }
    },

    /**
     * A source's skills, from its cached scan.
     *
     * A repository source with no cached scan is read now rather than reported
     * as unreadable: that is the state a source added while offline is left in,
     * and "open it and it lists" is what the user expects of a source in their
     * list. A read that fails says why, and Try again retries the read itself.
     */
    async getScan(input) {
      const source = await store.getSource(input.sourceId ?? '')
      if (!source) return { ok: false, message: 'That source is not in your list.' }
      const scan = await scanFor(source.id, { seed: false })
      if (scan) return { ok: true, source, scan }
      if (source.kind === 'local') {
        const root = localRootFor(source.id)
        if (!root || !existsSync(root)) {
          return { ok: false, message: `${source.path ?? source.name} is no longer on this machine.` }
        }
        try {
          const rescanned = await scanLocalSkillSource(root)
          await store.putSource(source, rescanned)
          return { ok: true, source, scan: rescanned }
        } catch (error) {
          // A folder that outgrew the walk's cap since it was added: the reason
          // is the reader's to see, not a rejected IPC call.
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }
      if (source.kind !== 'github') {
        return { ok: false, message: `${source.name} is not available in this build.` }
      }
      const ref = parseSkillRepoRef(source.repo)
      if (!ref) return { ok: false, message: `${source.repo} is not a repository that can be read.` }
      try {
        const context = await repoContext()
        const scanned = await scanGithubSource(ref, source.id, context, await store.getScan(source.id))
        await store.putSource(scanned.source, scanned.scan)
        return { ok: true, source: scanned.source, scan: scanned.scan }
      } catch (error) {
        // Our own marketplace is the one repository the build also SHIPS, so a
        // read that could not happen falls back to the copy on disk rather than
        // to an empty tab. Every other source has nothing to fall back to and
        // says why it is silent.
        if (source.id === STUDIO_SKILL_SOURCE_ID) {
          const seed = await studioMarketplaceSeed()
          if (seed) return { ok: true, source, scan: seed }
        }
        return { ok: false, message: describeFetchError(error) }
      }
    },

    async readFile(input) {
      const found = await resolveSkillFile(input.sourceId ?? '', input.skillId ?? '', input.path ?? '')
      if (!found.ok) return found
      try {
        const bytes = await readSkillBytes(found.source, found.skill, found.file)
        // Reading returns text. Decoding an image or archive as UTF-8 would
        // hand back convincing mojibake, so a file that is not text says so.
        if (!isUtf8Text(bytes)) {
          return { ok: false, message: `${found.file.path} is not a text file.` }
        }
        return { ok: true, path: found.file.path, content: bytes.toString('utf8') }
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }
    },

    async install(input) {
      const workspaceRoot = input.workspaceRoot?.trim() ?? ''
      // A caller that names no scope keeps the meaning it always had: a folder
      // given is the folder installed into. The Skills surfaces ask for
      // `global`, which is what makes a skill usable in every chat.
      const scope = input.scope ?? (workspaceRoot ? 'workspace' : 'global')
      if (scope === 'workspace') {
        if (!workspaceRoot) {
          return { ok: false, message: 'Open a project folder to install a skill into that project only.' }
        }
        if (!existsSync(workspaceRoot)) {
          return { ok: false, message: 'That workspace folder no longer exists.' }
        }
      }
      const located = await locateSkill(input.sourceId ?? '', input.skillId ?? '')
      if (!located.ok) return located
      const harnesses = await listHarnesses()
      const result = await installSkill({
        workspaceRoot: scope === 'workspace' ? workspaceRoot : globalRoot(),
        skill: located.skill,
        harnesses,
        readFile: (file) => readSkillBytes(located.source, located.skill, file),
        provenance: {
          sourceId: located.source.id,
          skillId: located.skill.id,
          commitSha: located.source.commitSha,
        },
      })
      return result.ok ? { ...result, scope } : result
    },

    /**
     * Removal sweeps every harness dir, not only the ones this machine reads
     * today: a skill installed while another CLI was present still has a copy
     * there, and leaving it behind means an agent keeps reading a skill the
     * user removed.
     */
    async uninstall(input) {
      const workspaceRoot = input.workspaceRoot?.trim() ?? ''
      if (workspaceRoot && !existsSync(workspaceRoot)) {
        return { ok: false, message: 'That workspace folder no longer exists.' }
      }
      // Both copies go: the workspace's, and the one every project reads. A
      // Remove that left either behind would leave an agent reading the skill.
      let dirName = input.dirName ?? ''
      const removedPaths: string[] = []
      for (const root of installRoots(workspaceRoot)) {
        const result = await uninstallSkill({ workspaceRoot: root, dirName, harnesses: SKILL_PACK_HARNESSES })
        if (!result.ok) return result
        dirName = result.dirName
        removedPaths.push(...result.removedPaths)
      }
      // A row whose skill is already gone is a stale row, and saying so beats
      // reporting a removal that removed nothing.
      if (removedPaths.length === 0) {
        return { ok: false, message: `${dirName} is not installed.` }
      }
      if (workspaceRoot) await pruneSkillFromPluginReceipts(installs, workspaceRoot, dirName)
      return { ok: true, dirName, removedPaths }
    },

    /**
     * Re-read a source at its current head, replace its cached scan, and copy
     * out of the new one the skills this workspace holds *from this source* —
     * a directory installed from somewhere else keeps its bytes.
     *
     * The store is written only once the whole scan succeeded, so a failed sync
     * leaves the list exactly as it was rather than half-refreshed with a
     * timestamp that says otherwise.
     */
    async syncSource(input) {
      const source = await store.getSource(input.sourceId ?? '')
      if (!source) return { ok: false, message: 'That source is not in your list.' }
      if (source.kind === 'local') return syncLocalSource(source, input)
      if (source.kind !== 'github') {
        return { ok: false, message: `${source.name} ships with SprintEngine and refreshes with the app.` }
      }
      const ref = parseSkillRepoRef(source.repo)
      if (!ref) {
        return { ok: false, message: `${source.repo} is not a repository that can be re-read.` }
      }

      const previous = await store.getScan(source.id)
      let rescan: { source: SkillSource; scan: ScanResult }
      try {
        const context = await repoContext()
        // `previous` is the cache the follow reads: a linked plugin whose pinned
        // sha has not moved is carried over instead of fetched again, which is
        // what makes the second Sync of a marketplace cost a fraction of the
        // first and what lets a budgeted pass resume where it stopped.
        rescan = await scanGithubSource(ref, source.id, context, previous)
        // Synced to head: the head the last check recorded IS this commit now,
        // so the drift mark clears with the scan rather than an hour later.
        rescan.source = { ...rescan.source, headSha: rescan.source.commitSha, headCheckedAt: new Date().toISOString() }
        await store.putSource(rescan.source, rescan.scan)
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }

      const changes = diffScannedSkills(previous, rescan.scan)
      const workspaceRoot = input.workspaceRoot?.trim() ?? ''
      // Sources are app-level and the door opens without a workspace, so a sync
      // with none still refreshes the copies installed for every project.
      const copied = await refreshCopies(workspaceRoot, source.id, rescan.scan, (skill, file) =>
        readSkillBytes(rescan.source, skill, file),
      )

      return {
        ok: true,
        source: rescan.source,
        scan: rescan.scan,
        added: changes.added.length,
        removed: changes.removed.length,
        refreshed: copied.refreshed.length,
        failures: copied.failures,
        // The servers this source installed, re-read at the same commit as the
        // skills. Independent of the workspace: MCP settings are app-level, so
        // a sync with no workspace open still refreshes them.
        mcpServers: refreshSourceMcpServers({
          sourceId: source.id,
          servers: input.mcpServers ?? [],
          scan: rescan.scan,
          commitSha: rescan.scan.commitSha,
        }),
      }
    },

    /**
     * Discover finds candidates; it does not add anything. A chosen result is
     * handed to `addSource`, which is the one path that scans a repository.
     */
    async search(input) {
      return discovery.searchSkills(input.query ?? '', await deps.resolveToken())
    },

    async listPopularRepos() {
      return discovery.listPopularSkillRepos(await deps.resolveToken())
    },

    scanLinkedPlugin: scanLinkedPluginNow,
    installPlugin: installPluginNow,
    uninstallPlugin: uninstallPluginNow,
    listInstalledPlugins: listInstalledPluginsNow,

    async checkSourceUpdates() {
      const check = await updateChecker.check()
      deps.broadcastSourceUpdates?.(check)
      return check
    },
  }

  /**
   * Sync a folder source: read the folder again and refresh what this
   * workspace installed from it. Nothing is fetched, so the only failure is a
   * folder that has gone away — and that is reported rather than left as a
   * list wearing a fresh timestamp for bytes nobody re-read.
   */
  async function syncLocalSource(source: SkillSource, input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome> {
    const root = localRootFor(source.id)
    if (!root || !existsSync(root)) {
      return { ok: false, message: `${source.path ?? source.name} is no longer on this machine.` }
    }
    const previous = await store.getScan(source.id)
    let scan: ScanResult
    try {
      scan = await scanLocalSkillSource(root)
    } catch (error) {
      // A failed sync leaves the list exactly as it was and says why, the same
      // rule the repository path follows.
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const synced: SkillSource = { ...source, scannedAt: new Date().toISOString() }
    await store.putSource(synced, scan)
    const changes = diffScannedSkills(previous, scan)
    const workspaceRoot = (input.workspaceRoot ?? '').trim()
    const copied = await refreshCopies(workspaceRoot, source.id, scan, (skill, file) =>
      readSkillBytes(synced, skill, file),
    )
    return {
      ok: true,
      source: synced,
      scan,
      added: changes.added.length,
      removed: changes.removed.length,
      refreshed: copied.refreshed.length,
      failures: copied.failures,
      mcpServers: refreshSourceMcpServers({
        sourceId: source.id,
        servers: input.mcpServers ?? [],
        scan,
        commitSha: scan.commitSha,
      }),
    }
  }

  /**
   * A linked plugin lives in another repository, and is read when opened:
   * that repository's tree at the commit the marketplace pinned (or its head
   * when it pinned none), the plugin's directory in it, and its skills. The
   * result is written back into the source's scan so the read happens once.
   */
  async function scanLinkedPluginNow(input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome> {
    const source = await store.getSource(input.sourceId ?? '')
    if (!source) return { ok: false, message: 'That source is not in your list.' }
    const scan = await scanFor(source.id)
    const plugin = scanPlugins(scan ?? { plugins: [] }).find((candidate) => candidate.id === input.pluginId)
    if (!scan || !plugin) return { ok: false, message: 'That plugin is not in this source.' }
    if (plugin.origin.kind !== 'linked') return { ok: true, source, scan, plugin }
    // A plugin the follow already read is re-read here anyway, and that is the
    // point: the follow lists components from the tree without fetching a
    // single skill's entry document, so this is where the descriptions come
    // from (linked-plugins review, 2026-09-06).

    if (plugin.origin.repo === '') {
      return {
        ok: false,
        message: `${plugin.name} is hosted at ${plugin.origin.url}, which this app does not read from.`,
      }
    }
    const repo = plugin.origin.repo
    try {
      const { reader } = await repoContext()
      const commitSha = plugin.origin.sha || (await reader.resolveCommit(repo, plugin.origin.ref))
      const entries = await reader.readTree(repo, commitSha)
      const skillScan = scanSkillTree({ entries: [...entries], commitSha })
      const dir = plugin.origin.path
      const inDir = skillScan.skills.filter((skill) => dir === '' || skill.id === dir || skill.id.startsWith(`${dir}/`))
      // `all`, because these ARE the plugin's components rather than a source's
      // skill listing: dropping one here would shrink a plugin's declared
      // contents with nothing on screen to say why.
      const { all: skills } = await enrichSkills(inDir, (skill) =>
        reader
          .readFile(repo, commitSha, joinRepoPath(skill.id, SKILL_ENTRY_FILE))
          .then((bytes) => bytes?.toString('utf8') ?? null),
      )
      const read = await readPluginComponents({
        dir,
        entries: [...entries],
        skills,
        readFile: (path) =>
          reader
            .readFile(repo, commitSha, path)
            .then((bytes) => bytes?.toString('utf8') ?? null)
            .catch(() => null),
      })
      const updated: ScannedPlugin = {
        ...plugin,
        version: plugin.version || read.manifest?.version || '',
        description: plugin.description || read.manifest?.description || '',
        author: plugin.author || read.manifest?.author || '',
        homepage: plugin.homepage || read.manifest?.homepage || '',
        // `origin.sha` is what the MARKETPLACE pinned and stays that, '' and
        // all; the commit this read used is recorded beside it. Writing it into
        // the origin made an unpinned entry look pinned and quietly moved every
        // later install onto a commit a scan happened to see (linked-plugins
        // review, 2026-09-06).
        readCommit: commitSha,
        // Opening a plugin is a full read of its one repository, entry
        // documents included, so it supersedes whatever the scan's budgeted
        // follow left behind — including a `pending` or `unreadable` verdict
        // this read has just disproved (linked-plugins ruling, 2026-09-06).
        // Unless files went missing on the way: then it is partly read, and
        // saying so is what keeps the hooks acknowledgement honest.
        componentsKnown: read.unreadFiles.length === 0,
        readState: read.unreadFiles.length > 0 ? { status: 'partial', unread: read.unreadFiles } : { status: 'read' },
        components: {
          ...read.components,
          mcpServers: read.components.mcpServers.map((server) => ({ ...server, declaredBy: plugin.id })),
        },
      }
      const nextScan: ScanResult = {
        ...scan,
        plugins: scanPlugins(scan).map((candidate) => (candidate.id === plugin.id ? updated : candidate)),
      }
      await store.putSource(source, nextScan)
      return { ok: true, source, scan: nextScan, plugin: updated }
    } catch (error) {
      return { ok: false, message: describeFetchError(error) }
    }
  }

  async function installPluginNow(input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome> {
    const workspaceRoot = input.workspaceRoot?.trim() ?? ''
    if (!workspaceRoot) {
      return {
        ok: false,
        message: 'Open a workspace to install a plugin — plugins install into a workspace, not the app.',
      }
    }
    if (!existsSync(workspaceRoot)) return { ok: false, message: 'That workspace folder no longer exists.' }
    const source = await store.getSource(input.sourceId ?? '')
    if (!source) return { ok: false, message: 'That source is not in your list.' }
    let scan = await scanFor(source.id)
    let plugin = scanPlugins(scan ?? { plugins: [] }).find((candidate) => candidate.id === input.pluginId)
    if (!scan || !plugin) return { ok: false, message: 'That plugin is not in this source.' }
    // Read it now when the scan did not, could not, or only partly could — and
    // when the marketplace pinned nothing, because "no pin" means the ref's head
    // at the moment you install, not the commit a scan happened to resolve
    // (linked-plugins review, 2026-09-06).
    const unpinned = plugin.origin.kind === 'linked' && plugin.origin.sha === ''
    if (!plugin.componentsKnown || unpinned || plugin.readState?.status === 'listed') {
      const read = await scanLinkedPluginNow({ sourceId: source.id, pluginId: plugin.id })
      if (!read.ok) return read
      scan = read.scan
      plugin = read.plugin
    }
    // Whatever that left, an install never proceeds on components nobody has
    // seen whole: the hooks acknowledgement can only disclose hooks that were
    // actually read, and a plugin whose hooks file was lost would sail past it.
    if (!plugin.componentsKnown) {
      return { ok: false, message: describeUnreadPlugin(plugin) }
    }
    const selected = selectPluginItems(plugin, {
      skillIds: input.skillIds,
      mcpServerIds: input.mcpServerIds,
    })
    if (!selected.ok) return selected
    // A filtered install copies only the chosen skills and servers — hooks
    // never land — so the acknowledgement that gates a full install does not
    // apply. The full path still refuses: that is the one that writes
    // enabledPlugins, which `claude plugin install` would then load whole.
    if (!selected.filtered && plugin.components.hooks.length > 0 && input.acknowledgedHooks !== true) {
      return {
        ok: false,
        needsHookAcknowledgement: true,
        message: `${plugin.name} runs ${plugin.components.hooks.length} hook command${plugin.components.hooks.length === 1 ? '' : 's'} on your machine. Review them, then install.`,
      }
    }
    const toInstall = selected.plugin
    const origin = plugin.origin
    // `readCommit` for a linked plugin: the commit the read above resolved,
    // which for a pinned entry IS `origin.sha` and for an unpinned one is the
    // ref's head as of a moment ago.
    const commitSha = origin.kind === 'linked' ? plugin.readCommit || origin.sha : source.commitSha
    // `owner/name` (or `host/owner/name` off github.com), which is the only
    // address a reader takes; '' when this plugin's bytes are not in a
    // repository at all.
    const bytesRepo: string = origin.kind === 'linked' ? origin.repo : source.kind === 'github' ? source.repo : ''
    const harnesses = await listHarnesses()
    // The plugin's OWN files, listed only when a server it declares runs out of
    // its directory. The listing is a repository tree request, so asking the
    // question first is what keeps every other plugin's install at the cost it
    // has always had
    // (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
    let pluginFiles: PluginDirectoryFile[] = []
    let readPluginFile: ((file: PluginDirectoryFile) => Promise<Buffer>) | undefined
    if (pluginNeedsOwnFiles(toInstall)) {
      const listed = await listPluginDirectory(source, plugin, commitSha, bytesRepo)
      if (!listed.ok) return listed
      pluginFiles = listed.files
      readPluginFile = listed.readFile
    }
    const result = await installPlugin({
      workspaceRoot,
      sourceId: source.id,
      marketplaceName: scan.marketplaceName ?? '',
      marketplaceRepo: source.kind === 'github' ? source.repo : '',
      plugin,
      skillIds: input.skillIds,
      mcpServerIds: input.mcpServerIds,
      harnesses,
      commitSha,
      readSkillFile: async (skill, file) => {
        // An in-tree plugin of our own marketplace is on this disk already, so
        // `readSkillBytes` answers it from the seed and the install works with
        // no network; a linked plugin has its own repository and never can.
        if (bytesRepo !== '' && origin.kind === 'linked') {
          const { reader } = await repoContext()
          const path = joinRepoPath(skill.id, file.path)
          return requiredBytes(await reader.readFile(bytesRepo, commitSha, path), bytesRepo, path)
        }
        return readSkillBytes(source, skill, file)
      },
      pluginFiles,
      ...(readPluginFile ? { readPluginFile } : {}),
      mcpClients: await mcpClients(),
    })
    if (!result.ok) return result
    const existing = await installs.get(workspaceRoot, source.id, plugin.id)
    await installs.put(
      mergeInstalledPluginRecord(existing, {
        workspaceRoot,
        sourceId: source.id,
        pluginId: plugin.id,
        pluginName: plugin.name,
        marketplaceName: scan.marketplaceName ?? '',
        claudePluginKey: result.claudePluginKey,
        skillDirNames: [...new Set(result.harnesses.flatMap((harness) => harness.skillDirNames))],
        ...(result.pluginDirName ? { pluginDirName: result.pluginDirName } : {}),
        mcpServerIds: result.mcpServers.map((server) => server.id),
        commitSha,
        installedAt: new Date().toISOString(),
      }),
    )
    // The receipt just written names the plugin as the marketplace lists it
    // NOW. A receipt under a name it was renamed from is the same install, and
    // leaving it beside the new one lists the plugin twice under Installed and
    // leaves an uninstall that removes only half of it.
    for (const alias of pluginAliases(scanPluginRenames(scan), plugin.id)) {
      if (alias !== plugin.id) await installs.remove(workspaceRoot, source.id, alias)
    }
    return {
      ok: true,
      plugin,
      harnesses: result.harnesses,
      mcpServers: result.mcpServers,
      claudePluginKey: result.claudePluginKey,
      pluginRoot: result.pluginRoot,
      pluginFileCount: result.pluginFileCount,
      warnings: result.warnings,
    }
  }

  /**
   * Every file of a plugin's OWN directory, and how to read one.
   *
   * Four places a plugin's bytes can live, and each answers the same shape:
   * a linked plugin's repository at the commit the read resolved, an in-tree
   * plugin of a GitHub source at that source's commit, a folder source on this
   * disk, and our own bundled marketplace seed. A registry entry has no
   * directory at all, and says so rather than installing an empty one.
   *
   * Symlinks and anything that is not a blob are skipped, for the reason the
   * skill scan skips them: a symlink's content is a path, and writing one into
   * a workspace either recreates a link out of the plugin directory or drops a
   * file holding somebody else's path.
   */
  async function listPluginDirectory(
    source: SkillSource,
    plugin: ScannedPlugin,
    commitSha: string,
    /** `owner/name` for a plugin whose files are in a repository, '' otherwise. */
    bytesRepo: string,
  ): Promise<
    | { ok: true; files: PluginDirectoryFile[]; readFile: (file: PluginDirectoryFile) => Promise<Buffer> }
    | { ok: false; message: string }
  > {
    const origin = plugin.origin
    if (origin.kind === 'registry') {
      return {
        ok: false,
        message: `${plugin.name} declares an MCP server that runs from the plugin's own directory, which a marketplace-registry entry does not ship.`,
      }
    }
    const dir = origin.path
    const localRoot =
      source.kind === 'local'
        ? localRootFor(source.id)
        : source.id === STUDIO_SKILL_SOURCE_ID && source.commitSha === ''
          ? studioSeedRoot()
          : null
    if (localRoot) {
      const root = dir === '' ? localRoot : join(localRoot, ...dir.split('/'))
      try {
        const entries = await listLocalTree(root)
        return {
          ok: true,
          files: entries.map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
          readFile: (file) => readFile(join(root, ...file.path.split('/'))),
        }
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }
    }
    if (bytesRepo === '' || splitSkillRepo(bytesRepo) === null) {
      return { ok: false, message: `${plugin.name} is not in a repository this app can read its files from.` }
    }
    try {
      const { reader } = await repoContext()
      const entries = await reader.readTree(bytesRepo, commitSha)
      const prefix = dir === '' ? '' : `${dir}/`
      const files = entries
        .filter((entry) => entry.type === 'blob' && entry.mode !== '120000')
        .filter((entry) => prefix === '' || entry.path.startsWith(prefix))
        .map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size ?? 0 }))
        .filter((entry) => entry.path !== '')
      return {
        ok: true,
        files,
        readFile: async (file) => {
          const path = `${prefix}${file.path}`
          const { reader } = await repoContext()
          return requiredBytes(await reader.readFile(bytesRepo, commitSha, path), bytesRepo, path)
        },
      }
    } catch (error) {
      return { ok: false, message: describeFetchError(error) }
    }
  }

  async function uninstallPluginNow(input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome> {
    const workspaceRoot = input.workspaceRoot?.trim() ?? ''
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      return { ok: false, message: 'That workspace folder no longer exists.' }
    }
    const record = await installs.get(workspaceRoot, input.sourceId ?? '', input.pluginId ?? '')
    if (!record) return { ok: false, message: 'That plugin is not installed in this workspace.' }
    const mcpServerId = input.mcpServerId?.trim() ?? ''
    if (mcpServerId !== '') {
      if (!record.mcpServerIds.includes(mcpServerId)) {
        return { ok: false, message: `${mcpServerId} is not installed from this plugin.` }
      }
      const mcpServerIds = record.mcpServerIds.filter((id) => id !== mcpServerId)
      if (mcpServerIds.length === 0 && record.skillDirNames.length === 0) {
        const result = await uninstallPlugin({
          workspaceRoot,
          pluginId: record.pluginId,
          marketplaceName: record.marketplaceName,
          skillDirNames: [],
          pluginDirName: record.pluginDirName ?? '',
          allHarnesses: SKILL_PACK_HARNESSES,
        })
        if (!result.ok) return result
        await installs.remove(workspaceRoot, record.sourceId, record.pluginId)
        return { ...result, mcpServerIds: [mcpServerId] }
      }
      await installs.put({ ...record, mcpServerIds })
      return {
        ok: true,
        removedPaths: [],
        disabledClaudePluginKey: '',
        mcpServerIds: [mcpServerId],
        warnings: [],
      }
    }
    const result = await uninstallPlugin({
      workspaceRoot,
      pluginId: record.pluginId,
      marketplaceName: record.marketplaceName,
      skillDirNames: record.skillDirNames,
      pluginDirName: record.pluginDirName ?? '',
      allHarnesses: SKILL_PACK_HARNESSES,
    })
    if (!result.ok) return result
    await installs.remove(workspaceRoot, record.sourceId, record.pluginId)
    return { ...result, mcpServerIds: record.mcpServerIds }
  }

  /**
   * What is installed, from two places: the receipts this app wrote, and the
   * plugins the workspace's Claude settings enable — a plugin enabled by hand
   * with `/plugin install` is installed too, and listing only our own writes
   * would offer to install it again.
   */
  async function listInstalledPluginsNow(input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome> {
    const workspaceRoot = input.workspaceRoot?.trim() ?? ''
    if (!workspaceRoot) return { ok: true, plugins: [] }
    const recorded = await installs.list(workspaceRoot)
    const known = new Set(recorded.map((record) => record.claudePluginKey).filter((key) => key !== ''))
    const enabled = await readEnabledClaudePlugins(workspaceRoot)
    const foreign = [...enabled]
      .filter((key) => !known.has(key))
      .map((key): InstalledPluginRecordShape => {
        const at = key.lastIndexOf('@')
        return {
          workspaceRoot,
          sourceId: '',
          pluginId: at === -1 ? key : key.slice(0, at),
          pluginName: at === -1 ? key : key.slice(0, at),
          marketplaceName: at === -1 ? '' : key.slice(at + 1),
          claudePluginKey: key,
          skillDirNames: [],
          mcpServerIds: [],
          commitSha: '',
          installedAt: '',
        }
      })
    return { ok: true, plugins: [...recorded, ...foreign] }
  }

  async function locateSkill(
    sourceId: string,
    skillId: string,
  ): Promise<{ ok: true; source: SkillSource; skill: ScannedSkill } | { ok: false; message: string }> {
    const source = await store.getSource(sourceId)
    if (!source) return { ok: false, message: 'That source is not in your list.' }
    const scan = await scanFor(source.id)
    const skill = scan?.skills.find((candidate) => candidate.id === skillId)
    if (!skill) return { ok: false, message: 'That skill is not in this source.' }
    return { ok: true, source, skill }
  }

  async function resolveSkillFile(
    sourceId: string,
    skillId: string,
    path: string,
  ): Promise<
    { ok: true; source: SkillSource; skill: ScannedSkill; file: SkillFileRef } | { ok: false; message: string }
  > {
    const located = await locateSkill(sourceId, skillId)
    if (!located.ok) return located
    // Only files the scan already listed are readable, so a crafted path can
    // never reach outside the skill.
    const file = located.skill.files.find((candidate) => candidate.path === path)
    if (!file) return { ok: false, message: 'That file is not part of this skill.' }
    return { ok: true, source: located.source, skill: located.skill, file }
  }

  async function readSkillBytes(source: SkillSource, skill: ScannedSkill, file: SkillFileRef): Promise<Buffer> {
    const repoPath = joinRepoPath(skill.id, file.path)
    const seeded = await readStudioSeedBytes(source, repoPath)
    if (seeded) return seeded
    if (source.kind === 'github') {
      const { reader } = await repoContext()
      return requiredBytes(await reader.readFile(source.repo, source.commitSha, repoPath), source.repo, repoPath)
    }
    const root = localRootFor(source.id)
    if (!root) throw new SkillFetchError(`${source.name} is not available in this build.`)
    return readFile(join(root, ...skill.id.split('/').filter(Boolean), ...file.path.split('/')))
  }

  /**
   * One file of our own marketplace from the copy this build ships, or null
   * when it holds no such file.
   *
   * Installing a studio skill used to be a copy from `resources/skills` and
   * cost nothing; now that the source is a repository it would be a download,
   * and a person with no network could no longer install the skills sitting on
   * their own disk. The bundled tree mirrors the published one path-for-path,
   * so it answers the same bytes at no cost.
   *
   * ONLY while nothing has been read from the repository. A source carrying a
   * commit has been LISTED from the repository, and the rows on screen are that
   * repository's; serving the build's bytes for them would install a version of
   * a skill nobody is looking at, silently, and only on the machines whose
   * bundle happens to be behind. The seed is the listing's companion, never a
   * cache in front of it.
   *
   * Confined to the seed root: `skill.id` and `file.path` come from a scan of
   * third-party bytes, and `..` in either must not reach out of the tree.
   */
  async function readStudioSeedBytes(source: SkillSource, repoPath: string): Promise<Buffer | null> {
    if (source.id !== STUDIO_SKILL_SOURCE_ID || source.commitSha !== '') return null
    const root = studioSeedRoot()
    if (!root) return null
    const base = resolve(root)
    const full = resolve(base, ...repoPath.split('/').filter(Boolean))
    if (full !== base && !full.startsWith(`${base}${sep}`)) return null
    return readFile(full).catch(() => null)
  }
}

async function scanGithubSource(
  ref: SkillRepoRef,
  id: string,
  context: RepoContext,
  /**
   * This source's previous scan, when there is one. A linked plugin whose
   * pinned sha has not moved is taken from it, so a re-scan reads only what
   * moved (linked-plugins ruling, 2026-09-06).
   */
  previous?: ScanResult | null,
): Promise<{ source: SkillSource; scan: ScanResult }> {
  const { reader } = context
  const repo = skillRepoName(ref)
  const commitSha = await reader.resolveCommit(repo, ref.ref)
  const entries = [...(await reader.readTree(repo, commitSha))]
  const manifest = entries.some((entry) => entry.type === 'blob' && entry.path === SKILL_MARKETPLACE_MANIFEST_PATH)
    ? await reader
        .readFile(repo, commitSha, SKILL_MARKETPLACE_MANIFEST_PATH)
        .then((bytes) => bytes?.toString('utf8') ?? null)
        .catch(() => null)
    : null

  const scanned = scanSkillTree({ entries, commitSha, marketplaceManifest: manifest })
  const { all, skills, skippedNoDescription } = await enrichSkills(scanned.skills, (skill) =>
    reader
      .readFile(repo, commitSha, joinRepoPath(skill.id, SKILL_ENTRY_FILE))
      .then((bytes) => bytes?.toString('utf8') ?? null),
  )
  // The plugins and MCP servers the same tree declares. Their manifests are a
  // handful of small raw reads at the pinned commit; one that fails leaves its
  // plugin listed under the marketplace's own words.
  const plugins = await scanPluginTree({
    entries,
    // A marketplace on another host may link plugins in other repositories
    // on that same host; nowhere else but github.com.
    host: ref.host,
    // Every directory, not just the listable ones: a plugin's own manifest is
    // the authority on what that plugin ships, and a skill this scan will not
    // list is still a directory the plugin shipped.
    skills: all,
    marketplaceManifest: manifest,
    readFile: (path) =>
      reader
        .readFile(repo, commitSha, path)
        .then((bytes) => bytes?.toString('utf8') ?? null)
        .catch(() => null),
  })
  // …and the plugins that live in OTHER repositories, read at the commits this
  // marketplace pinned (linked-plugins ruling, 2026-09-06). One tree listing
  // per distinct repository, and every plugin a previous scan already read at
  // the same sha costs nothing at all. The budget the token used to decide is
  // infinite over git, where a listing is not a REST request (git-transport
  // ruling, owner 2026-09-08).
  const followed = await followLinkedPlugins({
    plugins: plugins.plugins,
    cached: previous ? scanPlugins(previous) : [],
    marketplaceManifest: manifest,
    budget: context.linkedBudget,
    extraHosts: parseMarketplaceExtraHosts(readStudioEnv(MARKETPLACE_EXTRA_HOSTS_ENV)),
    reader: linkedPluginReaderOver(context),
  })
  // `fileCount` is recounted because a skipped skill takes its files with it.
  const scan: ScanResult = {
    ...scanned,
    skills,
    skippedNoDescription,
    fileCount: skills.reduce((total, skill) => total + skill.files.length, 0),
    ...plugins,
    plugins: followed.plugins,
    // The source's server list is the reach of everything it lists, in-tree and
    // linked alike: 15 was the in-tree count, and it was not what this
    // repository actually offers.
    mcpServers: dedupeScannedMcpServers([...plugins.mcpServers, ...followed.mcpServers]),
  }

  const name = repo
  return {
    source: {
      id,
      kind: 'github',
      name: ref.repo,
      repo: name,
      monogram: skillSourceMonogram(ref.repo),
      blurb: describeSourceBlurb(name, skills.length, scan.plugins?.length ?? 0, scan.mcpServers?.length ?? 0),
      commitSha,
      scannedAt: new Date().toISOString(),
    },
    scan,
  }
}

/**
 * The one reader this service reads a repository through, and what a pass may
 * spend against it.
 */
type RepoContext = {
  reader: SkillRepoReader
  transport: SkillRepoTransport
  /** Linked repositories one follow may read; `Infinity` on git, where a listing is free. */
  linkedBudget: number
}

/**
 * `SkillRepoReader` over GitHub's REST API — the fallback for a machine with no
 * git (git-transport ruling, owner 2026-09-08).
 *
 * `readFile` answers null for a file that is not there, because that is what
 * the interface means by a missing path and what the git reader answers; every
 * other failure is still thrown, so a fetch that failed is never mistaken for a
 * plugin that ships nothing.
 */
function apiSkillRepoReader(github: SkillGithubOptions): SkillRepoReader {
  // A repository on another host keeps it, so the API calls below refuse it
  // by name rather than asking github.com about a repository it has never had.
  const refFor = (repo: string, ref = ''): SkillRepoRef => {
    const location = splitSkillRepo(repo)
    if (!location) return { owner: '', repo: '', ref }
    const base = { owner: location.owner, repo: location.name, ref }
    if (location.ssh) return { ...base, host: location.host, ssh: location.ssh }
    return location.host === DEFAULT_SKILL_REPO_HOST ? base : { ...base, host: location.host }
  }
  return {
    resolveCommit: (repo, ref) => resolveSkillRepoCommit(refFor(repo, ref), github),
    // Exactly what `fetchSkillRepoTree` returned: the entries, and the caps and
    // the truncation refusal that came with them.
    readTree: (repo, sha) => fetchSkillRepoTree(refFor(repo), sha, github).then((tree) => tree.entries),
    readFile: (repo, sha, path) =>
      fetchSkillRepoFile(refFor(repo), sha, path, github).catch((error: unknown) => {
        if (error instanceof SkillFetchError && error.statusCode === 404) return null
        throw error
      }),
  }
}

/**
 * `followLinkedPlugins`'s reader, over whichever transport this build uses.
 *
 * Its whole job besides reading is to sort failures into "this minute" and
 * "this repository", because the follow stops the entire pass on the first of
 * the former and carries on past the latter. Over the API a `SkillFetchError`
 * carrying NO status code is a request that never reached GitHub at all — the
 * machine is offline, DNS failed, the fetch timed out — and calling that
 * "unreadable" would tell somebody on a train that 238 repositories are gone.
 * Over git the reader says which it is on its own error (`kind`), and only
 * 'offline' and 'timeout' are facts about the minute; a rate limit is not one
 * of git's problems at all.
 */
function linkedPluginReaderOver(context: RepoContext): LinkedPluginRepoReader {
  const { reader, transport } = context
  const rethrow = (error: unknown): never => {
    throw new LinkedPluginReadError(describeFetchError(error), linkedFailureKind(error, transport))
  }
  return {
    resolveCommit: (repo, ref) => reader.resolveCommit(repo, ref).catch(rethrow),
    readTree: (repo, sha) => reader.readTree(repo, sha).catch(rethrow),
    // A null here is a file the repository does not hold, which the scan treats
    // as an answer. A THROW is a read that failed, and the caller treats it as
    // one: the plugin comes back partly read rather than as a plugin that ships
    // nothing. A run of the live marketplace on 2026-09-06 lost seven MCP
    // servers this way — 172 where two other runs read 179 — out of 386 raw
    // reads.
    //
    // So a failure is tried twice, and the second attempt WAITS. An immediate
    // retry at twenty-wide is what turns throttling into more throttling, which
    // GitHub's own guidance says not to do; `retry-after` is honoured when the
    // reply carried one and is capped, because a plugin's manifest is not worth
    // holding a scan open for a minute.
    readFile: async (repo, sha, path) => {
      const read = (): Promise<string | null> =>
        reader.readFile(repo, sha, path).then((bytes) => bytes?.toString('utf8') ?? null)
      return read().catch(async (error: unknown) => {
        const wait = retryDelayMs(error)
        if (wait === null) return null
        await new Promise((resolve) => setTimeout(resolve, wait))
        return read().catch(() => null)
      })
    },
  }
}

/**
 * A file the caller cannot do without. The readers answer null for a path a
 * repository does not hold, and every one of these asks for a path a tree
 * listing already named — so null here is a repository that changed under the
 * scan, and saying which file beats handing back an empty install.
 */
function requiredBytes(bytes: Buffer | null, repo: string, path: string): Buffer {
  if (bytes) return bytes
  throw new SkillFetchError(`${path} is no longer in ${repo}.`)
}

/**
 * How long to wait before the one retry, or null for "do not retry".
 *
 * A refusal that names a reset further away than this is not worth waiting for
 * on a single component file: the pass has bigger problems, and the plugin is
 * better reported as partly read than kept open for a minute. A failure with no
 * rate-limit headers at all is the ordinary blip the retry exists for.
 */
const MAX_RAW_RETRY_WAIT_MS = 2_000

function retryDelayMs(error: unknown): number | null {
  if (!(error instanceof SkillFetchError)) return 250
  if (error.statusCode === 404) return null
  const hint = error.rateLimit
  if (!hint?.exhausted) return 250
  const after = hint.retryAfterSeconds * 1000
  return after > 0 && after <= MAX_RAW_RETRY_WAIT_MS ? after : null
}

/**
 * Fill in each skill's frontmatter — name, description, declared tools, and the
 * optional license, compatibility and metadata the Agent Skills specification
 * defines — from its entry document. A skill whose entry cannot be read keeps
 * its directory name and an empty description — an honest blank, never invented
 * copy.
 *
 * An entry that WAS read and declares no `description` is not a skill at all
 * (https://agentskills.io/specification, fetched 2026-09-06), so it is left out
 * of `skills` and counted. "Read" is the load-bearing word: an entry the reader
 * could not fetch, or that sat past `MAX_ENRICHED_SKILLS`, was never seen, and
 * nothing is dropped for a document nobody read. A zero-byte SKILL.md IS read,
 * and declares no description.
 *
 * `all` carries every directory the tree held, enriched, skipped ones included.
 * The plugin scan matches its manifests against that list: a plugin naming a
 * directory that shipped and was read must not be told the directory is
 * missing, which is what handing it the filtered list did.
 */
async function enrichSkills(
  skills: readonly ScannedSkill[],
  readEntry: (skill: ScannedSkill) => Promise<string | null>,
): Promise<{ all: ScannedSkill[]; skills: ScannedSkill[]; skippedNoDescription: number }> {
  const enriched = [...skills]
  const skipped = new Set<number>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, enriched.length) }, async () => {
    while (cursor < enriched.length && cursor < MAX_ENRICHED_SKILLS) {
      const index = cursor
      cursor += 1
      // null is "not read"; '' is a document that exists and says nothing.
      const raw = await readEntry(enriched[index]).catch(() => null)
      if (raw === null) continue
      const frontmatter = parseSkillFrontmatter(raw)
      if (frontmatter.description === '') {
        skipped.add(index)
        continue
      }
      enriched[index] = {
        ...enriched[index],
        name: frontmatter.name || enriched[index].name,
        description: frontmatter.description,
        allowedTools: frontmatter.allowedTools,
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
      }
    }
  })
  await Promise.all(workers)
  return {
    all: enriched,
    skills: enriched.filter((_, index) => !skipped.has(index)),
    skippedNoDescription: skipped.size,
  }
}

function joinRepoPath(skillId: string, relativePath: string): string {
  return skillId === '' ? relativePath : `${skillId}/${relativePath}`
}

/**
 * `resources/studio-plugin` in this build — the marketplace we publish, bundled.
 * Packaged it lands beside the other extraResources as `studio-plugin`; in a
 * dev run it is read out of the checkout.
 */
function defaultStudioMarketplaceSeedRoot(): string | null {
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, STUDIO_MARKETPLACE_RESOURCE_DIR)] : []),
    join(process.cwd(), 'resources', STUDIO_MARKETPLACE_RESOURCE_DIR),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Round-trips as UTF-8 and carries no NUL — the cheap, exact "is this text". */
function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return Buffer.compare(Buffer.from(bytes.toString('utf8'), 'utf8'), bytes) === 0
}

/**
 * A skill removed from the workspace is also dropped from every plugin receipt
 * that named it, so Remove on the plugin still knows what is left — and a
 * receipt that holds nothing is taken back, including the plugin directory
 * and any Claude settings key.
 */
async function pruneSkillFromPluginReceipts(
  installs: PluginInstallStore,
  workspaceRoot: string,
  dirName: string,
): Promise<void> {
  const records = await installs.list(workspaceRoot)
  for (const record of records) {
    if (!record.skillDirNames.includes(dirName)) continue
    const skillDirNames = record.skillDirNames.filter((name) => name !== dirName)
    if (skillDirNames.length === 0 && record.mcpServerIds.length === 0) {
      await uninstallPlugin({
        workspaceRoot,
        pluginId: record.pluginId,
        marketplaceName: record.marketplaceName,
        skillDirNames: [],
        pluginDirName: record.pluginDirName ?? '',
        allHarnesses: SKILL_PACK_HARNESSES,
      })
      await installs.remove(workspaceRoot, record.sourceId, record.pluginId)
      continue
    }
    await installs.put({ ...record, skillDirNames })
  }
}

/**
 * Which of the three a read failure is — see `linkedPluginReaderOver`.
 *
 * The headers decide, not the status. GitHub answers 403 both for a spent hour
 * and for a repository that is private, DMCA-blocked or behind an org's SSO,
 * and reading every 403 as a rate limit halted the pass on a repository that
 * will never answer — which, because a halted group stays pending and pending
 * groups are never demoted, was picked first on the next scan and halted that
 * one too, so the follow could never finish (linked-plugins review,
 * 2026-09-06).
 */
function linkedFailureKind(error: unknown, transport: SkillRepoTransport): 'rate-limited' | 'offline' | 'unreadable' {
  if (transport === 'git') {
    // The git reader names the kind itself. A throttle from the git host is
    // a fact about the minute exactly as the API's was, so it halts the pass
    // and leaves the rest pending; a timeout is a fact about ONE repository —
    // a slow tree, not a dead network — so it is that repository's verdict and
    // the pass carries on (review, 2026-09-09: one 60 s fetch used to mark
    // two hundred repositories "GitHub could not be reached").
    const kind = (error as { kind?: unknown } | null)?.kind
    if (kind === 'rate-limited') return 'rate-limited'
    if (kind === 'offline') return 'offline'
    return 'unreadable'
  }
  if (!(error instanceof SkillFetchError)) return 'unreadable'
  if (error.rateLimit?.exhausted === true) return 'rate-limited'
  return error.statusCode === undefined ? 'offline' : 'unreadable'
}

function describeFetchError(error: unknown): string {
  if (error instanceof SkillFetchError) return error.message
  return error instanceof Error ? error.message : String(error)
}

type InstalledPluginRecordShape = import('../../shared/electron-api').InstalledPluginRecord

function describeSourceBlurb(name: string, skills: number, plugins: number, servers: number): string {
  const parts: string[] = []
  if (plugins > 0) parts.push(`${plugins} ${plugins === 1 ? 'plugin' : 'plugins'}`)
  if (servers > 0) parts.push(`${servers} MCP ${servers === 1 ? 'server' : 'servers'}`)
  if (skills > 0) parts.push(`${skills} ${skills === 1 ? 'skill' : 'skills'}`)
  return parts.length > 0 ? `${parts.join(', ')} from ${name}.` : `Nothing installable found in ${name}.`
}
