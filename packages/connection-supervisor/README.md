# @sprintengine/connection-supervisor

One owner for a connection that has to stay up, shared by every part of
SprintEngine Studio that keeps one: an SSH machine's session, a paired
machine's change feed, a web tab's socket and the phone app's conversation
stream. It is private to this repository and not published.

- **An explicit state machine**: `idle`, `connecting`, `up`, `backoff`,
  `waiting-for-wake`, `needs-sign-in`, `failed`, `stopped`, observable through
  `state()` and `subscribe()` so a view can say which one it is in.
- **Retries that never give up**: jittered exponential backoff up to a cap,
  forgotten only after a connection stays up, and counted in time spent
  trying, so a computer asleep for a day wakes up still trying.
- **Wake without teardown**: a wake pings a live connection and keeps it when it
  answers, replaces it at once when it does not, and cuts a backoff short.
- **What needs a person waits for one**: a refused credential or a failure
  retrying cannot fix stops retrying until `retryNow()`.

The transport supplies one attempt (`connect`), a way to end a connection
(`close`) and, optionally, a liveness check (`ping`) and a reading of its
failures (`classify`). The clock, timers and randomness are injectable, which is
how the tests drive it.

`src/connectionSupervisor.ts` is one file with no imports, so the desktop's main
process, the renderer and the phone app all run the same source. The phone app
cannot import this package and keeps a byte-for-byte copy in
`mobile/src/shared/connection-supervisor/`; a digest pinned on both sides fails
the build when the two differ. Change both together.
