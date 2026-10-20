import { app, ipcMain, protocol, session, shell } from 'electron'
import { buildStamp as mainBuildStamp } from 'virtual:sprintengine-build-stamp'
import { MODULE_EVENTS_CHANNEL } from '../shared/modules/events'
import { MODULE_NOTIFICATIONS_CHANNEL } from '../shared/modules/notifications'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { ensureExtensionFolders } from './extension-folders'
import { raiseConnectAttemptTimeout } from './network-defaults'
import type { ModuleEnablementLiveApplier } from './ipc/module-enablement-ipc'
import { activeForChannel } from '../shared/modules/dev-only'
import { resolveModuleEnablement } from '../shared/modules/resolve'
import { loadMainModules } from './module-host/load-modules'
import { readModuleOverridesSync } from './module-host/enablement-store'
import { ScheduledAgentsServiceToken } from './module-host/service-tokens'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from './modules/agent-runtime-module'
import { LIVE_ENABLED_MODULE_IDS, type CapabilityManifest } from '../shared/modules/manifest'
import { createBundledMainModules } from './modules'
import { isLoadEligible, type ModuleTrustContext } from './modules/module-signature'
import { readModuleTrustContextSync } from './modules/trust-context'
import {
  decodeThirdPartyLaunchSession,
  encodeThirdPartyLaunchSession,
  planThirdPartyMainModules,
  readThirdPartyMainLaunchSnapshot,
  recordThirdPartyMainLaunchReport,
} from './modules/third-party-main-loader'
import { registerAppRestartIpc } from './ipc/app-restart-ipc'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { MODULE_ASSET_SCHEME } from '../shared/modules/assets'
import { createModuleAssetOriginResolver } from './modules/module-asset-origins'
import { createModuleAssetHandler, isAllowedModuleAssetRequest } from './modules/module-assets'
import { registerThirdPartyRendererEntryIpc } from './modules/third-party-renderer-entries'
import { defaultUserModuleRoot, discoverUserModules, discoverUserModulesSync } from './modules/user-module-registry'
import { attachBuildSkewWatch, createBuildSkewWatch } from './build-skew'
import { registerCoreIpc } from './register-core-ipc'
import { markStartup } from './startup-timeline'
import { readStudioEnv } from '../shared/studio-env'
import { allowsMultipleInstances } from './app-instance'
import { writeDiagnosticLog } from './diagnostics-service'
import { removeRetiredEntitlementCache } from './retired-entitlement-cache'
import { removeRetiredRelayState } from './retired-relay-state'
import { applyHostApiGate } from './modules/host-api-gate'
import { studioPlatform } from '../server/platform/platform'
import { SERVER_EVENTS, SERVER_METHODS } from '../server/desktop/server-methods'
import type { AgentPhaseEvent } from '../shared/agent-runtime'
import {
  readServerMode,
  SERVER_FALLBACK_ARGUMENT,
  setSessionServerMode,
  takeServerFallbackNote,
  writeServerFallbackNote,
  writeServerMode,
} from './server-mode'
import {
  readSavedSshPreview,
  readSshPreview,
  setSessionSshPreview,
  writeSshPreview,
} from './environments/ssh/ssh-preview'
import { SSH_PREVIEW_CHANNELS, type SshPreviewStatus } from '../shared/ssh-preview'
import { registerStudioServerIpc } from './ipc/studio-server-ipc'
import { STUDIO_SERVER_CHANNELS } from '../shared/studio-server-status'
import { createDesktopServerHost } from './server-supervisor/desktop-server-host'
import { channelForVersion } from './update-channel-store'
import { createDefaultMarketplaceRegistryClient } from './ipc/marketplace-registry-ipc'
import { toThirdPartyModuleView } from './ipc/third-party-module-ipc'

/** How long the boot's workspace pass waits for the Studio server out of process. */
const BOOT_SERVER_WAIT_MS = 15_000

// The app proper, loaded by the entry (index.ts) only in the process that holds
// the single-instance lock. By the time this runs the startup timeline is
// attached, the userData override is applied, the Electron platform is
// installed and the module-asset scheme is registered.

// Build-identity check. Registered next to the startup marks and for
// the same reason: a window reports the moment it starts, and the listener has
// to already be there. Log-only by explicit choice (2026-09-01): the dialog
// this used to raise interrupted the normal edit-the-running-app dev loop, so
// a skew now lands on the log (`[build-skew]`, greppable) and nowhere else.
attachBuildSkewWatch(ipcMain, createBuildSkewWatch({ mainStamp: mainBuildStamp }))

