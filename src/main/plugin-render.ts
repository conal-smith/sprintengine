import { toTomlBasicString } from '../shared/host-context/document'
import {
  CLI_PERMISSION_PRESETS,
  parseCliPermissionPreset,
  type CliPermissionPreset,
} from '../shared/cli-permission-preset'
import {
  parseCliPermissionModeId,
  type CliPermissionModeSpec,
  type CliPermissionSetting,
} from '../shared/cli-permission-mode'
import type {
  PluginArgvToken,
  PluginManifest,
  PluginPermissionPreset,
  PluginRenderContext,
  PluginRenderedCommand,
} from '../shared/plugin-manifest'

// Render a plugin manifest into a concrete spawnable command.
//
// Pure function — no I/O, no globals. Substitutes {{var}} placeholders,
// expands {spread: 'x'} into argv tokens from an array variable, and
// merges manifest env + caller-provided variables.

const SUBSTITUTION_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

export function renderPluginLaunch(manifest: PluginManifest, context: PluginRenderContext): PluginRenderedCommand {
  return renderArgvSpec(manifest, context, manifest.launch.argv, manifest.launch)
}

export function renderPluginResume(
  manifest: PluginManifest,
  context: PluginRenderContext,
): PluginRenderedCommand | null {
  if (!manifest.resume || !manifest.resume.supported) return null
  const argvSpec = manifest.resume.argv ?? manifest.launch.argv
  return renderArgvSpec(manifest, context, argvSpec, manifest.launch)
}

// The reasoning-effort argv tokens a manifest renders for a selected level, or
// an empty array when none should render: when no level is selected, when the
// manifest declares no reasoningSelection, when the level equals the manifest's
// declared default (so ordinary launches stay byte-identical), or when the level
// is outside the declared set (better no flag than a value the CLI can't parse).
// A manifest declaring no `default` therefore renders a flag for every declared
// level, which is how a CLI with an undocumented default effort is modelled.
//
// `scope`, when passed, is the launch's full variable scope: the templates
// substitute against it (and `reasoning` is set on it) exactly as they did
// inline, so a manifest whose effort args reference another variable keeps
// resolving it. Callers outside the manifest render path pass none and get the
// minimal scope their own templates need.
export function renderReasoningArgs(
  manifest: PluginManifest,
  reasoning: string | undefined,
  scope?: Map<string, string | string[] | undefined>,
): string[] {
  const level = reasoning?.trim()
  const selection = manifest.reasoningSelection
  if (
    !level ||
    !selection ||
    selection.args.length === 0 ||
    level === selection.default ||
    !selection.levels.some((declared) => declared.id === level)
  ) {
    return []
  }
  const variables = scope ?? new Map<string, string | string[] | undefined>([['binary', manifest.binary]])
  variables.set('reasoning', level)
  return selection.args.map((template) => substituteString(template, variables))
}

/**
 * The `contextArgs` this launch renders on its own — the tokens a host-context
 * document takes on the command line, measured by the launch planner to decide
 * whether the document fits there.
 */
export function renderPluginContextArgs(manifest: PluginManifest, context: PluginRenderContext): string[] {
  const value = buildVariableScope(manifest, context).get('contextArgs')
  return Array.isArray(value) ? value : []
}

/**
 * The environment a launch whose first message is typed in adds (the manifest's
 * `promptInjection.overflow.env`): whatever keeps a startup prompt from standing
 * between the CLI and its composer, said through the environment. Empty for
 * every other launch, and for a manifest that declares none.
 */
export function renderPluginTypedPromptEnv(
  manifest: PluginManifest,
  context: PluginRenderContext,
): Record<string, string> {
  const spec = manifest.promptInjection?.overflow
  if (context.promptOverflow?.mode !== 'input' || !spec || spec.mode !== 'input' || !spec.env) return {}
  return renderEnv(spec.env, buildVariableScope(manifest, context))
}

function renderArgvSpec(
  manifest: PluginManifest,
  context: PluginRenderContext,
  argvSpec: PluginArgvToken[],
  launchSpec: { cwd?: string; env?: Record<string, string> },
): PluginRenderedCommand {
  const variables = buildVariableScope(manifest, context)
  const argv = expandArgv(argvSpec, variables)
  const cwd = launchSpec.cwd ? substituteString(launchSpec.cwd, variables) : undefined
  // The context env rides the SAME record as `launch.env` because both are
  // "environment this manifest asks for at spawn time", and the caller injects
  // that record once. It is rendered only when a host-context document exists,
  // so a manifest declaring `contextInjection.env` adds nothing to a launch with
  // nothing to say. Resume renders it too: env is not argv, and a resumed
  // session has to be re-told.
  const env = {
    ...renderEnv(launchSpec.env, variables),
    ...renderEnv(contextEnvSpec(manifest, context), variables),
    // A preset told through the CLI's configuration rides the same record.
    ...resolvePermissionPreset(manifest, context.permissionPreset)?.env,
  }
  return { argv, cwd, env }
}

