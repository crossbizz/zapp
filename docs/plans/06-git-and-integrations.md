# Plan 06 — Git & Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Internal Git service (Forgejo) with scoped tokens and backups; GitHub App import/sync/export; Supabase, Neon, and generated-app Stripe adapters — PRD §19, §25, §26.2, §26.3.

**Architecture:** `services/git-service` (4500) wraps Forgejo behind a `GitProvider` interface (provider-neutral per PRD §19.1); internal Git is the source of truth for every project. GitHub is a peer remote synchronized at commit boundaries only. Database/billing integrations are `IntegrationProvider` implementations registered in `integration_connections`, with credentials in the CP-7 vault.

**Tech Stack:** Forgejo 9 (Fly.io + volume), simple-git/isomorphic-git (service-side ops), Octokit + GitHub App JWT, Supabase Management API, Neon API, Stripe SDK.

**Milestone:** GIT-1..4 (M0–M1), INT-1..9 (M4). **Depends on:** Plans 01, 02. **Consumed by:** 03 (clone/push), 07 (release commits), 04 (fix-mode restore).

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

### Task INT-1 [M4]: GitHub App + webhooks

**Files:** Create: `services/control-api/src/integrations/github/{app,webhooks,install}.ts`, `infra/terraform/github-app.tf` (manifest), `test/github-webhooks.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §19.2): GitHub App (permissions: contents rw, pull_requests rw, checks read, metadata; events: push, pull_request, installation) install at org/user level → `POST /v1/integrations/github/install` completes handshake, stores installation id in `integration_connections`; webhook receiver verifies signature, enqueues `github.push` etc. to SQS queue `zapp-github-webhooks` (DLQ-backed; LocalStack locally; processed by INT-3); repo selection API lists installation repos.
- [ ] Failing tests: signature verification (invalid → 401); installation persisted; push event enqueued exactly once (delivery id dedupe).
- [ ] Commit: `feat(integrations): github app install + verified webhooks`

### Task INT-2 [M4]: GitHub import

**Files:** Create: `src/integrations/github/import.ts`, `test/integration/import.test.ts`
**Effort:** M

- [ ] Binding behavior (PRD §10.2): `POST /v1/projects/:id/import/github` `{ installationId, repo, branch }` → project record (source_type `github_import`) → workspace clone via installation token → push mirror to internal Git (all refs of selected branch lineage) → `repositories.external_repo_ref` set, sync_policy default `manual_push` → capability scan (VF-3) auto-triggered → support-level report to conversation.
- [ ] Failing integration test (against a seeded fixture repo on a test org): import → internal repo head == GitHub head; scan row exists; re-import same repo → 409 `already_imported`.
- [ ] Commit: `feat(integrations): github repository import with internal mirror`

### Task INT-3 [M4]: Sync engine

**Files:** Create: `src/integrations/github/sync.ts`, `test/integration/sync.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §19.3): modes per repository `sync_policy`: `direct_push` (zapp pushes task/integration commits to GitHub branch) or `pull_request` (zapp pushes `zapp/run-{id}` branch + opens PR via App); inbound: `github.push` webhook → compare head vs `branches.head_commit_sha` → external movement: fetch to internal mirror, mark affected in-flight task bases stale (`task.blocked` event, base invalidation per PRD §19.3), surface sync state in project (`ahead/behind/diverged`); diverged → user chooses merge workflow (conflict task created; **never** auto-overwrite either side); every sync records commit SHAs both sides.
- [ ] Failing tests: external push during active run blocks affected task with event; direct_push propagates integration branch; diverged state produces conflict task and no force push anywhere (asserted via reflog fixture).
- [ ] Commit: `feat(integrations): bidirectional github sync with stale-base invalidation`

### Task INT-4 [M4]: GitHub export

**Files:** Create: `src/integrations/github/export.ts`
**Effort:** S

- [ ] Binding behavior: export a zapp-created project → create GitHub repo under chosen installation → push full history → set `external_repo_ref` + sync policy; idempotent (existing export → 409 with link).
- [ ] Commit: `feat(integrations): export project to github`

### Task INT-5 [M4]: Supabase adapter — connect/provision/schema/types

**Files:** Create: `src/integrations/supabase/{connect,provision,schema}.ts`, `packages/agent-tools/src/integrations/supabase.ts`, `test/supabase.test.ts` (env-gated live test)
**Effort:** L

