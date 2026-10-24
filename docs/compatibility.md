# Wire compatibility

Studio talks to software it does not ship with: another Studio on your tailnet,
the phone app, and the extensions people install into it. Both ends update on
their own schedule, so neither can assume the other is the same build. This
file is the policy for what that obliges you to do when you change something
that crosses the gap.

It is short on purpose. The one thing it must get across: **a wire format is not
a private data structure, and changing one is not a local edit.**

## What is versioned

| Wire                                                                                  | Version                                  | Window                                               | Declared in                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Tailnet transport — Studio driving another Studio                                     | `TAILNET_TRANSPORT_VERSION` (integer)    | `TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION` .. current | `src/main/automation/tailnet/tailnet-routes.ts` |
| Mobile control — the phone reading and driving a desktop over the tailnet gateway     | `mobileControlProtocolVersion` (integer) | `mobileControlSupportedProtocolVersions`             | `src/main/mobile/control/protocol.ts`           |
| MCP                                                                                   | dated strings, newest first              | every entry in the list                              | `src/shared/mcp/protocol.ts`                    |
| Module host API — an installed extension built against `@sprintengine/module-sdk`     | `HOST_API_VERSION` (integer)             | `HOST_API_MIN_SUPPORTED` .. current                  | `src/shared/modules/host-api.ts`                |
| Studio protocol — a client on Studio's owner socket (`@sprintengine/studio-protocol`) | `STUDIO_PROTOCOL_VERSION` (integer)      | `STUDIO_PROTOCOL_MIN_SUPPORTED` .. current           | `packages/studio-protocol/src/handshake.ts`     |
| Embed `postMessage` — a page framing an embedded conversation (`se.embed`)            | `EMBED_PROTOCOL_VERSION` (integer, `v`)  | current only (one version of slack when 2 ships)     | `src/renderer/src/web/embed/embedProtocol.ts`   |

