# Portable conversation contract

These five TypeScript files are a byte-for-byte mirror of
`packages/conversation-protocol/src/` in SprintEngine Studio. Update both source
trees and their digest assertions together. Do not edit only one mirror or
rewrite the `.js` import specifiers; Metro resolves those locally to `.ts`.

The ordered files are `index.ts`, `presentation.ts`, `tool-types.ts`,
`toolKind.ts`, and `commandLabel.ts`. SHA-256 covers each filename, a NUL byte,
then that file's source bytes, in order. The current digest is
`23e0189b289722112130934fc45ebd234dd5b034e5383263bf69042f061c5722`.

This source mirror does not publish a package. When adopting a published
version, remove the mirror and the narrowly scoped Metro resolver together.
