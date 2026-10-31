// A new project's name is its folder's name and, when it is published, its
// GitHub repository's, so it is held to GitHub's rule for a repository name:
// the stricter of the two. One check, read by the form as the person types and
// by main before it makes anything.
const GITHUB_REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/u

/** Why a name cannot be a new project's folder (and repository), or null when it can. */
export function newProjectNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Name the project.'
  if (trimmed === '.' || trimmed === '..' || !GITHUB_REPO_NAME.test(trimmed)) {
    return 'Use letters, numbers, dots, dashes and underscores only.'
  }
  return null
}
