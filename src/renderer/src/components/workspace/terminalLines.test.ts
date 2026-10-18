import assert from 'node:assert/strict'

import type {
  SessionFileChange,
  TerminalSessionSnapshot,
  WorkspaceChangeSummary,
} from '../../../../shared/electron-api'
import type { RemoteSessionRow } from './remoteBand/remoteSessionsModel'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import {
  MAX_TERMINAL_LINES,
  branchChipCopy,
  changedFileMarks,
  changedFilesPhrase,
  checkoutPathsOf,
  diffScopeCopy,
  lineDiffOf,
  lineOfRemoteRow,
  sessionCheckoutPath,
  terminalLinesOf,
  type TerminalLinesWorkspace,
} from './terminalLines'
import { test } from 'vitest'

test('terminalLines', async () => {
  // The sidebar row's terminal lines (sidebar-lists-every-terminal), DOM-free:
  // one per live terminal, each on ITS checkout, working first, capped.

  const session = (over: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot =>
    ({
      sessionId: 's',
      kind: 'agent',
      processAlive: true,
      suspended: false,
      visible: true,
      workspaceId: 'ws',
      agentId: 'a1',
      cli: 'claude-code',
      activity: { kind: 'idle', since: 1_000 },
      lastOutputAt: null,
      lastInputAt: null,
      startedAt: 0,
      ...over,
    }) as TerminalSessionSnapshot

  const workspace = (over: Partial<TerminalLinesWorkspace> = {}): TerminalLinesWorkspace => ({
    folderPath: '/repo',
    agents: {
      a1: { id: 'a1', name: 'Conor Kirby', execution: { mode: 'current_workspace', worktreeId: null, cwd: '/repo' } },
      a2: { id: 'a2', name: 'Aine Carey', execution: { mode: 'current_workspace', worktreeId: null, cwd: '/repo' } },
    } as never,
    ...over,
  })

  // `files` always adds up to `changedFiles` — main asserts it, so a fixture that
  // broke the identity would be testing a summary git never produces.
  const summary = (over: Partial<WorkspaceChangeSummary>): WorkspaceChangeSummary => ({
    branch: 'main',
    additions: 202,
    deletions: 122,
    changedFiles: 9,
    files: { added: 5, updated: 3, removed: 1 },
    scope: 'folder',
    ...over,
  })

  // One entry of a session's own hook ledger (hook-file-ledger): what the agent
  // edited, as its PostToolUse hooks reported it.
  const edited = (path: string, additions: number, deletions: number, edits = 1): SessionFileChange => ({
    path,
    additions,
    deletions,
    edits,
    lastEditedAt: 1_000,
  })

  // A pull request as main resolves it onto the session snapshot (epic
  // pull-request-marks): only its state and number matter to the line.
  const pr = (over: Partial<BranchPullRequest> = {}): BranchPullRequest => ({
    url: 'https://github.com/acme/sprintengine/pull/418',
    repoKey: 'github.com/acme/sprintengine',
    repoName: 'sprintengine',
    number: 418,
    title: 'The sidebar number is the branch diff',
    state: 'open',
    isDraft: false,
    openedAt: 1_000,
    stateAt: 2_000,
    // On the session's own branch unless a case says otherwise: main stamps this
    // for the branch lookup's entries, and only those may land the line.
    onSessionBranch: true,
    ...over,
  })

  const worktreeObserved = {
    cwd: '/repo/.claude/worktrees/rail/src',
    at: 5,
    resolved: true,
    gitRoot: '/repo/.claude/worktrees/rail',
    repoRoot: '/repo',
    branch: 'worktree-workspace-rail',
    isLinkedWorktree: true,
  }

  // A session with nothing observed reports on the workspace checkout; one
  // observed in a worktree reports on THAT; one in a plain folder on nothing.
  {
    const ws = workspace()
    assert.equal(sessionCheckoutPath(ws, session({})), '/repo')
    assert.equal(
      sessionCheckoutPath(ws, session({ observedCheckout: worktreeObserved })),
      '/repo/.claude/worktrees/rail',
    )
    assert.equal(
      sessionCheckoutPath(
        ws,
        session({
          observedCheckout: {
            ...worktreeObserved,
            gitRoot: null,
            repoRoot: null,
            branch: null,
            isLinkedWorktree: false,
            cwd: '/tmp',
          },
        }),
      ),
      null,
    )
    // Distinct, for the poll: two on main ask once, the worktree asks for itself.
    assert.deepEqual(
      checkoutPathsOf(ws, [
        session({ sessionId: 's1' }),
        session({ sessionId: 's2', agentId: 'a2' }),
        session({ sessionId: 's3', observedCheckout: worktreeObserved }),
      ]),
      ['/repo', '/repo/.claude/worktrees/rail'],
    )
  }

  // Each line reads ITS checkout's facts: the shared checkout quietly (folder
  // scope), the worktree at full strength with the path for hover.
  {
    const summaries = {
      '/repo': summary({}),
      '/repo/.claude/worktrees/rail': summary({
        branch: 'worktree-workspace-rail',
        additions: 1048,
        deletions: 21762,
        scope: 'worktree',
      }),
    }
    const { lines, overflow } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({ sessionId: 's1', lastOutputAt: 10 }),
        session({ sessionId: 's2', agentId: 'a2', observedCheckout: worktreeObserved, lastOutputAt: 20 }),
      ],
      meshPanes: [],
      summaries,
    })
    assert.equal(overflow, 0)
    assert.deepEqual(
      lines.map((line) => [line.name, line.branch, line.worktree, line.additions, line.diffScope, line.cwd]),
      [
        ['Aine Carey', 'worktree-workspace-rail', true, 1048, 'worktree', '/repo/.claude/worktrees/rail/src'],
        ['Conor Kirby', 'main', false, 202, 'folder', null],
      ],
      'the more recent line first; each on its own checkout',
    )
  }

  // A working line outranks a more recent idle one; a plain shell is a line too,
  // named Terminal; a mesh pane is a line with its machine and no diff claim.
  {
    const { lines } = terminalLinesOf({
      workspace: workspace({ remoteOrigin: { checkout: { branch: 'remote-main' } } as never }),
      sessions: [
        session({ sessionId: 'idle-recent', lastOutputAt: 900 }),
        session({
          sessionId: 'working',
          agentId: 'a2',
          activity: { kind: 'working', since: 100 },
          agentState: { phase: 'thinking', source: 'hook', since: 100 } as never,
          lastPrompt: { at: 120 } as never,
        }),
        session({ sessionId: 'shell', kind: 'terminal', cli: undefined, agentId: undefined, lastOutputAt: 500 }),
      ],
      meshPanes: [{ tabId: 'mesh-conversation:c1:ws-9:agent-9', machineName: 'air.local', cli: 'codex' }],
      summaries: { '/repo': summary({}) },
    })
    assert.deepEqual(
      lines.map((line) => [line.key, line.kind, line.name, line.working, line.workingSince]),
      [
        ['working', 'agent', 'Aine Carey', true, 120],
        ['idle-recent', 'agent', 'Conor Kirby', false, null],
        ['shell', 'shell', 'Terminal', false, null],
        ['mesh-conversation:c1:ws-9:agent-9', 'remote', null, false, null],
      ],
    )
    const pane = lines[3]
    assert.equal(pane.machineName, 'air.local', 'the machine is the glyph’s name, never line text')
    assert.equal(pane.branch, 'remote-main', 'the branch stamped at the remote create')
    assert.equal(pane.additions + pane.deletions, 0, 'no ±lines are claimed for a checkout on another disk')
    assert.equal(lines[2].branch, 'main', 'a shell on the workspace checkout still names the branch')
  }

  // A waiting line says so; a failed one says so.
  {
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({ sessionId: 'waiting', agentState: { phase: 'awaiting_input', source: 'hook', since: 1 } as never }),
        session({ sessionId: 'failed', agentId: 'a2', activity: { kind: 'failed', at: 7, exitCode: 1 } }),
      ],
      meshPanes: [],
      summaries: {},
    })
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line]))
    assert.equal(byKey.waiting.needsInput, true)
    assert.equal(byKey.failed.failed, true)
    assert.equal(byKey.failed.idleSince, 7, 'a failure is when it stopped')
  }

  // Past the cap the rest fold into an overflow count, most recent kept.
  {
    const sessions = Array.from({ length: MAX_TERMINAL_LINES + 2 }, (_, index) =>
      session({ sessionId: `s${index}`, activity: { kind: 'idle', since: 1_000 + index } }),
    )
    const { lines, overflow } = terminalLinesOf({ workspace: workspace(), sessions, meshPanes: [], summaries: {} })
    assert.equal(lines.length, MAX_TERMINAL_LINES)
    assert.equal(overflow, 2)
    assert.equal(lines[0].key, `s${MAX_TERMINAL_LINES + 1}`, 'the most recent stays')
  }

  // One remote AGENT's line: the agent's own name (the ROW is titled with the
  // conversation, so a chat running three of them says which is which), and no
  // diff where its machine lists none (a chat at rest, an older desktop). A
  // machine that names no branch leaves the line without one.
  {
    const row = {
      sessionId: 'r1',
      title: 'Gael Corry',
      cli: 'codex',
      activity: 'idle',
      since: 42,
    } as RemoteSessionRow
    const line = lineOfRemoteRow(row)
    assert.equal(line.name, 'Gael Corry', 'the line names its agent, for the mark’s tooltip')
    assert.equal(line.branch, null, 'no branch the machine did not name')
    assert.deepEqual(line.pullRequests, [])
    assert.equal(line.additions + line.deletions, 0)
    assert.equal(line.diffScope, 'folder')
    assert.equal(line.changedFiles, 0)
    assert.equal(line.files, null, 'no file breakdown on the wire: the row draws NOTHING')
    assert.equal(line.activeSubagents, 0)
    assert.equal(line.worktree, false)
    assert.equal(line.idleSince, 42)
    assert.equal(line.idleLabel, 'Idle')
    const working = lineOfRemoteRow({ ...row, activity: 'working' } as RemoteSessionRow)
    assert.equal(working.working, true)
    assert.equal(working.workingSince, 42)
    assert.equal(working.idleSince, null)
  }

  // The files its machine counted, drawn as a local line draws its own: the
  // branch's span, or what is left uncommitted once its pull request merged.
  {
    const changes = {
      added: 1,
      updated: 2,
      removed: 1,
      scope: 'worktree' as const,
      uncommitted: { added: 0, updated: 1, removed: 0 },
    }
    const row = { sessionId: 'r3', title: 'Gael Corry', activity: 'working', since: 5, changes, worktree: true }
    const line = lineOfRemoteRow({ ...row, pullRequests: [] } as unknown as RemoteSessionRow)
    assert.deepEqual(line.files, { added: 1, updated: 2, removed: 1 })
    assert.equal(line.changedFiles, 4)
    assert.equal(line.diffScope, 'worktree')
    assert.equal(line.worktree, true, 'the worktree its machine names')
    const merged = { url: 'https://github.com/acme/app/pull/9', number: 9, state: 'merged', title: 'Done' }
    const landed = lineOfRemoteRow({ ...row, pullRequests: [merged] } as unknown as RemoteSessionRow)
    assert.deepEqual(landed.files, { added: 0, updated: 1, removed: 0 })
    assert.equal(landed.diffScope, 'landed')
    const unscoped = lineOfRemoteRow({
      ...row,
      changes: { added: 1, updated: 0, removed: 0 },
      pullRequests: [],
    } as unknown as RemoteSessionRow)
    assert.equal(unscoped.diffScope, 'branch', 'a machine that names no scope is read as the branch’s')
  }

  // …and it SAYS what a local chat's line says: the opening of the agent's
  // last reply, read through the same preview, or the wait that needs a
  // person. An idle line counts from the agent's last finish, not from the
  // last time anything about the chat moved.
  {
    const row = {
      sessionId: 'r2',
      title: 'Gael Corry',
      cli: 'claude',
      activity: 'idle',
      phase: 'completed',
      replyPreview: '## Done\n\nThe **tests** pass now.',
      since: 900,
      lastTurnEndedAt: 700,
    } as RemoteSessionRow
    const line = lineOfRemoteRow(row)
    assert.equal(line.text, 'Done The tests pass now.', 'the reply as one line of prose, its markdown gone')
    assert.equal(line.idleSince, 700, 'idle since the agent last finished')
    assert.equal(lineOfRemoteRow({ ...row, replyPreview: null }).text, 'Ready', 'a machine that sends no preview')
    assert.equal(lineOfRemoteRow({ ...row, phase: 'running', activity: 'working' }).text, 'Thinking')
    assert.equal(
      lineOfRemoteRow({ ...row, phase: 'waiting_for_approval', activity: 'needs-input' }).text,
      'Needs approval',
    )
    assert.equal(
      lineOfRemoteRow({ ...row, phase: 'waiting_for_input', activity: 'needs-input' }).text,
      'Asked a question',
    )
    // The branch and pull requests its machine names, as a local line draws them.
    const pullRequest = {
      url: 'https://github.com/acme/app/pull/12',
      repoKey: 'github.com/acme/app',
      repoName: 'app',
      number: 12,
      title: 'Fix the upload',
      state: 'open',
      isDraft: false,
      openedAt: 0,
      stateAt: 0,
    } as const
    const named = lineOfRemoteRow({ ...row, branch: 'agent/fix-upload', pullRequests: [pullRequest] })
    assert.equal(named.branch, 'agent/fix-upload')
    assert.equal(named.worktree, false, 'no worktree claimed for a checkout this disk cannot see')
    assert.equal(named.cwd, null)
    assert.deepEqual(named.pullRequests, [pullRequest])
    const failed = lineOfRemoteRow({ ...row, phase: 'failed' })
    assert.equal(failed.text, 'Failed')
    assert.equal(failed.failed, true, 'a failure wears the failure mark, as a local line does')
  }

  // The numbers are the CHECKOUT's, whatever the agents' ledgers say (owner
  // ruling 2026-09-09, REVERSING "no git for a session that has a ledger"): the
  // hook ledger counts work done, which is not the outstanding diff. Two agents
  // on one branch therefore show the SAME number, and that is the right answer —
  // what is left on the branch is one fact about the branch.
  {
    const summaries = {
      '/repo': summary({ additions: 202, deletions: 122, changedFiles: 9, scope: 'branch', branch: 'feat/x' }),
    }
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({
          sessionId: 's1',
          lastOutputAt: 20,
          fileChanges: [edited('/repo/src/a.ts', 10, 4), edited('/repo/src/b.ts', 6, 1, 3)],
        }),
        session({ sessionId: 's2', agentId: 'a2', lastOutputAt: 10, fileChanges: [edited('/repo/src/c.ts', 2, 0)] }),
      ],
      meshPanes: [],
      summaries,
    })
    assert.deepEqual(
      lines.map((line) => [line.name, line.additions, line.deletions, line.changedFiles, line.diffScope]),
      [
        ['Aine Carey', 202, 122, 9, 'branch'],
        ['Conor Kirby', 202, 122, 9, 'branch'],
      ],
      'the branch span on both lines; no ledger anywhere near the sidebar number',
    )
    assert.equal(lines[0].branch, 'feat/x')
    // And the ledger still rides the snapshot untouched, for the peek and the
    // changelist: the line simply does not read it.
    assert.equal(lines[0].changedFiles, 9, 'the summary\u2019s file count, not the ledger\u2019s')
  }

  // A session in a worktree of its own reads THAT worktree's span — the
  // exclusive checkout keeps the scope git gave it, ledger or no ledger.
  {
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({ sessionId: 's1', observedCheckout: worktreeObserved, fileChanges: [edited('/repo/src/a.ts', 9, 2)] }),
      ],
      meshPanes: [],
      summaries: {
        '/repo/.claude/worktrees/rail': summary({
          branch: 'worktree-workspace-rail',
          additions: 1048,
          deletions: 21762,
          scope: 'worktree',
        }),
      },
    })
    assert.deepEqual([lines[0].additions, lines[0].deletions, lines[0].diffScope], [1048, 21762, 'worktree'])
    assert.equal(lines[0].branch, 'worktree-workspace-rail')
    assert.equal(lines[0].worktree, true)
  }

  // A shell reads its checkout like every other line, whatever arrives on its
  // snapshot — and it claims none of the session's own facts (subagents included).
  {
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({
          sessionId: 'shell',
          kind: 'terminal',
          cli: undefined,
          agentId: undefined,
          fileChanges: [edited('/repo/src/a.ts', 5, 5)],
          activeSubagents: 2,
        }),
      ],
      meshPanes: [],
      summaries: { '/repo': summary({ additions: 202, deletions: 122 }) },
    })
    assert.deepEqual([lines[0].additions, lines[0].deletions, lines[0].diffScope], [202, 122, 'folder'])
    assert.equal(lines[0].activeSubagents, 0)
  }

  // An agent that has written nothing, and one whose snapshot predates the
  // ledger field, read the checkout exactly like every other line.
  {
    const summaries = { '/repo': summary({ additions: 202, deletions: 122, changedFiles: 9, scope: 'folder' }) }
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({ sessionId: 'empty', fileChanges: [] }),
        // A snapshot from before the field existed (a parked session restored
        // from an older sidecar) must not throw or claim a session reading.
        session({ sessionId: 'absent', agentId: 'a2', fileChanges: undefined as never }),
      ],
      meshPanes: [],
      summaries,
    })
    for (const line of lines) {
      assert.deepEqual(
        [line.additions, line.deletions, line.changedFiles, line.diffScope, line.activeSubagents],
        [202, 122, 9, 'folder', 0],
        `${line.key} keeps the checkout reading`,
      )
    }
  }

  // A mesh pane claims nothing at all: its checkout is another machine's disk.
  {
    const meshOnly = terminalLinesOf({
      workspace: workspace(),
      sessions: [],
      meshPanes: [{ tabId: 'mesh-conversation:c1:ws-9:agent-9', machineName: 'air.local', cli: 'codex' }],
      summaries: {},
    })
    assert.equal(meshOnly.lines[0].activeSubagents, 0, 'a pane on another machine reports no subagents')
    assert.equal(meshOnly.lines[0].changedFiles, 0)
    assert.equal(meshOnly.lines[0].files, null, 'and nothing to draw')
    assert.equal(meshOnly.lines[0].diffScope, 'folder')
  }

  // Subagents ride the line for a later renderer; nothing draws them yet.
  {
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [session({ sessionId: 's1', activeSubagents: 3 })],
      meshPanes: [],
      summaries: {},
    })
    assert.equal(lines[0].activeSubagents, 3)
  }

  // The numbers ARE files (owner decision 2026-09-09): green is what the checkout
  // gained or reworked, red what it lost, and the two are one glance. The words
  // are what say which files did what.
  {
    assert.deepEqual(changedFileMarks({ added: 2, updated: 1, removed: 1 }), { plus: 3, minus: 1 }, '+3 \u22121')
    assert.deepEqual(
      changedFileMarks({ added: 0, updated: 0, removed: 0 }),
      { plus: 0, minus: 0 },
      'and nothing to draw',
    )
    assert.equal(changedFilesPhrase({ added: 2, updated: 1, removed: 1 }), '2 files added, 1 updated, 1 removed')
    assert.equal(
      changedFilesPhrase({ added: 1, updated: 1, removed: 1 }),
      '1 file added, 1 updated, 1 removed',
      'one file is one file',
    )
    assert.equal(
      changedFilesPhrase({ added: 0, updated: 2, removed: 1 }),
      '2 files updated, 1 removed',
      'a zero part is left out, and the noun moves',
    )
    assert.equal(changedFilesPhrase({ added: 0, updated: 0, removed: 1 }), '1 file removed')
    assert.equal(changedFilesPhrase({ added: 3, updated: 0, removed: 0 }), '3 files added')
    assert.equal(
      changedFilesPhrase({ added: 0, updated: 0, removed: 0 }),
      'No files changed',
      'never drawn, still true',
    )
  }

  // The scope's words, one place for both spellings: the tooltip and the
  // sentence a screen reader hears say the same sentence, so the numbers in them
  // cannot drift. Only a folder reading — the one nobody can be credited with —
  // steps back; `landed` names the pull request that moved the number.
  {
    const files = { added: 2, updated: 1, removed: 1 }
    const worktree = diffScopeCopy({ diffScope: 'worktree', branch: 'agent/x', files, pullRequests: [] })
    assert.equal(
      worktree.tooltip,
      '2 files added, 1 updated, 1 removed \u2014 changed by this terminal, which has a worktree of its own',
    )
    assert.equal(worktree.srText, worktree.tooltip, 'one sentence, two places')
    assert.equal(worktree.dim, false)

    const branch = diffScopeCopy({ diffScope: 'branch', branch: 'feat/y', files, pullRequests: [] })
    assert.equal(
      branch.tooltip,
      '2 files added, 1 updated, 1 removed \u2014 changed on feat/y; this terminal shares the checkout, so a person or another terminal may have made some of it',
    )
    assert.equal(branch.srText, branch.tooltip)
    const branchless = diffScopeCopy({
      diffScope: 'branch',
      branch: null,
      files: { added: 1, updated: 0, removed: 0 },
      pullRequests: [],
    })
    assert.match(branchless.srText, /^1 file added \u2014 changed on this branch;/)

    const folder = diffScopeCopy({
      diffScope: 'folder',
      branch: 'main',
      files: { added: 0, updated: 4, removed: 0 },
      pullRequests: [],
    })
    assert.equal(
      folder.tooltip,
      '4 files updated \u2014 uncommitted in this folder; this terminal has no branch of its own',
    )
    assert.equal(folder.dim, true, 'the repo\u2019s state is nobody\u2019s work, so it steps back')

    // The landed line says WHY it shrank, and says it to a screen reader too —
    // the tooltip is portalled on hover and AT never gets it.
    const landed = diffScopeCopy({
      diffScope: 'landed',
      branch: 'feat/y',
      files: { added: 1, updated: 1, removed: 1 },
      pullRequests: [pr({ number: 418, state: 'merged' })],
    })
    assert.equal(
      landed.tooltip,
      // design-tokens-allow: the literal is a pull request NUMBER in the tooltip's own words, not a colour
      '1 file added, 1 updated, 1 removed \u2014 uncommitted here since pull request #418 was merged',
    )
    assert.equal(landed.srText, landed.tooltip)
    assert.equal(landed.dim, false, 'what the checkout still carries is attributable work')
    // A line drawn without the record it came from still says the branch landed
    // rather than claiming a number it does not have.
    const anonymous = diffScopeCopy({ diffScope: 'landed', branch: 'feat/y', files, pullRequests: [] })
    assert.match(anonymous.tooltip, /uncommitted here since its pull request was merged$/)
  }

  // The workspace header's branch chip says the same thing in the same words —
  // the branch, the agent whose OWN worktree it is, the breakdown — and nothing
  // that instructs the person ("select another tab to follow it" is gone).
  {
    const own = branchChipCopy({ branch: 'main', agent: null, files: { added: 1, updated: 1, removed: 1 } })
    assert.equal(own.tooltip, 'main \u2014 1 file added, 1 updated, 1 removed')
    assert.equal(own.spoken, ', 1 file added, 1 updated, 1 removed')
    assert.doesNotMatch(own.tooltip, /following|select another tab/)

    const worktree = branchChipCopy({
      branch: 'agent/rail',
      agent: { name: '\u00c1ine Carey', runtime: 'Claude Code' },
      files: { added: 0, updated: 2, removed: 1 },
    })
    assert.equal(
      worktree.tooltip,
      'agent/rail \u00b7 \u00c1ine Carey\u2019s worktree (Claude Code) \u2014 2 files updated, 1 removed',
    )
    assert.equal(worktree.spoken, ', \u00c1ine Carey\u2019s worktree (Claude Code), 2 files updated, 1 removed')
    assert.equal(
      branchChipCopy({ branch: 'agent/rail', agent: { name: '\u00c1ine Carey', runtime: null }, files: null }).tooltip,
      'agent/rail \u00b7 \u00c1ine Carey\u2019s worktree',
      'no breakdown, no numbers \u2014 and no invented ones',
    )

    // A clean checkout, and a checkout whose summary carries no breakdown, both
    // say the branch and stop.
    assert.equal(
      branchChipCopy({ branch: 'main', agent: null, files: { added: 0, updated: 0, removed: 0 } }).tooltip,
      'main',
    )
    assert.equal(branchChipCopy({ branch: 'main', agent: null, files: null }).spoken, '')
    assert.equal(branchChipCopy({ branch: null, agent: null, files: null }).tooltip, 'Detached HEAD')
  }

  // The whole of decision 2, stated on the pure function: a merged PRIMARY pull
  // request with an uncommitted reading beside it lands the line; everything
  // else keeps the span, and nothing ever invents a zero.
  {
    const span = summary({ additions: 202, deletions: 122, changedFiles: 9, scope: 'branch', branch: 'feat/x' })
    const withUncommitted = {
      ...span,
      uncommitted: { additions: 3, deletions: 1, changedFiles: 2, files: { added: 1, updated: 1, removed: 0 } },
    }

    assert.deepEqual(
      lineDiffOf(withUncommitted, [pr({ state: 'merged' })]),
      { additions: 3, deletions: 1, changedFiles: 2, files: { added: 1, updated: 1, removed: 0 }, scope: 'landed' },
      'a squash-landed branch shows what the checkout still carries — including WHICH files',
    )
    assert.deepEqual(
      lineDiffOf(span, [pr({ state: 'merged' })]),
      { additions: 202, deletions: 122, changedFiles: 9, files: { added: 5, updated: 3, removed: 1 }, scope: 'branch' },
      'a reading we could not take degrades to the span, never to a confident zero',
    )
    assert.deepEqual(
      lineDiffOf(withUncommitted, [pr({ state: 'open' })]).scope,
      'branch',
      'an open primary keeps the span',
    )
    // A merged pull request the agent opened in ANOTHER repository (union,
    // pull-request-marks decision 10) says nothing about this branch: main did
    // not stamp it on the session's branch, so the line keeps the span.
    assert.deepEqual(
      lineDiffOf(withUncommitted, [
        pr({
          state: 'merged',
          onSessionBranch: false,
          repoName: 'website',
          url: 'https://github.com/acme/website/pull/9',
        }),
      ]).scope,
      'branch',
      'a merged pull request elsewhere does not land this branch',
    )
    assert.deepEqual(
      lineDiffOf(withUncommitted, [pr({ state: 'closed' })]).scope,
      'branch',
      'closed without merging is not landed',
    )
    assert.deepEqual(lineDiffOf(withUncommitted, []).scope, 'branch', 'no pull request at all keeps the span')
    // Decision 5's primary rule doing the work: a NEW open pull request on a
    // branch whose earlier one merged is the primary, so the line goes back to
    // the span — the branch has work outstanding again.
    assert.deepEqual(
      lineDiffOf(withUncommitted, [
        pr({ number: 418, state: 'merged', openedAt: 1_000 }),
        pr({ number: 420, state: 'open', openedAt: 2_000, url: 'https://github.com/acme/sprintengine/pull/420' }),
      ]).scope,
      'branch',
      'a newer open pull request takes the mark back, and the number with it',
    )
    // An unresolved checkout has no summary to read: exactly what it drew before.
    assert.deepEqual(
      lineDiffOf(undefined, [pr({ state: 'merged' })]),
      { additions: 0, deletions: 0, changedFiles: 0, files: null, scope: 'folder' },
      'no reading at all is not a landed reading',
    )

    // The breakdown is the ONE thing that may not be improvised. A summary from a
    // main that predates it — or one whose span git could not read — has lines and
    // no files, and the line then draws nothing rather than drawing the lines in a
    // place that means files.
    const { files: spanFiles, ...withoutFiles } = span
    void spanFiles
    assert.equal(lineDiffOf(withoutFiles, []).files, null, 'lines without files draw NOTHING')
    assert.equal(
      lineDiffOf(withoutFiles, []).additions,
      202,
      'the line counts still ride along for the surfaces that read them',
    )
    const landedWithoutFiles = { ...span, uncommitted: { additions: 3, deletions: 1, changedFiles: 2 } }
    assert.equal(
      lineDiffOf(landedWithoutFiles, [pr({ state: 'merged' })]).files,
      null,
      'a landed line never borrows the span\u2019s breakdown for the uncommitted reading',
    )
  }

  // And end to end on the line: the merged pull request main put on the snapshot
  // switches the numbers on the very next render, with no extra read.
  {
    const summaries = {
      '/repo': summary({
        additions: 202,
        deletions: 122,
        changedFiles: 9,
        scope: 'branch',
        branch: 'feat/x',
        uncommitted: { additions: 3, deletions: 1, changedFiles: 2, files: { added: 0, updated: 2, removed: 0 } },
      }),
    }
    const merged = terminalLinesOf({
      workspace: workspace(),
      sessions: [session({ sessionId: 's1', pullRequests: [pr({ number: 418, state: 'merged' })] })],
      meshPanes: [],
      summaries,
    })
    assert.deepEqual(
      [merged.lines[0].additions, merged.lines[0].deletions, merged.lines[0].changedFiles, merged.lines[0].diffScope],
      [3, 1, 2, 'landed'],
    )
    assert.deepEqual(
      merged.lines[0].files,
      { added: 0, updated: 2, removed: 0 },
      'and the breakdown the line draws is the uncommitted one',
    )
    assert.equal(merged.lines[0].branch, 'feat/x', 'the branch it landed from is still named')
    const open = terminalLinesOf({
      workspace: workspace(),
      sessions: [session({ sessionId: 's1', pullRequests: [pr({ number: 418, state: 'open' })] })],
      meshPanes: [],
      summaries,
    })
    assert.deepEqual([open.lines[0].additions, open.lines[0].diffScope], [202, 'branch'])
  }

  // The pull requests a line wears come straight off the session snapshot (epic
  // pull-request-marks, decision 10): main owns the union, the line only carries
  // it. An older snapshot that carries none reads as none — an absent answer and
  // an empty one draw the same thing, which is nothing.
  {
    const opened = {
      url: 'https://github.com/acme/sprintengine/pull/418',
      repoKey: 'github.com/acme/sprintengine',
      repoName: 'sprintengine',
      number: 418,
      title: 'Extensions icon carries its unread count',
      state: 'open' as const,
      isDraft: false,
      openedAt: 1_000,
      stateAt: 2_000,
    }
    const { lines } = terminalLinesOf({
      workspace: workspace(),
      sessions: [
        session({ sessionId: 's1', pullRequests: [opened], lastOutputAt: 20 }),
        session({ sessionId: 's2', agentId: 'a2', lastOutputAt: 10 }),
        session({ sessionId: 's3', kind: 'terminal', agentId: undefined, lastOutputAt: 5 }),
      ],
      meshPanes: [{ tabId: 'pane-1', machineName: 'Mini' }],
      summaries: {},
    })
    const byKey = new Map(lines.map((line) => [line.key, line.pullRequests]))
    assert.deepEqual(byKey.get('s1'), [opened], 'the agent line wears what its snapshot carries')
    assert.deepEqual(byKey.get('s2'), [], 'a snapshot with no answer draws what an empty one draws')
    assert.deepEqual(byKey.get('s3'), [], 'a plain shell has no conversation to have opened one')
    assert.deepEqual(byKey.get('pane-1'), [], 'a mesh pane’s checkout is another machine’s')
  }

  console.log('terminalLines: ok')
})
