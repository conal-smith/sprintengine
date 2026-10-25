# Studio protocol

The protocol SprintEngine Studio serves to its clients: the connection
envelope, the handshake, the scopes a client is granted and the table of
methods and streams. It carries the conversation contract from
[`@sprintengine/conversation-protocol`](../conversation-protocol/README.md)
unchanged and re-exports all of it, so a client depends on this one package.
[`@sprintengine/agent-sdk`](../agent-sdk/README.md) is the client library
built on it.

The conversation package stays what it is: the conversation lane on its own,
which Studio also serves to paired devices over the tailnet. This package adds
the connection around it. No Electron, Node or React dependencies; it runs in
Node and in a browser.

## Where it is served

A running Studio listens on an **owner socket**: a Unix domain socket in a
directory only its owner can enter (`<data directory>/run/studio.sock`, the
directory `0700` and the socket `0600`), or a named pipe on Windows whose name
carries a random part minted at each start. The socket's address, and the
protocol window, are in `<data directory>/run/server.json`
(`parseStudioServerDiscovery`), written once it is listening and removed when it
stops. Each frame is one line of JSON.

File permissions are not the whole of the check. Every connection presents a
credential in its first frame, because a Windows pipe's default access is wider
than its owner, and a second check costs nothing.

## The connection

```
client → Studio
  { t: 'hello', protocolVersion, minProtocolVersion?, client: { name, version? }, auth: { token } | { pairingCode } }
  { t: 'req',   id, method, params }
  { t: 'sub',   id, topic, params, cursor?: { afterSeq, generation } }
  { t: 'unsub', id }

Studio → client
  { t: 'welcome', protocolVersion, minProtocolVersion, server, environment, capabilities, conversation, grant, pairing? }
  { t: 'res', id, ok: true, result } | { t: 'res', id, ok: false, error: { code, message, retryAfterMs? } }
  { t: 'frame', sub, frame }                       // a conversation server frame: snapshot, event, synchronized
  { t: 'push', sub, payload }                      // one message of a stream with no cursor
  { t: 'subFailed', sub, code, message, retryable, retryAfterMs?, errorId? }
  { t: 'chunk', frameId, index, total, json }      // a frame over STUDIO_MAX_FRAME_BYTES
  { t: 'bye', code, message, retryAfterMs? }       // Studio is closing the connection
```

A refusal Studio tells in stable words, in place of a cause that could name
its internals, carries `errorId`: an opaque id it logged beside the real
cause, for someone looking into it to quote.

`hello` is the first frame, within `STUDIO_HELLO_TIMEOUT_MS`. It is answered by
`welcome`, or by `bye` and a close: `unauthorized` for a credential Studio does
not hold, `unsupported_protocol_version` with both numbers named
(`checkStudioProtocolVersion`). Validate what a Studio sends with
`parseStudioServerFrame`; a Studio validates what a client sends with
`parseStudioClientFrame` and `parseStudioMethodParams`.

## Pairing and grants

A local app is paired once. The person mints a one-time pairing code in
Studio's Settings, naming the app, the scopes it gets and its permission
ceiling. The app's first `hello` presents `{ pairingCode }`; its `welcome`
carries `pairing.token` — Studio keeps only its hash. The code stays good
until that token is first presented: a welcome lost with its connection is
answered again by presenting the code again, with a fresh token that voids the
lost one. Every later `hello` presents `{ token }`, which spends the code. Revoking the app in Settings ends its open
connections with `bye { code: 'revoked' }`.

The `welcome`'s `grant` is what the connection may do:

- `scopes` — `conversation:read` (list, follow, read), `conversation:operate`
  (every command; implies read) and `conversation:create` (start a chat). Each
  method's scope is in `STUDIO_METHODS`, and is checked on every request
  against the grant as it stands then.
