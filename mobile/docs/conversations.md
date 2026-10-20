# Phone conversations

The chat list is the app's home. It lists the chats of every paired tailnet
desktop that advertises the conversation capability and grants read access.
Conversation control is a separate pairing grant, and New (which also needs
the desktop's projects, `workspace:read`) appears only where some desktop
grants it. A desktop too old to stream chats lists nothing; update Studio and
pair again if conversation access is missing.

## The list

Chats are in the order you last wrote in each, newest first, in Recent and in
each By project group alike, and the groups themselves go by their most
recently written chat. A chat's state tints its row and never moves it: one
that finishes a turn or starts waiting on you stays where it was, as in the
desktop's sidebar: chats stay put, ordered by when you last sent them a
message. A chat waiting on you
is never put under Earlier, so it stays in view; nothing else about it lifts
it. Earlier holds the chats at rest that were last written in more than a day
ago. The bare time on a resting row is when its last turn ended.

A row is gold while an approval or a question waits on you, and green when it
finished a turn in the last day that nobody has seen since: not opened on this
phone after it ended, and, where the desktop lists visits, not on screen on
the desktop or any other phone either. The bell's finished notices follow the
same rule (`chatHasUnseenTurn`). A chat this phone has never seen before
counts as seen when it first lists, so a fresh pairing does not wash the list
green.

A chat whose turn has ended but which still has work going, an agent it
launched in the background or a monitor that will wake its agent, is working,
as the desktop's sidebar counts it: its row wears the working mark and says
"Working in background", it stays out of Earlier, and it turns green only once
that work ends. The desktop lists it as `backgroundWork` (2026-10-17) beside a
`phase` left as the turn's own, and the phone reads it nowhere a turn counts:
a message sent then goes straight to the desktop, never held behind a turn
(`chatWorksInBackground`). In the chat, the working line says "Working in
background", or how many agents are, and the desktop's list is read again
when an agent ends, so the line goes when the last of it does. A desktop from
before the member lists none, and such a chat reads as finished, as before. A
waiting or failed chat says that first.

A desktop that advertises `conversation-lifecycle` lists, for each chat, its
title as the sidebar shows it (`chatTitle`, which the row and the chat's
header lead with; an open chat reads it again as each turn ends, since the
desktop writes the title summary while the first turn runs), when you last sent it a message (`lastUserMessageAt`, the
order), when its last turn ended (`lastTurnEndedAt`, what makes it news) and
when a person last had it on screen anywhere (`lastVisitedAt`). Its list
leaves settled chats out; the phone also drops any chat whose workspace the
workspace list marks `settledAt`, so none reaches the list or a project group.
A field in the wrong shape is dropped and that chat reads as an older
desktop's would. An older desktop lists none of them: there the order and the
green read `updatedAt`, which also moves on a rename, a session starting or
stopping and a usage report, and the phone cannot settle or stamp visits.

While a chat is open, the phone tells its desktop so with
`conversation.visit`: on opening, at most every ten seconds while it stays on
screen with the app in front, at once when a turn ends in view or the chat has
a turn nobody has seen, and on leaving. A stamp that fails is logged and
nothing else; this phone still keeps when it last opened each chat itself.

A chat in one of a project's worktrees is the project's, as the desktop's
sidebar files it: its row names the project ("multicode") with the worktree's
mark, it groups under that project, and New's project list holds the project
once. The desktop's New chat starts every chat in a pooled worktree by
default, so without this each chat founded a project named after its slug
("pool-02", "chat-ab12"). The desktop's `workspace.list` sends each
workspace's folder but not the project a worktree was cut from, so the phone
reads the desktop's own path convention for that
(`<parent>/.sprintengine-worktrees/<repo>/<slug>` is `<parent>/<repo>`'s,
`worktreeProjectLogic.ts`), which holds for every worktree the desktop cuts.
A worktree made elsewhere by hand lists as a project of its own until the
desktop sends the workspace's recorded `worktree.repoRoot`, which the phone
reads first where it is sent.

Long-press a row, or use the chat header's More button, and choose Settle to
settle the chat on its desktop (`conversation.settle`), which moves it to the
desktop's Settled shelf. A screen reader finds Settle among the row's actions.
The row leaves the list at once, and the chat closes back to the list; if the
desktop refuses, the row comes back and a toast says why. Settle is offered
only where the desktop advertises `conversation-lifecycle` and the pairing
operates its chats.

The same menus offer Mark unread where the desktop advertises
`chat-mark-unread` (2026-10-07), the pairing operates its chats, and the
chat's agent has finished something, unless the row is already green. It
calls `conversation.mark_unread`, which moves the chat's `lastVisitedAt` back
to just before its latest finish, so the finish reads as unseen on every
device. The row goes green the moment the desktop answers; a refusal (one with
nothing finished is refused as `nothing_finished`) leaves it as it was, and a
toast says why. Marked from the chat's own More menu, the chat closes back to
the list, since looking at it is what reads it: nothing on this phone stamps
it seen again until it is next opened.

The visit clock had only ever moved forward, and the phone took the later of
the listed clock and its own readings: when it last opened the chat, and the
clock a visit it stamped answered with. A mark unread now wins over every
such reading taken before it (`chatLifecycleLogic.ts`, `visitRewindApplies`),
and a reading taken after it, the person opening the chat again, wins over
the mark. The phone learns of a mark from its own call, from a desktop that
lists `visitRewoundAt` beside the clock, or, from a desktop that advertises
`chat-mark-unread` and lists no such stamp (as of 2026-10-07 none does), from
a listed clock earlier than the last it heard from the desktop: its previous
read of the list, or a visit answered before the read set out. The
readings it resets are reset in its device notes too, so the mark stays up
after a restart. A desktop without the capability moves its clock only
forward, and is read as before. A chat marked unread on the desktop while the
app was closed has no earlier read to compare with, so it reads as the phone
last saw it until it is read again: read, never anything wrong.

## New

New is the desktop's New chat composer: the prompt, the "+" for pictures,
the model picker and send, with the strip tucked under the box saying where
the chat runs: the machine, the project, Worktree, and the branch.

Worktree is on when New opens, as on the desktop: the chat starts in a
worktree of its own, cut from the desktop's worktree pool on the project's
main checkout's branch, which the strip names ("from main"). Tap it for "No
worktree" and the chat starts in the project's folder. It is offered where
the desktop advertises `new-chat-worktree` and the folder can be forked: not
for a folder on an SSH machine (`ssh://…`), nor one the desktop's checkout
read says is not a git repository. A folder whose checkout has not been read
is offered; if the desktop then cannot make the worktree
(`worktree_unavailable`) nothing is started, its reason is shown, and "Start
without a worktree" starts the same chat in the folder. An older desktop
skips an argument it does not know, so `worktree` is never sent to one that
did not advertise it, and New there shows no Worktree.

The model picker is the desktop's (`ModelPickerSheet`,
`modelPickerLogic.ts`), on New and in a chat alike. The desktop's provider
rail is a row of chips across the top of the sheet, each a CLI's mark and
name, with the provider line under it ("Kimi K3 · via Claude Code"). A
search field searches every provider's models at once. Each row is one
model: the CLI's own default first, under the CLI's name, then one row per
model family, named by the id the desktop's picker names it by, with "New"
where the desktop marks it and the raw id under the name only where it says
something the name does not. A model the catalog ships at more than one
context window is one row, and once it is picked the window is a second
choice under it ("Standard | 1M"); picking the row again keeps the window.
Below the list is the effort ramp, "Reasoning", from Auto (no level sent,
the CLI's own default) to the CLI's costliest level, which reads in the warn
tone, with the CLI's own default level marked "Default". Under it is the
Access row. New keeps one choice the desktop's picker has no row for:
Desktop default, which sends no CLI and leaves it to the desktop's last-used
one.

A desktop that advertises `cli-runtime-catalog` answers `cli.runtime.list`
with its picker's own rows for each CLI (`catalog`): New offers every CLI it
says can run as a chat, and hides the ones it says cannot. An older desktop's
CLIs are offered as before, those that list models, grouped into families by
the desktop's own rule (a bracketed suffix, `[1m]`, names the window). An
effort is offered and sent only where the desktop advertises
`new-chat-effort` and the CLI declares levels; a level is the CLI's, so
switching CLI drops it. A level the desktop refuses (`unsupported_effort`)
says so, and nothing is started.

## A chat

Open a conversation to read Markdown, inspect grouped tool activity and changed
files, send a message, or respond to pending requests. Supported live sessions
also offer image attachments and interruption. Images are uploaded directly to
the paired desktop, not the hosted relay, and their references expire. A
picture over 5 MB is refused before it is uploaded, since the desktop would
refuse it; one that advertises `conversation-image-downscale` scales pictures
down itself and takes them up to 20 MB, and the phone lets them through there.

A desktop that advertises `conversation-message-files` takes files of any
type too, so the "+" adds **Choose a file** after the photo rows, on New and
in a chat (in a chat even where its agent reads no pictures, since any agent
reads a file by its path). The picker is expo-file-system's own
(`File.pickFileAsync`, `pickChatFile.ts`), already in the app, so it needs no
new build. iOS hands back a copy whose name is the file's; Android hands back a
document uri, which is copied into the app's cache before it uploads, and
named from the path its provider id carries, or `file` with the extension its
type says where the id names nothing. A file over 25 MB, or an empty one, is
refused before it goes (`chatFiles.ts`). It uploads to the chat's session with
`kind=file`; the desktop keeps it in Studio's own data folder, never the
project, and the send names its id beside any photo's, sixteen at most
between them. The tray shows it as a chip with its kind's glyph, and the
message, once the desktop has it, as a file card (below). A desktop without
the capability takes pictures only, and no File row is drawn.

A message Studio sent the chat itself, rather than you, is Studio's quiet
line, not your bubble: an agent the chat launched reporting back, or a resume
once a usage limit that stopped the chat has reset. The desktop records it as
any other `user_message`, since the agent is handed it as a turn, and marks it
with an `origin` (`{ kind: 'studio', reason }`) on the payload. The phone
reads that optional member off the payload without its pinned wire types
changing (`studioNotice.ts`): a `studio` origin whose reason this phone does
not know is still Studio's, and an origin in any other shape, or none, is
yours, as every message before the member was. The row reads "SprintEngine
Studio · …" in the note's ink, without the bracketed name the agent's copy of
the words opens with, and has nothing to act on. It is never you writing: the
list orders by the desktop's `lastUserMessageAt`, which leaves it out, and it
is no bubble of yours. The "New" divider goes above it when the reply it
opened is the first unseen one, since it is news too.

Files you attached to a message by path on the desktop travel beside your
words (`files`, each `{ path }`, on the `user_message`), never in them, and
show under your bubble as a card each: the kind's glyph (the desktop's office
marks: PDF, document, spreadsheet, presentation, text, archive, or a plain
page), the name cut in the middle so its extension stays, and the kind in
words ("PDF", "DOCX", or "File" for a name with no extension worth showing).
The paths are the desktop's, POSIX, a Windows drive or a Windows share, which
the phone cannot open, so a tap does nothing and a long press says the whole
path. The phone reads the optional member defensively (`attachedFiles.ts`):
an entry that is not an absolute path within bounds is skipped, each path
shows once, and no more than the desktop's fifty are drawn. A message of
files alone has no bubble, only its cards.

