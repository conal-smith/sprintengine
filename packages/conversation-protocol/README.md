# Conversation protocol

The conversation contract Studio speaks to everything that follows or drives
its chats: the tailnet lane below, the module SDK, and the desktop's own chat
view. Events, commands, frames, capabilities and their validators are declared
once, here.

Events come in two layers. Each provider adapter reads its CLI's own stream
and writes `ConversationEvent`s in a vocabulary no provider owns
(`CONVERSATION_EVENT_TYPES`); the provider's shapes never leave the adapter.
Everything this package describes is the second, public layer. A client skips
an event type or payload member it does not know.

The additive `conversations` lane on Studio's tailnet gateway. A socket is
scoped to one conversation and receives a bounded snapshot before `synchronized`, followed
by live events. Every mutation has a stable `commandId`; reads have a
`requestId`. This package contains portable frame types, input validation, tool
classification and presentation, without Electron, Node, or React dependencies.

Resume with `subscribe({ afterSeq, generation })`, using the last sequence you
hold and the `generation` from the `snapshot` or `synchronized` frame it came
from. When the desktop can vouch for that cursor it sends one `event` per
missed event, then `synchronized`, then live events, with no snapshot. When it
cannot — another generation (the log was recreated), no generation, a cursor
ahead of the log, or one too far behind — it sends a `snapshot` with
`reset: true`: replace cached events and the cursor before consuming the
following `synchronized` fence. Earlier turns remain available through
`loadEarlier` with the page's `beforeCursor`.

Sequence numbers only increase but are not contiguous. A run of text deltas can
arrive merged into one delta numbered with the run's last sequence, so a gap is
normal and never a reason to resubscribe. Pending command ids remain intact for
idempotent retry.

Every `snapshot` and `synchronized` frame names the conversation it belongs
to in `key`. When a socket switches conversations, the old replay stops at the
next whole frame and never sends its fence; ignore any snapshot, fence or event
for a conversation you no longer follow, so a cursor is never stored against
the wrong log.

A frame larger than `CONVERSATION_MAX_FRAME_BYTES` arrives as `chunk` frames
whose `json` strings concatenate, in `index` order, to the frame. A snapshot
larger than one frame arrives as several `snapshot` frames carrying
`part: { index, total }`; concatenate their `page.events` and apply the result
when the last part arrives.

A client that reads too slowly gets consecutive text deltas merged while it
catches up. Live events that arrive while a replay is still being sent wait
behind it, bounded by size rather than count, so a busy turn during a large
catch-up does not force a resync before the fence. One that stops reading is sent an `error` with code
`resync_required` and `retryAfterMs`, then closed with
`CONVERSATION_RESYNC_CLOSE_CODE`; the close reason carries the same delay
(`conversationCloseRetryAfterMs`). Wait that long, then resubscribe with the
last cursor. Requests beyond the per-socket bound are answered with code `busy`
and `retryAfterMs`, and the socket stays open.

Every refusal is correlated. A command is always settled by a `commandResult`
under its `commandId` (an unsafe decision, a message over
`CONVERSATION_MAX_MESSAGE_CHARS`, a missing grant), a read by a `result` under
its `requestId` (including `too_large` for a response over 32 MB), and a
subscription that cannot start by `subscribeFailed` with its `key`, a
`retryable` flag and, when retryable, `retryAfterMs`. A client frame larger
than `CONVERSATION_MAX_CLIENT_FRAME_BYTES` is skipped and refused the same way;
put `type` and the id ahead of any long field so the refusal can name it.

A desktop that advertises `conversation-models` (`CONVERSATION_MODELS_CAPABILITY`)
names each listed chat's CLI and the models it can switch between in the
thread's `models`: the same rows its own picker offers, at most
`CONVERSATION_MAX_MODEL_OPTIONS`, with `liveModelSwitch` saying whether the
chat's provider takes a new model mid-conversation. `setModel` switches the
chat to one of those ids, or to `CONVERSATION_DEFAULT_MODEL_ID` for the CLI's
own default; it never changes the CLI, needs `conversation:operate`, and an id
outside the catalog is refused with `unsupported_model`. An accepted switch
made while a turn is running carries a `notice` on its `commandResult`: the new
model applies from the next turn. Validate `models` with
`parseConversationWireModels`, and hide the model control for a desktop that
does not advertise the capability.