// Make the drop-in extension roots discoverable on a fresh (packaged) install:
// create ~/.sprintengine/{modules,plugins} and seed each with a README describing
// what to drop there. Best-effort — never block startup on it.
const extensionFolders = ensureExtensionFolders()

// Before anything here fetches: a slow IPv4 host behind an IPv6 address with
// no route answers within a second, not Node's quarter-second.
raiseConnectAttemptTimeout()

const DIAGNOSTICS_ENABLED = readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'

// Where the Studio server runs this session: in this process, the default, or
// in a utility process of its own (phase 6). Decided once, here, before any
// service is built, so every store has one writer for the whole session.
const serverMode = readServerMode(app.getPath('userData'))
setSessionServerMode(serverMode.mode)
// SSH machines, a preview until phase 8 is complete: off by default, and
// with it off no SSH code runs. Fixed for the session, like the server mode.
const sshPreview = readSshPreview(app.getPath('userData'))
setSessionSshPreview(sshPreview.enabled)
// A launch that follows one whose server could not start says why, once.
const serverFellBack =
  serverMode.source === 'fallback'
    ? (takeServerFallbackNote(app.getPath('userData')) ?? 'The Studio server could not start.')
    : null
const serverHost =
  serverMode.mode === 'out-of-process'
    ? createDesktopServerHost({
        buildStamp: mainBuildStamp.commit,
        diagnosticsEnabled: DIAGNOSTICS_ENABLED,
        version: app.getVersion(),
        channel: channelForVersion(app.getVersion()) === 'nightly' ? 'nightly' : 'latest',
      })
    : null
if (serverHost) {
  console.info(`[studio-server] out of process (${serverMode.source})`)
}
const services = createAppServices(DIAGNOSTICS_ENABLED, serverHost?.link ?? null)
let applyModuleEnablementLive: ModuleEnablementLiveApplier | undefined

// Dev-only capability surfaces (none today) ship only in
// from-source dev builds. A packaged/installed build is the production channel,
// so they are excluded from registration entirely. See
// src/shared/modules/dev-only.ts.
const includeDevModules = !app.isPackaged

const coreIpc = registerCoreIpc(ipcMain, services, DIAGNOSTICS_ENABLED, {
  applyModuleEnablementLive: (overrides) => applyModuleEnablementLive?.(overrides),
  // Which third-party main halves this session loaded: the server's, out of
  // process, where they run; otherwise this process's own. Read only when
  // Settings lists the modules, long after `moduleLoad` below exists.
  readThirdPartyLaunchSession: async () =>
    decodeThirdPartyLaunchSession(
      serverHost
        ? await serverHost.supervisor.call(SERVER_METHODS.thirdPartyLaunchSession)
        : encodeThirdPartyLaunchSession(readThirdPartyMainLaunchSnapshot(), moduleLoad.kernel.mcpToolRegistrations()),
    ),
  ...(serverHost
    ? {
        server: {
          studioConnections: { connectPort: (port) => serverHost.connectStudioPort(port) },
          discoverModels: (input) =>
            serverHost.supervisor.call(SERVER_METHODS.discoverModels, input, { timeoutMs: 120_000 }),
          // A long chat is tens of megabytes, its pictures more.
          readChatExportSource: (key) =>
            serverHost.supervisor.call(SERVER_METHODS.conversationExportSource, key, { timeoutMs: 120_000 }),
        },
      }
    : {}),
})

// Capability modules register their own IPC/services/sidecars through the host
// kernel, gated by the user's enablement overrides (mirrored from the renderer
// into userData). A disabled module skips registration entirely. The
// agent-runtime core module seeds the shared services (terminal runtime, auth,
// token stores) that the optional modules consume via the service bridge; the
// resolver orders it first because every dependent declares
// `dependsOn: ['agent-runtime']`. See docs/module-authors/drop-in-extensions.md.
const moduleOverrides = readModuleEnablementOverrides()

