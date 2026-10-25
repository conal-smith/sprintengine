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

- **A paired device can hand a chat off.** `CONVERSATION_HANDOFF_CAPABILITY`
  (`conversation-handoff`) names a desktop that takes the `handoff` command
  and hands the chat off to a fresh session as its own Handoff does: the
  chat's messages written to a file there, the provider session let go, and
  the next message pointing a new one at the file. A listed
  `ConversationThread` says which chats can, as `capabilities.handoff`.
  `parseConversationClientMessage` keeps a `handoff` that carries a command
  id; `parseConversationServerFrame` keeps `capabilities.handoff` when it is
  a boolean. A desktop without the capability refuses the kind as
  `unsupported_command`. The pinned files are unchanged.

- **A chat can go back to an earlier message, and a turn's files can be put
  back, from a paired device.** `CONVERSATION_REWIND_CAPABILITY`
  (`conversation-rewind`) names a desktop that takes the `rewind` command
  (`turnSeq`: the user message to go back before) as its Edit from here does;
  a listed `ConversationThread` says which chats can, as
  `capabilities.rewind`. `CONVERSATION_CHECKPOINT_REVERT_CAPABILITY`
  (`conversation-checkpoint-revert`) names one that takes `revert`
  (`turnSeq`, `undo`, `confirmed`, `files`) as its Revert does, previewing
  without `confirmed`. A command's result may now carry `data`
  (`ConversationCommandResultFrame`), which `parseConversationServerFrame`
  keeps when it is an object; a `revert`'s is a `ConversationRevertAnswer`,
  read with `parseConversationRevertAnswer`. `parseConversationClientMessage`
  keeps a `rewind` or `revert` in its documented shape and refuses any other
  as `invalid_frame`. A desktop without either capability refuses the kind
  as `unsupported_command`. The pinned files are unchanged.

- **A paired device can fork a chat, ask it a side question, and read what
  fills its window.** Three capabilities, each with a listed
  `ConversationThread` flag saying which chats can:
  `CONVERSATION_FORK_CAPABILITY` (`conversation-fork`, `capabilities.fork`)
  names a desktop that takes the `fork` command (`ConversationForkCommand`:
  `newAgentId` and `side: 'assistant'` with `turnId`, or `side: 'user'` with
  `turnSeq`); `CONVERSATION_SIDE_QUESTIONS_CAPABILITY`
  (`conversation-side-questions`, `capabilities.sideQuestion`) one that
  answers `askSideQuestion` and `cancelSideQuestion`; and
  `CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY`
  (`conversation-context-breakdown`, `capabilities.contextBreakdown`) one
  that answers `getContextBreakdown`. The frames, their answers and their
  readers (`parseConversationSideQuestionAnswer`,
  `parseConversationContextBreakdownAnswer`) live in a new file,
  `agentReads.ts`. `parseConversationClientMessage` keeps each well-formed
  frame and refuses a malformed one as `invalid_frame`;
  `parseConversationServerFrame` keeps each flag when it is a boolean. A
  desktop without a capability refuses `fork` as `unsupported_command` and the
  frames as `invalid_frame`. The pinned files are unchanged.

- **A client's composer reaches the chat's folder on the desktop.**
  `CONVERSATION_SEND_MENTIONS_CAPABILITY` (`conversation-send-mentions`): a
  `send` may name `mentions` (`ConversationWireMention`, at most
  `CONVERSATION_MAX_SEND_MENTIONS`), each by its path relative to the chat's
  folder, which the desktop resolves as its own composer's chips are.
  `parseConversationClientMessage` keeps them and refuses, as a bad frame, one
  that is absolute, names a drive, climbs out with `..`, or rides beside
  `queue`; `parseConversationWireMentions` reads a list alone.
  `CONVERSATION_FILE_SEARCH_CAPABILITY` (`conversation-file-search`) and
  `CONVERSATION_COMMANDS_CAPABILITY` (`conversation-commands`) name GETs
  beside the socket, whose answers `parseConversationFileSearchAnswer` and
  `parseConversationCommandsAnswer` read (composerReads.ts): the matches in
  the chat's folder by relative path, and the chat CLI's slash commands
  without Studio's. All additive; the pinned files are unchanged.
