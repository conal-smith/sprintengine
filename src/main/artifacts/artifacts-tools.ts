import { isAbsolute } from 'node:path'

import {
  ARTIFACTS_SETTINGS_PAGE,
  parseArtifactsRepositoryUrl,
  type ArtifactsSetupInput,
  type ArtifactsSetupResult,
} from '../../shared/artifacts'
import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'
import { SLUG_PATTERN } from './artifact-site'
import type { ArtifactsService } from './artifacts-service'
import {
  ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS,
  artifactsSetupQuestion,
  type ArtifactsSetupConsent,
} from './artifacts-setup-consent'

// The `artifacts.*` tools: an agent publishes an HTML page (a mockup, a
// prototype, a report) so the person can open it from any device, and finds,
// changes or removes what was published. Where it goes is the person's choice
// on Settings ▸ Artifacts; with nothing chosen every tool refuses and names
// that page. Main serves them, because the pages are files on this machine and
// publishing signs in with this machine's credentials; a paired device is
// served the reads only (tailnet-scopes.ts).

export const ARTIFACTS_MUTATION_TOOL_NAMES = [
  'artifacts.publish',
  'artifacts.update',
  'artifacts.delete',
  'artifacts.setup',
] as const

const LIMITS = {
  title: 200,
  description: 2000,
  tag: 40,
  tags: 20,
  project: 100,
  repo: 300,
  branch: 250,
  path: 4096,
  stylesheets: 10,
  query: 500,
}

type Args = Record<string, unknown>
type Invalid = { invalid: string }

function invalid(message: string): Invalid {
  return { invalid: message }
}

function optionalString(args: Args, key: string, max: number): string | undefined | Invalid {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return invalid(`"${key}" is a string.`)
  if (value.length > max) return invalid(`"${key}" is at most ${max} characters.`)
  if (value.includes('\0')) return invalid(`"${key}" holds a NUL character.`)
  return value
}

function optionalPath(args: Args, key: string): string | undefined | Invalid {
  const value = optionalString(args, key, LIMITS.path)
  if (value === undefined || typeof value !== 'string') return value
  if (!isAbsolute(value)) return invalid(`"${key}" is an absolute path on this machine.`)
  return value
}

function optionalStrings(args: Args, key: string, maxItems: number, maxLength: number): string[] | undefined | Invalid {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems)
    return invalid(`"${key}" is a list of at most ${maxItems} strings.`)
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maxLength)
      return invalid(`Each of "${key}" is a string of at most ${maxLength} characters.`)
  }
  return value as string[]
}

function isInvalid(value: unknown): value is Invalid {
  return typeof value === 'object' && value !== null && 'invalid' in value
}

/** The fields every publish and update share, read and checked. */
function readPageFields(args: Args): Invalid | Record<string, string | string[] | undefined> {
  const fields = {
    path: optionalPath(args, 'path'),
    entry: optionalString(args, 'entry', LIMITS.path),
    stylesheets: optionalStrings(args, 'stylesheets', LIMITS.stylesheets, LIMITS.path),
    title: optionalString(args, 'title', LIMITS.title),
    description: optionalString(args, 'description', LIMITS.description),
    tags: optionalStrings(args, 'tags', LIMITS.tags, LIMITS.tag),
    project: optionalString(args, 'project', LIMITS.project),
    repo: optionalString(args, 'repo', LIMITS.repo),
    branch: optionalString(args, 'branch', LIMITS.branch),
    commit: optionalString(args, 'commit', 40),
    thumbnail: optionalPath(args, 'thumbnail'),
  }
  for (const value of Object.values(fields)) if (isInvalid(value)) return value
  if (typeof fields.commit === 'string' && !/^[0-9a-f]{4,40}$/i.test(fields.commit))
    return invalid('"commit" is a commit hash.')
  if (typeof fields.entry === 'string' && (isAbsolute(fields.entry) || fields.entry.split(/[\\/]/).includes('..'))) {
    return invalid('"entry" is a page inside the published folder, relative to it.')
  }
  for (const sheet of (fields.stylesheets as string[] | undefined) ?? []) {
    if (!isAbsolute(sheet)) return invalid('Each of "stylesheets" is an absolute path to a .css file.')
  }
  if (typeof fields.title === 'string' && !fields.title.trim()) return invalid('"title" is not blank.')
  return fields as Record<string, string | string[] | undefined>
}

function slugArg(args: Args): string | Invalid {
  const slug = args.slug
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    return invalid('"slug" is an artifact’s slug, as artifacts.list or artifacts.publish answered it.')
  }
  return slug
}