const thirdPartyMainLoad = planThirdPartyMainModules(
  discoverUserModulesSync(defaultUserModuleRoot(), readModuleTrustContext()),
)
// ── extension-platform additions ──
// A module built for another host API stays unloaded whatever its trust says,
// and the load report says why (modules/host-api-gate.ts).
applyHostApiGate(thirdPartyMainLoad.ineligible, thirdPartyMainLoad.modules)
// Live-resolved main enablement, kept in step with the renderer's overrides (see
// recomputeMainEnablement below). A module with no main runtime of its own — one
// whose work rides another module's engine tick — is honored through this set
// rather than through load/unload, so its toggle (and its dependency cascade)
// takes effect without a reload. Declared before module construction so the
// predicate can close over it; the set is filled in once the manifest list exists.
const enabledMainModuleIds = new Set<string>()
const activeMainModules = activeForChannel(
  // Read only once a module asks, by which time `getModulePermissions` exists.
  createBundledMainModules(studioPlatform(), (moduleId): readonly string[] | undefined =>
    getModulePermissions(moduleId),
  ),
  (module) => module.manifest.id,
  includeDevModules,
)
// Resolves any module id to the permissions it declared in its manifest, across
// every module the app assembled. The companion registry gates attach on it.
const moduleManifestsById = new Map<string, CapabilityManifest>(
  [
    AGENT_RUNTIME_MANIFEST,
    ...activeMainModules.map((module) => module.manifest),
    ...thirdPartyMainLoad.modules.map((module) => module.manifest),
  ].map((manifest) => [manifest.id, manifest]),
)
const getModulePermissions = (moduleId: string): readonly string[] | undefined =>
  moduleManifestsById.get(moduleId)?.permissions
