# Pooled agent worktrees

Status: **built** (owner ruling 2026-10-05), in `src/main/worktree-pool/`. A
first implementation merged as #52 and was reverted by #54; its code stays
reachable at commit `301b64159`. Section 5 says how this one differs; sections
2–4 are the history it was built from.

## 1. The problem

Every agent that works in its own git worktree today gets a fresh one:
`git worktree add`, then — because a new worktree has no installed
dependencies — the agent pays for `npm install` (or the language's equivalent)
before its tests pass. On a warm macOS cache that is a few seconds; on Windows,
with a cold cache, or with native rebuilds it is much longer, and each worktree
holds its own copy of the dependencies on disk.

A pool keeps finished worktrees (with their dependencies) instead of deleting
them, and hands one to the next agent after resetting it to a clean base.

## 2. Why the first implementation was reverted

- **It worked while nobody asked for it.** Warm slots were refreshed every 30
  minutes and dependencies reinstalled in the background, costing CPU, disk and
  battery on machines where the pool might never be used.
- **It silently changed the base branch.** New chat and "+ Worktree" started
  handing out `origin/<default>` instead of the checkout's current branch, so a
  person working on a feature branch got an agent on main without asking.
- **Hand-out could be stale.** A lease did not fetch first, so a slot could be
  up to 30 minutes behind origin.
- **Installs only understood JavaScript lockfiles.**
- **Agents that create worktrees themselves bypassed it entirely.**

What it got right, and should be kept: the reset that preserves ignored files
(`read-tree --reset -u <sha>` then `clean -fd`, never `-x`), detached idle
slots, `git worktree lock` while leased, holding (never resetting) a dirty
return, lease ids in worktree identity, crash-safe per-step state, removal of
files the app wrote per agent (`.mcp.json` and similar) before reuse, and one
pool per repository and machine so Windows and WSL never share slots.

## 3. Decisions taken

| Decision                | Ruling                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle cost               | None. The pool is finished worktrees kept on disk; no timers, no background refresh, no idle installs. The only idle cost is disk.                                                                                                                                              |
| When a slot is prepared | On intent: when the person turns on the Worktree chip in New chat or starts typing its name, fetch once and reset a free slot to the chosen base in the background, so it is ready by the time they press Enter.                                                                |
| Base                    | `origin/<default branch>` by default, with a base-branch picker in New chat. A feature-branch base still reuses a pooled slot and switches it to that base.                                                                                                                     |
| Installs                | Off unless the project opts in (Settings ▸ Worktrees). Then after hand-out, and only when the install fingerprint changed since the worktree last installed. A command is inferred for npm, pnpm, yarn and bun only; a per-project command covers anything else. See section 5. |
| Pool size               | Keep 1–3 finished worktrees per repository; anything beyond that is removed by the automatic agent-worktree cleanup (#57's rules).                                                                                                                                              |
| Slot paths              | Stable and reused (`.sprintengine-worktrees/<repo>/pool-NN`). Accepted trade-off: a CLI's own per-directory resume history mixes across leases; the app always resumes by session id.                                                                                           |
| Agent branches          | Kept on return (the slot is detached, the branch stays).                                                                                                                                                                                                                        |
| Dirty returns           | Held, locked and never reset; the Worktree manager offers Commit, Stash, Discard and Keep.                                                                                                                                                                                      |
| WSL                     | A pool per machine; WSL pools run through the distribution's git via the Linux helper.                                                                                                                                                                                          |
| Review                  | Before it ships, the design is checked against the bug history of existing open-source worktree-pool tools, and every class of bug they hit is shown handled or fixed.                                                                                                          |

## 4. Open questions

1. **Agents that create worktrees themselves.** Offer an MCP tool ("get me a
   worktree") and tell agents to use it through the Studio skill, or install a
   `git` shim on the agent's `PATH` that routes `git worktree add` to the pool?
   The tool is simpler and less surprising; the shim covers everything.
2. **Prepare-on-intent triggers.** Is turning the Worktree chip on enough, or
   should typing the prompt first and turning it on afterwards also count? What
   happens when the person abandons New chat — keep the prepared slot warm or
   leave it?
3. **Default base.** `origin/<default>` (decided above) or the checkout's
   current branch, which is what New chat did before the pool?
4. **Where install progress shows.** In the agent's terminal before the CLI
   starts, as a banner, or silently in the background with a failure notice?
5. **Untrusted repositories.** Automatic installs run a repository's install
   scripts without asking. Acceptable for all repositories, or only ones the
   person has marked trusted?
6. **Adopting existing worktrees.** Should agent worktrees made outside the
   pool (or by an agent) be adopted into it when they are finished, instead of
   removed?
7. **Merged agent branches.** Keep them indefinitely, or delete them once
   merged into the default branch?
8. **Scheduled agents.** Each run of a scheduled agent is a new chat, started
   with no window open and with the worktree setting the agent was made with.
   Should those runs keep creating and removing their own worktrees, or lease
   from the pool?
9. **Disk cap and eviction.** Defaults (the first implementation used 20 GB and
   7 days idle) and whether the person sees them in Settings.

## 5. What was built (2026-10-05)

The owner's rulings on restarting the work, and how the open questions above
were settled:

- **Installs only when a project asks, and only when the lockfile changed**
  (owner ruling 2026-10-06, revising the 2026-10-05 "no installs, ever"). The
  first ruling held that the pool never runs a package manager: a reused slot
  keeps the last agent's ignored files (`node_modules`, build output, a virtual
  environment), so the next agent's own install is incremental or unnecessary,
  and nothing runs a repository's scripts that the person did not start. Both
  halves still hold for the pool itself, which never installs and never does
  anything in the background. What changed is the hand-out: a project may now
  opt in (Settings ▸ Worktrees, on the project's card; off by default), and
  then a leased slot installs before its agent starts when its lockfile
  differs from the one it last installed with. That answers question 5 the
  cautious way: an install runs the repository's own scripts with the
  person's rights, so it happens only where the person turned it on.
  - **Where.** `createAgentWorktreeFromPool` (git.ts), which every agent
    worktree goes through: after the lease, or after the fresh worktree made
    because the pool declined (full, held by another Studio, off), which is the
    worktree that needs it most. New chat, the tab strip's worktree spawn and
    scheduled runs wait for it. A gateway call does not: `agent.launch`,
    `backlog.work` and `conversation.create` answer while it runs, because the
    caller's client gives up on a call long before an install ends and a retry
    would be a second agent in a second worktree. `agent.launch` answers with
    the agent's id and state `installing_dependencies`, which `agent.status`
    reports (then `starting`, until the agent's start is confirmed), and starts
    the agent when the install ends; `conversation.create`
    makes the chat and its session at once, says `dependencyInstall` in its
    answer and in the chat's composer tray, and sends the first message when
    the install ends. However it ends, the agent starts. A reclaimed settled
    chat, a worktree forked from a named base ref and `worktree.lease` do not
    install.
  - **When.** The worktree's record is a fingerprint of everything the
    install's result depends on: the command, the lockfile it reads, the
    package manager version `packageManager` declares, the Node version
    (`node -v` in the install's environment, for a JavaScript project),
    `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `pnpm-workspace.yaml` and `patches/`
    (names and contents, bounded). It is kept in the worktree's git admin
    directory (`.git/worktrees/<slot>/sprintengine-dependencies.json`): outside
    the worktree, so `clean -fd` and "Clear ignored files" never reach it,
    ignored by git, and gone with the worktree's registration. It runs when the
    record is missing, differs, or `node_modules` (or Yarn's `.pnp.cjs`) is
    gone. The record is cleared before an install starts (an install whose
    record cannot be cleared does not run) and written only when it succeeds,
    so a failed, timed-out, cancelled or quit-stopped one runs again at the
    next lease.
  - **What.** Inferred from the lockfile, never one that rewrites it: `npm ci`,
    `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` (Yarn 1)
    or `--immutable` (Yarn 2+), `bun install --frozen-lockfile`;
    `packageManager` in package.json breaks a tie between lockfiles. A
    project's own command replaces it, and then every lockfile present
    (Cargo, uv, Poetry, Bundler, Composer and Go's included) counts, since
    nothing says which it reads. Other ecosystems get no inferred command. It
    runs through the platform shell with the person's whole login environment
    (an interactive login shell's for bash, zsh and the ksh family, a login
    shell's for fish and the rest; `worktree-pool/install-environment.ts`), so
    a registry token, a proxy or `NODE_EXTRA_CA_CERTS` their profile exports
    reaches it; none of the app's own `SPRINTENGINE_*` variables do. On
    Windows it gets the app's environment, less those. It runs as a process
    group of its own, and quitting the app stops every install still running,
    the whole group (`taskkill /T` on Windows).
  - **How it shows** (question 4). A toast that stays while it runs ("npm ci
    in pool-03: the lockfile changed. The agent starts when it finishes."),
    re-shown in place as it ends; the worktree's row in Settings ▸ Worktrees
    says it is installing, with its last output line and Cancel. The agent
    waits for it, and starts whatever came of it: a failure, a timeout (20
    minutes) or a cancel is a warning toast and a bell row carrying what the
    install printed, never a withheld chat.
- **Always the default branch.** Every agent worktree forks from
  `origin/<default>`, fetched at hand-out (at most once a minute per
  repository, and never waiting more than ten seconds; offline it forks from
  what the ref already says). That settles question 3. There is no base-branch
  picker yet; `agent.launch` with an explicit `worktree.baseRef` still forks
  that ref, outside the pool.
- **No idle cost.** No timers refresh or warm anything. A slot is reset to the
  base when it is leased, not when it is returned. The only timer is the
  instance lock's heartbeat, which touches one file.
- **Prepared on intent (2026-10-09).** New chat with Worktree on and no name
  typed leases a slot for the chat it is about to start (and installs, when
  the project opted in) a moment after it settles on a project, so Enter
  finds it made; that settles question 2. Turning Worktree off, moving to
  another project or closing New chat gives it back, clean, and its empty
  branch goes at the next sweep. Still no idle cost: nothing is prepared
  unless New chat is open on a project. A slot kept past 15 minutes is given
  back on Enter rather than hand out a stale base
  (`renderer/src/utils/newChatWorktree.ts`).
- **One way in.** `createGitWorktree({ fromPool: true })` leases a slot when
  the process keeps a pool (the desktop's main), and otherwise creates a fresh
  worktree from the same base (the out-of-process server, a WSL machine, the
  pool turned off). New chat, the tab strip's worktree spawn, `agent.launch`
  and scheduled runs all go through it. That settles question 8.
- **Agents that want a worktree** call `worktree.lease` (and optionally
  `worktree.release`) instead of `git worktree add` (question 1: the tool, not
  a shim). The lease is the calling agent's and is kept while that agent
  exists.
- **Returns ride the agent worktree cleanup.** The sweep that already knows
  every path the app's records use hands each unused slot back to the pool
  instead of removing it; the pool detaches it (branch kept), clears the
  per-agent files and unlocks it. A lease never seen in use is left alone for
  an hour. Dirty returns are held, and the Worktree manager offers Commit,
  Stash, Discard and Keep on them.
- **Merged agent branches are deleted** by the same sweep once no worktree has
  them checked out, no chat or worktree entry records them, and their work is
  on the default branch, squash merges included (question 7). A branch a chat
  still records is kept: a settled chat is restored from it.
- **Settled chats.** A settled chat in a pool slot offers it to the sweep like
  any settled worktree chat; the slot goes back to the pool and the chat is
  marked reclaimed. Opening the chat again asks the pool for that same slot
  (`reclaim`), which checks the chat's branch out in it again, ignored files
  and all. Leases take the least recently used idle slot, so a just-settled
  chat's slot is the last to go to someone else; if it has gone, the chat is
  told why.
- **Pool size.** Up to three idle slots per repository are kept (setting
  `keepIdle`); a return beyond that removes the least recently used. A
  repository's pool holds at most `maxSlots` (default 12, at most 32), leased
  ones included; past it a lease falls back to a plain worktree.
- **Ready slots expire, and other worktrees are swept too** (owner ruling
  2026-10-08). A ready slot unused for a day is removed whatever `keepIdle`
  says, so a project left alone drops its pool to nothing; every sweep ages
  them, not only a return. Worktrees the pool does not own (made by hand, by
  an agent CLI, in the Worktree manager) are no longer left for good: the
  sweep removes one that is clean, unlocked and has nothing ignored at risk
  once it has gone unused for a day with its work on the default branch, or
  for a week with its commits on a branch (the branch is kept). "Unused" is
  when its index or HEAD last moved; a `git gc` rewrites every worktree's
  reflog and admin folder, so those say nothing about use.
- **A settled chat counts as deleted** (owner ruling 2026-10-08). Unless
  someone has it open, nothing it records keeps anything: its folder, its
  agents' worktrees and leases, and its branches are released to the sweep,
  and its history in a slot or worktree no longer keeps that folder. An agent
  worktree nothing uses goes even unmerged, its commits staying on its
  `agent/` branch (never deleted while unmerged), as a returned slot's do.
  Reopening the chat checks its branch out again while the branch is there.

## 6. Settings ▸ Worktrees (2026-10-05)

The pool made visible (mockup: `docs/design/mockups/worktree-pool-settings.html`).
One page lists every worktree of every local project the window knows, plus
every pool on record: the pool's slots with who holds each (the chat, matched
by path, or the agent that called `worktree.lease`), and the worktrees the pool
does not own (made by hand, by an agent before the pool, kept out of it), each
with whether its work is on the default branch, its uncommitted changes and
its size. Main reads it (`worktree-pool/worktree-inventory.ts`); the page never
runs git.

- **Sizes** are measured with `du` (a walk on Windows) only when the page opens
  or asks again, and, while a disk limit is set, when a slot comes back. Never
  on a timer. The breakdown names the biggest top-level folders, which is where
  the space is (`node_modules`, build output).
- **Disk limit** (question 9): `diskLimitGb`, off by default. Past it, idle
  slots go least recently used first, across every pool; a leased or held slot
  is never removed, so the pools can stay over it. Worktrees outside the pool do
  not count.
- **Removing.** A ready slot is removed through the pool, which keeps one whose ignored files may be someone's work (an edited `.env`, an unknown file) as the agent worktree cleanup does, until its ignored files are cleared; what the app and the agent CLIs wrote there (`.sprintengine/`, installed skills, `.mcp.json`) and a linked `node_modules` never keep it, except the history of a chat still on record (`.sprintengine/conversations/<chat>/`: a settled chat's slot is given back while the chat stays, and is reclaimed when it is reopened), which keeps it until the chat is deleted and which clearing its ignored files leaves alone; a kept slot says why on the page; anything else through
  `removeGitWorktree`, which refuses a dirty tree. Neither deletes a branch. A
  worktree an open chat works in, one with changes, and one locked by another
  profile cannot be removed from the page, and each says why.
- **Free up space** offers only what loses nothing: ready slots beyond the most
  recently used one per project, clean merged worktrees outside the pool, and
  clearing a kept slot's ignored files (`git clean -dX`, at the price of the
  next install). Unmerged worktrees are named but never ticked.

Still open: adopting worktrees made outside the pool (question 6), WSL and
network-share projects on the page, and a settled chat whose slot was given to
another agent: today it is told so and opens without its folder, where it
could take a slot of its own on its branch instead.