/** A service answer as a tool's: its failure code and message, or the rest of it. */
function answer(result: { ok: boolean; code?: string; message?: string } & Record<string, unknown>): McpToolResult {
  if (!result.ok) return toolError(result.code ?? 'failed', result.message ?? 'It failed.')
  const { ok: _ok, ...rest } = result
  return toolSuccess(rest)
}

const NOT_SET_UP_NOTE = `Refused with "not_configured" until a host is set up, on ${ARTIFACTS_SETTINGS_PAGE} or with artifacts.setup.`

const SOURCE_PROPERTIES = {
  project: {
    type: 'string',
    description:
      'The project it belongs to, shown on its card and used to filter. Taken from the repository the page is in when left out.',
  },
  repo: {
    type: 'string',
    description: 'The repository it was made in (owner/name or its URL). Read from the page’s checkout when left out.',
  },
  branch: { type: 'string', description: 'The branch it was made on. Read from the page’s checkout when left out.' },
  commit: {
    type: 'string',
    description: 'The commit it was made at, linked from its page. Read from the page’s checkout when left out.',
  },
}

const PAGE_PROPERTIES = {
  path: {
    type: 'string',
    description:
      'Absolute path to the HTML file, or to a folder holding the page and its assets. Every local file the page references (stylesheets, scripts, images, fonts, `../` paths included) is published beside it as laid out on disk, so its relative links keep working.',
  },
  entry: {
    type: 'string',
    description: 'For a folder: the page to open, relative to it. index.html, or the folder’s only page, by default.',
  },
  stylesheets: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Absolute paths to stylesheets to add to the page’s head when it is published, such as the project’s web-font CSS the page relies on but does not link; published with what they reference (package imports such as `@fontsource/…` are resolved through node_modules).',
  },
  thumbnail: {
    type: 'string',
    description:
      'Absolute path to a PNG, JPEG or WebP picture to show on its card. Studio takes a screenshot of the page when left out.',
  },
}

/** What `artifacts.setup` needs beyond the service: the set-up itself, and the person's say. */
export type ArtifactsSetupToolDeps = {
  /**
   * For Cloudflare, read only: the account the token would publish to, or
   * the accounts to pick from when it sees several.
   */
  cloudflareAccount(
    token: string | undefined,
    accountId: string | undefined,
  ): Promise<
    | { ok: true; account: { id: string; name: string } }
    | { ok: false; message: string; accounts?: Array<{ id: string; name: string }> }
  >
  /** The set-up, saved. */
  run(input: ArtifactsSetupInput): Promise<ArtifactsSetupResult>
  consent: ArtifactsSetupConsent
}

export function createArtifactsTools(deps: {
  service: ArtifactsService
  setup?: ArtifactsSetupToolDeps
}): McpToolRegistration[] {
  const { service } = deps
  return [
    createSetupTool(deps.setup),
    {
      name: 'artifacts.publish',
      description:
        'Publish an HTML page (a mockup, a prototype, a report) to the person’s artifacts site, so it can be opened from any device, phone included. ' +
        'Answers its address. A new artifact gets a stable slug from its title; pass "slug" to publish a new version of one already published, ' +
        'which keeps every earlier version reachable. Each change is recorded in the site’s history. ' +
        NOT_SET_UP_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          ...PAGE_PROPERTIES,
          title: { type: 'string', description: 'What it is, in a few words, shown on its card and page.' },
          description: {
            type: 'string',
            description: 'A sentence or two on what it shows, searched by artifacts.search.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short words to find and filter it by, such as "mockup".',
          },
          ...SOURCE_PROPERTIES,
          slug: { type: 'string', description: 'An artifact already published, to add a version to.' },
        },
        required: ['path', 'title'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args) => {
        const fields = readPageFields(args)
        if (isInvalid(fields)) return toolError('invalid_arguments', fields.invalid)
        if (typeof fields.path !== 'string')
          return toolError('invalid_arguments', '"path" is required: the page, or its folder.')
        if (typeof fields.title !== 'string') return toolError('invalid_arguments', '"title" is required.')
        let slug: string | undefined
        if (args.slug !== undefined) {
          const checked = slugArg(args)
          if (isInvalid(checked)) return toolError('invalid_arguments', checked.invalid)
          slug = checked
        }
        return answer(
          await service.publish({
            ...(fields as Record<string, never>),
            path: fields.path,
            title: fields.title.trim(),
            ...(slug ? { slug } : {}),
          }),
        )
      },
    },
    {
      name: 'artifacts.list',
      description:
        'List the published artifacts, most recently changed first, with each one’s title, project, tags, version and address. ' +
        'Narrow by tag (every tag given must match) or project. ' +
        NOT_SET_UP_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many; 50 by default.' },
        },
        additionalProperties: false,
      },
      handler: async (args) => list(service, args, false),
    },
    {
      name: 'artifacts.search',
      description:
        'Find published artifacts by words in their title, description, project, tags or branch (every word must match), most recent first, optionally narrowed by tag and project. ' +
        NOT_SET_UP_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The words to look for.' },
          tags: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many; 50 by default.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args) => list(service, args, true),
    },
    {
      name: 'artifacts.get',
      description:
        'One published artifact: its title, description, tags, project, source commit, address, and every version with its own address. ' +
        NOT_SET_UP_NOTE,
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'The artifact’s slug.' } },
        required: ['slug'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const slug = slugArg(args)
        if (isInvalid(slug)) return toolError('invalid_arguments', slug.invalid)
        return answer(await service.get(slug))
      },
    },
    {
      name: 'artifacts.update',
      description:
        'Change a published artifact: retitle it, describe it again, re-tag it or move it to another project, and/or publish a new version of it from "path" (earlier versions stay reachable). ' +
        'Tags given replace its tags. ' +
        NOT_SET_UP_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The artifact’s slug.' },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          ...PAGE_PROPERTIES,
          ...SOURCE_PROPERTIES,
        },
        required: ['slug'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args) => {
        const slug = slugArg(args)
        if (isInvalid(slug)) return toolError('invalid_arguments', slug.invalid)
        const fields = readPageFields(args)
        if (isInvalid(fields)) return toolError('invalid_arguments', fields.invalid)
        const title = typeof fields.title === 'string' ? fields.title.trim() : undefined
        return answer(await service.update({ ...(fields as Record<string, never>), ...(title ? { title } : {}), slug }))
      },
    },
    {
      name: 'artifacts.delete',
      description:
        'Take a published artifact off the site, every version of it. Where the site is kept in a git repository it stays in the history; ' +
        'a Cloudflare site with no repository keeps no copy. Only when the person asked for it to go. ' +
        NOT_SET_UP_NOTE,
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'The artifact’s slug.' } },
        required: ['slug'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args) => {
        const slug = slugArg(args)
        if (isInvalid(slug)) return toolError('invalid_arguments', slug.invalid)
        return answer(await service.remove(slug))
      },
    },
  ]
}

