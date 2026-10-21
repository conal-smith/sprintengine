// The hosted card feed: `cards-feed.json` at the root of the public
// sprintengine/studio-releases repo, built by CI from the one-directory-per-card
// repository, fetched raw by every running studio and rendered as the Extensions
// home page. It is how a card reaches every install without an app release
// (backlog/2026-09-06-the-card-feed-is-a-hosted-file.md, item 2465).
//
// A card travels as data and never as code. It carries copy, the *name* of an
// artwork this build already ships, and an ordered list of actions drawn from a
// closed vocabulary of verbs the studio already implements. A card may name an
// action; it may not bring one. That is why there is no exec verb, no verb that
// writes a file, and no field anywhere below that holds a URL.
//
// **What a press of `Go` can actually cause is written down**, because the
// composition is larger than any one verb and because nothing but our own CI
// and our own authorship stands in front of it (R4a, owner, 2026-09-06):
// `CARD_CLONE_OWNERS` below. Read its note before you widen
// anything below — it also carries the list of conditions under which R4a must
// be revisited rather than inherited. This file used to say the blast radius of
// a hostile feed was "the one the plugin catalogue already has"; that is true
// about the ARTEFACT and false about the ceremony, since the plugin catalogue
// has a person choosing to install and a card deliberately does not.
//
// Node-free on purpose: `src/shared` cannot import `src/main` (TS6307). The
// fetcher, cache, and seed live in src/main/hosted-feed/card-feed-client.ts.
//
// The schema is a permanent contract: builds that are years old will keep
// reading it. Add fields; never remove or repurpose one. A body whose
// `schemaVersion` is not one this build knows is rejected whole and the client
// keeps its last good copy — but a single malformed card is dropped and
// counted, because one bad row must never blank the home page.

import { isRecord } from './records'

export const HOSTED_CARD_FEED_SCHEMA_VERSION = 1 as const

export const HOSTED_CARD_FEED_URL =
  'https://raw.githubusercontent.com/sprintengine/studio-releases/main/cards-feed.json'

// What the card is, which is also the word on its stamp. Not a taxonomy to
// filter by — the home page is marketing, not a catalogue — but the renderer
// needs to know whether it is showing an MCP server or a showcase.
//
// `automation` was a kind until automations became scheduled agents
// (2026-09-30): a card of that kind named something this build no longer has,
// so it is dropped and counted like any other kind a build does not know.
export type HostedCardKind = 'mcp' | 'skill' | 'plugin' | 'showcase'

const CARD_KINDS: readonly HostedCardKind[] = ['mcp', 'skill', 'plugin', 'showcase']

// The doors a card may open. `plugins` and `skills` are VIEWS OF THE EXTENSIONS
// DOOR — exactly `EXTENSIONS_DRAWER_VIEWS` in the renderer's
// extensionsSurfaceTarget.ts — and `home` is the card feed's own page beside
// them. The renderer latches the view and then opens the door.
//
// `agent-clis` named a third view until the owner moved agent CLIs to Settings ▸
// Agents (2026-09-25). It stays in the union because the union is a permanent
// contract and published cards still name it: the renderer now opens Settings ▸
// Agents on this machine for it, which is where that view's list went.
//
// The rule is the wide one: **every door the app has, whether or not it lives
// under Extensions**, may be named here. Adding one is additive and safe,
// because a build that does not know a view drops the card and counts it rather
// than opening nothing.
//
// Restated here rather than imported because src/shared may not reach into the
// renderer. Added to, never renamed: this union is a permanent contract.
export type CardSurfaceView = 'home' | 'plugins' | 'skills' | 'agent-clis'

const CARD_SURFACE_VIEWS: readonly CardSurfaceView[] = ['home', 'plugins', 'skills', 'agent-clis']

