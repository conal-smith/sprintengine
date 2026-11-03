# Connection supervisor

`connectionSupervisor.ts` is a byte-for-byte copy of
`packages/connection-supervisor/src/connectionSupervisor.ts` in SprintEngine
Studio: the one owner of retry, backoff and wake behaviour that the desktop's
SSH machines, its paired machines' change feeds, its web tab and this app's
conversation streams all run. Its behaviour is tested there.

Do not edit only this copy. Change the package's source and copy the file
here; the package's `test/mirror.test.ts` compares the two and fails while they
differ. The file has no imports, so it needs no resolver of its own.
