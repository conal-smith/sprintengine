import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHostContextDocument } from '../shared/host-context/document'
import {
  OSC7_BASH_PROMPT_COMMAND,
  applyAgentIdentityEnv,
  applyTerminalCapabilityDefaults,
  OSC133_BASH_PROMPT_COMMAND,
  SHELL_INTEGRATION_BASH_PROMPT_COMMAND,
  buildNativeWindowsInvocation,
  buildShellIntegrationSetup,
  buildShellIntegrationZshShim,
  replaceFileAtomically,
  writeShellIntegrationZshShims,
  applyHostContextToPrompt,
  cleanupHostContextFile,
  hostContextRenderInputs,
  mergeProviderLaunchEnv,
  buildLaunchShellBootstrap,
  type HostContextDelivery,
} from './terminal-launch'
import { test } from 'vitest'

test('terminal-launch', async () => {
  async function main(): Promise<void> {
    testNoOpWithoutProviderEnv()
    testProviderEnvWinsOnCollision()
    testStripsApiKeyOnBaseUrlRedirectWithoutToken()
    testStripsApiKeyWhenTokenSet()
    testKeepsApiKeyWhenNoAnthropicRedirect()
    testNeverOverridesProtectedKeys()
    testStripsInheritedAgentStateSocket()
    testSocketNeverClobberedByProviderEnv()
    testJsonEnvValuesMergeInsteadOfClobbering()
    testShellBootstrapExportsOnlyWhatItIsGiven()
    testNothingIsDeliveredWhenTheHostHasNothingToSay()
    testArgvModeCarriesTheFileAndTheText()
    testPromptModeWritesNoFileAndWrapsTheRequest()
    testPromptModeLeavesAnEmptyComposerAlone()
    testWslAndWindowsNormalizeTheContextPaths()
    await testCleanupRemovesAFileOrAPluginDirectory()
    testWindowsPowerShellHandsTheExeEveryArgumentIntact()
    testOsc7ReportsAnEmptyHostAndEscapesWhatWouldChangeTheMeaning()
    testTheZshShimHandsEveryStageBackToTheUsersOwnFiles()
    testOnlyTheShellsWeCanReachThroughEnvAreArmed()
    testOsc133RidesTheSamePromptCommandAndCapturesTheStatusFirst()
    testOsc133ZshHooksRunFirstAndHandTheStatusBack()
    testTheMarksAreArmedForShellsOnly()
    testTheShimQuotesEveryExpansionThatWouldOtherwiseBeAGlob()
    testBashKeepsTheUsersOwnPromptCommand()
    testTheShimFilesAreReplacedRatherThanTruncated()
    console.log('terminal-launch tests passed')
  }

  // Windows PowerShell 5.1 stripped the quotes out of `--settings {"theme":"dark"}`
  // on the way to claude.exe, which then refused its settings on every launch.
  // Round-trips real arguments through powershell.exe into node.exe and back.
  function testWindowsPowerShellHandsTheExeEveryArgumentIntact(): void {
    if (process.platform !== 'win32') {
      console.log('ok - skipped: native Windows argument passing (not win32)')
      return
    }
    const args = [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
      '--settings',
      '{"theme":"dark"}',
      'say "hi there" now',
      'two\nlines',
      '100% %PATH% done',
      'C:\\my dir\\',
      '',
    ]
    const script = [`$command = 'node'`, `$arguments = @()`, ...buildNativeWindowsInvocation(args)].join('\r\n')
    const dir = mkdtempSync(join(tmpdir(), 'se-winargs-'))
    try {
      const scriptPath = join(dir, 'launch.ps1')
      writeFileSync(scriptPath, script, 'utf8')
      const output = execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { encoding: 'utf8' },
      )
      assert.deepEqual(JSON.parse(output.trim()), args.slice(3))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    console.log('ok - native Windows launch hands the exe every argument intact')
  }

  // A manifest with no launch.env must not touch the base env at all.
  function testNoOpWithoutProviderEnv(): void {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'real-key' }
    assert.equal(mergeProviderLaunchEnv(base, undefined), base, 'undefined provider env returns base by reference')
    assert.equal(mergeProviderLaunchEnv(base, {}), base, 'empty provider env returns base by reference')
  }

  function testProviderEnvWinsOnCollision(): void {
    const out = mergeProviderLaunchEnv(
      { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', FOO: 'base' },
      { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', FOO: 'provider' },
    )
    assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
    assert.equal(out.FOO, 'provider')
  }

  // The critical leak case: endpoint redirected but NO token configured, while a
  // real ANTHROPIC_API_KEY is inherited. It must be stripped so the real key is
  // never sent to the redirect target (the launch fails closed instead).
  function testStripsApiKeyOnBaseUrlRedirectWithoutToken(): void {
    const out = mergeProviderLaunchEnv(
      { ANTHROPIC_API_KEY: 'real-anthropic-key', PATH: '/bin' },
      { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' },
    )
    assert.equal('ANTHROPIC_API_KEY' in out, false, 'inherited real key must not survive an endpoint redirect')
    assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
    assert.equal(out.PATH, '/bin')
  }

  function testStripsApiKeyWhenTokenSet(): void {
    const out = mergeProviderLaunchEnv(
      { ANTHROPIC_API_KEY: 'real-anthropic-key' },
      { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-token' },
    )
    assert.equal('ANTHROPIC_API_KEY' in out, false)
    assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'zai-token')
  }

  // A provider env that does not touch the Anthropic endpoint must leave an
  // inherited ANTHROPIC_API_KEY alone (no over-stripping).
  function testKeepsApiKeyWhenNoAnthropicRedirect(): void {
    const out = mergeProviderLaunchEnv({ ANTHROPIC_API_KEY: 'real-anthropic-key' }, { SOME_OTHER_VAR: 'x' })
    assert.equal(out.ANTHROPIC_API_KEY, 'real-anthropic-key')
    assert.equal(out.SOME_OTHER_VAR, 'x')
  }

  // Identity/terminal keys are owned by the host and must never be clobbered by a
  // manifest's launch.env, even a malicious one.
  function testNeverOverridesProtectedKeys(): void {
    const out = mergeProviderLaunchEnv(
      { TERM: 'xterm-256color', FORCE_HYPERLINK: '1', SPRINTENGINE_AGENT_ID: 'agent-1', PATH: '/bin' },
      {
        TERM: 'evil',
        FORCE_HYPERLINK: '0',
        SPRINTENGINE_AGENT_ID: 'spoofed',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      },
    )
    assert.equal(out.TERM, 'xterm-256color', 'TERM is protected')
    assert.equal(out.FORCE_HYPERLINK, '1', "the hyperlink capability is the pane's to declare, not a manifest's")
    assert.equal(out.SPRINTENGINE_AGENT_ID, 'agent-1', 'agent identity is protected')
    assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', 'non-protected keys still apply')
  }

  // A stale SPRINTENGINE_AGENT_STATE_SOCKET inherited by the app's own process (the
  // app launched from inside an agent shell) must never leak into a launched
  // session: an identity-less launch carries none, and an agent launch replaces
  // it with this instance's own address (unresolvable outside Electron, where it
  // is simply omitted — never the inherited value).
  function testStripsInheritedAgentStateSocket(): void {
    const base = {
      PATH: '/bin',
      SPRINTENGINE_AGENT_STATE_SOCKET: '/tmp/other-instance.sock',
      SPRINTENGINE_AGENT_ID: 'stale-agent',
    }
    const plain = applyAgentIdentityEnv(base, {})
    assert.equal('SPRINTENGINE_AGENT_STATE_SOCKET' in plain, false, 'identity-less launch drops inherited socket')
    assert.equal('SPRINTENGINE_AGENT_ID' in plain, false, 'identity-less launch drops inherited agent id')

    const agent = applyAgentIdentityEnv(base, { workspaceId: 'ws-1', agentId: 'agent-1' })
    assert.equal(agent.SPRINTENGINE_AGENT_ID, 'agent-1')
    assert.notEqual(
      agent.SPRINTENGINE_AGENT_STATE_SOCKET,
      '/tmp/other-instance.sock',
      'inherited socket address must never survive onto an agent launch',
    )
  }

  // The socket address is app-owned launch identity: a CLI manifest's launch.env
  // must not be able to redirect agent-state reporting to another socket.
  function testSocketNeverClobberedByProviderEnv(): void {
    const out = mergeProviderLaunchEnv(
      { SPRINTENGINE_AGENT_STATE_SOCKET: '/tmp/ours.sock', PATH: '/bin' },
      { SPRINTENGINE_AGENT_STATE_SOCKET: '/tmp/theirs.sock' },
    )
    assert.equal(out.SPRINTENGINE_AGENT_STATE_SOCKET, '/tmp/ours.sock', 'socket address is protected')
  }

  // ── Host context ────────────────────────────────────────────────────────────
  //
  // The delivery decision and the path normalisation over it are what this file
  // owns. Which flags each CLI actually ends up with is proved against the bundled
  // manifests in agent-launch-render.test.ts, through the same renderer the spawn
  // uses.

  const DESIGN_SYSTEM_DOCUMENT = buildHostContextDocument({
    designSystem: { bundlePath: 'C:/repo/design-system' },
  }) as string

  function delivery(overrides: Partial<HostContextDelivery> = {}): HostContextDelivery {
    return {
      mode: 'argv',
      document: DESIGN_SYSTEM_DOCUMENT,
      filePath: 'C:/Users/me/AppData/Roaming/Studio/host-context/s1.md',
      ...overrides,
    }
  }

  // The host-context env channel carries a whole JSON config document (OpenCode's
  // OPENCODE_CONFIG_CONTENT). A user who exports their own must not lose it
  // because we wanted to add one instructions entry — and must not lose ours.
  function testJsonEnvValuesMergeInsteadOfClobbering(): void {
    const out = mergeProviderLaunchEnv(
      { OPENCODE_CONFIG_CONTENT: '{"theme":"tokyonight","instructions":["AGENTS.md"]}' },
      { OPENCODE_CONFIG_CONTENT: '{"instructions":["/ctx/s1.md"]}' },
    )
    const merged = JSON.parse(out.OPENCODE_CONFIG_CONTENT) as { theme: string; instructions: string[] }
    assert.equal(merged.theme, 'tokyonight', "the user's own keys survive")
    assert.deepEqual(merged.instructions, ['AGENTS.md', '/ctx/s1.md'], 'lists concatenate')

    // A table merges key by key: the app's MCP servers join the person's own.
    const tables = mergeProviderLaunchEnv(
      { OPENCODE_CONFIG_CONTENT: '{"mcp":{"mine":{"type":"local","command":["a"]}}}' },
      { OPENCODE_CONFIG_CONTENT: '{"mcp":{"sprintengine-studio":{"type":"local","command":["b"]}}}' },
    )
    assert.deepEqual(Object.keys(JSON.parse(tables.OPENCODE_CONFIG_CONTENT).mcp).sort(), [
      'mine',
      'sprintengine-studio',
    ])

    // Everything that is not a JSON object still takes the plain replacement path,
    // so no other manifest's env changes behaviour.
    const plain = mergeProviderLaunchEnv({ ANTHROPIC_BASE_URL: 'https://a' }, { ANTHROPIC_BASE_URL: 'https://b' })
    assert.equal(plain.ANTHROPIC_BASE_URL, 'https://b')
  }

  function testShellBootstrapExportsOnlyWhatItIsGiven(): void {
    assert.equal(buildLaunchShellBootstrap(), '')
    const bootstrap = buildLaunchShellBootstrap({ MCP_TOKEN: 'abc' }, { TERM: 'should-not-win', FOO: 'bar baz' })
    assert.ok(bootstrap.includes("export MCP_TOKEN='abc'"), bootstrap)
    assert.ok(bootstrap.includes("export FOO='bar baz'"), bootstrap)
    assert.ok(!bootstrap.includes('TERM'), 'protected keys stay core-owned')
  }

  // A plain repo — no design system, no knowledge graph — launches exactly as it
  // did: no flag, no env, no wrapping.
  function testNothingIsDeliveredWhenTheHostHasNothingToSay(): void {
    assert.equal(buildHostContextDocument({}), null)
    const empty = delivery({ document: null, filePath: null })
    assert.deepEqual(hostContextRenderInputs(empty, null, []), {})
    assert.equal(applyHostContextToPrompt(empty, 'Build it.'), 'Build it.')
  }

  function testArgvModeCarriesTheFileAndTheText(): void {
    const inputs = hostContextRenderInputs(delivery(), null, [])
    assert.equal(inputs.contextFile, 'C:/Users/me/AppData/Roaming/Studio/host-context/s1.md')
    assert.ok(inputs.contextText?.includes('design system is attached'))
    // The user's prompt is untouched: that is the whole point of the channel.
    assert.equal(applyHostContextToPrompt(delivery(), 'Build it.'), 'Build it.')

    // A write that failed withholds BOTH, so a manifest spending {{contextFile}}
    // renders no flag rather than a flag with an empty value.
    assert.deepEqual(hostContextRenderInputs(delivery({ filePath: null }), null, []), {})
  }

  function testPromptModeWritesNoFileAndWrapsTheRequest(): void {
    const prompt = delivery({ mode: 'prompt', filePath: null })
    assert.deepEqual(hostContextRenderInputs(prompt, null, []), {}, 'no flag, no env')
    const wrapped = applyHostContextToPrompt(prompt, 'Build the settings page.')
    assert.ok(wrapped?.startsWith('Build the settings page.'), 'the request is first so the title hook sees it')
    assert.ok(
      (wrapped ?? '').indexOf('Build the settings page.') < (wrapped ?? '').indexOf('<host-context>'),
      'host context sits below the request',
    )
  }

  // A CLI launched with nothing typed is meant to sit at its prompt. Handing it a
  // host-context block as its first message would start it working on our words.
  function testPromptModeLeavesAnEmptyComposerAlone(): void {
    const prompt = delivery({ mode: 'prompt', filePath: null })
    assert.equal(applyHostContextToPrompt(prompt, undefined), undefined)
    assert.equal(applyHostContextToPrompt(prompt, '   '), '   ')
  }

  // The document names the design-system folder absolutely and the file itself is
  // under the app's own userData. A Windows path handed to a CLI running under WSL
  // points at nothing, so both are rewritten for the shell that will read them.
  function testWslAndWindowsNormalizeTheContextPaths(): void {
    const wsl = hostContextRenderInputs(delivery(), 'wsl', ['C:/repo'])
    assert.equal(wsl.contextFile, '/mnt/c/Users/me/AppData/Roaming/Studio/host-context/s1.md')
    assert.ok(wsl.contextText?.includes('/mnt/c/repo/design-system'), wsl.contextText ?? 'no context text')
    assert.ok(!wsl.contextText?.includes('C:/repo'), 'no Windows path survives into a WSL document')

    const windows = hostContextRenderInputs(
      {
        mode: 'argv',
        document: buildHostContextDocument({ designSystem: { bundlePath: '/mnt/c/repo/design-system' } }),
        filePath: '/mnt/c/ctx/s1.md',
      },
      'windows',
      ['/mnt/c/repo'],
    )
    assert.equal(windows.contextFile, 'C:\\ctx\\s1.md')
    // Prefix rewriting, not a full re-separation: the known roots become Windows
    // paths and whatever hangs off them keeps its slashes, which is exactly what
    // the initial prompt has always done here (and what Windows accepts).
    assert.ok(windows.contextText?.includes('C:\\repo/design-system'), windows.contextText ?? 'no context text')
    assert.ok(!windows.contextText?.includes('/mnt/c/'), 'no WSL path survives into a native-Windows document')
  }

  async function testCleanupRemovesAFileOrAPluginDirectory(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'se-host-context-'))
    try {
      const filePath = join(dir, 's1.md')
      writeFileSync(filePath, 'host context\n', 'utf8')
      await cleanupHostContextFile(filePath)
      assert.equal(existsSync(filePath), false, 'a markdown document is unlinked')

      const pluginRoot = join(dir, 'sid')
      mkdirSync(join(pluginRoot, '.cursor-plugin'), { recursive: true })
      mkdirSync(join(pluginRoot, 'rules'), { recursive: true })
      writeFileSync(join(pluginRoot, '.cursor-plugin', 'plugin.json'), '{}\n', 'utf8')
      writeFileSync(join(pluginRoot, 'rules', 'host-context.mdc'), 'rule\n', 'utf8')
      await cleanupHostContextFile(pluginRoot)
      assert.equal(existsSync(pluginRoot), false, 'a plugin directory is removed recursively')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  // ── OSC 7 ───────────────────────────────────────────────────────────────────

  // The renderer refuses any `file:` URI that names a host — a pane attached to
  // another machine must never resolve a local path, and this machine's hostname
  // is indistinguishable from someone else's once it is on the wire. So the
  // emitter's half of that contract is: never send one.
  function testOsc7ReportsAnEmptyHostAndEscapesWhatWouldChangeTheMeaning(): void {
    assert.match(
      OSC7_BASH_PROMPT_COMMAND,
      /printf '\\033\]7;file:\/\/%s\\033\\\\' "\$__sprintengine_osc7"/u,
      'an empty host, and $PWD (already absolute) supplies the leading slash',
    )
    assert.ok(!/file:\/\/\$\{?HOST/u.test(OSC7_BASH_PROMPT_COMMAND), 'never the hostname form other terminals emit')

    const escapes = [...OSC7_BASH_PROMPT_COMMAND.matchAll(/%([0-9A-F]{2})\}/gu)].map((match) => match[1])
    assert.deepEqual(
      escapes,
      ['25', '23', '3F', '5C'],
      '% is escaped FIRST — every later replacement introduces one, and a second pass would turn %5C into %255C',
    )

    const zshrc = buildShellIntegrationZshShim('.zshrc')
    const zshEscapes = [...zshrc.matchAll(/%([0-9A-F]{2})\}/gu)].map((match) => match[1])
    assert.deepEqual(zshEscapes, ['25', '23', '3F', '5C'], 'both shells escape the same set in the same order')
    assert.match(zshrc, /printf '\\033\]7;file:\/\/%s\\033\\\\' "\$d"/u)
  }

  // The shim stands in front of the user's $ZDOTDIR, so the one thing it must
  // never do is cost them a startup file or leave $ZDOTDIR pointing at us.
  function testTheZshShimHandsEveryStageBackToTheUsersOwnFiles(): void {
    for (const fileName of ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const) {
      const shim = buildShellIntegrationZshShim(fileName)
      assert.ok(
        shim.includes(`if [[ -f "$ZDOTDIR/${fileName}" ]]; then source "$ZDOTDIR/${fileName}"; fi`),
        `${fileName} sources the user's own copy — zsh takes the WHOLE set from $ZDOTDIR, so a missing shim silently drops that file`,
      )
      assert.ok(
        shim.includes('ZDOTDIR=${SPRINTENGINE_USER_ZDOTDIR:-$HOME}'),
        `${fileName} runs it with their own $ZDOTDIR`,
      )
      assert.ok(
        shim.includes('if [[ $ZDOTDIR == "$SPRINTENGINE_ZDOTDIR_SELF" ]]; then ZDOTDIR=$HOME; fi'),
        `${fileName} refuses to source itself if a relaunch pointed us at ourselves`,
      )
    }

    // Only the interactive stage installs the hook, and it is the stage that
    // hands $ZDOTDIR back for good.
    const zshrc = buildShellIntegrationZshShim('.zshrc')
    assert.ok(zshrc.includes('precmd_functions+=(__sprintengine_osc7_cwd)'))
    assert.ok(
      zshrc.includes('if (( ! ${precmd_functions[(I)__sprintengine_osc7_cwd]} )); then'),
      'a nested zsh reads this file again and must not stack a second hook',
    )
    assert.ok(
      zshrc.includes('  precmd_functions+=(__sprintengine_osc7_cwd)\nfi\n__sprintengine_osc7_cwd\n'),
      'the launch directory is reported before the first prompt — the call still follows its own registration',
    )
    assert.ok(zshrc.includes('ZDOTDIR=$SPRINTENGINE_USER_ZDOTDIR'), 'the shell is left holding its own $ZDOTDIR')
    for (const fileName of ['.zshenv', '.zprofile', '.zlogin'] as const) {
      assert.ok(
        !buildShellIntegrationZshShim(fileName).includes('precmd_functions'),
        `${fileName} installs no hook — the interactive stage owns it`,
      )
    }
  }

  // Only the environment survives the `exec` into the user's real shell, so a
  // shell with no env-only hook gets nothing rather than a broken approximation.
  function testOnlyTheShellsWeCanReachThroughEnvAreArmed(): void {
    const bash = buildShellIntegrationSetup('bash', null)
    assert.ok(bash, 'bash is reachable through the environment alone')
    assert.ok(bash.includes('PROMPT_COMMAND='), 'bash imports PROMPT_COMMAND from env')
    assert.ok(bash.endsWith('; export PROMPT_COMMAND'), 'and it is exported, or the exec would not carry it')
    assert.ok(bash.includes(`'"'"'`), 'the emitter is quoted for the startup script, not pasted raw')

    const zsh = buildShellIntegrationSetup('zsh', '/profile/shell-integration/zsh')
    assert.equal(
      zsh,
      'if [ "${ZDOTDIR:-}" != \'/profile/shell-integration/zsh\' ]; then export SPRINTENGINE_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"; fi; ' +
        "export ZDOTDIR='/profile/shell-integration/zsh'",
    )

    assert.equal(
      buildShellIntegrationSetup('zsh', null),
      null,
      'no shim directory (unwritable profile) means no OSC 7, not a broken $ZDOTDIR',
    )
    assert.equal(buildShellIntegrationSetup('sh', '/profile/shell-integration/zsh'), null)
    assert.equal(buildShellIntegrationSetup('fish', '/profile/shell-integration/zsh'), null)
    assert.equal(buildShellIntegrationSetup(undefined, '/profile/shell-integration/zsh'), null)
  }

  // ── OSC 133 ─────────────────────────────────────────────────────────────────

  // The marks ride the SAME exported PROMPT_COMMAND as OSC 7 — a second
  // injection would be a second thing to keep working — and the whole reason the
  // order inside it matters is `$?`: it is the status of the command the user just
  // ran, and any command at all replaces it.
  function testOsc133RidesTheSamePromptCommandAndCapturesTheStatusFirst(): void {
    assert.ok(
      SHELL_INTEGRATION_BASH_PROMPT_COMMAND.startsWith('__sprintengine_status=$?; '),
      'the status capture leads; the OSC 7 emitter opens with an assignment, which would already have reset $?',
    )
    assert.ok(
      SHELL_INTEGRATION_BASH_PROMPT_COMMAND.includes(OSC7_BASH_PROMPT_COMMAND),
      'OSC 7 still travels in this variable, byte for byte',
    )
    assert.ok(
      SHELL_INTEGRATION_BASH_PROMPT_COMMAND.endsWith(OSC133_BASH_PROMPT_COMMAND),
      'the marks come last, so the $? restore is the final thing that runs',
    )

    assert.ok(
      OSC133_BASH_PROMPT_COMMAND.startsWith(
        'printf \'\\033]133;D;%s\\033\\\\\\033]133;A\\033\\\\\' "$__sprintengine_status"',
      ),
      'D for the command that finished and A for the prompt about to be drawn, in one write',
    )
    assert.ok(
      OSC133_BASH_PROMPT_COMMAND.includes(
        "case ${PS1-} in *'\\033]133;B\\033\\\\'*) ;; *) PS1=${PS1-}'\\[\\033]133;B\\033\\\\\\]' ;; esac",
      ),
      'B is appended to PS1 once, inside \\[…\\] so readline does not count the escape as columns',
    )
    assert.ok(
      OSC133_BASH_PROMPT_COMMAND.includes(
        "case ${PS0-} in *'\\033]133;C\\033\\\\'*) ;; *) PS0=${PS0-}'\\033]133;C\\033\\\\' ;; esac",
      ),
      "C rides PS0 — no DEBUG trap, which would clobber the user's own",
    )
    assert.ok(
      OSC133_BASH_PROMPT_COMMAND.endsWith(
        'case $__sprintengine_status in 0) ;; *) ( exit $__sprintengine_status ) ;; esac',
      ),
      'the status is put back for anything appended behind us, and the subshell is skipped on success',
    )
    assert.ok(
      !OSC133_BASH_PROMPT_COMMAND.includes('trap '),
      'no DEBUG trap: bash has exactly one, and taking it would silently break a user who set theirs',
    )
  }

  // zsh's half. The precmd hook goes to the FRONT of precmd_functions because
  // only the first hook sees the real `$?` — and having taken that position it
  // owes the hooks behind it the status it found.
  function testOsc133ZshHooksRunFirstAndHandTheStatusBack(): void {
    const zshrc = buildShellIntegrationZshShim('.zshrc')

    assert.ok(
      zshrc.includes(
        'precmd_functions=(__sprintengine_osc133_precmd "${(@)precmd_functions:#__sprintengine_osc133_precmd}")',
      ),
      "prepended, not appended — a hook behind another one sees that one's status, not the command's",
    )
    assert.ok(
      zshrc.includes('__sprintengine_osc133_precmd() {\n  local __sprintengine_ret=$?\n  emulate -L zsh'),
      'the capture is the first line of the function; even `emulate` would be a command in front of it',
    )
    assert.ok(
      zshrc.includes('  return $__sprintengine_ret\n}'),
      'the status is handed on, so a prompt theme behind us still shows the real one',
    )
    assert.ok(
      zshrc.includes('if (( ! ${preexec_functions[(I)__sprintengine_osc133_preexec]} )); then'),
      'a nested zsh reads this file again and must not stack a second preexec',
    )
    assert.ok(
      zshrc.includes('  if (( __sprintengine_osc133_active )); then'),
      'D is emitted only for a command a C opened — a bare Enter fires precmd too',
    )
    assert.ok(
      zshrc.includes("PS1=$PS1$'%{\\e]133;B\\e\\\\%}'"),
      'B is zero-width inside %{…%}; without it zsh mis-measures the prompt',
    )
    assert.ok(
      zshrc.includes('if [[ -o promptpercent ]]; then __sprintengine_osc133_prompt_percent=1; fi'),
      "and the option is read at file scope — `emulate -L zsh` inside the hook would report zsh's defaults, not the user's",
    )
    assert.ok(
      zshrc.includes('if (( __sprintengine_osc133_prompt_percent )) && [[ $PS1 != '),
      'a shell with PROMPT_PERCENT off gets no B rather than a literal %{ in its prompt',
    )

    // OSC 7 is unchanged by all of the above: same hook, same registration, and
    // it is still the interactive stage alone that installs anything.
    assert.ok(zshrc.includes('precmd_functions+=(__sprintengine_osc7_cwd)'), 'OSC 7 still registers its own hook')
    assert.ok(zshrc.includes('printf \'\\033]7;file://%s\\033\\\\\' "$d"'), 'OSC 7 still emits')
    for (const fileName of ['.zshenv', '.zprofile', '.zlogin'] as const) {
      const shim = buildShellIntegrationZshShim(fileName)
      assert.ok(
        !shim.includes('__sprintengine_osc133'),
        `${fileName} installs no mark hook — the interactive stage owns it`,
      )
      assert.ok(!shim.includes('precmd_functions'), `${fileName} installs no hook at all`)
    }
  }

  // The scope rule of the epic, asserted on the only two shells that can be
  // reached through env: a shell we cannot reach gets nothing rather than a
  // half-armed approximation, and an agent pane never runs this path at all.
  function testTheMarksAreArmedForShellsOnly(): void {
    const bash = buildShellIntegrationSetup('bash', null)
    assert.ok(bash, 'bash is armed')
    assert.ok(bash.includes('133;A'), 'bash carries the marks in the same variable as OSC 7')
    assert.equal(
      bash.match(/PROMPT_COMMAND=/gu)?.length,
      2,
      "and in exactly one variable — the capture of the user's own, then ours",
    )
    assert.ok(bash.endsWith('; export PROMPT_COMMAND'), 'exported, or it would not survive the exec')

    const zsh = buildShellIntegrationSetup('zsh', '/profile/shell-integration/zsh')
    assert.ok(zsh, 'zsh is armed')
    assert.ok(zsh.includes('ZDOTDIR'), 'zsh is reached through the same generated $ZDOTDIR, not a second one')
    assert.ok(!zsh.includes('133'), 'the marks live in the generated files, not in the startup script')

    for (const shellName of ['sh', 'fish', 'nu', undefined]) {
      assert.equal(
        buildShellIntegrationSetup(shellName, '/profile/shell-integration/zsh'),
        null,
        `${String(shellName)} gets no shell integration at all`,
      )
    }
  }

  // The right side of `==` inside `[[ ]]` is a GLOB unless it is quoted, and under
  // `setopt globsubst` — which a user's own .zshenv can set, and which is in
  // effect by the time three of the four shim stages reach this line — an
  // unquoted `$SPRINTENGINE_ZDOTDIR_SELF` is a pattern rather than a string. The
  // shim path is `~/Library/Application Support/<productName>/…`, so a single
  // `[`, `]`, `*`, `?`, `(` or `)` anywhere in it made the self-reference guard
  // either miss (the shim sources itself) or fire against a directory that merely
  // MATCHED, discarding a real `~/.config/zsh`.
  function testTheShimQuotesEveryExpansionThatWouldOtherwiseBeAGlob(): void {
    for (const fileName of ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const) {
      const shim = buildShellIntegrationZshShim(fileName)
      assert.ok(
        !/==\s*\$[A-Za-z_]/u.test(shim),
        `${fileName}: an unquoted expansion on the right of == is a glob pattern, not a string`,
      )
      // `source` and `[[ -f ]]` run with the USER'S options in effect, so
      // SH_WORD_SPLIT / GLOB_SUBST reach them too.
      assert.ok(
        !/\bsource \$/u.test(shim) && !/\[\[ -f \$/u.test(shim),
        `${fileName}: the user's own startup file is named with a quoted path`,
      )
    }
    // The one pattern that IS meant to be a pattern stays one: PS1 is searched
    // for the mark with a literal `*…*`, which quoting would break.
    assert.ok(buildShellIntegrationZshShim('.zshrc').includes("[[ $PS1 != *$'\\e]133;B'* ]]"))
  }

  // The section header always claimed an inherited `PROMPT_COMMAND` was kept. It
  // was not: bash got a bare `export PROMPT_COMMAND=<ours>`, which destroys it.
  function testBashKeepsTheUsersOwnPromptCommand(): void {
    const bash = buildShellIntegrationSetup('bash', null) ?? ''

    assert.ok(
      bash.startsWith(
        'case "${PROMPT_COMMAND:-}" in *__sprintengine_status*) ;; *) ' +
          'SPRINTENGINE_USER_PROMPT_COMMAND=${PROMPT_COMMAND:-}; export SPRINTENGINE_USER_PROMPT_COMMAND ;; esac; ',
      ),
      'the inherited value is captured before it is replaced',
    )
    assert.ok(
      bash.includes('${SPRINTENGINE_USER_PROMPT_COMMAND:+"; $SPRINTENGINE_USER_PROMPT_COMMAND"}'),
      'and run BEHIND ours — the emitter puts $? back last precisely so it can be',
    )
    assert.ok(
      !bash.includes('export PROMPT_COMMAND='),
      'assigned then exported, so no shell can field-split the joined value',
    )
    // The guard keys on a variable that appears only in our own emitter, so a
    // relaunch inside one of our terminals does not record ours as "the user's"
    // and grow the string once per nesting level.
    assert.ok(SHELL_INTEGRATION_BASH_PROMPT_COMMAND.includes('__sprintengine_status'))
  }

  // Four files, a STABLE shared directory, rewritten on every shell-pane launch:
  // restoring a saved layout starts several at once. `writeFileSync` opens with
  // O_TRUNC, so a zsh reading `.zshrc` while another launch rewrites it can read
  // the empty middle — the user's own config then silently never sources, and
  // $ZDOTDIR is left pointing at the shim for that shell's whole life.
  function testTheShimFilesAreReplacedRatherThanTruncated(): void {
    const directory = mkdtempSync(join(tmpdir(), 'sprintengine-shim-'))
    try {
      const filePath = join(directory, '.zshrc')
      const before = `${'old'.repeat(4_000)}\n`
      writeFileSync(filePath, before, 'utf8')

      // A reader that opened the file BEFORE the replace. Under O_TRUNC this
      // descriptor would see an empty (or half-written) file; under rename it
      // keeps the whole inode it opened.
      const descriptor = openSync(filePath, 'r')
      try {
        replaceFileAtomically(filePath, 'new contents\n')

        const buffer = Buffer.alloc(before.length)
        const read = readSync(descriptor, buffer, 0, buffer.length, 0)
        assert.equal(
          buffer.subarray(0, read).toString('utf8'),
          before,
          'a reader that opened the old file still sees all of it — the replace was atomic',
        )
      } finally {
        closeSync(descriptor)
      }

      assert.equal(readFileSync(filePath, 'utf8'), 'new contents\n', 'and a new reader sees the new file')
      assert.deepEqual(readdirSync(directory), ['.zshrc'], 'no temporary left behind')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  await suiteRun
})

test('the zsh shims are written once, and rewritten only when one is missing or differs', () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'zsh-shims-')), 'shell-integration', 'zsh')
  const names = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const
  const inode = (name: string) => statSync(join(directory, name)).ino
  try {
    writeShellIntegrationZshShims(directory)
    for (const name of names)
      assert.equal(readFileSync(join(directory, name), 'utf8'), buildShellIntegrationZshShim(name))
    const before = names.map(inode)

    // Another launch: nothing is replaced (a rename would be a new inode).
    writeShellIntegrationZshShims(directory)
    assert.deepEqual(names.map(inode), before)

    // One out of date and one gone: just those two are put back.
    writeFileSync(join(directory, '.zshrc'), '# an older build\n')
    rmSync(join(directory, '.zlogin'))
    const stale = inode('.zshrc')
    writeShellIntegrationZshShims(directory)
    assert.equal(readFileSync(join(directory, '.zshrc'), 'utf8'), buildShellIntegrationZshShim('.zshrc'))
    assert.equal(readFileSync(join(directory, '.zlogin'), 'utf8'), buildShellIntegrationZshShim('.zlogin'))
    assert.notEqual(inode('.zshrc'), stale)
    assert.deepEqual([inode('.zshenv'), inode('.zprofile')], before.slice(0, 2))
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
      [],
    )
  } finally {
    rmSync(join(directory, '..', '..'), { recursive: true, force: true })
  }
})

test('a terminal says it draws 24-bit colour unless the person already said otherwise', () => {
  const missing: Record<string, string> = { PATH: '/bin' }
  applyTerminalCapabilityDefaults(missing)
  assert.equal(missing.COLORTERM, 'truecolor')
  assert.equal(missing.TERM, 'xterm-256color')

  const empty: Record<string, string> = { COLORTERM: '' }
  applyTerminalCapabilityDefaults(empty)
  assert.equal(empty.COLORTERM, 'truecolor', 'an empty value is as good as missing')

  const exported: Record<string, string> = { COLORTERM: '24bit', TERM: 'screen-256color', FORCE_HYPERLINK: '0' }
  applyTerminalCapabilityDefaults(exported)
  assert.deepEqual(exported, { COLORTERM: '24bit', TERM: 'screen-256color', FORCE_HYPERLINK: '0' })
})
