import { parseArtifactsRepositoryUrl, DEFAULT_CLOUDFLARE_PROJECT } from '../../shared/artifacts'

// What the person is asked before `artifacts.setup` changes anything: an
// agent wants to say where its pages are published, and that is the person's
// setting (Settings ▸ Artifacts), so nothing is turned on, made or saved until
// they confirm it in Studio. The question is put by main (the Electron half,
// artifacts-setup-consent-electron.ts, as the quit question is), not by the
// agent: an agent cannot answer it, and a refusal, a dismissal or no answer
// in time all leave the setting as it was.
//
// The token an agent passes is never part of the question.

export type ArtifactsSetupRequest =
  | { provider: 'github-pages'; repositoryUrl: string }
  | {
      provider: 'cloudflare-pages'
      accountName: string | null
      projectName: string
      sourceRepositoryUrl: string | null
    }

export type ArtifactsSetupConsentQuestion = {
  message: string
  detail: string
  confirmLabel: string
  refuseLabel: string
}

/** Asks the person; true only when they confirmed. */
export type ArtifactsSetupConsent = (question: ArtifactsSetupConsentQuestion, signal: AbortSignal) => Promise<boolean>

/** How long the question waits for an answer before it is taken as no. */
export const ARTIFACTS_SETUP_CONSENT_TIMEOUT_MS = 5 * 60_000

export function artifactsSetupQuestion(
  request: ArtifactsSetupRequest,
  agentName: string | null,
): ArtifactsSetupConsentQuestion {
  const who = agentName?.trim() ? agentName.trim().slice(0, 80) : 'An agent'
  if (request.provider === 'github-pages') {
    const parsed = parseArtifactsRepositoryUrl(request.repositoryUrl)
    const where = parsed.ok
      ? `${parsed.repository.owner}/${parsed.repository.name}${parsed.repository.host ? ` on ${parsed.repository.host}` : ''}`
      : request.repositoryUrl
    return {
      message: 'Publish artifacts with GitHub Pages?',
      detail: [
        `${who} asks to set this up.`,
        '',
        `Repository: ${where}`,
        '',
        'Studio will push the gallery to its main branch, turn on GitHub Pages for it if it is off, and publish agents’ pages there from now on.',
        'A Pages site is public on the internet, even for a private repository, unless your organization limits it to members.',
        '',
        'You can change this on Settings ▸ Artifacts at any time.',
      ].join('\n'),
      confirmLabel: 'Set up GitHub Pages',
      refuseLabel: 'Don’t allow',
    }
  }
  const project = request.projectName || DEFAULT_CLOUDFLARE_PROJECT
  return {
    message: 'Publish artifacts with Cloudflare Pages?',
    detail: [
      `${who} asks to set this up.`,
      '',
      `Account: ${request.accountName ?? 'the one the token can see'}`,
      `Project: ${project} (made if there is none)`,
      ...(request.sourceRepositoryUrl ? [`Source repository: ${request.sourceRepositoryUrl}`] : []),
      '',
      'Studio will keep the API token the agent was given in this computer’s secure storage, upload the gallery to the project, and publish agents’ pages there from now on.',
      '',
      'You can change this on Settings ▸ Artifacts at any time.',
    ].join('\n'),
    confirmLabel: 'Set up Cloudflare Pages',
    refuseLabel: 'Don’t allow',
  }
}
