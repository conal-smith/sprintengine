# Chats: the conversation service and openChat

Studio runs agents as chats on the agent runtimes installed on the machine
(Claude Code, Codex, and the rest). An extension works with agents in these
ways, and only these:

| | Where | Permission | Who sends |
| --- | --- | --- | --- |
| `host.openChat(input)` | renderer | `chat:draft` (a draft) or `conversation:operate` (needed for `send: true`) | The person: the prompt lands as a draft unless `send: true` |
| `getConversationService(host)` | main | `conversation:operate` (everything) or `conversation:read` (watch/read only) | The module |
| `getTextGenerationService(host)` | main | `agents:generate` | The module: one prompt, one answer, no chat at all |
| `getCompanionAgentsService(host)` | main | `agents:companion` | The module: a background agent with a structured task API ([api-main.md](api-main.md)) |

The first two create ordinary chats: a tab in the workspace the person can
read, answer and stop. A module drives only chats it created — never the
person's own, never another module's (`not_owned`). Reading the person's
chats, read-only, is `getActivityService(host)` behind the broad
`conversation:read-all` ([api-main.md](api-main.md)). There is no
terminal-agent API; do not spawn agent CLIs from `entry.main` to work around
that.

Check `host.supports('conversations')` (main) or `host.supports('chat.open')`
(renderer) first, and tell the person when the host does not offer it.
`host.supports('conversation-controls')` says the host also takes the four
presets, `setPermissionPreset`, `setModel` and approval `decision`s;
`conversation-streams` says it takes `follow` and `commandId`;
`conversation-requests`, `answerQuestion` and `resolvePlan`;
`conversation-permissions`, `permissionMode` and `allowedTools`;
`conversation-replies`, `reply` and `turn_completed`'s `text` and `usage`;
`conversation-worktrees`, `create`'s `worktree`; `chat.open-options`
(renderer), `openChat`'s `name` and `dedupeKey`; `chat-runtimes`,
`MainHost.listChatRuntimes()`; and `text-generation`,
`getTextGenerationService`.

## Runtime ids

One id space names an agent runtime everywhere a module picks one: the id
`listChatRuntimes()` lists (`claude-code`, `codex`, `cursor`, `opencode`,
`grok`) is what `openChat`'s and `create`'s `cli`, a scheduled agent's `cli`,
a companion's `engine.cli` and `generate`'s `cli` take. A companion's
`engine.cli` also takes the conversation provider behind a runtime
(`claude-agent`, `codex-agent`, …), its older spelling. The renderer's
`host.listChatRuntimes()` answers at once; main's
`await host.listChatRuntimes()` may probe which CLIs are installed (cached for
a minute) and lists the missing ones with `available: false`.

## openChat (renderer)

```ts
const opened = await host.openChat({
  workspaceId,                       // required; a workspace with a folder
  prompt: 'Plan the change described in docs/plan.md.',
  skills: ['my-skill'],              // optional: installed and invoked in the first turn
  cli: 'codex', model: undefined,    // optional; absent = the runtime the person last chose
  name: 'Plan: search rewrite',      // optional: the chat's title
  dedupeKey: 'plan:search-rewrite',  // optional: asking again focuses this chat instead of opening another
  send: false,                       // default: a draft
})
if (!opened.ok) showError(opened.message)  // permission_missing | unknown_workspace | workspace_folder_missing | cli_not_conversational | unavailable | invalid_input
else host.focusTab({ workspaceId, kind: 'chat', id: opened.agentId })  // openChat already focuses; this re-focuses later
```