- [ ] Binding behavior (PRD §25.1/§25.2): `POST /v1/integrations/supabase/connect` (OAuth or management PAT → vault); provision dev project via Management API where plan permits (else connect-existing); read schema metadata (postgres-meta endpoints); generate TS types (`supabase gen types` in workspace); env wiring: SUPABASE_URL/ANON_KEY into project secrets (dev + prod scopes separate); agent tools: `read_database_schema` binding, `execute_migration` routes through migration pipeline (INT-6) — never raw SQL to prod.
- [ ] Failing tests: connect stores credential ref only (no plaintext in `integration_connections.configuration_json` — asserted); schema read returns tables for fixture project; typegen artifact produced.
- [ ] Commit: `feat(integrations): supabase connect/provision/schema/types`

### Task INT-6 [M4]: Supabase migrations + RLS

**Files:** Create: `src/integrations/supabase/migrations.ts`, `templates/supabase/rls/*.sql.hbs`
**Effort:** L

- [ ] Binding behavior: migration pipeline: generated migration files in repo (`supabase/migrations/*`), applied to dev via CLI in workspace; validation against shadow database before any prod approval (VF-16 gate); destructive detection → approval (AR-5); RLS: policy generation templates for owner-scoped tables (auth.uid() pattern) + **generated RLS tests** (SQL asserting cross-user denial) required for Managed level (PRD §25.2); migration history recorded in release evidence (PRD §25.1).
- [ ] Failing tests: destructive migration flagged; RLS template renders valid SQL for a fixture schema; RLS test catches a policy-less table.
- [ ] Commit: `feat(integrations): supabase migration pipeline + RLS generation/tests`

### Task INT-7 [M4]: Neon adapter

**Files:** Create: `src/integrations/neon/{connect,branches,migrations}.ts`, `test/neon.test.ts` (env-gated)
**Effort:** L

- [ ] Binding behavior (PRD §25.3): connect via API key → vault; project/branch management (create `verify/run-{id}` temp branches for migration validation, TTL-deleted after gate); schema inspection via SQL over branch connection; migration validation = apply to temp branch + smoke queries + reversibility classification; connection-role separation: app role vs migration role connection strings stored as separate secrets; branch-based dev workflow (preview env → dedicated branch).
- [ ] Failing tests: temp branch lifecycle (created→validated→deleted); role separation (app role lacks DDL — asserted via failed ALTER).
- [ ] Commit: `feat(integrations): neon branch-based database workflows`

### Task INT-8 [M4]: Generated-app Stripe adapter

**Files:** Create: `templates/stripe/{checkout,portal,webhook,sync,access}.ts.hbs`, `src/integrations/stripe/connect.ts`, `packages/agent-tools/src/integrations/stripe.ts`
**Effort:** L

- [ ] Binding behavior (PRD §26.2): connect generated-app Stripe account (restricted key → vault, scope `generated_app`, **separate from platform billing connection** — vault scope + audit stream test); adapter templates the agent installs into user apps: customer creation, products/prices setup script, monthly+annual subscriptions, Checkout session route, customer portal route, webhook route with signature validation + idempotent event handling, subscription-state sync table + access-control middleware (`requireSubscription(tier)`), trial support, test-mode bootstrap (products seeded in test mode); templates are framework-adapted (next route handlers / express routers) via project-adapters hints.
- [ ] Failing tests: webhook template rejects bad signature fixture; sync handler idempotent on duplicate event id; credential separation test (generated-app key never readable via platform-billing paths).
- [ ] Commit: `feat(integrations): generated-app stripe adapter templates`

### Task INT-9 [M4]: Stripe adapter integration tests

**Files:** Create: `test/integration/stripe-flow.test.ts` (Stripe test mode, env-gated)
**Effort:** M

- [ ] Binding behavior: full loop in a fixture next app: seed products → checkout session (test card via Stripe test clock/API, not browser) → webhook `checkout.session.completed` → sync row `active` → access middleware admits; cancel → webhook → access revoked. This suite is what VF's `integration_tests` gate runs for Stripe-enabled Managed projects (PRD §24.2).
- [ ] Commit: `test(integrations): stripe subscription end-to-end in test mode`

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