- **A chat's agent can be restarted.** `CONVERSATION_RESTART_SESSION_CAPABILITY`
  (`conversation-restart-session`) names a desktop that takes the
  `restartSession` command and ends the chat's agent process as its own
  Restart agent session does, keeping the session's place for the next
  message. Refused while the agent works; a chat with none running is
  answered with a `notice`. `parseConversationClientMessage` keeps it under
  its command id and drops anything beside the kind. A desktop without the
  capability refuses the kind as `unsupported_command`. The pinned files are
  unchanged.

- **A live chat's MCP servers can be reconnected and switched.**
  `CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY`
  (`conversation-mcp-server-actions`) names a desktop that takes the
  `mcpServerAction` command (`serverId`, and an `action` of
  `ConversationWireMcpServerAction`: `reconnect`, `enable` or `disable`,
  listed as `CONVERSATION_MCP_SERVER_ACTIONS`) and lists the actions each
  chat's provider takes as `capabilities.mcpServerActions`. A sign-in is not
  one: the CLI waits for its callback on the desktop.
  `parseConversationClientMessage` refuses an action it does not name, a
  sign-in included, or one naming no server, as `invalid_frame`;
  `parseConversationServerFrame` keeps the actions it can read. A desktop
  without the capability refuses the kind as `unsupported_command`. The
  pinned files are unchanged.

