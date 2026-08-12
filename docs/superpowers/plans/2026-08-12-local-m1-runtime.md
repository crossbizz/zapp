# Local M1 Prompt-to-Preview Runtime Implementation Plan

> **For the implementing agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Apply superpowers:test-driven-development to every behavior change and superpowers:verification-before-completion before any completion claim.

**Goal:** Make the real zapp.build M1 browser journey runnable locally with one fail-closed command: Stytch sign-in, prompt, durable Builder run, Anthropic completion through model-gateway, Modal workspace, authenticated preview, follow-up edit, internal Git commits, and restore after terminating the active sandbox.

**Architecture:** Add the missing deployment compositions rather than a fixture path. A Node supervisor starts existing local infrastructure and the real service graph. Sandbox-service owns Modal plus a PostgreSQL-fenced capacity governor. The `agent-runs` Temporal worker composes the existing M1 workflow, session loop, model-gateway client, sandbox-backed `WorkspaceRuntime`, structured event publisher, and Git commit boundary. Control-api selects this M1 workflow only through an explicit development-only runtime profile; browser clients continue to use public `/v1` APIs and authenticated preview ingress.

**Tech Stack:** Node.js 22, pnpm 9.15, TypeScript strict mode, Zod 3, Fastify 5, Drizzle/PostgreSQL, Temporal 1.22, Modal SDK 0.9 (sandbox-service only), model-gateway HTTP/SSE, Next.js 15, Vitest, Playwright, Docker Compose.

**Approved design:** `docs/superpowers/specs/2026-08-12-local-m1-runtime-design.md`

## Binding constraints

- Work from current `upstream/main`; preserve unrelated local modifications in the original worktree.
- Never import Modal outside `services/sandbox-service` or a model-provider SDK outside `services/model-gateway`.
- Validate every new environment, HTTP, persistence, and process boundary with Zod.
- Keep the browser on generated public `/v1` SDK/API operations and zapp-owned authenticated preview routes; add no UI-private backend.
- Use scoped service tokens with explicit service/audience allowlists. Never expose provider keys, raw Modal URLs, or Forgejo credentials to the browser, events, or logs.
- Preserve idempotency keys on every mutation. Cross-tenant reads remain 404.
- Consume `infra/modal/images.lock.json`; do not build or republish images.
- Run the real Stytch/Anthropic/Modal gate exactly once, after all local tests and review are complete.
- One independent/self-contained review round exits only when there is no correctness defect or missing structural control. One fix round is the cap.
- This expanded gate may use the per-slice commits listed below. The final slice checks `tasks/todo.md` and appends the master-plan execution log in that same commit.

## Task 1: Register the live M1 gate and deploy the durable sandbox governor

**Files:**

- Modify: `docs/plans/00-master-plan.md`
- Modify: `tasks/todo.md`
- Modify: `packages/db/src/schema/execution.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/drizzle/0035_sandbox_capacity.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify/generated: `packages/db/drizzle/meta/0035_snapshot.json`
- Modify: `services/sandbox-service/src/compose.ts`
- Create: `services/sandbox-service/src/state/capacity.ts`
- Create: `services/sandbox-service/test/database-capacity.test.ts`

**Interfaces:**

```ts
export const sandboxCapacityAdmissions: PgTable;