// The closed verb set, and it is closed against the call sites rather than
// against an imagination of them. The first cut of this union carried thirteen
// verbs, nine of which no installer in this repository could execute:
// `add.source`, `seed.backlog`, `create.workflow`,
// `create.automation` and `design.import` named nothing, and the four that
// remained were shaped wrong — `install.mcp` carried a source the catalogue does
// not have, `clone.repo` a `ref` git-clone does not take, `open.chat` one
// attachment list where the composer keeps two, and `open.surface` a
// surface/tab pair the door stopped speaking in September. A schema is a
// permanent forward-compatible contract, so shipping a fictional vocabulary is
// worse than shipping a small true one: adding a verb later is cheap and
// additive, while un-shipping one is a breaking change to every build in the
// field. Each verb below is a call this repository already makes.
//
// **No action carries a workspace, deliberately.** A card runs in the workspace
// the person is already in, and the executor supplies it — a card that could
// name a workspace could reach into a project the person was not looking at.
// `clone.repo` is the one verb that makes a new one, and everything after it in
// the same card runs in that.
export type CardAction =
  // Make sure an agent CLI is there — and say which one is missing rather than
  // installing it. Installing a CLI runs a shell command on the person's
  // machine, and `CliInstallMethodInfo` exists so that command is shown before
  // anybody consents to it; a card may not answer that disclosure on somebody's
  // behalf, so the executor refuses and points at Settings → Agents — the app's
  // one install route (and see `openChat`'s neighbour in
  // src/main/cards/run-card.ts for why a card's refusal names it rather than the
  // Agent CLIs view the card is standing in). This comment said "and install it
  // if not" until 2026-09-06, which described behaviour the executor
  // deliberately does not have. `cli` is a plugin id under `resources/plugins/`
  // (`claude-code`, `codex`), never a vendor name or a binary path.
  | { verb: 'require.cli'; cli: string }
  // An MCP server by its id. The bundled catalogue this used to resolve against
  // was retired with the third-party ruling (2026-09-08) — sixteen
  // servers nobody here wrote — and no bundled list replaced it: an MCP server
  // arrives inside a plugin now, which `install.plugin` installs. The verb stays
  // in the schema because it is a published contract every build in the field
  // parses, but the executor can only honour an id the workspace already holds
  // in its MCP settings; any other id is refused by name
  // (`src/main/cards/run-card.ts`).
  | { verb: 'install.mcp'; id: string }
  // A skill and a plugin each name a source the app already holds and an id
  // within it. `source` is a source id as src/shared/skills.ts mints them:
  // `github:owner/name` or `local:<absolute path>` — `builtin` is gone. For a
  // skill, `id` is a `ScannedSkill.id`, which is the skill directory's path
  // relative to its source (`skills/engineering/prototype`).
  | { verb: 'install.skill'; source: string; id: string }
  // For a plugin, `id` is the plugin's name in its source's marketplace
  // manifest. The card carries nothing else: `installPlugin` also wants
  // `marketplaceName`, `marketplaceRepo` and `commitSha`, and the executor
  // resolves all three from that source's scan at run time. A card that carried
  // them would be carrying facts that go stale the moment the marketplace is
  // republished, and a stale commitSha installs the wrong bytes.
  | { verb: 'install.plugin'; source: string; id: string }
  // A capability module from the app's OWN signed marketplace registry — the
  // one `readMarketplaceRegistry` reads, not a Claude marketplace a source
  // points at. `id` is the registry entry's id, and the executor resolves it
  // there before anything is downloaded.
  //
  // It carries no `source` for the reason `install.plugin` carries one: there
  // is exactly one registry, it ships with the app, and a card that could name
  // another would be a card choosing where this machine's code comes from.
  //
  // A module is code that runs in-process, so the executor honours this verb
  // ONLY for a `verified` entry — signed by a publisher in
  // `trusted-publishers.json`. Everything else needs the trust prompt, which is
  // a disclosure a person reads and answers; R4's "Go goes" removes the card's
  // own ceremony and does not repeal somebody else's gate (the same rule
  // `require.cli` follows). Such a card is refused by name, pointing at
  // Extensions → Plugins where the disclosure lives.
  | { verb: 'install.module'; id: string }
  // Open a chat with the named tools attached and the prompt sent. Two lists and
  // not one because the composer draft keeps them apart (newChatDraft.ts:
  // `skills: WorkspaceSkill[]` beside `mcpServers: AgentComposerConnector[]`),
  // and a flat list could not say which an entry was. `skills` names installed
  // skills by directory name — a `WorkspaceSkill.id`; `mcpServers` names
  // MCP server ids. `send` is required rather than optional: R4 is "Go goes", and
  // an unstated `send` leaves the reader guessing whether the card meant to park
  // its prompt in the composer for somebody to approve.
  //
  // **`mcpServers` is an assertion, not an attachment** — read this before you
  // write one (2026-09-06,
  // backlog/2026-09-06-the-seams-that-lead-nowhere.md §2). Listing a server here
  // does not put it on the chat: the executor's `openChat`
  // (src/main/cards/run-card.ts) deliberately carries nothing across, because
  // the card's servers reach the chat by already being in the workspace's
  // `.mcp.json`, which the `install.mcp` earlier in the same card wrote on the
  // way past. What the field does is bound what the card may CLAIM —
  // `refuseCardActions` below refuses a card whose chat names a server the card
  // does not install itself — so it is the place a card states its own
  // dependency and is held to it, not a way to reach a server it never
  // installed. `skills` is the opposite shape and that asymmetry is real: the
  // renderer attaches skills by name because a chip in the composer is the only
  // way a skill shows up, while an MCP server is already there in the file.
  //
  // Kept rather than deleted for the reason at the head of this file: the schema
  // is a permanent contract, and a field years-old builds parse cannot be
  // withdrawn just because the executor stopped forwarding it.
  | { verb: 'open.chat'; prompt: string; skills?: string[]; mcpServers?: string[]; send: boolean }
  // A door, on one of the Extensions views. Mirrors `ExtensionsSurfaceTarget`
  // exactly: a view, and optionally its Installed tab. The pair it replaces
  // (`surface` + `tab`) was the vocabulary of a surface that no longer exists.
  | { verb: 'open.surface'; view: CardSurfaceView; installed?: boolean }
  // Clone a public GitHub repository and open it. `repo` is `owner/name`: a card
  // names a repository, never a URL, so no card can point git at a host of its
  // choosing, and the owner must be one of `CARD_CLONE_OWNERS` below.
  // `folderName` is the single directory name to clone into, and the executor
  // supplies `parentDir` — where this app keeps projects is the app's business,
  // not a card's. There is no `ref`: the clone takes a branch now, but a
  // schema field is a permanent contract, and no card has needed anything but
  // the default branch — it is added when one does, not before.
  | { verb: 'clone.repo'; repo: string; folderName?: string }

