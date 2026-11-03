# Connection supervisor

`connectionSupervisor.ts` is a byte-for-byte mirror of
`packages/connection-supervisor/src/connectionSupervisor.ts` in SprintEngine
Studio: the one owner of retry, backoff and wake behaviour that the desktop's
SSH machines, its paired machines' change feeds, its web tab and this app's
conversation streams all run. Its behaviour is tested there.

Do not edit only this copy. Change the package's source, copy the file here,
and move the SHA-256 pinned in `connectionSupervisor.regression.test.js` and in
the package's `test/mirror.test.ts` together. The file has no imports, so it
needs no resolver of its own.
