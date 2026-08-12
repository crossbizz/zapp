# Plan 06 — Git & Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internal Git service (Forgejo) with scoped tokens and backups; GitHub App import/sync/export; Supabase, Neon, and generated-app Stripe adapters — PRD §19, §25, §26.2, §26.3.

**Architecture:** `services/git-service` (4500) wraps Forgejo behind a `GitProvider` interface (provider-neutral per PRD §19.1); internal Git is the source of truth for every project. GitHub is a peer remote synchronized at commit boundaries only. Database/billing integrations are `IntegrationProvider` implementations registered in `integration_connections`, with credentials in the CP-7 vault.

**Tech Stack:** Forgejo 9 (Fly.io + volume), simple-git/isomorphic-git (service-side ops), Octokit + GitHub App JWT, Supabase Management API, Neon API, Stripe SDK.

**Milestone:** GIT-1..4 (M0–M1), INT-1..2 (M1 pull-forward), GIT-5..6 (M2), INT-10 (M3), INT-3..9 + GIT-7 (M4). **Depends on:** Plans 01, 02. **Consumed by:** 03 (clone/push), 07 (release commits), 04 (fix-mode restore), 08 (templates/settings), 09 (desktop sync).

## Global Constraints

Master plan §Global Constraints, plus:
- Git commit is the only synchronization boundary; no silent overwrite of external changes (PRD §19.3).
- Repo tokens are repository-scoped, short-TTL (300 s), minted per operation, audited.
- Platform Stripe credentials and generated-app Stripe credentials are separate connections, separate vault scopes, separate log streams (PRD §26.3).
- Production releases reference exact commit SHAs — never branch names.

## File structure owned

```text
services/git-service/src/{app,provider/{types,forgejo},tokens,backup,routes}.ts
services/control-api/src/routes/integrations.ts   (implementations replace CP-11 fakes)
packages/agent-tools/src/integrations/{supabase,neon,stripe}.ts   (agent-visible tools)
infra/terraform/{forgejo,github-app}.tf
templates/stripe/*  (generated-app billing templates)
```

---

### Task GIT-1: Forgejo deployment + bootstrap

**Files:** Create: `infra/terraform/forgejo.tf`, `infra/docker/forgejo/app.ini` (prod variant), `services/git-service/scripts/bootstrap.ts`
**Effort:** M

- [x] Binding behavior: Fly app `zapp-forgejo-{env}` with volume; app.ini: registrations disabled, API-only admin, webhooks allowed to control-api host, LFS enabled; bootstrap script creates admin token + org `zapp-projects`; health check wired.
- [ ] Verify: terraform plan clean — **not done.** Terraform is not installed on
      the machine this was authored on and `plan`/`validate` need `terraform init`
      to fetch the provider first. Left unchecked rather than ticked with a
      footnote: a checkbox is what somebody scans, and one that claims a
      verification the prose retracts is worse than an empty one (GIT review).
- [x] Verify: bootstrap idempotent (second run no-ops).
- [x] Commit: `feat(infra): forgejo internal git deployment`

**Delivered against a dev stack that already runs Forgejo.** FND-7's compose file
starts it and `scripts/dev-up.sh` mints its admin token, so this task shipped the
*deployed* half only: `infra/terraform/` (app, volume, addresses, certificate),
`infra/fly/forgejo/` (image + machine config), `infra/docker/forgejo/app.ini.prod`
and `services/git-service/scripts/bootstrap.ts`. The dev compose stack is
unchanged — see `infra/terraform/README.md` for the dev-vs-prod split.

Two deviations from the text above, both deliberate:

- **The admin token is not created by the bootstrap script.** Forgejo's API
  refuses to mint a token without HTTP basic auth, so the first one has to come
  from the CLI on the host (`forgejo admin user generate-access-token`) — which
  is what `scripts/dev-up.sh` does in dev and what the runbook does in a
  deployment. The script *verifies* the token instead, and that it belongs to an
  administrator: a non-admin token otherwise fails at the first customer project
  create rather than at deploy time.
- **`terraform validate` is unverified**, not clean: terraform is not installed
  on the machine this was authored on and `validate` needs `terraform init` to
  fetch the provider first. Recorded in `infra/terraform/README.md`.

