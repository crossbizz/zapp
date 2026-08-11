# WEB-4 Dependency Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the missing project-summary and GitHub import contracts, generate them into `@zapp/api-client`, and complete WEB-4 without inferred state or browser-private APIs.

**Architecture:** The existing paginated project list remains the source of project identity. A tenant-scoped batch summary endpoint projects durable events/releases into dashboard state. GitHub installation and discovery use a platform GitHub App behind injected ports; verified webhooks and imports are durably owned by PostgreSQL outboxes and DLQ-backed SQS queues. The web app consumes only generated operations and gates every visible state/action on API data.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle/PostgreSQL, Redis, AWS SQS/LocalStack, Octokit REST 20.1.2, Forgejo, OpenAPI/openapi-typescript, React 19, Next.js 15, Playwright, Vitest.

## Global Constraints

- Master plan Global Constraints 1–20 apply unchanged.
- API first: no web fetch or handwritten response type may bypass `@zapp/api-client`.
- `GET /v1/projects` remains keyset-paginated and response-compatible with WEB-4 Slice A.
- Project summary values come only from user-visible events, release/deployment rows, and authoritative release readiness.
- Cross-tenant project, installation, repository, branch, and import reads return 404.
- GitHub App keys, webhook secrets, OAuth material, and installation tokens never enter responses, events, fixtures, audit metadata, or logs.
- GitHub callback state is random, actor/organization-bound, expires after 10 minutes, and is consumed atomically.
- Webhook and import mutations are durable and idempotent; no clone, mirror, scan, or enqueue guarantee depends on one process remaining alive.
- GitHub import never force-pushes and never overwrites a nonmatching internal branch head or external repository reference.
- Zod owns every service boundary and TypeScript types are inferred from schemas.
- Review is capped at two local rounds. The credential-gated real GitHub check runs once, after local review closure.

---

### Task 1: Accept ADR-0028 and bind the dependency pull-forward

**Files:**
- Create: `docs/adr/0028-web-4-public-summary-and-durable-github-import.md`
- Modify: `docs/plans/02-control-plane.md`
- Modify: `docs/plans/06-git-and-integrations.md`
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`
- Modify: `docs/superpowers/plans/2026-08-10-web-4-dependency-completion.md`

**Interfaces:**
- Produces: task `CP-21 [M1 pull-forward]: Project dashboard summary read model`.
- Produces: the exact routes and schemas approved in `docs/superpowers/specs/2026-08-10-web-4-dependency-completion-design.md`.
- Produces: tracker order `CP-21 → INT-1 → INT-2 → WEB-4`; removes the duplicate INT-1/INT-2 entries from their former M4 position.

- [x] **Step 1: Write ADR-0028**

Record context, decision, alternatives, consequences, exact route names, exact public states, SQS queue names, and the accepted Files-list expansions. Mark the ADR `Accepted`, date it `2026-08-10`, and cite the user's instruction to self-audit and execute without another approval gate.

- [x] **Step 2: Add CP-21 to Plan 02**

Add a binding task whose interface is:

```ts
GET /v1/projects/summaries?projectId=<proj>&projectId=<proj>
// 200 { summaries: ProjectDashboardSummary[] }
```

Name every control API, database index, generated SDK, and test file from Task 2 below in its Files block. Specify the commit message `feat(control-api): public project dashboard summaries`.

- [x] **Step 3: Expand INT-1/INT-2 and WEB-4 Files/Interfaces**

Copy Task 3's installation/discovery/webhook interfaces and Task 4's durable import interfaces into Plan 06. Update Plan 08 so Slice B consumes CP-21 and Slice C consumes the generated INT-1/INT-2 operations. Preserve all existing completed Slice A checkboxes.

- [x] **Step 4: Reorder the authoritative tracker**

Place unchecked CP-21, INT-1, and INT-2 immediately before unchecked WEB-4 in `tasks/todo.md`; remove INT-1 and INT-2 from the M4 block so each task appears once.

- [x] **Step 5: Verify and commit the decision**

Run:

```bash
rg -n 'CP-21|INT-1|INT-2|WEB-4|/v1/projects/summaries|zapp-github-imports' \
  docs/adr/0028-web-4-public-summary-and-durable-github-import.md \
  docs/plans/{02-control-plane,06-git-and-integrations,08-web-ux}.md tasks/todo.md
