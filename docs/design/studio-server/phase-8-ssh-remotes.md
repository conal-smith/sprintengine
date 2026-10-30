# Phase 8 — Remote environments over SSH

Status: scoped, 2026-10-01; built 2026-10-03 as section 14 says. This expands phase 8
of `docs/design/studio-server.md` (section 13) and sections 9.4 and 10.3 that it
builds on. Where this file and the parent disagree, section 12 below lists what
the parent should change. When code and this file disagree, fix one of them in
the same change.

Amended 2026-10-02 for the owner ruling of that date: the server has no
browser and no canvas. The remote gets no Chromium; the desktop's own pane
reaches the remote through the SSH connection instead (6.8), and the canvas is
the desktop's toolset (phase 5, `phase-5-client-tools.md`).

Owner defaults this scope is built on (2026-10-01):

- A remote CLI signs in through its device-code flow where it has one;
  otherwise through one narrow, sign-in-only terminal exception.
- On a remote host, secrets go in the system keyring, or an owner-only file
  where there is none.
- No terminals on the server in v1 (ruling a).

## 1. What this phase delivers

A person adds `build-box` (an alias from their own `~/.ssh/config`, or
`dev@build-box.example.com:2222`) as an environment. Studio:

1. resolves the alias with the system `ssh -G`, connects with the person's own
   config, agent and keys, and asks in a Studio dialog for anything ssh needs
   to ask (a host key on first connect, a passphrase, a password, a one-time
   code);
2. finds out what the machine is (OS, CPU, libc, home, free space, whether its
   home can execute files, what is already installed and running);
3. installs the pinned Node and the server bundle that match this desktop, by
   streaming them over the SSH session — the remote needs no network, no `curl`
   and no root — or, when the owner allows it, by having the remote download a
   matching release that the desktop names by digest;
4. starts a **managed** server there, or attaches to one that is already
   running (a server the app started earlier, or an **external** one somebody
   started by hand or as a service);
5. carries the Studio protocol over the SSH session's own stdio to the server's
   owner socket. The server listens on no TCP port at all, and the desktop
   opens no local port or socket for it;
6. shows the machine as one more environment in the sidebar, the New chat
   machine menu and Settings → Machines, with its state in words;
7. survives sleep, roaming and a dropped connection by reconnecting and
   resuming every stream from its cursor (`afterSeq` and `generation`);
8. upgrades a managed server by installing the new bundle beside it, draining
   the old one and starting the new one; never touches an external server or a
   newer one; and says plainly when versions cannot talk;
9. sends the desktop pane's traffic for that machine's workspaces through the
   same SSH session, so an agent's `browser.open http://localhost:5173` shows
   the remote's dev server in the person's own pane (6.8). Nothing is installed
   on the remote for it.

Out of scope: terminals on the remote (ruling a), a native Windows server
reached over SSH (parent, non-goals), our own SSH implementation, multi-user
servers, the web client (phase 9).

## 2. Where things stand today

- **No SSH anywhere.** The tree runs `ssh` only indirectly, as git's transport,
  and always closed: `git-clone.ts` sets `GIT_SSH_COMMAND='ssh -oBatchMode=yes'`
  and `skills/git-repo-reader.ts` sets `SSH_ASKPASS_REQUIRE=never`. There is no
  askpass shim, no host-key handling and no `ssh_config` reading to reuse.
- **Execution hosts are not environments.** `src/shared/execution-host.ts`
  models `local` and `wsl:<distro>` as places main runs processes, and says in
  its header that a paired remote "is a different kind of thing … and is not a
  host". An SSH remote is the same kind of thing as a paired remote: a whole
  server with its own `local` host. `ExecutionHostId` does **not** grow an
  `ssh:` variant (section 12, change 1).
- **The WSL install is the template, but not portable as written.**
  `wsl-install.ts` stages, streams a tar into `tar -x`, commits under `flock`
  with a digest marker and `mv -T`, and prunes versions no process names in
  `/proc/*/cmdline`. Three of those are Linux-only: macOS has no `flock` (the
  script then skips the lock silently), no `mv -T` (there is a fallback), and
  no `/proc` (so `live()` is always false and a version a running server uses
  can be pruned under it). `wsl-node-runtime.ts` pins only `linux-x64` and
  `linux-arm64`, extracts only `bin/node` (no npm), and downloads with Node's
  `fetch`, which does not use the system proxy.
- **The tailnet lane** (`automation/tailnet/`) already has what SSH needs on
  the server side: a hand-rolled WebSocket server, single-use tickets, scopes
  read live, close codes 4401/4403/4409, a JSONL audit log, and a mesh client
  with reachability tracking and backoff (`tailnet-mesh-service.ts`,
  `MeshMachineReachability`). The SSH route reuses the stream semantics and the
  reachability model; it does not need pairing, because an SSH login already
  proves who the person is on that host.
- **Sign-in** opens a terminal today: `conversation-sign-in.ts` builds the
  line a plain Studio terminal runs (`claude auth login`).

## 3. Experiments and what they showed

All run on macOS 26 (OpenSSH 10.0p2) against an unprivileged `sshd` on
`127.0.0.1:2222` that admitted only scratch keys, and against Linux
containers (Ubuntu 24.04 with dash; Alpine with busybox and musl; an Ubuntu
`sshd` container shaped like the CI fixture in section 9). Scripts and logs are
not in the tree; each result below names what it changes.

| # | Experiment | Result | Consequence |
| --- | --- | --- | --- |
| E1.1 | `ssh -G <alias>` with `ProxyJump` in the config | Prints the resolved `hostname`, `port`, `user`, `proxyjump`, `controlmaster`, `stricthostkeychecking`, `userknownhostsfile`, `forwardagent` without connecting | Resolve aliases with `ssh -G`, never by parsing `ssh_config` ourselves; `Include`, `Match` and `ProxyJump` come for free |
| E1.2 | First connect, `StrictHostKeyChecking=ask`, no tty, `SSH_ASKPASS_REQUIRE=force`, askpass answers `no` | askpass receives the full question including `ED25519 key fingerprint is SHA256:…`; ssh exits 255 with "Host key verification failed."; `known_hosts` untouched | First-connect TOFU can go through the askpass dialog with the real fingerprint, and a refusal is clean |
| E1.3 | Same, askpass answers `yes` | "Permanently added … to the list of known hosts", connected, one line in `known_hosts` | Acceptance is written by ssh itself, to the file the person's config names |
| E1.4 | `BatchMode=yes` and an unknown host | No prompt, exit 255, "Host key verification failed." | `BatchMode=yes` is the right mode for background reconnects; it never hangs on a prompt |
| E1.5 | A key with a passphrase, answered by askpass; a wrong one | Right: connected. Wrong: "Permission denied (publickey)", exit 255. The prompt text is truncated by ssh for long key paths | Classify prompts by their shape, never by parsing the key path out of them |
| E1.7 | A config with `RemoteCommand`, `RequestTTY yes` and `LocalForward` | Plain: "Cannot execute command-line and remote command.", exit 255. With `-o RemoteCommand=none -o RequestTTY=no -o ClearAllForwardings=yes`: works | Every session we open must neutralise those three, or a person's tmux-attach alias breaks Studio |
| E1.8 | `ClearAllForwardings=yes` with a command-line `-L` | The `-L` is cleared too | Port forwarding and "ignore the person's LocalForward lines" cannot be combined; a stdio transport needs neither |
| E1.8 | A unix-socket `-L` under a long directory | "AF_UNIX path too long"; `ControlPath too long (… >= 104 bytes)` | macOS caps socket paths at 104 bytes. Any local socket or ControlPath we create must live in a short directory |
| E1.9 | `-L <local.sock>:<remote.sock>` | Works; local socket created `srw-------` with `StreamLocalBindMask=0177` | Viable on macOS/Linux clients, not needed if stdio is the transport |
| E1.10 | Kill the tunnel's ssh | Local socket left behind, connections refused | Needs `StreamLocalBindUnlink` and liveness checks; another reason to prefer stdio |
| E1.11 | `-L 127.0.0.1:0:<remote.sock>` | "Bad local forwarding specification" | ssh cannot pick a free local port; a TCP forward means pick-then-race |
| E1.12 | `-L` to a port already in use, `ExitOnForwardFailure=yes` | "cannot listen to port", exit 255 | The race in E1.11 is real and must be retried |
| E1.13 / E4.5 | `ssh -W <remote unix socket>` | stdio connected straight to the remote owner socket; no remote process, no login-shell output | A transport with no local listener exists in stock OpenSSH |
| E4.7 | Same, with `AllowStreamLocalForwarding no` on the server | "open failed … stdio forwarding failed" | Hardened `sshd` configs refuse it; a relay over an exec channel is needed anyway |
| E4.6 / E4.7 | A relay over an exec channel (`exec node -e '<pipe stdio to the socket>'`) | Works, with or without stream-local forwarding allowed; the login shell's output arrives first and is skipped by a marker line | **The relay over exec is the one transport** (section 5.4) |
| E1.14 | `ControlMaster` + three sessions | One authentication, three sessions | Fine on macOS/Linux; Windows OpenSSH has no multiplexing, so it cannot be the design's basis |
| E1.15 | A remote command's argv | Visible to every user in `ps` | Nothing secret in any remote argv, ever |
| E2 | One `sh -s` stdin carrying a script and then a gzipped tar | Naive (script then archive): **fails under dash, busybox ash, bash, zsh and macOS sh**, locally, in containers and over a real ssh channel ("Unrecognized archive format", "invalid magic"). Wrapped in one `{ … exit 0; }` compound command that prints a marker, with the archive written only after the client reads the marker: **passes on all five, over ssh too** | One session can install: the whole script is parsed before anything runs, and the shell never reads stdin again |
| E4.2 | E2 with a real 42 MB payload (a Linux Node plus a stand-in server) through the dockerized `sshd` | Committed in 0.8 s on loopback; the login shell's line printed before the marker was ignored | Install fits in one SSH session and one authentication |
| E4.3a / E5 | The bootstrap envelope written straight after the script, without waiting for the marker | `read` got 0 bytes; without `exit` closing the compound command the envelope is **executed as a command**, and the shell prints `{ownerToken:SECRET-abc123}: not found` on stderr (dash and busybox) | The marker handshake is a security rule, not an optimisation: otherwise a secret lands in a log |
| E4.3b | Envelope after the marker, server started with `setsid nohup`, owner socket only | Ready in 0.2 s; token in the remote `ps` output: 0 matches; run dir `700`, socket `600` | The parent's stdin envelope works over SSH with the handshake |
| E4.4 | End the SSH session | The server keeps running | (On this container. With systemd's `KillUserProcesses=yes` it would not; see 6.4) |
| E4.1 | A line at the top of `.bashrc` | Printed on stdout before every exec command's output (Ubuntu's stock `.bashrc` returns early for non-interactive shells, so only lines above that guard print) | Every exchange is marker-framed; nothing before the first marker is parsed |
| E4.8 | `docker pause` under a live session with `ServerAliveInterval=2`, `ServerAliveCountMax=2` | Detected in 6 s: "Timeout, server … not responding.", exit 255; the server survived | Keepalive bounds how long a dead path goes unnoticed; the server's life does not depend on it |
| E3 | A probe script (section 5.2) under `shellcheck -s sh`, `dash -n`, `bash -n`, and run on macOS, Ubuntu, Alpine, and a home on a `noexec` tmpfs | Clean under shellcheck. Detected `darwin`, `glibc-2.39`, `musl`; `exec=0` on the noexec home; macOS lacks `flock`, `setsid`, `mv -T`; Ubuntu minimal lacks `xz`, `curl` and `wget`; Alpine lacks `curl` | The probe's fields are the ones section 5.2 lists |
| E3b | A glibc Node binary on Alpine | `exec …: no such file or directory` (the musl loader cannot find `ld-linux`) | musl is detected up front and named, not discovered by a confusing ENOENT |
| E6 | Several length-delimited payloads on one stdin through `head -c N` | macOS sh: intact. **GNU `head -c` over a pipe: corrupt** (it reads past N) | Do not multiplex several payloads through `sh`; one archive per session, last on stdin |

