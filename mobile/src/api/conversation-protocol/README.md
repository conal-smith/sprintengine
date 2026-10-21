# Portable conversation contract

These five TypeScript files are a byte-for-byte mirror of
`packages/conversation-protocol/src/` in SprintEngine Studio. Update both source
trees and their digest assertions together. Do not edit only one mirror or
rewrite the `.js` import specifiers; Metro resolves those locally to `.ts`.

The ordered files are `index.ts`, `presentation.ts`, `tool-types.ts`,
`toolKind.ts`, and `commandLabel.ts`. SHA-256 covers each filename, a NUL byte,
then that file's source bytes, in order. The current digest is
`a1313dd4c44024e14956b1fb461ca30d0d65851ec28162453ffa888af66c5c3c`.

This source mirror does not publish a package. When adopting a published
version, remove the mirror and the narrowly scoped Metro resolver together.