/** True when main resolved a host-context document for this launch. */
function hasHostContext(context: PluginRenderContext): boolean {
  return Boolean(context.contextFile?.trim() || context.contextText?.trim())
}

/**
 * The manifest's `contextInjection.env`, or undefined when it must not render:
 * no document to deliver, or a manifest whose declared mode is not `env`.
 */
function contextEnvSpec(manifest: PluginManifest, context: PluginRenderContext): Record<string, string> | undefined {
  const injection = manifest.contextInjection
  if (!injection || injection.mode !== 'env') return undefined
  if (!hasHostContext(context)) return undefined
  return injection.env
}

// `none` passes no permission flag and lets the CLI's own configuration
// decide, which every CLI can express, so a manifest keys it, if at all, only
// for its label. Every other preset is what the manifest names for it, under
// its own key or the one it had before the rename (`default`,
// `auto_workspace`, `bypass_all`). One the manifest does not name renders no
// flag: passing a flag the CLI does not know is fatal to it, and inventing one
// is worse. The launcher offers a terminal agent only the presets its manifest
// names (`declaredPermissionPresets`).
const LEGACY_PRESET_KEYS: Record<Exclude<CliPermissionPreset, 'none'>, string> = {
  manual: 'default',
  auto: 'auto_workspace',
  bypass: 'bypass_all',
}

// What a launch renders for `requested`, which is a preset or one of the CLI's
// own mode ids (`permissionRenderKey`). A mode the manifest does not hold, or
// holds without a level, falls back to nothing rather than to a guess: the
// caller resolves a mode id beside its preset, and passes the preset when the
// mode is not one this CLI has.
function resolvePermissionPreset(
  manifest: PluginManifest,
  requested: string | undefined,
): PluginPermissionPreset | undefined {
  const own = parseCliPermissionModeId(requested)
  if (own) {
    const entry = Object.hasOwn(manifest.permissionPresets, own) ? manifest.permissionPresets[own] : undefined
    return entry && ownModeLevel(entry) ? entry : undefined
  }
  const preset = parseCliPermissionPreset(requested)
  if (!preset || preset === 'none') return undefined
  return manifest.permissionPresets[preset] ?? manifest.permissionPresets[LEGACY_PRESET_KEYS[preset]]
}

function ownModeLevel(entry: PluginPermissionPreset): CliPermissionPreset | null {
  return entry.level === 'manual' || entry.level === 'auto' || entry.level === 'bypass' ? entry.level : null
}

/**
 * What a launch at `preset` renders from when the CLI's own `mode` was chosen
 * beside it: the mode, when this manifest holds it at that level, else the
 * preset's own mode. A mode another CLI has, or one this CLI no longer
 * declares, never renders as nothing.
 */
export function permissionRenderKey(
  manifest: PluginManifest | undefined,
  preset: CliPermissionPreset,
  mode: string | undefined,
): CliPermissionSetting {
  const own = parseCliPermissionModeId(mode)
  if (!own || !manifest || !Object.hasOwn(manifest.permissionPresets, own)) return preset
  return ownModeLevel(manifest.permissionPresets[own]!) === preset ? own : preset
}

/** The presets a launch of this CLI is told in its own words: `none`, and each one the manifest names. */
export function declaredPermissionPresets(manifest: PluginManifest): CliPermissionPreset[] {
  return CLI_PERMISSION_PRESETS.filter(
    (preset) => preset === 'none' || resolvePermissionPreset(manifest, preset) !== undefined,
  )
}

/**
 * The CLI's permission modes under its own names, in the manifest's order: the
 * mode each named preset stands for, keyed by that preset, and each mode of
 * its own at the level it names. `none` is where the manifest keys it, else
 * last, labelled as passing no flag.
 */
