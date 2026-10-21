import { defineConfig } from 'vitest/config'

// Suites that assert on scheduler timing, so sharing a CPU with the rest makes
// them flake. They run in their own project, one file at a time, after the rest.
const SERIAL = [
  'src/main/account-client.test.ts',
  'src/main/agent-state-service.test.ts',
  'src/main/automation/automation.test.ts',
  'src/main/automation/tailnet-mesh-reachability.test.ts',
  'src/main/automation/tailnet-mesh.test.ts',
  'src/main/automation/tailnet-live-events.test.ts',
  'src/main/automation/tailnet.test.ts',
  'src/main/backlog-service.test.ts',
  'src/main/capability-watcher.test.ts',
  'src/main/companion-agent-service.test.ts',
  'src/main/hosted-feed/card-feed-client.test.ts',
  'src/main/skills/studio-plugin.test.ts',
  'src/main/studio-plugin-service.test.ts',
  'src/main/terminal-runtime.test.ts',
  // These two wait on a platform's directory watch, which a loaded machine delivers late.
  'src/main/canvas/canvas-service-filesystems.test.ts',
  'src/server/rpc/studio-files.test.ts',
  // Builds the WSL server tree and runs real servers through a stand-in for
  // wsl.exe: heavy enough to starve the timing suites it would share a CPU with.
  'src/server/wsl/wsl-environment-manager.test.ts',
  // Builds the same tree and runs detached servers and the SSH relay for real.
  'src/server/bootstrap/detached-start.test.ts',
  'src/main/environments/ssh/ssh-connect.test.ts',
  'src/main/environments/ssh/ssh-environment.test.ts',
  'src/main/environments/ssh/ssh-environment.docker.test.ts',
  'src/server/desktop/shell-ssh-servers.test.ts',
  'src/main/environments/ssh/ssh-resume.test.ts',
  'src/main/environments/ssh/machine-files.test.ts',
  'src/main/environments/ssh/ssh-variants.docker.test.ts',
  'src/renderer/src/components/workspace/ConversationPeekPopover.test.tsx',
  'src/renderer/src/hooks/useSharedBacklogScan.test.ts',
  'src/renderer/src/modules/backlog-reader.test.ts',
  'src/renderer/src/store/workspaceStore.activeSync.test.ts',
  'src/renderer/src/store/workspaceStore.persistence.test.ts',
  'src/renderer/src/store/workspaceStore.registrySnapshotHeal.test.ts',
  'src/seams/conversationSeam.test.ts',
  'src/seams/premiumFeelSeam.test.tsx',
  'src/seams/skillSourcesSeam.test.tsx',
]

// The chat view's suites that script its conversation IPC, run a second time
// with the window on the Studio protocol (tests/studio-chat-loopback.ts): the
// same assertions, through the protocol path.
const CHAT_OVER_STUDIO = [
  'chatViewMount.test.tsx',
  'changedFilesCard.test.tsx',
  'composerContextPicker.test.tsx',
  'editFromHere.test.tsx',
  'useConversationSession.test.tsx',
  'useConversationCommands.test.ts',
  'streamingTurnRenders.test.tsx',
].map((file) => `src/renderer/src/components/panels/agentChat/${file}`)

export default defineConfig({
  // The renderer's tsx is compiled the way the app's own build compiles it.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@renderer': new URL('./src/renderer/src', import.meta.url).pathname },
  },
  test: {
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    // Nearly every file is one test that walks all of its cases in order (see
    // CONTRIBUTING), and the slowest takes ~40s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A passing suite's `ok - …` lines are noise; a failing one's are the story.
    silent: 'passed-only',
    // Stylesheets are stubbed to nothing, which is right for the components'
    // imports. The token sheet is the exception: Export chat's PDF page and
    // its pasted HTML read their colours out of it as text (`tokens.css?raw`).
    css: { include: [/design-system\/foundations\/tokens\.css/u] },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', '**/__fixtures__/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html'],
    },
    pool: 'forks',
    // `--expose-gc` lets a suite that bounds what a reader RETAINS collect the
    // garbage first, so the bound does not move with the GC's timing.
    execArgv: ['--max-old-space-size=4096', '--expose-gc'],
    server: {
      deps: {
        // flexlayout-react ships no "exports" map, so Node cannot resolve it as
        // an external; Vite resolves it the way the app's bundle does.
        inline: ['flexlayout-react'],
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'src/**/*.test.{ts,tsx}',
            'packages/*/test/**/*.test.{ts,tsx}',
            'resources/marketplace/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', ...SERIAL],
        },
      },
      {
        extends: true,
        test: {
          name: 'chat-over-studio',
          include: CHAT_OVER_STUDIO,
          env: { STUDIO_CHAT_TRANSPORT_UNDER_TEST: 'studio' },
        },
      },
      {
        extends: true,
        test: {
          name: 'serial',
          include: SERIAL,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
