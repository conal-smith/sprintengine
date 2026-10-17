# Recording the browser pane to video

Status: proposed with its implementation, 2026-10-04. Local and WSL
workspaces are built; SSH workspaces and whole-screen recording are follow-ups
(sections 6 and 9). When code and this file disagree, fix one of them in the
same change.

## 1. What is being built

Two tools in the desktop's `browser` toolset:

- `browser.record_start { maxSeconds?, cursor?, tabId?, workspaceId? }` starts
  recording a pane tab to a WebM video, with the agent's cursor drawn in.
- `browser.record_stop { tabId?, workspaceId? }` stops it, saves it, and
  answers where the file is, how long it is, how big it is and why it stopped.

A recording is the tab as the person sees it: the same guest the agent drives,
not a headless copy. It lands in the project's store in the person's home, at
`~/.sprintengine/workspaces/<project>/browser/recordings/recording-<host>-<stamp>.webm`
(`src/main/workspace-store.ts`), never in the project's folder. A chat in a
worktree (every New chat leases one from the worktree pool) records into the
same store as the checkout it was cut from: a pool slot is reused by the next
chat and removed over the pool's limits, so a video kept with it would linger
under another chat or go with the slot. The answer gives the file's absolute
`path`, which the agent opens with its own file tools; nothing large crosses
the MCP connection.

While it runs, the tab's toolbar says **Recording 0:12**, with a Stop button.

## 2. Where the browser is, and where the agent is

The browser is always on the client: the desktop app. The Studio server has no
browser by owner ruling (studio-server.md, section 1.1, ruling f). The pane is
an Electron `<webview>` in a workspace window, and main drives it. The
`browser.*` tools are a toolset the desktop's shell offers to the server, which
routes agents' calls to it (phase 5).

| Mode                                          | The agent and its MCP gateway                  | The browser                     | Who can capture frames     | Where the agent's workspace is           |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------- | -------------------------- | ---------------------------------------- |
| Desktop, server in process                    | This computer, gateway in Electron main        | Desktop pane                    | The window hosting the tab | This computer                            |
| Desktop, server out of process                | This computer, the local server's gateway      | Desktop pane, via the shell     | The window hosting the tab | This computer                            |
| Desktop, a WSL server                         | Inside the distribution, that server's gateway | Desktop pane, relayed (phase 7) | The window hosting the tab | The distribution, reachable as `\\wsl…\` |
| Desktop, an SSH machine (preview)             | The remote machine, that server's gateway      | Desktop pane, relayed (phase 8) | The window hosting the tab | The remote machine only                  |
| Web client only                               | The server's machine                           | None: a tab cannot drive a page | Nobody                     | The server's machine                     |
| Nobody attached (a scheduled agent, the tray) | The server's machine                           | None                            | Nobody                     | The server's machine                     |

So capture is always possible where the pane is, and the only question that
changes by mode is how the file reaches the agent.

### 2.1 Getting the file to the agent

A video cannot come back inline. The gateway's lines are capped at 1 MiB, a
client tool's reply at 960 KiB (phase 5, 4.6), and a minute of video is about
10 MB. Chunking it through a "read the next piece" tool would not help either:
a tool result goes into the model's context, so an agent that fetched a video
that way would read megabytes of base64 and still have no file. The file has
to be written where the agent runs, and the agent told its path.

That is what the phase 5 spec already says a large result should be: "a
reference (a file it wrote through `files.*`, or a URL) and a summary".

