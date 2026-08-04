# Plan 02 — Control Plane & Multitenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A secure multitenant control-plane API (auth, organizations, RBAC, projects, environments, secrets, audit, SSE event streaming) that the web app, macOS app, and internal services consume — PRD §20.3, §22, §23, §31, §32.

**Architecture:** Fastify service (`services/control-api`, port 4000) with Zod-validated routes generating OpenAPI, Stytch B2B for identity behind an `AuthPort` (one Stytch Organization per zapp org; zapp's own tables remain the membership source of truth), tenant context resolved per request and threaded through the `packages/db` scoped repositories, `agent_events` as the SSE source of truth with Redis fanout. Internal service-to-service auth via HMAC service tokens.

**Tech Stack:** Fastify 5, `fastify-type-provider-zod`, Stytch Node SDK (B2B), jose (JWT), Upstash Redis client, @zapp/db, @zapp/contracts, openapi-typescript for SDK generation.

**Milestone:** M0 (CP-1..8) + M1 (CP-9..16) + M5 (CP-17..18). **Depends on:** Plan 01. **Consumed by:** all plans.

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
Routes (PRD §32.2/§32.3): `POST /v1/projects/:projectId/runs` (mode, prompt, branchId?, budget? → creates `agent_runs` row status=`queued`, starts Temporal workflow via `OrchestratorPort`, returns run), `GET /v1/runs/:runId`, `POST /v1/runs/:runId/{pause,resume,cancel,redirect}` (signal via OrchestratorPort; 409 `invalid_run_state` when not applicable), workspace routes proxying to sandbox-service with tenancy checks (`POST /v1/projects/:projectId/workspaces`, `GET /v1/workspaces/:id`, `POST /v1/workspaces/:id/{start,checkpoint,terminate,preview}`). Raw fs/command APIs are **not** exposed (PRD §32.3 note).
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

- [ ] Steps: failing RBAC tests (Builder with `builderCanDeploy=false` → 403 on `POST /v1/releases/:id/deploy`) → implement → commit: `feat(control-api): release + integration route shells with RBAC`

### Task CP-12: Audit log read API + org settings

**Files:** Create: `src/routes/audit.ts`
Routes: `GET /v1/organizations/:orgId/audit-events` (Owner only, keyset paginated, filter by actor/action/target/time range), `GET/PATCH /v1/organizations/:orgId/settings` (builderCanDeploy, defaultModelPolicy passthrough config JSON).
**Effort:** S

- [ ] Steps: failing tests (Builder → 403; filters work) → implement → commit: `feat(control-api): audit log reads + org settings`

### Task CP-13: Event write path (internal ingest)

**Files:** Create: `src/internal/events.ts`, `test/integration/events-ingest.test.ts`
**Interfaces produced:** `POST /internal/runs/:runId/events` (service token; body: array of events WITHOUT id/sequence; server assigns `newId("evt")` + `nextEventSequence` in one tx, inserts, `pg_notify('agent_events', runId)`). Batch ≤ 100. This is the ONLY write path for events (orchestrator-worker uses it — keeps one DB writer for sequencing).
**Effort:** M

- [ ] Steps: failing tests (batch insert assigns contiguous sequences under concurrency; payload > 64 KB → 413 `payload_too_large` telling caller to use artifacts; visibility validated) → implement → commit: `feat(control-api): sequenced event ingest with NOTIFY`

### Task CP-14: Redis fanout publisher

**Files:** Create: `src/events/publisher.ts`, `test/integration/publisher.test.ts`
**Effort:** M

- [ ] **Step 1:** Failing test: insert event via CP-13 → within 500 ms a Redis subscriber on channel `run:{runId}` receives `{ sequence }` ping.
- [ ] **Step 2:** Implement: dedicated pg LISTEN connection with reconnect/backoff; on notify, publish lightweight ping (subscribers re-read from DB — guarantees order/no-loss); on Redis outage, SSE degrades to 2 s DB polling (documented behavior, test simulates).
- [ ] **Step 3:** Commit: `feat(control-api): LISTEN/NOTIFY → Redis event fanout`

### Task CP-15: SSE stream endpoint

**Files:** Create: `src/events/sse.ts`, `test/integration/sse.test.ts`
**Interfaces produced:** `GET /v1/runs/:runId/events` with `Accept: text/event-stream`: replays rows `sequence > Last-Event-ID` (or `?after=`), then live-tails via Redis ping → DB read; each SSE message: `id: {sequence}`, `event: {type}`, `data: {AgentEvent JSON}`; heartbeat comment every 15 s; visibility filter: user sessions get `visibility=user`; support role param gets `user+support`; `internal` never leaves the service boundary.
**Effort:** M

- [ ] **Step 1:** Failing integration test: create 5 events → connect with `Last-Event-ID: 2` → receive 3,4,5 then a live 6 within 2 s; internal-visibility event never appears; disconnect/reconnect resumes without duplicates (client dedupe by sequence asserted server sends none twice for a stable cursor).
- [ ] **Step 2:** Implement with backpressure (pause DB tail if socket buffer full), 4 h max connection (client reconnects).
- [ ] **Step 3:** Commit: `feat(control-api): resumable SSE run event stream`

### Task CP-16: OpenAPI + generated SDK

**Files:** Create: `services/control-api/src/openapi.ts`, `packages/api-client/*`
**Effort:** M

- [ ] Steps: serve `/v1/openapi.json` from zod route schemas → generate `packages/api-client` via openapi-typescript + a thin fetch wrapper (`createZappClient({ baseUrl, getToken })`, SSE helper `subscribeRunEvents(runId, { after, onEvent })` with auto-reconnect + Last-Event-ID) → contract test: generated types compile against a live app instance's JSON → commit: `feat(api-client): generated typed SDK with SSE helper`

### Task CP-17 [M5]: Data retention & deletion pipeline

**Files:** Create: `src/jobs/retention.ts`, `src/jobs/deletion.ts`, `test/integration/deletion.test.ts`
**Effort:** L. **[expand-at-execution]**

Binding behavior: nightly retention job enforces PRD §31.4 TTLs (agent_events 90 d → archive to R2 then drop partition; test artifacts 30 d; diagnostics 7 d); project deletion enqueues a deletion record fanning out to Postgres rows, R2 prefixes, git-service repo delete, Modal snapshot deletes (via sandbox-service), then verifies each target reports absence before marking complete; org deletion cascades projects; audit rows retained per policy. Test: delete a seeded project → poll status → verify data gone from each store (MinIO/dev services).

### Task CP-18 [M5]: Export APIs

**Files:** Create: `src/routes/export.ts`
**Effort:** M. **[expand-at-execution]**

Binding behavior (PRD §36.5): `POST /v1/projects/:id/export` produces artifact bundle: git bundle (via git-service), spec JSON, plan JSON, evidence manifests, env var **names**, audit log (Owner only); download via signed URL; secrets never included.

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

- (empty)

## Execution log
- 2026-08-04: CP-1 done pending review (9bc70a8). DEFERRED INTO CP-2 SCOPE: migration revoking UPDATE/DELETE on usage_ledger + audit_events from the app role (was CP-1 note; FND-6 was mid-flight). Forward flags: fastify-type-provider-zod pinned ^4 (Zod-3 API — revisit at Zod 4 migration); no direct pino dep (fastify bundles it).
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