async function list(service: ArtifactsService, args: Args, search: boolean): Promise<McpToolResult> {
  const query = optionalString(args, 'query', LIMITS.query)
  const tags = optionalStrings(args, 'tags', LIMITS.tags, LIMITS.tag)
  const project = optionalString(args, 'project', LIMITS.project)
  for (const value of [query, tags, project]) if (isInvalid(value)) return toolError('invalid_arguments', value.invalid)
  if (search && (typeof query !== 'string' || !query.trim()))
    return toolError('invalid_arguments', '"query" is the words to look for.')
  const limit = args.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return toolError('invalid_arguments', '"limit" is a whole number from 1 to 200.')
  }
  return answer(
    await service.list({
      ...(typeof query === 'string' ? { query } : {}),
      ...(Array.isArray(tags) ? { tags } : {}),
      ...(typeof project === 'string' ? { project } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    }),
  )
}

/**
 * `artifacts.setup`: an agent sets the host up in conversation, from what
 * the person gave it (a repository, or a Cloudflare token). It is the
 * person's setting, so the person confirms in Studio before anything is
 * turned on, made or saved (artifacts-setup-consent.ts); the agent cannot
 * answer for them. Like the `tailnet.*` configuration tools it is a mutation,
 * audited, and served on this machine's socket only. The token goes from the
 * arguments to secret storage: no answer, step or question carries it, and
 * the audit keeps no argument but its identifiers.
 */