A desktop that advertises `conversation-permission-modes`
(`CONVERSATION_PERMISSION_MODES_CAPABILITY`) runs chats on four permission
presets — `bypass`, `auto`, `manual` and `none` — where one without it takes
only `bypass` and `none` and reads `manual` and `auto` as `none`. Its list may
name either new preset as a thread's `permissionPreset`, and names the presets
the chat's provider can run in `capabilities.permissionPresets`;
`setPermissionPreset` takes all four. Offer `manual` and `auto` only to a
desktop that advertises the capability, and leave a listed preset you do not
know out rather than guessing at it (`isConversationWirePermissionPreset`).

A listed chat may name the machine it runs on in `host` — `{ id, kind, label,
color }`, where `id` is `local` for the desktop answering (draw no machine mark
for it), `wsl:<distro>`, `ssh:<host>` or `tailnet:<host>` — and the pull
requests it opened in `pullRequests` — `{ number, state, url, title }`,
`state` being `open`, `merged` or `closed`, at most
`CONVERSATION_MAX_PULL_REQUESTS`. Both are optional with no capability: a
desktop that does not send them sends neither, and an empty `pullRequests` says
the chat has none. Draw a `kind` or `color` you do not know as your fallback,
since a newer desktop may add one. `parseConversationServerFrame` keeps both,
and drops one it cannot read without dropping the row.

Grants are read live. A device whose grant loses `conversation:operate` keeps
its socket and has further commands refused with `conversation_operate_required`;
one that loses `conversation:read` is sent that error and closed with
`CONVERSATION_SCOPE_CLOSE_CODE`, and a revoked device is closed with 4401.

A desktop that advertises `conversation-hello` (`CONVERSATION_HELLO_CAPABILITY`)
answers a `hello` frame — `{ type: 'hello', requestId, protocolVersion? }` —
with a `result` whose `data` is its `protocolVersion`, `minProtocolVersion` and
conversation `capabilities` (`parseConversationHelloAnswer`). One without it
answers `invalid_frame` under the same `requestId`: read that as protocol 1 with
the capabilities the transport's own handshake listed. Ask capabilities, not
the version, whether a feature is there; `checkConversationProtocolVersion`
refuses a peer outside the window and names both numbers.

The full contract reads frames with `parseConversationClientMessage`, which
takes every first-version frame exactly as `parseConversationClientFrame` does
and adds, each behind its capability:

- `conversation-plans`: `resolvePlan` with `decision: 'approve' | 'reject'`
  answers a `plan` request, and only a plan request. A desktop without it took
  a plan as a `resolveApproval` (`once` or `deny`), and still does.