export function createSandboxCapacityRepository(
  database: Database,
): GovernorCapacityPort;
```

The durable row is keyed by `workspace_id`; it stores tenant/project/run/task/purpose, the original operation key and decision, requested/deadline timestamps, active/released state, and nullable expiry lease owner/token/time. The migration supplies uniqueness for the immutable operation key and indexes for active global, active organization, and expired-unleased scans.

### Step 1.1: Add the unchecked gate contract

Add `M1-GATE-17 — Runnable local prompt-to-preview exit` under master-plan M1 gate repairs with this plan's Files, interfaces, exact verification commands, acceptance criteria, and prescribed final commit. `M1-GATE-16` was assigned after this expansion was authored, so the next available identifier and migration sequence are binding. Add an unchecked tracker line. Do not change any existing checkbox.

### Step 1.2: Write failing capacity tests

Tests must prove against real PostgreSQL:

1. `claim` atomically enforces global and organization limits under concurrent calls.
2. Same operation key replays the same deadline after release; a conflicting identity fails closed.
3. Queue position counts earlier active admissions deterministically.
4. `release` is tenant-scoped and idempotent.
5. `claimExpired` uses `FOR UPDATE SKIP LOCKED`, leases at most the requested limit, and never double-claims.
6. `renewExpired`, `completeExpired`, and `releaseExpired` require the exact durable lease token.
7. `listOrganization` cannot return another tenant's row.

Run:

```bash
pnpm --filter @zapp/sandbox-service exec vitest run test/database-capacity.test.ts
```

Expected RED: module/export or relation does not exist; no assertion may pass through an in-memory fake.

### Step 1.3: Implement the schema, migration, and adapter

Generate the Drizzle migration, then implement all `GovernorCapacityPort` methods as database transactions. Serialize the two limit counts with transaction-scoped PostgreSQL advisory locks ordered global then organization; persist the decision before returning. Parse inputs and outputs using exported governor schemas rather than duplicating types. If required, export those schemas from `lifecycle/governor.ts` without changing accepted values.

Run the migration and focused test until green:

```bash
pnpm db:migrate
pnpm --filter @zapp/sandbox-service exec vitest run test/database-capacity.test.ts
pnpm --filter @zapp/db lint
pnpm --filter @zapp/db typecheck
pnpm --filter @zapp/db build
```

### Step 1.4: Bind it at sandbox composition

Change `composeSandboxApp` so its deployable contract accepts the database and creates the durable capacity adapter internally. Tests may inject a capacity port only through a clearly named `testOnlyCapacity` option that throws when `NODE_ENV !== 'test'`. Update `production-compose.test.ts` to prove production composition cannot use a process-local counter or omitted capacity store.

Run:

```bash
pnpm --filter @zapp/sandbox-service exec vitest run test/database-capacity.test.ts test/production-compose.test.ts
```

### Step 1.5: Commit

```bash
git add docs/plans/00-master-plan.md tasks/todo.md packages/db services/sandbox-service/src/compose.ts services/sandbox-service/src/lifecycle/governor.ts services/sandbox-service/src/state/capacity.ts services/sandbox-service/test/database-capacity.test.ts services/sandbox-service/test/production-compose.test.ts
git commit -m "feat(sandbox): persist local capacity admission"
```

The tracker remains unchecked.

## Task 2: Add a deployable sandbox-service process

**Files:**

- Create: `services/sandbox-service/src/env.ts`
- Create: `services/sandbox-service/src/runtime.ts`
- Create: `services/sandbox-service/src/server.ts`
- Create: `services/sandbox-service/src/network/postgres.ts`
- Create: `services/sandbox-service/src/internal/control-api.ts`
- Create: `services/sandbox-service/test/env.test.ts`
- Create: `services/sandbox-service/test/runtime.test.ts`
- Modify: `services/sandbox-service/src/app.ts`
- Modify: `services/sandbox-service/package.json`
- Modify: `.env.example`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
export const SandboxServiceEnvSchema: ZodType<SandboxServiceEnv>;
export function loadSandboxServiceEnv(source?: unknown): SandboxServiceEnv;
export function composeSandboxRuntime(env: SandboxServiceEnv): Promise<SandboxRuntime>;
export async function runSandboxServer(source?: unknown): Promise<void>;
```

`SandboxRuntime` exposes `{ app, startBackgroundWork(), close() }`. `close()` aborts reconciliation, stops the governor/reaper/preview monitors, closes HTTP, then closes database clients. `/healthz` returns `{ status: 'ok', service: 'sandbox-service' }` only after composition; it performs no provider mutation.

### Step 2.1: Write failing env and composition tests

Cover missing variable names without values, placeholder rejection, locked-image/environment mismatch, bind host/port, shallow health, scoped service-token verification, PostgreSQL state/capacity/network audit binding, Modal provider binding, git/control-api internal clients, background start once, and reverse-order shutdown once.

Required environment names:

```text
NODE_ENV SANDBOX_HOST SANDBOX_PORT DATABASE_URL
CONTROL_API_INTERNAL_URL GIT_SERVICE_URL
SERVICE_TOKEN_SECRET SERVICE_TOKEN_ISSUER
MODAL_TOKEN_ID MODAL_TOKEN_SECRET MODAL_ENVIRONMENT
SANDBOX_GLOBAL_LIMIT SANDBOX_OWNER_ID
```

Image identifiers come from `infra/modal/images.lock.json`, never env strings. Run the focused tests and retain the expected missing-module failures.

### Step 2.2: Implement concrete production bindings

