# Published artifacts

Status: **built**, in `src/main/artifacts/`, with the site's files in
`resources/artifacts-site/`.

## 1. What it is for

Agents make HTML pages: mockups, prototypes, reports. They are files on the
machine the agent ran on, and nobody can open them from a phone. The
`artifacts.*` tools publish such a page to a static site the person chose, and
answer its address; the site is a gallery of everything published, newest
first.

## 2. Where it is set up

Settings ▸ Artifacts, or `artifacts.setup` from an agent (section 3). One host
or none, and each asks the person for one thing:

- **GitHub Pages: the repository**, on github.com or a GitHub Enterprise
  Server (its https or ssh address, or `owner/name` on github.com). Studio
  reads it and rehearses a push (a dry run of a throwaway commit to a branch
  never made), pushes the gallery to `main` when the repository is empty,
  turns Pages on when it is off (`POST /repos/{owner}/{repo}/pages`, main at
  `/`, through `gh api` on that host), waits for the first build, and keeps
  the address GitHub answers (`html_url`), so a custom domain or an
  Enterprise Server's Pages host is simply what the person gets. Refusals are
  said in words with what to do: a plan that does not allow Pages on a private
  repository, a sign-in without admin rights on it, gh missing or signed out.
  A Pages site is public on the internet even when the repository is private,
  unless the organization is on GitHub Enterprise Cloud and limits it; the
  page says so.
- **Cloudflare Pages: an API token** with Account › Cloudflare Pages › Edit
  (the page links to Cloudflare's token page with that permission
  preselected). Studio lists the accounts the token sees (`GET /accounts`):
  one is used, of several the person picks, none is an error saying what token
  to make. The project, `studio-artifacts` unless renamed under Advanced, is
  found or made; one that deploys from its own git connection, or whose latest
  deployment Studio did not make, is left alone and another name asked for. A
  project made by someone else between the lookup and the create is read as
  found. The site's address is the project's own domain, or its
  `*.pages.dev` subdomain. A source repository is optional, under Advanced.
  A sign-in goes in front with a Cloudflare Access self-hosted application;
  the page says how.

