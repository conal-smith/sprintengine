import assert from 'node:assert/strict'
import { test } from 'vitest'

import { isValidBranchName, providerForHost, validateCloneUrl } from './git-clone-url'

function parsed(raw: string) {
  const result = validateCloneUrl(raw)
  assert.ok(result.ok, `${raw} should parse: ${result.ok ? '' : result.error}`)
  return result
}

test('a github.com repository URL is cloned as it is, with its host surfaced for the token', () => {
  const source = parsed('https://github.com/octocat/sprintengine')
  assert.equal(source.url, 'https://github.com/octocat/sprintengine')
  assert.equal(source.httpsHost, 'github.com')
  assert.equal(source.provider, 'github')
  assert.equal(source.path, 'octocat/sprintengine')
  assert.equal(source.repoName, 'sprintengine')
  assert.equal(source.branch, null)
  assert.equal(source.insecure, false)
})

test('a .git suffix and a trailing slash are accepted and dropped from the name', () => {
  const source = parsed('https://github.com/octocat/sprintengine.git/')
  assert.equal(source.repoName, 'sprintengine')
  assert.equal(source.path, 'octocat/sprintengine')
})

test('owner/repo is GitHub shorthand', () => {
  const source = parsed('acme/widget')
  assert.equal(source.url, 'https://github.com/acme/widget')
  assert.equal(source.repoName, 'widget')
})

test('a host typed without a scheme is https', () => {
  const source = parsed('gitlab.com/acme/platform/widget')
  assert.equal(source.url, 'https://gitlab.com/acme/platform/widget')
  assert.equal(source.provider, 'gitlab')
})

test('a GitHub page URL is cut back to the repository and keeps the branch it was on', () => {
  const tree = parsed('https://github.com/octocat/sprintengine/tree/main/src')
  assert.equal(tree.url, 'https://github.com/octocat/sprintengine')
  assert.equal(tree.branch, 'main')
  const pulls = parsed('https://github.com/octocat/sprintengine/pulls?q=is%3Aopen#top')
  assert.equal(pulls.url, 'https://github.com/octocat/sprintengine', 'query and fragment are dropped')
  assert.equal(pulls.branch, null)
})

test('a self-hosted GitHub is recognised by its host name', () => {
  assert.equal(parsed('https://github.acme.dev/platform/api/tree/release').provider, 'github')
  assert.equal(parsed('https://github.acme.dev/platform/api/tree/release').branch, 'release')
  assert.equal(parsed('https://acme.ghe.com/platform/api').provider, 'github')
})

test('GitLab keeps nested groups and reads the branch after /-/', () => {
  const source = parsed('https://gitlab.acme.dev/platform/backend/api/-/tree/develop?ref_type=heads')
  assert.equal(source.url, 'https://gitlab.acme.dev/platform/backend/api')
  assert.equal(source.path, 'platform/backend/api')
  assert.equal(source.branch, 'develop')
  assert.equal(source.provider, 'gitlab')
  const plain = parsed('https://gitlab.com/group/sub/repo.git')
  assert.equal(plain.url, 'https://gitlab.com/group/sub/repo.git', 'a clone URL is kept whole')
  assert.equal(plain.repoName, 'repo')
})

test('Bitbucket Cloud keeps the account in the URL and reads /src/<branch>', () => {
  const source = parsed('https://dev@bitbucket.org/acme/mobile-app.git')
  assert.equal(source.url, 'https://dev@bitbucket.org/acme/mobile-app.git')
  assert.equal(source.provider, 'bitbucket')
  const page = parsed('https://bitbucket.org/acme/mobile-app/src/feature-login/README.md')
  assert.equal(page.url, 'https://bitbucket.org/acme/mobile-app')
  assert.equal(page.branch, 'feature-login')
})

test('a Bitbucket Server browse page becomes its scm clone URL', () => {
  const source = parsed('https://bitbucket.acme.dev/projects/PLAT/repos/api/browse?at=refs%2Fheads%2Frelease%2F2.0')
  assert.equal(source.url, 'https://bitbucket.acme.dev/scm/plat/api')
  assert.equal(source.repoName, 'api')
  assert.equal(source.branch, 'release/2.0')
})

test('Azure DevOps: the account in the copied URL is kept, and ?version=GB names the branch', () => {
  const source = parsed('https://acme@dev.azure.com/acme/web/_git/storefront?version=GBrelease%2F2026.10')
  assert.equal(source.url, 'https://acme@dev.azure.com/acme/web/_git/storefront')
  assert.equal(source.provider, 'azure')
  assert.equal(source.path, 'acme/web/_git/storefront')
  assert.equal(source.repoName, 'storefront')
  assert.equal(source.branch, 'release/2026.10')
  const legacy = parsed('https://acme.visualstudio.com/DefaultCollection/web/_git/storefront/pullrequests')
  assert.equal(legacy.url, 'https://acme.visualstudio.com/DefaultCollection/web/_git/storefront')
  const ssh = parsed('git@ssh.dev.azure.com:v3/acme/web/storefront')
  assert.equal(ssh.provider, 'azure')
  assert.equal(ssh.path, 'acme/web/storefront', 'the v3/ protocol prefix is not part of the name')
  assert.equal(ssh.repoName, 'storefront')
})