git diff --check
```

Expected: each task appears once in the tracker, all route/queue names match the design spec, and `git diff --check` emits no output.

```bash
git add docs/adr/0028-web-4-public-summary-and-durable-github-import.md \
  docs/plans/02-control-plane.md docs/plans/06-git-and-integrations.md \
  docs/plans/08-web-ux.md tasks/todo.md \
  docs/superpowers/plans/2026-08-10-web-4-dependency-completion.md
git commit -m "docs(adr): pull forward WEB-4 public dependencies"
```

### Task 2: CP-21 project dashboard summary read model

**Files:**
- Create: `services/control-api/src/routes/project-summaries.ts`
- Create: `services/control-api/test/project-summaries.test.ts`
- Modify: `services/control-api/src/app.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/src/tenant/view.ts`
- Modify: `services/control-api/test/support/tenant-db.ts`
- Modify: `services/control-api/test/support/harness.ts`
- Modify: `packages/db/src/schema/execution.ts`
- Modify: `packages/db/test/schema-execution.test.ts`
- Create: next generated `packages/db/drizzle/0020_*.sql` and matching `packages/db/drizzle/meta/*`
- Modify generated: `packages/api-client/openapi.json`
- Modify generated: `packages/api-client/src/generated.ts`
- Modify generated: `packages/api-client/src/generated-operations.ts`
- Modify: `services/control-api/test/openapi.test.ts`
- Modify: `docs/plans/02-control-plane.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Produces: `ProjectDashboardSummarySchema`, `ProjectDashboardSummariesResponseSchema`, and schema-inferred types.
- Produces: `TenantProjectSummaryRepository.forProjects(projectIds)` returning rows in input order or `undefined` if any ID is outside the tenant.
- Consumes: `ReleasePort.getReadiness({ organizationId, releaseId })`; absence/failure yields nullable readiness and never an invented ready state.
- Produces: generated `GET /v1/projects/summaries` operation with repeated `projectId` query values (1–100).

- [ ] **Step 1: Write route RED tests**

Create tests that seed two projects and assert exact request-order output, 404 when one batch ID is foreign, null activity for no user-visible events, latest user-visible event time instead of `createdAt`, latest valid preview event, latest production release/deployment status, and readiness only from the injected release port.

The core assertion must include:

```ts
expect(response.json()).toEqual({
  summaries: [
    {
      projectId,
      lastActivityAt: '2026-08-10T18:03:00.000Z',
      preview: { status: 'ready', occurredAt: '2026-08-10T18:02:00.000Z' },
      production: {
        status: 'healthy',
        occurredAt: '2026-08-10T18:03:00.000Z',
        releaseId,
      },
      deployReadiness: { releaseId, state: 'ready', findings: [] },
    },
  ],
});
```

Run:

```bash
pnpm --filter @zapp/control-api test -- project-summaries.test.ts
```

Expected RED: `/v1/projects/summaries` returns 404 because the route is absent.

- [ ] **Step 2: Implement schemas and route projection**

Define strict Zod schemas exactly as ADR-0028. Parse preview payload status through a strict schema; ignore malformed payloads. Map persisted production states only through explicit tables:

```ts
const productionStatus =
  deployment?.status === 'healthy' ? 'healthy' :
  deployment?.status === 'failed' ? 'failed' :
  release?.status === 'deploying' ? 'deploying' : 'not_deployed';
```

Authorize `view_project`, perform one tenant-bound batch read, and preserve input order. Register the static summary route before project parameter routes in `buildApp`.

- [ ] **Step 3: Implement the tenant repository with an index-first query**

Add `(organization_id, project_id, occurred_at DESC)` to `agent_events`. Use one bounded query for the requested IDs to obtain project existence, latest user-visible activity, latest preview event, latest production release, and latest deployment. Do not issue one event query per card. Generate the next Drizzle migration with:

```bash
pnpm db:generate
```

Run schema and route tests. Expected GREEN: the new focused suites pass with no warning output.

- [ ] **Step 4: Add isolation and unavailable-readiness regressions**

Prove a mixed same/foreign batch returns 404 with no partial summaries. Prove an unavailable readiness port returns `deployReadiness: null`, while a `warnings` or `blocked` report is returned verbatim and never enables the web action later.

- [ ] **Step 5: Generate and verify the SDK**

Run:

```bash
pnpm --filter @zapp/api-client generate
pnpm --filter @zapp/control-api test -- openapi.test.ts openapi-contract.test.ts project-summaries.test.ts
pnpm --filter @zapp/api-client test
pnpm --filter @zapp/db test -- schema-execution.test.ts
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
```

Expected: all commands exit 0 and generated operations contain `/v1/projects/summaries` GET.

- [ ] **Step 6: Record and commit CP-21**

Check CP-21 in `tasks/todo.md` and append `2026-08-10 CP-21 done — ...` to Plan 02's execution log, including the focused verification result and any skipped credential test (normally none).

```bash
git add services/control-api packages/db packages/api-client docs/plans/02-control-plane.md tasks/todo.md
git commit -m "feat(control-api): public project dashboard summaries"
```

### Task 3: INT-1 GitHub App installation, discovery, and verified webhooks

**Files:**
- Create: `services/control-api/src/integrations/github/{schemas,ports,app,install,webhooks,store,queue}.ts`
- Create: `services/control-api/test/github-install.test.ts`
- Create: `services/control-api/test/github-webhooks.test.ts`
- Create: `services/control-api/test/integration/github-live.test.ts`
- Modify: `services/control-api/src/app.ts`
- Modify: `services/control-api/src/compose.ts`
- Modify: `services/control-api/src/server.ts`
- Modify: `services/control-api/src/server-bootstrap.ts`
- Modify: `services/control-api/src/env.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/src/tenant/view.ts`
- Modify: `services/control-api/src/redis/client.ts` only if its existing `eval` surface needs no new command
- Modify: `services/control-api/test/support/{harness,tenant-db}.ts`
- Modify: `services/control-api/test/{compose,env,server-bootstrap,openapi}.test.ts`
- Modify: `services/control-api/test/openapi-contract.test.ts` for generated path-count and determinism coverage
- Modify: `services/control-api/package.json`
- Modify: `packages/db/src/schema/security.ts`
- Modify: `packages/db/test/schema-security.test.ts`
- Modify: `packages/db/test/prd-schema-conformance.test.ts`
- Create: next generated `packages/db/drizzle/0021_*.sql` and matching meta
- Modify: `infra/docker/localstack/init-aws.sh`
- Modify: `infra/docker/docker-compose.dev.yml`
- Modify: `scripts/dev-up.sh`
- Create: `infra/terraform/github-app.tf`
- Modify: `.env.example`
- Modify: `pnpm-lock.yaml`
- Modify generated: `packages/api-client/{openapi.json,src/generated.ts,src/generated-operations.ts}`
- Modify: `docs/plans/06-git-and-integrations.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Produces: `POST /v1/integrations/github/install/authorize` → `{ url }`.
- Preserves and implements: `POST /v1/integrations/github/install` → safe `IntegrationConnectionSchema`.
- Produces: repository and branch list GET routes from ADR-0028 with opaque cursors.
- Produces: `POST /v1/webhooks/github`, raw-body HMAC-SHA-256 verification, delivery-ID dedupe, and durable `zapp-github-webhooks` enqueue.
- Produces: `GitHubProviderPort` implemented with `@octokit/rest` 20.1.2 and JWT signing through the existing `jose` dependency.

- [ ] **Step 1: Write authorization-state RED tests**

Test that Owner can initiate installation; Builder cannot; the URL contains only app slug and opaque state; state is bound to actor and organization; expiry, replay, and mismatched actor/org fail closed. The in-memory and Redis stores must share the same atomic `consume` contract.

Run:

```bash
pnpm --filter @zapp/control-api test -- github-install.test.ts
```

Expected RED: missing GitHub install modules/routes.

- [ ] **Step 2: Implement the state store and installation routes**

Use 32 random bytes encoded base64url. Persist `{ organizationId, actorId }` under a SHA-256-derived Redis key for 600,000 ms. Consume with one Lua `GET` + `DEL` script through the existing `RedisCommands.eval` method. Do not add a read-then-delete implementation.

JWT input is `{ appId, privateKey }`; per ADR-0029, exchange the callback code with `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, use the ephemeral user token to list the user's accessible installations, and accept only a requested installation present in that strict parsed response. Store only `installationId` in `integration_connections.configuration_json`, keep `credentialRef` null for the platform-owned App, and audit `integration.connected` without callback code/state/token material.

- [ ] **Step 3: Write repository/branch discovery RED tests**

Prove pagination, exact repository/branch schema, installation tenant lookup before provider call, foreign installation 404, provider 404 mapping, and provider error redaction.

Implement:

```ts
listRepositories(input: { installationId: string; cursor?: string }): Promise<StorePage<GitHubRepository>>;
listBranches(input: { installationId: string; repositoryId: string; cursor?: string }): Promise<StorePage<GitHubBranch>>;
```

Use installation access tokens only in memory for the duration of an Octokit call.

- [ ] **Step 4: Write webhook RED tests**

Test invalid/missing signatures return 401 and enqueue nothing; supported deliveries insert once; duplicate delivery IDs return 202 without a second outbox row; unknown event types return 202 with no outbox row; a publisher crash before settlement leaves the row pending; replay publishes once and marks it settled.

- [ ] **Step 5: Implement webhook receipt and outbox publisher**

Add `github_webhook_deliveries` with delivery ID primary key, event name, payload JSON, pending/published status, attempts, next-attempt time, received time, and published time. Claim by insert-on-conflict-do-nothing. Verify `x-hub-signature-256` against the exact raw bytes using constant-time comparison before JSON parsing.

Create queue and publisher lifecycles patterned after `usage/outbox.ts`, but keep GitHub schemas and state independent. The SQS message contains delivery ID, event name, installation ID when present, and payload. No provider signature or secret is persisted.

- [ ] **Step 6: Wire environment, LocalStack, Terraform, and lifecycle**

Add name-only `.env.example` entries for `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, and optional `GITHUB_API_BASE_URL`. Add `zapp-github-imports` and its DLQ alongside the existing webhook queue, update `EXPECTED_QUEUES`, expected count, and LocalStack health proof. Terraform must declare the exact INT-1 permissions/events and output no private key.

Add lifecycle ordering tests proving publisher shutdown drains before database/queue closure.

- [ ] **Step 7: Generate SDK and run INT-1 verification**

```bash
pnpm install --lockfile-only
pnpm db:generate
pnpm --filter @zapp/api-client generate
pnpm --filter @zapp/control-api test -- github-install.test.ts github-webhooks.test.ts env.test.ts compose.test.ts server-bootstrap.test.ts openapi.test.ts openapi-contract.test.ts
pnpm --filter @zapp/control-api test:integration -- github-live.test.ts
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
./scripts/dev-up.sh
```

Expected: local suites and bootstrap exit 0; live test either passes once with all GitHub variables or reports explicit skips naming the missing variables.

- [ ] **Step 8: Record and commit INT-1**

Check INT-1 in `tasks/todo.md` only after the task gate. Append its execution-log line to Plan 06 with exact passes/skips.

```bash
git add .env.example infra services/control-api packages/db packages/api-client \
  scripts/dev-up.sh pnpm-lock.yaml docs/plans/06-git-and-integrations.md tasks/todo.md
git commit -m "feat(integrations): github app install + verified webhooks"
```

### Task 4: INT-2 durable GitHub import and internal mirror

**Files:**
- Create: `services/control-api/src/integrations/github/{import,import-store,import-queue}.ts`
- Create: `services/control-api/test/github-import.test.ts`
- Create: `services/control-api/test/github-import-queue.test.ts`
- Create: `services/control-api/test/integration/github-import-live.test.ts`
- Modify: `services/control-api/src/{app,compose,server,server-bootstrap,env}.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/test/support/{harness,tenant-db}.ts`
- Create: `services/git-service/src/import/{mirror,git}.ts`
- Create: `services/git-service/test/import-mirror.test.ts`
- Create: `services/git-service/test/integration/import-mirror.test.ts`
- Modify: `services/git-service/src/{app,routes,compose}.ts`
- Modify: `services/control-api/src/git/{port,client}.ts`
- Modify: `services/control-api/test/git-client.test.ts`
- Modify: `packages/db/src/schema/security.ts`
- Modify: `packages/db/test/schema-security.test.ts`
- Modify: `packages/db/test/prd-schema-conformance.test.ts`
- Create: next generated `packages/db/drizzle/0022_*.sql` and matching meta
- Modify generated: `packages/api-client/{openapi.json,src/generated.ts,src/generated-operations.ts}`
- Modify: `docs/plans/06-git-and-integrations.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Produces: keyed `POST /v1/projects/:projectId/import/github` returning 202 queued status.
- Produces: `GET /v1/projects/:projectId/import/github` returning the strict status enum from ADR-0028.
- Produces: `github_imports` (one row per project) and `github_import_outbox` durable stage delivery.
- Produces: internal git-service `POST /internal/git/repositories/:organizationId/:projectId/import` with source credential accepted only over service auth and never logged.
- Produces: idempotent mirror result `{ externalRepoRef, branch, headCommitSha }`.

- [ ] **Step 1: Write API acceptance RED tests**

Prove 202 durable acceptance, exact idempotency replay, 409 for a different operation key, foreign project/installation 404, source type requirement, GET progress, Owner/Builder permission, and no credential/provider text in errors.

Run:

```bash
pnpm --filter @zapp/control-api test -- github-import.test.ts
```

Expected RED: import routes and storage are absent.

- [ ] **Step 2: Add durable import tables and tenant/global repositories**

`github_imports.project_id` is the primary key, avoiding a new TypeID prefix. Store organization, installation ID, repo, branch, operation key, status, external ref, head SHA, scan ID, stable error code, created/updated times. Add a unique `(organization_id, operation_key)` index and tenant composite foreign key. `github_import_outbox` uses project ID plus stage as its unique delivery identity and the established pending/retry columns.

Create and verify the Drizzle migration before route implementation.

- [ ] **Step 3: Implement POST/GET routes**

POST validates same-tenant project and installation, requires `sourceType === 'github_import'`, and atomically creates the import row plus queued outbox. GET reads only through the tenant-bound repository. Map row conflicts to stable 409 and foreign/missing to 404.

- [ ] **Step 4: Write git mirror RED tests**

Test branch lineage import, selected branch becoming the internal default, exact head equality, retry when target already equals source, refusal when target differs, no `--force`, no credential in argv/error/log output, bounded execution, and temporary directory cleanup.

The executor contract is:

```ts
mirror(input: {
  sourceCloneUrl: string;
  sourceToken: string;
  sourceBranch: string;
  targetCloneUrl: string;
  targetUsername: string;
  targetToken: string;
}): Promise<{ headCommitSha: string }>;
```

Use separate `GIT_ASKPASS` environments for source clone and target push. Never place either token in a URL or process argument.

- [ ] **Step 5: Implement the git-service import boundary**

Extend the provider only with `setDefaultBranch(ref, branch)`. The internal route mints a short-TTL target write credential, calls the mirror, polls the imported branch to the returned head, sets the Forgejo default branch, and returns strict non-secret metadata. The control-api client signs a fresh service token and redacts all remote errors.

- [ ] **Step 6: Write queue state-machine RED tests**

Cover queued→mirroring→scan_pending→scan_accepted, process failure/redelivery at both stage boundaries, mirror conflict to stable failed status, retryable provider outage remaining pending, max-attempt/DLQ settlement, and shutdown draining. Prove each delivery reads persisted state before acting.

- [ ] **Step 7: Implement one-stage-per-delivery worker**

For `queued`, acquire a short-lived installation token, persist `mirroring`, call git-service, then transactionally persist ref/head/default branch/branch row and `scan_pending` plus next outbox. For `scan_pending`, call the existing keyed VF-3 port and persist `scan_accepted`. A duplicate message for an already advanced state no-ops.

- [ ] **Step 8: Generate SDK and verify INT-2**

```bash
pnpm db:generate
pnpm --filter @zapp/api-client generate
pnpm --filter @zapp/control-api test -- github-import.test.ts github-import-queue.test.ts git-client.test.ts openapi.test.ts openapi-contract.test.ts
pnpm --filter @zapp/git-service test -- import-mirror.test.ts
pnpm --filter @zapp/control-api test:integration -- github-import-live.test.ts
pnpm --filter @zapp/git-service test:integration -- import-mirror.test.ts
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
pnpm --filter @zapp/git-service lint
pnpm --filter @zapp/git-service typecheck
```

Expected: local/fake-port and Forgejo integration tests pass; the live GitHub test passes or skips visibly for missing M4 credentials.

- [ ] **Step 9: Record and commit INT-2**

Check INT-2 and append its Plan 06 execution log line only after the gate.

```bash
git add services/control-api services/git-service packages/db packages/api-client \
  docs/plans/06-git-and-integrations.md tasks/todo.md
git commit -m "feat(integrations): github repository import with internal mirror"
```

### Task 5: Finish WEB-4 Slices B and C

**Files:**
- Create: `apps/web/src/components/projects/ProjectCard.tsx`
- Create: `apps/web/src/components/projects/GitHubImportDialog.tsx`
- Modify: `apps/web/src/components/projects/ProjectsDashboard.tsx`
- Modify: `apps/web/src/components/projects/NewProjectDialog.tsx`
- Modify: `apps/web/src/components/projects/projects.module.css`
- Modify: `apps/web/src/components/home/PromptComposer.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/e2e/projects.spec.ts`
- Modify: `apps/web/e2e/support/server.ts` only for fixture capabilities used without route interception
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes only generated CP-21, INT-1, and INT-2 operations through `createControlPlaneClient`.
- Produces race-safe summary batches bound to the existing request generation and abort lifecycle.
- Produces import flow `installation → repositories → branches → create project → enqueue import → poll → route`.
- Preserves exact create/import operation keys across visible retries.

- [ ] **Step 1: Write Slice B E2E RED tests**

Intercept both `/v1/projects` and `/v1/projects/summaries`. Assert last activity, Preview and Production icon-plus-text labels, no-activity/not-deployed states, Deploy only for ready, no Deploy for warnings/blocked/null, summary Retry preserving base cards, and Alpha→Beta→Alpha stale-summary rejection.

Run:

```bash
pnpm --filter @zapp/web test -- projects.spec.ts
```

Expected RED: cards contain only Slice A fields.

- [ ] **Step 2: Implement summary loading and ProjectCard**

After each base page resolves, request one summary batch for its new IDs. Keep summaries in a project-ID map. Abort summary work on organization change and check the same captured generation before every state mutation. A summary failure renders a card-adjacent summary error/Retry without hiding identity, support level, or Open.

Use semantic time markup and status labels; color is supplementary. Deploy links to `/projects/:id/releases` only when state is exactly `ready`.

- [ ] **Step 3: Write Slice C E2E RED tests**

Cover install initiation/callback completion, repository pagination, branch selection, confirm-time project creation with `sourceType: github_import`, 202 import enqueue, status polling through all public states, `scan_accepted` navigation, failed status Retry with the exact operation key, selection change creating new keys, organization switch reset, and keyboard-only dialog use.

- [ ] **Step 4: Implement generated client wrappers and import dialog**

Add wrapper methods whose bodies and responses come from `paths[...]`; do not write duplicate interfaces. Keep pending state in a ref containing project-create and import operation keys. Poll with an abortable 1-second interval and stop on organization/selection change, unmount, `scan_accepted`, or `failed`.

Enable existing PromptComposer/Conversation links to `/projects?import=github`; the projects page consumes that query with replace semantics after opening the dialog so refresh does not reopen a completed import.

- [ ] **Step 5: Run WEB-4 verification**

```bash
pnpm --filter @zapp/web test -- projects.spec.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
pnpm --filter @zapp/web build
pnpm --filter @zapp/api-client test
```

Expected: all projects E2E tests, lint, typecheck, build, and SDK tests exit 0.

- [ ] **Step 6: Two-round review cap**

Round 1 reviews the complete diff against ADR-0028, CP-21, INT-1, INT-2, WEB-4, tenant isolation, idempotency, secret handling, durable queue ownership, and UI accessibility. Fix findings with failing regression tests first. Round 2 verifies every finding and accepts or escalates; do not start a third round.

- [ ] **Step 7: Final acceptance gate**

Run the focused commands again, then:

```bash
pnpm lint
pnpm typecheck
pnpm verify:cold
```

Run the real GitHub provider verification once with the M4 variables if present. If absent, capture the test runner's explicit skipped test names and do not describe them as passes.

- [ ] **Step 8: Record and commit WEB-4**

Check both Slice B/C and the WEB-4 commit checkbox in Plan 08, check WEB-4 in `tasks/todo.md`, and append one execution log line with review rounds, exact test counts, provider skips, and deviations.

```bash
git add apps/web docs/plans/08-web-ux.md tasks/todo.md
git commit -m "feat(web): dashboard with org switcher + github import entry"
```

- [ ] **Step 9: Final clean-tree proof**

```bash
git status --short --branch
git log --oneline -5
rg -n '^- \[ \] (CP-21|INT-1|INT-2|WEB-4)' tasks/todo.md
```

Expected: clean worktree; four prescribed implementation commits after ADR-0028; the final `rg` emits no matches.

## Execution log

- 2026-08-10 Task 1 done — accepted ADR-0028; bound CP-21, INT-1, INT-2, and WEB-4 in the authoritative tracker; required route/queue reference and one-entry-per-tracker-task checks passed with `git diff --check` clean; no deviations.
- 2026-08-10 Task 3 review round 1 revision — accepted ADR-0029 for GitHub setup ownership proof and added `services/control-api/test/openapi-contract.test.ts` to INT-1's explicit file scope and generated determinism gate; the authoritative tracker remains the single existing INT-1 entry.
- 2026-08-11 whole-branch final acceptance correction: projected preview state from exact sandbox lifecycle event types and payloads; added durable failed-import rearm, SQS visibility leases, authorize-start idempotency, and semantic ID/SHA schemas; regenerated OpenAPI/SDK; and corrected the INT-1 and WEB-4 evidence logs. Focused control-api passed 65/65, API client 52/52, projects E2E 17/17, PostgreSQL retry 1/1, tenant isolation 54/54, Gate 5 Forgejo 1/1, and root lint/typecheck passed. The one-time cold gate exited 1 when six unrelated load-sensitive tests hit existing timeouts or process cleanup races; every failing target passed in isolation. A cached full retry still hit two of those timeouts, and the serial integration follow-up found an ahead-of-branch shared database with a later non-null `usage_ledger.operation_key`; both failures are retained in the final fix report. Real GitHub provider checks were not rerun, as required.