Test and Save both run the set-up and list what was found and done ("Found
account Acme", "Created project studio-artifacts", the site's address); Save
keeps it. What a test makes (a first commit, Pages turned on, a project, an
upload) stays made, and says so.

What is kept, and where: `artifacts-settings.json` in userData holds the
repository and what Studio found (the site's address, the Cloudflare account
and project). The Cloudflare token is sealed with the app's secret cipher in
`artifacts-cloudflare-token.bin`, as the GitHub token is, and never comes back
to the renderer, a tool's answer or an error. Pushing to a git host uses the
sign-in the machine already has for that host: the saved GitHub token for
github.com, otherwise the token `gh` holds for the host, handed to git through
an inline credential helper and the child's environment, never argv, a remote
URL or the clone's config. With neither, and for ssh, git uses the person's
own helper or keys. An address with a sign-in in it is refused.

## 3. The tools

| Tool | What it does |
| --- | --- |
| `artifacts.setup` | Sets the host up from a repository or a Cloudflare token, once the person confirms in Studio. Answers the site's address. |
| `artifacts.publish` | An HTML file, or a folder with its page, with a title, description, tags, project, source repository/branch/commit and an optional picture. Answers the artifact's address. |
| `artifacts.list` | Newest first, narrowed by tags and project. |
| `artifacts.search` | By words in the title, description, project, tags and branch. |
| `artifacts.get` | One artifact and every version's address. |
| `artifacts.update` | Retitle, describe, re-tag, move project, and/or publish a new version from a path. |
| `artifacts.delete` | Takes it off the site; a git-kept site keeps it in its history. |

With no host set up every tool but `artifacts.setup` refuses with
`not_configured`, naming the settings page and `artifacts.setup`, so an agent
offers to set it up in conversation.

`artifacts.setup` changes the person's setting, so the person decides. Main
asks them in a native message box (as it asks before quitting), naming the
agent, the host, the repository or the account and project, and what Studio
will do; Return and Escape refuse, and no answer in five minutes is a refusal.
Nothing is turned on, made or saved before the answer, and only one question
is open at a time. The only thing done before asking is reading which accounts
a Cloudflare token sees, so the person can be asked which. The token goes
from the arguments to secret storage; neither the question nor the answer
carries it, and the gateway's audit keeps no argument but identifiers.

Publishing, changing, removing and setting up read files at a path the caller
names, or change where this machine publishes, and use its credentials, so
they are mutations served on the local socket only; a paired device gets the
three reads on the `workspace:read` scope. Main serves the family in process
and out (the shell's `artifacts` toolset), as it does `worktree.*`.

## 4. A version, and the site

A publish gathers the page and every local file it references
(`artifact-bundle.ts`): HTML attributes, `srcset`, inline and linked CSS
(`url()`, `@import`) and static module imports, recursively. The files keep
their layout relative to one another, so `../foundations/tokens.css` beside
`patterns/your-stars.html` still resolves; nothing is rewritten except what a
browser could not resolve on its own (a stylesheet's package import such as
`@fontsource/kalam/400.css`, resolved through `node_modules`; a published
folder's root-relative links), and the stylesheets the caller asked to add to
the page's head, such as a project's web fonts. A hidden file (`../.env`) or a
symbolic link the page names is left out with a warning, since the site is
public. Files the page loads from the network are listed as a warning.

The page is laid out in a folder of its own and opened there in a hidden,
sandboxed window of the app's own Chromium for its picture
(`artifact-thumbnail-electron.ts`).

The repository's layout is the site:

```
README.md          what it is, and the gallery's address
index.html         the gallery: reads artifacts.json
artifacts.json     every artifact's summary, newest first
site-files.json    every file of the site with its SHA-256
assets/            the gallery's and viewer's stylesheet and scripts
a/<slug>/
  index.html       the viewer: header, version picker, the page below
  meta.json        the record, every version listed
  thumbnail.png    the latest version's picture
  v1/ v2/ …        each version's page and files
.nojekyll          serve every file as it is
```

Every link in the site is relative, so it works at the root of a domain and
under a sub-path (`/artifacts/`). An artifact's address, `a/<slug>/`, is
stable; `?v=2` opens an earlier version. The gallery searches as you type,
filters by tag and project (both kept in the address), toggles a grid and a
list, and follows the system's light and dark. Nothing is loaded from another
host. The gallery and the viewer treat `artifacts.json` and `meta.json` as
data anyone with push access could edit: a slug that is not a folder name, a
page that is not one of the artifact's own versions, and a commit link that is
not a web address are ignored.

## 5. Keeping it consistent

A host keeps the site's source in a store (`artifacts-store.ts`): a clone of
the repository in userData, or, for Cloudflare without a repository, a folder
there. Every change runs in the store's queue, one per folder, shared by every
store on it (Settings' Test builds one of its own).

A git store brings the clone to the remote's `main`, makes the change,
commits and pushes. A push another machine beat is refused as not a
fast-forward; the store resets to the new tip and makes the change again, up
to five times. Making it again, rather than rebasing the commit, keeps the
manifest right: it is rebuilt from the `meta.json` files on every change, where
a rebase would stop on both sides having edited it. Anything a failed attempt
left in the clone (a half-written manifest, an unpushed commit) is thrown away
by the next reset. A local store copies the site before a change and puts the
copy back if the change fails, or if the app did not live to finish it.

GitHub Pages is turned on, if it is off, after a push and still in the queue,
so `main` exists by then, and two callers (a test and a first publish) share
one request; a 409 from another machine turning it on first reads as on. A
first publish waits up to two minutes for the first build and then answers
with `live: false` and where the site will be.

Cloudflare uploads once the change is kept, still inside the queue: the whole
site, content-addressed, so only files Pages does not have are sent, then one
deployment, whose message starts "SprintEngine Studio artifacts" so a project
can be told as Studio's. An upload that fails after the change was kept
answers `live: false` and why; the next publish or update uploads again.

Every change also writes `site-files.json`, every file of the site with its
SHA-256. A Cloudflare site kept on this machine, whose project's latest
deployment is not the one this machine made, is read back from the live site
before it is changed (`cloudflare-live-copy.ts`): with no copy at all every
file is fetched and checked; with a copy that is behind, each artifact the live
site has a newer version of is taken in, and one the copy has at the same or a
newer version is never touched, so work made here and not yet uploaded
survives. An artifact removed elsewhere comes back from a copy that still has
it. A site behind Cloudflare Access answers a sign-in page instead, and cannot
be read back: the publish says so, and that a source repository under
Advanced is how machines share one site.

## 6. Adding a host

`artifacts-hosts.ts` is the one shape the service uses: `read`, `change`,
`test` and the site's address. A third host is another `create…Host` built on
a store and its own way of putting the tree live, a case in
`resolveArtifactsHost`, its fields in `shared/artifacts.ts`, and its section on
the settings page.