function createSetupTool(setup: ArtifactsSetupToolDeps | undefined): McpToolRegistration {
  return {
    name: 'artifacts.setup',
    description:
      'Set up where artifacts are published, when the other artifacts tools answer "not_configured": GitHub Pages from a repository ' +
      '(its address, on github.com or a GitHub Enterprise Server), or Cloudflare Pages from an API token with the Cloudflare Pages Edit permission. ' +
      `Offer it to the person (the other way is ${ARTIFACTS_SETTINGS_PAGE}, which they open themselves), and ask them for the repository or the token. ` +
      'Studio shows the person what will be done and asks them to confirm; nothing is changed or saved until they do, and a refusal is final for this call. ' +
      'GitHub: Studio turns Pages on if it is off and answers the site address GitHub gives. Cloudflare: Studio finds the account (when the token ' +
      'sees several it answers them, to ask the person which, and call again with "accountId") and finds or makes the project. ' +
      'The token goes to secret storage and is never answered back; do not repeat it in the conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['github-pages', 'cloudflare-pages'] },
        repositoryUrl: {
          type: 'string',
          description: 'GitHub Pages: the repository’s address, or owner/name on github.com.',
        },
        cloudflareToken: {
          type: 'string',
          description: 'Cloudflare Pages: the API token the person gave. Left out, the token already saved, if any.',
        },
        accountId: {
          type: 'string',
          description: 'Cloudflare Pages: the account to use, when the token sees several.',
        },
        projectName: {
          type: 'string',
          description: 'Cloudflare Pages: the project, when the person wants another than "studio-artifacts".',
        },
        sourceRepositoryUrl: {
          type: 'string',
          description: 'Cloudflare Pages: a git repository to keep the site’s source in, when the person wants one.',
        },
      },
      required: ['provider'],
      additionalProperties: false,
    },
    mutates: true,
    handler: async (args, context) => {
      if (!setup) return toolError('unavailable', `Set artifacts up on ${ARTIFACTS_SETTINGS_PAGE}.`)
      const fields: Record<string, string | undefined> = {}
      for (const key of [
        'repositoryUrl',
        'cloudflareToken',
        'accountId',
        'projectName',
        'sourceRepositoryUrl',
      ] as const) {
        const value = args[key]
        if (value === undefined || value === null) continue
        if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
          return toolError('invalid_arguments', `"${key}" is a string.`)
        }
        fields[key] = value.trim()
      }
      if (args.provider === 'github-pages') {
        const repositoryUrl = fields.repositoryUrl ?? ''
        const parsed = parseArtifactsRepositoryUrl(repositoryUrl)
        if (!parsed.ok) return toolError('invalid_arguments', `"repositoryUrl": ${parsed.message}`)
        return confirmAndRun(
          setup,
          context,
          { provider: 'github-pages', repositoryUrl },
          {
            provider: 'github-pages',
            repositoryUrl,
          },
        )
      }
      if (args.provider === 'cloudflare-pages') {
        if (fields.sourceRepositoryUrl) {
          const parsed = parseArtifactsRepositoryUrl(fields.sourceRepositoryUrl)
          if (!parsed.ok) return toolError('invalid_arguments', `"sourceRepositoryUrl": ${parsed.message}`)
        }
        // Read only, and before the person is asked: which account it would be.
        const account = await setup.cloudflareAccount(
          fields.cloudflareToken || undefined,
          fields.accountId || undefined,
        )
        if (!account.ok) {
          if (account.accounts?.length) {
            return toolSuccess({
              ok: false,
              needsAccount: true,
              message: `${account.message} Ask the person which, then call again with its "accountId".`,
              accounts: account.accounts,
            })
          }
          return toolError('invalid_arguments', account.message)
        }
        return confirmAndRun(
          setup,
          context,
          {
            provider: 'cloudflare-pages',
            accountName: account.account.name,
            projectName: fields.projectName ?? '',
            sourceRepositoryUrl: fields.sourceRepositoryUrl || null,
          },
          {
            provider: 'cloudflare-pages',
            ...(fields.cloudflareToken ? { token: fields.cloudflareToken } : {}),
            accountId: account.account.id,
            ...(fields.projectName !== undefined ? { projectName: fields.projectName } : {}),
            ...(fields.sourceRepositoryUrl !== undefined ? { repositoryUrl: fields.sourceRepositoryUrl } : {}),
          },
        )
      }
      return toolError('invalid_arguments', '"provider" is "github-pages" or "cloudflare-pages".')
    },
  }
}

/** The set-ups waiting on the person: one question at a time, never a stack of them. */
const asking = new WeakSet<ArtifactsSetupToolDeps>()

async function confirmAndRun(
  setup: ArtifactsSetupToolDeps,
  context: McpConnectionContext | undefined,
  request: Parameters<typeof artifactsSetupQuestion>[0],
  input: ArtifactsSetupInput,
): Promise<McpToolResult> {
  if (asking.has(setup)) {
    return toolError('busy', 'The person is already being asked about setting artifacts up. Wait for that answer.')
  }
  const question = artifactsSetupQuestion(request, context?.metadata.agentName ?? null)
  asking.add(setup)
  const confirmed = await setup
    .consent(question, AbortSignal.timeout(ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS))
    .catch(() => false)
    .finally(() => asking.delete(setup))
  if (!confirmed) {
    return toolError(
      'not_confirmed',
      `The person did not confirm setting artifacts up, so nothing was changed. They can set it up on ${ARTIFACTS_SETTINGS_PAGE}.`,
    )
  }
  const result = await setup.run(input)
  if (!result.ok) {
    return toolError(
      'setup_failed',
      `${result.message}${result.steps.length ? ` (${result.steps.map((step) => `${step.label}: ${step.detail}`).join(' ')})` : ''}`,
    )
  }
  return toolSuccess({ siteUrl: result.siteUrl, steps: result.steps })
}