export function declaredPermissionModes(manifest: PluginManifest): CliPermissionModeSpec[] {
  const modes: CliPermissionModeSpec[] = []
  const describe = (entry: PluginPermissionPreset | undefined) => ({
    ...(entry?.summary ? { summary: entry.summary } : {}),
    ...(entry?.description ? { description: entry.description } : {}),
  })
  for (const [key, entry] of Object.entries(manifest.permissionPresets)) {
    if (key === 'none') {
      modes.push({ id: 'none', label: entry.label, level: 'none', ...describe(entry) })
      continue
    }
    const preset = parseCliPermissionPreset(key)
    if (preset) {
      // The entry a launch renders for the preset, so a manifest keying both a
      // preset and its retired spelling lists the one it runs.
      const effective = resolvePermissionPreset(manifest, preset)
      if (effective && !modes.some((mode) => mode.id === preset))
        modes.push({ id: preset, label: effective.label, level: preset, ...describe(effective) })
      continue
    }
    const level = ownModeLevel(entry)
    if (level && parseCliPermissionModeId(key)) modes.push({ id: key, label: entry.label, level, ...describe(entry) })
  }
  if (!modes.some((mode) => mode.id === 'none')) modes.push({ id: 'none', label: 'No flag', level: 'none' })
  return modes
}

/**
 * The permission args a preset renders to for one manifest — the single source
 * of truth for callers that need the mapping without a complete launch.
 * Windows and POSIX launches both render through the manifest so a permission
 * change cannot update one platform while leaving another on stale flags.
 */
export function resolvePermissionArgs(manifest: PluginManifest, requested: string | undefined): string[] {
  return resolvePermissionPreset(manifest, requested)?.args ?? []
}