- `conversation-cli-permission-modes`: `setPermissionPreset` takes the CLI's own
  `permissionMode` at that preset (Claude Code's Accept edits), and a listed
  thread names its `permissionMode` and the modes its provider runs
  (`capabilities.permissionModes`). A desktop without it drops the member and
  runs the preset's own mode, which is the fallback the field is shaped for.
- `conversation-queued-sends`: a `send` with `queue: true` (its words alone,
  never beside `uploadIds`) is held by the desktop and sent when the chat's
  turn ends, answered once it is held; `cancelQueued` with a `queuedId` takes
  one back; and `{ type: 'watchQueued', requestId }` has the desktop send a
  `queued` frame (`ConversationQueuedFrame`: the chat's `key` and its held
  `messages`, whole each time) now and whenever what it holds changes. A
  desktop without it drops `queue`, so a send made while a turn runs is
  refused `busy` as before; it refuses `cancelQueued` as `unsupported_command`
  and `watchQueued` as `invalid_frame`, each under its id. A desktop sends
  `queued` frames only to a client that asked.
- `conversation-steer-sends`: a `send` with `steer: true` goes into the turn
  that is running, where the chat's provider takes a message mid-turn (a
  listed thread's `capabilities.steer`), and is answered when that turn ends.
  With no turn running it is an ordinary send. A turn that cannot take it has
  the desktop hold it as a `queue` send is held, answered at once with a
  `notice`; one with `uploadIds` or `skills`, which cannot be held, is refused
  `busy` instead. Never beside `queue`. A desktop without it drops `steer`, so
  a send made while a turn runs is refused `busy` as before.
- `conversation-stop-subagent`: `stopSubagent` stops one agent a chat spawned,
  named by the call that spawned it (`toolUseId`), where the chat's provider
  can (a listed thread's `capabilities.stopSubagent`), and leaves the chat,
  its turn and its other agents running. A desktop without it refuses the
  kind as `unsupported_command`.
- `conversation-handoff`: `handoff` hands a chat off to a fresh session
  instead of compacting it, where the chat's provider can (a listed thread's
  `capabilities.handoff`): the desktop writes the chat's messages to a file,
  lets the provider session go, and the next message starts a new one pointed
  at the file. Refused while anything in the chat is running. A desktop
  without it refuses the kind as `unsupported_command`.
- `conversation-rewind`: `rewind` takes a chat back to before the user message
  at `turnSeq`, where the chat's provider can (a listed thread's
  `capabilities.rewind`): that message and every turn after it leave the
  agent's context and the transcript's view, and the files stay as they are.
  A repeat under the same `commandId` is answered as the first was. A desktop
  without it refuses the kind as `unsupported_command`.
- `conversation-checkpoint-revert`: `revert` puts a turn's files back from its
  checkpoint in the desktop's checkout, for a listed thread with
  `capabilities.checkpoints` (`undo`: as they were before that turn's last
  revert). Unconfirmed it lists the files it would touch; `confirmed`, it acts
  on exactly the `files` that list named and refuses when the list moved. The
  answer rides on the `commandResult` as `data`
  (`ConversationRevertAnswer`, read with `parseConversationRevertAnswer`): the
  files, whether they were reverted, the ignored new files it `kept`, or
  `changed`. Its paths are relative to the desktop's checkout. A desktop
  without it refuses the kind as `unsupported_command`.

`conversation-message-images` (`CONVERSATION_MESSAGE_IMAGES_CAPABILITY`)
names no frame. A `user_message`'s `attachments` record each picture the
person sent as `{ id, mediaType, name?, byteLength, ref }`, and a desktop that
advertises it serves one at `GET /tailnet/v1/conversation-image` by its `ref`
(`attachment=<ref>` in place of `toolUseId`). A client without it names the
picture rather than drawing it.

`conversation-message-files` (`CONVERSATION_MESSAGE_FILES_CAPABILITY`) names
no frame either. The desktop's upload route takes `kind=file`, a file of any
type, and a `send` names its `uploadId` in `uploadIds` beside any picture's.
The desktop attaches it to the message by its path there, so the
`user_message` lists it in `files` (`{ path }`). A client without it offers
pictures only.

`conversation-image-downscale` (`CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY`)
names no frame either. A desktop that advertises it shrinks each picture
uploaded for a chat to a 1568px long edge on receipt, so its upload route takes
up to 20 MB as it arrives and keeps at most 5 MB. A client without it holds an
upload to 5 MB itself.

`ConversationCreateRequest` is what starting a conversation takes, with
`allowedTools` — tools the chat may use without asking — beside the preset.
Validate one with `parseConversationCreateRequest`. The tailnet lane does not
create conversations; the module SDK does, and so does the Studio RPC on the
desktop's owner socket, whose protocol (`@sprintengine/studio-protocol`)
carries this contract and re-exports it. `@sprintengine/agent-sdk` is the
client for it.

Transcript frames travel directly over the tailnet between paired machines.