- Read the immutable `forge-node-base` record and require its environment to equal `MODAL_ENVIRONMENT`.
- Use `createPostgresWorkspaceStateStore` and the Task 1 capacity adapter.
- Persist each network-policy application as an append-only structured audit event; no noop recorder is allowed in runtime composition.
- Sign outbound service tokens for `sandbox-service` with the exact destination audience.
- Use existing internal control-api routes for secret decrypt, events, and usage. If one required route is absent, add only the versioned/internal service boundary already owned by control-api, with Zod and explicit sandbox-service claims; do not access control-plane secret tables directly.
- Use git-service for short-lived checkout/push credentials.
- Start the existing reconciler/governor/preview monitor loops only after the Fastify app is listening.

### Step 2.3: Add process scripts and verify

Add `dev` (tsx watch), `start` (built server), and any direct dependencies. Do not embed secrets in scripts.

```bash
pnpm --filter @zapp/sandbox-service exec vitest run test/env.test.ts test/runtime.test.ts test/production-compose.test.ts
pnpm --filter @zapp/sandbox-service lint
pnpm --filter @zapp/sandbox-service typecheck
pnpm --filter @zapp/sandbox-service build
git add .env.example pnpm-lock.yaml services/sandbox-service
git commit -m "feat(sandbox): add deployable local service"
```

## Task 3: Implement the sandbox-backed cloud WorkspaceRuntime

**Files:**

- Create: `services/orchestrator-worker/src/runtime/sandbox-client.ts`
- Create: `services/orchestrator-worker/test/sandbox-client.test.ts`
- Modify: `services/sandbox-service/src/routes/workspaces.ts`
- Modify: `services/sandbox-service/src/provider/modal.ts`
- Modify: `services/sandbox-service/test/integration/modal-provider.test.ts`
- Modify: `services/sandbox-service/test/integration/git-clone.test.ts`
- Modify: `services/orchestrator-worker/package.json`

**Interfaces:**

```ts
export interface SandboxWorkspaceClientOptions {
  baseUrl: string;
  serviceTokens: ServiceTokenConfig;
  organizationId: string;
  projectId: string;
  workspaceId: string;
  fetch?: typeof fetch;
}

export function createSandboxWorkspaceRuntime(
  options: SandboxWorkspaceClientOptions,
): WorkspaceRuntime;
```

### Step 3.1: Write the failing conformance tests

Run the shared `WorkspaceRuntime` contract against a fake HTTP server, plus explicit tests for:

- `orchestrator-worker -> sandbox-service` audience and exact allowed-service checks;
- organization/project headers on every request;
- operation/idempotency keys on mutations;
- Zod rejection of malformed responses;
- abort propagation and bounded request deadlines;
- safe error mapping with no raw response body or credential leakage;
- file, exec, Git, dev-server, logs, preview, health, attach, and terminate routes.

Expected RED is missing client/routes or 401 from the current control-api-only allowlist.

### Step 3.2: Implement the adapter and service allowlist

Map the complete `WorkspaceRuntime` interface to existing `/internal/workspaces/...` routes. Extend only worker-required routes to accept `orchestrator-worker`; keep preview-session issuance and browser preview bridging restricted to control-api. The service identity list is code-owned and exhaustively tested.

### Step 3.3: Verify and commit

```bash
pnpm --filter @zapp/orchestrator-worker exec vitest run test/sandbox-client.test.ts
pnpm --filter @zapp/sandbox-service exec vitest run test/integration/modal-provider.test.ts
pnpm --filter @zapp/orchestrator-worker lint
pnpm --filter @zapp/orchestrator-worker typecheck
pnpm --filter @zapp/orchestrator-worker build
git add pnpm-lock.yaml services/orchestrator-worker services/sandbox-service/src/routes/workspaces.ts services/sandbox-service/test/integration/modal-provider.test.ts
git commit -m "feat(worker): add sandbox workspace runtime"
```

## Task 4: Compose the real M1 Builder session

**Files:**

- Create: `services/orchestrator-worker/src/runtime/model-gateway-client.ts`
- Create: `services/orchestrator-worker/src/runtime/m1-session.ts`
- Create: `services/orchestrator-worker/src/runtime/unavailable-ports.ts`
- Create: `services/orchestrator-worker/test/model-gateway-client.test.ts`
- Create: `services/orchestrator-worker/test/m1-session.test.ts`
- Modify: `services/orchestrator-worker/package.json`
- Modify: `services/orchestrator-worker/src/session/loop.ts`
- Modify: `packages/agent-policies/src/approval.ts`
- Modify: `packages/agent-policies/test/policies.test.ts`
- Create: `docs/adr/0031-network-profiled-builder-provenance.md`