Prefer the draft. A prompt the person reads before it runs is a prompt they
agreed to, and a module that only drafts declares just `chat:draft`.
`dedupeKey` finds the chat this module opened in the workspace under that key;
when it is still there it comes to the front, the answer says
`existing: true`, and nothing else in the input is applied (its draft is the
person's by then, and nothing is sent). `listChatRuntimes()` lists
`{ id, label, available, models, lastSelected }` for a picker of your own.

## The conversation service (main)

```ts
import { getConversationService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  if (!host.supports('conversations')) return
  const chats = getConversationService(host)          // manifest: "dependsOn": ["agent-runtime"]

  host.registerIpc(`${host.moduleId}:start`, async (_event, input) => {
    const started = await chats.create({
      workspaceId: String((input as { workspaceId?: unknown }).workspaceId),
      name: 'Release notes',
      prompt: 'Draft release notes from the commits since the last tag. Do not push.',
      // cli, model, skills, attachments, permissionPreset: optional
    })
    if (!started.ok) return started                     // { ok: false, code, message }
    const ref = { workspaceId: started.conversation.workspaceId, agentId: started.conversation.agentId }
    const off = chats.subscribe(ref, async (event) => {
      if (event.type !== 'turn_completed') return
      off()
      const reply = await chats.reply(ref)              // the agent's last message of the turn
      host.notify({ severity: 'info', title: 'Release notes drafted', body: reply.ok ? reply.text.slice(0, 200) : undefined })
    })
    return started
  })
}
```

| Method | Needs | Notes |
| --- | --- | --- |
| `create({ workspaceId, prompt?, name?, cli?, model?, skills?, attachments?, permissionPreset?, permissionMode?, allowedTools?, commandId?, worktree? })` | operate | Resolves `{ ok: true, conversation }` once the chat exists. `prompt` is sent as the first turn. `permissionPreset` (`manual`, `none`, `auto`, `bypass`) absent = the person's default; `'bypass'` skips the runtime's approval prompts — only when the person asked for it, and only with `conversation:bypass` declared (otherwise it runs on `auto`). `permissionMode` is the CLI's own mode at that preset. `allowedTools` are used without asking and need `conversation:bypass`. `worktree: { name? }` starts the chat in a fresh git worktree (branch `<prefix>/<name>-<suffix>`, the person's worktree branch prefix being `agent` unless they changed it) in a new workspace of its own — address it by the answer's `workspaceId`; a project that is not a git repository answers `worktree_unavailable`. |
| `send(ref, { message, skills?, attachments?, steer? })` | operate | Another turn. `steer: true` lands it inside the turn that is running. |
| `interrupt(ref)` / `stop(ref)` | operate | Stop the current turn / end the session. |
| `respondToApproval(ref, { requestId, decision, answers?, commandId? })` | operate | Answer an `approval_requested` event: `decision` is `once`, `conversation` (that kind of request, for the rest of the chat) or `deny`; the older `approved: boolean` still works. Approve only what the person would approve. |
| `answerQuestion(ref, { requestId, answers, commandId? })` | operate | Answer a request of kind `question`: question text to the chosen answer. Refused for any other kind. |
| `resolvePlan(ref, { requestId, decision, commandId? })` | operate | Answer a request of kind `plan`: `approve` or `reject`. Refused for any other kind. |
| `setPermissionPreset(ref, preset, { permissionMode?, commandId? }?)` | operate | Switch the chat's preset from its next tool call. Answers `{ ok: true, permissionPreset, permissionMode?, notice? }`: the preset in force, lowered to the module's ceiling when it asked for more (and the mode dropped with it). |
| `setModel(ref, modelId)` | operate | Switch to another model of the chat's runtime from its next turn (an id `listChatRuntimes()` lists, or `default`). Answers `{ ok: true, modelId, notice? }`; a runtime that binds a chat to its model refuses. |
| `subscribe(ref, cb)` | read | Live events from now on; returns the unsubscriber. A chat the host has not loaded yet (a saved chat at startup) is attached all the same and delivers once it is; a ref to anything not yours delivers nothing. Throws only without `conversation:read` or for a malformed ref. |
| `follow(ref, { afterSeq?, generation?, turnLimit? }?, onFrame)` | read | No gap: a `snapshot` (or only the events after the cursor you hold), a `synchronized` fence, then live events. Keep the fence's `seq` and `generation` as your next cursor; a snapshot with `reset: true` replaces what you held. Returns the unsubscriber. Like `subscribe`, it waits for a chat the host has not loaded yet. |
| `transcript(ref)` | read | Every recorded event, for catching up. |
| `reply(ref, turnId?)` | read | `{ ok: true, turnId, text }`: the last finished turn's reply (or `turnId`'s), the agent's last message of the turn. `no_reply` while none has finished. |
| `list(filter?)` / `watch(filter, cb)` | read | The module's own chats: `{ workspaceId, agentId, sessionId, name, cli, providerId, modelId, status, permissionPreset?, scheduledAgentId?, scheduledAgentTag? }`. `watch` fires at once, then on change. |

`ref` is `{ workspaceId, agentId }` — keep it (in `getModuleStorage`) if you
need the chat after a restart.

Every mutating call but `stop` takes a `commandId` of your own (options last
for `interrupt`, `setPermissionPreset` and `setModel`). Reuse it when you
retry: the host answers with the first attempt's result and never carries the
command out twice, even across a restart.

