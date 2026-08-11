# WEB-4 Dependency Completion Design

**Date:** 2026-08-10

**Status:** Approved in conversation; pending ADR-0028 and implementation plan

**Owners:** control plane, integrations, generated SDK, web

**Affects:** Plan 02 public project APIs, Plan 06 INT-1/INT-2, Plan 08 WEB-4, ADR-0021

## Objective

Finish WEB-4 without browser-inferred state or UI-private backdoors. The work pulls forward
the smallest public control-plane and GitHub contracts required by ADR-0021, generates those
contracts into `@zapp/api-client`, and completes WEB-4 Slices B and C. Slice A and its
keyset-paginated `GET /v1/projects` behavior remain intact.

## Constraints

- Every capability is exposed through a versioned `/v1` API and generated SDK before the web
  client consumes it.
- The dashboard never derives activity, preview, production, deployment readiness, GitHub
  installation, repository, branch, or import state from unrelated fields.
- All reads are organization-scoped. A requested project from another organization returns
  404, never a partial result or 403.
- GitHub is an optional peer import source. Forgejo remains the internal project repository
  and source of truth under ADR-0018.
- GitHub credentials remain server-side and never appear in API responses, events, fixtures,
  logs, or committed environment files.
- Every mutation is keyed and auditable. GitHub webhook delivery IDs are deduplicated before
  enqueue.
- The implementation uses Zod at every service boundary and infers TypeScript types from the
  schemas.
- No provider verification runs during review rounds. A real GitHub provider check runs once
  at the final acceptance gate and skips visibly when the required M4 credentials are absent.

## Delivery decomposition

This completion consists of three independently testable dependency tasks followed by the
WEB-4 consumer task:

1. **Project dashboard summaries:** publish authoritative project activity, environment state,
   and deploy readiness without changing the existing project-list response.
2. **INT-1 GitHub installation and discovery:** replace the generic connection placeholder with
   the GitHub App handshake, repository/branch discovery, and verified webhook enqueue path.
3. **INT-2 GitHub import:** implement the prescribed keyed import operation, internal mirror,
   capability-scan handoff, and its public response.
4. **WEB-4 Slices B/C:** consume only the generated operations and finish the dashboard cards
   and import dialog.

ADR-0028 will record the new route and schema names below and update the binding Files and
Interfaces sections of the owning tasks before implementation begins.

## Public API design

### Project dashboard summaries

`GET /v1/projects/summaries?projectId=<id>&projectId=<id>` accepts 1–100 project IDs from the
current organization and returns summaries in request order. The dashboard continues to page
project identity through `GET /v1/projects`, then requests one summary batch for each page. If
any requested project is absent from the tenant-bound repository, the whole summary request
returns 404.

```ts
const ProjectDashboardSummarySchema = z.object({
  projectId: idSchema('proj'),
  lastActivityAt: z.string().datetime().nullable(),
  preview: z.object({
    status: z.enum(['not_started', 'starting', 'ready', 'failed']),
    occurredAt: z.string().datetime().nullable(),
  }).strict(),
  production: z.object({
    status: z.enum(['not_deployed', 'deploying', 'healthy', 'failed']),
    occurredAt: z.string().datetime().nullable(),
    releaseId: idSchema('rel').nullable(),
  }).strict(),
  deployReadiness: z.object({
    releaseId: idSchema('rel'),
    state: z.enum(['ready', 'warnings', 'blocked']),
    findings: z.array(ReadinessFindingSchema),
  }).strict().nullable(),
}).strict();

const ProjectDashboardSummariesResponseSchema = z.object({
  summaries: z.array(ProjectDashboardSummarySchema),
}).strict();
```

`lastActivityAt` is the latest durable user-visible event timestamp across the project's runs,
or null when no such event exists. It never aliases `projects.created_at`.

Preview state is the latest valid user-visible `preview.starting`, `preview.ready`, or
`preview.failed` event. Production state is the latest persisted production release/deployment
state. Missing evidence is represented by `not_started`, `not_deployed`, or null readiness; it
is never guessed. `deployReadiness` is populated only when the release service has an
authoritative report for the latest deployable release. The web client renders a Deploy action
only when `deployReadiness.state === 'ready'`.

### GitHub installation initiation and completion

`POST /v1/integrations/github/install/authorize` is an idempotency-keyed, CSRF-protected
operation returning a short-lived, state-bound GitHub App installation URL. The state is opaque
to the browser and is validated and consumed once during completion. The control plane stores a
random state nonce in Redis for 10 minutes, bound to organization and actor, and consumes it with
an atomic get-and-delete operation. No GitHub credential is placed in the state value or URL.

The existing `POST /v1/integrations/github/install` route remains the completion route. INT-1
replaces its placeholder port with GitHub-specific validation, exchanges the callback material,
and stores the installation identifier only inside the tenant-scoped integration connection.
The response exposes safe connection metadata and no token.

### Repository and branch discovery

`GET /v1/integrations/github/repositories?installationId=<id>&cursor=<opaque>` returns a
keyset/provider-paginated page of repositories visible to that installation:

```ts
const GitHubRepositorySchema = z.object({
  id: z.string().min(1),
  fullName: z.string().min(3),
  private: z.boolean(),
  defaultBranch: z.string().min(1),
}).strict();

const GitHubBranchSchema = z.object({
  name: z.string().min(1),
  headCommitSha: CommitShaSchema,
}).strict();
```

`GET /v1/integrations/github/repositories/:repositoryId/branches?installationId=<id>&cursor=<opaque>`
returns branch names and head SHAs for the selected repository. The provider identifiers are
secondary integration references, never zapp.build primary IDs. Both routes resolve the
installation through the current organization before calling GitHub; another tenant's
installation returns 404.