**Interfaces:**

```ts
export function createModelGatewaySessionGateway(options: {
  baseUrl: string;
  serviceTokens: ServiceTokenConfig;
  fetch?: typeof fetch;
}): SessionGateway;

export function createM1BuilderSessionRunner(options: {
  gateway: SessionGateway;
  runtime: WorkspaceRuntime;
  events: SessionEventPublisher;
  approvals: ApprovalPort;
  prompts: RolePromptRegistry;
  redactor: Redactor;
  tokenCounter: TokenCounter;
}): BuilderSessionRunner;
```

### Step 4.1: Test the model-gateway boundary first

Prove the client posts the existing completion schema to `/internal/v1/complete`, authenticates as `orchestrator-worker`, parses the full SSE terminal envelope, maps cancellation, and fails on malformed/ambiguous terminal output. Never import a provider SDK.

### Step 4.2: Test the session composition first

With a scripted model-gateway server and memory/fake runtime, prove an ordinary build prompt can:

1. inspect the repository;
2. write files only through registered tools;
3. install/run commands under existing policy;
4. start the dev server and wait for health;
5. emit structured assistant/tool/preview events;
6. resume a checkpointed transcript for a follow-up edit;
7. reject release/integration/browser tools that are outside M1 with typed unavailable results, not permissive mocks.

Build the exact `ToolRegistry` with all contract names. Bind M1-required workspace/dev-server/preview ports to the sandbox runtime and bind out-of-scope ports to code-owned fail-closed adapters. Construct session context from Zod-owned `ContextSection` values; do not derive authorization from prompt text.

### Step 4.3: Verify and commit

```bash
pnpm --filter @zapp/orchestrator-worker exec vitest run test/model-gateway-client.test.ts test/m1-session.test.ts
pnpm --filter @zapp/orchestrator-worker lint
pnpm --filter @zapp/orchestrator-worker typecheck
pnpm --filter @zapp/orchestrator-worker build
git add pnpm-lock.yaml services/orchestrator-worker
git commit -m "feat(worker): compose M1 builder session"
```

## Task 5: Add the deployable `agent-runs` worker and development-only M1 routing

**Files:**

- Create: `services/orchestrator-worker/src/env.ts`
- Create: `services/orchestrator-worker/src/runtime/run-worker.ts`
- Create: `services/orchestrator-worker/src/run-server.ts`
- Create: `services/orchestrator-worker/test/run-runtime.test.ts`
- Modify: `services/orchestrator-worker/package.json`
- Modify: `services/control-api/src/env.ts`
- Modify: `services/control-api/src/server.ts`
- Modify: `services/control-api/src/compose.ts`
- Modify: `services/orchestrator-worker/src/worker.ts`
- Modify: `services/control-api/test/compose.test.ts`
- Modify: `.env.example`

**Interfaces:**

```ts
export const RunWorkerEnvSchema: ZodType<RunWorkerEnv>;
export function composeRunWorker(env: RunWorkerEnv): Promise<RunWorkerRuntime>;
export function createLocalM1TemporalOrchestrator(options: {
  client: Pick<Client, 'workflow'>;
}): TemporalOrchestrator;
```

`createLocalM1TemporalOrchestrator` targets the production `agent-runs` queue but selects the AR-8 single-Builder workflow for Build. It must throw unless an explicit `RUN_WORKFLOW_PROFILE=m1` is combined with `NODE_ENV=development`. Default and production continue to select the dedicated Build workflow.

### Step 5.1: Write failing routing and runtime tests

Prove:

- `m1` profile is rejected in production/test and cannot be inferred from a prompt;
- default production routing remains unchanged;
- runtime composes PostgreSQL activity idempotency, durable events/status, workspace activities, approvals, Task 4 session activities, Temporal native connection, and `agent-runs` queue;
- worker readiness is printed only after Temporal pollers start;
- SIGTERM drains the worker and closes clients once;
- a real local Temporal integration creates a project/run fixture, executes a scripted Builder turn, kills/restarts the worker process, resumes the heartbeat transcript, and records one idempotent commit result and ordered structured events.

### Step 5.2: Implement the composition

Use existing `createEventActivities`, `createSessionActivities`, `createWorkspaceActivities`, `createApprovalActivities`, and `createProductionRunWorker`. Activity adapters call scoped service HTTP boundaries for workspace/Git and tenant repositories for durable run/event state. No activity writes a success event until its downstream mutation is durably confirmed.

