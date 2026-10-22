# Changelog

## 0.1.0 (unreleased)

### Changed

- `formatStepDuration` moves up to hours from an hour on ("6h 59m 50s"),
  where it read "419m 50s".

- `retryLabel` reads a 403 as "Access refused", where it read "Couldn’t
  authenticate", whatever category the provider filed it under.

### Added

- The projection carries a `handoff` entry, and the timeline a `handoff` row,
  for a `context_handed_off` event: the chat was handed off to a fresh session
  pointed at a file of its messages (`path`), leaving `preTokens` of context
  behind. It sits after the turn it followed, as a compaction between turns
  does, and resets the prompt-cache reading and the context's size, as a
  compaction does.

- A compaction entry says `beforeCacheExpiry` when its turn's message was
  Studio's own `/compact` before the chat's prompt cache expired (`origin`
  reason `auto-compact`), and the timeline draws no row for that message: the
  compaction's divider says it.

- The projection carries `goal`: the goal the session's agent keeps working
  toward by itself (`objective`, `status`), as the latest `session_updated`
  that named one said it, null once one says `goal: null`, and emptied when a
  session starts. `readConversationGoal` is the reader, and
  `CONVERSATION_GOAL_STATUS_WORDS` says each status in a word or two
  ("Working", "Paused", "Met").

- The projection carries `backgroundTasks`: the shells, monitors and workflows
  the session's process still runs after its turn ended, as the latest
  `session_updated` listed them, emptied when a session starts.
  `readBackgroundTasks` is the reader, `backgroundTasksWakeAgent` says whether
  any will wake the agent (a monitor with a deadline or a task does; a command
  does not), and `describeBackgroundTasks` names them in one line ("Waiting on
  monitor: CI checks", "Running: npm run dev").

- A tool entry carries `images`, the pictures its step returned, read from
  a `tool_output`'s `images` member (paths that are text, at most eight,
  `MAX_TOOL_IMAGES`) by `readImagePaths`. The full and the incremental
  projection read it alike; a step that returned none has no member.

- The working row carries `latestThought`, the first sentence of the newest
  thinking or prose between the running turn's steps, and the `turnId` whose
  fold it sits under, so a view can say why the agent is doing what the line
  says while those steps are folded. Absent while the agent replies.
  `reasoningPreview`, `firstThoughtSentence` and `latestTurnThought` are the
  readers.

- A user entry carries `files`, the files the message attached by path, read
  from a `user_message`'s `files` member (`{ path }` each), and a local turn
  passes its own through. `parseConversationAttachedFiles` is the reader and
  `attachedFileName` names one; a view draws a message's file cards from this
  list, never from its text.

- A user entry carries the `origin` its `user_message` recorded, for a message
  the desktop sent the chat itself, so a view can draw it as Studio's rather
  than as the person's.

- `ConversationUsage` carries `contextWindow` and `contextUsed` from
  `usage_updated`, each kept until a report moves it (a compaction resets
  `contextUsed` to what the summary left). `nextConversationUsage` is the fold,
  shared by the full and the incremental projection.

- The projection, incremental projection and timeline Studio's chat view
  draws from, moved here unchanged so the app and other views share one
  implementation.
- `createConversationFollower`: follow one conversation over a Studio
  connection and read it as rows, with paging to earlier turns.
- `checkConversationTimelineProtocol`: the conversation protocol window the
  package reads, checked against a Studio's welcome.
- `turn_retrying` is read: the turn's entry carries the latest `retry`
  until the turn reports anything else, and the working row says why and
  which attempt (`retryLabel`), in place of "Thinking…".