### Task GIT-2: git-service + GitProvider interface

**Files:** Create: `services/git-service/src/{app,provider/types,provider/forgejo,routes}.ts`, `test/integration/forgejo.test.ts` (against compose Forgejo)
**Interfaces produced (binding):**

```ts
export interface GitProvider {
  createRepository(input: { projectId: string; organizationId: string }): Promise<{ internalRepoRef: string; cloneUrl: string }>;
  deleteRepository(ref: string): Promise<void>;
  createBranch(ref: string, name: string, fromSha: string): Promise<void>;
  getBranch(ref: string, name: string): Promise<{ headSha: string }>;
  protectBranch(ref: string, name: string): Promise<void>;          // release/* protected
  listCommits(ref: string, branch: string, opts: Page): Promise<Commit[]>;
  getCommit(ref: string, sha: string): Promise<CommitDetail>;       // + diffstat
  createTag(ref: string, tag: string, sha: string): Promise<void>;  // release tags rel_*
}
```

Routes `/internal/git/*` (service-token). Repo naming: `org_{orgId}/proj_{projectId}` (Forgejo org per zapp org created lazily — tenant path isolation).
**Effort:** L

- [x] Failing integration tests: create repo → clone URL works with admin token; branch protect blocks force-push; per-org Forgejo org isolation (repo of org A not listable with org B scoped token — asserted in GIT-3 test).
- [x] Commit: `feat(git-service): forgejo-backed GitProvider`

Where the pieces landed, and the two decisions worth knowing:

- **The `GitProvider` interface is in `packages/contracts`** (`src/git.ts`), not in
  the service. PRD §19.1 calls the contract provider-neutral, and it has no
  runtime dependency beyond zod, so the control plane can depend on it without
  depending on Forgejo. The Forgejo implementation is `services/git-service`.
- **`internalRepoRef` is one function, called by both sides.** CP-6 already
  derived `org_{ulid}/proj_{ulid}` from the immutable ids — the same shape this
  plan specifies, because a TypeID *is* `org_<ulid>` — so nothing had to change
  to make them agree; the derivation simply moved into the contract so they
  cannot stop agreeing.
- `SERVICE_NAMES` in `@zapp/config` gained `control-api`. CP-8 defined the
  control plane as a verifier and explicitly not a caller; creating a project now
  provisions a repository through this service, so it holds a credential like any
  other caller and must be nameable as `sub`.
- Routes address a repository by `(organizationId, projectId)` and derive the ref
  themselves. A caller that could name a ref could name *any* ref, and this
  service holds the Forgejo admin token.

### Task GIT-3: Scoped short-lived tokens

**Files:** Create: `src/tokens.ts`, `test/tokens.test.ts`
**Interfaces produced:** `POST /internal/git/tokens` `{ projectId, access: "read"|"write", ttlSec ≤ 600 }` → `{ token, expiresAt }`; implementation: Forgejo scoped access token restricted to the single repository (repo-scoped deploy token / access token with repository restriction), audited (`git_token.minted` audit row with requesting service + run/task attribution); revocation on project deletion.
**Effort:** M

- [x] Failing tests: token clones only its repo (cross-repo clone → 403/404); expired token rejected; audit row present.
- [x] Commit: `feat(git-service): repository-scoped short-lived tokens`

**Forgejo has no repository-scoped token and no expiring token**, so both had to
be built:

- **Scope comes from the identity.** A `restricted` ephemeral user, made a
  collaborator on exactly one private repository, with a token minted as that
  user. Every other repository — same tenant included — answers 404 to it, over
  `git` and over the API. `test/integration/tokens.test.ts` proves it by cloning.
- **Expiry comes from a sweep**, and the deadline is encoded in the ephemeral
  username (`zt-<epoch>-<random>`) so the Git host is the only record of which
  grants exist. `POST /internal/git/tokens/sweep` deletes everything past its
  deadline; it is idempotent and cheap. **Ops requirement:** something has to
  call it — every minute is fine. Until it is scheduled, a token remains usable
  between its stated expiry and the next call, which is the one bounded exposure
  this design carries.
