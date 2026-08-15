# Local Docker Sandbox Development Design

**Date:** 2026-08-14

**Status:** Approved by the product owner in the 2026-08-14 local-development request

## Problem

The supported `pnpm local` path currently requires Modal credentials, verifies
the locked Modal images, and sends every workspace create to Modal. A developer
can sign in and create a run, but a Modal account limit makes the workspace
activity fail before the agent can edit files or start a preview. This prevents
the local product from reaching its prompt-to-preview path even though Docker is
already a required local dependency and a digest-pinned public Forge image is
published in `infra/modal/images.lock.json`.

The requested local alternative must not turn all users and projects into one
shared writable workspace. That would expose one project's source to another,
make branch locking meaningless, and let concurrent agents overwrite each
other.

## Decision

Add `SANDBOX_PROVIDER=modal|docker` at the sandbox provider boundary.

- `docker` is allowed only when `NODE_ENV` is `development` or `test`.
- `production` requires `modal` and fails environment validation for any other
  value.
- `pnpm local` defaults to `docker`; a developer may explicitly set
  `SANDBOX_PROVIDER=modal` to exercise the current provider-backed path.
- The control plane persists the selected provider on new workspace rows, so
  local records say `docker` rather than pretending to be Modal.
- No browser, worker, or control-plane route calls Docker directly. The existing
  sandbox-service API remains the only workspace boundary.

Modal remains the production provider and the real-provider milestone evidence
is not reclassified as local evidence.

## Isolation model

The local sandbox service creates one container per active project branch.
Containers may reuse one digest-pinned base image and one project cache volume,
but they never share a writable workspace filesystem.

Each workspace gets:

- a deterministic, branch-scoped container name that preserves the existing
  single-writer branch lock;
- a dedicated Docker bridge network;
- agent and preview ports published only on `127.0.0.1` with Docker-assigned host
  ports;
- a project-scoped cache volume mounted at `/cache`;
- an ephemeral `/workspace/<branchId>` filesystem restored from internal Git;
- only the current sandbox environment allowlist and workspace-agent token;
- the existing organization, project, branch, run, task, purpose, and environment
  tags as Docker labels.

The image is the `forge-node-base` public mirror from
`infra/modal/images.lock.json`, including its `sha256` digest. Startup pulls that
exact reference when it is absent and never uses `latest`.

## Provider behavior

The Docker adapter implements the existing workspace provider surface:

- create, attach, health, status, and terminate;
- agent HTTP requests and NDJSON execution streams;
- file, Git, search, and managed dev-server operations through workspace-agent;
- loopback preview tunnel resolution;
- project cache measurement;
- filesystem snapshots through immutable local Docker image IDs, used only as an
  acceleration and never as the source of truth.

The adapter applies structural network behavior available in local Docker:

- `dependency_install` and `build_test` use the workspace's isolated bridge;
- `restricted_verification` disconnects the workspace from that bridge, leaving
  only the loopback-published agent and preview ports reachable from the trusted
  host;
- reconnecting to a broader profile restores the same dedicated bridge.

Local Docker cannot enforce Modal's domain-level outbound allowlist. The service
must not record or report domain-filter evidence for Docker. Production keeps the
existing Modal enforcement unchanged.

## Data flow

1. The signed-in browser creates a project and run through the public control
   API.
2. The Temporal worker asks sandbox-service to create a workspace.
3. Sandbox-service selects the provider from validated environment, creates the
   Docker container, and clones the tenant's internal Forgejo branch using the
   existing short-lived token flow.
4. All agent tools continue through workspace-agent and sandbox-service.
5. The dev server starts in the container. The existing authenticated preview
   ingress proxies to the loopback Docker preview port.
6. Commits push to internal Git. Container termination cannot remove durable
   source or ordered events.

## Failure handling

- Docker absence, image pull failure, container boot failure, port discovery
  failure, and agent readiness failure name the failing component without
  including environment values.
- Partial creation removes the container and its dedicated network. The shared
  image and project cache volume remain reusable.
- Attach validates every persisted identity label before trusting an existing
  container.
- Termination is idempotent. A missing container is already terminated.
- A local snapshot that no longer exists returns absent and restoration falls
  back to internal Git.
- Modal credentials are neither required nor inspected in Docker mode.
- Docker mode records no Modal usage charge.

## Testing

Implementation follows red-green-refactor:

1. Environment tests prove provider selection, production refusal, and
   provider-specific credential requirements.
2. Adapter tests use a strict fake Docker command boundary and real HTTP servers
   for agent request/stream behavior.
3. One Docker integration test uses the digest-pinned public image to prove
   create, attach, exec, preview tunnel, isolation labels/network, and terminate.
4. Local supervisor tests prove Docker mode skips Modal verification, pulls the
   locked OCI image, and passes the provider to all relevant services.
5. Final signed-in browser QA on port 3000 submits a prompt, waits for a ready
   workspace, opens the authenticated preview, sends a follow-up change, and
   verifies the preview and internal Git commit.

## Acceptance criteria

- `pnpm local --no-open` reaches ready without Modal credentials when
  `SANDBOX_PROVIDER=docker` or the variable is absent.
- `SANDBOX_PROVIDER=modal` preserves the existing credential and immutable-image
  verification path.
- Production refuses Docker mode before listening.
- Two different project branches cannot read or write each other's workspace
  files.
- A signed-in user can submit a prompt and receive a working authenticated
  preview on port 3000 using the real API, Temporal worker, model gateway,
  Forgejo, and Docker sandbox.
- No raw container port, Docker identifier, provider credential, or Forgejo token
  reaches browser state or public API responses.
- The existing Modal provider tests and production composition remain green.