// Extracted as a const (rather than inlined) so `mainModuleManifests` below can
// reference its manifest for the enablement gate; constructed after
// `getModulePermissions` so the companion-attach permission check is wired in.
const agentRuntimeModule = createAgentRuntimeModule(services, {
  getModulePermissions,
  platform: studioPlatform(),
  // A module's prompt that names no runtime answers on the person's choice.
  getTextGenerationSettings: () => services.studioCore.textGenerationSettings.get(),
})
// Out of process every module's server half loads in the server
// (src/server/desktop/server-modules.ts); the shell loads none and keeps an
// empty kernel for the renderer-entry channel, which is the shell's.
const moduleLoad = loadMainModules({
  ipcMain,
  modules: serverHost ? [] : [agentRuntimeModule, ...activeMainModules, ...thirdPartyMainLoad.modules],
  overrides: moduleOverrides,
  // Skill directories a third-party module registers are resolved against —
  // and must stay inside — its install folder.
  moduleRoots: thirdPartyMainLoad.moduleRoots,
  // What `getAssetPath` resolves: the files each module was verified with.
  moduleVerifiedFiles: thirdPartyMainLoad.verifiedFiles,
  ineligible: thirdPartyMainLoad.ineligible,
  launchErrors: thirdPartyMainLoad.launchErrors,
  // Module events fan out to every open window on the one host-owned channel;
  // the renderer kernel routes each envelope to its own module's subscribers.
  // Nothing is buffered for windows opened later — see shared/modules/events.ts.
  deliverModuleEvent: (event) => studioPlatform().clients.publish(MODULE_EVENTS_CHANNEL, event),
  // A module's notify is a bell row in every window, over the same client bus;
  // the kernel keeps the recent ones for a window that opens later.
  deliverModuleNotification: (notification) =>
    studioPlatform().clients.publish(MODULE_NOTIFICATIONS_CHANNEL, notification),
  // A module tool that would shadow one of the gateway's own is refused at
  // registration, naming the tool it collides with.
  coreMcpToolNames: () => services.automationService?.coreToolNames() ?? [],
})
// The manifest universe the enablement gate resolves against — every main module
// present on this channel, so a module and its dependencies (scheduled agents,
// agent-runtime) all resolve. Recompute mirrors the renderer's
// resolution so the gate's answer matches what the user sees in Settings.
const mainModuleManifests = [
  agentRuntimeModule.manifest,
  ...activeMainModules.map((module) => module.manifest),
  ...thirdPartyMainLoad.modules.map((module) => module.manifest),
]
const recomputeMainEnablement = (overrides: Record<string, boolean>): void => {
  const { order } = resolveModuleEnablement(mainModuleManifests, overrides)
  enabledMainModuleIds.clear()
  for (const id of order) enabledMainModuleIds.add(id)
}
recomputeMainEnablement(moduleOverrides)
applyModuleEnablementLive = async (overrides) => {
  // Out of process the server's kernel applies it; this process wrote the file.
  if (serverHost) {
    recomputeMainEnablement(overrides)
    return serverHost.supervisor.call(SERVER_METHODS.applyModuleEnablement, { overrides })
  }
  const report = await moduleLoad.applyEnablement(overrides, { liveModuleIds: LIVE_ENABLED_MODULE_IDS })
  // A module with no live-loadable main half takes its toggle through the
  // enablement gate rather than module load/unload — refresh the resolved set.
  // The rest of the change was applied even when one module's half failed,
  // so the gate follows it either way.
  recomputeMainEnablement(overrides)
  // Module-contributed gateway tools follow enablement live: the
  // gateway re-reads the registry and enablement per request, so only the
  // connected MCP clients need a nudge to refresh their tool lists.
  services.automationService?.notifyToolsListChanged()
  const scheduledAgentsError = report.errors.find((error) => error.id === 'scheduled-agents')
  if (scheduledAgentsError) return { ok: false, message: scheduledAgentsError.message }
  return { ok: true }
}
// Automation server ← Scheduled agents module: resolved per tool call so a live
// module disable/enable cycle is reflected immediately (service absent ⇒ the
// scheduled-agent tools say the module is off).
services.setScheduledAgentsResolver(
  () => moduleLoad.kernel.hostFor('@host').getService(ScheduledAgentsServiceToken) ?? null,
)
// Module enablement for gateway tools that belong to a capability module: the
// resolved set is recomputed on every override the renderer pushes, so a module
// switched off in Settings is off for MCP callers on their next call, not after
// a restart (an owner ruling).
services.setModuleEnabledResolver((moduleId) => enabledMainModuleIds.has(moduleId))
// Module-contributed MCP tools ← the host kernel. The gateway was
// constructed above, before loadMainModules ran; this seam hands it the live
// registry, and the per-request evaluation makes the tools visible immediately.
services.setModuleMcpToolsResolver(() => moduleLoad.kernel.mcpToolRegistrations())
recordThirdPartyMainLaunchReport(
  thirdPartyMainLoad.modules.map((module) => module.manifest.id),
  moduleLoad.report,
)
const moduleAssetOrigin = createModuleAssetOriginResolver(app.getPath('userData'))
// Trusted third-party entry.renderer bundles are served on demand (the trust
// store is re-read per request, so revoking trust takes effect immediately).
registerThirdPartyRendererEntryIpc(moduleLoad.kernel.hostFor('@host'), {
  discoverModules: () => discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
  trustContext: readModuleTrustContext,
  assetOrigin: moduleAssetOrigin,
})
void app.whenReady().then(() => {
  // The hosted relay's leftover pairings and push tokens (retired-relay-state.ts).
  // Best effort and off the startup path; tailnet pairings are never touched.
  void removeRetiredRelayState(app.getPath('userData')).then((result) => {
    if (result.outcome === 'absent') return
    void writeDiagnosticLog(
      result.outcome === 'removed'
        ? {
            level: 'info',
            source: 'auth',
            title: 'Removed the hosted relay pairings',
            message: `The phone now pairs over Tailscale only. Deleted the relay's stored state: ${result.relayPairings} relay pairing(s) and ${result.pushRegistrations} push registration(s). Tailnet pairings were not touched.`,
          }
        : {
            level: 'warning',
            source: 'auth',
            title: 'Could not remove the hosted relay pairings',
            message: `The retired relay's state file is still in userData: ${result.message}`,
          },
    ).catch(() => {})
  })
  // The cached entitlement snapshot from when there was a paywall
  // (retired-entitlement-cache.ts). Best effort; the sign-in is never touched.
  void removeRetiredEntitlementCache(app.getPath('userData')).then((result) => {
    if (result.outcome === 'failed') {
      console.warn('[auth] retired-entitlement-cache-remove-failed', { message: result.message })
    }
  })
  const shellUrl = process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${MODULE_ASSET_SCHEME}://*/*`] }, (details, callback) => {
    callback({ cancel: !isAllowedModuleAssetRequest(details, shellUrl) })
  })
  protocol.handle(
    MODULE_ASSET_SCHEME,
    createModuleAssetHandler({
      assetOrigin: moduleAssetOrigin,
      discoverModules: () => discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
      isEnabled: (installed, modules) => {
        const trusted = modules.filter((module) => isLoadEligible(module.trust.status))
        const manifests = [
          ...mainModuleManifests.filter((manifest) => !modules.some((module) => module.manifest.id === manifest.id)),
          ...trusted.map((module) => module.manifest),
        ]
        return resolveModuleEnablement(manifests, readModuleEnablementOverrides()).order.includes(installed.manifest.id)
      },
    }),
  )
})
if (DIAGNOSTICS_ENABLED) {
  console.info('[modules] extension roots:', extensionFolders.moduleRoot, extensionFolders.pluginRoot)
  if (extensionFolders.errors.length > 0) {
    console.warn('[modules] extension folder setup errors:', extensionFolders.errors)
  }
  console.info(
    '[modules] loaded:',
    moduleLoad.report.loaded,
    'manifest-only:',
    moduleLoad.report.manifestOnly,
    'disabled:',
    moduleLoad.report.disabled,
    'sidecars:',
    moduleLoad.report.sidecars.map((s) => s.id),
  )
  if (moduleLoad.report.errors.length > 0) {
    console.warn('[modules] load errors:', moduleLoad.report.errors)
  }
  if (thirdPartyMainLoad.diagnostics.rejected.length > 0) {
    console.warn('[modules] rejected third-party modules:', thirdPartyMainLoad.diagnostics.rejected)
  }
}