- **Revocation on project deletion** is `POST /internal/git/tokens/revoke`, which
  removes every outstanding grant on the repository rather than waiting out TTLs.
- **`git_token.minted` is written by this service** into `audit_events`, with
  `actor_type = 'service'` — the same shape the control plane's `auditService`
  writes. Posting it to a control-plane route instead would have needed a new
  audience, a new route and a new entry in the control plane's `AUDIT_ACTIONS`,
  and would have put a network hop between an action and the record of it. The
  reasoning is in `services/git-service/src/audit.ts`; revisit when a second
  service needs to write a row.
- The mint is compensated: if the audit row cannot be written, the grant is
  destroyed and the caller gets an error. A credential handed out with no record
  of it is the outcome the trail exists to prevent.

### Task GIT-4: Backups + restore

**Files:** Create: `src/backup.ts`, `docs/runbooks/git-restore.md`, nightly CI/cron workflow
**Effort:** M

- [x] Binding behavior: nightly `git bundle create` per repo → R2 `org/{orgId}/project/{projectId}/git-backups/{date}.bundle` (30-day retention, latest never deleted); restore runbook: bundle → fresh Forgejo repo → verify head SHAs vs `branches` table; quarterly restore drill task in ops calendar (OPS-15).
- [x] Verify: backup of seeded repo → delete repo → restore → clone matches original head.
- [x] Commit: `feat(git-service): nightly bundle backups + tested restore path`

### Task INT-1 [M1 pull-forward]: GitHub App installation, discovery, and verified webhooks

**Files:** Create: `services/control-api/src/integrations/github/{schemas,ports,app,install,webhooks,store,queue}.ts`, `services/control-api/test/github-install.test.ts`, `services/control-api/test/github-webhooks.test.ts`, `services/control-api/test/integration/github-live.test.ts`, `infra/terraform/github-app.tf`, `docs/adr/0029-github-installation-user-ownership-proof.md`; Modify: `services/control-api/src/{app,compose,server,server-bootstrap,env}.ts`, `services/control-api/src/tenant/{db,view}.ts`, `services/control-api/src/redis/client.ts` only if its existing `eval` surface needs no new command, `services/control-api/test/support/{harness,tenant-db}.ts`, `services/control-api/test/{compose,env,server-bootstrap,openapi,openapi-contract}.test.ts`, `services/control-api/package.json`, `packages/db/src/schema/security.ts`, `packages/db/test/{schema-security,prd-schema-conformance}.test.ts`, next generated `packages/db/drizzle/0021_*.sql` and matching meta, `infra/docker/localstack/init-aws.sh`, `infra/docker/docker-compose.dev.yml`, `scripts/dev-up.sh`, `.env.example`, `pnpm-lock.yaml`, generated `packages/api-client/{openapi.json,src/generated.ts,src/generated-operations.ts}`, `docs/plans/06-git-and-integrations.md`, `docs/superpowers/plans/2026-08-10-web-4-dependency-completion.md`, `tasks/todo.md`
**Effort:** L

- [x] Binding interfaces (PRD §19.2, ADR-0029): `POST /v1/integrations/github/install/authorize` returns `{ url }`; the existing `POST /v1/integrations/github/install` completes the handshake and returns safe `IntegrationConnectionSchema` metadata after exchanging its callback code for an ephemeral user token and proving the requested installation appears in that user's installations; repository and branch GET routes use the opaque-cursor contracts in ADR-0028; `POST /v1/webhooks/github` verifies raw-body HMAC-SHA-256 before parse, deduplicates delivery IDs, and durably enqueues supported `push`, `pull_request`, and `installation` events to DLQ-backed `zapp-github-webhooks`. Unknown event types are successful no-ops; invalid signatures return 401 without enqueue. `GitHubProviderPort` uses `@octokit/rest` 20.1.2 and existing `jose` JWT signing. Authorization state is actor/organization-bound, random, Redis-stored for 600,000 ms, and atomically consumed; installation, repository, and branch reads are tenant-scoped 404s before any provider call.
- [x] Failing tests: authorization state expiry/replay/mismatch; repository and branch pagination and foreign installation 404; invalid signature 401/no enqueue; supported delivery one-time outbox enqueue; duplicate delivery no second row; unknown type no row; publisher crash/replay settlement; lifecycle drain. LocalStack creates `zapp-github-webhooks` and `zapp-github-imports` plus DLQs idempotently; live GitHub tests skip visibly without M4 credentials.
- [x] Commit: `feat(integrations): github app install + verified webhooks`