- **This computer.** The desktop writes into the workspace directly.
- **WSL.** The desktop writes through the `\\wsl.localhost\<distro>\…` path it
  already opens the workspace by (the pane's screenshots do the same). The
  agent in the distribution reads the same folder; the answer gives the file
  relative to the workspace and as a Linux path.
- **An SSH machine.** Nothing on the desktop can write a file into a folder on
  the machine yet: its server takes reads over the backend wire, and
  `files.write` writes canvas boards only, under roots its own (empty)
  workspace registry knows. A recording kept on the desktop would be a path the
  agent cannot open. So `browser.record_start` answers
  `recording_unavailable` for such a workspace, naming the machine, before
  anything is captured. Section 6 is the design that lifts it.
- **The web client.** It offers no `browser` toolset, so there is nothing to
  record and the tools are not listed (or answer `client_unavailable` to an
  agent that saw them earlier).

## 3. Capturing frames

| Way                                                                                                  | Debugger              | With DevTools open | Tab hidden             | Cost                                                       | Fidelity                   |
| ---------------------------------------------------------------------------------------------------- | --------------------- | ------------------ | ---------------------- | ---------------------------------------------------------- | -------------------------- |
| DevTools protocol screencast (`Page.startScreencast`)                                                | Needs the one session | Stops              | No frames              | JPEG per frame through main, decoded and encoded again     | Lossy twice                |
| `webContents.beginFrameSubscription`                                                                 | No                    | Works              | No frames              | A full bitmap per frame through main's heap (tens of MB/s) | Exact, scaled in main      |
| Screen or window capture (`desktopCapturer`)                                                         | No                    | Works              | Records what covers it | OS screen-recording permission, a restart on macOS         | Whatever is on screen      |
| **Tab capture of the guest** (`getDisplayMedia` in the host window, answered with the guest's frame) | **No**                | **Works**          | No frames              | **GPU path, nothing through main until encoded**           | **The guest's own frames** |

The chosen way: main installs a display-media handler on the host window's
session that answers exactly one armed request (from the main frame of the
window hosting the tab, within five seconds) with the guest's `WebFrameMain`.
Every other `getDisplayMedia` in that session is refused, as it was before
there was a handler. No screen-recording permission is involved: Chromium
captures a WebContents, not the screen.

Verified in Electron 44 against a `<webview>` guest: about 30 frames a second,
in a window that is never shown, and unaffected by DevTools opening on the
guest mid-recording. The older `getMediaSourceId` with a `chromeMediaSource:
'tab'` constraint still returns a stream but delivers one frame and no more, so
it is not used.

A guest that is hidden (`display: none`, the pane collapsed) produces no
frames, and nor does one that does not repaint. The video then holds its last
frame. `browser.record_start` brings the pane forward on the recorded tab for
this reason, and its description says so.

## 4. Encoding

MediaRecorder, in the window hosting the tab, to WebM: VP9, else VP8. It is in
every Electron build, needs no dependency and no binary, and hands over a
chunk a second, which main appends to the file as it comes.

- **No ffmpeg.** Bundling one adds tens of megabytes and a binary per platform;
  shelling out to one assumes it is installed.
- **No JavaScript muxer.** The small MIT WebM muxer is deprecated in favour of
  a larger MPL-2.0 library. WebCodecs plus a muxer would buy keyframe control
  this does not need.
- **Not MP4.** MediaRecorder's H.264 depends on the platform's encoder, and an
  MP4 recorded across a viewport resize is known to break; VP9 in WebM takes a
  resize.

MediaRecorder writes WebM as a live stream, with no length in its header, so
players show it as unbounded and most will not seek. When a recording ends,
`webm-duration.ts` writes its length into the Segment Info (an 11-byte EBML
edit; nothing else in a live file holds an offset it moves). Verified: the
saved file reports its duration and seeks.

Defaults: 30 fps, the longer edge at most 1280 px, 1.5 Mbit/s, which keeps five
minutes of screen content under the 60 MB cap.

## 5. The cursor

The agent's cursor is the host window's overlay (`AgentBrowserCursor.tsx`), not
part of the guest, so a capture of the guest does not have it. It is drawn
into the recording from the same pointer events the overlay draws from: each
frame goes onto a canvas, the arrow (the overlay's own path and tokens) and a
click's ring are drawn over it, and the canvas is a track again for
MediaRecorder (Chromium's track processor and generator). While the cursor
moves or fades on a page that does not repaint, the last frame is drawn again
with it.

To place it, a pointer event now carries the guest viewport's CSS size, read in
the same page evaluation that found the point (`browser-control.ts`). A
recording can turn `cursor` off.

Capturing the host pane instead (cursor included) was rejected: it would also
record whatever app UI covers the pane, a popover or a toast, and nothing at
all once the person switches workspace.

Captions and annotations are not built.

## 6. SSH machines: the follow-up

What is missing is a way for a client tool to hand a file to the agent's own
machine. The design that fits the architecture is the server writing it, one
hop at a time, so each server only ever writes its own disk:

1. A client running a call stages bytes on the connection the call came on
   (`uploads.begin { purpose: 'artifact' }`, the chunked upload that exists
   for pictures and board files) and names them in its reply.
2. The server that routed the call writes them into the calling conversation's
   workspace sidecar. It resolves the folder from the conversation's own live
   root, not its workspace registry (an SSH machine's is empty), and rewrites
   the reply's reference into a workspace path before the agent sees it.
3. A relayed call (the desktop's local server forwarding to an SSH machine's
   server) does the same at each hop: the relay is the client of the remote
   server, so it re-stages the bytes it received there.

It is a change to the published Studio protocol (a capability flag, the
compatibility policy in `docs/compatibility.md`), to the SDK, the client-tool
registry and the relay, and it serves any client tool that produces a file
(the canvas's exports, a future screenshot to disk), not only recordings. That
makes it its own change with its own review, and an owner decision.

## 7. Lifecycle and safety

- **One recording per tab, two at once.** Each one encodes video on this
  machine. A second start on the tab answers `already_recording`; a third tab,
  `busy`.
- **Limits.** `maxSeconds` defaults to 60 and stops at 300. A recording that
  reaches 60 MB stops there. Each ends by itself and is saved.
- **Who may stop it.** The agent (or device, or connection) that started it,
  and the person. Another agent gets `not_yours`.
- **What ends it, saved with why:** the agent's stop (`stopped`), the person's
  Stop (`stopped_by_person`), `max_duration`, `max_bytes`, the tab or its
  window closing (`tab_closed`, `capture_ended`), and quitting (`app_quit`, a
  shutdown leg before the windows close). A recording that captured nothing
  leaves no file. A result is kept for half an hour, so an agent whose
  recording ended at a limit gets it from `browser.record_stop` the same way.
- **Navigation does not end it.** A recording is usually of a flow across
  pages (sign in, then the dashboard), which stopping on navigation would cut
  in two. The person is shown the recording throughout and can stop it.
- **The person always knows.** The tab's state carries the recording; the
  toolbar shows the word, a running clock and Stop, never a dot (AGENTS.md).
  `browser.status` lists it on the tab.
- **Mutations.** Both tools are in `BROWSER_MUTATION_TOOL_NAMES`: they capture
  the person's page and write into their workspace, so they are audited and
  need the operate scope from a paired device.
- **Deadlines.** `record_start` has the browser default of 20 s (capture has
  10 s to begin); `record_stop` has 60 s, for the last second of video and a
  file of up to 60 MB.
- **Files.** `browser/recordings/` in the project's store, written as
  `<name>.webm.part` while recording and renamed when it ends.

## 8. Where the code is

| Part                                              | File                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| The two tools                                     | `src/main/automation/browser-tools.ts`                                   |
| Lifecycle, limits, stop reasons (Electron-free)   | `src/main/browser/browser-recorder.ts`                                   |
| The file in the store, and the SSH refusal        | `src/main/browser/recording-output.ts`                                   |
| The display-media grant and the window's messages | `src/main/browser/recording-encoder.ts`                                  |
| The length in the header                          | `src/main/browser/webm-duration.ts`                                      |
| Capture, cursor, MediaRecorder                    | `src/renderer/src/components/workspace/pane/browser/browserRecording.ts` |
| A tab's side of it, and the toolbar indicator     | `useTabRecording.ts`, `BrowserRecordingIndicator.tsx` beside it          |

The encoder and the output are interfaces, so the lifecycle is tested with
both stood in for, and the window's pipeline with the capture stood in for.

## 9. Recording the whole screen: not built

Recording outside the pane (another app, the whole desktop) is a different
thing to grant an agent, and is left out:

- **Permission.** macOS gates it behind Screen Recording in Privacy & Security
  (`systemPreferences.getMediaAccessStatus('screen')`). The grant cannot be
  requested in-app beyond opening Settings, and takes effect only after the
  app restarts. Windows and Linux (X11) grant it silently; Wayland goes
  through a portal picker every time.
- **Privacy.** Everything on screen is in it: other apps, notifications,
  passwords being typed. An agent should not be able to start that on its own.
- **The design if it is wanted:** a `screen.record_start` that always asks the
  person, through the system picker where there is one
  (`setDisplayMediaRequestHandler` with `useSystemPicker` on macOS 15 and
  later) or Studio's own picker over `desktopCapturer.getSources` elsewhere,
  then runs through the same encoder, output and indicator as a tab, with the
  indicator in the window chrome rather than a pane. The entitlements file
  needs nothing new; the signing does not change.

## 10. Testing it by hand

1. In a workspace on this computer, open a browser tab on a page, and in a
   chat ask the agent to record it while it clicks through something
   (`browser.record_start`, a few `browser.click`s, `browser.record_stop`).
2. The toolbar shows **Recording** with a clock while it runs; the answer to
   the stop names `~/.sprintengine/workspaces/<project>/browser/recordings/….webm`. Open the file:
   it plays, shows its length, seeks, and the agent's cursor and click rings
   are in it.
3. Start one and press the toolbar's Stop: the agent's `browser.record_stop`
   answers the saved file with `stopped_by_person`.
4. Start one with `maxSeconds: 5` and wait: it stops by itself.
5. Open DevTools on the tab while it records: the recording carries on.
6. In an SSH machine's workspace (preview on): `browser.record_start` answers
   `recording_unavailable`, naming the machine, and nothing is recorded.