- `ceiling` — the loosest permission preset the client's chats may run on. A
  chat it starts, or switches, with a looser preset is lowered to the ceiling,
  and one it starts without a preset is pinned to it. A chat that already runs
  looser than the ceiling can be read, interrupted and stopped, and its
  requests denied, but not sent to or approved; a chat whose session runs
  tools unasked counts as `bypass` for that. Naming `allowedTools` needs a
  `bypass` ceiling, since a tool allowed unasked is as loose as bypass for it,
  and answering a request `conversation` (an allow rule for its kind) needs a
  ceiling of at least `auto`.
- `owner` — the connection is Studio's own, with every scope and no ceiling.
  Some methods are an owner's only (`STUDIO_METHODS[m].owner`), whatever
  scopes another grant holds, and are refused `owner_required`.

## Methods

| Method                             | Scope          | Takes                                           | Answers                                          |
| ---------------------------------- | -------------- | ----------------------------------------------- | ------------------------------------------------ |
| `server.info`                      | any            | —                                               | the welcome, without its pairing                 |
| `server.ping`                      | any            | —                                               | `{ at }`, at once: the line is alive             |
| `conversation.list`                | read           | —                                               | `{ conversations: ConversationThread[] }`        |
| `conversation.create`              | create         | `ConversationCreateRequest` + `commandId`       | `{ conversation }`                               |
| `conversation.send`                | operate        | `key`, `commandId`, `message`                   | `{ notice? }`, when the turn ends                |
| `conversation.interrupt`           | operate        | `key`, `commandId`                              | `{}`                                             |
| `conversation.resolveApproval`     | operate        | `key`, `commandId`, `requestId`, `decision`     | `{}`                                             |
| `conversation.answerQuestion`      | operate        | `key`, `commandId`, `requestId`, `answers`      | `{}`                                             |
| `conversation.resolvePlan`         | operate        | `key`, `commandId`, `requestId`, `decision`     | `{}`                                             |
| `conversation.setPermissionPreset` | operate        | `key`, `commandId`, `preset`, `permissionMode?` | `{ permissionPreset, permissionMode?, notice? }` |
| `conversation.setModel`            | operate        | `key`, `commandId`, `modelId`                   | `{ modelId, notice? }`                           |
| `conversation.cancelQueued`        | operate, owner | `key`, `commandId`, `queuedId`                  | `{}`                                             |
| `conversation.stopSubagent`        | operate, owner | `key`, `commandId`, `toolUseId`                 | `{}`                                             |
| `conversation.setReasoningEffort`  | operate, owner | `key`, `commandId`, `effort?`                   | `{ notice? }`                                    |
| `conversation.mcpServerAction`     | operate, owner | `key`, `commandId`, `serverId`, `action`        | `{}`                                             |
| `conversation.restartSession`      | operate, owner | `key`, `commandId`                              | `{ notice? }`                                    |
| `conversation.stop`                | operate        | `key`, `commandId`                              | `{}`                                             |
| `conversation.loadEarlier`         | read           | `key`, `beforeCursor`, `turnLimit?`             | `{ page }`                                       |
| `conversation.toolDetail`          | read           | `key`, `toolUseId`                              | `{ detail }`                                     |
| `conversation.turnDiff`            | read           | `key`, `turnSeq`, `path?`                       | `{ diff, patch?, … }`                            |

A key is `{ workspaceId, agentId }`. An owner may add `workspaceRoot`, the
folder the conversation is kept in when that is not its workspace's (a chat
started in a run worktree), where the Studio serves `conversation-folders`.

A command's params are the conversation lane's command plus its `key` and
`commandId`, read by the lane's own validator (`parseStudioCommand`), so a
command means the same thing on this socket as on the tailnet. Every mutation
carries a `commandId`, recorded as a durable receipt before the work starts: a
retry with the same id, on the same connection or after a reconnect or a
restart of the app, is answered with the first attempt's result and never
carried out twice. A create's `commandId` is kept on the chat it made, so a
retried create finds that chat. Command ids are namespaced per client by
Studio, so one client can neither collide with nor answer from another's. An
id names one command: sent again with different params, or for another method,
it is refused `command_id_conflict` rather than answered with the first
command's result.