### Task INT-2 [M1 pull-forward]: Durable GitHub import and internal mirror

**Files:** Create: `services/control-api/src/integrations/github/{import,import-store,import-queue}.ts`, `services/control-api/test/github-import.test.ts`, `services/control-api/test/github-import-queue.test.ts`, `services/control-api/test/integration/github-import-live.test.ts`, `services/git-service/src/import/{mirror,git}.ts`, `services/git-service/test/import-mirror.test.ts`, `services/git-service/test/integration/import-mirror.test.ts`; Modify: `services/control-api/src/{app,compose,server,server-bootstrap,env}.ts`, `services/control-api/src/tenant/db.ts`, `services/control-api/test/support/{harness,tenant-db}.ts`, `services/git-service/src/{app,routes,compose}.ts`, `services/control-api/src/git/{port,client}.ts`, `services/control-api/test/git-client.test.ts`, `packages/db/src/schema/security.ts`, `packages/db/test/{schema-security,prd-schema-conformance}.test.ts`, next generated `packages/db/drizzle/0022_*.sql` and matching meta, generated `packages/api-client/{openapi.json,src/generated.ts,src/generated-operations.ts}`, `docs/plans/06-git-and-integrations.md`, `tasks/todo.md`
**Effort:** M

- [x] Binding interfaces: keyed `POST /v1/projects/:projectId/import/github` returns 202 queued status and `GET /v1/projects/:projectId/import/github` returns the strict ADR-0028 enum `queued|mirroring|scan_pending|scan_accepted|failed`; `github_imports` has one row per project and `github_import_outbox` provides durable stage delivery; service-authenticated `POST /internal/git/repositories/:organizationId/:projectId/import` accepts source credentials only at this internal boundary and never logs them; idempotent mirror result is `{ externalRepoRef, branch, headCommitSha }`. POST validates same-tenant project/install, requires `sourceType === 'github_import'`, creates the import/outbox transactionally for `zapp-github-imports`, replays the same operation key, and returns 409 for a distinct key. The one-stage-per-delivery worker resumes persisted state, mirrors without force overwrite, persists `manual_push` plus ref/head, then hands off keyed VF-3 capability scan to `scan_accepted`; retryable failures remain pending and exhausted delivery produces stable `failed` state.
- [x] Failing tests: 202 durable acceptance, exact idempotency/409, foreign project or installation 404, source-type and permission checks, GET progress and redaction; branch lineage/head equality, equal-head retry/refusal of differing target/no force or token leakage; queued→mirroring→scan_pending→scan_accepted with redelivery, retry, DLQ settlement, and shutdown draining.
- [x] Commit: `feat(integrations): github repository import with internal mirror`

### Task INT-3 [M4]: Sync engine

**Files:** Create: `src/integrations/github/sync.ts`, `test/integration/sync.test.ts`
**Effort:** L

- [x] Binding behavior (PRD §19.3): modes per repository `sync_policy`: `direct_push` (zapp pushes task/integration commits to GitHub branch) or `pull_request` (zapp pushes `zapp/run-{id}` branch + opens PR via App); inbound: `github.push` webhook → compare head vs `branches.head_commit_sha` → external movement: fetch to internal mirror, mark affected in-flight task bases stale (`task.blocked` event, base invalidation per PRD §19.3), surface sync state in project (`ahead/behind/diverged`); diverged → user chooses merge workflow (conflict task created; **never** auto-overwrite either side); every sync records commit SHAs both sides.
- [x] Failing tests: external push during active run blocks affected task with event; direct_push propagates integration branch; diverged state produces conflict task and no force push anywhere (asserted via reflog fixture).
- [x] Commit: `feat(integrations): bidirectional github sync with stale-base invalidation`

