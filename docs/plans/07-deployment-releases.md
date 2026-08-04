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

Release flow states: `candidate → verifying → ready|warnings|blocked → approved → deploying → healthy|failed → superseded`. Creation requires: exact commit SHA exists in internal Git (GIT-2 lookup), spec version reference (or explicit waiver object), no release for prototype-only runs (AR-15 rule).
**Effort:** M

- [ ] Failing tests: create validates commit exists (unknown SHA → 422 `commit_not_found`); immutability (attempt to change commit → no code path; status transition table enforced); approve requires RBAC `approve_production_deploy` (checked at CP-11, re-checked here with actor).
- [ ] Commit: `feat(release-service): immutable release candidates + ReleasePort`

### Task DEP-2: Pre-deployment readiness check

**Files:** Create: `src/release/readiness.ts`, `test/readiness.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §26A.2): evaluates exactly: production build + start commands (gate reuse VF-5), lockfile consistency (`pnpm install --frozen-lockfile` dry check), required env/secrets present in target environment (contract-declared + detected `process.env` reads missing → finding), database connectivity + approved migrations (INT-6/7 validation state), provider compatibility (adapter `detectCompatibility`), health endpoint defined, critical browser flows green (latest VF results for the commit), release-policy + verifier decision (VF-10). Output: exactly three states — `ready | warnings | blocked` with findings `[{ id, severity: "blocker"|"warning", title, detail, action: "fix_and_recheck"|"review"|"waive" }]`; blockers list which mandatory gate failed; primary action for blocked = Fix and recheck (spawns Fix run via AR-19).
- [ ] Failing tests: missing env secret → warning (or blocker for Managed); failed critical flow → blocked; all green → ready; findings payload drives WEB-14 UI snapshot.
- [ ] Commit: `feat(release-service): three-state readiness report`

### Task DEP-3: Deployment type classification + confirmation contract

**Files:** Create: `src/release/types.ts`, `test/types.test.ts`
**Effort:** M

- [ ] Binding behavior (PRD §26A.3): classify(environment history, target): `first_deploy` (no prior deployment for env) | `redeploy` (same project lineage) | `replace_deployment` (different project/major identity change — detected via repo lineage mismatch or explicit user retarget); confirmation payload states, in user language: production data effect (`preserved | migrated (n migrations, reversibility) | reset — requires explicit selection`), secrets effect (added/changed/removed names), URL effect, active-user effect (brief interruption vs zero-downtime per provider); `replace_deployment` requires explicit data disposition selection (`preserve | transfer | reset`) — API rejects absent selection (422 `data_disposition_required`).
- [ ] Failing tests: each classification from seeded histories; replace without disposition rejected; confirmation text snapshots (used verbatim by WEB-14).
- [ ] Commit: `feat(release-service): deployment type classification + explicit data behavior`

### Task DEP-4: Fly.io generic Node container adapter

**Files:** Create: `src/providers/fly.ts`, `test/integration/fly.test.ts` (env-gated staging)
**Effort:** XL → split at execution: 4a image build+push, 4b machines deploy+health, 4c logs+status streaming. **[expand-at-execution]**

Binding behavior: implements `DeploymentProvider` (FND-4): `detectCompatibility` (any Node app with build+start or Dockerfile); build: in sandbox — Dockerfile template (node:22-slim multi-stage, contract build command, non-root user) unless project Dockerfile exists → `docker buildx` → push to Fly registry `registry.fly.io/zapp-{projectId}-{env}`; deploy: Fly app per project-env under zapp org (locked decision #4), machines update with new image ref (blue-green: start new machine → health check → stop old), secrets via Fly secrets API from vault (release-service is decrypt-allowlisted, CP-7); `getStatus`/`streamLogs` from Machines API; `rollback` = machines update to previous image ref (image refs retained on `deployments` rows); cost attribution stub → OPS-2 (deploy provider usage category).

### Task DEP-5: Vercel adapter

**Files:** Create: `src/providers/vercel.ts`, `test/integration/vercel.test.ts` (env-gated)
**Effort:** L

- [ ] Binding behavior: user-connected Vercel (OAuth token in vault, `integration_connections` provider `vercel`); `detectCompatibility` from project-adapters hints (next/vite/astro/sveltekit/nuxt); deploy: file-digest upload of the sandbox-built output via Vercel deployments API (deterministic: we build, Vercel serves; framework preset set explicitly), env vars synced from vault per environment, `target: production` only on user-approved deploy; preview deployments NOT used for zapp previews (Modal previews remain the dev loop; Vercel = production path) — keeps environments visibly distinct (PRD §26A.1); rollback = re-promote previous deployment id; domains via Vercel domains API (DEP-9).
- [ ] Failing tests (staging token): deploy fixture static next app → URL 200; env var present at runtime; promote-previous restores prior content.
- [ ] Commit: `feat(release-service): vercel production adapter`

### Task DEP-6: Deploy workflow with stage timeline

**Files:** Create: `src/workflows/deploy.ts`, `test/integration/deploy-workflow.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §26A.4, §27.3): Temporal workflow stages exactly: `readiness_check → build_artifact → configure_secrets → apply_migrations → provision_runtime → start_services → production_health_check → go_live`; each stage emits `deployment.updated` event `{ stage, status: running|passed|failed, elapsedMs, summary, evidenceArtifactId? }`; migrations stage: only pre-approved migration plan (INT-6/7), destructive ops re-verified against approval record; traffic switch (`go_live`) happens only after `production_health_check` passes — failure at any stage leaves previous deployment serving (test asserts old URL content unchanged after induced failure); idempotent stages (activity idempotency keys); deployment row status transitions recorded.
- [ ] Failing integration test (fly staging + fixture app): full deploy walks all 8 stages in order with events; induced health-check failure → status `failed`, previous deployment still live, no partial traffic switch.
- [ ] Commit: `feat(release-service): staged deploy workflow with safe go-live`

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