## The chat surface

What a chat view needs beside the conversation lane, so any client can show
and drive a chat as Studio's own windows do (`chat.ts`). Every one of these is
an owner's only for now; each still names the scope it would need.

| Method                                                                  | Scope                  | What                                                                                    |
| ----------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `session.start`                                                         | operate                | start a provider session for a chat                                                     |
| `session.send`, `.interrupt`, `.respond`, `.setPermission`, `.setModel` | operate                | drive a live session by its id, with all a composer sends; answered with its outcome    |
| `uploads.begin`, `.append`, `.discard`                                  | operate                | stage a picture in pieces of `STUDIO_UPLOAD_CHUNK_BYTES`; a send names it by `uploadId` |
| `conversation.revert`, `.rewind`, `.fork`                               | operate (fork: create) | a turn's files from its checkpoint; back to an earlier message; a new chat from one     |
| `conversation.attachment`, `.planDocument`, `.commands`                 | read                   | a sent picture; a proposed plan as a file; the `/` command list a CLI reports           |
| `providers.list`, `.models`, `.secretStatus`                            | `providers:read`       | the providers a chat can run, their models, whether each has its key                    |
| `files.search`, `.cancelSearch`, `.stat`, `.readImage`, `.repoRoot`     | `files:read`           | @-mention search and the file facts a chat's links and pictures need                    |
| `workspaces.list`                                                       | `workspaces:read`      | the workspaces this Studio holds                                                        |

A session method's result is the runtime's own outcome, a refusal by the
runtime included: `{ ok: true, session, notice? } | { ok: false, message,
event? }`, inside a successful response. The response's error is for the
request itself. The same holds for the other methods whose outcome has an `ok`
of its own.

Staged pictures are the client's, counted against the connection that staged
them, and expire unsent after ten minutes (a minute once that connection has
closed and no other has taken them up); `uploads.discard` gives back what will
not be sent. `files.stat` and `files.readImage` read only inside a workspace's
folder or Studio's own stores of sent pictures and plans, and refuse a path
that is not the plain spelling of where it really is.

`{ t: 'sub', id, topic: 'conversation.commands' }` hears every command list a
CLI reports from then on, one `push` frame each, nothing replayed.

## Following a conversation

`{ t: 'sub', id, topic: 'conversation.session', params: { key, turnLimit? }, cursor? }`
follows one conversation exactly as the conversation lane does: a `snapshot`
(or, for a `cursor` the log can vouch for, only the events after it), one
`synchronized` fence, then live `event`s, each wrapped as `{ t: 'frame', sub,
frame }`. Keep the fence's `seq` and `generation` and the `seq` of every event
after it: they are the cursor to resume from after a reconnect. A cursor the
log cannot vouch for is answered with a `snapshot` carrying `reset: true`.
Sequence numbers increase with gaps; a gap is never a reason to resubscribe.

A client that stops reading has text deltas merged while it catches up, and
is then sent `bye { code: 'resync_required', retryAfterMs }`. Wait that long,
reconnect, and resubscribe with your cursors. Requests beyond the
per-connection bound are answered `busy` with a `retryAfterMs`, and the
connection stays open.

## Versioning

`STUDIO_PROTOCOL_VERSION` is 1, with one version of slack
(`STUDIO_PROTOCOL_MIN_SUPPORTED`), refused at the handshake by an error naming
both numbers. Features are asked about by capability (`studioPeerSupports`),
never by version: `conversations`, `conversation-create`, `local-pairing`,
and with the chat surface `conversation-folders`, `conversation-sessions`,
`conversation-files`, `conversation-checkpoints`, `conversation-commands`,
`providers`, `files-mention`, `workspaces` and `session-files`
(`STUDIO_CHAT_CAPABILITIES`; the last lets `session.send` attach files by
path). The
conversation contract's own version and capabilities travel in
`welcome.conversation`, unchanged. The policy is the repository's
`docs/compatibility.md`.
