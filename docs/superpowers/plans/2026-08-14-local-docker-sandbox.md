# Local Docker Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm local` run real project workspaces in isolated Docker containers while keeping Modal mandatory in production.

**Architecture:** Add a Docker implementation behind sandbox-service's existing provider interface, selected by a Zod-validated environment enum. Persist the selected provider in workspace rows, keep every agent operation on workspace-agent HTTP, and let the local supervisor pull the existing digest-pinned public image instead of validating Modal.

**Tech Stack:** TypeScript strict mode, Zod, Fastify, Docker CLI, PostgreSQL/Drizzle, Vitest, Temporal, Next.js.

## Global Constraints

- `SANDBOX_PROVIDER=docker` is allowed only for `NODE_ENV=development|test`; production requires `modal`.
- Docker calls remain inside `services/sandbox-service`, except the existing local supervisor preflight and image pull.
- One active project branch gets one container and one dedicated Docker bridge; no shared writable workspace container.
- The image reference comes from `infra/modal/images.lock.json` and includes a `sha256` digest.
- Browser and worker clients keep the existing public/internal API contracts and never receive provider credentials or raw provider origins.
- Internal Git remains the durable source of truth.

---

### Task 1: Validate and persist provider selection

**Files:**
- Modify: `services/sandbox-service/src/env.ts`
- Modify: `services/sandbox-service/src/runtime.ts`
- Modify: `services/sandbox-service/test/env.test.ts`
- Modify: `services/sandbox-service/test/runtime.test.ts`
- Modify: `services/sandbox-service/src/routes/workspaces.ts`
- Modify: `services/control-api/src/compose.ts`
- Modify: `services/control-api/src/env.ts`
- Modify: `services/control-api/src/server.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/test/app.test.ts`
- Modify: `services/control-api/test/integration/projects.test.ts`

**Interfaces:**
- Produces: `SandboxProviderSchema = z.enum(['modal', 'docker'])`
- Produces: `SandboxServiceEnv.provider: 'modal' | 'docker'`
- Produces: `ServiceEnv.SANDBOX_PROVIDER: 'modal' | 'docker'`
- Consumes: existing `WorkspaceLifecycleRowSchema` and tenant workspace repository

- [x] **Step 1: Write failing environment and persistence tests**

Add cases proving Docker mode accepts absent Modal credentials in development,
Modal mode requires them, production rejects Docker, the control-plane default is
Modal, and a Docker-configured tenant workspace insert persists `provider='docker'`.

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --filter @zapp/sandbox-service exec vitest run test/env.test.ts test/runtime.test.ts
pnpm --filter @zapp/control-api exec vitest run test/app.test.ts test/runs.test.ts
```

Expected: provider enum/field assertions fail because both services currently
require or persist Modal unconditionally.

- [x] **Step 3: Implement provider-specific Zod transforms and persistence**

Parse one provider enum in each service boundary, reject Docker in production,
make Modal credentials a discriminated requirement, pass the provider into
`createTenantDbFactory`, and widen the internal workspace row schema to the exact
two values.

- [x] **Step 4: Run focused tests GREEN**

Run the Step 2 commands and require zero failures.

### Task 2: Implement the isolated Docker provider

**Files:**
- Create: `services/sandbox-service/src/provider/docker.ts`
- Create: `services/sandbox-service/test/docker.test.ts`
- Create: `services/sandbox-service/test/integration/docker-provider.test.ts`
- Modify: `services/sandbox-service/src/runtime.ts`
- Modify: `services/sandbox-service/src/compose.ts`
- Modify: `services/sandbox-service/src/preview/transport.ts`
- Modify: `services/sandbox-service/src/provider/modal.ts`
- Modify: `services/sandbox-service/package.json`
- Modify: `services/sandbox-service/test/integration/modal-provider.test.ts`
- Modify: `services/sandbox-service/test/preview-auth.test.ts`
- Modify: `services/sandbox-service/test/production-compose.test.ts`
- Modify: `services/orchestrator-worker/src/activities/capability-scan-production.ts`
- Modify: `services/orchestrator-worker/src/activities/session.ts`
- Modify: `services/orchestrator-worker/src/env.ts`
- Modify: `services/orchestrator-worker/src/runtime/capability-scan-worker.ts`
- Modify: `services/orchestrator-worker/src/runtime/run-worker.ts`
- Modify: `services/orchestrator-worker/src/runtime/sandbox-client.ts`
- Modify: `services/orchestrator-worker/test/capability-scan-production.test.ts`
- Modify: `services/orchestrator-worker/test/integration/m1-run.test.ts`
- Modify: `services/orchestrator-worker/test/run-runtime.test.ts`
- Modify: `services/orchestrator-worker/test/sandbox-client.test.ts`

**Interfaces:**
- Produces: `createDockerSandboxProvider(options): WorkspaceAgentProvider`
- Produces: `DockerCommandPort.run(args, timeoutMs)`
- Consumes: `ModalWorkspaceSdkPort` only as the existing provider-neutral agent transport seam; it never constructs a Modal client
- Consumes: `imageLock.publicMirrors['forge-node-base']`
- Consumes: the provider-neutral worker workspace schema and Temporal activity heartbeat channel

- [x] **Step 1: Write failing command-boundary and HTTP transport tests**

Cover digest validation, dedicated network/container creation, loopback-only port
publishing, strict labels/env, attach label validation, request and NDJSON stream
forwarding, restricted-network disconnect/reconnect, snapshot ID mapping,
idempotent terminate, and cleanup after partial create.

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm --filter @zapp/sandbox-service exec vitest run test/docker.test.ts
```