export type CardActionVerb = CardAction['verb']

/**
 * The GitHub owners a card may clone from — the one rule in this file that
 * names us rather than the schema, and the one defence a card feed has that
 * does not run in CI.
 *
 * `clone.repo` is the outlier among the verbs. Every other id a card carries is
 * resolved against something this build already holds: a CLI against the
 * registered agent-CLI plugin ids, a server against the workspace's own MCP
 * settings,
 * a skill or a plugin against that source's own scan, a view against the four
 * `CARD_SURFACE_VIEWS`. A repository was resolved against nothing. The only
 * test applied to it was its SHAPE, and `owner/name` is a shape every public
 * repository on GitHub has — so `run-card.ts`'s claim that "every id is
 * resolved against something this app already holds" had two exceptions, not
 * one: that file already qualifies itself for `open.chat`'s prompt, and this
 * was the other.
 *
 * What that bought a card is the largest step in the chain a single press can
 * execute. A clone becomes the workspace every later action installs into AND
 * the workspace the chat opens in, and that chat launches on the person's
 * remembered permission preset, whose app-wide default is `bypass`
 * (`DEFAULT_AGENT_SPAWN_PERMISSION_PRESET`, owner, 2026-07-26). A repository we
 * did not publish carries `CLAUDE.md`, `.claude/`, `.mcp.json` and agent
 * definitions that the harness reads when it starts — so an unbounded
 * `clone.repo` was a way to put somebody else's instructions in front of an
 * agent running without permission checks, from one press of a button and with
 * no dialog anywhere on the path, which is exactly what R4a rules there must
 * not be.
 *
 * `scripts/check-card-feed-seed.mjs` has refused a non-`sprintengine` clone in
 * the bundled seed since it was written, and said in its own comment that "a
 * card can name any public repository once the feed is hosted". That asymmetry
 * is closed here rather than merely stated (2026-09-06,
 * backlog/2026-09-06-the-only-gate-is-our-own-ci.md), because the seed gate is
 * CI and CI never reads the hosted file: `check-card-feed-seed.mjs` opens
 * `resources/cards-feed.json` and nothing else, so every rule it enforces stops
 * at the artefact that ships in the installer. This rule ships INSIDE the app,
 * which is what makes it hold for the hosted feed too — at both boundaries
 * `parseCardAction` is called from, the feed parse in main and the `cards:run`
 * re-parse in `src/main/ipc/cards-ipc.ts`.
 *
 * The cost, stated so the next person does not discover it: widening this list
 * is an app release, and until every build in the field has it, a card cloning
 * the new owner is dropped — silently, because R6 says the page never
 * apologises for its own network. That is the same operational shape as adding
 * a verb, which this schema already lives with, and it is the reason the list is
 * an array rather than a single constant. GitHub owners are case-insensitive,
 * so the comparison is too.
 */