### Task INT-4 [M4]: GitHub export

**Files:** Create: `src/integrations/github/export.ts`
**Effort:** S

- [x] Binding behavior: export a zapp-created project → create GitHub repo under chosen installation → push full history → set `external_repo_ref` + sync policy; idempotent (existing export → 409 with link).
- [x] Commit: `feat(integrations): export project to github`

### Task INT-5 [M4]: Supabase adapter — connect/provision/schema/types

**Files:** Create: `src/integrations/supabase/{connect,provision,schema}.ts`, `packages/agent-tools/src/integrations/supabase.ts`, `test/supabase.test.ts` (env-gated live test)
**Effort:** L

- [x] Binding behavior (PRD §25.1/§25.2): `POST /v1/integrations/supabase/connect` (OAuth or management PAT → vault); provision dev project via Management API where plan permits (else connect-existing); read schema metadata (postgres-meta endpoints); generate TS types (`supabase gen types` in workspace); env wiring: SUPABASE_URL/ANON_KEY into project secrets (dev + prod scopes separate); agent tools: `read_database_schema` binding, `execute_migration` routes through migration pipeline (INT-6) — never raw SQL to prod.
- [x] Failing tests: connect stores credential ref only (no plaintext in `integration_connections.configuration_json` — asserted); schema read returns tables for fixture project; typegen artifact produced.
- [x] Commit: `feat(integrations): supabase connect/provision/schema/types`

### Task INT-5-FIX-1 [M4]: Deterministic GitHub import retry clock

**Files:** Modify: `test/integration/github-import-retry.test.ts`
**Effort:** XS

- [x] Binding behavior: the durable GitHub import retry integration test uses one injected clock for route-side outbox enqueue and publisher eligibility, so wall-clock passage cannot make a freshly enqueued row appear to be scheduled in the future.
- [x] Failing test: the focused PostgreSQL retry test reproduces the authoritative CI failure after wall time passes its previous fixed publisher instant, then passes with the shared injected clock.
- [x] Commit: `test(integrations): make github import retry clock deterministic`

### Task INT-6 [M4]: Supabase migrations + RLS

**Files:** Create: `src/integrations/supabase/migrations.ts`, `templates/supabase/rls/*.sql.hbs`
**Effort:** L

- [x] Binding behavior: migration pipeline: generated migration files in repo (`supabase/migrations/*`), applied to dev via CLI in workspace; validation against shadow database before any prod approval (VF-16 gate); destructive detection → approval (AR-5); RLS: policy generation templates for owner-scoped tables (auth.uid() pattern) + **generated RLS tests** (SQL asserting cross-user denial) required for Managed level (PRD §25.2); migration history recorded in release evidence (PRD §25.1).
- [x] Failing tests: destructive migration flagged; RLS template renders valid SQL for a fixture schema; RLS test catches a policy-less table.
- [x] Commit: `feat(integrations): supabase migration pipeline + RLS generation/tests`

### Task INT-7 [M4]: Neon adapter

**Files:** Create: `src/integrations/neon/{connect,branches,migrations}.ts`, `test/neon.test.ts` (env-gated)
**Effort:** L

- [x] Binding behavior (PRD §25.3): connect via API key → vault; project/branch management (create `verify/run-{id}` temp branches for migration validation, TTL-deleted after gate); schema inspection via SQL over branch connection; migration validation = apply to temp branch + smoke queries + reversibility classification; connection-role separation: app role vs migration role connection strings stored as separate secrets; branch-based dev workflow (preview env → dedicated branch).
- [x] Failing tests: temp branch lifecycle (created→validated→deleted); role separation (app role lacks DDL — asserted via failed ALTER).
- [x] Commit: `feat(integrations): neon branch-based database workflows`

### Task INT-8 [M4]: Generated-app Stripe adapter

**Files:** Create: `templates/stripe/{checkout,portal,webhook,sync,access}.ts.hbs`, `src/integrations/stripe/connect.ts`, `packages/agent-tools/src/integrations/stripe.ts`
**Effort:** L