Not tested here, and listed as risks to check in the Windows job (section 9):
Windows OpenSSH's `SSH_ASKPASS` behaviour, its `known_hosts` location in
practice, and whether a Git for Windows `ssh.exe` earlier on `PATH` changes
any of the above.

## 4. Environments in the app

### 4.1 The model

```ts
type EnvironmentRoute =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string }
  | { kind: 'ssh'; target: SshTarget }
  | { kind: 'tailnet'; device: string }

type SshTarget = {
  /** What the person typed: an alias, or user@host[:port]. Validated, never starts with '-'. */
  destination: string
  /** What `ssh -G` resolved last time; shown, never used to connect. */
  resolved?: { hostname: string; user: string; port: number; proxyJump?: string }
}

type SavedEnvironment = {
  id: string                    // client-side id of the saved connection
  label: string                 // "build-box", editable
  route: EnvironmentRoute
  environmentId?: string        // the server's welcome.environment.id, once seen
  ssh?: {
    installSource: 'stream' | 'remote-download'   // section 5.3
    keepRunning: boolean        // leave the managed server up after the last client
    dataDir?: string            // advanced: a non-default --data-dir on the remote
    installDir?: string         // advanced: for a home mounted noexec
    paneTraffic: 'all' | 'loopback' | 'off'   // what the pane sends through the remote (6.8)
  }
}
```