const CARD_CLONE_OWNERS: readonly string[] = ['sprintengine']

export type HostedCard = {
  // Stable for the life of the card: the directory name in the cards repo, and
  // the key the renderer counts a press against.
  slug: string
  kind: HostedCardKind
  // A capability in the second person, never a product name — "Let an agent
  // drive your browser", not "Playwright MCP server" (epic ruling R2).
  title: string
  dek: string
  // The quiet line under the dek: what it is built on, in words a person
  // recognises. Optional because a showcase often has nothing to credit.
  credit?: string
  // The NAME of an artwork this build ships ('browser', 'city', 'tokens'),
  // never a URL. A card with no picture is not a card, so this is required and
  // a row without it is dropped.
  art: string
  // ISO date the card was published. The home page orders by it.
  publishedAt: string
  // The one full-bleed card at the top of the page. More than one is allowed by
  // the schema; which of them leads is the renderer's business.
  hero?: boolean
  // What Go does, in order. An empty list is legal — a showcase card can be
  // pure marketing — so it is not a reason to drop the row.
  go: CardAction[]
}

export type HostedCardFeed = {
  schemaVersion: typeof HOSTED_CARD_FEED_SCHEMA_VERSION
  // Bumped on every edit. The tie-break between a bundled seed and a disk
  // cache: whichever was edited later wins, regardless of when it was fetched.
  updatedAt: string
  cards: HostedCard[]
}

export type HostedCardFeedParseResult =
  | {
      ok: true
      feed: HostedCardFeed
      // How many rows were dropped for failing their own shape, and why. The
      // feed still renders; the count is what a diagnostic line reports.
      dropped: number
      dropReasons: string[]
    }
  | { ok: false; message: string }

