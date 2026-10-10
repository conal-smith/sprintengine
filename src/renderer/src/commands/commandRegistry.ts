import { collapseDuplicateKeybindings } from './keybindings'
import type { CommandDefinition } from './types'

function command(definition: CommandDefinition): CommandDefinition {
  return {
    ...definition,
    defaultKeybindings: definition.defaultKeybindings
      ? collapseDuplicateKeybindings(definition.defaultKeybindings)
      : undefined,
  }
}

export const COMMAND_REGISTRY = [
  command({
    id: 'app.settings.open',
    title: 'Open settings',
    category: 'settings',
    scopes: ['global'],
    defaultKeybindings: ['Primary+,'],
    handlerPath: { kind: 'workspace-manager', handler: 'openSettings(false)' },
  }),
  command({
    id: 'app.updates.check',
    title: 'Check for updates',
    category: 'settings',
    scopes: ['global'],
    handlerPath: { kind: 'app-menu', command: 'app.updates.check' },
  }),
  command({
    id: 'commandPalette.open',
    title: 'Open command palette',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Primary+K', 'Primary+Shift+P'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true)' },
  }),
  // Search Everywhere. `Shift Shift` is here for the reason a person reaches
  // for it: their hands are in a terminal and they
  // want the palette NOW. The dispatcher fires a lone-modifier double tap
  // regardless of target suppression, so it works inside xterm and Monaco where
  // ⌘K deliberately does not.
  //
  // It raises the SAME overlay `commandPalette.open` does, with the same
  // groups. The two are separate commands only so they are separately
  // rebindable and separately disableable: disable and rebind are per command,
  // so while the gesture rode the palette's id, turning off Double Shift meant
  // turning off ⌘K with it (double-shift review, 2026-09-10).
  command({
    id: 'search.everywhere',
    title: 'Search everywhere',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Shift Shift'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true)' },
  }),
  // Find in Path. The same overlay `commandPalette.open` raises, opened filtered
  // to the file-backed groups — a snippet of code should not be ranked against
  // command and workspace rows. Global scope, like the palette itself: with no
  // workspace open the overlay says so rather than refusing to appear, which is
  // the behaviour a user pressing a search shortcut expects.
  command({
    id: 'search.files.open',
    title: 'Search in files',
    category: 'command_palette',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Shift+F'],
    handlerPath: { kind: 'workspace-manager', handler: 'setCommandPaletteOpen(true, "text")' },
  }),
  // Opens the pre-creation New Chat panel — the one way to start (owner,
  // 2026-09-04; the New workspace command and its hub are gone). Global-scope:
  // openNewChatPanel() resolves to the active workspace's folder when one exists
  // and to null otherwise, so it works with no active workspace.
  command({
    id: 'chat.new',
    title: 'New chat',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+N'],
    handlerPath: { kind: 'workspace-manager', handler: 'openNewChatPanel()' },
  }),
  // New chat, scoped to "No project": the chat runs in a folder of its own
  // that the app makes for it (shared/projectless-chats.ts), for a question or
  // a one-off task that belongs to no codebase. ⌘N with Option held, because
  // it is New chat with one thing changed; bound nowhere else in the app or
  // its modules.
  command({
    id: 'chat.newWithoutProject',
    title: 'New chat without a project',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Alt+N'],
    handlerPath: { kind: 'workspace-manager', handler: 'openNewChatWithoutProject()' },
  }),
  // Start the chat typed in New chat and stay there, on a fresh empty box with
  // the same project and engine, to fire off the next task at once. ⌘⏎
  // because it is ⏎ held a little harder: the same send, kept in place. Plain ⏎
  // still opens the chat it starts. Its `new-chat` scope is never pushed onto
  // the window's active scopes: NewAgentPanel resolves the binding in the
  // prompt's keydown, after its slash and mention menus and an input method
  // have had the key, so the window dispatcher never matches it. It has a scope
  // at all so the Shortcuts tab shows it, rebinds it, and checks it for
  // conflicts like any other command.
  command({
    id: 'chat.new.launchInBackground',
    title: 'Start chat and stay on New chat',
    category: 'workspace',
    scopes: ['new-chat'],
    defaultKeybindings: ['Primary+Enter'],
    allowInEditableTarget: true,
    handlerPath: {
      kind: 'context-bound',
      owner: 'NewAgentPanel',
      action: 'onPromptKeyDown -> launch(prompt, { stay: true })',
    },
  }),
  // Send what is in a chat's composer and go straight to New chat, to fire off
  // the next task while this one runs. ⌘⌥⏎: the chat's ⌘⏎ is "send now", and
  // Option is the key that says "and then somewhere else". Resolved in the
  // composer's own keydown, after its pickers and an input method have had the
  // key, so the window dispatcher's match runs nothing (context-bound); the
  // scope is what puts it in the Shortcuts tab, rebindable and checked for
  // conflicts.
  command({
    id: 'chat.sendAndNew',
    title: 'Send and start a new chat',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+Enter'],
    allowInEditableTarget: true,
    handlerPath: {
      kind: 'context-bound',
      owner: 'AgentChatView',
      action: 'composer onKeyDown -> submitComposer(), then chat.new',
    },
  }),
  // The chats waiting on the person, one press each: blocked on a question or
  // an approval first, then a failed turn, longest-waiting first within each —
  // the same chats the Home badge counts. J for "jump"; ⌘⇧J is spoken for
  // nowhere in the app or its modules, and a person reaches for it from a
  // composer, so it works there too.
  command({
    id: 'chat.nextWaiting',
    title: 'Go to next chat that needs you',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Shift+J'],
    allowInEditableTarget: true,
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action: 'nextWaitingChatId(...) -> sidebarSelectWorkspace(nextWorkspaceId) | toast',
    },
  }),
  // Settle the chat on screen, or bring it back if it is settled: the row's
  // Settle, from the keyboard. S for "settle"; ⌘⇧S is bound nowhere in the app
  // or its modules, and a person reaches for it from a composer as they finish
  // with a chat — but not from an editor or a terminal, where ⌘⇧S is Save As
  // (`shellTakesChordFrom`). A chat whose agents are working is refused, as
  // its row refuses it.
  command({
    id: 'chat.settle',
    title: 'Settle chat, or bring it back',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+S'],
    allowInEditableTarget: true,
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceSidebar',
      action: 'chatSettleStep(activeWorkspace) -> settleWorkspaceById | setWorkspaceSettled(id, false) | toast',
    },
  }),
  command({
    id: 'chat.newConversation',
    title: 'New conversation',
    category: 'workspace',
    scopes: ['global'],
    handlerPath: { kind: 'workspace-manager', handler: 'openNewChatPanel(undefined, null, { kind: "conversation" })' },
  }),
  command({
    id: 'chat.newTerminalAgent',
    title: 'New terminal agent',
    category: 'workspace',
    scopes: ['global'],
    handlerPath: { kind: 'workspace-manager', handler: 'openNewChatPanel(undefined, null, { kind: "general" })' },
  }),
  // The chat composer's model picker (remote-sessions-ux / selector-menus-
  // premium). Works from inside the
  // composer's textarea — that is where a person is when they want to change
  // model — so it is allowed in editable targets. The chat view listens for
  // the panel event of the same id, which both the shell's runCommand (the
  // palette row) and the view's own binding resolution dispatch.
  command({
    id: 'chat.modelPicker.toggle',
    title: 'Toggle model picker',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+M'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'chat.modelPicker.toggle' },
  }),
  command({
    id: 'chat.effort.cycle',
    title: 'Cycle reasoning effort',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: [],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'chat.effort.cycle' },
  }),
  // Resume in terminal: the focused chat's conversation carried on by a
  // terminal agent running the CLI's own resume.
  command({
    id: 'chat.resumeInTerminal',
    title: 'Continue chat in terminal',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: [],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'chat.resumeInTerminal' },
  }),
  // End the focused chat's agent process the way Settle and the idle sweep do,
  // keeping the conversation: the next message starts it again, resumed, and
  // the CLI reads its skills and plugins afresh as it starts. For after
  // installing one, which a running CLI does not see. No chord: it is reached
  // for rarely, from the palette.
  command({
    id: 'chat.restartSession',
    title: 'Restart agent session',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: [],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'chat.restartSession' },
  }),
  // Step through a conversation one prompt at a time — the chat's reading of
  // what `terminal.promptPrevious` / `terminal.promptNext` do in a shell, so it
  // takes the same chords. The terminal's pair sits on the more specific
  // `terminal` scope and wins inside a terminal; here, in an editable target
  // (the composer), ⌘⇧↑/↓ stays the text field's select-to-start/end.
  command({
    id: 'chat.turn.previous',
    title: 'Jump to previous turn',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+ArrowUp'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'chat.turn.previous' },
  }),
  command({
    id: 'chat.turn.next',
    title: 'Jump to next turn',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+ArrowDown'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'chat.turn.next' },
  }),
  // Play the focused chat back from its first message, a reply at a time, for
  // reading a finished conversation to a room. No chord: it is started rarely,
  // from the palette or the chat tab's menu, and once started the replay owns
  // the bare keys (Space, the arrows, Esc) while it has focus.
  command({
    id: 'chat.replay.start',
    title: 'Replay conversation',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: [],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'chat.replay.start' },
  }),
  // Find in the conversation you are reading: its messages, replies and plans,
  // a match at a time. ⌘F because that is where a person's hand goes to find
  // anything, and it is free here: `terminal.find` holds the chord on the more
  // specific `terminal` scope and wins inside a terminal, and
  // `shellTakesChordFrom` hands it back to Monaco and to everything that is
  // not a chat. `allowInEditableTarget` so it works from the composer, where
  // the person is when they think to look something up.
  command({
    id: 'chat.find',
    title: 'Find in chat',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+F'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'chat.find' },
  }),
  // Quote what is selected in a conversation's transcript into its composer,
  // as the selection toolbar's Quote does. `>` is markdown's quote marker and
  // what the chord inserts, and on a US layout ⌘⇧. is ⌘> — the physical key is
  // what the dispatcher matches, so the chord is written unshifted. Outside
  // editable targets only: the selection it acts on is in the transcript, and
  // focus is there with it.
  command({
    id: 'chat.quoteSelection',
    title: 'Quote selection in reply',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+.'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'chat.quoteSelection' },
  }),
  command({
    id: 'workspace.close',
    title: 'Close workspace',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+W'],
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action: 'closeWorkspaceById(windowActiveWorkspaceId)',
    },
  }),
  command({
    id: 'workspace.switch.next',
    title: 'Switch workspace forward',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    defaultKeybindings: ['Primary+`', 'Meta+Alt+ArrowRight'],
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action:
        'getNextWorkspaceId(numberedChatIds(drawn, ...), 1) -> setActiveWorkspaceForWindow(workspaceWindowId, nextWorkspaceId)',
    },
  }),
  command({
    id: 'workspace.switch.previous',
    title: 'Switch workspace back',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    defaultKeybindings: ['Primary+Shift+`', 'Meta+Alt+ArrowLeft'],
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action:
        'getNextWorkspaceId(numberedChatIds(drawn, ...), -1) -> setActiveWorkspaceForWindow(workspaceWindowId, previousWorkspaceId)',
    },
  }),
  command({
    id: 'workspace.history.back',
    title: 'Go back (recent workspace)',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action:
        'stepNavigationHistory(..., -1) -> setActiveWorkspaceForWindow | openGlobalSurface (per visited entry kind)',
    },
  }),
  command({
    id: 'workspace.history.forward',
    title: 'Go forward (recent workspace)',
    category: 'workspace',
    scopes: ['workspace-navigation'],
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action:
        'stepNavigationHistory(..., 1) -> setActiveWorkspaceForWindow | openGlobalSurface (per visited entry kind)',
    },
  }),
  ...Array.from({ length: 9 }, (_, index) => {
    const workspaceNumber = index + 1
    return command({
      id: `workspace.switch.${workspaceNumber}`,
      title: `Switch to workspace ${workspaceNumber}`,
      category: 'workspace',
      scopes: ['workspace-navigation'],
      defaultKeybindings: [`Primary+${workspaceNumber}`],
      availability: ['activeWorkspace'],
      handlerPath: {
        kind: 'context-bound',
        owner: 'WorkspaceManager',
        action: `setActiveWorkspaceForWindow(workspaceWindowId, numberedChatIds(drawnSidebarChatIds(document), ...)[${index}])`,
      },
    })
  }),
  command({
    id: 'workspace.sidebar.toggle',
    title: 'Toggle sidebar',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Primary+B'],
    handlerPath: { kind: 'workspace-manager', handler: 'setSidebarCollapsed(!sidebarCollapsed)' },
  }),
  command({
    id: 'layout.tab.next',
    title: 'Next tab',
    category: 'workspace',
    scopes: ['global'],
    // Tab cycling uses the physical Control key on every platform. On macOS,
    // Primary is Command, whose Tab chord belongs to application switching;
    // Control+Tab is the in-window gesture people expect. It must also work
    // while the terminal, editor, or another editable surface owns focus.
    defaultKeybindings: ['Ctrl+Tab', 'Meta+Shift+]'],
    allowInEditableTarget: true,
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action: 'cycleActiveLayoutTab(windowActiveWorkspaceId, 1)',
    },
  }),
  command({
    id: 'layout.tab.previous',
    title: 'Previous tab',
    category: 'workspace',
    scopes: ['global'],
    defaultKeybindings: ['Ctrl+Shift+Tab', 'Meta+Shift+['],
    allowInEditableTarget: true,
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action: 'cycleActiveLayoutTab(windowActiveWorkspaceId, -1)',
    },
  }),
  command({
    id: 'layout.tab.close',
    title: 'Close layout tab',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+W'],
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspaceManager',
      action: 'closeActiveLayoutTab(windowActiveWorkspaceId, terminalSessions)',
    },
  }),
  // Reveal-in-file-manager for the active checkout, and the keyboard half of
  // the workspace bar's open-in-editor split button (item 1990). The reveal
  // target is the workspace's mounted worktree when it has one, so this and the
  // control resolve the same folder; the control owns that resolution and this
  // command routes to it as a panel event.
  //
  // Consequence of routing to the control: it acts only while the workspace bar
  // is on screen. A door surface replaces the identity cluster with its own bar
  // (WorkspaceHeader), so this is inert there — the same shape as the git.*
  // panel commands, which gate on `gitPanelActive` for the same reason. It has
  // no equivalent flag because the control's presence also depends on the
  // main-process target probe, which the renderer cannot report as availability.
  command({
    id: 'workspace.folder.reveal',
    title: 'Reveal workspace folder',
    category: 'workspace',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+O'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'panel-event', eventId: 'workspace.folder.reveal' },
  }),
  // Files, Git and (later) the browser live in the workspace pane — the
  // full-height column on the right (browser-pane epic). The pane toggle takes
  // ⌘⌥B — the whole column, one chord away from the ⌘B a person already reads
  // as "show or hide the side panel"; Files and Git keep theirs and now toggle
  // their pane tab.
  command({
    id: 'pane.toggle',
    title: 'Toggle workspace pane',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+B'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: 'setPaneOpen(windowActiveWorkspaceId, !paneOpen)' },
  }),
  // The pane's "+" from the keyboard: the menu of what can be opened there,
  // with the pane shown first if it was closed. T for "tab", as a new tab is
  // what it makes; ⌘T is bound nowhere else in the app. From the composer on
  // macOS, but never from an editor or a terminal, nor from a text field off
  // macOS, where Ctrl+T is the transpose (`shellTakesChordFrom`).
  command({
    id: 'pane.add',
    title: 'Open in the pane…',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+T'],
    allowInEditableTarget: true,
    availability: ['activeWorkspace'],
    handlerPath: {
      kind: 'context-bound',
      owner: 'WorkspacePane',
      action: 'setPaneOpen(windowActiveWorkspaceId, true) -> setAddMenuOpen(true)',
    },
  }),
  command({
    id: 'panel.files.toggle',
    title: 'Toggle file explorer',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+E'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'panel.files.toggle' },
  }),
  command({
    id: 'panel.editor.toggle',
    title: 'Toggle code editor',
    category: 'panel',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+O'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'panel.editor.toggle' },
  }),
  command({
    id: 'panel.git.toggle',
    title: 'Toggle Git panel',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Shift+G'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'app-menu', command: 'panel.git.toggle' },
  }),
  // The Agents list is a pane tab like Git: showing → close it, behind → bring
  // it forward, absent → open it. Unbound, like Canvas; the palette, the pane's
  // "+" menu and a chat's own agent lanes open it.
  command({
    id: 'panel.agents.toggle',
    title: 'Toggle agents',
    category: 'panel',
    scopes: ['workspace'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "togglePaneKind(windowActiveWorkspaceId, 'agents')" },
  }),
  // Canvas is a pane tab like Files and Git, so its toggle reads the same way:
  // showing → close it, present but behind → bring it forward, absent → open
  // it. It ships UNBOUND, because the three letters a whiteboard wants
  // (⌘⇧C/⌘⇧D/⌘⇧W) are all spoken for elsewhere and a new surface does not get
  // to take a chord someone's hands already know; the launcher tile and the
  // pane's "+" menu are its reachable entry points, and Shortcuts settings is
  // where a person who draws every day binds it.
  command({
    id: 'panel.canvas.toggle',
    title: 'Toggle canvas',
    category: 'panel',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'canvasEnabled'],
    handlerPath: { kind: 'workspace-manager', handler: "togglePaneKind(windowActiveWorkspaceId, 'canvas')" },
  }),
  // The Knowledge Graph has no rail glyph (the rail is reserved for the
  // navigational core: Files / Git / Backlog), so this
  // command — surfaced in the palette and the View menu — is its entry point.
  // It ships unbound; users can bind it in Shortcuts settings.
  command({
    id: 'panel.knowledge-graph.toggle',
    title: 'Toggle knowledge graph',
    category: 'panel',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'memoryGraphEnabled'],
    handlerPath: { kind: 'app-menu', command: 'panel.knowledge-graph.toggle' },
  }),
  command({
    id: 'git.worktrees.open',
    title: 'Git: Manage worktrees',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: "openPaneTab(windowActiveWorkspaceId, { kind: 'git' })" },
  }),
  // Git refresh/fetch/commit run the Git panel's real handlers via the
  // panel-command bridge, so they are only available while the Git tab is
  // showing in the active workspace's pane. No default keybindings: refresh is safe but
  // unbound by default, and commit/fetch are stateful — users can bind them in
  // the Shortcuts settings (commit is destructive-adjacent, so it ships unbound
  // per the plan's no-risky-default rule).
  command({
    id: 'git.refresh',
    title: 'Git: Refresh status',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.refresh' },
  }),
  command({
    id: 'git.fetch',
    title: 'Git: Fetch remotes',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.fetch' },
  }),
  command({
    id: 'git.commit',
    title: 'Git: Commit staged changes',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.commit' },
  }),
  // The Commit window's row actions, reachable from the keyboard with the menu
  // closed (git-commit-window T6). They act on the changes list's SELECTION, so
  // they are gated on the Git panel exactly as the three above are, and the
  // panel itself refuses them while one of its dialogs is open.
  //
  // ⌘D and ⌥⌘Z ship bound because they are the two the mockup's menu carries a
  // hint for and neither chord is spoken for. `git.changes.moveToChangelist`
  // ships UNBOUND on purpose: ⇧⌘M already belongs to the model picker
  // at workspace scope here, the dispatcher takes the first match, and a default
  // that quietly loses to another command is worse than none — so the menu
  // carries no hint for it either, per the kit's menu rule.
  command({
    id: 'git.changes.showDiff',
    title: 'Git: Show diff for the selected file',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+D'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.changes.showDiff' },
  }),
  command({
    id: 'git.changes.discard',
    title: 'Git: Discard changes in the selected files',
    category: 'git',
    scopes: ['workspace'],
    defaultKeybindings: ['Primary+Alt+Z'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.changes.discard' },
  }),
  command({
    id: 'git.changes.moveToChangelist',
    title: 'Git: Move the selected files to another changelist',
    category: 'git',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'gitPanelActive'],
    handlerPath: { kind: 'panel-event', eventId: 'git.changes.moveToChangelist' },
  }),
  // No Fleet command: the Fleet panel was retired on 2026-09-05
  // (remote-sessions-in-the-sidebar). Paired machines' sessions are rows in
  // the sidebar's Remote band; machine management is Settings → Remote and
  // the top bar's Remote glyph (WorkspaceActions → RemotePopover).
  command({
    id: 'terminal.new',
    title: 'Open plain terminal',
    category: 'terminal',
    scopes: ['workspace'],
    defaultKeybindings: ["Primary+Shift+'"],
    availability: ['activeWorkspace'],
    handlerPath: { kind: 'workspace-manager', handler: 'addNewTerminal()' },
  }),
  // Focus/stop act on the active workspace's live terminal, so they require a
  // terminal session to exist. Unbound by default: focus is benign but bindable,
  // and stop kills a session (destructive) so it ships without a default key.
  command({
    id: 'terminal.focus',
    title: 'Focus terminal',
    category: 'terminal',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'terminalActive'],
    handlerPath: { kind: 'workspace-manager', handler: 'focusActiveTerminal()' },
  }),
  // Find in the pane you are looking at — the scrollback of one terminal.
  //
  // The sibling of `search.files.open` (⌘⇧F, the workspace's files through
  // ripgrep), not a rival to it: same registry, same Shortcuts tab (where it
  // sits with the other Terminal commands and can be rebound), one key
  // narrower for one pane. It is the only command on the
  // `terminal` scope, which WorkspaceManager activates for exactly the
  // keystrokes that came from inside a terminal surface — so ⌘F anywhere else
  // (Monaco's own find, a text field) is untouched. `allowInEditableTarget`
  // because the keystroke arrives at xterm's hidden textarea, which
  // `isGlobalShortcutSuppressedTarget` treats as editable.
  command({
    id: 'terminal.find',
    title: 'Find in terminal',
    category: 'terminal',
    scopes: ['terminal'],
    defaultKeybindings: ['Primary+F'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'terminal.find' },
  }),
  // Jump between the prompts OSC 133 marks. Same registry, same Shortcuts tab
  // and the same `terminal` scope as Find in Terminal — the scope
  // WorkspaceManager activates for exactly the keystrokes that came from inside
  // a terminal surface, so these keys are free everywhere else.
  //
  // Only a plain terminal answers. Agent panes are never sent the shell
  // integration that emits the marks, and this is shell ergonomics, not a
  // status feed: agent phase comes from `agent-state.ts` over the state socket.
  // `allowInEditableTarget` because the keystroke arrives at xterm's hidden
  // textarea, which `isGlobalShortcutSuppressedTarget` treats as editable.
  command({
    id: 'terminal.promptPrevious',
    title: 'Jump to previous prompt',
    category: 'terminal',
    scopes: ['terminal'],
    defaultKeybindings: ['Primary+Shift+ArrowUp'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'terminal.promptPrevious' },
  }),
  command({
    id: 'terminal.promptNext',
    title: 'Jump to next prompt',
    category: 'terminal',
    scopes: ['terminal'],
    defaultKeybindings: ['Primary+Shift+ArrowDown'],
    availability: ['activeWorkspace'],
    allowInEditableTarget: true,
    handlerPath: { kind: 'panel-event', eventId: 'terminal.promptNext' },
  }),
  command({
    id: 'terminal.stop',
    title: 'Stop active terminal',
    category: 'terminal',
    scopes: ['workspace'],
    availability: ['activeWorkspace', 'terminalActive'],
    handlerPath: { kind: 'workspace-manager', handler: 'stopActiveTerminal()' },
  }),
  // The performance diagnostics panel is a dev/diagnostics-only engineering
  // tool (process metrics, terminal/replay footprint, retention warnings).
  // The subscription usage limits as a dialog, for a person with no Claude or
  // Codex chat open to open them from. Unbound.
  command({
    id: 'usage.limits.show',
    title: 'Show usage limits',
    category: 'settings',
    scopes: ['global'],
    handlerPath: { kind: 'workspace-manager', handler: 'setUsageLimitsOpen(true)' },
  }),
  // Gated on diagnosticsEnabled so it never surfaces in a normal build; ships
  // unbound (users can bind it in Shortcuts settings).
  command({
    id: 'diagnostics.open',
    title: 'Diagnostics: Performance panel',
    category: 'diagnostics',
    scopes: ['global'],
    availability: ['diagnosticsEnabled'],
    handlerPath: { kind: 'workspace-manager', handler: 'setDiagnosticsOpen(true)' },
  }),
] as const satisfies readonly CommandDefinition[]

export type CommandId = (typeof COMMAND_REGISTRY)[number]['id']

export function getCommandDefinition(commandId: string): CommandDefinition | undefined {
  return COMMAND_REGISTRY.find((commandDefinition) => commandDefinition.id === commandId)
}