function readModuleEnablementOverrides(): Record<string, boolean> {
  try {
    return readModuleOverridesSync(app.getPath('userData'))
  } catch {
    return {}
  }
}

function readModuleTrustContext(): ModuleTrustContext {
  return readModuleTrustContextSync(app.getPath('userData'))
}

// Everything above ran synchronously during entry evaluation: module
// construction, sync user-module discovery, IPC registration. This mark closes
// that phase, so a slow module registration shows up as its own segment rather
// than hiding inside "app ready".
markStartup('main.module-evaluated')

// The server's phase in words for every window, the Advanced toggle and the
// actions on it: registered in process too, where the toggle is all there is.
const relaunchApp = (args: string[] = []): void => {
  app.relaunch({ args: [...process.argv.slice(1).filter((arg) => arg !== SERVER_FALLBACK_ARGUMENT), ...args] })
  // A restart the person asked for in Settings, or the server's fallback: the
  // app comes straight back, so it is not a quit to ask about.
  services.quitConfirmation.quitWithoutAsking()
  app.quit()
}
// Settings → Extensions' "Restart now": a restart the person asked for, so it
// is asked about the way their own quit is when agents are working.
registerAppRestartIpc(ipcMain, {
  confirm: () => services.quitConfirmation.confirm(),
  relaunch: () => relaunchApp(),
})
// The SSH machines switch: answered whether or not this session has them.
const sshPreviewStatus = (): SshPreviewStatus => ({
  enabled: sshPreview.enabled,
  saved: sshPreview.fromEnvironment ? sshPreview.enabled : readSavedSshPreview(app.getPath('userData')),
  fromEnvironment: sshPreview.fromEnvironment,
})
ipcMain.handle(SSH_PREVIEW_CHANNELS.get, () => sshPreviewStatus())
ipcMain.handle(SSH_PREVIEW_CHANNELS.set, (_event, payload: unknown) => {
  const enabled = (payload as { enabled?: unknown } | null)?.enabled
  if (typeof enabled === 'boolean' && !sshPreview.fromEnvironment) writeSshPreview(app.getPath('userData'), enabled)
  return sshPreviewStatus()
})
registerStudioServerIpc(ipcMain, {
  choice: serverMode,
  supervisor: serverHost?.supervisor ?? null,
  fellBack: serverFellBack,
  readSavedMode: () => readServerMode(app.getPath('userData'), {}, []).mode,
  writeSavedMode: (mode) => writeServerMode(app.getPath('userData'), mode),
  openLog: async () => {
    const path = serverHost?.log.currentPath() ?? app.getPath('logs')
    return (await shell.openPath(path)) === ''
  },
  relaunch: ({ compatibility }) => {
    if (compatibility) writeServerMode(app.getPath('userData'), 'in-process')
    relaunchApp()
  },
  publish: (status) => studioPlatform().clients.publish(STUDIO_SERVER_CHANNELS.changed, status),
})

