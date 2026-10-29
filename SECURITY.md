# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately, not as a public issue.

Use GitHub's private vulnerability reporting on this repository:

<https://github.com/conal-smith/sprintengine/security/advisories/new>

That form is the only channel for security reports. There is no security
mailing address for this project, so please do not send reports by email.

When you report, it helps to include:

- what an attacker can do, and what they need in order to do it;
- the version or commit you tested against, and your operating system;
- the steps to reproduce it, and a proof of concept if you have one.

You will get an acknowledgement, and the report is kept private until a fix
ships. If you would like credit in the advisory, say so and give the name you
would like used.

## Supported versions

Only the latest release receives security fixes. Older releases are not
patched; upgrading to the current release is the supported remedy.

## Scope

In scope:

- **The desktop app** — the Electron main, preload, renderer and shared code in
  `src/`, and its packaging and update path.
- **The module SDK** in `packages/module-sdk/`, including module manifest
  parsing, the permission model, and module and plugin signature verification.
- **The studio plugin** in `resources/studio-plugin/`, and the MCP surface it
  exposes to agents.

Findings that are especially welcome: sandbox or permission escapes from a
module or plugin into the host, agent output or workspace file content that
reaches a privileged code path, credential and token handling, IPC boundaries
between renderer and main, and anything that lets a workspace repository
execute code without the user having agreed to it.

Out of scope:

- The third-party agent CLIs the app launches. Report those to their own
  maintainers.
- Modules, plugins and automations written by users or third parties, unless
  the flaw is in the SDK or host that is supposed to contain them.
- The sprintengine.ai website and any hosted service, which are not in this
  repository.
- Findings that need an attacker who already has local access to an unlocked
  machine and the user's account.