- [x] Binding behavior (PRD §26.2): connect generated-app Stripe account (restricted key → vault, scope `generated_app`, **separate from platform billing connection** — vault scope + audit stream test); adapter templates the agent installs into user apps: customer creation, products/prices setup script, monthly+annual subscriptions, Checkout session route, customer portal route, webhook route with signature validation + idempotent event handling, subscription-state sync table + access-control middleware (`requireSubscription(tier)`), trial support, test-mode bootstrap (products seeded in test mode); templates are framework-adapted (next route handlers / express routers) via project-adapters hints.
- [x] Failing tests: webhook template rejects bad signature fixture; sync handler idempotent on duplicate event id; credential separation test (generated-app key never readable via platform-billing paths).
- [x] Commit: `feat(integrations): generated-app stripe adapter templates`

### Task INT-9 [M4]: Stripe adapter integration tests

**Files:** Create: `packages/agent-tools/test/integration/stripe-flow.test.ts` (Stripe test mode, env-gated). Modify: `packages/agent-tools/package.json`, `templates/stripe/{webhook,sync}.ts.hbs`, `turbo.json` (review-required checkout completion, resource cleanup, and integration-gate wiring).
**Effort:** M

- [x] Binding behavior: full loop in a fixture next app: seed products → checkout session (test card via Stripe test clock/API, not browser) → webhook `checkout.session.completed` → sync row `active` → access middleware admits; cancel → webhook → access revoked. This suite is what VF's `integration_tests` gate runs for Stripe-enabled Managed projects (PRD §24.2).
- [x] Commit: `test(integrations): stripe subscription end-to-end in test mode`

### Task GIT-6 [M2]: Approved template source registry

**Files:** Create `config/templates.json`; modify config schema/tests and required server loader.
**Effort:** S. **[expand-at-execution]**

- [ ] Binding behavior: strict unique slugs, immutable source identity, approved internal refs kept server-side, validated demo URLs and presentation metadata.
- [ ] Commit: `feat(templates): approved source registry`

### Task GIT-5 [M2]: Commit comparison + approved template seeding

**Files:** Modify git-service provider/routes/ports/tests.
**Effort:** M. **[expand-at-execution]**

- [ ] Binding behavior: bounded before/after patch plus idempotent repository seed from server-approved template refs; reject arbitrary sources and preserve tenant/project scope.
- [ ] Commit: `feat(git-service): commit diff and template seeding`

### Task INT-10 [M3]: Public GitHub sync controls

**Files:** Modify control-api GitHub integration routes/composition, DB if required, OpenAPI/SDK/tests.
**Effort:** L. **[expand-at-execution]**

- [ ] Binding behavior: sync policy/state, keyed manual sync and export over the existing engines; stale-base/conflict surfacing and no last-writer-wins.
- [ ] Commit: `feat(integrations): public GitHub sync controls`

### Task GIT-7 [M4]: Public short-lived repository credential lease

**Files:** Modify git-service token boundary, control-api project route/client, OpenAPI/SDK/tests.
**Effort:** M. **[expand-at-execution]**

- [ ] Binding behavior: session-authenticated, audited, `edit_code`-authorized, `no-store`, repository-scoped credential lease with maximum 300-second TTL; never persist tokens in remotes or desktop state.
- [ ] Commit: `feat(git): public short-lived repository lease`

---

## Testing strategy
- Forgejo tests run against compose instance per-PR; GitHub/Supabase/Neon/Stripe live tests env-gated to staging credentials, run nightly.
- Sync-engine divergence scenarios use local bare-repo fixtures (fast, deterministic) with a nightly live GitHub smoke.

## Scalability notes
- Forgejo vertical-scales fine to P0 targets (1k repos); GitProvider interface keeps a managed-Git migration open (decision gate note in ADR); webhook processing via SQS with DLQ (at-least-once + dedupe by delivery id).

## Security & tenancy notes
- Repo-scoped 300 s tokens; per-org Forgejo namespaces; installation tokens never stored raw (exchanged per operation); integration credentials only in vault with scope labels; credential separation (platform vs generated-app Stripe) has a dedicated permanent test.

## Execution log

