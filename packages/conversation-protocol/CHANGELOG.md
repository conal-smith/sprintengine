# Changelog

## Unreleased

### Changed

- **A command led by shell grammar is not named after it.** `labelCommand`
  read `if`, `for`, `[`, `{`, `(cd` or `!` as the program that ran ("Ran if",
  "Ran ["). Control keywords, `test` and `[ … ]` conditions, `true`, `false`,
  `:` and function definitions now label as "Ran command", and a subshell,
  group, negation or `eval` is labelled by the command it holds. A pinned
  file: the phone's copy changes with it.

### Added

- **A listed chat says what it still has working after its turn.**
  `backgroundWork` is an optional member of `ConversationThread`,
  `ConversationBackgroundWork` (`{ agents, monitors }`): the background agents
  the chat launched that are still running, and the background tasks that will
  wake its agent (a monitor with a deadline, or a task it is told about when it
  ends). The desktop's own sidebar counts such a chat as working; its `phase`
  stays the turn's, so a client that holds sends while a turn runs does not
  hold them for background work. Absent when nothing works in the background,
  and from a desktop built before it was listed.
  `parseConversationServerFrame` keeps it when both counts are whole and one
  is above zero, and leaves it out otherwise (`parseConversationBackgroundWork`).
  The pinned files are unchanged.
- **A listed chat says where the desktop's sidebar orders it, and when its
  turn began.** `recencyAt` and `turnStartedAt` are optional members of
  `ConversationThread`. `recencyAt` is the moment the desktop's own sidebar
  sorts the chat by: `lastUserMessageAt` when a person has written to it, else
  when the chat was made or last typed into there, which `lastUserMessageAt`
  alone could not say. `turnStartedAt` is when the running turn began. Both are
  absent from a desktop built before they were listed;
  `parseConversationServerFrame` keeps each when it is a clock and leaves out
  anything else. The pinned files are unchanged.
- **An uploaded picture is sized for the model by the desktop.**
  `CONVERSATION_IMAGE_DOWNSCALE_CAPABILITY` (`conversation-image-downscale`)
  names a desktop that shrinks a picture uploaded for a chat on receipt, to the
  1568px long edge its own composer sends, so its upload route takes up to
  20 MB where it took 5 MB; what it keeps is still at most 5 MB. No frame
  changed; a client without it keeps its upload under 5 MB itself. The pinned
  files are unchanged.
- **The pictures a person sent with a message can be fetched.**
  `CONVERSATION_MESSAGE_IMAGES_CAPABILITY` (`conversation-message-images`)
  names a desktop whose `GET /tailnet/v1/conversation-image` takes
  `attachment`, the `ref` of an entry in a `user_message`'s `attachments`, in
  place of `toolUseId`, and serves that picture when the chat kept it. No
  frame changed; a client without it names the picture as before. The pinned
  files are unchanged.
- **A message may steer the turn that is running.**
  `CONVERSATION_STEER_SENDS_CAPABILITY` (`conversation-steer-sends`) names a
  desktop that takes `steer: true` on `send`: the message goes into the turn
  the chat is running rather than waiting for it to end, where its provider
  takes one, and the send is answered when that turn ends. A listed
  `ConversationThread` says which chats can, as `capabilities.steer`. With no
  turn running the send is an ordinary one; a turn that cannot take it has the
  desktop hold the message as a queued one, answered at once with a `notice`,
  or, for a message with `uploadIds` or `skills` that a held one cannot carry,
  refused `busy`. Never beside `queue`. `parseConversationClientMessage` keeps
  `steer` when it is `true` and refuses the frame otherwise;
  `parseConversationServerFrame` keeps `capabilities.steer` when it is a
  boolean. A desktop without the capability drops the member. The pinned files
  are unchanged.

- **A wake about a watched pull request is Studio's.** `pull-request-watch`
  joins `ConversationStudioMessageReason`: the desktop sent the chat news
  about a pull request its agent asked it to watch (a check failed, a review,
  a merge). `readConversationMessageOrigin` keeps it; a reader from before it
  reads the message as Studio's with no reason, as it reads any reason it does
  not know. The pinned files are unchanged.