One more version number is near these and is **not** a wire window: the
backlog item schema version is a file format, and is not negotiated with a peer.
(`mobileControlWorkspaceSnapshotVersion` was a second; it versioned the mobile
snapshot's `workspaces` detail body and left the wire with it in v4.)

Alongside the tailnet version is `TAILNET_CAPABILITIES` — a list of named,
additive features. It is not a version and does not follow one; see
"Capabilities, not version arithmetic" below.

Three wires between this app and the Studio server trees it installs on a WSL
distribution or an SSH machine are private and are not in this table: the
bootstrap envelope, the front door's proof preamble (`FRONT_DOOR_PROOF_VERSION`)
and the conversation backend wire (`BACKEND_WIRE_VERSION`), and the SSH
relay's multiplexer (`MUX_VERSION` in `resources/wsl-server/relay-mux.mjs`).
Both ends are this app's own build: the tree is installed per app version and
checked by digest. An SSH machine can run another version's server (a newer
desktop installed it); the desktop then speaks to it only when it is this
version, upgrades an older managed one, and otherwise refuses in words
(`locateServer` in `src/main/environments/ssh/ssh-connect-script.ts`). Bump
`BACKEND_WIRE_VERSION` whenever a forwarded member's arguments or answer
change, and `MUX_VERSION` whenever a frame does. A number once on `main` is
spent, even before a release, since a nightly may already carry it: two changes
made side by side take one each. The backend wire went from 2 to 3 when
`sendTurn` took `origin` (a message Studio sends a chat itself), and to 4 when
it took `files` (a message's files attached by path), both on 2026-10-07. It
went to 5 when `sendTurn` took `composedAt` and `confirmedStale` and could
answer `stale` (2026-10-20), and to 6 when it gained `handoffConversation`, a
chat handed off to a fresh session, and `sendTurn`'s `origin` the reason
`auto-compact` (2026-10-21).

A session's summary, which that wire pushes with every chat event, carries
three optional clocks a reader must not count on: `lastTurnEndedAt` (when
the agent last finished a turn), `turnStartedAt` (when the turn now running
began) and `waitingSince` (when the chat began waiting on the person, by the
time of the approval or question that stopped it; absent while nothing is
asked). Each is additive, with no bump: a server of the same wire version
built before one existed leaves it out, and the desktop reads that absence
as it did before the member: a "working for" count and the next chat that
needs you (`nextWaitingChat.ts`) both fall back to `updatedAt`. A fourth,
`workingSince` (2026-10-20: when the chat's current stretch of work began,
held through the turns it opens by itself while a background agent or a
monitor works; present only while the summary reads as working), is additive
the same way: a server built before it leaves it out, and the desktop counts
"working for" from its own reading of the turns, as it did before.

The summary also carries `fileActivity`: the files the chat's tool calls are
reading and editing, and the ones they finished with in the last minute, which
the Files tree marks. It is additive in the same way. A server built before it
leaves it out, and the tree reads that as an agent touching nothing: the tree
draws no trail for that chat, and nothing else reads the member.

A conversation search hit carries `from`: who wrote the matching words (the
person, the agent, or Studio). It is additive in the same way. A server built
before it leaves it out, and the palette still shows the match, without the
"You:" or "Agent:" in front of it, ranked after the hits that say.

So is `backgroundTasks`: the shells, monitors and workflows the chat's process
still runs after its turn ended, which a `session_updated` event carries as the
whole list each time it changes. A server built before it leaves both out, and
the desktop reads that as nothing running: a monitor does not keep the chat
working, the composer names nothing it waits on, and that server's own idle
sweep is the one that decides whether its child lives. Stop between turns is the
same `interrupt` the wires already carry: a server built before it answers as
it always did, that the session has no active turn, and the chat says so.

So is `goal`: the goal a Codex chat keeps working toward by itself, which a
`session_updated` event carries when it changes, and as null once there is
none. A server built before it never sends it, and its chats have no goal to
show. A client built before it skips the member, as it skips any it does not
know; the turns Codex starts toward the goal reach it as `turn_started` with no
`user_message` before them, which every client already takes for a turn an
agent carried on with by itself. That event's `follows`, the turn it came
straight after, is read by the desktop's own runtime and by nothing else.

## The support window

Both integer wires accept **one version of slack**: the current version and the
one before it. Anything outside is refused at the handshake, by a named error
that says both what was seen and what is supported.

- Tailnet: `checkTailnetTransportVersion` in `tailnet-routes.ts`, applied in
  `readRemoteIdentity` (`tailnet-remote-client.ts`). A machine outside the window
  is reported unreachable with the reason, and shown as such in the Remote panel.
- Mobile: `isSupportedMobileControlProtocolVersion`, and the
  `unsupported_protocol_version` error code. Enforced on inbound commands
  (`command-validation.ts`, behind `workspace.mobile_command`). The snapshot the
  desktop sends is stamped with the current version, and the phone reads it at
  that version only. The phone pairs through the tailnet gateway's own pairing,
  which is versioned by the tailnet transport, not by this integer.

One version, and not more, because the second version back is one this tree no
longer has to be able to produce, and a window wider than the shapes anyone
tests is a promise that quietly stops being true.

The window is also why the **refusal must name both numbers**. "Unsupported
protocol version" alone cannot tell someone which of their two installs to
update, which makes it a support thread instead of a fix.

## Capabilities, not version arithmetic

Where the question is "can this peer do X", ask the capability list, not the
version integer. A capability list is what the peer says about itself now; a
version is a proxy for it that goes stale in three ways — a feature can be
back-ported to an older version, withdrawn by a build that keeps the version, or
shipped behind a setting.

The tailnet transport advertises `capabilities` on `health`, on the pairing
response and on `identity`; `tailnetPeerSupports` is the accessor. A peer that
advertises no list has no capabilities, not all of them — but note that a peer
which published **no list** (null) is a different fact from one that published an
**empty list**, and only the second is a denial. The capability list shipped a
day after the first feature it describes, so silence there means "unknown".

This is what lets the version window stay narrow while the wire keeps growing: a
**purely additive** feature ships as a capability with no version bump at all, so
no peer is refused over it.

A capability can name an addition to a gateway tool as well as to a route or a
frame. The phone's New chat calls `conversation.create` and `cli.runtime.list`,
and three capabilities (2026-10-05) say what those take and answer:
`new-chat-worktree` (`conversation.create` takes `worktree`), `new-chat-effort`
(it takes `effort`) and `cli-runtime-catalog` (`cli.runtime.list` answers each
CLI with a `catalog`, the model picker's own rows). An argument needs its
capability more than a route does: a handler skips an argument it does not
know rather than refusing it, so a `worktree` sent to a desktop without the
capability starts the chat in the checkout and says nothing. The answer to a
`worktree` create may carry `dependencyInstall` (2026-10-07): the new
worktree's project installs its dependencies first, the chat and its session
already exist, and the first message goes once the install ends. It is an
optional member with no capability: a client that does not read it sees the
chat start a little later, and an older desktop never sends it. A paired
desktop's New chat added two more (2026-10-09): `new-chat-worktree-name`
(`conversation.create` takes `worktreeName`, what a `worktree` and its
branch are named from) and `new-chat-in-worktree` (it takes `inWorktree`, a worktree the
project already has, by the path `workspace.checkout` lists). Its answer then
names the `worktree` the chat runs in, an optional member like
`dependencyInstall`. The desktop asking refuses a worktree a machine does not
advertise rather than sending it, for the reason above. These names carry
no `conversation-` prefix, which is kept for the conversation lane's own
vocabulary: every `conversation-` capability this machine advertises must be
one `@sprintengine/conversation-protocol` names
(`conversation-protocol.test.ts`).

`usage-report` (2026-10-21) names a gateway tool of its own: `usage.report`
answers a window of this machine's token usage for a paired desktop's Usage
dashboard, on `workspace:read`, and is listed only to paired devices. Its
structured answer carries a `version` of its own (1), which moves only for a
change an older reader would misread, beside rows of
`[hour, agent, sessionIndex, model, input, output, cacheRead, cacheWrite,
requests, reportedCostUsd, speed?]` and the hashed session ids they point
into; a member added later is optional, and a reader skips a row it cannot
read rather than the answer. A window too large for one answer ends on an
hour and names `nextFrom`, where the next call starts, so no answer runs into
the client's 4 MB. A desktop that does not see the capability asks nothing
and says that machine's Studio needs updating; one that sees an answer of
another `version` counts nothing from it and says the same. The desktop
asking prices the rows itself, so two machines on different price lists
still agree.

Bump the version instead when the change is not additive: a field that changes
meaning or type, a field that is removed, a response whose shape a peer is
already parsing. Nothing a capability flag can describe should bump the version,
and nothing a capability flag cannot describe should ship without one.

## The module host API

An extension is compiled against `@sprintengine/module-sdk` and runs inside
whatever Studio later loads it, so the contract between them — the `MainHost`
and `RendererHost` members, the services behind the SDK's `get*Service`
helpers, the manifest fields — is a wire in the sense of this file, even though
nothing crosses a network.

- **The version.** `HOST_API_VERSION = 1`, `HOST_API_MIN_SUPPORTED = 1`. Both
  are declared once, in `packages/module-sdk/src/host-api.ts`, and re-exported
  for app code by `src/shared/modules/host-api.ts`, so the app, the SDK and the
  `sprintengine-module` CLI cannot disagree about them. The drift guard
  (`npm run test:sdk:drift`) pins the two sides anyway.
- **The declaration.** A third-party manifest must carry
  `"engines": { "hostApi": <n> }`. First-party modules ship with the host they
  run on and may omit it.
- **The window.** A module loads when `HOST_API_MIN_SUPPORTED <= n <=
HOST_API_VERSION`. `checkHostApiCompatibility` is the one check; it is
  applied when modules are planned at startup (`src/main/modules/host-api-gate.ts`),
  when renderer entries are served (`third-party-renderer-entries.ts`), when a
  module's state is shown (`src/shared/modules/resolve.ts`, as
  `incompatible_host_api` rather than "not trusted"), and by the CLI's `sign`,
  `verify` and `pack`. A refusal names both numbers and which side to update —
  the same rule as the integer wires above.
- **Unlike the integer wires, the window is not one version wide by rule.** An
  extension is not a peer that updates alongside the app; raise
  `HOST_API_MIN_SUPPORTED` only when the host genuinely stops providing
  something older modules were promised, and say so in the SDK's
  `CHANGELOG.md`.
- **Capabilities.** `host.supports(name)` answers what the running host
  provides now, from the table in `src/shared/modules/host-api.ts`
  (`hostSupports`). The names are the SDK's `HostCapability` union:
  `conversations`, `conversation-controls`, `conversation-streams`,
  `conversation-requests`, `conversation-permissions`, `chat.open`, `companion-agents`,
  `scheduled-agents`, `secrets`, `github`, `storage`, `mcp-tools`, `skills`,
  `module-assets`, `notifications`, `companion-tools`, `conversation-replies`,
  `text-generation`, `conversation-worktrees`, `chat-runtimes`,
  `scheduled-agent-runs`, `chat.open-options` (a renderer's, answered live
  like `chat.open`), and `electron-main`, which the main host
  answers itself: true in the desktop's own main process, false where a
  module's main half runs in the Studio server out of process.
- **`requires.hostCapabilities`.** An optional manifest field (added with
  `electron-main`, no version bump): a module whose `entry.main` cannot run
  without a capability names it, and a host that lacks it loads the module
  manifest-only (its renderer half still loads). The validator keeps names it
  does not know, since a host that does not know a name does not support it.
  A capability joins the table in the same change that makes it real, and an
  unknown name answers `false`. As on the tailnet, an additive feature ships as
  a capability with no version bump.
- **When to bump.** Removing or changing a host member, a service method or a
  manifest field that a module built for the current version may use. Adding
  an optional member, a service, a capability or a permission is additive.
  `scripts/release/sdk-release-check.mjs` (run by `npm run test:release`) checks
  that the version quoted here matches the source.

## The mobile wire lives in this tree

The mobile-control shapes — the snapshot the phone reads and the commands it
sends — are declared in `src/main/mobile/control/protocol.ts`, next to the
snapshot builder and command service that are their only producers here. They
used to ship as the `@sprintengine/mobile-control-protocol` package, when the
same wire also ran through a hosted relay; the relay was removed on 2026-09-27
(owner ruling) and the package with it. Its published `4.x` versions stay on
npm, and wire version 4 is what this tree still speaks, unchanged.

The phone app keeps its own copy of these types, in
`mobile/src/shared/mobile-control/protocol.ts`. Nothing compares the two
automatically any more, so a change that crosses the wire is made on both sides
in the same coordinated change, and the version integer is still the only thing
a peer sees.

### Direct conversation lane

`@sprintengine/conversation-protocol` is a separate portable package for the
additive `conversations` tailnet capability. It owns the direct conversation
WebSocket frames, their client validator and pure tool-presentation helpers,
and since `0.2.0` the whole conversation contract: the event layer, the
command vocabulary, create requests, the `hello` handshake and the capability
names. It does not change the mobile-control wire or its version number.

The lane has its own `CONVERSATION_PROTOCOL_VERSION`, answered by `hello` on a
desktop that advertises `conversation-hello`, with the same one-version window
rule as the integer wires above (`checkConversationProtocolVersion` names both
numbers). It is 1, and like them it moves only for a change a capability
cannot describe. `0.2.0` added three capabilities and no version:
`conversation-hello`, `conversation-plans` (`resolvePlan`) and
`conversation-cli-permission-modes` (a `permissionMode` beside the preset).
Each degrades on a desktop without it to something that desktop already does:
`hello` and `resolvePlan` are refused under their ids, and an unknown
`permissionMode` member is dropped, so the preset's own mode runs.

An `answerQuestion`'s answers are keyed by each question's whole text, which
is how the CLI reads them back. The first version capped a key at 200
characters, so a long question's answer was refused as `invalid_frame`. Since
2026-10-16 a desktop accepts a key as long as an answer (20,000 characters),
with the frame's total still the message limit. Only the validator widened:
a client sends the same frame to either desktop, and an older one goes on
refusing a long question as it always did. The first version's reader in
`index.ts` is unchanged, since the phone carries it byte for byte; the wider
rule is in `clientFrames.ts`, the server half.

The initial `0.1.0` contract requires the `conversations` capability. Additive
optional fields preserve that contract. Model switching is one such addition: its own
`conversation-models` capability, a `models` catalog on a listed thread, the
`setModel` command, the `unsupported_model` code and a `notice` on an accepted
command. A client hides its model control for a desktop that does not
advertise it, and such a desktop refuses the command as `unsupported_command`.
The pictures a chat's steps show are another: the `conversation-images`
capability names a plain `GET /tailnet/v1/conversation-image` beside the socket
rather than a frame, so it changes neither the frame contract nor this package.
A client that does not see it says the picture is on the other machine, and an
older desktop answers the route 404. The pictures a person sent with a message
are the `conversation-message-images` capability (2026-10-16), on the same
route: `attachment`, the `ref` an entry of a `user_message`'s `attachments`
records, in place of `toolUseId`. Those entries (`{ id, mediaType, name?,
byteLength, ref }`) were on the wire before it, an optional member with no
capability; the capability only says the bytes can be fetched. A client that
does not see it names the picture, and an older desktop answers the request
400, since it names no `toolUseId`. Files of any type with a message are the
`conversation-message-files` capability (2026-10-17): the upload route takes
`kind=file`, and the `uploadIds` a `send` already carried name that upload as
they name a picture's, so neither the route's path nor any frame changed. The
message records it in `files` (`{ path }`), a member `user_message` carried
before for files dropped on the desktop. A client that does not see it offers
pictures only; an older desktop refuses a file `415 invalid_media_type`, as it
always did. A file is kept as it came: `conversation-image-downscale`
applies to pictures only. A desktop that shrinks an uploaded picture for the
model on receipt advertises `conversation-image-downscale`
(2026-10-17): its `POST /tailnet/v1/upload` takes up to 20 MB as the bytes
arrive, where it took 5 MB, and keeps at most 5 MB, sized to its composer's
1568px long edge. Nothing in the request or the answer changed shape. A client
that does not see it holds its upload to 5 MB, as before, and an older desktop
refuses a larger one `413 too_large`, as it always did. Only a desktop has the
image codec, so a standalone Studio server leaves it out, and the Studio RPC,
whose own uploads are kept as they came, never lists it. The machine each chat runs on (`host`),
its pull requests (`pullRequests`) and the desktop's own kind and colour
(`machine` on `identity`) are optional members with no capability: an older
phone ignores them, and a phone reads their absence as a desktop that does not
send them (`docs/conversations.md`, "Machines and pull requests in the list").
A listed chat's `backgroundWork` (2026-10-17: `{ agents, monitors }`, the
background agents still running and the monitors that will wake its agent) is
another, beside a `phase` left as the turn's own: the desktop's sidebar counts
such a chat as working, but a phone of that date holds a plain send while the
listed phase says `running`, so the phase could not carry it. An older phone
ignores the member and shows the chat as finished, as before; a phone that
reads it shows the chat working without holding sends.
`workingSince` (2026-10-20) is another, beside `turnStartedAt`: when the
chat's stretch of work began, the person's message that began it, held
through the turns the chat opens by itself while its `backgroundWork` goes on,
which is the number the desktop's own sidebar counts "working for" from. It
is listed whenever the desktop counts the chat as working, background work
included. A client that does not read it counts from `turnStartedAt`, as
before, and restarts with each turn the chat opens by itself; a client that
reads it falls back to `turnStartedAt` for a desktop that does not send it.
So are `scheduledAgentId` (the schedule whose run started the chat, which
the desktop marks with the schedule's clock) and `snoozedUntil` (when a chat
the person snoozed on the desktop wakes, listed only while that is ahead): a
client that reads them draws the clock, and leaves a sleeping chat unmarked
by "finished, unseen" until it wakes, as the desktop's own row does; an older
client ignores both.
The context a chat has spent (`contextWindow` and `contextUsed` on a
`usage_updated` event) is the same kind of member: a phone that does not read
them shows no context ring, and one that does draws none for a desktop that
does not send them. The files a message attached by path (`files` on a
`user_message`, each `{ path }`, a path on the desktop's disk) are the same
kind of member: the message's `text` is the person's words alone, an older
phone shows those and nothing more, and a phone that reads the member can
name the files (it cannot open them). The phone's commands do not send
`files`, so nothing it sends changed. The pictures a step returned
(`images` on a `tool_output`, 2026-10-09: paths on the desktop that ran it, at
most eight, a browser screenshot most often) are the same kind of member: the
bytes were never on the wire and still are not, an older phone shows the
step's words as before, and a reader that knows the member can say the step
returned pictures but cannot fetch them, since `conversation-image` serves a
step's picture by the step's input and not by this list. An MCP step's own
title and its server's name (`displayTitle` and `serverName` on a
`tool_started`, 2026-10-13: plain text, at most 120 characters each) are the
same kind of member: a reader that does not know them titles the step from
its wire name, as every reader did before. So is `origin` on a `user_message`
payload (`ConversationMessageOrigin`, 2026-10-07), which marks a message the
desktop sent a chat itself — a launched agent's notice, a resume after a usage limit —
as Studio's: a reader that does not know it shows the message as the person's,
as every reader did before, and a message without one is the person's. Its
`reason` gained `pull-request-watch` (2026-10-11), a wake about a pull request
the chat's agent asked the desktop to watch; a reader that does not know a
reason still reads the message as Studio's, without one.
A chat's rest and read state are the `conversation-lifecycle` capability: a
desktop that advertises it leaves the chats it has settled out of the list, sends it in its sidebar's order, names
each chat's `chatTitle`, `lastUserMessageAt`, `lastTurnEndedAt` and
`lastVisitedAt`, and serves the `conversation.settle` and `conversation.visit`
gateway tools; `workspace.list` items carry `settledAt` beside it, with no
capability of their own. The members are optional and the tools new, so no
peer is refused over any of it: a client offers no Settle for a desktop that
does not advertise it, and an older one answers either tool "Unknown tool"
(`docs/conversations.md`, "Rest, order and read state in the list").
The leaving out and the order are the capability's promise, so they hold only
where it is advertised: the Studio RPC does not advertise it, and its
`conversation.list` is the list it always was, every chat (settled ones
included) most recently moved first. The members ride along there too, as
optional additions a client that does not read them never sees.
Mark unread (2026-10-07) is a gateway tool beside them,
`conversation.mark_unread`, advertised as `chat-mark-unread` (no
`conversation-` prefix: it names a tool, not the conversation lane). It
deliberately amends one rule: `lastVisitedAt` had only ever moved forward, and
this tool moves it back, to just before the chat's latest finish. That is not
a bump, because nothing a peer parses changed: the member keeps its type, may
be absent exactly as before, and still means the clock every device reads
"finished, unseen" against. A client from before the tool sees an earlier
visit time and nothing else; the phone of that date takes the later of the
listed clock and its own readings, so at worst it keeps showing the chat as
read. On the desktop the rewind travels as `lastVisitedAt` with a newer
`visitRewoundAt`, the only patch that may lower the clock, so a lagging
window's visit still cannot. A phone that adds Mark unread checks for
`chat-mark-unread`, and must stop keeping its own later visit readings over
an earlier listed one. Each listed chat names that stamp as `visitRewoundAt`
beside `lastVisitedAt`, an optional member with no capability of its own: a
phone drops only the readings it took before the stamp, so a chat marked
unread while the phone was closed reads unread there, and an older phone
ignores the member. The Studio
RPC does not advertise it, having no method for either tool.
A queued message is the `conversation-queued-sends` capability (2026-10-08):
a `send` that says `queue` is held by the desktop and sent when the chat's
turn ends, `cancelQueued` takes one back, and a client that asks with a
`watchQueued` request is sent `queued` frames saying what is held for the
chat it follows. All of it is additive: a desktop without the capability
drops `queue` and refuses a send made mid-turn `busy`, as it always did, and
answers the new command and request under their ids; a desktop sends `queued`
frames only to a client that asked, so a phone that never asks never sees
one. A client asks whenever the desktop has not said it lacks the
capability, since an older desktop's refusal is harmless. The Studio RPC does
not advertise it: its conversation topic carries no `queued` frames, and its
`conversation.cancelQueued` method is an owner's only.
A steered message is the `conversation-steer-sends` capability (2026-10-14):
a `send` that says `steer: true` goes into the turn the chat is running, where
its provider takes one, and each listed chat says whether it does as
`capabilities.steer`, an optional boolean. With no turn running the send is an
ordinary one; a turn that cannot take it has the desktop hold the message as a
`queue` send is held, answered at once with a `notice`, or, for a message with
`uploadIds` or `skills` that a held one cannot carry, refused `busy` as a
mid-turn send always was, and run as the next turn when sent again once the
turn is over. One that reached the chat is answered as taken, its turn's end
in the `notice`, even when that turn then fails. `steer` is never beside `queue`. All of it is
additive: a desktop without the capability drops `steer`, so the send is
refused `busy` mid-turn as before, and a client sends it only where it is
advertised. The Studio RPC advertises it too: its `conversation.send` reads
the lane's own validator and reaches the same host.
One agent stopped by itself is the `conversation-stop-subagent` capability
(2026-10-24): a `stopSubagent` command names an agent a chat spawned by the
call that spawned it (`toolUseId`, as its `subagent_status` events carry it),
and stops that agent alone, leaving the chat, its turn and its other agents
running, between turns too. Each listed chat says whether its provider can as
`capabilities.stopSubagent`, an optional boolean. It matters more than its
size: the same release has a chat's turn Stop spare the agents a Claude chat
runs, so a client that offers no agent's Stop leaves a runaway agent no way to
be stopped short of settling the chat. All of it is additive: a desktop
without the capability refuses the kind as `unsupported_command`, and a client
sends it only where it is advertised (a desktop following another machine's
chat refuses it there in words first). The Studio RPC advertises it too: its
`conversation.stopSubagent` method, an owner's for now, reads the lane's own
validator and reaches the same host.
A `send` may say when it was written, `composedAt` (epoch ms, the client's
clock), and that the person confirmed one written long ago, `confirmedStale`
(2026-10-20). A desktop that reads them records `composedAt` on the
`user_message` and refuses a send written more than
`CONVERSATION_STALE_SEND_MS` (30 minutes) ago with the new `stale` code,
recording nothing and keeping no receipt, unless `confirmedStale` is set; a
`queue` send it would hold is refused the same way, since a held message goes
the moment the chat is free. A repeat of a send that already went is still
answered from its receipt, however old. No capability: a desktop built before
the members drops both (the first version's validator strips unknown members)
and sends as it always did, so a client sends `composedAt` with every message
and keeps its own rule for what it no longer sends without asking (the phone
stops at ten minutes after an absence, `mobile/src/features/conversations/queuedSends.ts`).
An older client never sends either, and its sends are never stale. `stale` is
an error code a client from before it reads as any refusal with a message;
the code joined the pinned `ConversationWireErrorCode` union, so both copies
and both pins moved with it.
A desktop also remembers, across a restart, the commands its held messages
came in on, while each is held and for the 500 most recent after it has gone,
so the same `queue` command offered again (its answer lost, or the desktop
restarted) is answered as held and never held or sent a second time
(`scheduled-messages.json` keeps `sources` on a message and a top-level
`heldSources`; a file without them reads as before).
Create PR on a paired machine's chat is `chat-create-pull-request`
(2026-10-18), gateway tools beside `conversation.mark_unread` and, like it,
without the `conversation-` prefix: `conversation.pull_request_state`
(`conversation:read`) and `conversation.pull_request_draft`, `_draft_cancel`,
`_push` and `_create` (`conversation:operate`). Each names the chat by
`workspaceId` and `agentId`, never a folder; the machine reads the chat's
checkout from its own record, drafts with its own text generation settings,
and records a pull request it creates as the chat's, so its next list carries
it. All of it is additive: a client offers Create PR under a machine's chats
only where it is advertised, and an older machine answers the tools "Unknown
tool". The Studio RPC does not advertise it, having no method for them.
A paired desktop's row menu on a machine's chat is `chat-row-menu`
(2026-10-21), gateway tools beside `conversation.mark_unread` and, like it,
without the `conversation-` prefix: `conversation.highlight` (Star and
Highlight color), `conversation.snooze` (Snooze, and Wake now with `until:
null`) and `conversation.auto_settle`, each on `conversation:operate` and
audited. Each listed chat names what they write as two new optional members
of `ConversationThread`, `highlight` (`{ starred, color? }`, the colour one
of `CONVERSATION_HIGHLIGHT_COLORS`) and `autoSettle: true`, with no
capability of their own; `parseConversationServerFrame` keeps a `highlight`
it can read, a known colour and a boolean star, and `autoSettle` only when it
is `true`. All of it is additive: a client offers Star, Highlight color,
Snooze and Auto-settle for a machine's chats only where it is advertised, an
older machine answers the tools "Unknown tool", and an older client ignores
the members. The pinned phone files are unchanged. The Studio RPC does not
advertise it, having no method for them.
Breaking frame changes require a new
negotiated capability or the tailnet version-window process above, not merely
a package version change. Presentation-only fixes use a package patch.
Both ESM and CommonJS tarball consumers and Node16 declarations are checked by
`npm run test:conversation-protocol:pack` as part of `verify:app`.

Until a published version is adopted, the phone carries the same portable source
files with a shared SHA-256 pin. A wire or presentation edit must update both
copies and both pins in companion changes; passing one repo's local hash check
alone does not prove the two peers agree. The pin covers `index.ts` and the four
files it re-exports; the package's entry is `public.ts`, which re-exports those
and the files added since, so an addition goes in a file of its own and leaves
the pin alone. Publishing is a separate release step.

### The Studio protocol

`@sprintengine/studio-protocol` is what Studio serves on its owner socket (a
Unix socket in `<userData>/run/`, or a named pipe on Windows) to the
applications on this machine a person has paired with it, and is the protocol
`@sprintengine/agent-sdk` speaks. It is a connection envelope — `hello` /
`welcome`, requests answered by id, subscriptions keyed by id — around the
conversation contract, which it depends on and re-exports rather than copies:
a stream's frames are the conversation lane's own server frames, and a
command's params are read by the lane's own validator. The phone's pinned
files are not touched by it.

`STUDIO_PROTOCOL_VERSION` is 1, with the same one-version window as the
integer wires above; `checkStudioProtocolVersion` refuses a peer outside it at
the handshake, naming both numbers, and the server answers that refusal as
`bye { code: 'unsupported_protocol_version' }`. Features are capabilities
(`conversations`, `conversation-create`, `local-pairing`, and the chat
surface's in `STUDIO_CHAT_CAPABILITIES`) advertised in the `welcome`, a Studio
leaving out any it does not serve; the conversation contract's own `protocolVersion` and capabilities
travel inside it, in `welcome.conversation`, unchanged. A new method or topic
is a capability, not a bump; so is a new server frame type (`push` was one),
since a client skips a frame type it does not know. Client tools are one such
capability within version 1: `client-tools` adds the `tools.*` methods and
stream, the server frames `call` and `cancel`, and the client frames `reply`
and `progress`. A Studio sends `call` only to a connection that offered a
toolset, and the SDK sends `reply` only to a Studio that advertised the
capability, so neither end is handed a frame type it does not know.
`conversation-handoff` (2026-10-21) adds the owner-only
`conversation.handoff`, a chat handed off to a fresh session instead of
compacted, answered with the path of the file its messages were saved to.
`files-write` adds the owner-only `files.*` by root, which the canvas uses
over a Studio's boards. The `store` root kind (2026-10-16), the project's
store in the person's home where a Studio keeps the captures, recordings and
transcripts older builds kept in `<project>/.sprintengine/`, is additive under
it with no capability of its own: `files.roots` answers `store: true` where it
is served, a Studio built before it leaves the member out and refuses the kind
as `invalid_params`, and a client asks for it only where it is listed. An old
client's read of `.sprintengine/…` under the `workspace` root that the folder
no longer has is answered from the store, so a path it learned from an older
Studio still finds its file. `pull-requests` adds the owner-only `pullRequests.*`
methods and stream, and `pull-request-tool-calls` the one method a client that
runs its own agents forwards their tool calls with, `pullRequests.noteToolCall`,
and `pull-request-link` `pullRequests.link`, which records a pull request an
owner opened for a conversation (refused as `claimed` when another
conversation opened it first). `pull-request-watch` (2026-10-11) adds
`pullRequests.unwatch`, an owner stopping an agent's watch on one of its pull
requests, and says a listed pull request may carry `watch` (what a watched one
waits on, an optional member): a client that does not read it shows the pull
request as before, and a client offers Stop watching only to a Studio that
advertises the capability. A `waitingOn` word a client does not know reads as
plain watching. `local-servers` adds the owner-only
`localServers.*` methods and stream: the local servers a Studio's agents
linked, as the Studio checks them, and running one's command again, stopping
that run, or forgetting the link (`run` and `stop` refused as `conflict` when
it is already running, or when the Studio did not start the run). `session-files`
adds `files` to `session.send`, a message's files attached by path: a Studio
without it reads `session.send` with a validator that keeps only the members
it knows, so it would drop the files without a word and send the words as if
nothing were attached — which is why a client sends `files` only to a Studio
that advertises it, and the desktop's own window refuses such a send in words
otherwise. A hello's `client.kind` and `client.instanceId` are
optional hints a Studio that does not know them ignores. Every method names its scope in `STUDIO_METHODS`,
typed over the method map so a method without one does not compile.

The pack check (`npm run test:studio-packages:pack`) installs the packed
tarball beside the conversation protocol's and checks both module systems and
Node16 declarations.

### The embed's `postMessage` wire

A page that frames Studio's embedded conversation view
(`/embed/conversation/<id>`) talks to the frame by `postMessage`, and the two
update separately: the frame is served by whichever Studio the embed points
at, the page by whoever wrote it. Every message carries an integer `v`, now 1.

- The frame posts `ready` (with the embed's id), `resize` (its content
  height), `link` (a link the person clicked, for the page to open), `state`
  (how many turns, and whether one is running) and `error` (a code). It posts
  only to the embed's registered origins, never `'*'`.
- The page may post `theme` (`light`, `dark` or `system`), `token` (the
  embed's token, for a page that keeps it out of the frame's address) and
  `scrollTo` (a turn). The frame accepts a message only from its parent and
  from a registered origin; it ignores a `type` it does not know and answers
  a `v` it does not know with `error { code: 'unsupported_version' }`.
- No message makes the frame send, answer or navigate. A new message type is
  additive and needs no bump; a change to an existing message's meaning bumps
  `v`, and the frame then accepts the old and the new for one version.

## Changing a wire format

If your change alters anything that crosses either wire, do all of this:

1. **Decide which it is.** Additive → a new entry in `TAILNET_CAPABILITIES` (or,
   for the phone, a new command in the snapshot's advertised `commands`, which
   the phone reads as plain strings), no version bump. Otherwise → a version bump.
2. **If you bump**, move the current version and the minimum together so the
   window stays one version wide, and leave the code that reads the previous
   shape in place for that one release. A bump that also drops the old reader
   refuses every peer that has not updated yet, which is what the window exists
   to prevent.
3. **Check every enforcement site.** They must agree, or a peer is accepted by
   one and refused by another. Today:
   `git grep -n 'protocolVersion' -- src | grep -v test` and
   `git grep -n 'transportVersion' -- src`. Note that the sites include the
   validators for records read back off **this machine's own disk** — a check
   pinned to the current version alone unpairs every device paired before the
   bump, silently, on the first restart after it.
4. **Test the edge, not the middle.** A peer inside the window is accepted, one
   outside it is refused, and the refusal names both versions. The existing
   examples are in `src/main/automation/tailnet-peers.test.ts`,
   `src/main/automation/tailnet-mesh-reachability.test.ts`,
   `src/main/mobile/control/command-validation.test.ts` and
   `src/main/mobile/control/protocol.test.ts`.
5. **Make the same edit on the phone.** The phone carries its own copy of the
   mobile-control types (see "The mobile wire lives in this tree" above), so a
   desktop-only change to a shape the phone parses is half a change. The window
   is the grace period a bump needs, not permission to skip the other side.
6. **Update this file**, if what you changed is the policy rather than an
   instance of it.

## Bumps that have happened

### 4 — the members nothing produces leave the wire (2026-09-16)

**Breaking, deliberately, and for the same reason as 3.** Taking the Sprint Engine
off the wire left members no desktop could produce: the `workspaces` collection
(always `[]`, with its `switchboard` / `watchtower` kinds, nine workspace
capabilities, detail shapes and the `desktopWorkspaces` snapshot collection), the
`roadmaps` rider, the always-`undefined` `statePath`, and the `python_tool_failed`
error code. All of it is deleted. `mobileControlProtocolVersion` moved 3 -> 4 and
the window moved with it, to `[3, 4]`. The package published `4.0.0`.

Removing `desktopWorkspaces` from the collection list is what makes this a bump
rather than a quiet tidy: a v3 phone that asked for it would now be refused with
`invalid_payload`.

As with 3, pre-release: no users and no paired devices. The phone's mirror moved
in the same coordinated change, with both sha256 pins set to the same new hash.
Step 2's one-release grace reader was skipped for the same reason as in 3; the
window is still one version wide and still enforced, and nothing reads v3.

The phone's project list and switcher were built from `workspaces` joined with
`backlog`. With `workspaces` always empty they were already built from `backlog`
alone, so the phone's projects are unchanged; only the dead join went.

The member-by-member list was in the protocol package's `CHANGELOG.md`, removed
with the package; `git show 84500b7f2:packages/mobile-control-protocol/CHANGELOG.md`
still has it.

### 3 — the Sprint Engine leaves the wire (2026-09-16)

**Breaking, and deliberately so.** `sprintEngines` was a required member of the
snapshot; the nine sprint commands, the eight sprint capabilities, their relay
scopes, the role catalogue and the `sprintengine` workspace kind were all wire
vocabulary. All of it is deleted. `mobileControlProtocolVersion` moved 2 -> 3 and
the window moved with it, to `[2, 3]`. The package published `3.0.0`.

**Why it could not be additive.** The Sprint Engine moved out of the
desktop into a signed module, and the desktop stopped being able to serve any of
it. It kept emitting `sprintEngines: []` anyway, and the phone kept demanding
the key, because removing a required member is not additive: a desktop that
dropped it while the phone still required it would fail EVERY snapshot read on
the phone with `invalid_payload`, taking backlog and automations down with the
runs. Emitting an empty array forever was the right answer while a paired phone
existed. It also meant the wire carried a large vocabulary — a whole run type
tree, nine commands, eight capabilities — that nothing on either side could
produce or act on.

**What made it possible.** Pre-release: no users, no published consumers, no
paired devices to protect. Both halves — this package and the phone's mirror of
it — moved in one coordinated change, with both sha256 pins set to the new shared
hash in that same change.

**Where this departs from step 2 below.** Step 2 says a bump leaves the code that
reads the previous shape in place for one release, so the window is a grace
period rather than an outage. That was skipped on purpose here: there is no
deployed peer to grant grace to, and a retained v2 reader would have been a copy
of exactly the vocabulary the change exists to delete. The window itself is still
one version wide and still enforced; nothing reads v2.

The member-by-member list was in the protocol package's `CHANGELOG.md`, removed
with the package; `git show 84500b7f2:packages/mobile-control-protocol/CHANGELOG.md`
still has it.

## Withdrawals that did not bump

### Terminals leave the tailnet (2026-09-29)

**Not a bump, and the tailnet transport stays at 2.** Owner ruling: nothing
about a terminal crosses the tailnet any more; what a paired device reads,
drives and starts is a conversation. Everything that went is one of the shapes
this file already says a peer must tolerate, so no peer on version 1 or 2 is
refused over it:

- **Two capabilities withdrawn**, `sliced-frames` and `terminal-resume`. Both
  described the terminal stream. A capability is what a peer asks before relying
  on a feature, and a build that stops advertising one is read as not having it
  — the case "withdrawn by a build that keeps the version" above.
- **The route**, `/tailnet/v1/terminal`. An upgrade there is answered 404, which
  is what a peer from before the route existed answered.
- **Five tools off the tailnet**, `terminal.list`, `terminal.create`,
  `agent.launch`, `backlog.work` and `automation.run`. All five still exist and
  are served on the local socket, to the agents and MCP clients on this machine;
  a paired device's `tools/list` no longer names them, and a call to one is
  refused as `tailnet_local_only`, the refusal the `tailnet.*` family already
  had. `tools/list` is read on every connection and never pinned, so a shorter
  list is a shape every peer already reads.
- **A change-feed kind**, `terminals`. No `changed` frame names it, and the
  `hello` frame's `revisions` map no longer has its key. That map is keyed by
  the lists this machine announces and has grown a key before (`conversations`)
  without a bump; a key a build does not announce is absent, the same as it was
  before the key existed.
- **Two scopes**, `terminal:observe` and `terminal:control`, retired the way the
  Horizon scopes were: `normalizeTailnetScopes` drops a scope outside the
  vocabulary, so a device stored with them loads with the rest of its grant, a
  pair request naming them is read without them, and a peer reading a grant
  list sees a shorter list, which a grant list always could be.
- **The upload route** keeps its path, its `upload` capability and its
  conversation shape. Its terminal branch — a file written into a session's
  folder — is gone, and the `kind=conversation` older phones send is accepted
  and no longer needed.

The phone's side of this is its own change: it stops asking for terminals.
Nothing in `src/main/mobile/control/protocol.ts` changed, so the mobile-control
version stays at 4.

### Automations leave the phone (2026-09-29)

**Not a bump, and the mobile-control version stays at 4, window `[3, 4]`.**
Owner ruling: the phone does not show or drive automations any more. What
left `src/main/mobile/control/protocol.ts`:

- **The snapshot member** `automations`, with its types
  (`MobileControlAutomationSnapshot`, `MobileControlAutomationRunSummary`,
  `MobileControlAutomationRunStatus`) and the producer's caps
  (`automationsPerProjectMax`, `automationRecentRunsMax`,
  `automationRunTextMaxChars`). The member was optional and already absent
  whenever a desktop had no automations to show, so a snapshot without it is
  one every v3 and v4 phone reads. That is why this is not the case "a field
  that is removed" in the bump rule above: nothing about whether it may be
  absent changed.
- **The collection** `automations` from `mobileSnapshotCollections`. This is
  the part that would have been a bump — it is what made v4 one — because
  phones built before this ask for `['backlog', 'automations']` on every read,
  and `workspace.snapshot` refuses a name it does not know. So the name is kept
  as a retired collection (`retiredMobileSnapshotCollections`): accepted in
  `include`, and answered with nothing, the way the upload route still accepts
  the `kind` older phones send.
- **The command** `automations.control`, with `AutomationsControlCommand`,
  `MobileControlAutomationAction` and the `task_not_ready` error code only it
  produced. A command is advertised in the snapshot's `commands` strings, and
  the tailnet never advertised this one: the gateway's `workspace.mobile_command`
  allowlist is `backlog.update` alone, so since the hosted relay went
  (2026-09-27) no transport served it. A phone that sends it is refused
  `command_not_supported` by the gateway, as before.

The phone's mirror drops the same members in its own companion change. On the
desktop, automations are unchanged, and `automation.run` stays a local-socket
tool.

## What never changes without a bump

- The meaning of an existing field.
- The type of an existing field.
- Whether an existing field may be absent.
- The shape of anything under `health` on the tailnet transport, which is read by
  peers that have never paired with us and may be several releases behind.