Required worker env names:

```text
NODE_ENV DATABASE_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE
CONTROL_API_INTERNAL_URL MODEL_GATEWAY_URL SANDBOX_SERVICE_URL GIT_SERVICE_URL
SERVICE_TOKEN_SECRET SERVICE_TOKEN_ISSUER RUN_WORKFLOW_PROFILE
```

### Step 5.3: Verify and commit

```bash
pnpm --filter @zapp/orchestrator-worker exec vitest run test/run-runtime.test.ts
pnpm --filter @zapp/control-api exec vitest run test/compose.test.ts
pnpm --filter @zapp/orchestrator-worker test:integration
pnpm --filter @zapp/orchestrator-worker lint
pnpm --filter @zapp/orchestrator-worker typecheck
pnpm --filter @zapp/orchestrator-worker build
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
pnpm --filter @zapp/control-api build
git add .env.example pnpm-lock.yaml services/orchestrator-worker services/control-api/src/compose.ts services/control-api/src/env.ts services/control-api/src/server.ts services/control-api/test/compose.test.ts
git commit -m "feat(worker): deploy the local M1 run worker"
```

## Task 6: Implement the fail-closed local supervisor

**Files:**

- Create: `scripts/local/config.mjs`
- Create: `scripts/local/process.mjs`
- Create: `scripts/local/supervisor.mjs`
- Create: `scripts/local.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**

```js
export function loadLocalConfig({ cwd, env, argv }) {}
export function createProcessSupervisor(options) {}
export async function runLocal(options) {}
```

### Step 6.1: Write failing Node tests

Use `node:test` with injected process, port, HTTP, Docker, and browser-open adapters. Cover:

- Node/pnpm/Docker/Compose/version checks;
- root `.env` loading without value logging;
- placeholder/missing Stytch, Anthropic, and Modal variable classification;
- exact port conflict reporting;
- locked dev image presence and environment validation;
- dependency DAG order and readiness polling without sleeps;
- `NEXT_PUBLIC_CONTROL_API_URL=http://127.0.0.1:4000` passed explicitly to web;
- `--no-open` and default browser open;
- prefixed, redacted, bounded log tails;
- required-child crash propagation and nonzero exit;
- Ctrl-C reverse-order child shutdown with zero exit;
- never executing `docker compose down`, deleting volumes, rebuilding images, or printing env values.

Run and retain RED:

```bash
node --test scripts/local.test.mjs
```

### Step 6.2: Implement preflight and orchestration

Preflight, then run `scripts/dev-up.sh`, `pnpm db:migrate`, and required package builds. Start and await:

```text
git-service:4100/healthz
model-gateway:4200/healthz
sandbox-service:4400/healthz
agent-runs worker ready line
verification worker ready line
control-api:4000/healthz
web:3000/login
```

Write no generated configuration containing secrets. Use a new process group and explicit signals. Preserve Docker services on all exits.

### Step 6.3: Verify and commit

```bash
node --test scripts/local.test.mjs
pnpm lint:architecture
git add .gitignore package.json scripts/local scripts/local.test.mjs
git commit -m "feat(local): supervise the M1 platform"
```

## Task 7: Add local smoke and real live acceptance runners

**Files:**

