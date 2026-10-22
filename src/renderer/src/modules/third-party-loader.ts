import * as MonacoReact from '@monaco-editor/react'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'

import {
  BUNDLED_MODULE_IDS,
  type CapabilityManifest,
  type ThirdPartyRendererEntriesResult,
} from '../../../shared/modules/manifest'
import { sanitizeEntryMessage } from '../../../shared/modules/entry-messages'
import type { RendererKernel } from './renderer-host'
import { bindSharedSpecifiers } from './shared-specifiers'

// Renderer-side loader for trusted third-party modules' `entry.renderer`
// bundles — the consuming half of the main-side server in
// src/main/modules/third-party-renderer-entries.ts. Trust gating already
// happened in the main process (only isLoadEligible modules with contained
// entries are ever served); this loader's jobs are evaluation, registration
// through the identical `hostFor(manifest.id)` contract bundled modules use,
// and per-module failure isolation: a broken bundle records an error surfaced
// in Settings → Modules and never takes down the renderer or its neighbors.
//
// Like bundled modules, third-party entries register their contributions
// regardless of the enablement toggle — enablement gating happens in the
// consumers (panel factory, workspace-type picker, command pipeline, settings
// rail), which is exactly what makes toggling a module off and on work without
// a reload.

export type ThirdPartyRendererLoadState = { status: 'loaded' } | { status: 'error'; message: string }

const LOAD_FAILURE_FALLBACK = 'entry.renderer bundle failed to load.'

// How long an asynchronous registerRenderer may take. The whole batch waits on
// each module in turn, so one that never settles must not hold the rest.
export const RENDERER_REGISTER_TIMEOUT_MS = 10_000

