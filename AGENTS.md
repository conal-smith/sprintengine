# Agent instructions — SprintEngine Studio

`CONTRIBUTING.md` is the contract: how to run the app, which gates have to be
green, and how commit messages are written. Read it before you open a pull
request. Three of its rules are repeated here because they are broken while a
comment is being typed, not at review time.

## No competitor product names

Not in comments, not in test names, not in assertion messages, not in a
`component.md`. This repository was private for most of its life and its
comments carry honest notes about where an idea came from; in a public repo the
same sentences read as running commentary on another product, and the ones
citing another product's internal identifiers read worse than that.

**Rewrite, never delete.** A comment exists to explain why the code is shaped
the way it is, and that reason always survives without the name. Turn "⌘⇧M
toggles the model picker (X's `modelPicker.toggle`, adopted)" into a sentence
about why the chord sits on that key. Keep a ruling's date —
`(owner ruling 2026-09-10)` is useful; the clause naming whose launcher prompted
it is not. Deleting the sentence and leaving an unexplained constant behind
loses the only part that was worth keeping.

The agent CLIs the app drives — Claude Code, Codex, Cursor, OpenCode, Gemini,
Grok — are runtimes it integrates with, not competitors. Name them freely.

## No backlog ticket numbers in the tree

The backlog is private to the machine it lives on, so `(MC-2183)` in a comment
is a link nobody outside can follow. Say what the ticket changed instead — "since
workspace creation moved to main", not "since MC-2158" — or leave it out when
the sentence stands without it. A backlog key as data (a fixture's `MC-240`, an
example of the id format) is fine.

## No real identities in fixtures

A fixture needs a plausible value, not a true one. Use the placeholders the tree
already uses: `/Users/dev/…` and `/Users/me/…` for home paths,
`tail1234.ts.net` and `example.ts.net` for tailnets, `mac-mini` /
`dev-macbook-air` / `android-phone` / `build-box` for machines,
`dev@example.com` for an address, `acme` for an org. Never a real machine name,
tailnet id, email, account handle, or absolute path out of someone's home
directory — including in a doc comment that uses one as a worked example, where
the example is the point and the machine is not.

Nothing here is enforced by a lint. It is checked when the change is reviewed.

## Generated files

`design-system/catalog/index.html` and `design-system/foundations/tokens.css`
are built, not edited. Change the `component.md` or the token source and rebuild
with `node design-system/scripts/build-catalog.mjs`. A hand-edit survives review
looking correct and is silently reverted by the next build.

## No status dots

The app draws no status dots (owner ruling 2026-09-28). A small disc has no
shape, so "working", "waiting" and "failed" read alike. Say a state with a
word, a lifecycle glyph, a timer, or the working mark (`ui/WorkingMark.tsx`).
An agent a conversation spawned is drawn as its model's or provider's icon
(`agentChat/subagentIcon.tsx`), beside words that say how it is doing.
The one exception is an MCP server's connection state in the composer's Skills
& MCPs picker (owner ruling 2026-10-09): a dot beside the server's name, with the
state's word as its accessible name and tooltip
(`agentComposer/SkillsAndMcpsPicker.tsx`). It does not license a dot anywhere
else.
`StatusDot` keeps its name because modules import it, but it draws shapes; a
`rounded-full` bullet added somewhere else is the same dot by another name.
