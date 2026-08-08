# ADR-0020: Private GitHub source build secret

- Status: Accepted
- Date: 2026-08-07
- Owners: Workspace runtime / sandbox service / infrastructure
- Affects: WS-2; temporary until M4 GitHub App delivery

## Context

The Modal image builder cannot anonymously clone the private `crossbizz/zapp`
repository, and Modal JS SDK 0.9.0 has no local-source upload primitive. WS-2
must build an exact advertised Git revision without placing a repository
credential in a command argument, URL, Git configuration, log, or image layer.

## Decision

Provision a Modal named Secret called `zapp-github-source-read` containing only
the required key `ZAPP_GITHUB_READ_TOKEN`. Its value is a fine-grained GitHub
personal access token limited to the selected repository `crossbizz/zapp` with
only `Contents: read` permission.

Expose this only as a provider-neutral source-fetch build capability. The Modal
JS SDK 0.9.0 provider implementation attaches the named Secret only to one
explicit source-fetch build layer. That layer uses `GIT_ASKPASS`; the token is
never placed in argv, the repository URL, Git configuration, logs, or a layer.
The fetch checks out the requested full commit SHA and asserts that
`git rev-parse HEAD` equals that exact SHA.

The immediately following layer has no Secret attached and proves the token is
unavailable. A real image smoke also proves no credential persists in process
environment, Git configuration, filesystem contents, logs, or image layers.

This is temporary until the M4 GitHub App can mint the source-read credential.
The human approved this decision on 2026-08-07 and provisioned the named Secret
in the `zapp-dev` environment before implementation began.
