# ADR-0028: Pull forward WEB-4 public summary and durable GitHub import dependencies

- Status: Accepted
- Date: 2026-08-10
- Owners: control plane / integrations / generated SDK / web
- Approval: user instructed the team to self-audit and execute this approved design without another approval gate, 2026-08-10
- Affects: Plan 02 CP-21, Plan 06 INT-1/INT-2, Plan 08 WEB-4, `packages/api-client`, `apps/web`
- References: WEB-4 Dependency Completion Design, 2026-08-10; ADR-0021; ADR-0018; product-owner API-first directive, 2026-08-03

## Context

ADR-0021 allowed WEB-4 Slice A because the public membership and keyset-paginated project-list
operations already existed. It deliberately left Slice B blocked: the existing list response is
not a source for last activity, preview/production state, or deploy readiness. Slice C remained
blocked because installation, repository/branch discovery, and durable import progress were
scheduled as INT-1/INT-2 in M4 and had no public generated-SDK operations.

The approved WEB-4 dependency-completion design self-audited the original proposal and requires
durable PostgreSQL outboxes plus DLQ-backed SQS queues. It keeps Forgejo as the internal source
of truth under ADR-0018, requires versioned public APIs before the web client, and prohibits
browser-inferred state or an API process owning clone, mirror, or scan lifetime.

## Decision

Pull these dependencies into M1 in this exact order:

```text
CP-21 -> INT-1 -> INT-2 -> WEB-4
```

### CP-21: project dashboard summaries

CP-21 publishes the generated operation:

```text
GET /v1/projects/summaries?projectId=<proj>&projectId=<proj>
// 200 { summaries: ProjectDashboardSummary[] }
```

It accepts 1–100 tenant-scoped project IDs, preserves request order, and returns 404 for the
whole request when any project is absent from the current organization. It produces strict
`ProjectDashboardSummarySchema` and `ProjectDashboardSummariesResponseSchema` types. A summary
contains `projectId`, nullable `lastActivityAt`, preview `{ status, occurredAt }` with states
`not_started|starting|ready|failed`, production `{ status, occurredAt, releaseId }` with states
`not_deployed|deploying|healthy|failed`, and nullable `deployReadiness` with
`releaseId`, `state: ready|warnings|blocked`, and `ReadinessFindingSchema[]`. Activity is a latest
user-visible event, never `projects.created_at`; malformed preview payloads are ignored;
readiness comes only from `ReleasePort` and is null when unavailable.

### INT-1: GitHub App installation, discovery, and webhooks

INT-1 publishes these generated operations:

- `POST /v1/integrations/github/install/authorize` -> `{ url }`;
- `POST /v1/integrations/github/install` -> safe `IntegrationConnectionSchema` metadata;
- `GET /v1/integrations/github/repositories?installationId=<id>&cursor=<opaque>`;
- `GET /v1/integrations/github/repositories/:repositoryId/branches?installationId=<id>&cursor=<opaque>`; and
- `POST /v1/webhooks/github`.

Authorization state is opaque, actor/organization-bound, stored for 10 minutes, and atomically
consumed once. Repository and branch discovery resolve the installation through the current
organization before provider access; foreign installations return 404. Raw-body HMAC-SHA-256
verification precedes parsing. Supported `push`, `pull_request`, and `installation` delivery IDs
are deduplicated in a durable outbox and published once to the DLQ-backed
`zapp-github-webhooks` SQS queue; unknown event types are successful no-ops. Provider credentials,
callback material, signatures, and secrets never cross the public API or logs.

Discovery response items are strict `GitHubRepositorySchema` `{ id, fullName, private,
defaultBranch }` and `GitHubBranchSchema` `{ name, headCommitSha }`; each identifier is an
integration reference, never a zapp.build primary identity.

### INT-2: durable GitHub import and internal mirror

INT-2 publishes keyed operations:

```text
POST /v1/projects/:projectId/import/github
GET /v1/projects/:projectId/import/github
```

The POST requires `Idempotency-Key`, validates same-tenant project and installation, accepts only
`sourceType: github_import`, and returns 202 only after one transaction creates the single
project import row, records the operation key, and writes a `zapp-github-imports` outbox message.
The POST response is strict `GitHubImportResponseSchema` `{ import: { projectId, status: 'queued' } }`.
The polling response is strict `GitHubImportStatusSchema` `{ projectId, status, externalRepoRef,
branch, headCommitSha, scanId, errorCode, updatedAt }`. Its public status states are
`queued|mirroring|scan_pending|scan_accepted|failed`; stable error codes are
`github_unavailable|repository_not_found|branch_not_found|mirror_failed|scan_unavailable`.
The GET returns 404 for a missing or foreign project/import.

One SQS delivery performs one resumable stage. `queued` obtains an in-memory installation token
and invokes the service-authenticated internal mirror boundary
`POST /internal/git/repositories/:organizationId/:projectId/import`; the idempotent result is
`{ externalRepoRef, branch, headCommitSha }`. The next durable stage persists the external ref,
`manual_push` policy, head SHA, and `scan_pending`; `scan_pending` hands off to the keyed VF-3
scan and reaches `scan_accepted`. Redelivery resumes from persisted state. A different import
operation key for the project returns 409. Neither mirror nor scan force-overwrites and no API
process owns their duration.

### Accepted Files-list expansions

- CP-21 owns the control API summary route and tests, tenant repository/view and test support,
  execution schema/index and migration, generated API client artifacts, OpenAPI tests, Plan 02,
  and tracker entries.
- INT-1 owns the GitHub integration modules/tests, control API composition/bootstrap/environment,
  tenant and Redis boundaries, security schema/migration tests, LocalStack/compose/bootstrap,
  GitHub App Terraform, name-only environment entries, lockfile, generated SDK, Plan 06, and
  tracker entries.
- INT-2 owns the GitHub import modules/tests, control API lifecycle/tenant/git client, git-service
  mirror boundary and tests, security schema/migration tests, generated SDK, Plan 06, and tracker
  entries.
- WEB-4 owns `ProjectCard`, `GitHubImportDialog`, dashboard/new-project/API wrappers, styles,
  prompt entry, E2E fixtures/tests, Plan 08, and tracker entries. It consumes only generated
  CP-21, INT-1, and INT-2 operations.

## Alternatives considered

- Keep Slice B/C blocked until their original M4 scheduling. Rejected because approved, bounded
  public contracts make the dashboard completion dependency order explicit without relaxing API
  first.
- Extend `GET /v1/projects` or infer card state in the browser. Rejected: those are distinct,
  mutable facts and would make a UI-private/inferred contract.
- Run clone, mirror, or capability scan in the API request. Rejected: it violates durable
  ownership and loses work on process failure.
- Use GitHub as the project source of truth. Rejected by ADR-0018; Forgejo remains internal truth.

## Consequences

Plan and tracker ordering now make the implementation dependency explicit. CP-21, INT-1, and
INT-2 execute and generate SDK operations before WEB-4 Slices B/C. All existing Slice A work
remains valid and complete, but WEB-4 remains unchecked until the new slices pass their final
acceptance gate. The LocalStack bootstrap must create both GitHub queues and DLQs idempotently;
real-provider verification remains a single credential-gated final-task check.
