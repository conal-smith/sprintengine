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

Settings ▸ Artifacts. One host or none:

- **GitHub Pages.** A repository on github.com or on a GitHub Enterprise
  Server, given by its https or ssh address (or `owner/name` on github.com).
  Studio pushes to `main`, and Pages serves it as it is. The site's address is
  worked out from the repository (`https://<owner>.github.io/<repo>/`; on a
  GitHub Enterprise Server `https://pages.<host>/<owner>/<repo>/`, its address
  with subdomain isolation) and can be overridden. Pages is turned on by the
  person, in the repository's Settings ▸ Pages: deploy from the `main` branch,
  `/ (root)`. A Pages site is public on the internet even when the repository is
  private, unless the organization is on GitHub Enterprise Cloud and limits it
  to members; the settings page says so.
- **Cloudflare Pages.** An account ID, a Pages project made with Direct
  Upload, and an API token with the Cloudflare Pages Edit permission; a custom
  domain and a git repository for the site's source are optional. Studio
  uploads the site itself (section 5), so no CI runs. A sign-in goes in front
  with a Cloudflare Access self-hosted application for `<project>.pages.dev`
  and the custom domain; the settings page says how.

Test checks the fields on the page, saved or not, without publishing: the
repository is reachable and accepts a push (a dry-run push of a throwaway
commit to a branch that is never made), Pages' status where `gh` can read it,
the Cloudflare token is valid and the project exists and takes direct
uploads, and a dry run of the upload.

What is kept, and where: `artifacts-settings.json` in userData holds the
non-secret fields. The Cloudflare token is sealed with the app's secret cipher
in `artifacts-cloudflare-token.bin`, as the GitHub token is, and never comes
back to the renderer; the page learns only whether one is held. Pushing to a
git host uses the sign-in the machine already has for that host: the saved
GitHub token for github.com, otherwise the token `gh` holds for the host
(`gh auth token --hostname`), handed to git through an inline credential
helper and the child's environment, never argv, a remote URL or the clone's
config. With neither, and for ssh, git uses the person's own helper or keys.
An address with a sign-in in it is refused at the field.

## 3. The tools

| Tool | What it does |
| --- | --- |
| `artifacts.publish` | An HTML file, or a folder with its page, with a title, description, tags, project, source repository/branch/commit and an optional picture. Answers the artifact's address. |
| `artifacts.list` | Newest first, narrowed by tags and project. |
| `artifacts.search` | By words in the title, description, project, tags and branch. |
| `artifacts.get` | One artifact and every version's address. |
| `artifacts.update` | Retitle, describe, re-tag, move project, and/or publish a new version from a path. |
| `artifacts.delete` | Takes it off the site; a git-kept site keeps it in its history. |

With no host chosen every tool refuses with `not_configured`, naming the
settings page. Publishing, changing and removing read files at a path the
caller names and write them with this machine's credentials, so they are
served on the local socket only; a paired device gets the three reads on the
`workspace:read` scope. Main serves the family in process and out (the shell's
`artifacts` toolset), as it does `worktree.*`.

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

Cloudflare uploads once the change is kept, still inside the queue, on the
tree as it was kept: the whole site, content-addressed, so only files Pages
does not have are sent, then one deployment. An upload that fails after the
change was kept answers the publish with `live: false` and a note saying so;
what was last put live is recorded, and the next publish or update (an update
with nothing to change will do) uploads the site again. Two machines that
publish to one Cloudflare project through one repository each deploy the tree
they pushed; if their uploads finish out of order the older tree is live until
the next change. Without a repository the site's source lives on one machine,
and publishing to the same project from another replaces it.

## 6. Adding a host

`artifacts-hosts.ts` is the one shape the service uses: `read`, `change`,
`test` and the site's address. A third host is another `create…Host` built on
a store and its own way of putting the tree live, a case in
`resolveArtifactsHost`, its fields in `shared/artifacts.ts`, and its section on
the settings page.