test('Gitea and Forgejo read /src/branch/<branch>', () => {
  const source = parsed('https://codeberg.org/acme/widget/src/branch/next/docs')
  assert.equal(source.url, 'https://codeberg.org/acme/widget')
  assert.equal(source.branch, 'next')
  assert.equal(source.provider, 'gitea')
  assert.equal(parsed('https://git.forgejo.acme.dev/acme/widget').provider, 'gitea')
})

test('an unknown server keeps its whole path, port included', () => {
  const source = parsed('https://git.acme.dev:8443/scm/platform/api.git')
  assert.equal(source.url, 'https://git.acme.dev:8443/scm/platform/api.git')
  assert.equal(source.provider, 'git')
  assert.equal(source.host, 'git.acme.dev')
  assert.equal(source.repoName, 'api')
})

test('plain http and git:// are accepted for servers on a private network, and marked insecure', () => {
  const http = parsed('http://git.internal.acme.dev/platform/api')
  assert.equal(http.insecure, true)
  assert.equal(http.httpsHost, null, 'no token ever rides plain http')
  const daemon = parsed('git://git.acme.dev/platform/api.git')
  assert.equal(daemon.insecure, true)
  assert.equal(daemon.httpsHost, null)
})

test('ssh, scp-style and ssh:// alike, never carry a token', () => {
  const scp = parsed('git@github.com:octocat/sprintengine.git')
  assert.equal(scp.httpsHost, null)
  assert.equal(scp.repoName, 'sprintengine')
  assert.equal(scp.path, 'octocat/sprintengine')
  const url = parsed('ssh://git@git.acme.dev:2222/platform/api.git')
  assert.equal(url.httpsHost, null)
  assert.equal(url.host, 'git.acme.dev')
  assert.equal(url.path, 'platform/api')
})

test('a whole `git clone` line is unwrapped, with the branch its -b names', () => {
  const source = parsed('git clone -b release/1.2 --depth 1 git@bitbucket.org:acme/mobile-app.git my-app')
  assert.equal(source.url, 'git@bitbucket.org:acme/mobile-app.git')
  assert.equal(source.branch, 'release/1.2')
  assert.equal(parsed('$ git clone https://github.com/acme/widget').url, 'https://github.com/acme/widget')
  assert.equal(parsed('git clone --branch=dev https://github.com/acme/widget').branch, 'dev')
})

test('anything that could reach git as something other than a URL is refused', () => {
  for (const raw of [
    '',
    '-oProxyCommand=evil',
    'ext::sh -c whoami',
    'file:///etc',
    'ftp://example.com/repo',
    'not a url',
    'https://github.com/',
    'https://github.com/a/../b',
    'git clone --upload-pack=evil',
  ]) {
    assert.equal(validateCloneUrl(raw).ok, false, `${JSON.stringify(raw)} is refused`)
  }
})

test('a password in the URL is refused, a user name alone is not', () => {
  const withPassword = validateCloneUrl('https://user:secret@github.com/a/b')
  assert.equal(withPassword.ok, false)
  assert.match(withPassword.ok ? '' : withPassword.error, /password/)
  assert.ok(validateCloneUrl('https://user@github.com/a/b').ok)
})

test('a branch a page names is dropped when git would not accept it', () => {
  assert.equal(parsed('https://github.com/acme/widget/tree/-oops').branch, null)
  assert.equal(isValidBranchName('feature/login'), true)
  assert.equal(isValidBranchName('-x'), false)
  assert.equal(isValidBranchName('a..b'), false)
  assert.equal(isValidBranchName('topic.lock'), false)
  assert.equal(isValidBranchName('ends/'), false)
  assert.equal(isValidBranchName('has space'), false)
})

test('providers by host', () => {
  assert.equal(providerForHost('github.com'), 'github')
  assert.equal(providerForHost('gitlab.com'), 'gitlab')
  assert.equal(providerForHost('code.gitlab.acme.dev'), 'gitlab')
  assert.equal(providerForHost('bitbucket.org'), 'bitbucket')
  assert.equal(providerForHost('dev.azure.com'), 'azure')
  assert.equal(providerForHost('ssh.dev.azure.com'), 'azure')
  assert.equal(providerForHost('acme.visualstudio.com'), 'azure')
  assert.equal(providerForHost('codeberg.org'), 'gitea')
  assert.equal(providerForHost('git.sr.ht'), 'sourcehut')
  assert.equal(providerForHost('git.acme.dev'), 'git')
})

test('an escaped percent in a path or branch is decoded once, never twice', () => {
  const source = parsed('https://github.com/acme/widget/tree/100%25-done')
  assert.equal(source.branch, null, '`%` is not a branch character git accepts, so it is dropped, not thrown on')
  assert.equal(validateCloneUrl('https://git.acme.dev/a%25b/repo').ok, true)
  assert.equal(validateCloneUrl('https://git.acme.dev/a%ZZ/repo').ok, false, 'a malformed escape is refused')
})