- **A chat's reasoning effort can be read and set.**
  `CONVERSATION_REASONING_EFFORT_CAPABILITY` (`conversation-reasoning-effort`)
  names a desktop that lists each chat's provider levels as
  `capabilities.reasoningEfforts` and the one the chat runs at as
  `reasoningEffort`, and takes `setReasoningEffort` (`effort`, absent for the
  provider's default), kept on the chat for its next turns.
  `isConversationReasoningEffortId` says whether a value can be a level.
  `parseConversationClientMessage` refuses a level that cannot be one as
  `invalid_frame`; `parseConversationServerFrame` keeps the levels it can read
  and a `reasoningEffort` that is one. A desktop without the capability
  refuses the kind as `unsupported_command`. The pinned files are unchanged.

- **A message can say the mode its turn runs in.**
  `CONVERSATION_SEND_MODE_CAPABILITY` (`conversation-send-mode`) names a
  desktop whose `send` takes `mode` (`ConversationSendMode`: `plan` or `ask`)
  and runs the turn in it, as its own chat sends one. `CONVERSATION_SEND_MODES`
  lists them with `default`. `parseConversationClientMessage` keeps a named
  mode beside whatever else the send says, reads `default` as none, and
  refuses one it does not name, or one beside `queue`, as `invalid_frame`. A
  desktop without the capability drops the member. The pinned files are
  unchanged.

- **A listed chat names its agents' local servers.** `localServers` is an
  optional member of `ConversationThread` (`ConversationWireLocalServer`:
  `id`, `url`, `title`, `port`, `state`), at most
  `CONVERSATION_MAX_LOCAL_SERVERS`, absent for a chat with none and from a
  desktop built before it was listed. `parseConversationWireLocalServers`
  reads it, dropping a server it cannot read (one whose address is not
  http(s), whose port is not one), and the row keeps the rest. No
  capability. The pinned files are unchanged.

- **A desktop says what it knows of its agents' usage limits.**
  `CONVERSATION_USAGE_LIMITS_CAPABILITY` (`conversation-usage-limits`) names a
  desktop that answers `ConversationWatchUsageLimitsRequest`
  (`watchUsageLimits`) with `ConversationUsageLimitsFrame`s (`usageLimits`: the
  followed chat's `ConversationUsageLimitNotice` or null, `autoResume`, and
  each plan's `ConversationUsageLimitSnapshot`, at most
  `CONVERSATION_MAX_USAGE_LIMIT_PLANS` of
  `CONVERSATION_MAX_USAGE_LIMIT_WINDOWS` windows each), now and on every
  change, and takes `usageLimitResume` (`action`, one of
  `CONVERSATION_USAGE_LIMIT_RESUME_ACTIONS`, and `always` beside `schedule`).
  `parseConversationUsageLimitNotice` and
  `parseConversationUsageLimitSnapshots` read the frame's members;
  `parseConversationClientMessage` refuses a malformed resume as
  `invalid_frame`. A desktop without the capability refuses the kind as
  `unsupported_command`. The pinned files are unchanged.

- **A message can be scheduled into a chat for a time.**
  `CONVERSATION_SCHEDULED_SENDS_CAPABILITY` (`conversation-scheduled-sends`)
  names a desktop that takes `scheduleSend` (`message`, `sendAt`), keeps the
  message and sends it then, and takes `sendScheduledNow` and
  `cancelScheduled` (`scheduledId`) to send one at once or delete it.
  `ConversationWatchScheduledRequest` (`watchScheduled`) has it send
  `ConversationScheduledFrame`s (`scheduled`: the chat's `key` and its
  `ConversationScheduledMessage`s, at most
  `CONVERSATION_MAX_SCHEDULED_MESSAGES`) now and on every change.
  `parseConversationClientMessage` keeps each and refuses a malformed one as
  `invalid_frame`; `parseConversationServerFrame` reads the frame, skipping a
  message it cannot read. A desktop without the capability refuses the kinds
  as `unsupported_command`. The pinned files are unchanged.

- **One agent a chat spawned can be stopped by itself.**
  `CONVERSATION_STOP_SUBAGENT_CAPABILITY` (`conversation-stop-subagent`)
  names a desktop that takes the `stopSubagent` command (`toolUseId`: the
  call that spawned the agent, its lane's id) and stops that agent alone,
  leaving the chat, its turn and its other agents running. A listed
  `ConversationThread` says which chats can, as `capabilities.stopSubagent`.
  `parseConversationClientMessage` keeps a `stopSubagent` that names an agent
  and refuses one that does not as `invalid_frame`;
  `parseConversationServerFrame` keeps `capabilities.stopSubagent` when it is
  a boolean. A desktop without the capability refuses the kind as
  `unsupported_command`. The pinned files are unchanged.

- **A chat can be handed off to a fresh session.** `context_handed_off` joins
  `CONVERSATION_EVENT_TYPES`, with its payload as
  `ConversationHandoffPayload` (`path`, `preTokens`, `seedOwed`,
  `providerSessionId: null`): the chat's messages, without its tool calls,
  were saved to a file on the machine the agent runs on, the provider session
  was let go, and the person's next message points the new one at the file.
  It sits between turns. A client that does not know it skips it, as it skips
  any event type it does not know, and draws the conversation without the
  divider. Not a pinned file.
- **Studio compacts an idle chat before its cache expires.**
  `ConversationStudioMessageReason` gains `auto-compact`: a `/compact` the
  desktop sent a chat by itself, while it sat idle with its prompt cache about
  to go cold. `readConversationMessageOrigin` keeps it; an older reader still
  reads the message as Studio's, without a reason. Not a pinned file.
- **A listed chat says how a person marked it.** `highlight` and
  `autoSettle` are optional members of `ConversationThread`. `highlight`
  (`ConversationWireHighlight`, `{ starred, color? }`) is the star and the
  highlight colour a person put on the chat from its row menu, on any device;
  `CONVERSATION_HIGHLIGHT_COLORS` names the colours, and
  `isConversationHighlightColor` and `parseConversationWireHighlight` read
  them. `autoSettle: true` says Auto-settle is on for the chat. Both are
  absent for a chat with neither, and from a desktop built before they were
  listed. `parseConversationServerFrame` keeps `highlight` when its star is a
  boolean or its colour one it knows, and `autoSettle` only when it is `true`.
  The pinned files are unchanged.

- **A send says when it was written.** `composedAt` (epoch ms) and
  `confirmedStale` are optional members of a `send` command, beside any other.
  `isStaleConversationSend` says whether a desktop refuses one at a time: it
  was written more than `CONVERSATION_STALE_SEND_MS` (30 minutes) ago and the
  person has not confirmed it. Such a send is refused with the new `stale`
  code, which joined `ConversationWireErrorCode`. `parseConversationClientMessage`
  keeps both members and refuses a malformed one; the first version's
  `parseConversationClientFrame` drops them, as a desktop from before them
  does. A pinned file: the phone's copy changes with it.
- **A listed chat says when its work began, how it began, and whether it
  sleeps.** `workingSince`, `scheduledAgentId` and `snoozedUntil` are optional
  members of `ConversationThread`. `workingSince` is when the chat's current
  stretch of work began: the person's message that began it, held through the
  turns the chat opens by itself while its `backgroundWork` goes on, where
  `turnStartedAt` restarts with each. The desktop's own sidebar counts
  "working for" from it, and lists it whenever it counts the chat as working.
  `scheduledAgentId` names the schedule whose run started the chat, which the
  desktop marks with the schedule's clock. `snoozedUntil` is when a chat the
  person snoozed wakes, listed only while that is ahead. All three are absent
  from a desktop built before they were listed. `parseConversationServerFrame`
  keeps `workingSince` and `snoozedUntil` when each is a clock and
  `scheduledAgentId` when it is an id, and leaves out anything else. The
  pinned files are unchanged.
- **A listed chat says what its checkout carries, and whether it is a
  worktree.** `changes` is an optional member of `ConversationThread`,
  `ConversationWireChanges` (`{ added, updated, removed, scope?, uncommitted? }`):
  the files the chat's branch added, updated and removed, as the desktop's own
  sidebar line and composer strip count them, whose changes they are
  (`ConversationWireChangeScope`: `worktree`, `branch` or `folder`), and the
  uncommitted ones alone.
  Listed only for a chat with a live session. `worktree: true` says the chat
  works in a git worktree of its project. Both are absent from a desktop built
  before they were listed. `parseConversationServerFrame` keeps `changes` when
  every count is whole and not negative (`parseConversationWireChanges`), and
  `worktree` only when it is `true`. The pinned files are unchanged.

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

- **A session can have a goal.** `ConversationGoal` (`objective`, `status`)
  is a goal the agent keeps working toward by itself, and
  `ConversationGoalStatus` says where it stands. A `session_updated` event
  carries it as `goal` when it changes, and `goal: null` once there is none.
  The turns the agent starts toward it come as `turn_started` with no
  `user_message` before them, as a turn an agent carries on with by itself
  always has. No frame changed; the pinned files are unchanged.
- **A listed chat says where the desktop's sidebar orders it, and when its
  turn began.** `recencyAt` and `turnStartedAt` are optional members of
  `ConversationThread`. `recencyAt` is the moment the desktop's own sidebar
  sorts the chat by: `lastUserMessageAt` when a person has written to it, else
  when the chat was made or last typed into there, which `lastUserMessageAt`
  alone could not say. `turnStartedAt` is when the running turn began. Both are
  absent from a desktop built before they were listed;
  `parseConversationServerFrame` keeps each when it is a clock and leaves out
  anything else. The pinned files are unchanged.

- **A message can carry files, not only pictures.**
  `CONVERSATION_MESSAGE_FILES_CAPABILITY` (`conversation-message-files`) names
  a desktop whose upload route takes `kind=file`: a file of any type, which a
  `send` names in `uploadIds` as it names a picture and which the message then
  carries by its path on that desktop (`files` on the `user_message`). No
  frame changed; a client without it offers pictures only. The pinned files
  are unchanged.
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