function buildVariableScope(
  manifest: PluginManifest,
  context: PluginRenderContext,
): Map<string, string | string[] | undefined> {
  const scope = new Map<string, string | string[] | undefined>()

  for (const [name, decl] of Object.entries(manifest.variables ?? {})) {
    if (decl.default !== undefined) {
      scope.set(name, String(decl.default))
    }
  }

  for (const [name, value] of Object.entries(context.variables ?? {})) {
    if (value === undefined) continue
    scope.set(name, Array.isArray(value) ? value.map(String) : String(value))
  }

  scope.set('binary', context.binary ?? manifest.binary)
  if (context.sessionId !== undefined) scope.set('sessionId', context.sessionId)
  if (context.prompt !== undefined) scope.set('prompt', context.prompt)
  // The host-context document, in the three shapes a manifest can spend it: the
  // file main wrote, the raw text, and the text as a TOML basic-string literal
  // (codex's `-c developer_instructions=<value>` parses its value as TOML, so
  // an unescaped newline there is a parse error). Escaping lives here rather
  // than in the manifest, because a manifest is data and cannot escape anything.
  if (context.contextFile !== undefined) {
    scope.set('contextFile', context.contextFile)
    // As a JSON string literal (quotes included), for a manifest that embeds the
    // path inside a JSON document (OpenCode's OPENCODE_CONFIG_CONTENT). A raw
    // Windows path has backslashes, and a backslash inside a JSON string is an
    // escape — the raw form would hand the CLI an unparseable config.
    scope.set('contextFileJson', JSON.stringify(context.contextFile))
  }
  if (context.contextText !== undefined) {
    scope.set('contextText', context.contextText)
    scope.set('contextToml', toTomlBasicString(context.contextText))
  }
  if (context.cwd !== undefined) scope.set('cwd', context.cwd)
  if (context.workspaceRoot !== undefined) scope.set('workspaceRoot', context.workspaceRoot)
  if (context.files !== undefined) scope.set('files', context.files)

  const preset = resolvePermissionPreset(manifest, context.permissionPreset)
  scope.set('permissionArgs', preset?.args ?? [])

  // `modelArgs` mirrors `permissionArgs`: a spreadable token list manifests
  // opt into via { spreadIf: "modelArgs" }. Rendered only when a model was
  // selected AND the manifest declares how to pass it; otherwise empty, so the
  // CLI's own default model wins and plugins without modelSelection are
  // unaffected by stale persisted model ids.
  const model = context.model?.trim()
  const modelArgTemplates = manifest.modelSelection?.args
  if (model && modelArgTemplates && modelArgTemplates.length > 0) {
    scope.set('model', model)
    scope.set(
      'modelArgs',
      modelArgTemplates.map((template) => substituteString(template, scope)),
    )
  } else {
    scope.set('modelArgs', [])
  }

  // `reasoningArgs` mirrors `modelArgs`: spread into argv via
  // { spreadIf: "reasoningArgs" }. The render rule lives in
  // renderReasoningArgs, shared by all platform launch paths. It sets `reasoning` on this
  // scope only when the level actually renders, so an unset, default, or
  // undeclared level leaves `{{reasoning}}` unresolved as before.
  scope.set('reasoningArgs', renderReasoningArgs(manifest, context.reasoning, scope))

  // `contextArgs` mirrors `modelArgs`: a spreadable token list manifests opt
  // into via { spreadIf: "contextArgs" }, in LAUNCH and RESUME argv alike —
  // being re-told on resume is the whole point of moving host context off the
  // first user message. Rendered only when main resolved a document AND the
  // manifest declares `mode: "argv"`, so a CLI with no out-of-band channel (or
  // a launch with nothing to say) passes no flag.
  const contextInjection = manifest.contextInjection
  const contextArgTemplates = contextInjection?.mode === 'argv' ? contextInjection.args : undefined
  scope.set(
    'contextArgs',
    contextArgTemplates && contextArgTemplates.length > 0 && hasHostContext(context)
      ? contextArgTemplates.map((template) => substituteString(template, scope))
      : [],
  )

  // `promptOverflowArgs`: what a launch carries instead of a prompt too long for
  // the platform's command line (see `promptInjection.overflow`). Rendered only
  // when the caller says the prompt overflowed, so every ordinary launch renders
  // none. `input` is the default for a manifest that declares no overflow, and
  // has no args of its own unless the manifest gives some.
  const overflow = context.promptOverflow
  const overflowSpec = manifest.promptInjection?.overflow ?? { mode: 'input' as const }
  if (overflow && overflow.mode === overflowSpec.mode) {
    const overflowScope = new Map(scope)
    if (overflow.mode === 'file') overflowScope.set('promptFile', overflow.promptFile)
    scope.set(
      'promptOverflowArgs',
      (overflowSpec.args ?? []).map((template) => substituteString(template, overflowScope)),
    )
  } else {
    scope.set('promptOverflowArgs', [])
  }

  // `themeArgs` mirrors `modelArgs`: spread into argv via { spreadIf: "themeArgs" }.
  // Rendered only when the host reported a color scheme AND the manifest declares
  // themeSelection; otherwise empty, so a CLI without theme support — or before
  // the renderer has pushed a scheme — keeps its own configured theme.
  //
  // When the manifest provides a `schemes` map (for CLIs with no literal
  // "light"/"dark" value, e.g. Codex's named syntax themes), the active scheme
  // resolves through it and is exposed as `{{themeName}}`. Without a map, the
  // templates substitute `{{colorScheme}}` directly. A scheme that the map
  // doesn't cover yields no theme args — better to let the CLI keep its own
  // detection than to force a wrong or empty theme.
  const colorScheme = context.colorScheme?.trim()
  const themeSelection = manifest.themeSelection
  const themeArgTemplates = themeSelection?.args
  const themeName = themeSelection?.schemes
    ? colorScheme === 'light' || colorScheme === 'dark'
      ? themeSelection.schemes[colorScheme]
      : undefined
    : colorScheme
  if (colorScheme && themeName && themeArgTemplates && themeArgTemplates.length > 0) {
    scope.set('colorScheme', colorScheme)
    scope.set('themeName', themeName)
    scope.set(
      'themeArgs',
      themeArgTemplates.map((template) => substituteString(template, scope)),
    )
  } else {
    scope.set('themeArgs', [])
  }

  // `launchSettingsArgs`: ONE `--settings` document carrying every setting this
  // launch wants. The theme used to ride its own `--settings` (themeArgs); the
  // status line has to travel the same way because no plugin can declare one,
  // and Claude Code documents `--settings` as a single value with nothing said
  // about repeating it. So when this renders, the theme is folded in here and
  // `themeArgs` is emptied — one flag, never two.
  //
  // A manifest that declares no `launchSettings` is untouched: its theme keeps
  // rendering exactly as before.
  const launchSettingsTemplates = manifest.launchSettings?.args
  if (launchSettingsTemplates && launchSettingsTemplates.length > 0) {
    const payload: Record<string, unknown> = {}
    // `themeName` is the resolved value the theme args would have carried: the
    // scheme itself for a manifest with no `schemes` map, the mapped name for
    // one that has it.
    if (colorScheme && themeName) payload.theme = themeName
    for (const [key, value] of Object.entries(context.launchSettings ?? {})) {
      if (value !== undefined) payload[key] = value
    }
    if (Object.keys(payload).length > 0) {
      scope.set('launchSettingsJson', JSON.stringify(payload))
      scope.set(
        'launchSettingsArgs',
        launchSettingsTemplates.map((template) => substituteString(template, scope)),
      )
      scope.set('themeArgs', [])
    } else {
      scope.set('launchSettingsArgs', [])
    }
  } else {
    scope.set('launchSettingsArgs', [])
  }

  // `pluginDirArgs` mirrors `modelArgs`: spread into argv via
  // { spreadIf: "pluginDirArgs" }, in LAUNCH and RESUME argv alike — a resumed
  // session needs the app's skills and its agent-state hook exactly as much as
  // a fresh one. Rendered only when the caller resolved directories AND the
  // manifest declares `launchPlugins`, so a CLI that cannot take them (or a
  // launch before the app materialised its copy) passes no flag.
  //
  // The templates are rendered ONCE PER DIRECTORY against a copy of the scope
  // carrying that directory as `{{pluginDir}}`: one flag per directory is what
  // these CLIs accept, and a copy rather than a mutation so the binding cannot
  // leak into any template rendered after this one.
  const pluginDirs = (context.pluginDirs ?? []).map((dir) => dir.trim()).filter((dir) => dir !== '')
  const pluginDirArgTemplates = manifest.launchPlugins?.args
  const pluginDirArgs: string[] = []
  if (pluginDirArgTemplates && pluginDirArgTemplates.length > 0) {
    for (const dir of pluginDirs) {
      const perDirectory = new Map(scope)
      perDirectory.set('pluginDir', dir)
      for (const template of pluginDirArgTemplates) {
        pluginDirArgs.push(substituteString(template, perDirectory))
      }
    }
  }
  scope.set('pluginDirArgs', pluginDirArgs)

  // `integrationArgs`: passed through as main rendered them, launch and resume
  // alike (a resumed session needs its MCP servers and hooks as much as a fresh
  // one). Empty for every launch that has none.
  scope.set(
    'integrationArgs',
    (context.integrationArgs ?? []).filter((arg) => typeof arg === 'string'),
  )

  return scope
}