export function parseHostedCardFeed(source: unknown): HostedCardFeedParseResult {
  let value: unknown = source
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source)
    } catch (error) {
      return { ok: false, message: `Card feed is not valid JSON. ${formatError(error)}` }
    }
  }
  if (!isRecord(value)) return { ok: false, message: 'Card feed must be a JSON object.' }
  if (value.schemaVersion !== HOSTED_CARD_FEED_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `Card feed schemaVersion ${JSON.stringify(value.schemaVersion)} is not one this build reads (${HOSTED_CARD_FEED_SCHEMA_VERSION}).`,
    }
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    return { ok: false, message: 'Card feed updatedAt must be an ISO date-time.' }
  }
  if (!Array.isArray(value.cards)) return { ok: false, message: 'Card feed cards must be an array.' }

  const cards: HostedCard[] = []
  const dropReasons: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.cards.entries()) {
    const parsed = parseCard(raw)
    if (!parsed.ok) {
      dropReasons.push(`cards[${index}]: ${parsed.message}`)
      continue
    }
    // A duplicate slug is a mistake in the cards repo, not a reason to blank
    // the page: the first one wins and the second is dropped like any other
    // bad row.
    if (seen.has(parsed.card.slug)) {
      dropReasons.push(`cards[${index}]: duplicate slug "${parsed.card.slug}".`)
      continue
    }
    seen.add(parsed.card.slug)
    cards.push(parsed.card)
  }
  return {
    ok: true,
    feed: { schemaVersion: HOSTED_CARD_FEED_SCHEMA_VERSION, updatedAt: value.updatedAt, cards },
    dropped: dropReasons.length,
    dropReasons,
  }
}

// Every field is copied out of the input, never referenced into it: the result
// shares no object or array with the body it was parsed from, so a caller that
// mutates a card cannot reach back into the cache or the response.
function parseCard(raw: unknown): { ok: true; card: HostedCard } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'row must be an object.' }
  const slug = text(raw.slug)
  if (!slug) return { ok: false, message: 'slug must be a non-empty string.' }
  const kind = text(raw.kind)
  if (!kind || !CARD_KINDS.includes(kind as HostedCardKind)) {
    return { ok: false, message: `"${slug}" has kind ${JSON.stringify(raw.kind)}, which is not one this build knows.` }
  }
  const title = text(raw.title)
  if (!title) return { ok: false, message: `"${slug}" has no title.` }
  const dek = text(raw.dek)
  if (!dek) return { ok: false, message: `"${slug}" has no dek.` }
  const art = text(raw.art)
  // Artwork is a name the app ships. Anything with a scheme or a slash is
  // somebody trying to serve a picture from their own host.
  if (!art || /[:/\\]/.test(art)) {
    return { ok: false, message: `"${slug}" must name artwork this build ships, not a URL.` }
  }
  const publishedAt = text(raw.publishedAt)
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) {
    return { ok: false, message: `"${slug}" has no publishedAt date.` }
  }
  if (!Array.isArray(raw.go)) return { ok: false, message: `"${slug}" has no go list.` }

  const go: CardAction[] = []
  for (const [index, entry] of raw.go.entries()) {
    const action = parseCardAction(entry)
    // An action this build cannot read makes the whole card untrustworthy: half
    // of Go is worse than none of it, so the row goes rather than the step.
    if (!action.ok) return { ok: false, message: `"${slug}" go[${index}]: ${action.message}` }
    go.push(action.action)
  }

  // The ordering rules, applied here so a card that can never succeed drops
  // like any other bad row rather than rendering a `Go` that cannot work. They
  // lived only in the executor until 2026-09-06, which meant the home page drew
  // a button whose one press was always a toast.
  const refusal = refuseCardActions(go)
  if (refusal) return { ok: false, message: `"${slug}" was dropped: ${refusal}` }

  const card: HostedCard = { slug, kind: kind as HostedCardKind, title, dek, art, publishedAt, go }
  const credit = text(raw.credit)
  if (credit) card.credit = credit
  if (raw.hero === true) card.hero = true
  return { ok: true, card }
}

/**
 * One action, parsed and copied out of whatever it was read from.
 *
 * Exported because the feed is not the only place an action is read: `cards:run`
 * gets its list back from the renderer and puts it through this same function
 * again before the executor touches it (item 2469). One parser, two boundaries —
 * a second hand-written check on the main side would be the thing that drifts.
 */
