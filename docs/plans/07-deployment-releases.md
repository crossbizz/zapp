# Plan 07 — Deployment & Release Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release service with immutable release records, pre-deployment readiness checks, Vercel + Fly.io deployment adapters, staged deploy progress, production health verification, rollback, custom domains, and synthetic checks — PRD §26A, §27, §28 (release forking touchpoints).

**Architecture:** `services/release-service` (4300) implements `ReleasePort` consumed by CP-11 routes and orchestrator activities. Deployments run as Temporal workflows on queue `releases` emitting `deployment.updated` stage events. Providers implement the FND-4 `DeploymentProvider` interface; default hosting = zapp-managed Fly.io org (locked decision #4), optional user-connected Vercel.

**Tech Stack:** Temporal, Fly Machines API, Vercel API, Docker buildkit in sandbox (image builds), @zapp/{contracts,verification-engine}.

**Milestone:** M4. **Depends on:** Plans 01–06 (evidence from 05, commits from 06, sandboxes from 03). **Consumed by:** 08 (deploy UX), 10 (cost attribution, synthetic checks ops).

## Global Constraints

Master plan §Global Constraints, plus:
- A failed deployment must never replace a healthy production release (PRD §26A.4) — traffic switch is the last stage, gated on health.
- Deployment types (First / Redeploy / Replace) are explicitly classified; destructive data behavior is never inferred silently (PRD §26A.3).
- Releases are immutable: `releases` rows never update commit/spec references; status transitions only.
- Provider identity never leaks into product models (deployment URLs/ids stored on `deployments`, not `projects`).

## File structure owned

```text
services/release-service/src/
  app.ts, routes.ts                     # /internal/releases/*
  release/{create,readiness,types}.ts
  workflows/deploy.ts                   # Temporal deploy workflow + activities
  providers/{vercel,fly,registry}.ts
  domains/service.ts
  rollback/service.ts
  synthetics/{runner,scheduler}.ts
  annotations/{grafana,posthog}.ts
```

---

### Task DEP-1: Release records + ReleasePort

**Files:** Create: `src/release/create.ts`, `src/routes.ts`, `test/release.test.ts`
**Interfaces produced (binding):**

```ts
export interface ReleasePort {
  createReleaseCandidate(input: { projectId, environmentId, commitSha, specificationId }): Promise<Release>;
  getReadiness(releaseId: string): Promise<ReadinessReport>;
  approve(releaseId: string, actor: Actor): Promise<Release>;
  deploy(releaseId: string, input: { deploymentType: DeploymentType; confirmation: DeploymentConfirmation }): Promise<{ deploymentId }>;
  rollback(input: { environmentId; toDeploymentId?: string; reason: string }): Promise<{ deploymentId }>;
  getEvidence(releaseId: string): Promise<EvidenceManifest>;
}
```

AR-4 compatibility note (product-owner delegated controller decision 2026-08-06,
ADR-0012): this six-method set remains binding. Agent-tools preview/smoke and
deployment-health operations use separately named adapter ports and do not extend or
replace `ReleasePort`. Agent-originated mutations may supply optional trusted
idempotency/cancellation call options without changing these lifecycle operations.
`DeploymentConfirmation` is `{ dataDisposition: "preserve" | "transfer" | "reset" | null }`:
`replace_deployment` requires a non-null disposition, while `first_deploy` and
`redeploy` pass `null`, matching the control API boundary.

Release flow states: `candidate → verifying → ready|warnings|blocked → approved → deploying → healthy|failed → superseded`. Creation requires: exact commit SHA exists in internal Git (GIT-2 lookup), spec version reference (or explicit waiver object), no release for prototype-only runs (AR-15 rule).
**Effort:** M

- [x] Failing tests: create validates commit exists (unknown SHA → 422 `commit_not_found`); immutability (attempt to change commit → no code path; status transition table enforced); approve requires RBAC `approve_production_deploy` (checked at CP-11, re-checked here with actor).
- [x] Commit: `feat(release-service): immutable release candidates + ReleasePort`

### Task DEP-2: Pre-deployment readiness check

**Files:** Create: `src/release/readiness.ts`, `test/readiness.test.ts`
**Effort:** L

- [x] Binding behavior (PRD §26A.2): evaluates exactly: production build + start commands (gate reuse VF-5), lockfile consistency (`pnpm install --frozen-lockfile` dry check), required env/secrets present in target environment (contract-declared + detected `process.env` reads missing → finding), database connectivity + approved migrations (INT-6/7 validation state), provider compatibility (adapter `detectCompatibility`), health endpoint defined, critical browser flows green (latest VF results for the commit), release-policy + verifier decision (VF-10). Output: exactly three states — `ready | warnings | blocked` with findings `[{ id, severity: "blocker"|"warning", title, detail, action: "fix_and_recheck"|"review"|"waive" }]`; blockers list which mandatory gate failed; primary action for blocked = Fix and recheck (spawns Fix run via AR-19).
- [x] Failing tests: missing env secret → warning (or blocker for Managed); failed critical flow → blocked; all green → ready; findings payload drives WEB-14 UI snapshot.
- [x] Commit: `feat(release-service): three-state readiness report`

### Task DEP-3: Deployment type classification + confirmation contract

**Files:** Create: `src/release/types.ts`, `test/types.test.ts`
**Effort:** M

- [x] Binding behavior (PRD §26A.3): classify(environment history, target): `first_deploy` (no prior deployment for env) | `redeploy` (same project lineage) | `replace_deployment` (different project/major identity change — detected via repo lineage mismatch or explicit user retarget); confirmation payload states, in user language: production data effect (`preserved | migrated (n migrations, reversibility) | reset — requires explicit selection`), secrets effect (added/changed/removed names), URL effect, active-user effect (brief interruption vs zero-downtime per provider); `replace_deployment` requires explicit data disposition selection (`preserve | transfer | reset`) — API rejects absent selection (422 `data_disposition_required`).
- [x] Failing tests: each classification from seeded histories; replace without disposition rejected; confirmation text snapshots (used verbatim by WEB-14).
- [x] Commit: `feat(release-service): deployment type classification + explicit data behavior`

### Task DEP-4: Fly.io generic Node container adapter

**Files:** Create: `src/providers/fly.ts`, `test/integration/fly.test.ts` (env-gated staging)
**Effort:** XL → split at execution: 4a image build+push, 4b machines deploy+health, 4c logs+status streaming. **[expand-at-execution]**

Binding behavior: implements `DeploymentProvider` (FND-4): `detectCompatibility` (any Node app with build+start or Dockerfile); build: in sandbox — Dockerfile template (node:22-slim multi-stage, contract build command, non-root user) unless project Dockerfile exists → `docker buildx` → push to Fly registry `registry.fly.io/zapp-{projectId}-{env}`; deploy: Fly app per project-env under zapp org (locked decision #4), machines update with new image ref (blue-green: start new machine → health check → stop old), secrets via Fly secrets API from vault (release-service is decrypt-allowlisted, CP-7); `getStatus`/`streamLogs` from Machines API; `rollback` = machines update to previous image ref (image refs retained on `deployments` rows); cost attribution stub → OPS-2 (deploy provider usage category).

#### DEP-4a: Sandbox image build + push

- [x] Failing tests first: compatibility accepts a Dockerfile or a Node `package.json` with both build/start scripts and rejects incomplete projects; stable Fly app/registry naming handles prefixed IDs and provider length limits; generated Dockerfile snapshot is `node:22-slim` multi-stage, executes the contract install/build/start commands through JSON-form shell arguments, and ends as a non-root user; an existing project Dockerfile is used unchanged; a failed `docker buildx build --push` never returns an artifact.
- [x] Implement strict Zod inputs/outputs plus a minimal sandbox execution port; `buildFlyImage` writes only a temporary generated Dockerfile when needed, never passes secrets/build args, runs buildx in the contract workspace, pushes `registry.fly.io/<stable project-environment app>:<exact commit sha>`, removes the temporary file, and returns a validated `container_image` artifact. The sandbox is pre-authenticated with a registry-scoped credential outside this adapter.
- [x] Run the focused red/green cycle, then the release-service test/lint/typecheck/build commands. Check only DEP-4a boxes in this commit.
- [x] Commit: `feat(release-service): build and push Fly images`

#### DEP-4b: Machines deploy, vault secrets, health, rollback

- [x] Failing local integration tests first, against a recording HTTP server: app creation is idempotent in the configured zapp Fly org; environment values are resolved only through an injected decrypt-allowlisted vault port and sent by name to the Fly Secrets API without appearing in adapter results/errors; production deploy creates a new Machine with `skip_service_registration: true`, waits for `started` plus passing service health checks, uncordons it, then and only then stops the prior Machine; a failed health check stops the candidate and leaves the prior Machine serving.
- [x] Implement a strict Machines API client and `DeploymentProvider` production path. Machine config uses the exact image artifact, contract start command/port/health path, restart policy, release/project/environment metadata, and app secrets; provider deployment IDs durably encode app + Machine identity. Call the OPS-2 seam with usage category `deploy_provider` after an accepted provider mutation, without recording secret material.
- [x] Failing rollback tests first: resolve the explicit prior provider deployment ID, retain its image/config, perform the same cordoned health-gated handoff, and return a new deployment handle; invalid cross-app targets fail before mutation.
- [x] Run the focused red/green cycles, then the release-service test/lint/typecheck/build commands. Check only DEP-4b boxes in this commit.
- [x] Commit: `feat(release-service): health-gated Fly Machine deploys and rollback`

#### DEP-4c: Status, log streaming, final staging proof

- [x] Failing local integration tests first: map Fly Machine lifecycle/check states into the FND-4 deployment status without false-ready states; page the official Logs API cursor, emit only the selected Machine's validated stdout/stderr records, and redact every vault value before yielding; provider/API failures surface as failed status detail or typed errors, never success.
- [x] Implement `getStatus` and `streamLogs`, plus the FND-4 preview rejection and DEP-10 domain seam without inventing provider-hosted previews or premature custom-domain behavior. Keep all Fly-specific identity inside the adapter.
- [x] After local suites and the single capped review are complete, run the env-gated Fly staging test exactly once when `FLY_API_TOKEN`, `FLY_ORG_SLUG`, and `ZAPP_FLY_STAGING_ENABLED=1` are present: build/push the fixture, deploy it, prove runtime env + URL health, observe status/logs, roll back to the retained image, and clean up the staging app. Otherwise print a visible `SKIPPED — not run, not passed` reason naming the missing gate.
- [x] Run release-service test/lint/typecheck/build, root lint/typecheck, and the task's one real-provider gate; record any credential skip honestly. Check DEP-4 and tracker boxes and append the Execution log in this final substep commit.
- [x] Commit: `feat(release-service): Fly status and log streaming`

### Task DEP-5: Vercel adapter

**Files:** Create: `src/providers/vercel.ts`, `test/integration/vercel.test.ts` (env-gated)
**Effort:** L

- [x] Binding behavior: user-connected Vercel (OAuth token in vault, `integration_connections` provider `vercel`); `detectCompatibility` from project-adapters hints (next/vite/astro/sveltekit/nuxt); deploy: file-digest upload of the sandbox-built output via Vercel deployments API (deterministic: we build, Vercel serves; framework preset set explicitly), env vars synced from vault per environment, `target: production` only on user-approved deploy; preview deployments NOT used for zapp previews (Modal previews remain the dev loop; Vercel = production path) — keeps environments visibly distinct (PRD §26A.1); rollback = re-promote previous deployment id; domains via Vercel domains API (DEP-9).
- [x] Failing tests (staging token): deploy fixture static next app → URL 200; env var present at runtime; promote-previous restores prior content.
- [x] Commit: `feat(release-service): vercel production adapter`

### Task DEP-6: Deploy workflow with stage timeline

**Files:** Create: `src/workflows/deploy.ts`, `test/integration/deploy-workflow.test.ts`
**Effort:** L

- [x] Binding behavior (PRD §26A.4, §27.3): Temporal workflow stages exactly: `readiness_check → build_artifact → configure_secrets → apply_migrations → provision_runtime → start_services → production_health_check → go_live`; each stage emits `deployment.updated` event `{ stage, status: running|passed|failed, elapsedMs, summary, evidenceArtifactId? }`; migrations stage: only pre-approved migration plan (INT-6/7), destructive ops re-verified against approval record; traffic switch (`go_live`) happens only after `production_health_check` passes — failure at any stage leaves previous deployment serving (test asserts old URL content unchanged after induced failure); idempotent stages (activity idempotency keys); deployment row status transitions recorded.
- [x] Failing integration test (fly staging + fixture app): full deploy walks all 8 stages in order with events; induced health-check failure → status `failed`, previous deployment still live, no partial traffic switch.
- [x] Commit: `feat(release-service): staged deploy workflow with safe go-live`

### Task DEP-7: Production health checks + post-deploy smoke

**Files:** Create: `src/release/health.ts`
**Effort:** M

- [ ] Binding behavior: health = contract health path 200 × 3 consecutive (10 s apart) + error-rate guard (no 5xx burst in first 2 min via provider logs); post-deploy smoke = Playwright critical-flow subset against production URL (read-only flows only — no data mutation in prod smoke; flows tagged `@prod-safe` from VF-8 generation); results attached to release evidence (`preview` block gains `production` sibling); failure → automatic `mark failed` + rollback offer event (never auto-rollback without policy flag `autoRollbackOnFailedHealth: true`, default true for Managed).
- [ ] Failing tests: 2-of-3 health → still failed; prod smoke excludes non-safe flows (fixture with mutating flow asserts exclusion).
- [ ] Commit: `feat(release-service): production health + safe smoke verification`

### Task DEP-8: Success state + release annotations

**Files:** Create: `src/annotations/{grafana,posthog}.ts`, success payload assembly
**Effort:** S

- [ ] Binding behavior (PRD §26A.5): success payload: permanent URL, custom-domain action link, release id + exact commit, evidence status link, production health status, monitoring links (Grafana dashboard/Faro app, PostHog annotation), previous healthy release + one-click rollback action, note that preview changes require redeploy; annotations: Grafana deployment annotation (annotations API, tagged `release:{id}` + commit sha) on the project's dashboards, Faro sourcemap upload hook (generated-app template), PostHog annotation `release {id}` on project analytics.
- [ ] Commit: `feat(release-service): deployment success contract + release annotations`

### Task DEP-9: Rollback

**Files:** Create: `src/rollback/service.ts`, `test/integration/rollback.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §27.5): rollback restores: previous artifact/deployment (provider switch), previous env-config version (env config is versioned per deployment row), previous commit reference, static assets (implicit in artifact); DB compatibility state machine: migration reversibility from release evidence — `reversible` → allow; `compensating` → require approved compensating plan attached; `unavailable` → **block** with explanation; UI contract: response includes `databaseState: "compatible" | "requires_compensation" | "incompatible"` — code rollback never presented as full system rollback when incompatible (WEB-15 renders warning verbatim); rollback creates a new deployment row `rollback_of_deployment_id` set; post-rollback health check runs (DEP-7).
- [ ] Failing tests: rollback after compatible migration succeeds end-to-end (staging); incompatible fixture blocked with correct state; env config restored (secret renamed between releases → old name active after rollback).
- [ ] Commit: `feat(release-service): rollback with database-compatibility gating`

### Task DEP-10: Custom domains + SSL

**Files:** Create: `src/domains/service.ts`, `test/domains.test.ts`
**Effort:** M

- [ ] Binding behavior: `POST /v1/projects/:id/domains` `{ hostname, environmentId }` → provider call (Fly certs API / Vercel domains API) → returns DNS instructions (CNAME/A + verification TXT) → polling verification → status `pending_dns → verifying → active | failed` with user-readable failure causes (wrong record, CAA, rate limit); SSL auto via provider; apex + www handling documented in payload; domain rows on `environments`.
- [ ] Failing tests: instruction payload per provider snapshot; verification state machine transitions on fake DNS results.
- [ ] Commit: `feat(release-service): custom domains with guided DNS verification`

### Task DEP-11: Synthetic checks

**Files:** Create: `src/synthetics/{runner,scheduler}.ts`
**Effort:** M

- [ ] Binding behavior (PRD §23.5, §29.2): `synthetic_checks` rows (name, schedule cron, flow ref) created by default for Managed releases (critical flows from spec); scheduler (Temporal cron workflow) runs prod-safe Playwright flow via verification-service against production URL; failure → incident event + notification (OPS-7) + offer Fix run (AR-19 entry point, PRD §10.3); results retained 30 d; status shown on project health (WEB-15).
- [ ] Failing tests: schedule → run → failure creates event linked to release; disabled check doesn't run.
- [ ] Commit: `feat(release-service): synthetic production checks`

### Task DEP-12: Wire CP-11 + evidence + forking touchpoint

**Files:** Modify: `services/control-api/src/routes/releases.ts` (replace fakes with ReleasePort client); Create: `test/integration/release-e2e.test.ts`
**Effort:** M

- [ ] Binding behavior: PRD §32.4 routes fully live: create → readiness → approve → deploy → evidence → rollback; evidence endpoint returns VF-15 manifest; release-into-repair-branch fork (PRD §28): `POST /v1/releases/:id/fork` creates branch `fix/rel-{id}` at release commit + optional Fix run — used by production-bug journey (§10.3 step 3).
- [ ] E2E test (staging, nightly): template project → build run → verify → release → deploy (fly) → synthetic pass → rollback → previous content served. This is exit criteria E16/E17/E18 as one executable test.
- [ ] Commit: `feat: end-to-end release lifecycle live behind /v1 APIs`

---

## Testing strategy
- Unit for classification/readiness/rollback state machines (fast, fixture-driven).
- Env-gated staging integration per provider; the DEP-12 nightly E2E is the release-plane regression net.
- Chaos case in CI: kill release-service mid-deploy → Temporal resumes → no double go_live (idempotency proof).

## Scalability notes
- Deploy workflows queue-isolated (`releases`) so a deploy storm can't starve agent runs; provider API rate limits respected via per-provider token buckets; image builds run in sandboxes (scales with sandbox pool, not service).

## Security & tenancy notes
- release-service is decrypt-allowlisted (CP-7) — the only path secrets take to providers; provider tokens vault-scoped per org; deployment logs scrubbed by redaction registry before storage; approval re-verified server-side at deploy time (defense in depth vs UI bypass).

## Execution log

- (empty)

- 2026-08-06 DEP-1 interface ownership clarified — ADR-0012 preserves the six-method `ReleasePort`; AR-4 tool-only preview/smoke/health operations remain separate adapters.
- 2026-08-06 DEP-1 deployment confirmation clarified — AR-4 removes invented confirmation IDs and uses the control API's exact nullable data-disposition envelope; replacement requires an explicit preserve/transfer/reset choice.

## Execution log

- 2026-08-04: **BLOCKER SURFACED BY GIT-2/3 (before DEP-1 starts).** Forgejo's `release/*` branch protection refuses pushes from the platform **admin** token too — proven by `services/git-service/test/integration/forgejo.test.ts` (an admin push to `release/1` is rejected by the hook). So the release service CANNOT create or move `release/*` branches over git with the credentials it was assumed to have. Resolve before DEP-1: either (a) set `apply_to_admins = false` and confirm the API branch-create path is likewise ungated (the git hook and the API may differ — verify, don't assume), (b) create release branches through the Forgejo API rather than a push, or (c) tag-only releases (PRD §27.3 requires an exact commit SHA, which a tag satisfies without a protected branch). Whichever is chosen, add an integration test that actually creates a release ref through the intended path — this was found because a test pushed for real rather than trusting the config.
- 2026-08-07 GIT-4 gate rewire — ci.yml's `git-backup-live` job was removed when Actions were parked (owner decision: metered minutes), which broke workflow.test.ts's never-silently-vanish assertion the moment caches went cold. The property now attaches to the real gate: scripts/git-hooks/pre-push.local exports GIT_BACKUP_LIVE=1 (backup.test.ts throws rather than skips when armed with a dependency missing), and workflow.test.ts asserts hook + turbo env + verify chain instead of the ci.yml job. Live proof against the local stack: backup/delete/restore/clone 1/1 in 6.2s, git-service integration 16/16, workflow.test.ts 4/4. The scheduled git-backups.yml workflow (nightly R2 drill) is untouched.
- 2026-08-11 DEP-1 done — Added the minimally required release-service package scaffold, immutable exact-SHA candidates, the six-method ReleasePort, authoritative tenant/provenance/RBAC context, append-only specification-waiver audit evidence, durable replay, guarded routes, and transition tests; the prior branch-protection blocker was resolved by GIT-3's live-tested idempotent `rel_*` exact-SHA tag path, and the single capped review's four Major findings were remediated with no remaining task blocker or interface deviation.
- 2026-08-11 DEP-2 done — Added an exact-SHA three-state readiness evaluator for every binding gate, canonical support-level secret severity, stable WEB-14 findings, and a keyed release/commit-bound AR-19 Fix action; the single capped review's three Major findings were remediated with no remaining blocker or deviation.
- 2026-08-11 DEP-3 done — Added latest-environment deployment classification, explicit replacement data-disposition enforcement, and stable user-language data, secret-name, URL, and active-user effects for WEB-14; the single capped review's two Major project-identity and non-replacement-disposition findings were remediated with no remaining blocker or deviation.
- 2026-08-11 DEP-4 done — Added exact-SHA sandbox image builds, health-gated blue-green Fly Machines deploys and rollback, strict status/log pagination with vault-value redaction, provider auth, preview rejection, domain seam, usage attribution, and a destructive-cleanup-safe staging proof; the single capped review's scoped-token auth, finite-cursor, and credential-cleanup findings were remediated with no deviation, while the one real-provider gate skipped visibly because `FLY_API_TOKEN`, `FLY_ORG_SLUG`, and `ZAPP_FLY_STAGING_ENABLED=1` are absent.
- 2026-08-11 DEP-5 done — Added deterministic Build Output API uploads, vault-backed production env sync, exact adapter presets, strict status/log redaction, true Vercel rollback, and domains; the single capped review's rollback-endpoint, nullable-events, runtime-env-proof, and staging restoration findings were remediated with no remaining blocker or deviation, while the one real-provider gate skipped visibly because `VERCEL_ACCESS_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_PROJECT_NAME`, and `ZAPP_VERCEL_STAGING_ENABLED=1` are absent.
- 2026-08-11 DEP-6 done — Added the exact eight-stage Temporal deploy workflow with schema-derived activity boundaries, durable activity/event/status keys, authoritative migration-plan and destructive-approval re-verification, health-gated go-live, and a Fly fixture proving failed health leaves the prior release serving; the single capped review fixed derived-key limits, event identity, event-store failure classification, and duplicated boundary types with no deviation, while the real Fly gate skipped visibly because `FLY_API_TOKEN`, `FLY_ORG_SLUG`, and `ZAPP_FLY_STAGING_ENABLED=1` are absent.