Expected: import fails because `provider/docker.ts` does not exist.

- [x] **Step 3: Implement the minimum Docker adapter**

Use `execFile('docker', ...)` with fixed argument arrays and bounded output. Run
one container per branch on its own network, discover ports through `docker port`,
and forward trusted host HTTP to the workspace agent. Do not invoke a shell for
Docker control commands.

Propagate the selected provider through every worker boundary that reads a
workspace, preserve provider-specific network-policy evidence, allow HTTP preview
transport only for a loopback Docker tunnel, prefer IPv4 in local Vite processes,
and send native Temporal heartbeats in addition to the durable checkpoint
acknowledgement so a real build remains alive past the activity heartbeat timeout.

- [x] **Step 4: Run unit tests GREEN, then the real Docker integration**

Run:

```bash
pnpm --filter @zapp/sandbox-service exec vitest run test/docker.test.ts
ZAPP_DOCKER_LIVE=1 pnpm --filter @zapp/sandbox-service exec vitest run test/integration/docker-provider.test.ts
```

The integration test must visibly skip when Docker is unavailable; it may not be
reported as a pass in that case.

### Task 3: Make `pnpm local` select Docker and pull the locked image

**Files:**
- Modify: `scripts/local/config.mjs`
- Modify: `scripts/local/supervisor.mjs`
- Modify: `scripts/local.test.mjs`
- Modify: `scripts/local-smoke.test.mjs`
- Modify: `.env.example`
- Modify: `docs/dev-setup.md`

**Interfaces:**
- Produces: `loadLocalConfig().sandboxProvider`
- Consumes: `imageLock.publicMirrors['forge-node-base']`

- [x] **Step 1: Write failing local-config and supervisor tests**

Prove Docker is the absent-variable default, Docker mode does not require or
redact Modal credentials, Modal mode preserves its current preflight, Docker mode
pulls the pinned image and skips Modal verification, and all application children
receive the provider value.

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
node --test scripts/local.test.mjs scripts/local-smoke.test.mjs
```

Expected: missing Modal credentials still fail and image verification still calls
the Modal publisher.

- [x] **Step 3: Implement conditional preflight and image pull**

Read the provider from the merged local environment, default it to Docker, pass it
to control-api and sandbox-service, and run `docker image inspect` followed by
`docker pull` only when the locked image is absent.

- [x] **Step 4: Run local tests GREEN**

Run the Step 2 command and require zero failures.

### Task 4: Verify the product path and record project bookkeeping

**Files:**
- Create: `docs/adr/0033-local-docker-sandbox-provider.md`
- Create: `docs/superpowers/specs/2026-08-14-local-docker-sandbox-design.md`
- Create: `docs/superpowers/plans/2026-08-14-local-docker-sandbox.md`
- Modify: `docs/plans/00-master-plan.md`
- Modify: `tasks/todo.md`
- Modify: `tasks/lessons.md` only if the live entry point exposes a durable new lesson

**Interfaces:**
- Consumes: `pnpm local --no-open`, public `/v1` APIs, authenticated preview ingress, internal Forgejo

- [x] **Step 1: Run package gates**

```bash
pnpm --filter @zapp/sandbox-service lint
pnpm --filter @zapp/sandbox-service typecheck
pnpm --filter @zapp/sandbox-service build
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
pnpm --filter @zapp/control-api build
```

- [x] **Step 2: Start the actual local entry point on port 3000**

Stop only this task's existing supervised application processes, then run:

```bash
SANDBOX_PROVIDER=docker pnpm local --no-open
```

Require every service readiness check to pass.

- [x] **Step 3: Run signed-in browser acceptance**

Using the existing Stytch session, submit a prompt, wait for the run to create a
Docker workspace and ready preview, send one follow-up change, and verify a new
internal Git commit. Capture console errors and desktop/mobile screenshots.

- [x] **Step 4: Run cold repository verification**

```bash
pnpm verify:cold
```

- [x] **Step 5: Commit**

Stage only the files named in Tasks 1-4, excluding any unrelated desktop changes.
Append a dated `M1-GATE-17-FIX-1` execution-log line and check only that fix task;
leave `M1-GATE-17` itself unchecked until its required Modal evidence exists.

```bash
git commit -m "feat(local): add isolated Docker sandboxes"
```