- (empty)
- 2026-08-04: GIT-1/2/3 done (90aa3c5+c6175d7+282a1f0 + fix f9c0198, review Approved). Cross-repo denial is now a CI gate (`git isolation (repository-scoped tokens)`, real forgejo:9 container) — resists filtering three ways: own job, integration excludes the package, module-level throw fails rather than greens if the container is removed. Tokens expire on an in-process 60s sweep. Note for later: ci.yml resolves the container by `docker ps --filter ancestor=` rather than service name — wrong container if a second Forgejo ever runs on a runner.
- 2026-08-04 GIT-4 implementation committed — independent review and live Forgejo/PostgreSQL/MinIO proof pending controller; task and tracker remain unchecked.
- 2026-08-04 GIT-4 review 1/5 NEEDS_FIXES — unchecked pending workflow credential scoping, restore compensation, authoritative CLI coverage, retention/date validation, inferred artifact env, and executable restore evidence.
- 2026-08-04 GIT-4 review 2/5 implementation committed — independent review and live Forgejo/PostgreSQL/MinIO proof pending controller; task and tracker remain unchecked.
- 2026-08-04 GIT-4 review 3/5 implementation committed — immutable-ID cleanup, PostgreSQL drill lease, bounded R2 layout/reconciliation, and atomic evidence publication implemented; independent review and live proof pending controller; task and tracker remain unchecked.
- 2026-08-04 GIT-4 review 4/5 implementation committed — automatic repository deletion removed; intent-first append-only restore recovery, caller-keyed manual replay, persistent leased drill target, and fresh-signal R2 ambiguity reconciliation implemented; independent review round 5 and live proof pending controller; task and tracker remain unchecked.
- 2026-08-04 GIT-4 BLOCKED: final review 5/5 found a path-replacement race before admin-token mirror push, marker-only adoption without a prior immutable-ID receipt, and multi-document restore evidence accepted by jq; live restore proof canceled and task remains unchecked pending explicit approval for another remediation round.
- 2026-08-04 GIT-4 final-review remediation implementation committed: restore push/ref reads now use an immutable-ID-checked repository credential, marker-only adoption is refused, and evidence requires one JSON document; fresh independent review and live proof remain pending, task and tracker stay unchecked.
- 2026-08-04 GIT-4 done — nightly immutable bundle backups and append-only restore recovery now fence credential terminalization across processes, isolate conditional S3 uploads, and pass final CLEAN review plus the live Forgejo/PostgreSQL/MinIO backup-delete-restore-clone drill.
- 2026-08-07 ADR-0018 accepted — internal Git stays Forgejo (product-owner delegated decision). GitHub remains an optional peer remote via INT-1..4; PRD §19.1 ("must work without requiring a user GitHub account") is affirmed, not amended. No code removed. Accepted cost: we operate a stateful service (mitigated by GIT-4 bundle backups + live recovery gate). Exit hatch is swapping GitProvider to a managed host behind the existing interface — not requiring user GitHub accounts.
- 2026-08-08 GIT-4 CI fix done — bounded the second real-entrypoint child-process test at 15 seconds after clean Linux contention exceeded Vitest's 5-second default; no production or provider behavior changed.
- 2026-08-10 INT-1 done — GitHub App installation, tenant-scoped repository/branch discovery, and signature-verified durable webhook delivery shipped; focused control-api 41/41, route regression 18/18, DB schema 39/39, lint/typecheck, SDK determinism, and local dev-stack queue/migration gates passed; live GitHub skipped because `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_LIVE_CALLBACK_CODE`, and `GITHUB_LIVE_INSTALLATION_ID` are unset; Terraform validation skipped because `terraform` is not installed.
- 2026-08-10 INT-1 review round 1 security revision — accepted ADR-0029 and replaced App-wide installation lookup with callback-code exchange plus ephemeral user-scoped installation proof; added a concurrent-association unique index/idempotent insert, restored ordinary malformed-JSON 400 handling, inferred boundary schemas, name-only GitHub environment entries, and the `openapi-contract.test.ts` file-scope paper trail; final passes/skips are recorded in the Task 3 report.
- 2026-08-10 INT-2 done — durable keyed import/outbox stages, credential-contained Forgejo mirror, and keyed VF-3 handoff shipped; review round 1 added the required validated public idempotency header, shared strict repository/store schemas, and all-target-ref refusal while preserving equal-head replay; retained `setDefaultBranch` as the narrowest git-service-local import capability without changing `packages/contracts` per the approved interface assumption; DB 152/152, control-api 542/542, git-service 367/367, focused gates, generator/SDK determinism, lint/typecheck, and Forgejo integration passed; live GitHub import skipped because its seven named credentials are unset.
- 2026-08-11 INT-3 done — bidirectional direct-push/PR sync, durable idempotent head/state recording, branch-scoped stale-base events, and conflict tasks shipped with a structurally force-free Git port and real local-reflog proof; the single capped review timed out, so bounded local review fixed cross-branch invalidation and unconfigured `manual_push` retry poisoning before exit; focused 5/5, control-api build/lint/typecheck, root lint/typecheck, and Semgrep passed; live GitHub smoke skipped because the named GitHub App credentials are unset.
- 2026-08-11 INT-4 done — zapp-created projects now export through a deterministic provider operation, structurally force-free full-history push, exact default-head verification, and tenant/installation-scoped atomic peer-ref + sync-policy persistence with linked 409 replay; temporary memory and PostgreSQL TDD contracts passed alongside control-api build/lint/typecheck, Prettier, and Semgrep; no binding-file deviation or blocker, and live GitHub export was skipped because the named GitHub App credentials are unset.
- 2026-08-11 INT-5 done — Supabase connect/provision/schema/typegen and agent-tool bindings now vault the management token, isolate preview/production project secrets, and keep migrations behind INT-6; one capped review corrected the current Management API provisioning payload, PostgreSQL/local suites passed, no blockers or plan deviations, and the live Supabase test skipped because `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are unset.
- 2026-08-11 INT-5-FIX-1 done — The exact authoritative CI failure reproduced after wall time crossed the retry test's fixed publisher instant; injecting one clock into the app and publisher made the PostgreSQL retry proof deterministic, focused and package checks passed, and one capped review found no Critical/Major issue.
- 2026-08-11 INT-6 done — Supabase migrations now stage keyed monotonic repo files, apply only to linked non-production projects, feed pending history through the VF-16 shadow receipt recorded in release evidence, and generate owner-scoped RLS plus pgTAP denial tests; one capped review fixed fixture-vacuity and migration-ordering risks, local PostgreSQL proved cross-user denial, no blockers or plan deviations occurred, and live Supabase verification skipped because `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are unset.
- 2026-08-11 INT-7 done — Neon API connect now vaults explicit-database app/migration URLs for default and dedicated preview branches, VF-16 validates on TTL verification branches with response-loss reconciliation and cleanup, schema SQL and real DDL denial passed, and one capped review fixed concurrent password persistence, post-create compensation, explicit database targeting, and cursor pagination; no blockers or plan deviations, while live Neon skipped because `NEON_API_KEY` and `NEON_PROJECT_ID` are unset.
- 2026-08-11 INT-8 done — Generated-app Stripe credentials now use an audited vault scope isolated from platform billing, and the installer emits typechecked Next or Express Checkout, portal, signed webhook, atomic stale-safe sync, access-control, and migration artifacts; one capped review fixed authenticated portal ownership, current Stripe item periods, stale-event fencing, migration installation, and explicit Express/Fastify handling, while the first pre-push run exposed and bounded the compiler-heavy test's default timeout; no blockers or plan deviations, and live Stripe skipped because `STRIPE_GENERATED_APP_RESTRICTED_KEY` and `STRIPE_GENERATED_APP_ACCOUNT_ID` are unset.
- 2026-08-12 INT-9 done — The generated Next fixture now exercises checkout completion, signed subscription sync, real isolated Postgres state, admission, cancellation, and revocation through the discoverable integration gate; one capped review exposed and drove the provider/DB/gate remediation, and the live Stripe proof skipped visibly because `STRIPE_GENERATED_APP_RESTRICTED_KEY` and `STRIPE_GENERATED_APP_ACCOUNT_ID` are unset.