function expandArgv(argvSpec: PluginArgvToken[], variables: Map<string, string | string[] | undefined>): string[] {
  const out: string[] = []
  for (const token of argvSpec) {
    if (typeof token === 'string') {
      out.push(substituteString(token, variables))
      continue
    }
    if ('spread' in token) {
      const value = variables.get(token.spread)
      if (Array.isArray(value)) {
        out.push(...value)
      } else if (typeof value === 'string' && value.length > 0) {
        out.push(value)
      }
      continue
    }
    if ('spreadIf' in token) {
      const value = variables.get(token.spreadIf)
      if (Array.isArray(value) && value.length > 0) {
        out.push(...value)
      } else if (typeof value === 'string' && value.length > 0) {
        out.push(value)
      }
      continue
    }
    if ('valueIf' in token) {
      const condition = variables.get(token.valueIf)
      const truthy =
        (Array.isArray(condition) && condition.length > 0) || (typeof condition === 'string' && condition.length > 0)
      if (truthy) out.push(substituteString(token.value, variables))
      continue
    }
  }
  return out
}

function substituteString(template: string, variables: Map<string, string | string[] | undefined>): string {
  return template.replace(SUBSTITUTION_PATTERN, (_match, name: string) => {
    const value = variables.get(name)
    if (value === undefined) return ''
    if (Array.isArray(value)) return value.join(' ')
    return value
  })
}

function renderEnv(
  envSpec: Record<string, string> | undefined,
  variables: Map<string, string | string[] | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  if (!envSpec) return env
  for (const [name, template] of Object.entries(envSpec)) {
    const value = substituteString(template, variables)
    if (value.length > 0) env[name] = value
  }
  return env
}

/**
 * The CLI a hosted runtime rides, or undefined for one that is its own.
 * Derived, never declared: a runtime that is the claude binary redirected at an
 * alternate provider endpoint (zai, kimi-claude) is a hosted model, and pickers
 * group it under "Models via Claude Code". claude-code itself is the host, not
 * hosted. `cli.runtime.list` reads it too, so a paired phone's picker names the
 * host where this machine's does.
 */
export function pluginHostedVia(manifest: PluginManifest): 'claude-code' | undefined {
  return manifest.binary === 'claude' &&
    manifest.id !== 'claude-code' &&
    typeof manifest.launch.env?.ANTHROPIC_BASE_URL === 'string'
    ? 'claude-code'
    : undefined
}