- **Background work has a type.** `ConversationBackgroundTask` (`taskId`,
  `kind`, optional `description` and `persistent`) is one shell, monitor or
  other task a session's process runs after its turn ended, and
  `ConversationBackgroundTaskKind` is `command`, `monitor` or `task`. A
  `session_updated` event carries them as `backgroundTasks`, the whole list
  each time it changes; an empty list says nothing runs any more.

- **A step names the pictures it returned.** `images` is an optional member
  of `ConversationToolOutputPayload`: the files a step's pictures (a browser
  screenshot, say) were written to on the desktop that ran it, in the order
  the tool returned them, at most eight. The bytes are not in `output` and
  never cross the wire. Absent for a step that returned none, and on every
  step a desktop from before this member reports. The paths name files on
  that desktop, so a client on another device can say a step has pictures
  but cannot open them. The pinned files are unchanged.

- **A message may bring skills.** `CONVERSATION_SEND_SKILLS_CAPABILITY`
  (`conversation-send-skills`) names a desktop that takes `skills` on `send`:
  ids of its skills the chat runs with that message, at most
  `CONVERSATION_MAX_SEND_SKILLS`, as its own composer's skill chips do. Never
  beside `queue`. `parseConversationClientMessage` keeps the list when every
  member is a skill id and refuses the frame otherwise. A desktop without the
  capability drops the member.

- **A listed chat names its branch.** `branch` is an optional member of
  `ConversationThread`: the branch the chat's folder is checked out on, as its
  HEAD names it, which the desktop's own sidebar shows on the chat's line.
  Absent for a folder that is not a repository, on a detached HEAD, and from a
  desktop built before it was listed. `parseConversationServerFrame` keeps it
  when it is one line with no spaces, at most 255 characters, and leaves out
  anything else. The pinned files are unchanged.

- **A queued message is held by the desktop the chat runs on.**
  `CONVERSATION_QUEUED_SENDS_CAPABILITY` (`conversation-queued-sends`) names a
  desktop that holds a message queued while a chat is mid-turn and sends it
  when the turn ends, so the device that typed it may sleep or close
  meanwhile. `send` takes `queue: true` (its words alone: never beside
  `uploadIds`), answered once the message is held; the `cancelQueued` command
  (`queuedId`) takes one back; the `watchQueued` request
  (`ConversationWatchQueuedRequest`) has the desktop send `queued` frames
  (`ConversationQueuedFrame`, each message a `ConversationQueuedMessage` of
  `id`, `text`, `createdAt` and an optional `failure`, at most
  `CONVERSATION_MAX_QUEUED_MESSAGES`) for the chat followed, now and on every
  change. `parseConversationClientMessage` reads all three and
  `parseConversationServerFrame` reads the frame, leaving out a message it
  cannot read. A desktop without the capability drops `queue`, so a send made
  mid-turn is refused `busy` as before, and answers the command and the
  request under their ids; it never sends a `queued` frame to a client that
  did not ask. The pinned files are unchanged.

- **A listed chat previews its agent's last reply.** `lastAssistantText` is
  an optional member of `ConversationThread`: the opening of the reply as
  written, at most `CONVERSATION_MAX_REPLY_PREVIEW` (240) characters, the line
  the desktop's own sidebar shows under the chat's title. Absent for a chat
  whose agent has not answered since the person last wrote.
  `parseConversationServerFrame` keeps it when it is text with words in it,
  cuts one past the cap, and leaves out anything else. The pinned files are
  unchanged.

- **A listed chat says when it was last marked unread.** `visitRewoundAt` is
  an optional member of `ConversationThread`, beside `lastVisitedAt`, kept by
  `parseConversationServerFrame` when it is a time and left out otherwise. A
  client keeping visit readings of its own takes the listed `lastVisitedAt`
  over any it took before this stamp. The pinned files are unchanged.

- **A message the desktop sent a chat itself says so.** `origin` is an
  optional member of the `user_message` payload,
  `ConversationMessageOrigin` (`{ kind: 'studio', reason? }`, the reason
  `agent-notice` or `usage-resume`), read by `readConversationMessageOrigin`.
  A message without one is the person's, so every transcript written before
  reads as it did, and a reader that does not know the member shows the
  message as the person's. The pinned files are unchanged.