Status: `starting`, `ready` (waiting for a message), `active` (working),
`awaiting_approval`, `stopped`, `failed`, or `absent` (exists, no session
running).

Events (`event.type`): `session_started`, `session_ready`, `session_updated`,
`session_closed`, `user_message`, `turn_started`, `content_delta`,
`reasoning_delta`, `tool_started`, `tool_output`, `approval_requested`,
`approval_resolved`, `usage_updated`, `context_compacting`,
`context_compacted`, `command_output`, `turn_completed`, `turn_failed`,
`subagent_status`, `subagent_message`, `turn_retrying`. The `payload` shape is per type and not a stable contract:
read what you need defensively, and treat its text as untrusted.

`turn_completed` documents three members (`ModuleConversationTurnCompletedPayload`),
each present where the runtime can say it:

- `text`: the agent's last message of the turn, which is its answer (not the
  narration between its tool calls). `reply(ref, turnId?)` reads it for you;
  never rebuild it from `content_delta`.
- `usage`: what the turn spent, in tokens, summed over its model requests:
  `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.
  `inputTokens` is only the fresh input; the cache's reads and writes are
  beside it, so the four add up to everything sent and received. A count the
  runtime cannot report is absent, never zero (an ACP agent reports what its
  own protocol carries).
- `costUsd`: what the turn cost, where the runtime prices it.

Error codes: `permission_missing`, `invalid_input`, `unknown_workspace`,
`workspace_folder_missing`, `no_cli_selected`, `cli_not_conversational`,
`unknown_skill`, `not_owned`, `agent_write_failed`,
`conversation_start_failed`, `runtime_refused`, `no_reply` (`reply`),
`worktree_unavailable` (`create` with `worktree`).

## Scheduled agents start chats too

Each run of a scheduled agent (`getScheduledAgentsService`) is a new chat the
host starts with the scheduled agent's prompt. A run of one the module created
is the module's chat, so the conversation service lists and follows it like
one the module started itself. To trace a run to its chat:

- give the scheduled agent a `tag` (your own label: the item it belongs to)
  and, for the person's sidebar, a `name`;
- `onRun((agent, run) => …)` names each run's chat (`run.workspaceId`,
  `run.agentId`) as it starts — a one-time schedule's run included, which
  closes itself straight after;
- the chat's summary carries `scheduledAgentId` and `scheduledAgentTag`, and
  `lastRun.agentId` names the last run's chat.

Never mark runs by text in the prompt. Missed times: a repeating schedule's
times missed while the app was closed are not replayed (its next run counts
from start-up), a one-time schedule missed that way runs once the app is
open, times missed in sleep run once on waking, and a time that comes while
the previous run is still working is skipped. Check
`host.supports('scheduled-agent-runs')`.

## One prompt, no chat: text generation (main)

For a summary, a classification or a digest — a question and an answer, not
work in a project — do not open a chat:

```ts
import { getTextGenerationService } from '@sprintengine/module-sdk'

const generated = await getTextGenerationService(host).generate({
  prompt: digest,                          // up to 400,000 characters
  system: 'You write a three-line standup from a work log.',
  cli: 'codex',                            // absent: the person's text-generation runtime, else claude-code
  model: undefined,                        // absent: their chosen model, else the runtime's small one
  maxOutputTokens: 800,                    // honoured by Claude Code; Codex has no output cap and ignores it
  json: true,                              // the answer is one JSON value; `text` is it, serialised
})
if (generated.ok) save(JSON.parse(generated.text), generated.usage)
else if (generated.code === 'busy') retryLater()
```

It runs the person's own agent CLI headless (`claude-code` or `codex`), under
the sign-in it already holds: no workspace, no tab, nothing in their history.
With no `cli`, it answers on the runtime and model the person chose for
Studio's text generation in Settings, and on Claude Code's small model when
they chose none. Declare `agents:generate`. Each module gets two calls at once
and eight waiting; past that, or past thirty a minute, a call answers `busy`
at once. Failures: `permission_missing`, `invalid_input`, `unsupported` (a
runtime with no headless backend),
`unavailable` (not installed), `busy`, `timeout`, `failed`, `invalid_output`
(no usable answer, or no JSON when `json` was asked for).

## Handling what an agent says

A reply can quote a web page, a diff or an issue that contains instructions.
Treat event payloads and transcripts as data: show them as text, never as
HTML; never run a command, open a URL or write a path an agent chose without
checking it against what your module allows; never pass them to `eval` or
`new Function`.