### Webhook ingress

`POST /v1/webhooks/github` verifies the raw-body signature before parsing or enqueueing. Supported
`push`, `pull_request`, and `installation` deliveries are recorded by delivery ID and enqueued
once to the DLQ-backed `zapp-github-webhooks` SQS queue. Unknown event types receive a successful
no-op response. Invalid signatures return 401 and never enqueue. LocalStack bootstrap creates the
queue and DLQ idempotently so `scripts/dev-up.sh` cannot report healthy dependencies and then fail
because the queue is absent. Delivery IDs are claimed through a unique tenant-neutral webhook
delivery record in the same transaction that writes the outbox entry; an outbox publisher sends
the SQS message and records settlement. This prevents a process crash between deduplication and
enqueue from losing the delivery.

### GitHub import

The binding route remains:

```text
POST /v1/projects/:projectId/import/github
{ installationId, repo, branch }
```

The mutation requires `Idempotency-Key`. Before invoking the provider, it verifies the selected
project and installation in the same tenant. The implementation obtains a short-lived
installation token server-side, imports the selected branch lineage, mirrors it into the
project's internal Forgejo repository without force-overwriting an existing import, stores the
external repository reference with `manual_push`, and starts the existing VF-3 capability scan.

The response is returned only after the internal mirror is durable and the scan handoff is
accepted:

```ts
const GitHubImportResponseSchema = z.object({
  import: z.object({
    projectId: idSchema('proj'),
    repositoryId: idSchema('repo'),
    externalRepoRef: z.string().min(1),
    branch: z.string().min(1),
    headCommitSha: CommitShaSchema,
    status: z.literal('imported'),
  }).strict(),
  scan: z.object({
    id: z.string().min(1),
    status: z.literal('accepted'),
  }).strict(),
}).strict();
```

The web operation truthfully progresses through `submitting`, `importing`, `scan_accepted`, and
`failed` based on SDK request state and the returned contract. It does not claim provider-side
sub-stages the API cannot observe. Retrying an ambiguous response uses the same operation key;
re-importing an already imported repository with a different operation key returns 409.

## Web experience

Each loaded dashboard page batches its summary request after the base project page resolves.
Cards add:

- a real last-activity timestamp or an explicit `No activity yet` label;
- Preview and Production badges with icon and text;
- Deploy only for authoritative `ready` results; and
- no placeholder status while summary loading fails.

A summary read failure preserves the base card and exposes a summary-specific Retry. Organization
switching aborts both list and summary work and binds both responses to the existing monotonic
request generation.

`Import from GitHub` opens a dialog that:

1. starts or completes GitHub installation when no valid connection exists;
2. pages repositories through the generated SDK;
3. loads branches for the selected repository;
4. creates the destination project with `sourceType: 'github_import'` only after the user confirms
   the repository and branch;
5. calls the keyed import route; and
6. routes to the imported project after the mirror is durable and the scan is accepted.

An ambiguous create or import failure retains the exact project/import operation keys for the
visible Retry. Changing organization, repository, or branch intentionally starts a new operation
identity. Error copy remains based on public error codes and never exposes provider messages.

## Failure and security behavior

- Summary payloads with invalid event state are ignored by the projection and represented as
  absent state; malformed persisted state is never passed to clients as a fabricated status.
- Provider timeouts and rate limits map to stable public errors and a Retry action. Secret-bearing
  provider errors are redacted before logging.
- Installation callback state is single-use and tenant/user-bound. A replay or mismatch fails
  closed.
- Repository/branch results are parsed with Zod before crossing the integration boundary.
- Import never force-pushes, never overwrites a different external reference, and never leaves the
  project advertising success before the internal mirror commit is durable.
- Cross-tenant summary, installation, repository, branch, and import requests all return 404.

## Verification strategy

TDD proceeds in dependency order:

1. Control-plane tests prove summary projection, batch order, 404 isolation, absent state, preview
   transitions, production transitions, and readiness-gated Deploy data.
2. INT-1 tests prove authorization state binding, callback replay rejection, installation storage,
   repository/branch pagination, invalid webhook signature rejection, delivery dedupe, and exact
   SQS enqueue behavior.
3. INT-2 tests prove internal head equality, external reference persistence, accepted scan handoff,
   operation-key replay, 409 for a distinct re-import, rollback on mirror failure, and tenant
   isolation.
4. Generated SDK checks prove every new route and schema is represented without handwritten
   browser request types.
5. WEB-4 E2E proves summary rendering, icon-plus-text status, readiness-gated Deploy, summary retry,
   organization race safety, installation/repository/branch selection, import retry identity,
   import success routing, and keyboard accessibility.
6. Touched-package lint, typecheck, tests, format, build, repository `pnpm verify`, and the task's one
   final credential-gated GitHub provider verification form the acceptance gate.

Two local review rounds are the cap. Round 1 exits when all contract, tenant, idempotency, and UI
acceptance criteria have tests and no structural blocker remains. Round 2 exits when all round-1
findings are closed and the local acceptance gate is green; any unresolved structural issue is
re-scoped and escalated rather than sent through a third review.

## Out of scope

- GitHub bidirectional sync, pull-request creation, conflict handling, and export remain INT-3/INT-4.
- Rich asynchronous import-stage telemetry is not added; the current plan requires truthful import
  progress, not a new durable import workflow.
- DEP-1/DEP-2 are not reimplemented. The summary exposes readiness only when the existing release
  boundary can supply an authoritative report and otherwise returns null.
- No changes are made to Forgejo's source-of-truth role.
