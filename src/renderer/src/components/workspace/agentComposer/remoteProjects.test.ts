import assert from 'node:assert/strict'

import { remoteProjectOfWorkspace, remoteProjectsOf } from './remoteProjects'
import type { MeshWorkspace } from '../../../../../shared/tailnet-mesh'
import { test } from 'vitest'

test('remoteProjects', async () => {
  // The fold that turned the remote project chip from a list of the other
  // machine's CHATS into a list of its projects.

  let failures = 0
  function check(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.log(`not ok - ${name}`)
      console.error(error)
    }
  }

  const repo = (name: string) => ({
    canonicalKey: `github.com/acme/${name}`,
    remoteUrl: `git@github.com:acme/${name}.git`,
    name,
  })

  const chat = (
    id: string,
    name: string,
    folderPath: string | null,
    repository = null as MeshWorkspace['repository'],
  ): MeshWorkspace => ({
    id,
    name,
    mode: 'standard',
    folderPath,
    repository,
  })

  check('chats in one folder are one project, named after the folder', () => {
    const projects = remoteProjectsOf([
      chat('w3', 'Yeah, that’s a good spot', '/Users/dev/sprintengine'),
      chat('w1', 'Improve Search Glass Effect', '/Users/dev/sprintengine'),
      chat('w2', 'Fix Reaped Terminal Brightness', '/Users/dev/sprintengine'),
    ])
    assert.equal(projects.length, 1, 'three chats in one checkout are one row')
    assert.equal(projects[0]!.name, 'sprintengine', 'named after the folder, not after a chat')
    assert.equal(projects[0]!.folderPath, '/Users/dev/sprintengine')
    assert.equal(projects[0]!.conversationCount, 3)
  })

  check('the seat is the lowest id, so a re-read does not move it', () => {
    const first = remoteProjectsOf([chat('w3', 'c', '/srv/app'), chat('w1', 'a', '/srv/app')])
    const reordered = remoteProjectsOf([chat('w1', 'a', '/srv/app'), chat('w3', 'c', '/srv/app')])
    assert.equal(first[0]!.workspaceId, 'w1')
    assert.equal(reordered[0]!.workspaceId, 'w1', 'list order does not change which workspace answers for the folder')
  })

  check('two folders of one repository stay two projects', () => {
    // A worktree checkout is the same repository and a DIFFERENT folder. Merging
    // them would pick one of the two paths for a launch to land in.
    const projects = remoteProjectsOf([
      chat('w1', 'main chat', '/srv/app', repo('app')),
      chat('w2', 'worktree chat', '/srv/app-feature', repo('app')),
    ])
    assert.deepEqual(
      projects.map((project) => project.folderPath),
      ['/srv/app', '/srv/app-feature'],
    )
  })

  check('a chat in an app-made worktree files under its project, never as a row of its own', () => {
    // The owner's list: real projects buried under `pool-01`, `chat-k_iq`, …
    // — the worktrees chats over there run in, each listed as a project.
    const projects = remoteProjectsOf([
      chat('w9', 'plain', '/Users/dev/app', repo('app')),
      chat('w1', 'pool', '/Users/dev/.sprintengine-worktrees/app/pool-01', repo('app')),
      chat('w2', 'cut', '/Users/dev/.sprintengine-worktrees/app/chat-k_iq', repo('app')),
      chat('w3', 'named', '/Users/dev/.sprintengine-worktrees/app/hidden-tool-calls', repo('app')),
      chat('w4', 'other', '/Users/dev/toolbox'),
    ])
    assert.deepEqual(
      projects.map((project) => [project.name, project.folderPath]),
      [
        ['app', '/Users/dev/app'],
        ['toolbox', '/Users/dev/toolbox'],
      ],
    )
    assert.equal(projects[0]!.conversationCount, 4, 'the worktree chats count toward their project')
    assert.equal(
      projects[0]!.workspaceId,
      'w9',
      "the chat in the project's own folder answers for it, over a lower-id worktree chat",
    )
  })

  check('a project open there only through worktree chats is still listed, as the project', () => {
    const workspaces = [
      chat('w5', 'cut', '/Users/dev/.sprintengine-worktrees/site/chat-3kmu', repo('site')),
      chat('w2', 'pool', '/Users/dev/.sprintengine-worktrees/site/pool-02', null),
    ]
    const projects = remoteProjectsOf(workspaces)
    assert.equal(projects.length, 1)
    assert.equal(projects[0]!.name, 'site')
    assert.equal(projects[0]!.folderPath, '/Users/dev/site')
    assert.equal(projects[0]!.workspaceId, 'w2', 'lowest id seats it, as for any other project')
    assert.equal(projects[0]!.repository?.canonicalKey, 'github.com/acme/site')
    assert.equal(
      remoteProjectOfWorkspace(projects, workspaces, 'w5')?.folderPath,
      '/Users/dev/site',
      "a worktree chat's id resolves to its project",
    )
  })

  check('the chats started without a project are not a project', () => {
    const projects = remoteProjectsOf([
      chat('w1', 'loose', '/Users/dev/.sprintengine/chats/2026-10-10-hello-ab12cd34'),
      chat('w2', 'plain', '/Users/dev/app'),
    ])
    assert.deepEqual(
      projects.map((project) => project.folderPath),
      ['/Users/dev/app'],
    )
  })

  check('trailing slashes, backslashes and case are one folder', () => {
    const projects = remoteProjectsOf([
      chat('w1', 'a', '/srv/app/'),
      chat('w2', 'b', '/srv/App'),
      chat('w3', 'c', '\\srv\\app'),
    ])
    assert.equal(projects.length, 1)
    assert.equal(projects[0]!.conversationCount, 3)
  })

  check('a chat with no folder is not a project', () => {
    const projects = remoteProjectsOf([chat('w1', 'folderless', null), chat('w2', 'blank', '   ')])
    assert.deepEqual(projects, [], 'there is nowhere for a new chat to run, so there is no row to pick')
  })

  check('the repository is taken from whichever chat in the folder could answer', () => {
    const projects = remoteProjectsOf([chat('w1', 'a', '/srv/app', null), chat('w2', 'b', '/srv/app', repo('app'))])
    assert.equal(projects[0]!.repository?.canonicalKey, 'github.com/acme/app')
  })

  check('projects come back in name order', () => {
    const projects = remoteProjectsOf([
      chat('w1', 'a', '/srv/zebra'),
      chat('w2', 'b', '/srv/apple'),
      chat('w3', 'c', '/srv/mango'),
    ])
    assert.deepEqual(
      projects.map((project) => project.name),
      ['apple', 'mango', 'zebra'],
    )
  })

  check('a machine copy found by repository resolves to the folder it stands in', () => {
    const workspaces = [
      chat('w1', 'other', '/srv/other', repo('other')),
      chat('w2', 'sprintengine-air', '/srv/sprintengine', repo('sprintengine')),
    ]
    const projects = remoteProjectsOf(workspaces)
    const found = remoteProjectOfWorkspace(projects, workspaces, 'w2')
    assert.equal(found?.name, 'sprintengine')
    assert.equal(
      remoteProjectOfWorkspace(projects, workspaces, 'nope'),
      null,
      'an id the read no longer holds resolves to nothing',
    )
  })

  if (failures > 0) {
    console.error(`remoteProjects.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('remoteProjects.test.ts: ok')
})