- **A listed chat says where it stands in the desktop's own list.**
  `chatTitle` (the chat's title as the desktop's sidebar shows it),
  `lastUserMessageAt`, `lastTurnEndedAt` and `lastVisitedAt` are optional
  members of `ConversationThread`, kept by `parseConversationServerFrame` when
  readable and left out otherwise. `CONVERSATION_LIFECYCLE_CAPABILITY`
  (`conversation-lifecycle`) names a desktop that sends them, leaves settled
  chats out of the list, orders it as its sidebar does, and serves the
  `conversation.settle` and `conversation.visit` tools. The pinned files are
  unchanged.

- **`usage_updated` says how full the context window is.** `contextWindow`
  (the model's window, in tokens) and `contextUsed` (the tokens in it now:
  the latest request's size, not a sum) are reported by Claude Code and Codex
  chats as well as ACP agents, which already sent them. Both are optional
  payload members, so a reader that does not know them skips them, and the
  wire validator passes them through. The pinned files are unchanged.
- **A listed chat names its machine and its pull requests.** `host`
  (`ConversationWireHost`: `id`, `kind`, `label`, `color`) and `pullRequests`
  (`ConversationWirePullRequest`: `number`, `state`, `url`, `title`, at most
  `CONVERSATION_MAX_PULL_REQUESTS`) are optional members of
  `ConversationThread`, kept by `parseConversationServerFrame` and validated
  on their own by `parseConversationWireHost` and
  `parseConversationWirePullRequests`. An unreadable one is left out and the
  row kept. The pinned files are unchanged.
- **`turn_retrying`**, an event for a model call the provider will try
  again, with `ConversationTurnRetryingPayload` (`attempt`, `maxAttempts`,
  `retryInMs`, and the failure's `error` category and HTTP `status`). Until
  now a turn that kept failing and retrying showed nothing until the provider
  gave up. A client that does not know the type skips it.
- **The tool presentation is public.** `presentToolItem`, `toolActionVerb`
  and `summarizeToolGroup` (with `PresentableTool` and `ToolPresentation`)
  are exported from the entry, for views that word a tool step as Studio
  does. The pinned files are unchanged.

## 0.2.0

The package becomes the one conversation contract: what the tailnet lane, the
module SDK and the desktop's own chat view all speak.

### Added

- **The package entry is `public.ts`.** It publishes the first version's
  frames and helpers (`index.ts`, unchanged byte for byte, because the phone
  app carries those files under a shared pin), the client-side server-frame
  validator (`parseConversationServerFrame`, `parseConversationWireEvent`),
  which the entry did not export before, and everything below.
- **The event layer.** `ConversationEvent`, `ConversationEventType` with its
  value list `CONVERSATION_EVENT_TYPES` and `isConversationEventType`,
  `ConversationSessionStatus`, the payload types (`tool_started`,
  `tool_output`, `subagent_status`, `subagent_message`, `approval_requested`,
  `approval_resolved`), `ConversationQuestion`, `ConversationPage`, the stream
  frames a follower receives (`ConversationStreamFrame`) and the resume
  cursor (`ConversationCursor`). These were the desktop's own declarations;
  the desktop now imports them from here.
- **The command vocabulary.** `ConversationCommand` extends the wire's
  commands with `resolvePlan` (`approve` or `reject`, behind
  `conversation-plans`) and a `permissionMode` on `setPermissionPreset`
  (behind `conversation-cli-permission-modes`); `ConversationRequestDecision`
  names the three answers a client may give a tool request and never a
  permanent rule. `parseConversationClientMessage` and
  `explainRejectedConversationMessage` read the full contract and read every
  first-version frame exactly as `parseConversationClientFrame` does.
- **Create requests.** `ConversationCreateRequest`, with `allowedTools`, and
  its validator `parseConversationCreateRequest`.
- **The handshake.** `CONVERSATION_PROTOCOL_VERSION` (1) and
  `CONVERSATION_PROTOCOL_MIN_SUPPORTED`, the `hello` request and its answer
  (`parseConversationHelloAnswer`), `checkConversationProtocolVersion`, and
  `CONVERSATION_CAPABILITIES`, every capability name the lane has shipped.
- **Listed modes.** `ConversationThread` is a listed thread with its
  `permissionMode` and `capabilities.permissionModes`, which
  `parseConversationServerFrame` now keeps.
- **Publishable.** `publishConfig`, `repository` and this changelog. Publishing
  is a separate release step.

## 0.1.0

The direct conversation lane on the tailnet gateway: frames, the client-frame
validator, tool classification and presentation.
