# Changelog

## Unreleased

### Added

- **A chat's effort, its MCP servers and its agent's restart**
  (`conversation-reasoning-effort`, `conversation-mcp-server-actions` and
  `conversation-restart-session`, in `welcome.conversation`, owners):
  `conversation.setReasoningEffort` sets the level the chat runs at from its
  next turn (`effort?`, none for the provider's default);
  `conversation.mcpServerAction` reconnects one of a live chat's MCP servers
  or switches it on or off (`serverId`, `action`: `reconnect`, `enable` or
  `disable`); `conversation.restartSession` ends the chat's agent process,
  keeping its place for the next message. Their params are read by the
  conversation lane's own validator, and they reach the same host. A Studio
  built before them does not advertise them and refuses the methods as
  unknown.
- **A usage limit's resume** (owners): `conversation.usageLimitResume`
  (`action`: `schedule`, `cancel`, `dismiss` or `retry`; `always` beside
  `schedule`) acts on the notice a usage limit left on a chat's turn, as the
  conversation lane's `usageLimitResume` does, read by its own validator and
  carried to the same host. The socket does not advertise
  `conversation-usage-limits`: its conversation topic carries no `usageLimits`
  frames. A Studio built before it refuses the method as unknown.

- **A message scheduled for a time** (owners): `conversation.scheduleSend`
  (`message`, `sendAt`) has the desktop keep a message and send it into the
  chat then, and `conversation.sendScheduledNow` and
  `conversation.cancelScheduled` (`scheduledId`) send one it keeps at once or
  delete it: the conversation lane's `scheduleSend`, `sendScheduledNow` and
  `cancelScheduled`, read by its own validator and carried to the same host.
  The socket does not advertise `conversation-scheduled-sends`: its
  conversation topic carries no `scheduled` frames, as it carries no `queued`
  ones. A Studio built before them refuses the methods as unknown.

- **One agent stopped by itself** (`conversation-stop-subagent`, in
  `welcome.conversation`, owners): `conversation.stopSubagent` stops one agent a
  conversation spawned, named by the call that spawned it (`toolUseId`), and
  leaves the conversation, its turn and its other agents running. Its params
  are read by the conversation lane's own validator, and it reaches the same
  host. A Studio built before it does not advertise it and refuses the method
  as unknown.

- **Handoff** (`conversation-handoff`, owners): `conversation.handoff` hands a
  chat off to a fresh session of its CLI instead of compacting it. The chat's
  messages, without its tool calls, are saved to a file on the machine its
  agent runs on, and the answer names that file (`{ ok: true, path }`); the
  next message sent to the chat points the new session at it. A Studio built
  before it does not advertise it and refuses the method as unknown, so a
  client offers Handoff only where it is listed.

- **The project's store as a file root** (`files-write`, owners): a
  `StudioFileRoot` may be `{ kind: 'store', workspaceId }`, the folder in the
  person's home where Studio keeps a project's browser captures, recordings
  and chat transcripts, which older builds kept in the project's
  `.sprintengine/`. `files.roots` answers `store: true` where it is served; a
  Studio built before it leaves the member out and refuses the kind, so a
  client asks for it only where it is listed. A read of the workspace root's
  `.sprintengine/…` that the folder no longer has is answered from the store,
  so a client that learned such a path from an older Studio still finds the
  file.

- **A steered send** (`conversation-steer-sends`, in `welcome.conversation`):
  `conversation.send` may say `steer: true`, read by the conversation lane's
  own validator, and the message goes into the turn the conversation is
  running where its provider takes one. A turn that cannot take it has the
  Studio hold the message for the turn's end, answered with a `notice`.

- **Pull request watches** (`pull-request-watch`, owners): `pullRequests.unwatch`
  stops a conversation's watch on one of its pull requests, and a listed
  `StudioPullRequest` may carry `watch` (`StudioPullRequestWatch`: when it
  began, what it waits on, whether it is approved and set to merge on its
  own, its base and how many checks failed) while the conversation's agent has
  the Studio watching it.

- **`conversation.cancelQueued`** (operate, an owner's only), the
  conversation lane's `cancelQueued` command as a method: it takes back a
  message the desktop holds for a chat's turn to end, by its `queuedId`. The
  socket does not advertise `conversation-queued-sends`, since its
  conversation topic carries no `queued` frames, so it names no held message
  to an app; the method is here so the socket carries every command kind the
  lane defines.
- **Client tools** (`client-tools`): `tools.offer`, `withdraw`, `focus`,
  `catalog`, `grants` and `grant`, the `tools.catalog` stream, the `call` /
  `cancel` server frames and `reply` / `progress` client frames, the
  `tools:offer` scope, `STUDIO_TOOL_LIMITS` and the validators
  (`parseStudioToolsetOffer`, `parseStudioToolResult`, …).
- **Files by root** (`files-write`, owners): `files.roots`, `list`, `read`,
  `write`, `remove`, `stat` with a `root`, the `files.watch` stream, the
  `files:write` scope, and `uploads.begin { purpose: 'file' }`.
- `hello.client.kind` and `hello.client.instanceId`; the `reserved_name`,
  `name_taken` and `not_offered` codes.
- `worktree` among `STUDIO_RESERVED_TOOLSET_NAMES`: the worktree pool's
  `worktree.lease` and `worktree.release`, which a Studio's shell offers.
- `artifacts` among `STUDIO_RESERVED_TOOLSET_NAMES`: `artifacts.publish`,
  `list`, `search`, `get`, `update` and `delete`, which publish an agent's
  HTML pages to the site set on Settings ▸ Artifacts, and which a Studio's
  shell offers.

- **The chat surface** (`chat.ts`): `session.*`, `uploads.*` (with
  `uploads.discard`), the
  conversation's `revert`, `rewind`, `fork`, `attachment`, `planDocument` and
  `commands` with its `conversation.commands` stream, `providers.*`, `files.*`
  and `workspaces.list`; their param validators (`parseStudioChatParams`) and
  limits; the scopes `providers:read`, `files:read` and `workspaces:read`; and
  the capabilities in `STUDIO_CHAT_CAPABILITIES`. Every chat method is an
  owner's only (`StudioMethodSpec.owner`, refused `owner_required`).
- **Folder keys.** A conversation key may carry `workspaceRoot`, an owner's
  only, behind `conversation-folders` (`key.ts`).
- **Files attached by path** (`session-files`): `session.send` takes `files`,
  a list of at most `STUDIO_MAX_FILES_PER_SEND` `{ path }` (`StudioAttachedFile`),
  and the `user_message` the send becomes carries them as `files`. Additive: a
  Studio without the capability drops the member unread, so a client sends it
  only where the capability is advertised.
- **Push streams.** `{ t: 'push', sub, payload }` for a stream with no cursor.
- **`server.ping`**, answered at once, for a client's liveness check.
- **Error ids.** A refusal's error and a `subFailed` frame may carry `errorId`.
- **`command_id_conflict`**, for a command id reused for a different command.

## 0.1.0

The first version: what Studio serves on its owner socket.

### Added

- **The envelope.** `hello` / `welcome` / `bye`, requests answered under their
  id (`res`), streams keyed by subscription (`sub`, `frame`, `subFailed`,
  `unsub`) and chunking for frames over `STUDIO_MAX_FRAME_BYTES`, with their
  validators for both ends (`parseStudioClientFrame`,
  `parseStudioServerFrame`) and a chunk assembler for clients.
- **The handshake.** `STUDIO_PROTOCOL_VERSION` (1) and its window,
  `checkStudioProtocolVersion`, and the Studio capabilities `conversations`,
  `conversation-create` and `local-pairing`. The conversation contract's
  `hello` answer is nested in the `welcome` unchanged.
- **Scopes and grants.** `conversation:read`, `conversation:operate` and
  `conversation:create`, and a grant's permission `ceiling`.
- **The method table.** `STUDIO_METHODS` and `STUDIO_TOPICS`, each naming its
  scope, for the `server` and `conversation` namespaces; params validated by
  `parseStudioMethodParams`, a command's through the conversation lane's own
  validator.
- **Discovery.** The `server.json` a running Studio writes beside its socket.
- **The conversation contract**, re-exported from
  `@sprintengine/conversation-protocol`, which this package depends on.