// A registerRenderer's result, awaited when it is a promise and bounded either
// way; a synchronous return settles at once.
async function settleRegisterRenderer(result: unknown, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`registerRenderer did not settle within ${timeoutMs / 1000}s.`)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([Promise.resolve(result), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// Each id is evaluated at most once per renderer session. New renderer-only
// modules can be added after install/trust; updates and failed evaluations
// require a restart. The module registry signals after a complete load batch.
const loadStates = new Map<string, ThirdPartyRendererLoadState>()

export function getThirdPartyRendererLoadState(moduleId: string): ThirdPartyRendererLoadState | undefined {
  return loadStates.get(moduleId)
}

// ── Shared React runtime ─────────────────────────────────────────────────────
//
// The SDK contract (packages/module-sdk README) has authors bundle
// `entry.renderer` as a single-file ESM bundle with React marked external, so
// the bundle still contains bare `import … from 'react'` statements. Module
// contributions render inside the app's React tree, so they MUST resolve to
// the app's own React instance (a second copy breaks hooks/context). We bridge
// the bare specifiers to generated blob modules re-exporting the app's
// instances, by rewriting each such import in the bundle to its shim's URL
// before the bundle is imported (shared-specifiers.ts). An import map would be
// an inline script, which the window's Content-Security-Policy does not run.

// React is eager because the app is already holding it, and so is the Monaco
// wrapper: Monaco is loaded as the renderer boots (utils/monacoRuntime.ts), so
// a module's `import { DiffEditor } from '@monaco-editor/react'` reaches the
// same wrapper the app's editors use, already configured with the bundled
// Monaco — a module can never start a second, CDN-loaded copy. The UI kit and
// the door shell are bridged the same way (D6) so a module renders with the
// app's own components; they are resolved on first third-party load instead,
// because nothing in the shell's first render needs them.
const EAGER_SHARED_MODULE_SPECIFIERS: Record<string, object> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': ReactJsxRuntime,
  '@monaco-editor/react': MonacoReact,
}

// Resolved lazily, in parallel, the first time a third-party entry is loaded.
// The keys are exact bare specifiers, which is what an import map matches on,
// so a module's `import { Banner } from '@sprintengine/module-sdk/ui'` resolves
// without the SDK tarball's runtime stub ever being reached.
const LAZY_SHARED_MODULE_LOADERS: Record<string, () => Promise<object>> = {
  '@sprintengine/module-sdk/ui': () => import('./sdk-ui'),
  '@sprintengine/module-sdk/surface': () => import('./sdk-surface'),
}

const SHARED_RUNTIME_GLOBAL = '__sprintengineSharedModuleRuntime'

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// A blob module can't import from the app bundle, so the shim reaches the live
// namespace through a global the loader installs, then re-exports every named
// export so `import { useState } from 'react'` works as written.
function sharedModuleShimSource(specifier: string, namespace: object): string {
  const exports = Object.keys(namespace)
    .filter((name) => name !== 'default' && IDENTIFIER_PATTERN.test(name))
    .map((name) => `export const ${name} = m[${JSON.stringify(name)}];`)
  return [
    `const m = globalThis[${JSON.stringify(SHARED_RUNTIME_GLOBAL)}][${JSON.stringify(specifier)}];`,
    ...exports,
    'export default m.default ?? m;',
  ].join('\n')
}

let sharedRuntimeInstall: Promise<Record<string, string>> | null = null

// Async because the bridged kit is loaded on demand. The shims are made once,
// when every namespace is in hand, and live as long as the window: a bundle
// imported later points at the same ones.
async function installSharedRuntime(): Promise<Record<string, string>> {
  sharedRuntimeInstall ??= (async () => {
    const namespaces: Record<string, object> = { ...EAGER_SHARED_MODULE_SPECIFIERS }
    const lazy = Object.entries(LAZY_SHARED_MODULE_LOADERS)
    const loaded = await Promise.all(lazy.map(([, load]) => load()))
    lazy.forEach(([specifier], index) => {
      namespaces[specifier] = loaded[index]!
    })
    ;(globalThis as Record<string, unknown>)[SHARED_RUNTIME_GLOBAL] = namespaces
    const urls: Record<string, string> = {}
    for (const [specifier, namespace] of Object.entries(namespaces)) {
      urls[specifier] = URL.createObjectURL(
        new Blob([sharedModuleShimSource(specifier, namespace)], { type: 'text/javascript' }),
      )
    }
    return urls
  })()
  return sharedRuntimeInstall
}

// ── Bundle evaluation ────────────────────────────────────────────────────────

export type ThirdPartyEntryImporter = (code: string) => Promise<unknown>

// Bundle content arrives over IPC and is evaluated via dynamic import of a
// blob URL — no file:// or custom-protocol exposure of the module root.
const importEntryBundle: ThirdPartyEntryImporter = async (code) => {
  const bound = bindSharedSpecifiers(code, await installSharedRuntime())
  const url = URL.createObjectURL(new Blob([bound], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function recordError(id: string, message: string): void {
  loadStates.set(id, {
    status: 'error',
    message: sanitizeEntryMessage(message, LOAD_FAILURE_FALLBACK),
  })
}

const RESERVED_IDS: ReadonlySet<string> = new Set(BUNDLED_MODULE_IDS)

/** Never hot-load one half of a module whose main/preload needs a restart. */
export function rendererEntriesForRefresh(served: ThirdPartyRendererEntriesResult): ThirdPartyRendererEntriesResult {
  return {
    entries: served.entries.filter(
      (entry) => !entry.manifest.entry?.main && !entry.manifest.entry?.preload && !loadStates.has(entry.id),
    ),
    failures: Object.fromEntries(Object.entries(served.failures).filter(([id]) => !loadStates.has(id))),
  }
}

// Evaluates every served entry and registers its contributions. Returns the
// manifests of the modules that loaded *cleanly* — only those join the
// enablement-resolution universe, so a module that failed mid-registration is
// gated off everywhere instead of surfacing half its contributions.
export async function loadThirdPartyRendererEntries(
  kernel: RendererKernel,
  served: ThirdPartyRendererEntriesResult,
  importEntry: ThirdPartyEntryImporter = importEntryBundle,
  registerTimeoutMs: number = RENDERER_REGISTER_TIMEOUT_MS,
): Promise<CapabilityManifest[]> {
  for (const [id, message] of Object.entries(served.failures)) {
    recordError(id, message)
  }

  const loadedManifests: CapabilityManifest[] = []
  for (const entry of served.entries) {
    // Re-check the reserved-id rule at the execution boundary. Reserved ids
    // are publisher-locked: main verifies the first-party signature
    // and stamps `firstPartySigned` on the served entry (the renderer cannot
    // verify signatures itself). Anything reserved WITHOUT the stamp is a
    // bypass upstream and must never shadow a bundled module.
    if (RESERVED_IDS.has(entry.id) && entry.firstPartySigned !== true) {
      recordError(entry.id, `"${entry.id}" is a reserved id, publisher-locked to the first-party signing key.`)
      continue
    }
    if (entry.manifest.id !== entry.id) {
      recordError(entry.id, 'entry.renderer manifest id does not match the served module id.')
      continue
    }
    // Main-side discovery keys modules by folder name, so duplicate ids should
    // never arrive; defensively keep the first definition (matching the
    // resolver's duplicate_id rule) without clobbering its recorded state.
    if (loadStates.has(entry.id)) {
      console.warn(`[ThirdPartyModules] duplicate module id "${entry.id}"; ignoring the later entry.`)
      continue
    }
    try {
      const exports = await importEntry(entry.code)
      const registerRenderer = (exports as { registerRenderer?: unknown } | null)?.registerRenderer
      if (typeof registerRenderer !== 'function') {
        recordError(entry.id, 'entry.renderer must export a registerRenderer(host) function.')
        continue
      }
      if (entry.assetOrigin) kernel.setModuleAssetOrigin(entry.id, entry.assetOrigin)
      // A rejection or a timeout lands in the catch below: the module records
      // an error and stays out of the enablement universe, like a throw.
      await settleRegisterRenderer(registerRenderer(kernel.hostFor(entry.id, entry.manifest)), registerTimeoutMs)
      loadStates.set(entry.id, { status: 'loaded' })
      loadedManifests.push(entry.manifest)
    } catch (error) {
      recordError(entry.id, error instanceof Error ? error.message : String(error))
    }
  }
  return loadedManifests
}