if (serverHost) {
  // Three failed boots with no server ever ready: this session goes on in
  // process (decision O9), by starting again in process at once, never by
  // building a second writer mid-session. The next ordinary launch tries the
  // separate process again; the fallback launch says why, in words.
  let fellBack = false
  serverHost.supervisor.onState((state) => {
    if (fellBack || state.kind !== 'failed' || !state.neverReady) return
    fellBack = true
    writeServerFallbackNote(app.getPath('userData'), state.reason)
    relaunchApp([SERVER_FALLBACK_ARGUMENT])
  })
  // What the server asks of the shell: the keychain, notices, terminal
  // launches, the integrations gate, and the two caches only the shell keeps.
  serverHost.serveShell(services.shellBridge, {
    marketplaceRead: (input) => createDefaultMarketplaceRegistryClient().read(input as never),
    thirdPartyModules: async () => {
      const { modules, rejected } = await discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext())
      return { modules: modules.map((module) => toThirdPartyModuleView(module)), rejected }
    },
  })
  // A restarted server starts without the renderer's module registry; it is sent again.
  serverHost.supervisor.onReady(() => {
    const snapshot = services.moduleRegistryMirror.read()
    if (snapshot) serverHost.link.rpc.emit(SERVER_EVENTS.moduleRegistrySnapshot, snapshot)
  })
}

registerAppLifecycle({
  diagnosticsEnabled: DIAGNOSTICS_ENABLED,
  allowMultipleInstances: allowsMultipleInstances(app),
  terminalRuntime: services.terminalRuntime,
  conversations: services.conversations,
  conversationOwner: services.conversationOwner,
  automationService: services.automationService ?? undefined,
  studioRpcService: services.studioRpcService ?? undefined,
  agentStateService: services.agentStateService,
  workspaceSyncService: services.workspaceSyncService,
  removeSessionIntegrations: services.removeSessionIntegrations,
  releaseDataDir: () => (serverHost ? undefined : services.studioCore.dataDirLock?.release()),
  canvasService: services.canvasService,
  worktreePool: services.worktreePool,
  dependencyInstaller: services.dependencyInstaller,
  browserRecorder: services.browserRecorder,
  desktopShell: serverHost ? services.desktopShell : null,
  conversationCommands: coreIpc.conversationCommands,
  onAgentAttentionReady: (attention) => services.setTourAttention((key) => attention.notify(key)),
  agentNotifier: services.agentNotifier,
  onChatLinksReady: (open) => services.setChatLinkOpener(open),
  pullRequestRecord: services.pullRequestRecord,
  ...(services.localServers ? { localServers: services.localServers } : {}),
  ...(services.usageLimitResumes ? { usageLimitResumes: services.usageLimitResumes } : {}),
  ...(services.scheduledMessages ? { scheduledMessages: services.scheduledMessages } : {}),
  analytics: services.analytics,
  // Out of process the server runs every module's startup and shutdown hooks.
  ...(serverHost ? {} : { moduleKernel: moduleLoad.kernel }),
  updateService: services.updateService,
  checkPluginSourceUpdates: () => services.skillsService.checkSourceUpdates(),
  startDeferredBootJobs: services.startDeferredBootJobs,
  // Out of process the workspaces to prepare arrive with the server's first
  // snapshot; the pass waits for it, inside the same boot budget.
  prepareWorkspacesAtBoot: serverHost
    ? () =>
        serverHost.link
          .whenServing(BOOT_SERVER_WAIT_MS)
          .then(() => serverHost.mirror.whenLoaded())
          .then(() => services.prepareWorkspacesAtBoot())
    : services.prepareWorkspacesAtBoot,
  ...(serverHost
    ? {
        server: {
          start: () => serverHost.start(),
          shutdown: (options) => serverHost.shutdown(options),
          log: serverHost.log,
          onAttentionPhase: (listener) =>
            void serverHost.link.rpc.on(SERVER_EVENTS.attentionPhase, (event) => listener(event as AgentPhaseEvent)),
        },
      }
    : {}),
  backgroundMode: {
    isEnabled: () => services.backgroundModeStore.isEnabled(),
    readStatus: () => services.readBackgroundStatus(),
  },
  quitConfirmation: services.quitConfirmation,
  agentKeepAwake: services.agentKeepAwake,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.sprintengineAuth, argv)
  },
  chatWindows: {
    holderOf: (chatId) =>
      services.workspaceSyncService
        .getSnapshot()
        .state.workspaceWindows.find((windowState) => windowState.workspaceIds.includes(chatId))?.id ?? null,
    primaryWindowId: () => services.workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId,
  },
  // ── extension-platform additions ──
  ...(serverHost ? {} : { moduleLoadReady: moduleLoad.ready }),
})