- Create: `scripts/local-smoke.test.mjs`
- Create: `scripts/m1-live.mjs`
- Create: `scripts/m1-live.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `docs/dev-setup.md`

**Interfaces:**

```js
export async function runM1Live(options) {}
```

Evidence is written under ignored `.artifacts/m1-live/<timestamp>.json` with entity IDs, commit SHAs, ordered event sequence numbers, screenshot paths, and provider/resource identifiers safe for developer logs. It contains no token, key, raw credential, or raw Modal URL.

### Step 7.1: Write failing harness tests

Prove the live runner:

- refuses fixture/session-bypass flags and missing credentials;
- waits for an authenticated browser session without pretending sign-in was automated;
- drives only the web UI/public `/v1` API for user actions;
- creates a unique prompt, waits for preview health, and verifies visible unique content;
- records the first internal Git commit SHA;
- submits a unique follow-up edit and verifies a different commit plus refreshed preview;
- terminates the active sandbox through the public authenticated workspace API;
- waits for replacement workspace/preview and proves source/event continuity;
- rejects missing/duplicate/out-of-order evidence and exits nonzero;
- redacts output and evidence files.

### Step 7.2: Implement local-process smoke

Start the full supervisor with injected seam providers and ephemeral ports, assert every readiness contract and clean shutdown, and make zero external provider calls. This is process wiring validation, not the M1 acceptance substitute.

### Step 7.3: Implement the interactive live runner and docs

Use Playwright's persistent browser context. Open `/login`, tell the developer once when Stytch interaction is required, then continue when the authenticated session exists. Use generated SDK helpers for API reads/assertions and DOM actions for the prompt/edit journey. Query Forgejo only through git-service's scoped boundary. Kill the Modal workspace only through the public API. Document:

```bash
pnpm local
pnpm local --no-open
pnpm test:m1:live
```

Include prerequisites, URLs, stop/retry behavior, which provider credentials are required, and named troubleshooting failures. Never include secret values.

### Step 7.4: Verify and commit

```bash
node --test scripts/m1-live.test.mjs scripts/local-smoke.test.mjs
pnpm --filter @zapp/web test
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
pnpm --filter @zapp/web build
git add .gitignore package.json docs/dev-setup.md scripts/local-smoke.test.mjs scripts/m1-live.mjs scripts/m1-live.test.mjs
git commit -m "test(m1): add live prompt-to-preview gate"
```

## Task 8: Static gate, capped review, single live acceptance, and bookkeeping

**Files:**

- Modify only if required by review: files already listed in Tasks 1–7
- Modify: `tasks/todo.md`
- Modify: `docs/plans/00-master-plan.md`

### Step 8.1: Run all non-provider verification

Run this phase with `ANTHROPIC_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and all Stytch secret variables absent from the command environment, so credential-gated suites skip visibly and no review round consumes the single live-provider allowance. The local-process smoke uses only injected seam providers.

```bash
node --test scripts/local.test.mjs scripts/local-smoke.test.mjs scripts/m1-live.test.mjs
pnpm --filter @zapp/db test
pnpm --filter @zapp/sandbox-service test
pnpm --filter @zapp/orchestrator-worker test
pnpm --filter @zapp/control-api test
pnpm lint
pnpm typecheck
pnpm build
env -u ANTHROPIC_API_KEY -u MODAL_TOKEN_ID -u MODAL_TOKEN_SECRET -u STYTCH_SECRET -u STYTCH_PROJECT_ID pnpm verify
```

Record trailing output. Any failure remains a failure; use systematic debugging before editing.

### Step 8.2: Run one bounded review round

Review the full diff for correctness, tenant boundaries, idempotency, credential containment, process lifecycle, event truth, and provider-boundary architecture. Exit when no correctness or structural-control finding remains. Apply at most one fix round and rerun all affected local suites. Do not spend provider calls during review.

### Step 8.3: Run the real providers exactly once

With the supervisor ready and the approved development credentials present:

```bash
pnpm test:m1:live
```

The command must prove every approved-design acceptance item, including two distinct Git commits and replacement after explicit Modal sandbox termination. If it fails, report the exact failed assertion and keep the gate unchecked; do not re-label it a smoke pass and do not automatically rerun provider calls.

### Step 8.4: Finish tracker and execution log only after success

Check only `M1-GATE-17` in `tasks/todo.md`. Check its master-plan steps and append:

```text
2026-08-13 M1-GATE-17 done — Local supervisor, deployable sandbox/run-worker compositions, and the one real Stytch/Anthropic/Modal prompt-to-preview/edit/restore gate passed; <blockers/deviations or none>.
```

Then run:

```bash
git diff --check
git status --short
git commit -am "feat(local): ship runnable M1 prompt-to-preview"
```

## Final acceptance

- `pnpm local --no-open` reaches ready from a healthy current clone with valid M1 credentials.
- `pnpm local` opens the real web login only after every required process is ready.
- An ordinary prompt creates a real project and Forgejo repo, runs a real Anthropic-backed Builder in a real locked-image Modal workspace, and renders an authenticated preview beside chat.
- A follow-up edit creates a second internal Git commit and changes the preview.
- Explicit sandbox termination followed by another action creates/reuses a replacement workspace and restores from durable Git/control-plane/Temporal state without losing ordered events.
- Browser traffic contains no provider credential or raw Modal URL.
- Missing dependencies, child crashes, provider failures, and failed assertions exit nonzero with a redacted named failure.
- Full local verification is green, the single live evidence file exists, and `M1-GATE-17` is checked in the final code commit.
