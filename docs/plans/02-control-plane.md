# Plan 02 — Control Plane & Multitenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A secure multitenant control-plane API (auth, organizations, RBAC, projects, environments, secrets, audit, SSE event streaming) that the web app, macOS app, and internal services consume — PRD §20.3, §22, §23, §31, §32.

**Architecture:** Fastify service (`services/control-api`, port 4000) with Zod-validated routes generating OpenAPI, Stytch B2B for identity behind an `AuthPort` (one Stytch Organization per zapp org; zapp's own tables remain the membership source of truth), tenant context resolved per request and threaded through the `packages/db` scoped repositories, `agent_events` as the SSE source of truth with Redis fanout. Internal service-to-service auth via HMAC service tokens.

**Tech Stack:** Fastify 5, `fastify-type-provider-zod`, Stytch Node SDK (B2B), jose (JWT), Upstash Redis client, @zapp/db, @zapp/contracts, openapi-typescript for SDK generation.

**Milestone:** M0 (CP-1..8) + M1 (CP-9..16, CP-20..21) + M2 (CP-22..25) + M3 (CP-26) + M5 (CP-17..18, CP-27). **Depends on:** Plan 01. **Consumed by:** all plans.

## Global Constraints

Master plan §Global Constraints, plus:
- Every route handler receives `ctx: RequestContext = { requestId, user, organizationId, role, db: TenantDb }` — no handler queries outside `ctx.db`.
- Cross-tenant lookups return **404** (`*_not_found`), never 403, to avoid existence leaks.
- Route paths exactly as PRD §32. All under `/v1`. Error envelope from FND-10.
- Every mutating route: (a) emits an `audit_events` row in the same transaction, (b) honors `Idempotency-Key` header, (c) checks the PRD §22.2 permission matrix.

## File structure owned

```text
services/control-api/
  src/app.ts                # buildApp(): register plugins, no listen (testable)
  src/server.ts             # listen entrypoint
  src/plugins/auth.ts       # session resolution -> ctx.user
  src/plugins/tenant.ts     # org resolution -> ctx.organizationId, ctx.db, ctx.role
  src/plugins/audit.ts      # audit emit helper on ctx
  src/plugins/idempotency.ts
  src/plugins/rate-limit.ts
  src/auth/port.ts          # AuthPort interface
  src/auth/stytch.ts        # Stytch B2B implementation
  src/policy/permissions.ts # can(role, action) matrix
  src/routes/{auth,orgs,projects,secrets,events,workspaces,runs,releases,integrations,audit}.ts
  src/events/publisher.ts   # NOTIFY->Redis bridge worker
  src/events/sse.ts         # SSE endpoint with Last-Event-ID resume
  src/internal/service-auth.ts
  test/ (unit) + test/integration/
packages/api-client/        # generated SDK (CP-16)
```

---

### Task CP-1: Fastify skeleton with request context

**Files:** Create: `services/control-api/src/app.ts`, `src/server.ts`, `src/plugins/context.ts`, `test/app.test.ts`
**Interfaces produced:** `buildApp(deps: { db, redis, auth: AuthPort }): FastifyInstance`; `RequestContext` type.
**Effort:** M

- [x] **Step 1:** Failing test: `GET /healthz` → `{ status: "ok" }`; every response carries `x-request-id`; unknown route → 404 with FND-10 error envelope (`code: "route_not_found"`).
- [x] **Step 2:** Implement `buildApp` with zod type provider, global error handler mapping thrown `ApiError(code, status, message)` to the envelope (unexpected errors → 500 `internal_error`, message redacted, stack to logs only), request-id plugin, pino logger with tenant-safe serializers (never log headers.authorization, request bodies on secret routes).
- [x] **Step 3:** Tests pass. Also add migration revoking UPDATE/DELETE on `usage_ledger`, `audit_events` from the app role (FND note). Commit: `feat(control-api): fastify skeleton, error envelope, request context`

### Task CP-2: AuthPort + Stytch B2B integration

**Files:** Create: `src/auth/port.ts`, `src/auth/stytch.ts`, `src/routes/auth.ts`, `test/auth.test.ts`, `test/integration/auth.test.ts`
**Interfaces produced:**

```ts
export interface AuthPort {
  getAuthorizationUrl(input: { redirectUri: string; state: string }): string;
  exchangeCode(code: string): Promise<{ externalId: string; email: string; displayName: string; avatarUrl?: string }>;
  verifySession(token: string): Promise<{ externalId: string } | null>;
}
```

Routes: `GET /v1/auth/login` (redirect), `GET /v1/auth/callback` (upsert user by externalId→email, issue httpOnly session cookie `zapp_session` = signed JWT {userId, sessionId} 12 h + refresh 30 d), `POST /v1/auth/logout`, `GET /v1/auth/device` + `POST /v1/auth/device/token` (PKCE device flow for desktop; token returned once, stored in Keychain by MAC plan). 
**Effort:** L

- [x] **Step 1:** Failing tests with a `FakeAuthPort`: callback creates user row on first login, links on second; session cookie authenticates `GET /v1/me`; tampered JWT → 401 `unauthenticated`; device flow issues a bearer usable in `Authorization` header.
- [x] **Step 2:** Implement port + Stytch B2B impl: Discovery sign-in flow (email magic link + Google/GitHub OAuth + password) → `exchangeCode` = Stytch session authentication (verify Stytch session JWT server-side, map member → `externalId`); zapp mints its own session cookie afterward — `/v1/me` returns user + memberships from zapp tables. JWTs signed with `SESSION_JWT_SECRET` (rotatable: accept `SESSION_JWT_SECRET_PREVIOUS`). Device flow for desktop via Stytch OAuth + PKCE.
- [x] **Step 3:** Integration test against a Stytch test project is env-gated (`STYTCH_PROJECT_ID` + `STYTCH_SECRET` present) — CI skips without it, staging runs it. Commit: `feat(control-api): Stytch B2B sessions + device flow behind AuthPort`

### Task CP-3: Organizations, memberships, invites

**Files:** Create: `src/routes/orgs.ts`, `src/policy/permissions.ts`, `test/orgs.test.ts`
**Interfaces produced:** `can(role: Role, action: Action): boolean` implementing PRD §22.2 matrix verbatim; Actions enum: `manage_organization, manage_billing, manage_members, create_project, edit_code, start_run, approve_production_deploy, view_project, view_secret_metadata`.
Routes: `POST /v1/organizations`, `GET /v1/organizations`, `PATCH /v1/organizations/:orgId`, `POST /v1/organizations/:orgId/invites` (email + role), `POST /v1/invites/:token/accept`, `DELETE /v1/organizations/:orgId/members/:userId`, `PATCH .../members/:userId` (role change).
**Effort:** M

- [x] **Step 1:** Failing tests: the full §22.2 matrix as a table-driven test (9 actions × 3 roles = 27 assertions, exactly the PRD values, including "Approve production deploy: Builder = Configurable" → expressed as `approve_production_deploy` allowed for builder only when org setting `builderCanDeploy=true`); creating an org makes creator Owner; Builder cannot invite; last Owner cannot be demoted/removed (409 `last_owner`).
- [x] **Step 2:** Implement; org creation seeds `plan="trial"` and creates the paired Stytch Organization via AuthPort (`organization_id` stored on the org row; failure → org creation rolls back); invites are single-use tokens (7 d expiry) stored hashed.
- [x] **Step 3:** Commit: `feat(control-api): organizations, memberships, invites, RBAC matrix`

#### CP-3-FIX-1 — self-service organization bootstrap on first login

**Files:** Create: `src/auth/default-organization.ts`. Modify: `src/auth/port.ts`, `src/auth/stytch.ts`, `src/auth/users.ts`, `src/routes/auth.ts`, `test/stytch.test.ts`, `test/integration/auth.test.ts`, `test/integration/audit.test.ts`, `test/integration/orgs.test.ts`, `test/integration/tenant-isolation.test.ts`, `tasks/todo.md`, this plan.

- [x] **RED/provider:** replace the org-less discovery rejection assertion with a failing adapter test proving that Stytch's discovery-organization endpoint receives the intermediate session, a user-prefixed organization name, a collision-safe slug, and the configured session lifetime, and that its authenticated member becomes the returned identity.
- [x] **RED/database:** add failing PostgreSQL login coverage proving that first login creates exactly one `trial` organization plus one active Owner membership, `/v1/me` exposes it, and repeated login does not create another organization or membership.
- [x] **GREEN:** make org-less Stytch discovery create-and-authenticate the user's organization; make the database user upsert transactionally ensure a default organization and active Owner membership for users with no live membership. Use `<user name>'s Workspace` and a stable, collision-safe slug. Existing memberships remain unchanged.
- [x] **Verify/review/ship:** run focused control-api unit and integration suites, package lint/typecheck, `pnpm verify`, one Critical/Important review round (exit: zero Critical/Important), record the execution log, commit `fix(control-api): bootstrap organization on first login`, push `main`, and confirm exact-head GitHub CI/Security green. Run the real Stytch acceptance gate once at final acceptance; do not create persistent provider test fixtures outside the interactive sign-in flow.

### Task CP-4: Tenant context plugin + isolation suite v1

**Files:** Create: `src/plugins/tenant.ts`, `test/integration/tenant-isolation.test.ts`
**Effort:** M

- [x] **Step 1:** Failing integration tests (the permanent suite, CI job `tenant-isolation`): user in org A with session → `GET /v1/projects/:idOfOrgB` → 404 `project_not_found`; list endpoints never return org B rows; `x-organization-id` header selects among the user's orgs, non-member org id → 404 `organization_not_found`; Viewer calling `POST /v1/projects` → 403 `forbidden`.
- [x] **Step 2:** Implement plugin: resolve org from header (web) or route param, verify membership + status=active, attach `ctx.db = forOrg(db, orgId)`, `ctx.role`.
- [x] **Step 3:** Commit: `feat(control-api): tenant context + permanent isolation test suite`

### Task CP-5: Audit + idempotency + rate limiting plugins

**Files:** Create: `src/plugins/audit.ts`, `src/plugins/idempotency.ts`, `src/plugins/rate-limit.ts`, `test/plugins.test.ts`
**Interfaces produced:** `ctx.audit(action, target, metadata)`; idempotency: first POST with key stores response hash 24 h (Redis), replay returns stored response with `x-idempotent-replay: true`, mismatched body → 422 `idempotency_conflict`; rate limit: token bucket per org+route class (Redis), 429 with `retry-after`.
**Effort:** M

- [x] **Step 1:** Failing tests for all three behaviors (audit row written in same tx — verify rollback removes it; replay; bucket exhaustion).
- [x] **Step 2:** Implement. Default limits config: `mutations: 60/min/org`, `reads: 600/min/org`, `auth: 10/min/ip` (config file, not code constants).
- [x] **Step 3:** Commit: `feat(control-api): audit emit, idempotency keys, org rate limits`

### Task CP-6: Projects, repositories, branches, environments CRUD

**Files:** Create: `src/routes/projects.ts`, `test/projects.test.ts`
Routes (PRD §32.1): `POST /v1/projects` (name, description, sourceType: `template|blank|github_import`; creates project + internal repo record via git-service GIT-3 + default branch `main` + environments `preview`,`production` + audit), `GET /v1/projects` (keyset paginated), `GET/PATCH /v1/projects/:projectId`, `GET /v1/projects/:projectId/contract`, `POST /v1/projects/:projectId/scan` (enqueues capability scan — stub returning 202 until VF-2 wires it).
**Effort:** M

- [x] **Step 1:** Failing tests: create → project + repo + 2 environments + branch rows exist; slug uniqueness per org (409 `slug_taken`); pagination returns stable keyset order; PATCH by Viewer → 403.
- [x] **Step 2:** Implement with transactional creation; git-service call behind `GitServicePort` (fake in unit tests).
- [x] **Step 3:** Commit: `feat(control-api): project lifecycle with repo/env/branch records`

### Task CP-7: Secrets vault

**Files:** Create: `src/secrets/crypto.ts`, `src/routes/secrets.ts`, `src/internal/secrets.ts`, `test/secrets.test.ts`
**Interfaces produced:** envelope encryption: `encryptSecret(plaintext) → { ciphertext, dekCiphertext, keyVersion }` (AES-256-GCM per-secret DEK, DEK wrapped by master key from `SECRETS_MASTER_KEY` env in dev / KMS in prod via `MasterKeyPort`); routes per PRD §32.5: `POST /v1/projects/:projectId/secrets` (name, value, environmentId?), `GET` (metadata only — name, environment, rotatedAt, createdBy; **never values**), `DELETE /v1/projects/:projectId/secrets/:secretId`; internal-only `POST /internal/secrets/decrypt` (service-token auth, sandbox-service + release-service allowlist, every call → audit row `secret.decrypted` with reason field).
**Effort:** L

- [x] **Step 1:** Failing tests: round-trip encrypt/decrypt; GET returns metadata only (assert `value` absent from JSON, recursively); decrypt endpoint rejects user sessions (401) and non-allowlisted services (403); decrypt writes audit row; redaction helper `redactSecrets(text, registry)` replaces values with `[secret:NAME]` (used later by WS/AR plans — export from `packages/contracts` util or shared package `@zapp/redaction`; choose `packages/config/src/redaction.ts` and re-export).
- [x] **Step 2:** Implement; key rotation: `keyVersion` on rows; re-encrypt job stub documented.
- [x] **Step 3:** Commit: `feat(control-api): envelope-encrypted secrets with metadata-only reads + audited internal decrypt`

### Task CP-8: Internal service-to-service auth

**Files:** Create: `src/internal/service-auth.ts`, `packages/config/src/service-token.ts`, `test/service-auth.test.ts`
**Interfaces produced:** `signServiceToken({ service, aud, ttlSec })` / `verifyServiceToken(token, expectedAud)` — HS256 JWT with `SERVICE_TOKEN_SECRET`; services: `orchestrator-worker`, `sandbox-service`, `verification-service`, `release-service`, `git-service`, `model-gateway`. `/internal/*` routes require it.
**Effort:** S

- [x] Steps: failing test (valid token passes, wrong aud fails, expired fails, user JWT fails) → implement → commit: `feat: HMAC service tokens for internal APIs`

### Task CP-9: Run + workspace passthrough routes

**Files:** Create: `src/routes/runs.ts`, `src/routes/workspaces.ts`, `test/runs.test.ts`
Routes (PRD §32.2/§32.3, ADR-0009): `POST /v1/projects/:projectId/runs` (mode, prompt, branchId?, budget?, appType?=`"web"`, model? → validates an explicit model against the selected organization's policy, creates an `agent_runs` row with durable `app_type` + nullable `model` and status=`queued`, starts Temporal workflow via `OrchestratorPort`, returns the structured run intent), `GET /v1/runs/:runId`, `POST /v1/runs/:runId/{pause,resume,cancel,redirect}` (signal via OrchestratorPort; 409 `invalid_run_state` when not applicable), workspace routes proxying to sandbox-service with tenancy checks (`POST /v1/projects/:projectId/workspaces`, `GET /v1/workspaces/:id`, `POST /v1/workspaces/:id/{start,checkpoint,terminate,preview}`). Raw fs/command APIs are **not** exposed (PRD §32.3 note).
**Effort:** M

- [x] Steps: failing tests with fake ports (run created + workflow started exactly once — idempotency key = run id; pause on completed run → 409; Viewer cannot start run) → implement → commit: `feat(control-api): run lifecycle + workspace routes behind ports`

### Task CP-10: Specification routes

**Files:** Create: `src/routes/specifications.ts`, `test/specifications.test.ts`
Routes (PRD §32.2): `POST /v1/projects/:projectId/specifications` (content per `SpecificationSchema` from AR-21; status `draft`), `GET .../specifications/:version`, `POST .../specifications/:version/approve` (immutable after: PATCH attempts → 409 `specification_immutable`; approval stamps approved_by/at, bumps status).
**Effort:** S

- [x] Steps: failing tests (versions auto-increment per project; approve locks; edit-after-approve creates v+1 draft copy) → implement → commit: `feat(control-api): versioned specifications with immutable approval`

### Task CP-11: Release + integration routes (shells)

**Files:** Create: `src/routes/releases.ts`, `src/routes/integrations.ts`
Routes exactly PRD §32.4/§32.5, delegating to `ReleasePort` / `IntegrationPort` (implemented in plans 07/06; fakes here). Tenancy + RBAC (approve/deploy requires `approve_production_deploy`) enforced at this layer with tests.
**Effort:** M

- [x] Steps: failing RBAC tests (Builder with `builderCanDeploy=false` → 403 on `POST /v1/releases/:id/deploy`) → implement → commit: `feat(control-api): release + integration route shells with RBAC`

### Task CP-12: Audit log read API + org settings

**Files:** Create: `src/routes/audit.ts`
Routes: `GET /v1/organizations/:orgId/audit-events` (Owner only, keyset paginated, filter by actor/action/target/time range), `GET/PATCH /v1/organizations/:orgId/settings` (builderCanDeploy, defaultModelPolicy passthrough config JSON).
**Effort:** S

- [x] Steps: failing tests (Builder → 403; filters work) → implement → commit: `feat(control-api): audit log reads + org settings`

### Task CP-13: Event write path (internal ingest)

**Files:** Create: `src/internal/events.ts`, `test/integration/events-ingest.test.ts`
**Interfaces produced:** `POST /internal/runs/:runId/events` (service token; body: array of events WITHOUT id/sequence; server assigns `newId("evt")` + `nextEventSequence` in one tx, inserts, `pg_notify('agent_events', runId)`). Batch ≤ 100. This is the ONLY write path for events (orchestrator-worker uses it — keeps one DB writer for sequencing).
**Effort:** M

- [x] Steps: failing tests (batch insert assigns contiguous sequences under concurrency; payload > 64 KB → 413 `payload_too_large` telling caller to use artifacts; visibility validated) → implement → commit: `feat(control-api): sequenced event ingest with NOTIFY`

### Task CP-14: Redis fanout publisher

**Files:** Create: `src/events/publisher.ts`, `test/integration/publisher.test.ts`
**Effort:** M

- [x] **Step 1:** Failing test: insert event via CP-13 → within 2 s of the insert's commit, a Redis subscriber on channel `run:{runId}` receives `{ sequence }` ping. (Amended 2026-08-07: was "within 500 ms" measured from before the POST — see Execution log; the 500 ms figure is a production SLO for ops metrics, not a laptop-stack test bound.)
- [x] **Step 2:** Implement: dedicated pg LISTEN connection with reconnect/backoff; on notify, publish lightweight ping (subscribers re-read from DB — guarantees order/no-loss); on Redis outage, SSE degrades to 2 s DB polling (documented behavior, test simulates).
- [x] **Step 3:** Commit: `feat(control-api): LISTEN/NOTIFY → Redis event fanout`

### Task CP-15: SSE stream endpoint

**Files:** Create: `src/events/sse.ts`, `test/integration/sse.test.ts`. Expanded by accepted ADR-0008: `packages/db/src/{client,tenant}.ts`, `services/control-api/src/{app.ts,routes/runs.ts}`, and directly related composition tests.
**Interfaces produced:** `GET /v1/runs/:runId/events` with `Accept: text/event-stream`: replays rows `sequence > Last-Event-ID` (or `?after=`), then live-tails via Redis ping → DB read; each SSE message: `id: {sequence}`, `event: {type}`, `data: {AgentEvent JSON}`; heartbeat comment every 15 s; visibility filter: user sessions get `visibility=user`; support role param gets `user+support`; `internal` never leaves the service boundary.
**Effort:** M

- [x] **Step 1:** Failing integration test: create 5 events → connect with `Last-Event-ID: 2` → receive 3,4,5 then a live 6 within 2 s; internal-visibility event never appears; disconnect/reconnect resumes without duplicates (client dedupe by sequence asserted server sends none twice for a stable cursor).
- [x] **Step 2:** Implement with backpressure (pause DB tail if socket buffer full), 4 h max connection (client reconnects).
- [x] **Step 3:** Commit: `feat(control-api): resumable SSE run event stream`

### Task CP-16: OpenAPI + generated SDK

**Files:** Create: `services/control-api/src/openapi.ts`, `packages/api-client/*`
**Effort:** M

- [x] Steps: serve `/v1/openapi.json` from zod route schemas → generate `packages/api-client` via openapi-typescript + a thin fetch wrapper (`createZappClient({ baseUrl, getToken })`, SSE helper `subscribeRunEvents(runId, { after, onEvent })` with auto-reconnect + Last-Event-ID) → contract test: generated types compile against a live app instance's JSON → commit: `feat(api-client): generated typed SDK with SSE helper`

### Task CP-20 [M1]: Conversation continuation + attachments API (ADR-0027)

**Files:** Modify: `packages/contracts/src/events.ts` (additive `message.*` events + required tool `userSummary`), `src/routes/runs.ts`, `src/openapi.ts`, `packages/api-client/*` (regenerated); Create: `src/routes/attachments.ts`, `test/integration/messages.test.ts`
**Interfaces produced (binding for plans 04, 08, 09 — full payload contracts in ADR-0027):**
- `AgentEvent` additions: `message.user` `{ messageId, content, attachments: AttachmentRef[] (≤ 10), source }`; `message.assistant` `{ messageId, turnId, content (inline ≤ 48 KB, overflow → contentArtifactId), model }`; `tool.started/completed/failed` payloads gain **required** `userSummary: string`. Assistant deltas are explicitly M2.
- `POST /v1/runs/:runId/messages` `{ content, attachments? }` → 202 `{ messageId, sequence }`: idempotency-keyed, org-scoped 404, persists + emits `message.user` via CP-13 ingest, signals the AR-8 workflow; run not accepting input → 409 typed `run_not_active`.
- `POST /v1/projects/:projectId/attachments` (multipart ≤ 8 MiB) → `{ attachmentId, kind, name, byteSize, contentType }` stored via existing artifact conventions (FND-7 tenant-prefixed R2, `artifact.created`); `GET /v1/attachments/:attachmentId` → short-TTL signed URL.
**Effort:** M

- [x] Failing tests first: duplicate idempotent message POST → single `message.user` event and sequence; message to a completed run → 409 `run_not_active`; cross-tenant runId → 404; attachment round-trip incl. 413 over size cap and content-type allowlist; SSE replay returns `message.*` in sequence order; OpenAPI snapshot diff is additive only (breaking-change detector green).
- [x] Commit: `feat(control-api): public conversation continuation + attachments (ADR-0027)`

### Task CP-21 [M1 pull-forward]: Project dashboard summary read model

**Files:** Create: `services/control-api/src/routes/project-summaries.ts`, `services/control-api/test/project-summaries.test.ts`; Modify: `services/control-api/src/app.ts`, `services/control-api/src/tenant/db.ts`, `services/control-api/src/tenant/view.ts`, `services/control-api/test/support/tenant-db.ts`, `services/control-api/test/support/harness.ts`, `packages/db/src/schema/execution.ts`, `packages/db/test/schema-execution.test.ts`, next generated `packages/db/drizzle/0020_*.sql` and matching `packages/db/drizzle/meta/*`, generated `packages/api-client/openapi.json`, `packages/api-client/src/generated.ts`, `packages/api-client/src/generated-operations.ts`, `services/control-api/test/openapi.test.ts`, `docs/plans/02-control-plane.md`, `tasks/todo.md`
**Interfaces produced:** `GET /v1/projects/summaries?projectId=<proj>&projectId=<proj>` returns `200 { summaries: ProjectDashboardSummary[] }` for 1–100 IDs in request order; strict `ProjectDashboardSummarySchema` and `ProjectDashboardSummariesResponseSchema` with schema-inferred types; `TenantProjectSummaryRepository.forProjects(projectIds)` returns tenant rows in input order or `undefined` when any ID is outside the tenant; generated SDK GET operation with repeated `projectId` query values. The route authorizes `view_project`; last activity is the latest user-visible event (never `createdAt`), malformed preview state is absent, production state is read only from persisted release/deployment state, and unavailable `ReleasePort.getReadiness({ organizationId, releaseId })` yields null readiness rather than invented readiness.
**Effort:** M

- [ ] Failing route tests first: request-order summaries; mixed local/foreign IDs return one 404 with no partial result; no user-visible events yield null activity; latest valid preview event and production state are returned; readiness is only injected from the release port.
- [ ] Implement strict Zod schemas and route projection; register the static route before project parameter routes.
- [ ] Add `(organization_id, project_id, occurred_at DESC)` to `agent_events`, generate the migration, and use one bounded tenant query rather than an event query per card.
- [ ] Generate SDK and verify focused route, OpenAPI, API-client, schema, lint, and typecheck suites.
- [ ] Commit: `feat(control-api): public project dashboard summaries`

### Task CP-21 [M2]: Public builder preview bridge (ADR-0028)

**Files:** Create: `packages/contracts/src/builder-preview.ts`, `services/control-api/src/routes/builder-preview.ts`, `services/control-api/src/sandbox/client.ts`, `services/control-api/test/builder-preview.test.ts`; Modify: contracts exports, control-api sandbox port/app/compose/env wiring, OpenAPI, `packages/api-client` generated surface + preview SSE helper/tests
**Interfaces produced (binding for WEB-7 and WEB-11):** the four public operations and `subscribePreviewEvents` defined by ADR-0028.
**Effort:** L. **[expand-at-execution]**

#### CP-21 execution expansion (2026-08-10)

- [x] **RED — tenant-scoped logs and server-authoritative restart:** add route tests proving log cursor forwarding, cross-tenant 404, restart contract lookup/validation, stable idempotent forwarding, and typed missing-contract refusal. Run the focused suite and confirm failure because the public routes and sandbox port methods do not exist.
- [x] **GREEN — logs/restart boundary:** add shared Zod contracts, extend `SandboxServicePort`, implement the service-authenticated HTTP client, register the two public routes, and wire the shipping client in composition. Rerun the focused suite to green.
- [x] **RED — capture SSE and screenshot:** add tests proving an authenticated user receives the exact no-body capture records, downstream abort cancels the upstream request, cross-tenant reads never open the proxy, screenshot status/body are preserved including 501, and no provider/service credential reaches the response. Run and confirm the missing routes fail.
- [x] **GREEN — capture proxy:** register the cancellable SSE and screenshot routes on the existing `PreviewProxyPort`; preserve upstream content type/status and strip hop-by-hop/provider headers. Rerun the focused suite to green.
- [x] **RED/GREEN — generated SDK:** extend the API-client contract tests for all four OpenAPI operations and a real-stream `subscribePreviewEvents` helper that closes and reports malformed records. Regenerate, implement the helper, and run the client suite.
- [x] **Verify/review/ship:** run control-api and api-client tests plus lint/typecheck/build; run at most two Critical/Important review rounds (exit: zero Critical/Important); check CP-21 in `tasks/todo.md`, append one execution-log line, commit `feat(control-api): public builder preview bridge (ADR-0028)`, push `main`, and confirm GitHub CI/Security green. No provider run is required.

#### CP-21-FIX-1 — durable screenshot operation reservation

**Files:** Modify: `services/control-api/src/routes/builder-preview.ts`, `services/control-api/src/plugins/audit.ts`, `services/control-api/test/builder-preview.test.ts`, `services/control-api/test/sandbox-preview-client.test.ts`, `services/control-api/test/integration/audit.test.ts`, and existing `AuditSink` test doubles

- [x] **RED/evidence:** retain CP-21 round 2's finding that writing screenshot bytes only after capture leaves an ambiguous crash window. Add a route regression where the proxy request fails after it starts, then a retry with the same public idempotency key must not invoke capture again.
- [x] **GREEN:** reserve the tenant-prefixed artifact-store operation key atomically before capture. A completed reservation replays the original PNG; a pending/ambiguous reservation fails closed without a second capture; only an explicit upstream non-success releases the reservation. Bound stored and replayed PNGs at 10 MiB, preserve structural 501/503 responses, and retry the deterministic exactly-once completion-audit row from durable replay.
- [x] **Verify/review/ship:** run focused and package gates and at most two fresh Critical/Important review rounds (exit zero), then close CP-21 and CP-21-FIX-1 together without any provider call.

### Task CP-17 [M5]: Data retention & deletion pipeline

**Files:** Create: `src/jobs/retention.ts`, `src/jobs/deletion.ts`, `test/integration/deletion.test.ts`
**Effort:** L. **[expand-at-execution]**

Binding behavior: nightly retention job enforces PRD §31.4 TTLs (agent_events 90 d → archive to R2 then drop partition; test artifacts 30 d; diagnostics 7 d); project deletion enqueues a deletion record fanning out to Postgres rows, R2 prefixes, git-service repo delete, Modal snapshot deletes (via sandbox-service), then verifies each target reports absence before marking complete; org deletion cascades projects; audit rows retained per policy. Test: delete a seeded project → poll status → verify data gone from each store (MinIO/dev services).

Execution expansion (2026-08-12; route-name assumption follows the existing project-resource vocabulary because the plan/PRD leaves polling paths unnamed):

- [x] **17a RED — durable schema/classification:** add DB schema tests for an append-only-audit-preserving `project_deletions` state machine and explicit expirable-artifact classifications; generated migration must be deterministic and test evidence must be classified at write time, never inferred from names or JSON.
- [x] **17b GREEN — nightly retention:** add `retention.test.ts` for exact-object delete → absence verification → row delete, 30-day test and 7-day diagnostic cutoffs, release/unclassified exclusion, failure retry, and composition with OPS-14's 90-day event partition archive; implement the bounded daily lifecycle and PostgreSQL/S3 adapters.
- [x] **17c RED/GREEN — public deletion API:** add Owner-only, idempotency-keyed `DELETE /v1/projects/:projectId` → `202` and `GET /v1/projects/:projectId/deletion`; cross-tenant reads return 404, Viewer/Builder mutation is denied, exact replay is stable, and enqueue + `project.deletion_requested` audit are atomic. Regenerate OpenAPI/SDK before UI consumers.
- [x] **17d RED/GREEN — fan-out worker:** add deterministic crash/redelivery tests for leased one-target-at-a-time progression across sandbox snapshots, Git, R2, and PostgreSQL; each remote target must report absence before its durable target becomes verified, PostgreSQL is last, audit rows survive it, and completion is only reachable when every target is verified.
- [x] **17e RED/GREEN — downstream deletion ports:** extend the authenticated git-service and sandbox-service boundaries with idempotent delete plus explicit absence probes; add provider/fake/HTTP tests, including Modal image deletion, and preserve service-token/tenant scoping.
- [x] **17f RED/GREEN — organization cascade:** enqueue one project deletion per current organization project under the same Owner-authorized organization operation; prove an empty organization is an idempotent success and each project remains independently resumable.
- [x] **17g integration:** seed a real project with related PostgreSQL rows, classified objects in MinIO/R2, an internal Git repository, and snapshot records through dev-service adapters; enqueue, poll, and prove every target absent while tenant audit evidence remains. Environment-gate only genuinely unavailable providers and print exact skips.
- [x] **17h verify/review/ship:** run schema/generator determinism, focused and full touched-package tests, lint/typecheck/build, one final real-provider gate, and at most two Critical/Important review rounds (exit zero); update tracker/log and commit `feat(control-api): retention + verified deletion pipeline`.

#### CP-17-FIX-1 — terminate project workspaces before row deletion

**Files:** Modify: `services/sandbox-service/src/routes/workspaces.ts`, `services/sandbox-service/src/state/postgres.ts`, sandbox-service integration fixtures/tests, `tasks/todo.md`, and this execution plan.

- [x] **RED:** add a project-deletion regression proving that an existing provider workspace remains present and the absence probe stays false even when its durable row is already marked terminated.
- [x] **GREEN:** enumerate workspaces by exact organization/project scope, finalize active usage, terminate every provider workspace idempotently, revoke monitors, persist termination, release capacity, and require both workspace and snapshot absence before deletion can advance.
- [x] **Verify/ship:** run focused integration coverage, the full sandbox-service test/lint/typecheck/build gates, `pnpm verify`, then update the tracker/log and commit `fix(sandbox): remove project containers before deletion`.

### Task CP-18 [M5]: Export APIs

**Files:** Create: `services/control-api/src/routes/export.ts`, `services/control-api/src/export/service.ts`, `services/control-api/test/export.test.ts`, `services/control-api/test/integration/export.test.ts`, `services/git-service/src/export.ts`, `services/git-service/test/export.test.ts`; Modify: control-api/Git-service app, composition, auth/idempotency/storage boundaries and test doubles, shared audit contract, generated OpenAPI/SDK artifacts, Git provider integration coverage.
**Effort:** M. **[expand-at-execution]**

Binding behavior (PRD §36.5): `POST /v1/projects/:id/export` produces artifact bundle: git bundle (via git-service), spec JSON, plan JSON, evidence manifests, env var **names**, audit log (Owner only); download via signed URL; secrets never included.

Execution expansion (2026-08-12; the portable artifact is a deterministic uncompressed tar so binary Git history and typed JSON documents stay self-contained without a format-specific runtime dependency):

- [x] **18a RED — public/API boundary:** add Owner-only route tests for required CSRF, tenant, and `Idempotency-Key`; cross-tenant and missing projects are indistinguishable 404s, Builder/Viewer calls are denied, and exact replay performs no second Git/storage write.
- [x] **18b GREEN — safe bundle assembly:** implement `src/routes/export.ts` with strict Zod schemas, deterministic artifact identity/key, bounded tar construction, SHA-256 receipt, five-minute signed URL, atomic `project.exported` audit plus unclassified project-lifetime artifact row, and explicit exclusion of secret values/ciphertext/storage credentials.
- [x] **18c RED/GREEN — export projection:** add a tenant-scoped PostgreSQL projection for the latest specification, durable phase/task plan, test/evidence manifests, releases/deployments, secret-metadata names only, and project-related audit rows; prove another tenant's rows and secret ciphertext cannot enter the projection.
- [x] **18d RED/GREEN — Git bundle port:** add a service-authenticated, tenant/project-derived git-service export boundary that mints a bounded read credential, creates and verifies a Git bundle through the existing Git command adapter, returns no credential, and cleans scratch/token state on success and failure; add fake/provider/HTTP coverage.
- [x] **18e integration/artifacts:** compose production Git and S3 ports, generate OpenAPI/SDK, and add a PostgreSQL + MinIO integration that downloads the signed tar, verifies every required entry and exact Git bytes, and proves only environment-variable names are present.
- [x] **18f verify/review/ship:** run deterministic generation, full touched-package tests, lint/typecheck/build, one final real-provider gate, and at most two Critical/Important review rounds (exit zero); update tracker/log and commit `feat(control-api): portable project export bundles`.

### Task CP-22 [M2]: Public builder controls + generic approvals

**Files:** Modify contracts, run/Mission Control routes, tenant ports, OpenAPI/SDK and tests.
**Effort:** L. **[expand-at-execution]**

- [x] Binding behavior: server-computed action eligibility/reasons; keyed retry-failed-task and skip-optional-phase routes over AR-23; strict discriminated approval decisions with stored id/kind matching and rollout-compatible budget behavior.
- [x] Verify generated SDK determinism, tenant/RBAC/idempotency behavior, and typed stale-state conflicts.
- [x] Commit: `feat(control-api): public builder controls and typed approvals`

Execution expansion (2026-08-12):

- [x] **22a RED — public contract:** lock stable builder action/reason schemas, strict keyed retry/skip requests, discriminated approval kinds/decisions, and exact Temporal projections.
- [x] **22b GREEN — Mission Control eligibility:** derive retry eligibility from terminal task/dependency state and skip eligibility from durable optional/start state; unknown, unsupported, stale, and terminal runs fail closed with stable reasons.
- [x] **22c RED/GREEN — keyed mutations:** add tenant/RBAC/CSRF/idempotency tests and routes for failed-task retry and optional-phase skip; re-check state immediately before the AR-23 signal and return typed 409 conflicts without signalling.
- [x] **22d RED/GREEN — typed approvals:** generalize the existing route/repository by stored approval kind while retaining the exact budget ceiling/accounting path; mismatched ids/kinds are 404 and conflicting replays are 409.
- [x] **22e SDK/verification:** regenerate OpenAPI/SDK deterministically; run focused contracts/control/API-client tests, lint/typecheck/build, and diff/boundary checks; then record and commit once.

### Task CP-23 [M2]: Public conversation-card responses + artifacts

**Files:** Modify message/spec/run routes and ports, contracts, OpenAPI/SDK and tests.
**Effort:** M. **[expand-at-execution]**

- [x] Binding behavior: keyed typed responses to AR-24 cards plus tenant-safe bounded specification, plan, and referenced artifact reads; no assistant-prose parsing.
- [x] Commit: `feat(control-api): public conversation-card responses`

Execution expansion (2026-08-12):

- [x] **23a RED — public card response:** require session, tenant, CSRF, and `Idempotency-Key`; accept only `ConversationCardResponseSchema`, signal the exact AR-24 card id/response, and prove stable replay without assistant-prose parsing.
- [x] **23b GREEN — typed run reads:** add run-scoped specification and implementation-plan reads that first resolve the tenant-owned run and exact referenced identity; return stable 404s for missing/foreign/mismatched rows.
- [x] **23c RED/GREEN — bounded artifact port:** add a tenant-scoped artifact repository read plus a fail-closed object-content port capped before response serialization; never expose `storage_ref` or service credentials.
- [x] **23d SDK/verification:** regenerate OpenAPI/SDK deterministically; run focused contracts/control/API-client tests plus touched lint/typecheck/build and diff/boundary checks; record and commit once.

### Task CP-24 [M2]: Public builder artifact surfaces

**Files:** Modify workspace/Mission Control routes and service clients, contracts, OpenAPI/SDK and tests.
**Effort:** L. **[expand-at-execution]**

- [x] Binding behavior: tenant/RBAC bridges to WS-16, GIT-5, and VF-17 for files, attributed edits, commit comparison, logs, test cases, evidence, downloads, and Fix-run creation; no internal credential exposure.
- [x] Commit: `feat(control-api): public builder artifact surfaces`

Execution expansion (2026-08-12):

- [x] **24a RED/GREEN — workspace artifacts:** add bounded project workspace discovery and tenant/RBAC file list/read plus keyed Owner/Builder edits attributed to the authenticated user.
- [x] **24b RED/GREEN — comparisons:** bridge exact before/after SHAs through the service-authenticated GIT-5 comparison boundary without returning internal refs or credentials.
- [x] **24c RED/GREEN — verification:** bridge VF-17 run/case and exact-provenance signed evidence reads; keep downloads short-lived and storage refs private.
- [x] **24d SDK/verification:** retain the existing public logs and Fix-run creation surfaces, regenerate OpenAPI/SDK, run focused contracts/control/client plus touched lint/typecheck/build and commit once.

### Task CP-25 [M2]: Public template registry + Remix creation

**Files:** Modify project/template routes, composition, contracts, OpenAPI/SDK and tests.
**Effort:** M. **[expand-at-execution]**

- [x] Binding behavior: registry list/detail and discriminated template project source by slug; resolve approved repository refs server-side and seed through GIT-5/GIT-6 before project success; stable replay.
- [x] Commit: `feat(control-api): public template remix contract`

Execution expansion (2026-08-12):

- [x] **25a RED/GREEN — public registry:** expose bounded list/detail responses containing presentation fields only; unknown slugs return a stable 404 and private repository refs/SHAs never serialize.
- [x] **25b RED/GREEN — typed Remix source:** make template creation require `sourceType: "template"` plus an approved `templateSlug`; reject arbitrary source refs and validate the slug against the server registry.
- [x] **25c RED/GREEN — seed and replay:** create the internal repository, seed its exact approved template through GIT-6 before returning project success, and prove one stable seed call across an idempotent replay.
- [x] **25d SDK/verification:** bind the registry in production composition, regenerate OpenAPI/SDK, run focused route/client and touched lint/typecheck/build gates, then record and commit once.

### Task CP-26 [M3]: Settings + organization directory APIs

**Files:** Modify org/integration/project routes and tenant views, DB where required, OpenAPI/SDK and tests.
**Effort:** L. **[expand-at-execution]**

- [x] **26a RED/GREEN — directory:** list active members with public identity fields and unexpired pending invites; enforce tenant membership and member-management RBAC.
- [x] **26b RED/GREEN — integration settings:** list secret-free connection status for every provider (including Vercel) and disconnect by stable idempotency key with audit.
- [x] **26c existing lifecycle proof:** retain the landed settings, archive, deletion request, and deletion-status timeline contracts; regenerate the public SDK and verify focused control/API-client gates.
- [x] Binding behavior: member/pending-invite directory; integration status/disconnect including Vercel; project archive/delete timeline; existing secret values stay write-only.
- [x] Commit: `feat(control-api): settings and member directory APIs`

### Task CP-27 [M5]: Public desktop notification projection

**Files:** Modify notification routes/store/composition, DB where required, OpenAPI/SDK and tests.
**Effort:** M. **[expand-at-execution]**

- [x] Binding behavior: authenticated per-user/device cursor replay and per-type preferences for approval, run, and deployment notifications; bounded reconnect; tenant isolation and secret-safe payloads.
- [x] Commit: `feat(control-api): desktop notification delivery API`

### Task CP-28 [M6]: Durable project conversations and public history

**ADR:** ADR-0034. **Files:** Modify conversation/event contracts, planning/execution schema and migration, run/conversation routes and tenant repositories, OpenAPI/generated SDK, composition, tests, this plan, Plans 04/08, and `tasks/todo.md` as enumerated by `docs/superpowers/plans/2026-08-16-durable-project-conversations.md`.
**Effort:** XL. **[expand-at-execution]**

- [x] **28a RED/GREEN — schema foundation:** add strict conversation/history and `message.applied` contracts; add tenant-scoped conversations, ordered run membership, immutable successor-context artifacts, and durable Builder transcripts; migrate every legacy run into a deterministic conversation without changing event or accounting counts.
- [x] **28b RED/GREEN — public API:** expose bounded newest-first project conversation summaries and deterministic structured cross-run event history; extend keyed run creation so omission atomically creates a conversation and a terminal conversation creates one successor with bounded server-owned context.
- [x] **28c isolation/race proof:** return 404 for foreign projects/conversations/runs/events, reject concurrent successors with `conversation_run_active`, preserve stable idempotent replay, and filter internal events from public history.
- [x] **28d SDK/verification:** regenerate OpenAPI and `@zapp/api-client`; run focused contracts, DB, control-api, SDK, integration, lint/typecheck/build and architecture gates; visibly report infrastructure-gated skips.
- [x] Binding interfaces: `GET /v1/projects/:projectId/conversations`, `GET /v1/conversations/:conversationId/events`, optional `conversationId` on `POST /v1/projects/:projectId/runs`, `message.applied`, and generated SDK methods. No UI-private route.
- [x] Step commits: `feat(db): add durable project conversations`, then `feat(control-api): add public conversation history` with tracker/log completion in the second commit.

---

## Testing strategy
- Unit: route handlers with fake ports; permission matrix table-driven.
- Integration: compose Postgres/Redis; the tenant-isolation and SSE suites are permanent CI jobs.
- Contract: OpenAPI snapshot diff on PR (breaking-change detector: removed field/route → CI failure without `api-breaking` label).

## Scalability notes
- SSE: any node serves any run (replay from DB + Redis tail) — no sticky sessions; ping-then-read keeps Redis payloads tiny and ordering DB-authoritative.
- Keyset pagination + per-org rate limits from day one; dashboard queries covered by indexes added in FND-6.

## Security & tenancy notes
- 404-not-403 for cross-tenant; secrets metadata-only reads; decrypt allowlist + audit; service tokens short-TTL (300 s) minted per call.
- Session cookies: httpOnly, Secure, SameSite=Lax; CSRF: state-changing routes require `x-zapp-csrf` double-submit token for cookie auth (bearer/device tokens exempt).

## Execution log
- 2026-08-12 CP-26 done — Added public member/pending-invite directory and secret-free integration list/disconnect including Vercel, retained existing settings/archive/deletion timeline, regenerated the SDK, and passed focused 52/52 control, 56/56 SDK, 5/5 Redis invite, lint, and typecheck gates.
- 2026-08-16 CP-28 done — Added tenant-scoped project conversations, ordered cross-run history, verified successor context, concurrency-safe keyed creation, and named generated SDK methods; PostgreSQL checks skipped visibly because `DATABASE_URL` is unset.

- (empty)

## Execution log
- 2026-08-04: CP-1 done pending review (9bc70a8). DEFERRED INTO CP-2 SCOPE: migration revoking UPDATE/DELETE on usage_ledger + audit_events from the app role (was CP-1 note; FND-6 was mid-flight). Forward flags: fastify-type-provider-zod pinned ^4 (Zod-3 API — revisit at Zod 4 migration); no direct pino dep (fastify bundles it).
- 2026-08-12 CP-24 done — Added tenant/RBAC workspace discovery, bounded file reads and attributed keyed edits, exact commit comparison, typed tests/evidence with short-lived downloads, production service-token clients, and regenerated SDK; 801/811 control tests passed before one stale route-absence assertion was corrected and focused green, plus 56/56 API-client tests.
- 2026-08-12 CP-17 done — shipped classified TTL retention plus leased, absence-verified project/org deletion; required schema, generated SDK, git-service, sandbox-service, verification-service, and composition files beyond the terse task list. Two review rounds fixed durable post-delete replay, fail-closed composition/provider proof, and a row-locked organization deletion fence.
- 2026-08-12 CP-17 integration fix — removed cascading run/approval foreign keys from append-only credit-ceiling history so deletion retains immutable attribution without firing a forbidden ledger delete; schema regression, DB 157/157, and orchestrator integration 43/43 verify the correction.
- 2026-08-12 CP-18 done — shipped deterministic Owner-only tar exports with durable fresh-URL replay, bounded PostgreSQL/Git/S3 paths, deletion fencing/cleanup, generated SDK, and immediate Git credential revocation; expanded the terse Files list for required service/SDK composition, and corrected one provider-test-only strict-input fixture before the focused real Forgejo pass.
- 2026-08-04: CP-1 done (9bc70a8, review Approved; 12 tests + 20 reviewer edge-probes clean). buildApp deps narrowed to growing AppDeps (sanctioned). Folded into CP-2: branch-4 + hook-throw tests, errorHandler serializer bypass (template hardening), dev script (tsx watch convention), @zapp/db first import, grants migration.
- 2026-08-04: FND-6 note for CP-13: agent_events has NO project_id column (PRD §23.4 omits it; AgentEventSchema carries projectId) — CP-13 ingest either adds a one-line migration (preferred, enables per-project queries) or joins agent_runs. Decide at CP-13.
- 2026-08-04: CP-13 additional binding notes from FND-6 review: (a) payload cap check must measure BYTES (Buffer.byteLength), not JSON.stringify().length — DB CHECK is pg_column_size; (b) resolve runId within the tenant BEFORE calling nextEventSequence (it takes no org — a cross-tenant bump would inject a sequence gap).
- 2026-08-04: CP-2 security review found a CRITICAL (device grant approved as a side effect of login → crafted link yields victims tokens). Fix in flight. PLAN AMENDMENT: device flow is a zapp-native RFC 8628 flow with an EXPLICIT consent endpoint (POST /v1/auth/device/approve behind session+CSRF), not "Stytch OAuth + PKCE" — sanctioned deviation (confidential server-side client). WEB-12/WEB-1 must add the /device consent screen showing the user code before approval.
- 2026-08-04: CP-5 hardening list (from CP-2 review): Redis denylist must use SET NX PX for atomic rotation; session_replication_role=replica can disable append-only triggers on superuser connections; add __Host-/__Secure- cookie prefixes; make CSRF default-on for unsafe methods rather than per-route opt-in; startup guard against in-memory stores in production.
- 2026-08-04: CP-2 done (c29623d + fix b35de36, review Approved after a CRITICAL device-consent finding). 74 unit + 10 integration (2 Stytch env-skipped). BINDING FOR WEB PLAN: the /device consent screen (shows user code, Approve/Deny) is a web-app obligation — WEB-1/WEB-12 must implement it; API is POST /v1/auth/device/{approve,deny} behind session+CSRF.
- 2026-08-04: CP-3 done (196e41e, review Approved; 27/27 PRD §22.2 cells verified exact, 155 unit + 28 integration). MANDATORY FOLD INTO CP-5 (do these FIRST, before modelling pending memberships):
  1. **Important** — `membership()` in `src/orgs/store.ts` filters `ne(status,'removed')`, so an `'invited'` row would authorize with full role permissions; the last-owner guards in the same file already require `status='active'`. Split the predicate: **authorization requires `status='active'`**; targeting a member for setRole/removeMember keeps `ne(removed)`. Latent only because nothing writes `'invited'` today — CP-5 is what makes it live.
  2. Invite claim + membership write must share one transaction (today `claim()` spends the invite before `addMember`, so a failure strands the invitee on 410 with no self-service recovery).
  3. `setRole` should return the updated record (route currently re-reads outside the store call → spurious 404 + skipped audit row on a concurrent removal; audit metadata records the re-read role, not the requested one).
  4. Minors: `builderCanDeploy` consulted for any 'configurable' cell (scope to the builder cell); derived slugs bypass SlugSchema min(2); `GET /v1/organizations` promises `nextCursor` it never paginates; rate-limit `POST /v1/organizations` (each success mints a Stytch org); Stytch-org reconciliation note wherever the org-id column lands.
- 2026-08-04: CP-4 done (2408820, review Approved; 33-test isolation suite + 169 unit + 61 integration; wired as CI job "tenant isolation (M0 exit criterion)" — verified to fail if the suite file is deleted AND if DATABASE_URL is missing under CI). Negative controls verified load-bearing by the reviewer (reject-everything mutation fails them). **M0 SIGN-OFF BLOCKER folded into CP-5:** server.ts never wired `tenant`, so the criterion was proven only against a test-only composition — CP-5 wires it + adds a composition test + makes the orgs-without-tenant combination an explicit refusal. Known residual for CP-6+ authors: routes taking an unscoped store (orgs.ts) bypass ctx.db by construction; isolation there depends on every handler calling membershipOf first.
- 2026-08-04: CP-5 done pending fixes (8f11304, review: audit + all 7 folds + all 5 addendum items APPROVED; rate-limit deliverable Needs fixes). Audit-in-transaction proof called "the real one" (throws inside the hook, counts both tables to zero against real Postgres). **CP-5 FIX ROUND (queued behind CP-6 — same package):**
  1. **Important** — `request.ip` is proxy-blind: no `trustProxy`, yet env.ts states the service sits behind a proxy. The `auth` class (scope: ip) collapses to ONE global 10/min bucket for all `/v1/auth/*` across every client — any caller 429s everyone's sign-in, and per-attacker brute-force limiting isn't delivered at all. Fix is NOT `trustProxy: true` (makes XFF client-controlled = full bypass); use an explicit trusted-hop count / CIDR list driven from config/rate-limits.json.
  2. **Important** — shipped auth limit (10/min, refill 1/6s) is BELOW the shipped device poll interval (5s = 12/min): a device sign-in starts 429ing five minutes into a ten-minute grant window, and the browser leg shares the bucket. Carve `device/token` out of the `auth` class or reconcile the numbers.
  3. **Important** — idempotency `onSend` awaits store.complete/release unguarded: a Redis blip AFTER commit turns a successful mutation into a 500, and the un-completed reservation makes the retry 409 for 60s then re-run the handler — creating the duplicate the plugin exists to prevent. Wrap in catch+log → degrade to at-least-once.
  4. Minors: fold user id into the idempotency scope alongside org (removes a whole class of same-org key collisions; note replay is served before authorize() runs); log when MAX_STORED_BODY_BYTES releases a key; `addMember` audits a no-op re-join (append-only, uncorrectable); document why session lifecycle events are unaudited (org-scoped table, no org); stale comment at test/support/harness.ts:39.
- 2026-08-04: CP-6 done (fdca3c4, review Approved; 230 unit + 113 integration, isolation 33→41). Transaction boundary + rollback proved by counting five PostgreSQL tables; keyset pagination walked to exhaustion; per-org slug 409 comes from the index with NO application pre-check (so it cannot become a global oracle). Both sanctioned deviations confirmed correct (sourceType narrowing — nothing in the repo still sends the old values; supportLevel removal — tiers are earned by the scan per PRD §7.1). **FOLD INTO CP-7 (same package, sequential):**
  1. **Important** — `internal_repo_ref` is derived from the MUTABLE slug (`<orgId>/<projectSlug>`), but PATCH accepts a slug change and never touches the repositories row. Rename desyncs the ref; rename-then-reuse mints a SECOND row with the same ref (no unique constraint on internal_repo_ref). Fix: derive from the immutable project id, and/or add unique (organization_id, internal_repo_ref). Add the ref-after-rename test that is currently missing.
  2. **Important** — the record-only repositories row is indistinguishable in DATA from a GIT-2-provisioned one (comments aren't queryable). Add a nullable `provisioned_at` (or provider `internal_pending`) so plan 06 can find exactly the rows it must retrofit. Needs a small additive packages/db migration.
  3. **Important (contract, before GIT-2 implements it)** — `GitServicePort.createRepository` is awaited inside an open Postgres transaction; instantaneous for the record-only impl, but under Forgejo HTTP a hung provider pins a connection and an open transaction for the duration. Keep the placement (atomicity is right); ADD a bounded deadline to the port's contract + document pool implications.
  4. Minors: scan response `status: 'queued'` → `'accepted'` (nothing is enqueued; a client polling on `queued` waits forever); add index (organization_id, id DESC) for the keyset order; make CreateProjectBody `.strict()` so a stale `supportLevel` 400s like a stale `sourceType` does; log the git failure cause server-side behind redaction; narrow `isUniqueViolation` to the slug constraint; move `drizzle-orm` from devDependencies to dependencies (imported at runtime — a --prod install fails at boot).
- 2026-08-04: CP-5 fully done (8f11304 + fix 715b4f1, review Approved). Rate-limit proxy trust cannot return `true` by construction (config → false|number|string[]); device-poll budget test derives from the constants so the files cannot drift; idempotency degrades to at-least-once after commit. Residual: ~5 concurrent device logins behind ONE address still share the 60/min ip bucket — inherent to an ip-scoped class, trustedProxies is the lever.
- 2026-08-04: CP-7 done (df4d067, review Approved — adversarial security read found NO plaintext path, NO crypto misuse, NO cross-tenant decrypt). 275 unit / 124 integration / isolation 46 (negative controls 7→8). Design that earned the verdict: ciphertext on a SEPARATE `secret_ciphertexts` table (metadata queries have no value column in reach), three independent barriers on value exposure, fresh DEK+IV per encryption, pinned authTagLength on the decipher (closes truncated-tag acceptance), audit inside the read's transaction, `decryptSecret` deliberately absent from the package barrel, deny-all verifier until CP-8. Two Importants folded into CP-8: /internal/* unauthenticated rate limiting; SECRETS_PREVIOUS_MASTER_KEY empty-string schema (boot-blocking on fresh checkout). Residual for plan 03/CP-8: an allowlisted service token may name ANY organizationId — bind the caller to the run whose org it names. redactSecrets is byte-literal (JSON-escaped/base64/URL-encoded values pass through) and leaves a fragment on OVERLAPPING values — document before wiring into log/model-context paths.
- 2026-08-04: CP-8 done (a78e7c1 + fix 23b3ff1, review fully Approved — "strongest credential work in the plan"). 21/21 mutations caught. Absolute lifetime bound + window-width bound BOTH falsifiable (each catches a forgery the other cannot). FakeServiceTokens deleted, so the M0 isolation gate runs on real HS256. **M0 CONTROL PLANE COMPLETE (CP-1..CP-8).**
- 2026-08-04 CP-9 done — added tenant-scoped run/workspace lifecycle ports and routes, plus the fail-closed real control-api → git-service → Forgejo GATE-5 harness; local credential-gated integration suites remain explicitly skipped where credentials are absent.
- 2026-08-04 CP-9 fix round 2 — completed route-wide Owner/Builder/Viewer and foreign-ID mutation coverage; GATE-5 tracker checked after the controller's real Forgejo 1/1 rerun.
- 2026-08-04 CP-10 done — versioned tenant-scoped specifications with stable create recovery, atomic audits, and immutable approval. Temporary documented assumption: CP-10 defines a strict local PRD §12.2 schema because AR-16 (not AR-21) owns the shared SpecificationSchema; AR-16 should replace this local schema when it lands.
- 2026-08-04 CP-10 Fix Round 1 done — required idempotency keys for PATCH/approve, made lost PATCH responses audit-stable, seeded real foreign-resource 404 coverage, and centralized the temporary local schema/types in tenant/view.
- 2026-08-04 CP-10 Fix Round 2 done — replaced latest-audit replay detection with a tenant/specification/operation-key history lookup, so a stale lost PATCH retry cannot overwrite an intervening edit.
- 2026-08-04 CP-11 done — temporary shells use candidate `{environmentId,commitSha,specificationId|null}`, replace-only `dataDisposition`, and GitHub installationId/Supabase projectRef/Neon projectId/Stripe accountId+mode configurations; injected Builder settings default deny; added tenant-explicit `getRelease` read.
- 2026-08-04 CP-12 BLOCKED: the required durable organization settings have no PRD §23.1/Drizzle storage, while schema conformance rejects undocumented columns/tables. Proposed ADR-0004 adds `organizations.settings_json`; human approval is required before plan/schema/code changes. Task and tracker remain unchecked.
- 2026-08-04 CP-12 done — Added tenant-safe audit reads, durable organization settings, generated public API/SDK contracts, shared schema-first audit vocabulary, strict Git audit metadata, and truthful idempotent no-op updates; independent review CLEAN and detached package/root verification green, with live DB/Redis/Stytch/Forgejo/artifact suites skipped visibly because credentials are unset.
- 2026-08-04 CP-13 execution assumption: choose the FND-6 note's additive migration path and retain all PRD §14.4 top-level replay context absent from the conceptual `agent_events` row (`project_id`, `phase_id`, `task_id`, `agent_id`), documented in the schema-conformance allowlist. The internal route uses a route-specific orchestrator token, required idempotency key, tenant/run/project validation before sequence allocation, and one transactional batch audit + NOTIFY.
- 2026-08-04 CP-13 done — sequenced service-only event ingest persists full replay context, audits each committed batch, and sends transactional PostgreSQL NOTIFY.
- 2026-08-04 CP-14 done — committed event notifications now publish Zod-validated high-water pings through Redis, with bounded LISTEN retry and a 2-second database polling fallback.
- 2026-08-04 CP-15 implementation committed — resumable tenant-scoped SSE now has bounded replay, bounded shutdown, and serialized backpressure; review pending.
- 2026-08-04 CP-15 BLOCKED: final review 5/5 found shutdown still waits indefinitely for an already-stalled database `byRun()` read and valid bare post-`q` Accept extensions are rejected; task/tracker remain unchecked pending explicit approval for another remediation round.
- 2026-08-04 CP-15 done — accepted ADR-0008; resumable tenant-scoped SSE now bounds replay and backpressure, revalidates active authorization, enforces stream ceilings, and safely cancels active or pool-queued PostgreSQL replay; final review CLEAN with clean-checkout DB 48/48, tenant isolation 46/46, SSE 57/57, and root gates green.
- 2026-08-04 CP-16 done — versioned OpenAPI and generated SDK preserve security alternatives, exact status/body/media/header contracts, typed redirects, and resumable validated SSE; final review CLEAN with SDK 49/49, control API 415/415, forced build 7/7, lint 12/12, and typecheck 11/11.
- 2026-08-05 M1 prerequisite fix done — control-api now directly declares TypeScript 5, preventing clean installs from resolving its build script to TypeScript 6 through openapi-typescript.
- 2026-08-07 CP-14 test amendment — the fanout SLO test never ran locally before (it was env-skipped; the new pre-push gate arms refuse-to-skip and runs it). It failed: the clock started before the POST, and the cold insert path alone measured 875 ms of a 998 ms total; actual NOTIFY→Redis fanout was ~120 ms. (Attribution correction, same day: those numbers were measured against a remote Neon DATABASE_URL that .env carried at the time, not against the local stack — the gate now pins localhost. The amendment stands on its own: wall-clock is a property of wherever DATABASE_URL points.) Clock now starts at commit (the 201) and the bound is 2 s — every break the test catches (no bridge, wrong channel, fabricated sequence, publish-before-commit) fails at any bound. Production 500 ms SLO enforcement belongs to ops metrics (plan 10), not this test.
- 2026-08-10 CP-21 done — tenant-bound batch dashboard summaries, generated SDK, and `agent_events` project-time index verified by focused control-api (15), api-client (52), db schema (14), lint, and typecheck; no credential tests skipped.
- 2026-08-10 M1-GATE-10 done — Accept-negotiation integration probes now await bounded SSE body cancellation before connection reuse, closing the full-gate cancellation race that intermittently returned HTTP 500.
- 2026-08-10 M1-GATE-13 done — Accept-negotiation probes now await the matching server-side subscription close after bounded client cancellation, preventing a later probe from reusing a connection while PostgreSQL replay cleanup is still active; focused 2/2, full integration 257/257, package 489/489, lint/typecheck/build green, and review PASS.
- 2026-08-10 CP-20 done — Added typed conversation events, idempotent continuation signalling, tenant-scoped R2 image attachments with run-scoped artifact events, a 10-image/8-MiB-per-image contract, and regenerated SDK support; no model-provider call required.
- 2026-08-10 CP-21 done — Added the tenant-scoped public logs/restart/capture/screenshot bridge and generated SDK; capped review re-scoped ambiguous screenshot replay into CP-21-FIX-1, and no provider run was required.
- 2026-08-10 CP-21-FIX-1 done — Fenced screenshot capture with a durable conditional artifact-store reservation, bounded replay reads, retry-safe completion audits, final round-2 PASS, and no provider call.
- 2026-08-12 CP-22 done — Added server-derived builder eligibility, keyed retry/skip routes, typed stored-kind approvals, deterministic SDK output, and rollout-compatible budget decisions; no provider call.
- 2026-08-12 CP-23 done — Added keyed typed card responses, run-scoped specification/plan projections, SHA-verified 64-KiB artifact reads, and deterministic SDK routes; no provider call.
- 2026-08-12 CP-25 done — Added presentation-only template APIs and exact-slug Remix creation with server-owned seeding and idempotent replay; no provider call.
- 2026-08-12 CP-27 done — Added bounded authenticated desktop-notification cursor replay over the existing strict projection and preference boundary, with atomic Redis cursor append, per-user/tenant isolation, reconnect guidance, and regenerated SDK; no provider call.
- 2026-08-13 CP-3-FIX-1 done — Self-service Stytch discovery and transactional default workspace bootstrap shipped; updated dependent org/audit/isolation fixtures for the new login invariant.
- 2026-08-17 CP-17-FIX-1 done — Project deletion now terminates and confirms every tenant-scoped provider workspace, including stopped containers whose durable rows were already terminal, before snapshot and PostgreSQL deletion can advance; full verification passed with database and live cloud-provider cases skipped visibly when credentials were unset.