export function parseCardAction(raw: unknown): { ok: true; action: CardAction } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'action must be an object.' }
  const verb = text(raw.verb)
  switch (verb) {
    case 'require.cli': {
      const cli = text(raw.cli)
      return cli ? { ok: true, action: { verb, cli } } : { ok: false, message: 'require.cli needs a cli id.' }
    }
    case 'install.mcp': {
      const id = text(raw.id)
      return id ? { ok: true, action: { verb, id } } : { ok: false, message: 'install.mcp needs a server id.' }
    }
    case 'install.module': {
      const id = text(raw.id)
      return id
        ? { ok: true, action: { verb, id } }
        : { ok: false, message: 'install.module needs a marketplace entry id.' }
    }
    case 'install.skill':
    case 'install.plugin': {
      const source = text(raw.source)
      const id = text(raw.id)
      if (!source || !id) return { ok: false, message: `${verb} needs a source and an id.` }
      return { ok: true, action: { verb, source, id } }
    }
    case 'open.chat': {
      const prompt = text(raw.prompt)
      if (!prompt) return { ok: false, message: 'open.chat needs a prompt.' }
      // A prompt is not just copy: it becomes the LAST argv token the agent CLI
      // is launched with (`{{prompt}}` in `resources/plugins/*/plugin.json`),
      // and there is no `--` in front of it. The shell is safe — every value is
      // single-quoted — but the CLI's own option parser is not, so a prompt of
      // `--permission-mode=bypassPermissions` parsed as copy and rendered as a
      // flag. A card may say anything it likes to an agent; it may not say
      // anything to the launcher, and the cheapest true line between the two is
      // the first character. (The `--` separator the manifests should also carry
      // is backlog/2026-09-06-agent-cli-argv-ends-with-a-separator.md.)
      if (prompt.startsWith('-')) {
        return {
          ok: false,
          message: 'open.chat prompt must not begin with "-" — a leading dash is an option to a CLI, not a sentence.',
        }
      }
      // Required, and required to be a boolean: a card that forgets to say
      // whether Go sends the prompt is a card nobody can read, and defaulting
      // either way would put words in the author's mouth.
      if (typeof raw.send !== 'boolean') return { ok: false, message: 'open.chat needs send: true or false.' }
      const action: Extract<CardAction, { verb: 'open.chat' }> = { verb, prompt, send: raw.send }
      const skills = stringList(raw.skills)
      if (skills) action.skills = skills
      const mcpServers = stringList(raw.mcpServers)
      if (mcpServers) action.mcpServers = mcpServers
      return { ok: true, action }
    }
    case 'open.surface': {
      const view = text(raw.view)
      if (!CARD_SURFACE_VIEWS.includes(view as CardSurfaceView)) {
        return { ok: false, message: `open.surface view ${JSON.stringify(raw.view)} is not one this build knows.` }
      }
      const action: Extract<CardAction, { verb: 'open.surface' }> = { verb, view: view as CardSurfaceView }
      if (raw.installed === true) action.installed = true
      return { ok: true, action }
    }
    case 'clone.repo': {
      const repo = repoName(raw.repo)
      if (!repo) return { ok: false, message: 'clone.repo needs a repo as owner/name.' }
      // The trust rule, applied after the shape rule so the two failures read
      // differently: "that is not a repository name" and "that is not a
      // repository we publish" are different mistakes by an author. See
      // `CARD_CLONE_OWNERS` for why a card may not clone anything else.
      if (!isCardCloneOwner(repo)) {
        return {
          ok: false,
          message: `clone.repo may only clone a repository we publish, and "${repo}" is not under ${CARD_CLONE_OWNERS.map((owner) => `${owner}/`).join(' or ')}.`,
        }
      }
      const folderName = text(raw.folderName)
      // One segment, and never a relative directory: the executor joins this
      // onto the app's projects directory, which is the same gate
      // `cloneRepository` puts on its own `folderName`.
      if (folderName && (folderName === '.' || folderName === '..' || /[/\\]/.test(folderName))) {
        return { ok: false, message: 'clone.repo folderName must be a single folder name.' }
      }
      return { ok: true, action: folderName ? { verb, repo, folderName } : { verb, repo } }
    }
    default:
      return { ok: false, message: `${JSON.stringify(raw.verb)} is not a verb this build implements.` }
  }
}