Pictures you sent with a message show in your bubble above your words, a
64-point rounded square each, as the desktop's sent bubble draws them, and a
tap opens one full screen. The desktop records each on the `user_message` as
an `attachments` entry (`{ id, mediaType, name?, byteLength, ref }`, `id`
the upload id); the bytes are never on the wire. A photo this phone sent is
drawn from the phone's own file, remembered by its upload id the moment it
uploads, so the message shows it while it is pending and after the desktop
echoes it, with no fetch. Any other (sent from the desktop, from another
phone, or before the app last started) is fetched from a desktop that
advertises `conversation-message-images`, by its `ref` on the
`conversation-image` route (`attachment=<ref>`). Where neither has it, the
square names the picture instead. The phone reads the member defensively
(`sentPhotos.ts`): an entry without an id is skipped, a ref not in the
desktop store's shape is never asked for, and no more than the desktop's
sixteen are drawn.

A chat opened with agent replies that finished since anyone last had it on
screen draws a thin "New" seam, the compaction divider's, above the first of
them, and opens there instead of at its end, so what is new reads downwards
from where you left off (the desktop's divider, `unreadDivider.ts`). What was
seen is the chat's visit clock (`lastVisitedAt`) as it stood when the chat
was opened, taken before this phone's own visit stamp moves it and held until
you leave the chat. Only an agent's reply can be new, never your own message,
and the divider lands at a reply's start, with a compaction on the way into it
below it. It keeps its row while the agent streams on: a reply that starts or
finishes while you watch never takes it. A chat nobody has opened, or one where
nothing from an agent was read yet, has none, and so does every chat on a
desktop that lists no visits, where the phone's own record of opening a chat
counts its first sighting as seen. The landing happens once per opening; a
chat scrolled by hand before the desktop has caught it up stays where it was
put. After a Mark unread, on any device, the visit clock sits just before the
chat's latest finish, so the next opening's divider sits above its latest
reply; a thread the chat was handed before the mark, still carrying the clock
from before it, does not move it (`chatOpenedSince`).

Scrolled away from the end of a chat, a pill floats over the transcript's
foot, above the composer and above a queued message: "Jump to latest", or "2
new replies" once replies finished while you were up there, as on the
desktop. Tapping it glides to the end (a jump, with Reduce Motion on) and the
chat follows new messages again. The count is of replies, one per turn
however its words are split around its steps, that finished after the last
one finished when you left the end; a reply still arriving is not counted
until it ends, a page of older history loaded above adds none, and coming back
to the end, by the pill or by hand, starts it again (`jumpToLatest.ts`). A
transcript that fits on the screen, or a chat still landing, has no pill.

### Diagrams and math in a reply

An agent's reply draws its `mermaid` fences as diagrams and typesets its
display math, as the desktop's chat does; a person's own message never does
either, and neither does a plan or a document. The rules are the desktop's
(`src/components/document/rich/replyMarkup.ts`):

- Display math is a block of its own, like a code fence: `$$` alone on a
  line, the TeX, and `$$` alone on a closing line; or `\[` opening a line and
  `\]` ending one, so `\[ E = mc^2 \]` filling a line counts. A block needs its
  closing line: until it has one, it is the text it is. A `math` fence
  typesets; `latex`, `tex` and `katex` fences stay code, since they are as often
  whole documents.
- A dollar never opens math in prose: prices ("$5 to $10") and `$HOME` stay
  text. Nothing is read inside a code span or a code block. `\[1\]` on its own
  line is a citation, and `\[WIP\]` mid-sentence is brackets. A formula over
  16,384 characters stays text.
- Inline `\( … \)` is shown as its TeX in a code pill. A React Native text run
  cannot hold a typeset formula without breaking its line around it (an
  inline drawing sits on the line's bottom, not its baseline, and arrives a
  moment after the text), so the phone keeps the line whole and the TeX
  legible rather than half-typesetting it. It stays on its line, gives way to
  a backtick or a `://`, and is capped at 4,096 characters.
- While a reply streams, a diagram or a formula draws only once its block is
  complete: closed, with a line break after the closing line (a fence closing
  on the very last line might yet gain an info string and not close). Until then it is
  its source. A finished reply draws what it has.
- A diagram that does not parse, or a formula KaTeX refuses, shows its source
  with a one-line note saying why ("Shown as source: Parse error on line 3").
  A drawn diagram has Source in its header, which shows (and lets you select)
  what it was drawn from, and Diagram to go back; its Copy copies that source
  either way.
- Diagrams and formulas take the theme's ink and surfaces, light and dark
  (`diagramTheme`). A diagram wider than the column shrinks to it, to half
  its size at most, then scrolls sideways; a formula never shrinks and
  scrolls when it is wider, as on the desktop.

Both are drawn in one hidden WebView (`RichRendererHost.tsx`), separate from
the artifact preview, which stays as inert as it was. It is mounted the first
time a reply needs a drawing and draws one job at a time; each drawing is kept,
so a reply scrolled back into view draws at once. Its page
(`richRendererDocument.generated.ts`, built by `npm run build:renderer` from
the pinned Mermaid and KaTeX and KaTeX's faces) is part of the app: it works
offline and fetches nothing. Its policy is `default-src 'none'` with its own
five scripts admitted by hash; every navigation and window is refused and
nothing is stored. What it sends back is untrusted: it must answer the job in
flight, and its SVG is rebuilt from an allow-list (`svgSanitizer.ts`) before
react-native-svg draws it. No `a`, `image`, `img`, `script`, `style`, `use` or
`foreignObject`, no `href`, `src` or `srcset`, no handler, and no `url()` but
one naming an element of the drawing itself, in any attribute, CSS escapes
read first. A page that does not answer in 15 seconds is thrown away and
loaded afresh.

Mermaid runs at `securityLevel: 'strict'` with HTML labels off, and a
diagram's own `%%{init}%%` cannot turn them back on or change its stylesheet,
theme values, fonts, label sanitising or markers (`secure`). Mermaid fetches
while it lays some diagrams out, so a diagram that would (any `url()` that is
not `#`, `image-set()`, `@import`, a node's `img:`, a participant's `icon`
given as an address) is refused before it reaches the page and shows as source
with "Diagrams in a reply do not load images or styles from elsewhere". A
source over 20,000 characters shows as source.

The phone draws with react-native-svg, which has no `foreignObject`, so the
page flattens each drawing first: every computed style is written onto its
element, a baseline react-native-svg cannot place becomes an offset, and
every KaTeX glyph is drawn as the outline its face holds for it, so the phone
needs none of KaTeX's faces. Labels are set in a face both sides have
(Helvetica on iOS, Roboto on Android). What Mermaid still puts in a
`foreignObject` with HTML labels off is lost: a user journey's section names,
and a sequence message written as `$$…$$` math. Every other diagram type
draws.

react-native-svg parses a drawing's values on the UI thread as it draws, and
throws on one it cannot read, which no error boundary catches: the app dies.
So the sanitiser also keeps every value only in a form its parsers take
(`svgNativeValues.ts`): lengths as `SVGLength` reads them, transforms by its
grammar, path data as its Android parser reads it, text's keywords from its
enums. Anything else is dropped, and a path or polygon whose geometry cannot
be read is dropped whole. Its markers read `orient` as `auto` or a number,
so Mermaid's `auto-start-reverse` (every sequence diagram's arrowheads) is
drawn `auto`, and the starts that use it get a reversed copy of the marker,
as SVG draws them. It turns a fixed angle 180° further than written, so one
is written 180° less, and it draws a marker outside a `defs` where it
stands, so each is put in one.

Each turn's work rests behind one line, as on the desktop: "Worked for 2m 14s
· 12 steps", "Working · 3 steps" while it runs, "Failed after…" or "You
stopped after…", with how many steps went wrong in error ink. Tapping it opens
the turn as it happened: each run of steps, and what the agent said between
them. The agents a turn sent off stay cards of their own under it, the reply
after the last step stays as written, and a picture the agent generated (or
prose that shows one) stays in view. A finished turn that changed files says
how many and the lines in and out ("3 files changed · +42 −7"), from the
desktop's checkpoint summary, and opens them when the desktop kept a
checkpoint; a checkpoint that changed nothing leaves no row. Where a desktop
reports the files a step changed (`fileChanges` on a finished step) and kept
no summary, the count is taken from those: each step once, however often it
is reported, and never from a partial output. A turn whose only steps made
pictures has no fold, as on the desktop.

### A step's output

Tapping a step opens what it produced, read the way its kind reads, as the
desktop's tool rows read it (`toolOutput.ts`, `ToolOutputPanel.tsx`), rather
than the desktop's detail record as JSON. It shows the transcript's preview of
the output (the desktop keeps its first 4,000 characters there) at once, even
offline, and fetches the whole detail (`getToolDetail`) the first time it
opens. A running step shows its output as the transcript brings it and is
fetched only once it finishes, so an open step never freezes on a snapshot.
A fetched detail is kept by chat and step (a step's id is unique only within
its chat), up to 8 MB of text, a write's whole call included, and 200 steps,
least recently opened first to go, so a step scrolled away and back neither
loses its output nor asks again.

- A command is its command line after a `$`, with Copy, then what it printed
  as terminal text on the inset a command's output stands on: colours and bold
  kept in the theme's tones, every other escape dropped, a carriage return
  redrawing its line as a progress bar does. Under it, "exit 1" in the error
  ink, "exit 0" quietly, or "Running…".
- A read is its path and the file's text, unwrapped and scrolled sideways as
  code is, with Claude Code's line numbers in the gutter's quiet ink.
- An edit or a write is its change as diff rows, read from what the step was
  called with as the desktop reads it: a before and an after (three lines of
  context kept beside the change, the middle aligned line by line), several
  edits, a unified patch (the desktop's own parser), a Codex patch, or a whole
  file's new contents, which reads as every line added ("Whole file written").
- A search or a listing is its pattern and where, how many lines it found, and
  the lines; a fetch is its address and the text it brought back; a plan is its
  items, ticked or not.
- Anything else is a compact line of the JSON it was called with, then its
  output. A declined step says so.

A long output shows a slice: a command's last 14 lines, since its end is how
it went, with how many came before; anything else its first 14, with how many
follow. "Show all" draws up to 600 lines, and a line over 1,200 characters is
cut and says how many more it had. Terminal colours are read only in the slice
drawn, from the colour in force where it starts, so a megabyte of log costs a
split and a slice, not a parse. Copy (beside the command, the output or the
panel's heading) copies all of it, escapes removed. Where the desktop cut the
middle of an output to keep it under its limit, the panel says so.

Copy is a glyph, as on the desktop, named for what it copies: "Copy code" in
the header of every code well in a reply (a diagram's and a formula's too),
once its fence has closed; "Copy reply" on a finished turn's footer, which
copies everything the agent said in the turn as the Markdown it wrote, the
words between its steps and the reply after them, a blank line apart, and
never its thinking or its steps; and "Copy message" beside your bubble, your
words exactly as you wrote them. A message of pictures or files alone, or a
turn that said nothing, has none. A copy that lands turns the glyph into a
check and "Copied" for a moment, with a tap of haptics and the word to a
screen reader; one that fails says why in a toast. The clipboard is
`expo-clipboard`, reached only through `src/components/clipboard.ts`; what is
copied is decided in `copyText.ts`. It is a native module, so it needs a
build of the app made after it was added: on an older build Copy says so
rather than the chat failing to open.

What the model thought on its way to a reply (`reasoning_delta`) is a quiet
row of its own, where in the turn it thought it: a bulb, "Thinking" and the
first line of the thought, closed, or "Thinking…" while it is the last thing
the running turn has said. Tapping it opens the thought as Markdown in the
muted ink on the steps' rail. One stretch of thinking is one row however many
deltas it came in; words or a step after it start the next. Thinking before
a turn's last step folds with the turn's work, as its prose does, and the
thinking after it stays in view above the reply. A stretch that never says
anything leaves no row. The thought is never part of a copied reply.

While the provider waits to retry a failed model call (`turn_retrying`), the
working line says why and how far along it is ("Couldn't authenticate ·
retrying (3 of 10)…") until the turn reports anything else or ends, a stop
that names no turn included. A desktop that does not send the event shows the
usual working line.

The chat's composer is New's: one box with the "+" (pictures, where the chat
takes them), the model picker and send, or stop while a reply runs. The access
preset is no longer a chip beside the model; it is the Access row in the model
picker's sheet, as on New and the desktop. The chat and New stand on the
conversation's ground (`agentSurface`, the theme's raised paper); the composer
is one step above it (`composerSurface`) and the person's bubble and a
command's output one step off it (`agentInset`).

The chat's box grows with the words to about six lines and then scrolls
inside. Past that, an expand control sits in the box's top corner and opens
the draft full screen: the same draft, collapse at the top left and the
composer's send (queue, steer and the long press included) at the top right,
clear of the keyboard. Sending collapses it, and so does the system back.
New has none, since its box already takes the screen.

Tucked under the composer, the strip says, on one line that never wraps: the
machine's mark when the chat runs somewhere other than the paired desktop (its
name on a press), the branch in monospace with the worktree's mark before it
when the folder is a worktree, what the chat changed as a split pill ("+42"
green, "−7" red, each half drawn only when it is not zero), and at the right
the chat's pull request and the context ring. The pull request is the
desktop's strip's: "Open PR #42", or "Merged PR #39" once the work went in,
opening it in the browser; a chat whose pull requests all closed unmerged
shows none. It is on the strip and not in the header, as on the desktop,
where a person finishing with a chat looks. The branch and the pill open the changed files: the one turn's
straight away, or a list when several turns changed files. The counts add up
every turn's changes loaded so far. As the line narrows the branch is cut from
the front, whole leading segments first ("…cli-update-output"), then it, the
pill and the machine leave in that order for a "⋮" that lists them, each still
actionable; the pull request and the ring never leave (`composerStripLogic.ts`). The ring fills
clockwise from twelve in the accent, in the warn tone past 80%, and a press
shows "76,000 / 200,000 tokens". It reads `contextWindow` and `contextUsed` off
`usage_updated` (ACP agents send both); without `contextUsed`, the latest
report's input plus output tokens. A desktop that never sends `contextWindow`
shows no ring (`contextUsage.ts`).

The chat's header names the paired desktop it runs on. The tailnet lane does
not yet say when that desktop runs the chat in WSL or on an SSH machine.

A desktop that advertises `conversation-models` lists each chat's CLI and the
models it can switch between, and the composer shows the chat's model by its
friendly name. Tapping it opens New's model picker held to the chat's own
CLI, as the desktop's chat holds its own: the CLI's default and the models
the chat lists, one row per family, each matched by id to the desktop's
picker rows where it advertises `cli-runtime-catalog`, for the window and the
New mark. Picking a window switches to that window's id. A switch never
changes the CLI, and there is no effort ramp: a chat's effort is the one it
was started at, and the wire has no command to change it. The model
moves on screen only once the desktop accepts it. A switch made while a reply
is running says the new model starts with the next message, and a refusal says
why. The control is hidden for a desktop that does not advertise the
capability, a chat with no catalog, and a pairing without conversation
control; a chat whose CLI cannot switch mid-conversation shows its list
read-only, under the desktop's note ("Claude Code · model is set once the
chat starts").

The permission chip names the chat's preset in the desktop's words: Manual,
Auto, Bypass or No flag. A desktop that advertises
`conversation-permission-modes` runs all four, and the sheet offers the ones
the chat's provider lists (New offers the ones the chosen CLI lists). Where
nothing is listed, a preset the CLI's chat cannot run is left out: Manual for
Cursor, which edits without asking. One that
does not runs only Bypass and No flag and reads Manual or Auto as No flag, so
only those two are offered there. A desktop that advertises
`conversation-plans` takes a plan's answer as `resolvePlan`; an older one takes
it as an approval, as before.

A desktop that advertises `conversation-images` serves a chat's pictures over
the tailnet (`GET /tailnet/v1/conversation-image`, with the device token, as
the image upload is authorised). A picture Codex generated shows under its step
without opening it, captioned with its prompt; an image an agent read shows when
its step is opened. Only finished steps are fetched. Tapping a picture opens it
full screen. A picture the desktop no longer has, or one too large to send,
leaves one quiet line saying so, and is not asked for again. A desktop that
does not advertise the capability shows no pictures and no placeholders.

The connection uses a separate conversation WebSocket. The local cache keeps
the transcript with the last sequence and log generation it holds, and a
reconnect sends both back: when the desktop still has that log it replies with
only the missed events, otherwise with a reset snapshot that replaces the
cache. Sequence numbers have gaps by design and are never treated as damage.
Reconnects back off exponentially with jitter and never sooner than the
desktop asks. Losing conversation access stops the stream in a no-access
state, and a revoked phone is sent back to pairing.

Studio holds a pairing to the Tailscale device it was made from and checks
it with `tailscale whois` on every call. A refusal because whois could not
place the phone for a moment (`peer_unverified`) is a pause: the chat says so
and dials again. A refusal because the pairing belongs to another Tailscale
device (`peer_mismatch`, for example after Tailscale was reinstalled on the
phone) stops the chat and asks for a new pairing, without marking the desktop
as having revoked the phone. Only a token the desktop no longer knows is a
revocation.

A chat on a Studio server that restarted (a WSL distribution's, an SSH
machine's, or the desktop's own when it runs out of process) can have a send
refused because the session it went to is gone (`session_not_found`, or the
runtime's "Conversation session is invalid." on the tailnet lane). The phone
offers that send once more under the same command id, and the desktop resumes
the chat from its transcript and sends it there. A second refusal stands. An
answer to a request on a lost session says the request ended with it.

Offline sends retain their command identifiers for idempotent retries; queued
messages can be removed before transmission. A message queued behind a running
turn still goes when the person leaves the chat: the screen hands what it has
unsent to a stream with no screen (`queuedSendCourier.ts`), which offers it as
the turn ends and closes once each message is taken or refused. Opening the
chat again takes them back first. A refused one stays queued, and the chat's
screen shows the desktop's reason when it is next opened. The app being
closed altogether still holds them until the chat is opened. A message over the desktop's size
limit is refused before it is queued, and a send the desktop refuses is shown
as not sent, with the reason, until it is removed. The cache is bounded and
does not store credentials or image bytes.

### A message queued on the desktop

A desktop that advertises `conversation-queued-sends` holds a message queued
behind a running turn itself, and sends it the moment the turn ends, so the
phone may sleep, close or drop off the tailnet meanwhile. Behind a running
turn the phone sends it as `send` with `queue: true`, and the desktop answers
as soon as it holds it. After every subscription's fence, a redial's included,
the phone sends `watchQueued`, and the desktop answers with a `queued` frame
then and whenever what it holds for the chat changes: the whole list each
time, at most twenty, each `{ id, text, createdAt, failure? }`. That list is
the one word on what waits there. The queued bubble draws it entry by entry;
the desktop joins what one turn queued into one message, a line apiece, so
three lines queued read as one entry of three lines. The line under it says
"Queued on the desktop · sends when this turn ends". Between the phone sending
it and the desktop's list naming it, it reads "Queuing on the desktop…" and
offers nothing, since it can only be taken back by the id the list gives it.

Edit takes a held message back (`cancelQueued` with its id) and, only once the
desktop gives it back, puts its words in the composer. The desktop refuses
once the message is on its way into the chat, and the phone shows its reason
("That message is already on its way into the chat."). A held message the chat
refused when its turn came stays in the list with its `failure`, which the
bubble shows in the error ink as "Not sent: …", with Remove (take it back
without sending) beside Edit. A send the desktop will not hold (its twenty are
full, say) is shown as not sent, with the reason, as any refused send is.

Not every message goes to the desktop (`queuedSends.ts`):

- With no turn running a message goes straight into the chat, as before.
- A message with pictures waits on the phone, as before. A held message is its
  words alone (the contract refuses `queue` beside `uploadIds`): an upload is
  staged for the send it was made for and would be gone by the turn the
  message waits on. Keeping the pictures with their words costs the phone-side
  risk of it being lost if the phone sleeps first.
- A message queued while the phone already holds one waits on the phone too:
  the desktop sends what it holds the instant the turn ends, before the phone
  hears of it, and would overtake the phone's earlier message.
- The phone sends no skills, which the contract would refuse beside `queue`.

No message goes twice. A handed-over send is kept in the cache, `queue` and
all, until the desktop answers, so a phone killed in between offers it again
under the same command id, which the desktop holds once. Once the desktop has
answered, it leaves the cache, and neither the screen's stream nor the courier
that carries a closed chat's messages ever offers it again. A desktop that
held a message whose answer was lost with the socket, and has already sent it
by the time the phone redials, holds it no longer, so a repeat would be held
afresh: the phone therefore reads the catch-up first, and a `user_message`
after the point it first offered the message that carries its words as whole
lines settles it as accepted, never offered again (`heldSendLanded`). The point
is kept with the send in the cache (the cursor it was queued at), so a stream
that takes the send over later, the chat reopened, the courier or the app
restarted, reads the chat from there as well. Only the first person's message
after that point can be the held one: the desktop sends what it holds before
anything sent later, and refuses or joins a send made while the turn runs.
Words are not an identity, and this is the trade-off: if the offer never
reached the desktop and that first message happens to carry the same words
(a "yes" typed on the desktop), the phone takes it for delivery and its own
"yes" is not sent. Losing a repeat of words the chat was just sent is the
lesser harm than the agent being told the same thing twice. A desktop
without the capability keeps the phone-held queue exactly as it was; a send
cached as handed over goes to such a desktop (one that lost the capability) as
an ordinary send, held on the phone until the turn ends.

Conversation links use
`sprintengine://conversation/<deviceId>/<workspaceId>/<agentId>`, with each
component URL-encoded. They resolve against an existing paired desktop, never a
server address supplied by the link. The desktop's own chat links,
`sprintengine://chat/<workspaceId>`, optionally with `?agent=<agentId>` (its
row menu's "Copy link to chat"), open on the phone too. They name no desktop,
so the phone reads every paired desktop's chats afresh and looks for the
workspace: where one desktop lists it the chat opens, on that agent's chat when
the link names one the workspace has, else the one last written in; where
several do, the person picks the desktop; where none does it says "That chat
isn't on a desktop you're paired with", and which desktops did not answer. The
link is read with the desktop's strictness (`parseChatLink`, after its
`deep-link.ts`): the scheme and the bare `chat` host in any case, one id of
`[A-Za-z0-9_-]{1,128}`, the one `agent` parameter, any other parameter
ignored. Like the desktop, it only ever navigates. Hosted push delivery is not included in
this client change; it requires notification infrastructure and credentials.

## Verification

Run `npm run ci` and `npx expo export --platform android` for the normal app.
For isolated native screen checks, build with both
`EXPO_PUBLIC_VERIFY_HARNESS=1` and `EXPO_PUBLIC_VERIFY_CONVERSATION=1`. That
fixture renders the real chat screen against a mock API, with tool, question and
plan requests, and two messages queued behind the running turn, held by the
fixture desktop as one entry of two lines (`EXPO_PUBLIC_VERIFY_CONVERSATION=queued-failed`
adds a held message the chat refused, with Remove); `sprintengine://verify/conversation/model` opens it with the
model picker up. Built with `EXPO_PUBLIC_VERIFY_HARNESS=1` alone, the harness
runs the whole app against a fake desktop that advertises the worktree,
effort and catalog capabilities: `sprintengine://verify/new/dev_verify/ws-studio/multicode/MBP-M3`
opens New on a project, and the same link ending `/model` opens it with the
picker up. There, the green row ("Docs: the list's own rules") opens on its
"New" divider the first time it is opened after launch. A desktop's chat link reaches
the harness as `sprintengine://verify/chat/ws-docs` (that same chat, opened
from the link), `…/chat/ws-nowhere` (on no desktop) and
`sprintengine://verify/chat-twins/ws-docs` (on two, to pick from). A reply's
diagrams and math are `sprintengine://verify/chat/ws-rich`: a flowchart, a
sequence diagram, display math in `$$`, `\[ \]` and a `math` fence, inline
`\( \)` as a pill, a `latex` fence and prices and citations that stay as
written, then a broken diagram, one refused for asking for a picture from the
web, and a formula that does not parse, each as source with its note; the
person's message above holds `$$` and a `mermaid` fence of its own, as
typed. `sprintengine://verify/chat/ws-rich-live` replays a reply the first
time it is opened after launch, so its diagram and its sum show as source
until each block's closing line and the line break after it are in, then
draw while the reply is still arriving. Both rest under Earlier.
`sprintengine://verify/chat/ws-notices` holds Studio's two kinds of message,
an agent's news and a usage-limit resume, between the person's, and opens on
"New" above the agent's news; `sprintengine://verify/chat/ws-files` holds a
message with a PDF, a DOCX on a Windows drive, a spreadsheet on a
Windows share and a file of no kind the phone names, each a card under the
bubble. Both rest under Earlier too. Do not distribute the
fixture build as the normal app.

On a paired desktop, separately verify cold conversation resume, permissions,
a model switch (idle and mid-reply), image upload, a generated picture and a read screenshot, interruption, background/foreground reconnect and an offline send
that appears exactly once after acknowledgement. Mock fixtures and transport
regressions do not establish physical-device notification delivery.

### Queue or Steer

While a reply runs, a message can wait for the turn to end (Queue) or go into
the turn now (Steer). Settings ▸ "Steer while an agent works" picks the
default, off (Queue) unless turned on, and a long press on the send does the
other one for that message. The send is drawn as which it will do: the queue
mark or the steer arrow, named "Queue" or "Steer" for a reader, with the long
press in its hint. Stop sits beside it, ghost, whenever words are in the box,
so the reply can be stopped without emptying the box to find the button.

Steer is offered only where it can land (`followUp.ts`): a desktop that
advertises `conversation-steer-sends`, a chat whose listed
`capabilities.steer` is `true` (absent is unknown, and offers nothing), a
turn running, and no pictures. Anywhere else the send queues, the long press
and a Steer default included. A steer goes as `send` with `steer: true` and
its words alone, never beside `queue` or `uploadIds`; it is drawn like any
send, not in the queued bubble. Where the turn cannot take it after all (an
approval is pending, or the turn ended on the way) the desktop holds it as a
queued send, answers with a notice saying so, and its `queued` frame draws it
in the bubble; with no turn left it is an ordinary send. A steer is never lost.
An older desktop does not advertise the capability, and the phone sends it
nothing new.
