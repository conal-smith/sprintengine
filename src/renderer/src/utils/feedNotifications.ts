// The words for the app's background notices: models a CLI refresh added, CLI
// and app updates, plugin-source drift. Pure: the store hands in what it knows,
// this hands back titles and lines, and the tests hold the table.
import type { CliVersionAdvisory, SkillSourceUpdateCheck } from '../../../shared/electron-api'
import type { DiscoveredCliModel, DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'

export type Notice = {
  title: string
  description: string
}

const joinNames = (names: string[]): string => {
  if (names.length <= 1) return names.join('')
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

type CatalogsByCli = Partial<Record<string, DiscoveredCliModelCatalog>>

// Ids a model refresh added, per CLI: rows in `next` that carry a `firstSeenAt`
// and were not in the catalog `previous` held for that CLI. Both halves matter.
// A CLI with no previous catalog is a first-ever probe, or the persisted
// catalogs arriving at boot, and neither is news. A row without `firstSeenAt`
// came from a first probe, which the picker does not mark new either.
export function discoveredModelAdditions(
  previous: CatalogsByCli | null | undefined,
  next: CatalogsByCli | null | undefined,
): Record<string, DiscoveredCliModel[]> {
  const out: Record<string, DiscoveredCliModel[]> = {}
  for (const [cli, catalog] of Object.entries(next ?? {})) {
    const before = previous?.[cli]
    if (!catalog || !before || before === catalog || !Array.isArray(catalog.models)) continue
    const known = new Set((Array.isArray(before.models) ? before.models : []).map((model) => model.id))
    const added = catalog.models.filter((model) => Boolean(model.firstSeenAt) && !known.has(model.id))
    if (added.length > 0) out[cli] = added
  }
  return out
}

// One notice per refresh that introduced ids for INSTALLED CLIs: "New models
// for Claude Code" + up to three names, then "and N more". Two CLIs in one
// refresh make one notice naming both. Ids the person already added by hand
// are not news and are left out.
export function newModelsNotice(input: {
  additions: Record<string, ReadonlyArray<Pick<DiscoveredCliModel, 'id' | 'displayName'>>>
  installed: ReadonlySet<string>
  userModels: (cli: string) => ReadonlyArray<string>
  displayName: (cli: string) => string
}): Notice | null {
  const perCli = Object.entries(input.additions)
    .filter(([cli]) => input.installed.has(cli))
    .map(([cli, models]) => {
      const own = new Set(input.userModels(cli))
      return { cli, models: models.filter((model) => !own.has(model.id)) }
    })
    .filter((entry) => entry.models.length > 0)
  if (perCli.length === 0) return null
  const clis = joinNames(perCli.map((entry) => input.displayName(entry.cli)))
  const models = perCli.flatMap((entry) => entry.models)
  const named = models.slice(0, 3).map((model) => model.displayName?.trim() || model.id)
  const rest = models.length - named.length
  const list = rest > 0 ? `${named.join(', ')}, and ${rest} more` : joinNames(named)
  return {
    title: models.length === 1 ? `New model for ${clis}` : `New models for ${clis}`,
    description: `${list} ${models.length === 1 ? 'is' : 'are'} in the picker.`,
  }
}

// The CLI-update toast's copy: "Update available: Codex 0.153.3", with the
// machine after it when it is not this one — "(WSL: Ubuntu)" — since the same
// CLI may be current here and behind there.
export function cliUpdateNotice(
  advisory: CliVersionAdvisory,
  displayName: (cli: string) => string,
  machineLabel: string | null = null,
): Pick<Notice, 'title'> {
  const title = `Update available: ${displayName(advisory.cli)} ${advisory.latestVersion ?? ''}`.trim()
  return { title: machineLabel ? `${title} (${machineLabel})` : title }
}

export function updateReadyNotice(appName: string, version: string | null, requiresAdmin = false): Notice {
  return {
    title: version ? `${appName} ${version} is ready` : `${appName} update is ready`,
    // An update that needs an administrator does not install at quit: the
    // permission prompt would come up after the app had gone.
    description: requiresAdmin
      ? 'Restart to update. Windows will ask for administrator permission.'
      : 'Restart now to update, or it installs the next time you quit.',
  }
}

// Plugin sources (backlog/2026-09-05-plugin-sources.md, "Update notifications"):
// one notice per check that DISCOVERED drift, naming up to three repositories
// and then "and N more". Sources already known to be behind are not news
// again; their rail row keeps the mark until they are synced.
export function sourceUpdatesNotice(check: Pick<SkillSourceUpdateCheck, 'sources' | 'newlyChanged'>): Notice | null {
  const fresh = check.sources.filter((source) => check.newlyChanged.includes(source.sourceId))
  if (fresh.length === 0) return null
  const named = fresh.slice(0, 3).map((source) => source.name)
  const rest = fresh.length - named.length
  const list = rest > 0 ? `${named.join(', ')}, and ${rest} more` : joinNames(named)
  return {
    title: fresh.length === 1 ? 'A plugin source has updates' : `${fresh.length} plugin sources have updates`,
    description: `${list} ${fresh.length === 1 ? 'has' : 'have'} moved on since you scanned. Open Plugins and press Sync to take the changes.`,
  }
}