const INSTALL_VERBS: readonly CardActionVerb[] = ['install.mcp', 'install.skill', 'install.plugin', 'install.module']

/**
 * The rules a whole card has to obey that no single action can state, and the
 * sentence to say when it does not. `null` means the card is runnable.
 *
 * This is one function called at two boundaries: `parseCard` above drops a row
 * that fails it, so the home page never draws a `Go` that cannot work, and
 * `src/main/cards/run-card.ts` calls it again before it runs anything, because
 * the action list has been to the renderer and back by then. The messages are
 * written for a toast, because that is where the second caller puts them.
 *
 * Four rules, each of them a state somebody could otherwise not see or undo:
 *
 *  - **One chat, and it goes last.** The chat is the payoff, so it opens onto
 *    tools that are already there; a chat attached to a server that failed to
 *    install is worse than no chat.
 *  - **A clone comes first or not at all.** `clone.repo` moves the workspace
 *    everything after it runs in, so `[install.mcp, clone.repo, open.chat]`
 *    synced a server into the workspace the person was in and then opened the
 *    chat somewhere else entirely — an install nobody asked for in a project
 *    nobody was looking at.
 *  - **A chat may only name servers the card itself installed.** The chat gets
 *    its MCP servers by reading the `.mcp.json` this card just wrote, so a name
 *    nothing installed is a chat that silently opens with no tools; the card
 *    said what it was, and this is what makes that true.
 */
export function refuseCardActions(actions: readonly CardAction[]): string | null {
  const chats = actions.filter((action) => action.verb === 'open.chat')
  if (chats.length > 1) return 'This card opens more than one chat, so it was not run.'
  if (chats.length === 1 && actions[actions.length - 1]?.verb !== 'open.chat') {
    return 'This card opens its chat before it has finished setting up, so it was not run.'
  }

  const clone = actions.findIndex((action) => action.verb === 'clone.repo')
  const install = actions.findIndex((action) => INSTALL_VERBS.includes(action.verb))
  if (clone >= 0 && install >= 0 && install < clone) {
    return 'This card clones a project after it has already installed something, so it was not run.'
  }

  const installed = new Set<string>()
  for (const action of actions) {
    if (action.verb === 'install.mcp') installed.add(action.id)
    if (action.verb !== 'open.chat') continue
    const missing = (action.mcpServers ?? []).find((id) => !installed.has(id))
    if (missing) return `This card opens a chat with ${missing}, which it never installs, so it was not run.`
  }
  return null
}

// Epoch millis of `updatedAt`, or 0 when unparsable: an undated copy loses
// every tie-break.
export function hostedCardFeedUpdatedAtMs(feed: Pick<HostedCardFeed, 'updatedAt'>): number {
  const parsed = Date.parse(feed.updatedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// `owner/name`, and nothing else: no scheme, no host, no path beyond the two
// segments. A card names a repository; it does not name a URL.
function repoName(value: unknown): string {
  const repo = text(value)
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return ''
  // The character class admits `.` and `..`, so `../..` is a well-formed
  // owner/name by that rule alone — and `clone.repo` hands the pair to a path
  // join. Neither segment may be a relative directory.
  return repo.split('/').some((segment) => segment === '.' || segment === '..') ? '' : repo
}

// Whether an already-shape-checked `owner/name` is one a card may clone.
// Case-folded on both sides: GitHub treats `SprintEngine` and `sprintengine` as
// the same owner and a rule that did not would be one lowercase letter away
// from being no rule at all.
function isCardCloneOwner(repo: string): boolean {
  const owner = repo.slice(0, repo.indexOf('/')).toLowerCase()
  return CARD_CLONE_OWNERS.some((allowed) => allowed.toLowerCase() === owner)
}

// A fresh array of trimmed strings, or null when the field was absent or held
// anything that was not a list of strings.
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const entry of value) {
    const item = text(entry)
    if (item) out.push(item)
  }
  return out.length > 0 ? out : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