Saved environments are client-owned (parent 7.2): the desktop's userData. Two
saved routes that report the same `environment.id` (an SSH alias and the same
machine's tailnet device) are one environment with two routes; the sidebar
shows it once and uses whichever route is up.

### 4.2 Where it shows

- **Settings → Machines** lists environments: This Mac, WSL distributions,
  SSH machines, paired machines. "Add SSH machine" is one text field that takes
  an alias or `user@host:port`, completed from the non-wildcard `Host` lines of
  `~/.ssh/config` (a suggestion list only); what is saved is checked with
  `ssh -G`, whose resolved host, user, port and jump host are shown before the
  first connect.
- **The sidebar** groups workspaces by environment, as the parent's 10.3 says;
  the Remote band lists environments, not only paired desktops.
- **New chat's machine menu** lists the environments with their state.
- **State in words, never a dot** (AGENTS.md): "Connected", "Connecting…",
  "Asking for your passphrase", "Installing Studio server 1.9.0 (34 MB)",
  "Reconnecting — last reached 2 min ago", "Needs an update: this machine runs
  1.6.0, this app speaks 1.8–1.9", "Can't run here: Alpine (musl) is not
  supported yet". The working mark shows only while a step is running.

As built (2026-10-03):

- Saved machines live in `userData/ssh-environments.json` (0600): id, label,
  destination, the `ssh -G` route, the server's environment id once seen,
  and settings (`keepRunning`, `paneTraffic`, `installDir`, `remoteDownload`).
  No credential. `src/main/environments/ssh/ssh-environments.ts` holds them in
  main with one state machine each, and answers the renderer over
  `environments:ssh:*` (`src/main/ipc/ssh-environments-ipc.ts`).
- A workspace on an SSH machine is recorded with
  `environment: { kind: 'ssh', id, label }` and the folder as that machine
  spells it; `hostId` stays absent (this computer's `local`), as change 1 in
  section 12 asks. The router in the core (`RoutedConversationBackend`, phase
  7's) sends such a workspace's chats to `ssh:<id>`, on any platform. Main's
  sessions reach the core in process only: with the desktop's server out of
  process, machines are listed and connected, but their chats are not routed
  yet.
- Settings › Machines shows on every platform now, with an "SSH machines"
  section: the add field (suggestions from the plain `Host` names of
  `~/.ssh/config`, then the resolved route shown before saving), each machine
  with its state in words and the working mark only while a step runs,
  Connect, Disconnect, Update (asks first, for an older external server),
  Stop server (managed only), Diagnostics (redacted) and Forget.
- New chat's machine menu lists the SSH machines after this computer's; one
  that cannot be used (unsupported, version-blocked) is listed with why.
  Picking one replaces the project picker with a field for the folder's full
  path on that machine; only a chat can start there.
- The sidebar files an SSH machine's chats under that machine's folder, with
  the machine's name, as a paired machine's are; nothing on this computer
  checks that folder (it is not this computer's).
- Not built: the remote's file explorer, Git pane, @-mention search and
  previews for an SSH workspace, which read this computer's disk today.

## 5. The bootstrap

### 5.1 How ssh is run

The desktop's main process spawns the **system** `ssh` (no shell, argv only):

```
ssh -T
    -o RemoteCommand=none -o RequestTTY=no -o ClearAllForwardings=yes
    -o ForwardAgent=no -o ForwardX11=no
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o ConnectTimeout=20
    [-o BatchMode=yes]                 # background reconnects only
    -- <destination> sh -s
```

- **Which `ssh`.** macOS and Linux: `/usr/bin/ssh`, else `PATH`. Windows:
  `%SystemRoot%\System32\OpenSSH\ssh.exe` first, then `PATH`, with a Settings
  override. The chosen binary and its `ssh -V` are shown in diagnostics.
- **`--` before the destination, and a validated destination.** A destination
  is refused if it starts with `-`, or contains whitespace, control characters
  or any of `` ;|&$`'"<>()\ ``. This closes argument injection (a destination
  `-oProxyCommand=…` from a pasted or deep-linked value) and the `%`-token
  expansion class in `ProxyCommand`.
- **Not ours to override:** `ProxyJump`, `ProxyCommand`, `IdentityFile`,
  `IdentitiesOnly`, `User`, `Port`, `UserKnownHostsFile`,
  `StrictHostKeyChecking`, `ControlMaster`/`ControlPath`. The person's config
  decides. If their config has `StrictHostKeyChecking no`, that is their
  choice, and Settings says so on that machine.
- **Overridden, because Studio would break otherwise (E1.7):** `RemoteCommand`,
  `RequestTTY`, `ClearAllForwardings`. **Overridden for safety:**
  `ForwardAgent=no` (a long-lived server would hold a forwarded agent socket
  that dies with the session anyway), `ForwardX11=no`.
- **Environment for ssh:** `SSH_ASKPASS=<shim>`, `SSH_ASKPASS_REQUIRE=force`,
  `DISPLAY` left alone; `SPRINTENGINE_ASKPASS_SOCKET` and a per-spawn
  `SPRINTENGINE_ASKPASS_TOKEN` (section 5.5). `LC_ALL=C` so messages are
  classifiable. Nothing from the remote is put into the local environment.

### 5.2 One stage, one compound script, marker-framed

Every remote script is one `{ … ; exit N; }` compound command followed by a
newline (E2: the whole script is parsed before the first command runs, so the
shell never reads stdin again), run by `sh -s`. Every line the client parses
starts with `@@SPRINTENGINE_`; anything before the first marker (motd, a
chatty `.bashrc`, E4.1) is discarded and kept for diagnostics only. When the
client has something to send — a decision, an envelope, an archive — the
script prints `@@SPRINTENGINE_SEND` and the client writes only after reading
it (E4.3a/E5). An archive is always the **last** thing on a session's stdin
(E6).

The probe prints, as `@@SPRINTENGINE_PROBE key=value` lines (E3):

| Key | From | Used for |
| --- | --- | --- |
| `proto` | the script | refusing a script/client mismatch |
| `os`, `machine` | `uname -s`, `uname -m` | the Node and bundle target |
| `libc` | `ldd --version` / `/lib/ld-musl-*`, `getconf GNU_LIBC_VERSION`, `sw_vers` | glibc floor (2.28 for the pinned Node), musl refusal, macOS version |
| `uid`, `home`, `shell` | `id -u`, `$HOME`, `$SHELL` | paths, diagnostics |
| `base`, `writable`, `free_kb`, `fstype`, `exec` | the install dir's nearest existing ancestor; `df -Pk`; `stat -f -c %T` (Linux); a two-line script written there and run | no-root installs, quotas, NFS homes, `noexec` homes |
| `has_<tool>` | `command -v` for `tar gzip xz flock sha256sum shasum curl wget systemctl loginctl setsid` | which archive (xz or gz), lock strategy, whether remote download is possible |
| `linger`, `kill_user_processes`, `systemd_user` | `loginctl`, `systemctl --user` | whether a server can outlive the session (6.4) |
| `installed` | each `.ready` marker under `base` | skip installs |
| `server` | `<runDir>/server.json` (pid, version, origin, host id, protocol window — no secrets) and whether its lock is held | attach, start, upgrade or refuse |
| `cli` | `command -v` for the agent CLIs (`claude`, `codex`, `cursor-agent`, `opencode`, `gemini`, `grok`) through a login shell's `PATH` | the Agents tab before the server is up |
| `proxy` | whether `HTTPS_PROXY`/`https_proxy` is set | diagnostics; the server inherits it |

As built (2026-10-03), `src/main/environments/ssh/ssh-connect-script.ts`:
every session runs one script, the probe and then one decision line, so a
connect is one authentication and an install two (the archive must be the
last thing on a session's stdin). The decisions are `install`,
`install-fetch`, `attach`, `start <idle|keep> <label>`, `upgrade <idle|keep>
<label>` and `stop`; anything else ends the session having changed nothing.
`start` and `upgrade` check their two words against fixed character sets with
globbing off before using them. `RemoteSession.send` throws before
`@@SPRINTENGINE_SEND`, so the marker rule is enforced in one place.

The probe as built drops the `cli` line: a login shell's `PATH` is slow and
noisy to read in the probe, and the server's own CLI detection answers as soon
as it is up. It adds `user`, `hostname` (for the NFS check against the run
lock's host), and the run lock's pid, host and liveness (`kill -0`).

### 5.3 Install

Two sources, the same commit:

- **Stream (default).** The desktop holds verified archives: the pinned Node
  for the target (downloaded and SHA-256-checked on the desktop, as
  `wsl-node-runtime.ts` does, but with Electron's `net.fetch` so the system
  proxy and PAC apply) and the server bundle for the target (carried in the
  app package, parent 10.4). One session: probe → `@@SPRINTENGINE_SEND` →
  the client writes `install\n` and then **one** combined archive (runtime if
  needed + bundle) → `tar -x` into a private staging dir → verify → commit.
  The remote needs no network.
- **Remote download (opt-in per machine).** For a remote on a fast network and
  a desktop on a slow uplink. The desktop sends the release URL and the SHA-256
  it already trusts; the remote fetches with `curl` or `wget` (honouring its
  own proxy variables) and checks with `sha256sum`/`shasum -a 256` before
  unpacking. A mismatch is fatal and names both digests. The client never
  trusts a digest the remote computes for it.

Commit (generalised from `wsl-install.ts` into `remote-install.ts`, shared by
WSL and SSH):

- **Lock**: `mkdir "$base/.install.lock"` with the pid inside, reclaimed when
  `kill -0` says the holder is gone, waiting up to 120 s. Works on every target
  (macOS has no `flock`; NFS `flock` semantics vary).
- **Verify**: `node --version` equals the pin; the bundle's manifest digests
  match; `node server.mjs --version` equals the bundle version. This also
  catches a `noexec` mount, a glibc below the floor and musl.
- **Move**: `mv -T` where it exists, else `mv` into a path checked not to exist.
- **Prune**: versions no running process names — `/proc/*/cmdline` on Linux,
  `ps -axo command` on macOS — and never the version `server.json` names.
- **Layout** as the parent's 7.1:
  `~/.local/share/sprintengine-studio/runtime/node-<v>/`,
  `~/.local/share/sprintengine-studio/<version>/server/`, data under `data/`,
  logs under `~/.local/state/sprintengine-studio/logs/`. `installDir`
  overrides the first two for a home mounted `noexec` (the probe's `exec=0`
  says which directory failed and suggests one on another mount).
- **Space**: refused before streaming when `free_kb` is under the archive's
  unpacked size plus 20%. A quota hit during `tar` (`Disk quota exceeded`) is
  mapped to the same message.
- **npm**: the runtime keeps `lib/node_modules/npm` (the WSL install strips
  it) because the server's managed CLI installs (parent 6.1) run npm on the
  server's own Node. Alternatively the bundle carries the pure-JS npm the
  desktop already ships under `resources/runtime/npm`; either is fine, one
  must be chosen (decision D9).

As built: the remote download covers the pinned Node only. Its URL and
digest for each of the four targets are written into the script itself and
chosen by `uname`, so nothing a client sends names what the remote fetches;
`curl` or `wget` fetches, `sha256sum` or `shasum -a 256` checks, and a
mismatch fails with both digests. The server tree is always streamed: no
published release archive of it exists yet (decision R08 publishes one later).

Targets in v1: `linux-x64`, `linux-arm64` (glibc ≥ 2.28), `darwin-arm64`,
`darwin-x64`. musl (Alpine) is refused with a sentence naming the reason
(decision D3).

As built (2026-10-03), `src/main/hosts/remote-install.ts`:

- The layout is phase 7's as built, not the one above: the server tree is
  `server-<version>/` beside `runtime/node-<v>/` and `data/`, so a WSL
  distribution and an SSH machine hold the same tree in the same place, and
  each kind of install prunes only its own (`PRUNE_GLOBS`).
- The lock, the liveness check and the move are shared with WSL, whose commit
  now takes the `mkdir` lock too instead of `flock`. A lock is reclaimed when
  its pid is gone, when it never got a pid and is two minutes old, or when it
  is half an hour old (a pid reused by another process of the same user).
  Liveness reads `/proc` where there is one and `ps` otherwise; when neither
  answers, a tree counts as in use and is never pruned on a guess.
- The SSH install is one session: `buildStreamInstallScript` stages, says
  `@@SPRINTENGINE_SEND`, reads the decision line and then the archive to its
  end, and commits the runtime and the server tree it holds under one lock.
  The runtime in that archive is the pinned binary alone
  (`runtime/node-<v>/bin/node`, 0700), repacked on the desktop; its marker
  holds the digest of the pinned archive it came from, as on WSL.
- Tested under dash, bash, zsh in sh emulation and the macOS `/bin/sh`, and
  under busybox in an Alpine container when `STUDIO_TEST_DOCKER=1`
  (`remote-install.test.ts`); `shellcheck -s sh` where it is installed.

### 5.4 Transport: the relay over the session's stdio

The parent's 9.4 and 10.3 step 5 forward a local socket or port with
`ssh -N -L`. This scope replaces that with a **relay**: the last step of the
connect session `exec`s

```
<node> <bundle>/server.mjs relay --data-dir <dir>
```

which prints `@@SPRINTENGINE_RELAY <server version> <protocol window>` and
then carries bytes between its stdio and the server's owner socket. Why, from
the experiments:

- no local listener for the protocol: nothing for another local user to connect to,
  no free-port race (E1.11, E1.12), no 104-byte socket paths (E1.8), no stale
  socket files (E1.10);
- works where `sshd` disables stream-local or TCP forwarding (E4.7) and
  regardless of the person's `LocalForward` lines (E1.8);
- the same session that probes can start the server and become the relay, so
  a reconnect costs **one** authentication — the only way to get that on
  Windows, whose OpenSSH has no `ControlMaster` (E1.14);
- the WSL stdio fallback (parent 10.2 step 3) is the same shape, so phase 7 and
  phase 8 share one client transport.

The relay carries a small **multiplexer** (length-prefixed frames with a
stream id), so the desktop can open several logical owner-socket connections —
the WebSocket and the HTTP requests for images and uploads beside it (parent
5.1) — over one SSH session. Each logical stream is an ordinary connection to
the owner socket on the remote; the server needs no change for it. A second
stream kind, `tcp`, carries the pane's traffic to the remote's network (6.8).

**Auth through the relay.** The relay runs as the person, launched over an
authenticated SSH session, so it already is the proof the parent's 9.4 wants.
It reads `<runDir>/owner-token` (0600) itself and presents it on each logical
connection, tagged `via: 'ssh-relay'` with `SSH_CONNECTION`'s client address
for the audit log. **The remote owner token never leaves the remote**, so a
desktop's disk holds no credential for any SSH machine. The renderer reaches the
environment through main as it reaches any other (section 12, change 4).

`ssh -W <owner socket>` (E1.13) is kept as a diagnostic only: it shows whether
stream-local forwarding is allowed, which is useful in a support report.

As built (2026-10-03), by decision R21 the relay is phase 7's stdio bridge,
not a `server.mjs relay` entry: `bridge.mjs --mux <runDir>` from the
installed tree, with its multiplexer in `relay-mux.mjs` beside it, plain Node
with no dependencies. The desktop imports the same file for its end, so the
two ends share one codec. The ready line is
`@@SPRINTENGINE_RELAY {mux, pid, server}`, where `server` is what the server's
record (`run/server.json`) says about it, or null when none runs.

- Frames are a 9-byte header (u32 length, u8 type, u32 stream id) and a
  payload: `open`, `opened`, `refused`, `data` (at most 32 KiB), `credit`,
  `fin`, `close`. Each stream starts with a 256 KiB window both ways.
- An `owner` stream is a connection to the server's front-door socket (phase
  7's bridge door, `run/front-door.sock`), on which the relay runs the front
  door's half of the mutual proof with the owner token it reads from
  `run/owner-token`, fresh for each stream. The token never leaves the
  machine (R22). The opening line carries `via: 'ssh-relay'`, the
  `SSH_CONNECTION` client address and the relay's pid, which the server writes
  in its log when it admits the connection. The purposes are phase 7's,
  `backend` (the private conversation wire) and `studio` (the shell role).
- Refusal codes are `refused`, `unreachable`, `timeout`, `limit`,
  `no-server` (no record or socket) and `closed`.
- On exit the relay writes one line to stderr with its counts: streams of each
  kind, refusals, bytes each way, and up to 64 `host:port` targets.

### 5.5 Prompts: the askpass shim

`SSH_ASKPASS` points at a tiny shim shipped with the app
(`resources/ssh-askpass/askpass` for macOS/Linux, `askpass.cmd` + a Node script
on Windows). It connects to `SPRINTENGINE_ASKPASS_SOCKET` (a socket in a
short, 0700 directory under main's run dir; a named pipe with an owner-only ACL
on Windows), presents `SPRINTENGINE_ASKPASS_TOKEN` (random per spawn), sends
argv[1] — the prompt ssh wrote — and prints the answer main sends back. The
answer never sits in an environment variable or a file.

Main classifies the prompt (E1.2, E1.5) and shows one dialog per kind:

| ssh's prompt | Dialog | Remembered? |
| --- | --- | --- |
| `The authenticity of host … can't be established. … key fingerprint is SHA256:…  Are you sure …` | **New machine**: the host, the key type, the fingerprint, "Check this with whoever runs the machine". Buttons: Trust and connect / Cancel. Answers `yes` or `no`. Never pre-selected | ssh writes `known_hosts` itself (E1.3) |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` (stderr, exit 255) | No prompt (ssh does not ask). An error naming both the host and the `known_hosts` line, with the `ssh-keygen -R` command to copy. No button that removes it for the person | — |
| `Enter passphrase for key …` | Passphrase field. The key path is not parsed out of the text (ssh truncates long ones) | No; the person's `ssh-agent` (or macOS `UseKeychain`) is the way to stop being asked |
| `…'s password:` | Password field | No (decision D6) |
| anything else (keyboard-interactive: `Verification code:`, `Passcode or option (1-3):`) | The remote's text, shown verbatim inside a frame that says "build-box asks:", so a server cannot impersonate a Studio prompt | No |
| `Allow use of key …? Key fingerprint …` (agent confirm / security key touch) | Confirm, or "Touch your security key" with no input | — |

A dialog waits up to three minutes, then answers nothing (ssh fails, and the
environment says "Sign-in to build-box timed out"). Background reconnects run
with `BatchMode=yes` (E1.4): if they need a prompt, they stop and the
environment shows "Needs you to sign in" with a Connect button, instead of
raising a dialog over whatever the person is doing.

As built (2026-10-03), `src/main/environments/ssh/askpass.ts` and
`src/renderer/src/components/environments/SshPromptDialog.tsx`:

- The shim is not shipped in `resources/`: main writes it when it first needs
  it into a fresh private directory in the system temp directory (0700), a
  `#!/bin/sh` line that runs the app's own binary as Node on a script beside
  it (`askpass.cmd` on Windows), and listens on a socket in the same
  directory (0600). Nothing depends on an executable bit surviving packaging.
- Keyboard-interactive questions are the remote's text, and OpenSSH 8.4 and
  later prefixes them with `(user@host) `. Any question so prefixed, or one
  that matches none of ssh's own, is shown as the remote's, verbatim, in a
  frame that says "build-box asks:". A remote that writes "Enter passphrase
  for key …" after the prefix gets the remote frame, never the passphrase
  dialog. On OpenSSH before 8.4 there is no prefix (Windows 10's own ssh is
  8.1), so main reads `ssh -V` once, and on such a client (or one it cannot
  read) a passphrase or password question is shown verbatim in a frame
  titled "ssh or build-box asks", saying Studio cannot tell who asks. Such
  clients are not refused.
- `SSH_ASKPASS_PROMPT=none` (a security key's touch) shows a notice with only
  Cancel, taken down when ssh kills the shim; `confirm` is Allow / Cancel.
- The host-key dialog's Trust button is never the focused default.
- Tested against the dockerized sshd: a refused host key leaves
  `known_hosts` untouched and ssh exits 255; a trusted one is written by ssh
  itself; a key's passphrase goes through the shim (`askpass.test.ts`).
  The Windows shim is written but not run anywhere yet (9.4).

### 5.6 The state machine

One state machine per saved SSH environment, in main
(`src/main/environments/ssh/ssh-environment.ts`), serialised so two triggers
never run two bootstraps at once.

```
            ┌───────────────────────────────────────────────────────────────────────┐
            ▼                                                                       │
 Idle ─connect─► Resolving ─► Authenticating ─► Probing ─┬─► Installing ─► Probing  │
  ▲               (ssh -G)    ├ AwaitingHostKey          │   (one archive,         │
  │                           ├ AwaitingSecret           │    then a new session)  │
  │                           └ refused ──► Failed       │                          │
  │                                                      ├─► Unsupported (musl, glibc < 2.28, Windows, noexec without installDir)
  │                                                      ├─► Locating ─┬─► Attaching ─────────────┐
  │                                                      │             ├─► Starting ──────────────┤
  │                                                      │             ├─► Upgrading ─► Starting ─┤
  │                                                      │             └─► VersionBlocked         │
  │                                                      │                                        ▼
  │                                                      │                               Relaying ─► Handshaking ─┬─► Connected
  │                                                      │                                                        └─► VersionBlocked
  │                                                                                                                    │
  │                     transport lost / wake / network change                                                         │
  └──── Disconnected ◄──────────────── Reconnecting (backoff, BatchMode=yes) ◄────────────────────────────────────────┘
                                         │ needs a prompt
                                         ▼
                                     NeedsSignIn (Connect button)
```

| State | Leaves on | Deadline | Fails as |
| --- | --- | --- | --- |
| Resolving | `ssh -G` output | 5 s | "build-box isn't in your SSH config and isn't a host name" |
| Authenticating | first marker | `ConnectTimeout` 20 s + time in dialogs | classified from stderr: unknown host refused, host key changed, permission denied (which methods), name not resolved, connection refused/timed out, jump host failure |
| Probing | `@@SPRINTENGINE_PROBE end` | 30 s | "Studio couldn't read build-box's setup" + the discarded pre-marker output |
| Installing | `@@SPRINTENGINE_COMMITTED` | 15 min overall, 60 s without progress | space, quota, noexec, digest mismatch, node won't run (glibc) — each its own sentence |
| Locating | `server.json` + lock + `relay --probe` | 10 s | — |
| Starting | `@@SPRINTENGINE_READY` from the new server | 30 s | the server log's last 40 lines, shown in diagnostics |
| Upgrading | old server exited after `server.shutdown { drain: true }` | drain budget 60 s (turns finish or suspend), then SIGTERM, 10 s, SIGKILL | "The old server on build-box didn't stop" |
| Relaying | `@@SPRINTENGINE_RELAY` | 10 s | — |
| Handshaking | `welcome` | 10 s | window mismatch → VersionBlocked |
| Reconnecting | Connected | backoff 1, 2, 4 … 30 s, reset on wake or network change | after 10 min awake: Disconnected with "last reached …"; a wake or network change tries again |

As built (2026-10-03), `src/main/environments/ssh/ssh-environment.ts`:

- The states are the table's, named for Settings: `connecting` (Resolving and
  Authenticating: `ssh -G` runs when a machine is added, not on every
  connect), `probing`, `installing`, `starting`, `upgrading`, `connected`,
  `reconnecting`, `needs-sign-in`, `version-blocked`, `unsupported`,
  `failed`, `disconnected`. The Relaying and Handshaking steps are timed in
  the diagnostics but not shown as states of their own.
- A reconnect that ssh refuses because it would need a prompt (a key's
  passphrase not in the agent, a password, an unknown host) stops at
  `needs-sign-in`, "build-box needs you to sign in.", and no background
  attempt runs until the person connects. A changed host key stops at
  `failed` with the `ssh-keygen -R` line.
- The window is one app version: a server of another version is attached
  only when it is this version, upgraded when it is an older managed one,
  and otherwise refused in words (newer: "Update this app"; an older external
  one: an Update button that asks first, R31). The backend wire is private
  and changes with the app, so "inside the window" is exactly "this version"
  until it is published.
- Resume, as built: the private backend wire has no stream cursors. A new
  wire re-reads the server's sessions (`refresh`), and a call that carries a
  `commandId` is answered once by the server's receipts, so repeating it after
  a reconnect joins the turn still running there instead of starting another
  (`ssh-environment.docker.test.ts` drops a session mid-turn and shows it).
  Events emitted while the wire was down are caught up by the subscription
  itself: when the router attaches a new wire for a server it followed
  before, it says so (`onRouteResumed`), and every `ConversationSessionApi`
  subscription to a chat that server holds joins again from its own cursor
  and generation, with live events held back meanwhile. A log the server
  vouches for hands over just the missed events; a rewritten one a reset
  snapshot. The chat view needs no reload and sees nothing twice
  (`ssh-resume.test.ts`: the session dropped, another client ending the turn
  meanwhile, the open subscription handed the rest). WSL servers' chats get
  the same.

Locating decides between four outcomes:

| Found on the remote | Action |
| --- | --- |
| no server | **Start** a managed one (`origin: 'bootstrap'`) with the envelope after a marker |
| a server of this desktop's version | **Attach** |
| an older **managed** server (`origin: 'bootstrap'`), inside or outside the window | **Upgrade**: the new bundle is already installed beside it; drain, then start |
| an older **external** server (`origin: 'cli'`, `'systemd'`, `'launchd'`) | Attach if inside the window, with "build-box runs 1.8.0; update it to get …" and an Update button that asks first; outside the window, VersionBlocked with the same button |
| a **newer** server (any origin) | Attach if inside the window; outside it, VersionBlocked: "build-box runs Studio server 2.1; this app speaks 1.8–1.9. Update this app." Never downgraded, never stopped |
| a server on this data directory whose `server.json` names another host (a shared NFS home) | VersionBlocked-style refusal naming that host (6.5) |

The "never replace a newer server" rule is what stops two desktops on
different versions, both attached to one remote, from replacing each other's
server in turn.

### 5.7 Starting and the envelope

The connect session's script, after `@@SPRINTENGINE_SEND`, reads one line —
the envelope — with `read -r` (which reads byte by byte, so nothing after the
line is consumed), and starts the server:

```
node server.mjs start --detach --data-dir <dir>
```

`start --detach` is a Node entry, not shell: it forks the server with
`detached: true` (its own session; no `setsid` binary needed, which macOS
lacks — E3), stdio to the log, hands it the envelope over a pipe, waits for
ready, and prints `@@SPRINTENGINE_READY {…}`. The envelope for an SSH start
holds the data dir, `origin: 'bootstrap'`, the listeners wanted (owner socket
only) and the client's version; **no token** — the server mints its own owner
token into `<runDir>/owner-token`, because the relay, not the desktop, is what
presents it.

When the systemd user manager is available **and** lingering is on, the start
uses `systemd-run --user --unit=sprintengine-studio --collect` around the same
command, so the server is supervised, its logs go to the journal too, and it
survives the session. Otherwise the detached fork, with the honest caveat in
6.4.

As built (2026-10-03):

- `start --detach` is an entry of `server.cjs` (`src/server/bootstrap/
  detached-start.ts`), run by the connect script with stdin on `/dev/null`.
  It takes a start lock (`run/start.lock`, a directory), so two desktops
  connecting at once start one server. A running server on this machine is
  reported (`attached: true`), or with `--replace` sent SIGTERM and given 60 s
  to drain (then SIGKILL). A run lock and record naming another machine are
  refused (R25).
- The starter, not the server, mints the owner token: 32 random bytes into
  `run/owner-token` (0600, renamed into place). The server is handed only its
  hash in the envelope, as on WSL, so phase 7's front door and proof are reused
  unchanged.
- The server is the ordinary `--bootstrap stdio` server, forked with Node's
  `detached` (its own session, no `setsid` needed), its stderr appended to
  `~/.local/state/sprintengine-studio/logs/<data>/server-<date>.log`. The
  envelope gains `detached: { idleMs, origin, startedBy }`: stdin ending is
  then not the parent gone, SIGHUP is ignored, and SIGTERM or SIGINT drain
  with a 60 s budget. The front door opens its bridge socket only
  (`loopback: false`), so the server listens on no TCP port.
- The server writes `run/server.json` itself once its doors are open (pid,
  version, origin, startedBy, hostId, environmentId, socketPath,
  `backendWire`, dataDir; 0600) and removes it when it stops.
- Idle: with no admitted front-door connection for `idleMs` (default five
  minutes; `--keep-running` for none) and no chat working, it stops itself.
- No systemd unit is used: decision R29 rules that out unasked, so the managed
  server is always the detached process, with the caveat of 6.4.
- The "protocol window" is the private backend wire's version
  (`BACKEND_WIRE_VERSION`) together with the app version (5.6, as built).

## 6. The remote, in detail

### 6.1 Paths and the run directory

- Data `~/.local/share/sprintengine-studio/data`, logs
  `~/.local/state/sprintengine-studio/logs` (parent 7.1).
- **Run directory**: `<dataDir>/run` (0700) as the parent says — **not**
  `$XDG_RUNTIME_DIR`, because logind removes `/run/user/<uid>` at the last
  logout when lingering is off, which would take the socket of a server meant
  to outlive the session with it. When `<dataDir>/run/studio.sock` would pass
  Linux's 108-byte socket path limit (a long home path), the socket goes to
  `/tmp/sprintengine-studio-<uid>/` instead, created 0700 and refused if it
  exists and is not a directory owned by this uid with mode 0700 (checked with
  `lstat`, so a planted symlink is refused).
- `server.json` gains `hostId` (`/etc/machine-id` or `hostname` + boot id),
  `origin`, `protocolWindow`, and `startedBy` (the client label, for "started
  by Studio on dev-macbook-air").

### 6.2 Multiple users on one host

Everything is per uid: the install, the data dir, the run dir and the socket
(0700/0600), the server process. Two people on `build-box` each get their own
server and never see each other's. Nothing listens on TCP, so "the port is
already in use" cannot happen for the SSH route; the only shared resource is
`/tmp` for the long-path fallback, which is per uid and ownership-checked.

### 6.3 Network homes (NFS)

- An install on NFS works; the probe reports `fstype=nfs` and the install
  lock is `mkdir`-based, which is atomic over NFS.
- A home shared by several machines means one data directory for all of them.
  One server per data directory is enforced by the lock, and `server.json`'s
  `hostId` lets a second machine say "Studio server is already running for
  this home on build-box-2" instead of failing to connect to a socket that
  lives on another kernel. Whether to give each host its own data directory
  automatically is decision D5.
- Per-workspace data in each repository's `.sprintengine/` is shared by
  whoever opens the repository, exactly as it is for two desktops on one
  network drive today.

### 6.4 Keeping it running

| Remote | What keeps a managed server alive after the SSH session ends |
| --- | --- |
| Linux with systemd, lingering on | the transient user unit (5.7) |
| Linux with systemd, lingering off, `KillUserProcesses=no` (what most distributions ship) | the detached process (E4.4) |
| Linux with systemd, `KillUserProcesses=yes` (some hardened or desktop distributions) | **nothing**: the server ends when the session ends, and with it any running agent. Settings says so for that machine, with the `loginctl enable-linger` line an admin can run |
| Linux without systemd, macOS | the detached process. A `launchd` agent on macOS is a later option |

"Leave it running" (per machine, `keepRunning`) decides what happens when the
last client detaches: a managed server idles out after five minutes with no
client and no running agent (parent 10.3), unless `keepRunning` is on. An
external server is never stopped by a client. "Stop server on build-box" in
Settings calls `server.shutdown { drain: true }` and is offered for managed
servers only.

### 6.5 Logs and diagnostics

- Server logs rotate under the logs dir; `server.logs.tail` (owner) streams
  them; Settings → Machines → build-box → Diagnostics shows the last 200 lines,
  the probe, the ssh binary and version, the resolved `ssh -G` fields, the
  last bootstrap's step timings, and the discarded pre-marker output.
- "Copy diagnostics" redacts the owner token pattern, `SSH_CONNECTION`
  addresses and the home path's user name.

### 6.6 Agent CLIs on the remote

- **Detecting**: the server's own `detectClis` on its host (parent 6.1), with
  the login-shell `PATH` resolver; the probe's `cli` lines give a first answer
  before the server is up.
- **Installing**: the server's managed npm prefix (`~/.sprintengine/node`) on
  the pinned Node with npm (5.3). The remote needs network for this and for the
  agents themselves; a corporate proxy is honoured through the environment
  variables the server inherits and the per-machine `env` setting
  (`ExecutionHostSettings.env` moves to the environment's server settings).
- **Signing in** (owner default):
  - **Device-code flow** where the CLI has one: `providers.signIn` runs it on
    the server without a terminal, streams the URL and the code it prints, and
    takes a pasted code back (parent 6.6). Which CLIs qualify is to be checked
    per CLI and version during the phase; the table in Settings is driven by a
    capability each provider declares, not a hard-coded list.
  - **Otherwise, the narrow exception, with no terminal on the server**: the
    desktop opens one of its own local terminal tabs running
    `ssh -t -- <destination> <cli> <login args>` and closes it when the command
    exits. The server serves no terminal, ruling (a) holds for the server, and
    the exception exists only on a desktop client (a web client gets the
    device-code flow or "run this over SSH").
  - **API keys** go through `providers.secrets.set` (parent 7.3).
- **Where logins live**: in the remote's home, where each CLI keeps them. On a
  macOS remote, a CLI that keeps its login in the macOS keychain cannot read it
  from an SSH session (the login keychain is locked there); Settings says so
  and suggests the CLI's token or API-key login instead.

### 6.7 Secrets on the remote

Owner default: the system keyring, or an owner-only file where there is none.
In practice over SSH:

- **Linux**: the Secret Service needs a D-Bus session bus and an unlocked
  keyring, which a headless SSH login almost never has. The server tries
  `libsecret` only when `DBUS_SESSION_BUS_ADDRESS` is set and an unlock does not
  need a prompt; otherwise the 0600 key file in `<dataDir>/run/`.
- **macOS**: the login keychain is locked in an SSH session; the server does
  not ask to unlock it. 0600 key file.
- `server.info` says which one is in use, and Settings shows it per machine.

### 6.8 The pane's traffic through the SSH connection

The server has no browser (owner ruling 2026-10-02). An agent on `build-box`
that starts a dev server on the remote's `127.0.0.1:5173` and calls
`browser.open http://localhost:5173` reaches the desktop's `browser` toolset
(phase 5), whose pane would load the **laptop's** port 5173. This section
makes `localhost` in that environment's tabs mean the remote, with no
Chromium on the remote and no screencast: the desktop's own pane, its network
sent through the SSH connection the desktop already holds.

Amended 2026-10-03 for decision R75 (owner ruling 2026-10-02): the local
end is an HTTP proxy that demands a per-forward credential, not a SOCKS5
listener. Where the text below still says SOCKS5, read this paragraph and the
"As built" notes at the end of this section.

```
 pane tab of a build-box workspace, partition persist:env-<environment.id>
   │  Chromium: proxyRules 127.0.0.1:<p> (an HTTP proxy), proxyBypassRules '<-loopback>'
   │  Proxy-Authorization answered by main through Electron's `login` event
   ▼
 main: SshPaneForward for build-box, an HTTP proxy on 127.0.0.1:<p>
   │  one multiplexer stream per CONNECT or plain request: open { kind: 'tcp', host, port }
   ▼
 the environment's SSH session: the relay's stdio (5.4)
   ▼
 relay on build-box: connects to host:port as the person, resolving host there
   ▼
 the dev server on build-box's 127.0.0.1:5173 (or any host build-box can reach)
```

**Why the relay and not `ssh -D`.** Every session Studio opens runs with
`ClearAllForwardings=yes`, because a person's `LocalForward` lines otherwise
break it (E1.7, E1.8), and that also clears a `-D`. A second session just for
`-D` would cost a second authentication, which Windows OpenSSH cannot share
(E1.14), and hardened hosts refuse forwarding outright (E4.7). The relay's
multiplexer already carries streams over the one session; a `tcp` stream kind
is a small addition that needs no forwarding and no new authentication.

**The relay side.**

- The multiplexer's `open` gains a kind: `owner` (today's: a connection to
  the owner socket, authenticated by the relay) and `tcp { host, port }`. For
  `tcp` the relay resolves `host` on the remote, so `localhost`, the remote's
  `/etc/hosts` and its private DNS mean what they mean to the agent, connects
  with a 10 s deadline, and answers `opened` or `refused { code }`
  (`refused`, `unreachable`, `timeout`, `limit`).
- Half-close is carried both ways, and each stream has its own credit window,
  so a stalled page cannot hold up the Studio protocol beside it.
- At most 256 `tcp` streams per relay. The relay counts streams, targets and
  bytes for diagnostics; it records no content.
- The Studio server takes no part: the relay opens the connection. The pane's
  network keeps working while the server restarts or upgrades, for as long as
  the session lives.

**The desktop side.** `SshPaneForward` (`src/main/environments/ssh/pane-forward.ts`),
one per SSH environment, in main:

- **Listener.** A SOCKS5 server bound to `127.0.0.1` on a port the OS picks
  (`listen(0)`). It is opened when the first tab of that environment is
  created (by the person, or by an agent's `browser.open`), and closed when
  the last one closes, when the environment is forgotten, and at quit. The
  port is kept for the listener's life, across reconnects, so the session's
  proxy setting never has to change under an open tab.
- **SOCKS5 subset.** Method "no authentication" only, because Chromium offers
  no other (see Security). `CONNECT` only; `BIND` and `UDP ASSOCIATE` are
  refused with reply 0x07. Address types IPv4, IPv6 and domain name; Chromium
  sends `socks5://` targets as names, so names resolve on the remote. Relay
  refusals map to replies 0x05 (`refused`), 0x04 (`unreachable`), 0x06
  (`timeout`) and 0x01 (`limit`).
- **Partition.** One per environment, `persist:env-<environment.id>` (phase 5
  §10.4, R76), shared by that environment's workspaces, as today's single
  partition is shared by the local ones. Tabs are keyed by environment and
  workspace (phase 5 §10.1), so a tab of a `build-box` workspace is always
  created in `build-box`'s partition. Before the first tab loads, main calls
  `session.setProxy({ proxyRules: 'socks5://127.0.0.1:<p>', proxyBypassRules:
  '<-loopback>' })`. `<-loopback>` removes Chromium's implicit bypass of
  `localhost`, `127.0.0.1` and `[::1]`, so loopback goes to the remote too.
  Keying by `environment.id` means the SSH alias and the tailnet route to one
  machine share one partition.
- **What goes through the remote** (R76): by default everything the partition
  loads, so the pane sees the network the agent sees. A per-machine setting,
  `paneTraffic: 'all' | 'loopback' | 'off'`, can send only loopback targets
  through the remote, the forward itself connecting everything else directly
  from the laptop (no PAC script needed: the forward sees each target), or
  turn the forward off. `browser.status` reports `network: 'remote'` or
  `'local'` per tab, and the tool descriptions say so.

**Lifecycle with the connection** (5.6):

| Environment state | The forward |
| --- | --- |
| Relaying, Handshaking, Connected | `CONNECT`s flow. |
| Reconnecting, NeedsSignIn, Disconnected | The listener stays bound. Streams that were open die with the session, so Chromium shows its own error page, and a dev page's hot-reload client retries on its own. A new `CONNECT` waits up to 10 s for the relay, then gets 0x04. The pane shows a line in words: "build-box is reconnecting. This tab's network goes through it." |
| Resolving to Locating, Starting, Upgrading | As Reconnecting: there is no relay yet. |
| Sleep, wake, network change | The session is asked to answer, and restarted if it does not (section 7); as Reconnecting. |
| Forget | The listener closes. "Also clear build-box's browsing data" calls `session.clearStorageData()` on the partition. |
| App quit | The listener closes with main. |

**What works, and what does not.**

- HTTP, HTTPS, HTTP/2 (inside TLS through the tunnel), WebSockets (a dev
  server's hot reload) and server-sent events are TCP, and pass through SOCKS5
  unchanged.
- HTTP/3 does not: QUIC is UDP, and Chromium does not send it through a SOCKS
  proxy, so those sites fall back to HTTP/2.
- WebRTC: UDP cannot ride the forward. The partition's web contents set
  `webRTCIPHandlingPolicy: 'disable_non_proxied_udp'`, so a page neither
  leaks the laptop's addresses nor goes around the remote. A dev app that
  uses peer connections does not work in the pane over SSH; this is stated in
  the pane's help.
- Secure contexts and mixed content follow the URL, not the route.
  `http://localhost:5173` is a secure context because of its name, so service
  workers, `crypto.subtle` and the clipboard behave as for a local dev
  server. `http://build-box.lan:5173` is not one, as it would not be locally.
- Cookies and storage are the desktop's, in the environment's partition on the
  laptop's disk. They are never written on the remote, and they are not
  shared with local tabs: being signed in to a site locally does not carry
  over to `build-box`'s tabs.
- The laptop's own `localhost:5173` is unreachable from `build-box`'s tabs, by
  design. Local workspaces' tabs still reach it.
- The laptop's system proxy and VPN do not apply to that partition: its
  traffic leaves from the remote's network. A remote with no internet egress,
  or one that needs an HTTP proxy, fails for outside sites unless
  `paneTraffic` is `loopback`. The relay does not chain to the remote's
  `HTTPS_PROXY` in v1.
- DevTools, downloads (they land on the laptop), file uploads (from the
  laptop), the password manager and inline PDFs are the native pane's, as
  they are for a local tab.
- Every request crosses the SSH link. Hot reload is unaffected; a heavy first
  page load is as slow as the link.

**Security.**

- **The local listener (D13, R75).** Chromium speaks SOCKS5 without
  authentication, so the listener cannot ask for a credential. Any process
  that can reach the laptop's loopback can connect to it while it is open,
  and through it reach `build-box` as the person. A process of the same user
  can already run `ssh build-box` as them, so the exposure is to other OS
  users on the laptop, which is against the parent's goal 4 ("never an
  unauthenticated port"). The working default narrows it: loopback only, a
  port the OS picks, open only while a tab of that environment exists, and on
  Linux each accepted connection's owner uid is read from `/proc/net/tcp` and
  another uid's is refused. macOS and Windows have no cheap equivalent. The
  alternative that meets goal 4 everywhere is the same forward with an HTTP
  proxy as its local end (`CONNECT` for TLS and WebSockets, absolute-form
  requests for plain HTTP), demanding a per-session `Proxy-Authorization` that
  main answers through Electron's `login` event. Nothing else in this section
  changes. Decision D13.
- **The remote side.** The relay connects as the person, to what their shell
  on `build-box` can reach anyway; the forward adds no capability there. Where
  an administrator set `AllowTcpForwarding no`, the forward still works,
  because it is a program in the person's own session, as `nc` would be;
  OpenSSH's own documentation notes that turning forwarding off does not stop
  a user with shell access from running their own forwarder. Settings says
  "Browser traffic for build-box goes through build-box" on that machine, and
  `paneTraffic: 'off'` turns it off.
- **The page is untrusted**, exactly as a local dev page in today's pane: the
  pane's guest isolation is unchanged, and the partition holds no Studio
  credential.

**As built (2026-10-03), by decision R75.**

- The local end is `SshPaneForward` (`src/main/environments/ssh/
  pane-forward.ts`): an HTTP proxy bound to the literal `127.0.0.1` on a port
  the OS picks. Every request and every `CONNECT` must carry
  `Proxy-Authorization: Basic` with this forward's own credential (random per
  forward); without it the answer is `407` and nothing reaches the relay.
  Chromium asks for the credential through Electron's `login` event, and main
  answers only when the request comes from that machine's partition and names
  that forward's port (`PanePartitions.answerLogin`). No SOCKS5 listener
  exists, and the Linux uid check of the SOCKS design is not needed.
- `CONNECT` carries HTTPS and WebSockets (Chromium tunnels `ws://` through an
  HTTP proxy too). A plain `http://` request in absolute form is passed on
  once, in origin form, without the proxy's headers and with
  `Connection: close`, as raw bytes over its own tcp stream.
- A plain request is passed on once: only its own body (its
  `Content-Length`; any other framing is refused with `501`), and every
  response head, early hints included, says `Connection: close`, so
  Chromium never sends its next request, for another site, down a
  connection the first site answered.
- Refusals are said in words in the response body: `502` (refused,
  unreachable), `504` (timeout), `503` (the relay's limit, or "build-box is
  reconnecting. This tab's network goes through it." after ten seconds).
- `PanePartitions` (`pane-partitions.ts`) opens the forward when a tab of the
  machine's workspace asks for its partition (`browser:config` with the
  workspace), sets the session's proxy before that tab is made, and closes the
  forward five seconds after the machine's last tab. A later tab opens a new
  forward and points the session at it first. A `<webview>` may attach to a
  machine's partition only once its proxy is set (`guest-policy.ts`).
- The partition is `persist:env-<environment id>`, or
  `persist:env-ssh-<saved id>` until the machine's server has been reached.
- A machine whose `paneTraffic` is `off` gives its tabs this computer's
  partition. `loopback` sends loopback targets through the machine and the
  rest from this computer.
- `browser.status` reports `network: 'remote'` for those tabs; their guests run
  with `webRTCIPHandlingPolicy: 'disable_non_proxied_udp'`.
- A site cannot reach the machine's loopback (V-P3): before any tab loads,
  the partition's session cancels, through `webRequest.onBeforeRequest`, a
  subresource, frame, WebSocket or non-GET navigation to a loopback host
  (`localhost`, `*.localhost`, `127.x`, `[::1]`, `0.0.0.0`, `::`, an
  IPv4-mapped `127.x`) whose initiator is a web origin that is not itself
  loopback, or an opaque one. Allowed: requests with no initiator (a typed
  URL, an agent's `browser.open`), a loopback page's own requests, the
  developer tools', and a top-level GET link (`pane-partitions.ts`,
  `blocksForeignLoopback`). The same addresses count as loopback for
  `paneTraffic: 'loopback'`, so none of them is ever connected from this
  computer.
- After a machine's last tab its forward closes and its partition stops
  being one a guest may attach to until a new forward is open.
- The desktop's `browser` and `canvas` toolsets are offered to the machine's
  server (`relayShellToolsets` with an SSH target), so an agent there can open
  its dev server in the person's pane. The editor, tour, terminal and agent
  toolsets are not: they act on this computer's files and processes.
- Checked in Electron (a throwaway script against the dockerized sshd with
  `AllowTcpForwarding no`, not kept in the tree): a page served on the
  container's `127.0.0.1:5173` loaded in the machine's partition for
  `http://localhost:5173/` and `http://127.0.0.1:5173/`, while a page this
  computer was serving on its own `127.0.0.1:5173` loaded in a local
  partition; `http://[::1]:5173/` reached the container too (refused there,
  since the dev server bound IPv4 only), which confirms V-P1 for all three
  loopback names. Chromium raised the proxy's `login` once and was answered;
  a request without the credential got `407`. V-P2 to V-P4 were not run.

## 7. Connection resilience

- **Keepalive**: `ServerAliveInterval=15`, `ServerAliveCountMax=3`: a silent
  path is noticed within 45 s (E4.8 measured 6 s at 2×2).
- **Sleep and wake**: main's `powerMonitor` `resume`, a screen unlock and a
  network change (an `online` event, or a new default route) ask a connected
  session to answer within 10 s, instead of waiting for keepalive to time out
  on a dead socket. One that answers is kept; one that does not is killed and
  reconnected. Killing it unasked cost a full ssh handshake on every unlock,
  and a key whose passphrase is not in ssh-agent cannot make one in the
  background. A wake also restarts a reconnect's ten minutes (time asleep is
  not time spent trying) and lets a machine that gave up (Disconnected) try
  again; Needs sign-in and the person's own Disconnect stay held.
- **Reconnect**: `BatchMode=yes`, backoff 1 → 30 s, reset on wake. On success
  the client resumes every open stream with its `afterSeq` and `generation`
  (parent 5.1); a cursor the server cannot vouch for gets a reset snapshot.
  Commands in flight are retried with their `commandId`, so a send lost with
  the tunnel is applied once.
- **Mid-stream death**: the relay dies with the session; the server sees its
  logical connections close and keeps every conversation and agent running.
  An upload in flight is restarted from its start (uploads are bounded at the
  attachment limit).
- **Nothing on the remote depends on the tunnel**: the server's life is the
  idle rule plus `keepRunning`, not the SSH session.

## 8. Security

### 8.1 Assets

The person's SSH credentials (keys, passphrases, passwords, OTPs); the remote
owner token; provider API keys and CLI logins on the remote; the person's code
and transcripts; the integrity of what runs on the remote (Node, server).

### 8.2 Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| **MITM on first connect** | Host key TOFU only through the New machine dialog with the SHA-256 fingerprint (E1.2); never `StrictHostKeyChecking=no` or `accept-new` set by Studio; a changed key is a hard failure with no override button |
| **Argument injection** through a destination (`-oProxyCommand=…`) | `--` before the destination; the destination validator (5.1); the destination comes only from the person's own typing or their config, never from a deep link without a confirmation that shows it |
| **A secret in a remote argv** (visible to all users, E1.15) | No secret in any remote argv; the envelope travels on stdin after a marker; the relay reads the token file itself |
| **A secret executed as shell text** and echoed into a log (E5) | The marker handshake before any stdin payload; scripts are a single compound command ending in `exit`; a test that the envelope is never written before the marker |
| **Other users on the remote** | No TCP listener; run dir 0700, socket and token 0600; `/tmp` fallback ownership-checked with `lstat`; the owner token required on the socket regardless (parent 9.1) |
| **Other users on the desktop** | No local listener for the protocol (5.4); the askpass socket in a 0700 directory with a per-spawn token; the pane forward's SOCKS listener only on loopback, only while a tab needs it, uid-checked on Linux, and decision D13 for the rest (6.8) |
| **Phishing through prompts**: a server crafting keyboard-interactive text that looks like a Studio or OS prompt | Remote text shown only inside "build-box asks:"; the host-key and passphrase dialogs are recognised from ssh's own fixed strings, never from remote text |
| **Leaked SSH secrets** | Answers go from the dialog to the shim over the socket and nowhere else: not in an env var, a file, a log or memory beyond the dialog's life |
| **Agent forwarding abused by remote root** | `ForwardAgent=no` on Studio's sessions, whatever the config says |
| **A tampered Node or server** | Node pinned by SHA-256 (as for WSL), the bundle by the manifest in the signed app; the remote download checks the digest the desktop sends; markers hold the digest and a later start trusts only a matching one |
| **A stolen laptop** | The desktop holds no remote token (5.4). Revoking is revoking the SSH key on the remote; `studio-server token --rotate` on the remote ends every owner connection, including relays |
| **Binding a public interface** | The SSH route binds nothing but the owner socket. A server flag that binds anything other than loopback or a tailnet address does not exist (parent 9.1); the bind guard from `tailnet-interface.ts` moves into the server's listener factory and a test asserts `0.0.0.0` and `::` are refused |
| **Audit gaps** | Every owner connection is logged with `connection.kind: 'ssh-relay'`, the client address from `SSH_CONNECTION`, the relay pid and the client's `hello.client` name; mutations only, no message text (parent 9.4) |

### 8.3 Revoking access

- On the remote: remove the key from `authorized_keys` (ends future
  connections) and run `studio-server token --rotate` (ends current ones).
- In Studio: Settings → Machines → build-box → Forget, which deletes the saved
  environment and its cached snapshot, and does not touch the remote unless
  "Also stop and remove Studio server on build-box" is ticked.
- `auth.devices.*` (parent 5.2) covers tailnet pairings; SSH sessions appear in
  `auth.sessions.list` (owner) so another client can see and end them.

## 9. Testing

### 9.1 Unit (every platform, fast)

- The argv builder: golden argv per platform; the destination validator
  against a table of hostile and odd values (`-oProxyCommand=x`, `a b`,
  `host;id`, `[::1]:22`, `user@host:2222`, IDN hosts).
- Prompt classification against recorded ssh prompt texts (E1.6), including
  truncated passphrase prompts.
- stderr classification against recorded failures: unknown host, changed host
  key, permission denied (each method list), connection refused, timeout,
  name not resolved, jump host failure, `Cannot execute command-line and remote
  command`, `stdio forwarding failed`.
- Marker parsing with noise before, between and after markers.
- The state machine with a fake `ssh` spawner that plays scripted sessions:
  every row of the Locating table, every failure row, wake during each state,
  two connects at once (serialised), and the "never downgrade" rule with two
  clients.
- The multiplexer: interleaving, back-pressure, a stream closed mid-frame.
- The pane forward (6.8): the SOCKS5 parser (a greeting offering only "no
  authentication"; `CONNECT` with IPv4, IPv6 and a name; `BIND` and
  `UDP ASSOCIATE` refused 0x07; truncated and malformed requests); relay
  refusals mapped to SOCKS replies; the listener opened by the first tab and
  closed by the last, by Forget and at quit; the port unchanged across a
  reconnect; a `CONNECT` during Reconnecting held, then answered 0x04 after
  10 s; `paneTraffic: 'loopback'` connecting a non-loopback target directly;
  the Linux uid check against a fake `/proc/net/tcp`.
- The relay's `tcp` streams against a local echo server: `opened`, a closed
  port `refused`, `localhost` resolved by the relay, half-close both ways,
  the 256-stream limit.

### 9.2 Script tests (generated scripts, real shells)

Following `wsl-install.test.ts`: each generated script runs under `dash`,
`bash`, `busybox sh` (a container) and macOS `/bin/sh` against a temp `$HOME`,
and every generated script passes `shellcheck -s sh` in CI. Cases: fresh
install, re-install no-op, a digest mismatch, a concurrent install (two at
once, one waits on the `mkdir` lock), a stale lock from a dead pid, a `noexec`
install dir, a full disk (a small tmpfs), pruning with a live process on Linux
and on macOS, and the E2/E5 regressions (archive before the marker is refused;
the envelope is never written before `@@SPRINTENGINE_SEND`).

### 9.3 Integration: a dockerized `sshd` in CI (Linux job)

A fixture image like E4's: Ubuntu with `openssh-server`, a `dev` user, a key
injected at run time, a `.bashrc` that prints a line above its interactive
guard. Variants by build arg or run flag:

| Variant | Proves |
| --- | --- |
| stock | full bootstrap → chat with the mock provider → disconnect → server still up → reconnect resumes from cursor without duplicated text |
| `AllowStreamLocalForwarding no`, `AllowTcpForwarding no` | the relay does not need forwarding |
| a jump host (second container, `ProxyJump`) | resolution and connect through a bastion |
| `AuthenticationMethods publickey,password` | two prompts in order, through a scripted askpass |
| a key with a passphrase | the passphrase path |
| home on a `noexec` tmpfs | Unsupported → `installDir` |
| Alpine | the musl refusal message |
| `docker pause` for 30 s / `docker restart` | keepalive detection, reconnect, resume (E4.8) |
| an older and a newer fake server version in `server.json` | upgrade, attach, VersionBlocked; never downgraded |
| arm64 and x64 runners | both Linux targets |
| a Vite-style dev server bound to the container's `127.0.0.1:5173`, and a decoy on the runner's own `127.0.0.1:5173` | an Electron test opens a tab in `persist:env-<id>` with the forward: the remote's page loads, never the decoy's; the hot-reload WebSocket connects, and an edit on the remote updates the tab; `browser.open http://localhost:5173` through the `browser` toolset from a chat on the remote shows the same page |
| the dev server, with `AllowTcpForwarding no` | the forward needs no `sshd` forwarding |
| the dev server, `docker pause` for 30 s | the tab's error page and the reconnecting line, then the page and its hot reload back once the session is |

### 9.4 macOS and Windows

- **macOS runner**: an unprivileged `sshd` on a high port admitting a scratch
  key works without root (E1 ran exactly that), so the macOS target and the
  macOS client are covered by the same suite against `127.0.0.1`.
- **Windows client**: unit tests plus a Windows job that runs the client
  against a Linux `sshd` reached over the network (a service on another job's
  runner is not available, so this is either a self-hosted target or a manual
  release checklist). The checklist: `System32\OpenSSH\ssh.exe` found;
  `known_hosts` written to `%USERPROFILE%\.ssh\known_hosts`; the askpass `.cmd`
  shim receives the host-key and passphrase prompts; a Git for Windows
  `ssh.exe` first on `PATH` is not picked; the Windows `ssh-agent` service off
  (the default) still works with key files.

### 9.5 Chromium behaviour to confirm

Facts 6.8 relies on that were read, not run, and get an Electron-level test
before the forward ships:

- **V-P1.** With `proxyBypassRules: '<-loopback>'`, `localhost`, `127.0.0.1`
  and `[::1]` all go to the SOCKS proxy, and `localhost` arrives as a name.
- **V-P2.** Chromium sends no QUIC through a SOCKS proxy, and an HTTP/3 site
  loads over HTTP/2.
- **V-P3.** What Chromium's private-network checks do for a public page that
  fetches `http://localhost` through the proxy.
- **V-P4.** `webRTCIPHandlingPolicy: 'disable_non_proxied_udp'` set on the
  partition's guests sends no UDP from the laptop.

Checked 2026-10-03 in Electron, through the HTTP-proxy forward (R75) and
the dockerized sshd (a throwaway script, not kept in the tree):

- **V-P1** holds: `localhost` and `127.0.0.1` reached the machine's dev
  server, `[::1]` went to the machine as well (refused there: the dev server
  bound IPv4 only), and this computer's own server on the same port was
  never reached from that partition.
- **V-P2** holds: `https://www.google.com/` loaded through the forward over
  `h2` (`nextHopProtocol`); no QUIC.
- **V-P3**: a public page (`https://example.com/`) in the machine's partition
  could send a `no-cors` request to the machine's `http://localhost:5173/`
  (an opaque answer came back); a CORS read was refused, by CORS. This
  Chromium does not block private-network requests made through the proxy,
  so a site the person opens in that machine's tabs can reach the machine's
  loopback services blind, as a site in a local browser without
  private-network checks could reach the laptop's. Decided at review
  (2026-10-03): blocked, as a local browser keeps public sites off the
  laptop's loopback, with a `webRequest` rule on the machine's partition
  (6.8, as built). Not re-run in Electron since; the rule's cases are unit
  tested.
- **V-P4** holds: with `disable_non_proxied_udp`, a peer connection with a
  STUN server gathered no candidates at all.

### 9.6 Skew tests

A fake server advertising `protocolVersion` at each edge of the window and
one past it, against the client's handshake: attach, attach with hidden
features, VersionBlocked with both numbers named.

## 10. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
| --- | --- | --- |
| The variety of SSH setups (bastions, `ControlMaster` in the person's config, smartcards, 2FA, `RemoteCommand`) | High / high | System `ssh` with the person's config; only three options overridden, each tested (E1.7); `ssh -G` for display; the integration variants in 9.3 |
| `KillUserProcesses=yes` kills the server and agents on logout | Medium / high | Probe `loginctl`; systemd user unit with linger; say it in Settings before the person relies on "leave it running" |
| Windows OpenSSH behaves differently (askpass, paths, no multiplexing) | Medium / medium | One session per connect so multiplexing is not needed; a Windows checklist; the binary override |
| Old glibc (RHEL 7 class) or musl remotes | Medium / medium | Detected in the probe and named; decisions D3 and D4 |
| Password users are asked on every reconnect | Medium / low | One authentication per reconnect, not per step; background reconnects stop at NeedsSignIn rather than prompting; the person's own `ControlMaster`/`ControlPersist` config is honoured and makes it silent |
| Payload size on slow uplinks (Node ~30–45 MB, bundle tens of MB) | Medium / low | Node installed once per version; upgrades send only the bundle; the remote-download option; progress and size shown. No Chromium is ever sent (2026-10-02) |
| A long-lived server on a machine nobody watches (disk, memory) | Medium / medium | Idle-out by default; logs rotate; `keepRunning` is explicit per machine |
| Two clients on different versions fighting over one remote | Low / high | Never downgrade, never stop an external or newer server (5.6) |
| Login-shell noise or a broken profile | Medium / low | Markers: nothing before the first `@@SPRINTENGINE_` line is parsed (E4.1), and it is kept for diagnostics |
| Agents on the remote that need a terminal (`agent.launch`, `backlog.work`) | Certain / medium | Not offered on SSH servers (parent 6.3), and the UI says why |
| A public site open in an SSH machine's tabs can send blind requests to that machine's loopback services (V-P3) | Low / medium | Blocked by a rule on the machine's partition (6.8, as built): a request to a loopback host from a non-loopback web origin is cancelled; a top-level GET link still goes. The machine's private network (other than loopback) is not covered, as Chromium's private-network checks would for a laptop |
| The pane's SOCKS listener on the laptop is reachable by other local users while it is open | Low on single-user laptops / high where it applies | Loopback only, open only while a tab of that environment exists, a uid check on Linux; decision D13 offers an authenticated local end |
| Pane traffic leaving from the remote surprises the person (no egress there, a proxy it needs, a site that geolocates) | Medium / low | Said in Settings and in the pane's reconnecting line; `paneTraffic: 'loopback'` or `'off'` per machine |
| Agents on an SSH server lose the browser and canvas when the laptop sleeps | Certain / medium | The ruling's intent: they are the desktop's toolsets. Calls answer `client_unavailable` naming the fix (phase 5); the headless client is the later answer |

## 11. Decisions for the owner

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Replace the parent's `ssh -N -L` tunnel with the relay over the session's stdio (5.4)? | **Yes.** It removes every local listener, works with forwarding disabled, needs one authentication per connect on every OS, and is the WSL fallback's shape |
| D2 | Should the remote owner token ever reach the desktop? | **No.** The relay presents it on the remote; the desktop stores no remote credential |
| D3 | musl (Alpine) remotes in v1? | **No**, refuse with a clear sentence. Node's musl builds are unofficial, with narrower platform coverage; the bundle's native pieces would need musl variants. Revisit on demand |
| D4 | glibc below 2.28 (RHEL/CentOS 7)? | **No.** Refuse with the version found. Those systems are past end of life |
| D5 | Shared NFS homes: one server per home (refuse on the second host) or a data directory per host automatically? | **One per home, with a clear message and an opt-in per-host data directory.** Automatic per-host directories split a person's chats invisibly |
| D6 | Remember SSH passwords or passphrases (in the desktop's keychain) for silent reconnects? | **No.** Point people at `ssh-agent` and their own `ControlPersist`. A stored password is a second copy of their SSH credential |
| D7 | Install source default: stream from the desktop, or download on the remote? | **Stream by default**, remote download as a per-machine option. Streaming needs nothing on the remote and keeps one trust root |
| D8 | Sign-in exception for CLIs without a device-code flow: a local desktop terminal running `ssh -t` (6.6), rather than a terminal on the server? | **Yes.** It keeps ruling (a) intact for the server and costs no new server surface |
| D9 | npm on the remote: keep it in the pinned Node install, or ship the desktop's pure-JS npm in the bundle? | **The pure-JS npm in the bundle**: one npm version across WSL, SSH and the desktop |
| D10 | Use a systemd user unit when lingering is on, without asking? | **Yes**, and show it in Settings. Without linger, the detached process; never run `loginctl enable-linger` ourselves |
| D11 | macOS remotes in v1? | **Yes** (both arches): the experiments ran the whole path on macOS without root. A `launchd` agent comes later |
| D12 | When a desktop finds an older external server, offer the upgrade in place? | **Offer, ask first, drain the same way** — never automatic |
| D13 | *(Ruled 2026-10-02, R75: the HTTP-proxy local end with a per-session credential; no SOCKS5.)* The pane forward's local end (6.8): Chromium speaks SOCKS5 without authentication, so a SOCKS listener on the laptop's loopback can be reached by other local users while it is open. Keep SOCKS5 as ruled, or give the same forward an HTTP-proxy local end with a per-session credential that Chromium answers through Electron's `login` event? | **SOCKS5 as ruled, narrowed** (loopback, open only while a tab needs it, a uid check on Linux), until the owner says goal 4 must hold on multi-user Macs and Windows PCs too; then the HTTP-proxy end, which changes nothing else |
| D14 | The pane's partition for an SSH machine, and what goes through the remote | **One persistent partition per environment** (`persist:env-<environment.id>`), and **all of its traffic** through the remote by default, with `paneTraffic` per machine |

## 12. Changes the parent design needs

1. **10.3, "Environments in the app"**: say explicitly that an SSH route is an
   environment, not an execution host; `ExecutionHostId` stays
   `local | wsl:<distro>`, and on a remote server every process is that
   server's `local`.
2. **9.4 and 10.3 step 5**: replace `ssh -N -L` and "read the owner token over
   an exec channel" with the relay (5.4) and its in-remote authentication. The
   audit's `connection.kind` for this route is `ssh-relay`, not `ssh-tunnel`.
3. **10.1 "stdin rather than argv … works through ssh"**: true only with the
   marker handshake (E4.3a, E5); state the rule there, because phase 7's WSL
   start has the same exposure.
4. **5.5, the renderer's connection**: the renderer reaches every environment
   through main (a `MessagePort`, or a loopback relay with a ticket), since no
   environment but the local one has an address a page can open. One
   connection broker in main serves local, WSL (stdio fallback) and SSH.
5. **5.3, `welcome.environment.hostKind`**: a server cannot know how a client
   reached it (one server, two routes). Drop `hostKind` from `welcome`; the
   client knows its route. Keep `os`, `arch`, `home`.
6. **7.1, the run directory**: not `$XDG_RUNTIME_DIR` (removed at logout
   without linger); the short-path `/tmp` fallback for Linux's 108-byte socket
   path limit; `hostId` in `server.json`.
7. **10.2 / 10.3, install scripts**: generalise `wsl-install.ts` into a
   `remote-install.ts` that runs on macOS and busybox too: `mkdir` lock,
   `ps`-based liveness on macOS, one combined archive per session, no
   `flock`/`setsid`/`mv -T` dependence; `wsl-node-runtime.ts` grows darwin
   targets and downloads through Electron's `net.fetch` for proxy support.
8. **6.6**: the narrow sign-in exception on a desktop client is a local
   terminal running `ssh -t`, not a server terminal.
9. **9.3**: secrets on SSH hosts resolve to the 0600 file in nearly every case
   (no unlocked keyring in SSH sessions on Linux or macOS); say so, and report
   the choice in `server.info`.
10. **13, phase 8 risks**: add `KillUserProcesses`, Windows OpenSSH's lack of
    multiplexing, and macOS keychain-held CLI logins.
11. **8.1 (2026-10-02)**: the pane's traffic for an SSH environment goes
    through the relay's `tcp` streams, on that environment's own partition
    with `proxyBypassRules: '<-loopback>'` (6.8). Not `ssh -D`, which every
    Studio session's `ClearAllForwardings=yes` rules out.
12. **2, goal 4 (2026-10-02)**: the pane forward's SOCKS listener is the one
    local listener this phase adds, and it cannot be authenticated (D13). Say
    which way goal 4 is kept.

## 13. Commits

Each lands on `feat/studio-agent-sdk`, keeps `npm run verify:app` green, and is
reviewable alone. Phases 3, 6 and 7 are prerequisites (the server entry, the
spawn and envelope, the WSL stdio transport).

1. **`refactor(hosts): generalise the WSL install scripts for any POSIX host`**
   — `remote-install.ts` from `wsl-install.ts`: `mkdir` lock with pid
   reclaim, `ps` liveness on macOS, combined archive, marker handshake helper;
   WSL keeps its behaviour. Script tests under dash, bash, busybox, macOS sh;
   shellcheck in CI.
2. **`feat(server): relay and detached start entries`** — `server.mjs relay`
   (multiplexer to the owner socket, in-remote owner auth, `ssh-relay`
   audit kind), `server.mjs start --detach` (fork, envelope over a pipe,
   ready line, systemd-run when lingering), `server.json` fields, the run-dir
   rules. Tests with a temp data dir and a real socket.
3. **`feat(environments): the SSH command builder, destination validation and
   stderr classification`** — pure modules with golden tests; `ssh -G`
   resolution.
4. **`feat(environments): askpass shim and prompt dialogs`** — the shim (POSIX
   and Windows), the 0700 socket with per-spawn tokens, prompt
   classification, the dialogs (no status dots; words and the working mark).
5. **`feat(environments): the SSH probe and install over one session`** — the
   probe script and parser; streamed install; the remote-download option;
   Node pins for darwin targets; `net.fetch` downloads.
6. **`feat(environments): the SSH environment state machine`** — Locating,
   start/attach/upgrade/VersionBlocked, reconnect with backoff and wake
   handling, the client side of the multiplexer, resume from cursors. Fake
   spawner tests.
7. **`feat(environments): SSH machines in Settings, the sidebar and New chat`**
   — saved environments, Add SSH machine, per-machine diagnostics, Forget,
   keep-running and stop.
8. **`feat(providers): sign in on an SSH machine`** — device-code flows through
   `providers.signIn`; the local `ssh -t` terminal for the rest.
9. **`feat(environments): the pane's traffic through the SSH connection`** —
   the relay's `tcp` stream kind; `SshPaneForward` (the SOCKS5 listener, its
   lifecycle with the connection, the Linux uid check); the per-environment
   partition with its proxy and WebRTC policy; `paneTraffic` in Settings;
   `browser.status` reporting `network: 'remote'`; the 9.1 unit tests and the
   9.5 checks.
10. **`test(environments): dockerized sshd integration suite`** — the fixture
   image and the 9.3 variants in the Linux CI job; the macOS unprivileged-sshd
   job; the Windows checklist in `docs/`.
11. **`docs(design): fold phase 8's changes into the Studio server design`** —
    the section 12 edits to the parent, and a `docs/compatibility.md` note on
    the relay and its framing version.

## 14. Implementation status (2026-10-03)

Built behind a preview switch, off by default (Settings › Agents › Studio
server › "SSH machines (preview)", or `SPRINTENGINE_SSH_MACHINES=on|off`),
read once at launch like the server's own process switch. With it off no SSH
code runs: main builds no machines, no askpass broker, no pane partitions
and no IPC for them, the core gets no SSH servers, and the Machines tab is
Windows-only as before. Two guards run either way, and change nothing for a
folder on this computer: the file, git and folder channels refuse a path
argument spelled `ssh://` in words (text such as a file's contents, a
search or a commit message is never read as one), and this process's
runtime refuses a chat whose folder is spelled so. A machine's workspace
left from a session with the preview on then offers no sign-in and no
terminal. The server tree ships in every installer (about
5 MB unpacked), used only by WSL distributions and SSH machines; a macOS or
Linux build needs it only for the preview. With the switch on:

- Commits 1–10 of section 13, each with its "As built" notes above:
  the shared POSIX install, the relay and the detached start, the ssh command
  builder, askpass and its dialogs, the probe and the one-session install,
  the state machine, Settings, New chat and the sidebar, the pane's forward
  (an HTTP proxy by R75), and the dockerized sshd suites with their CI job.
- Section 12's changes 1, 2, 3 and 11 are folded into the parent design and
  `docs/compatibility.md` notes the private wires.

Files and git for a workspace on an SSH machine (the owner's ruling: the
server holds raw access to its machine, clients build the views). Such a
workspace keeps its folder spelled `ssh://<saved id>/home/dev/repo`
(`shared/machine-paths.ts`), so nothing on this computer can mistake it for
one of its own folders. The desktop's file, git, terminal and folder IPC
registrations go through `machineAwareIpc` (`src/main/environments/ssh/
machine-ipc.ts`): an invoke that names a machine path is never handed to this
computer's file system or git. The machine channels
(`shared/machine-channels.ts`: reading directories and files, image data,
stat, the folder check, @-mention search; git's repository root, status,
ignore checks, file bases and revisions, hunks, change summaries, branch
steps, branches, history and identity; staging, unstaging and committing) go
to that machine's server on the backend wire (`backend.machine`, wire version
2), which answers with the same modules the desktop answers its own folders
with (`src/server/machine/machine-channels.ts`), and the paths in the answer
are spelled again (fields named for paths, and path-keyed maps; never file
contents). A watch is answered that there is none; every other channel is
refused with "Not available for SSH machines yet (<channel>)". So the
explorer, the editor's and previews' reads, @-mentions, git status and diffs
in the Git pane, and staging and committing work, read and run on the
machine. The router translates a chat's root at its edge as it does for WSL
(`createPathEdge`, shared now by both). This process's own runtime refuses a
chat whose folder is spelled for a machine, in words, and local root scans
drop such folders, so turning the preview off never makes this computer
read or write a folder named after one (`machine-files.test.ts` against the
real relay, with a decoy local folder of the same plain path).

Signing a chat's CLI in on an SSH machine, with no terminal (decision R34,
`src/server/machine/machine-sign-in.ts`): the chat's Sign in runs the CLI's
own login on the machine as a plain child of its server (`backend.sign-in`
on the wire: start, paste, wait, cancel), read for its link, its one-time
code and whether it waits for a pasted code. Read from each CLI's output
with no terminal attached: `codex login --device-auth` (a device code),
`cursor-agent login` with `NO_OPEN_BROWSER` (a link it polls), `claude auth
login` (a link, then a code pasted back). Main shows it in the prompt dialog
(`kind: 'sign-in'`): the link with Open in browser, the code, a field for a
pasted code; the dialog closes itself when the login finishes. Any other CLI
is told the exact command, `ssh -t <destination> <its login>`. A login still
waiting ends with its server.

Out of process (phase 6's switch), main still holds the SSH sessions. The
desktop's server asks main for each relay stream it needs
(`shell.ssh.open { key, purpose }`); main opens it on the machine's session
and hands the server a message port spliced onto it (an `ssh-stream`
attach), over which the server reads its conversation wire and relays the
desktop's browser and canvas toolsets. Main tells the server when a machine
connects or reconnects (`ssh.connected`), and again for every connected
machine when a restarted server comes up, so its router follows that
machine's chats as the in-process core does
(`src/server/desktop/shell-ssh-servers.ts`).

The jump-host and password variants of 9.3 ran against containers' sshd
(`ssh-variants.docker.test.ts`): a machine reachable only through a bastion
by `ProxyJump` in the config, both host keys asked and checked, the server
started on the target and nothing on the bastion; and `AuthenticationMethods
publickey,password`, the key's passphrase and then the password asked through
the shim in order, a wrong password said in words.

Ran against a real `sshd` (Ubuntu 24.04 in Docker on an arm64 Mac, forwarding
of every kind off): the host-key question and a key's passphrase through the
askpass shim, a refusal that leaves `known_hosts` untouched, the pinned Linux
Node downloaded and checked on the desktop and streamed with the server tree,
a managed server started and attached, a chat on the mock provider, the
session killed mid-turn and the background reconnect stopping at
`needs-sign-in` (the key is not in an agent), the person's reconnect joining
the same turn by its command id, a `noexec` home refused in words, and the
relay reaching the remote's `localhost`. The install scripts ran under dash,
bash, zsh as sh and macOS `sh`, and under busybox in Alpine. An Electron check
loaded the remote's page through the forward (section 6.8, "As built").

Changed at review (2026-10-03): the pane's forward passes a plain request
on once and tells Chromium every connection closes (6.8); the V-P3 rule
(6.8, 9.5); an install directory checked through a symlink and refused
when anyone may write in it; the `ssh-keygen -R` line offered only for a
plain host name, since a remote's banner shares ssh's stderr; questions an
older ssh cannot attribute shown as such (5.5); prereleases ordered when
deciding to upgrade, so an older nightly never replaces a newer one's
server; background connects joining the reconnect's backoff instead of
starting their own; the out-of-process `shell.ssh.open` given as long as a
first install takes, and an unclaimed stream's port closed; a sign-in's
login ended with its process group; and nothing of a machine's workspace
written on this computer (a board inside its folder, a terminal launch's
`.mcp.json` and skills, a chat launch's skills).

Not built yet:

- **Sign-in, the rest of R34**: credential fields, a browser callback the
  desktop catches, and the sign-in-only terminal (the server bundle carries
  no pty). A CLI with none of the three flows above (opencode's provider
  picker, an API-key CLI) is answered with the command to run once over the
  person's own SSH session. The flows were read from each CLI's output on a
  Mac with no terminal attached; no CLI was signed in on a remote.
- **Not tested in the running app**: the New chat SSH flow, the Settings
  section, the chat view's sign-in and the explorer and Git pane on a
  machine's workspace have unit and wire-level tests; the app itself booted
  with the preview on in both server modes (`smoke-server-mode.mjs`), but was
  not driven through them.
- **Files**: no watch on a machine's folder (the views refresh when asked
  again), no file writes from the editor, and from the Git pane only staging
  and committing: push, pull, branches, stashes, worktrees, changelists,
  conflict resolution and patches answer "Not available for SSH machines
  yet". Terminals and agent launches in a terminal answer the same.
- `auth.sessions.list` for SSH sessions, `server.logs.tail` in Diagnostics
  (they show the bootstrap's steps, the probe and ssh's words), `ssh -W` as a
  diagnostic, the Windows job
  (9.4; the Windows shim is written but has not run).
- A published release archive of the server tree, so the remote download
  covers the Node runtime only (5.3).

