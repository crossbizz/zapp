# Plan 10 — Billing, Observability & Security Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usage metering and credits (Flexprice), Stripe platform billing, budgets/quotas, platform + generated-app observability (OTel → Grafana Cloud), product analytics **and feature flags** (PostHog), the security test program, data lifecycle, and support operations — PRD §29, §30, §31, §26.1, §38.7.

**Architecture:** The append-only `usage_ledger` (FND-5) is the attribution/audit source of truth; every ledger row streams to **Flexprice** (idempotent by ledger row id) which owns rating, credit wallets, and entitlements; Redis counters serve hot reads with three-way reconciliation. Stripe Billing owns subscription commerce (checkout, seats, portal) with Flexprice handling usage rating into billing. **OpenTelemetry is the instrumentation standard across all services, exported to Grafana Cloud** (Tempo traces, Mimir metrics, Loki logs, Faro for frontend errors/web vitals, Grafana Alerting + OnCall). PostHog provides product analytics **and feature flags**. Security is a set of permanent executable suites, not documents.

**Tech Stack:** Stripe SDK + webhooks, Flexprice API (event ingestion, meters/metered features, wallets, entitlements — docs.flexprice.io), OpenTelemetry SDK (node) + OTLP → Grafana Cloud, Grafana Faro (web/desktop), PostHog (cloud: analytics + flags), k6 (load), gitleaks/osv-scanner/Semgrep (CI), AWS SQS/SNS/SES for queues + email (LocalStack locally, AWS SDK v3 with endpoint override).

**Milestone:** OPS-1A (M1), OPS-1B..3 (M2), OPS-4..18 (M5, several can start earlier). **Depends on:** Plans 01–08 hooks. **Consumed by:** master exit criteria E19, E20, E22.

## Global Constraints

Master plan §Global Constraints, plus:
- `usage_ledger` rows are never updated or deleted; corrections are compensating entries (negative quantities) with `correction_of` metadata.
- Pricing/margins/plan limits live in `config/pricing.json` + `config/plans.json` — deployable without code change.
- Telemetry attributes are tenant-safe: org/project/run IDs yes; emails, prompts, code, secret names **no**. Log serializers enforce this centrally.
- Every metric that gates business behavior (budgets, quotas) reads Redis but reconciles to Postgres within 60 s.

---

### Task OPS-1A [M1]: Durable completion journal + authoritative usage reservation

**ADR:** ADR-0025. **Files:** Create/modify: control-api model-completion and usage schemas/routes/repositories/composition plus run-budget default resolution; `packages/db` execution/billing schema, next migration and schema/tenant tests; `config/pricing.json`; usage transactional-outbox publisher/consumer; API/internal client tests; required manifests/exports.
**Effort:** L

- [x] RED: stable claim/commit/get boundary; tenant/fingerprint conflict; lease takeover; commit replay; deterministic ledger row IDs; omitted run budget resolves to configured M1 default and invalid/absent default/rate fails closed before workflow/provider dispatch; pricing snapshot remains fixed for the run; atomic worst-case reservation rejects before provider dispatch; concurrent reservations cannot cross the effective ceiling; commit settles actual usage and releases unused credit; approved idempotent monotonic ceiling increase resumes a blocked run while a decrease is rejected; database-commit/Redis-loss healing; completed journal byte-for-byte replay; active-run-only bounded reconciliation under a database leader lease; transactional outbox publishes one SQS/Flexprice event per ledger row.
- [x] GREEN: resolve and persist every run's immutable base ceiling and local pricing-version snapshot at creation; one run-scoped database transaction owns completion reservations, journal completion, append-only token rows, append-only approved ceiling adjustments, authoritative per-run running totals, and usage outbox; Redis is only the healed hot mirror under `run:{id}:credits`. No model-gateway database/Redis/SQS/Flexprice dependency.
- [x] Verify DB and control-api packages including real Postgres/Redis/LocalStack; two review rounds maximum, exit = zero Critical/Important.
- [x] Commit: `feat(usage): durable model completion journal and authoritative reservation`

### Task OPS-1B [M2]: Ledger service + Flexprice metering completion

**Files:** Create: `services/control-api/src/usage/{ledger,flexprice,pricing}.ts`, `scripts/flexprice-bootstrap.ts`, `test/usage.test.ts`; Modify: `config/pricing.json`
**Depends on:** OPS-1A. **Interfaces produced (binding):**
- `recordUsage(entry: UsageEntry)`: (1) validates category enum from FND-5, (2) appends `usage_ledger` row (attribution truth: org/project/run/task), (3) forwards to Flexprice ingestion — event shape per Flexprice docs: `{ event_name: category, external_customer_id: organizationId, event_id: ledgerRowId (idempotency), timestamp, properties: { project_id, run_id, task_id, quantity, unit, provider } }`; Flexprice forwarding runs through SQS `zapp-usage-events` (+DLQ): the ledger write is synchronous, the Flexprice event is enqueued, and a consumer forwards with backoff — the ledger never blocks on Flexprice and outages drain automatically (LocalStack in tests).
- `scripts/flexprice-bootstrap.ts`: idempotently creates one **metered feature + meter** per PRD §30.1 category (aggregation SUM over `properties.quantity`) and plans/entitlements from `config/plans.json` — Flexprice is configured from code, never hand-edited.
- `config/pricing.json` rates are authoritative, versioned snapshots for in-flight run reservation/cutoff and also drive pre-run estimates/Mission Control; Flexprice remains authoritative for organization wallet rating, entitlements, and billing.
- `getUsageSummary(orgId, window)`: ledger aggregates by category/project/run (attribution views); credit balance reads come from OPS-3.
- Internal route `POST /internal/usage` (service token) for non-model emitters extends OPS-1A; model-gateway uses only ADR-0025's claim/commit/get boundary.
**Effort:** L

- [ ] Failing tests: ledger append + Flexprice event forwarded with `event_id` = ledger row id (fake client); duplicate `recordUsage` retry → single ledger row + same event_id (idempotent); Flexprice-down path queues and drains without data loss; estimate math table-driven (tokens, cpu-seconds, GiB-seconds fixtures → exact estimated credits); compensating entry nets to zero in summary and emits a negative-quantity Flexprice event; unknown category rejected; bootstrap script second run is a no-op diff.
- [ ] Commit: `feat(usage): append-only ledger + idempotent Flexprice metering pipeline`

### Task OPS-2 [M2]: Metering collectors completion

**Files:** Create: `services/control-api/src/usage/collectors/{storage,git}.ts`; verify gateway/sandbox emitters
**Effort:** M

- [ ] Binding behavior (PRD §30.1 full category coverage): storage cron (daily): R2 prefix sizes per project → `artifact_storage`; snapshot/volume sizes via sandbox-service → `storage_gib_hours`; deploy-provider usage recorded per deployment (build seconds where measurable); reconciliation job (three-way): Redis run counters vs ledger sums vs Flexprice aggregates (per-category API query) — drift > 1% → alert + heal (ledger is arbiter); **every provider cost category maps to a ledger category and a Flexprice metered feature** — coverage test enumerates PRD §30.1 list against emitter registry and bootstrap output.
- [ ] Commit: `feat(usage): full metering coverage + three-way reconciliation`

### Task OPS-3 [M2]: Budgets, quotas, plan limits

**Files:** Create: `services/control-api/src/usage/limits.ts`, `config/plans.json`, enforcement hooks
**Effort:** L

- [ ] Binding behavior (PRD §30.3): `config/plans.json` per plan: `{ concurrentAutonomousRuns, concurrentSandboxes, maxResourceProfile, maxRunBudgetCredits, maxPreviewLifetimeHours, artifactRetentionDays, monthlyCredits, seats }` (placeholder tiers trial/builder/studio — GTM adjustable; synced to Flexprice plans/entitlements by the OPS-1 bootstrap). Enforcement is **local** (runtime concurrency/queues never depend on a vendor call) with typed errors: run start (CP-9) → `plan_limit_concurrent_runs`; sandbox create (WS-15 governor reads these) → `sandbox_quota_exceeded`; resource profile clamp; run budget default from plan; pre-run cost estimate surfaced (AR-14, local pricing config). **Credit balance** = Flexprice wallet balance API, Redis-cached ≤ 30 s, in-flight Redis counters subtracted; budget alerts at 50/80/100% (OPS-7 notify); balance ≤ 0 → new runs blocked (existing run finishes current task, then pauses with approval); Flexprice unreachable → last-known balance with a grace floor (config) and an ops alert — never a hard platform outage.
- [ ] Failing tests: each enforcement point table-driven per plan tier; balance-exhaustion mid-run pauses gracefully.
- [ ] Commit: `feat(usage): plan quotas + budget enforcement`

### Task OPS-4 [M5]: Stripe platform billing

**Files:** Create: `services/control-api/src/billing/{stripe,webhooks,portal}.ts`, `test/integration/billing.test.ts` (Stripe test mode)
**Effort:** L

- [ ] Binding behavior (PRD §26.1): products/prices bootstrapped by script from `config/plans.json`; subscribe flow: checkout session (plan + seats) → webhook `customer.subscription.*` sync → `subscriptions` row + org.plan update + Flexprice customer/plan assignment; monthly credit grant on invoice.paid = **Flexprice wallet grant** + mirror `usage_ledger` entry category `credit_grant` (extend enum, idempotent by invoice id); metered/usage charges flow Flexprice → Stripe via Flexprice's Stripe integration (invoice items), reconciled monthly against ledger aggregates; seat changes prorated via Stripe; customer portal link for payment method/invoices; failed payment: dunning state → org banner + 7-day grace → downgrade to trial limits (never data deletion); webhook signature + idempotent event processing (dedupe by event id); **platform Stripe credentials in separate vault scope from generated-app scope (INT-8 separation test extends here)**.
- [ ] Failing tests: webhook replay idempotent; subscription lifecycle transitions; grace-period state machine.
- [ ] Commit: `feat(billing): stripe subscriptions, seats, credit grants, dunning`

### Task OPS-5 [M5]: Credit top-ups + trial

**Files:** Create: `src/billing/topup.ts`
**Effort:** M

- [ ] Binding behavior: one-time checkout for credit packs (config-defined), grant on payment success = Flexprice wallet top-up + mirror ledger entry (idempotent by checkout session id); trial: signup grants `plans.trial.monthlyCredits` as a Flexprice trial wallet once per org with abuse guard (domain+card heuristics deferred; simple per-user-one-trial in P0); estimated-cost display API for pre-run UX (AR-14/WEB) from local pricing config.
- [ ] Commit: `feat(billing): credit top-ups + trial grants`

### Task OPS-6 [M5]: Product analytics + feature flags (PostHog)

**Files:** Create: `packages/config/src/{analytics,flags}.ts` (typed catalogs), web/desktop/service wiring
**Effort:** L

- [ ] Binding behavior — analytics: PostHog with typed catalog: `signup, org_created, project_created, run_started(mode), plan_approved, first_preview_ready, change_applied, verification_passed/failed, release_created, deploy_succeeded/failed, rollback_executed, credits_exhausted` — properties: orgId, projectId, mode, supportLevel (no prompt/code content); north-star dashboard: verified releases per active org per month (PRD §37.1) + activation funnel (§37.2) + reliability panel fed by verifier events (§37.3); release annotations on deploys (DEP-8 hook).
- [ ] Binding behavior — feature flags (PostHog flags, posthog.com/docs): typed flag catalog in `packages/config/src/flags.ts` (name, type, default, owner, expiry-review date): P0 flags: `voice-input` (WEB-3 mic, default off), `mobile-app-tab`, `visual-editing`, `browser-agent-enabled` (kill-switch), `auto-repair-enabled` (kill-switch), `autonomous-mode` (gradual rollout by org), `model-default-override` (multivariate for AR routing experiments); evaluation: server-side (PostHog Node in control-api/orchestrator, org-keyed with `groups: { organization }`), client bootstrap to web/desktop (no flag flicker); **kill-switch rule:** risky subsystems (browser agent, auto-repair, autonomous) check their flag at run/phase start so ops can disable without deploy; flags cached 60 s with local default fallback on PostHog outage (a flag outage never blocks the platform); stale-flag lint: catalog entries past expiry-review fail CI warning.
- [ ] Failing tests: flag helper returns default on outage; org-targeted rollout evaluates by group key; kill-switch consulted at autonomous phase boundary (fake flag flip pauses next phase).
- [ ] Commit: `feat(analytics): typed PostHog events + feature-flag catalog with kill-switches`

### Task OPS-7 [M5]: Notification service

**Files:** Create: `services/control-api/src/notifications/{service,email,templates}.ts`
**Effort:** M

- [ ] Binding behavior: delivery pipeline: triggers enqueue to SQS `zapp-notifications` (+DLQ); worker consumes → channels: email (AWS SES) + in-app (event-derived) + desktop push (MAC-11 consumes events); SNS topics for multi-subscriber fan-out (e.g. deploy events → email + webhook subscribers) as needed; triggers: approval requested, run completed/failed, budget 50/80/100%, synthetic check failure, deploy success/failure, payment failure, member invited; per-user per-type preferences; batching (no more than 1 email/type/15 min per org); templates text-first with deep links (`zapp://` + web URLs); LocalStack-backed integration tests for the full enqueue→SES path.
- [ ] Failing tests: trigger→notification mapping; batching window; preference suppression.
- [ ] Commit: `feat(notifications): multi-channel notification service`

### Task OPS-8 [M5, start M2]: OpenTelemetry → Grafana Cloud across services

**Files:** Create: `packages/config/src/otel.ts` (shared init), per-service wiring, `packages/config/src/logger.ts` (tenant-safe serializers)
**Effort:** L

- [ ] Binding behavior (PRD §29.1): every service: OTel SDK (traces + metrics + logs) with resource attrs (service.name, env) + context propagation (control-api → temporal → sandbox-service chain), exported via OTLP to **Grafana Cloud** (Tempo traces, Mimir metrics, Loki logs — stack per env: zapp-dev/staging/prod); instrument the PRD list: API latency/errors (route histograms), Temporal workflow/activity latency + failure counters (interceptors), agent step + tool call latency (AR-6 spans), model latency/tokens/cost (AR-3), sandbox lifecycle timings (WS-6), preview readiness, deployment success, queue delay, event-stream lag (CP-15 sequence age gauge); frontend/desktop errors + web vitals via **Grafana Faro** SDK with sourcemap upload in CI and release tagging; error alerting via Grafana Alerting rules (5xx bursts, unhandled-exception log matches); **sandbox telemetry is relayed through a sandbox-service collector endpoint — sandboxes never hold Grafana credentials** (Global Constraint 5); logs: pino → OTLP with central redaction serializers (test: logging an object containing a vault value emits `[secret:*]`).
- [ ] Commit: `feat(observability): otel→grafana cloud with faro frontend + tenant-safe logging`

### Task OPS-9 [Deferred post-P0 — ADR-0022]: SLO dashboards + load tests + capacity model

**Files:** Create: `infra/observability/dashboards/*.json`, `test/load/k6/*.js`, `docs/capacity-model.md`
**Effort:** L

- [ ] Binding behavior: Grafana dashboards **as code** (Grafana Terraform provider / JSON in `infra/observability/dashboards`) for PRD §36.2 targets (dashboard p95 < 500 ms, event delivery p95 < 2 s, sandbox ready p95 < 30 s warm, template preview < 2 min p50, import preview < 5 min p50, cancel ack < 5 s) with burn-rate alerts in Grafana Alerting; k6 suites (native Grafana Cloud k6 integration for result storage): API read/write mix at 10× P0 scale (1k orgs synthetic), SSE fanout (500 concurrent streams), event ingest (25 runs × 20 events/s); capacity doc: measured headroom + scaling levers per component (from master §5); staging soak run gate before beta.
- [ ] Commit: `test(load): k6 suites + grafana SLO dashboards as code at 10× targets`

### Task OPS-10 [M5]: Generated-app observability (Managed)

**Files:** Create: `templates/observability/{faro-web,otel-node,health-endpoint,logging}.ts.hbs`, instrumentation plan hook in project-adapters
**Effort:** L

- [ ] Binding behavior (PRD §29.2): `proposeInstrumentation` (VF adapters) returns plan: frontend error reporting + web vitals via **Grafana Faro** (per-project Faro app provisioned under the zapp-managed Grafana Cloud org by default — matching the managed-hosting default of locked decision #4; customer-owned Grafana stack connectable post-P0), backend via OTel node SDK (per-project scoped OTLP token), structured logging setup, `/api/health` endpoint template, release annotation wiring into DEP-8; applied as normal agent tasks (visible commits); observability_check gate (VF-4 matrix) verifies presence for Managed releases; customer telemetry isolation guaranteed (PRD §29.3 — per-project Faro apps/tokens, never shared).
- [ ] Commit: `feat(templates): managed-app observability via faro + otel`

### Task OPS-11 [M5]: Closed-loop diagnosis (production error → Fix run)

**Files:** Create: `services/control-api/src/routes/incidents.ts`, web hook-up
**Effort:** M

- [ ] Binding behavior (PRD §29.4): inbound error webhook (Grafana Alerting webhook from Faro/Loki error rules) / synthetic failure / user report → incident record → "Create Fix run" action (web + notification CTA) → AR-19 fix workflow seeded with: release id, commit, error payload, trace/log links, repro route; resolution links back (incident → fix run → new release) for the §10.3 journey; fully autonomous remediation explicitly absent (approval gates intact).
- [ ] Commit: `feat(ops): incident-to-fix-run closed loop`

### Task OPS-12 [M5, start M3]: Security test program — isolation, redaction, sandbox abuse

**Files:** Create: `test/security/{tenant-isolation-extended,redaction,sandbox-abuse,path-traversal}.test.ts`, CI job `security-suite`
**Effort:** L

- [ ] Binding behavior (PRD §31.2 as executable checks): extends CP-4 suite to every resource type (releases, artifacts, evidence, secrets, audit — 404 cross-tenant matrix); redaction: seeded secrets never appear in events/logs/artifacts/model-request captures (greps recorded fixtures); sandbox abuse (against real dev sandbox, nightly): fork bomb → cgroup kill + abnormal-termination event; memory balloon → OOM handled; egress attempt to non-allowlisted host under `build_test` profile → blocked + policy log; path traversal fuzz corpus vs workspace-agent (`../`, symlinks, `%2e%2e`, null bytes); control-plane credential absence (WS-11 allowlist test promoted here).
- [ ] Commit: `test(security): permanent isolation/redaction/abuse suites`

### Task OPS-13 [M5, start M3]: Prompt-injection evals + CI policy scans

**Files:** Create: `test/security/injection-evals/{corpus/*.md,eval.test.ts}`, `.semgrep/zapp-policies.yml`, CI updates
**Effort:** M

- [ ] Binding behavior (PRD §31.3): corpus ≥ 25 injection payloads embedded in fixture repo files (README instructions, code comments, tool output, package descriptions, error messages) — eval asserts agent-policies deny the induced actions (secret exfil attempt, policy override, unapproved deploy, curl-pipe-sh) with `untrusted_instruction`; corpus grows on every real-world finding (regression file per incident); Semgrep policy pack: empty catch, `child_process` outside runtime packages, direct Modal/model SDK imports outside allowed services (Global Constraints 1–2 as scans), `process.env` secret names in client code; osv-scanner flips to blocking for critical severities.
- [ ] Commit: `test(security): injection eval corpus + semgrep policy gates`

### Task OPS-14 [M5]: Retention + archival execution

**Files:** Create: `services/control-api/src/jobs/archive.ts` (with CP-17), R2 lifecycle Terraform
**Effort:** M

- [ ] Binding behavior (PRD §31.4, master §5.2): monthly `agent_events` partitions > 90 d → R2 JSONL archive (readable by support tooling) → partition drop; artifact TTLs by class via R2 lifecycle rules (test 30 d, diagnostics 7 d, evidence retained); Modal snapshot TTL enforcement audit (WS-7 classes); restore-from-archive utility (support tool: rehydrate a run's events read-only).
- [ ] Commit: `feat(ops): retention archival with rehydration tooling`

### Task OPS-15 [Deferred post-P0 — ADR-0022]: Backup/DR + drills

**Files:** Create: `docs/runbooks/{dr-restore,git-restore,neon-pitr}.md`, drill automation script
**Effort:** M

- [ ] Binding behavior: verified restore paths: Neon PITR (control DB), nightly logical dumps to R2 (secondary), Forgejo bundles (GIT-4), R2 artifact durability review; quarterly drill script: restore staging from backups → run smoke (targets: RPO ≤ 24 h, RTO ≤ 4 h documented in master §6); drill results recorded in ops log (SOC2 evidence, OPS-16).
- [ ] Commit: `docs(ops): DR runbooks + automated quarterly drill`

### Task OPS-16 [Deferred post-P0 — ADR-0022]: SOC 2 Type I readiness pack

**Files:** Create: `docs/compliance/{soc2-readiness.md,vendor-register.md,access-review.md,change-management.md}`
**Effort:** M

- [ ] Binding behavior: control mapping doc: change management = PR + CI evidence (link policy), access reviews quarterly (checklist + owner), vendor register (Modal, Neon, Upstash, Cloudflare, Stytch, Stripe, Flexprice, Temporal, Vercel, Fly, Grafana Cloud, PostHog, AWS — DPA/status links), incident response (OPS-18), encryption + secret controls (CP-7/WS-11 references), audit trail (CP-5); explicitly *readiness*, not certification (PRD non-goal), structured so an auditor engagement post-P0 starts from evidence, not archaeology.
- [ ] Commit: `docs(compliance): soc2 type i readiness pack`

### Task OPS-17 [M5]: Support/admin console

**Files:** Create: `apps/web/src/app/admin/*` (staff-role gated), `services/control-api/src/routes/admin.ts`
**Effort:** L

- [ ] Binding behavior (PRD §6.4, §22.3): staff role (zapp employees, separate flag + allowlist): tenant lookup (org/project/run state, sandbox + deployment status, cost/usage), agent-run diagnostics (support-visibility events + artifacts), resource termination (kill run/sandbox — WS-15 kill-switch), impersonation: explicit reason required → time-boxed session → `support.impersonation` audit events on every action → org-visible in their audit log (locked decision #11: source code inspection requires customer grant flow); no secret value access path exists in admin UI.
- [ ] Failing tests: staff route 403 for normal users; impersonation without reason → 422; every admin mutation audited.
- [ ] Commit: `feat(admin): audited support console with termination controls`

### Task OPS-18 [Deferred post-P0 — ADR-0022]: Incident response + status page

**Files:** Create: `docs/runbooks/incident-response.md`, status page setup (BetterStack or equivalent), alert routing
**Effort:** S

- [ ] Binding behavior: severity ladder (S1 platform down / S2 degraded / S3 partial), paging via **Grafana OnCall** (Grafana Cloud IRM) fed by OPS-9 burn-rate alerts + synthetic platform checks (zapp's own app monitored like a Managed customer — dogfood DEP-11), public status page with component granularity (API, builds, previews, deploys), postmortem template with action-item tracking into `tasks/`.
- [ ] Commit: `docs(ops): incident response + public status page`

---

## Testing strategy
- Billing: Stripe test clocks for subscription lifecycles; ledger math is pure-function table tests.
- Security suites are CI-permanent from creation (start M3, complete M5); nightly abuse tests run against real dev sandboxes.
- Load: k6 at 10× targets — deferred post-P0 with OPS-9 (ADR-0022); soak runs before public beta.

## Scalability notes
- Ledger writes are the highest-frequency control-plane inserts after events: batched (collectors flush ≤ 5 s), indexed for the two real queries (org-window aggregate, run rollup); Redis counters absorb read load.

## Security & tenancy notes
- This plan owns the permanent proof that master §6 promises hold: every enterprise-readiness row maps to a suite or runbook here (isolation → OPS-12, audit → CP-5+OPS-17 tests, lifecycle → OPS-14/CP-17, DR → OPS-15, program → OPS-16/18). OPS-9/15/16/18 are deferred post-P0 by ADR-0022 and return before public beta.

## Execution log

- 2026-08-09 OPS-1A done — Durable claim/commit accounting, exact reservations, Postgres-led Redis healing, and SQS-to-Flexprice delivery verified; at the two-review cap, three round-two correctness findings were closed by deterministic RED/GREEN without a third review, the cold gate's real early-abort DB test received the same bounded 15 s process budget as its load-bearing pool assertion, and clean CI repairs now await preview-coordinator release after aborted CDP cleanup, atomically publish complete native workspace helpers, bound transient normal-filesystem removal retries in the cgroup test double, and probe append-only ledger TRUNCATE guards through the new outbox FK with CASCADE.
- 2026-08-04: DEPLOYMENT NOTE (from CP-5 fix): rate-limit proxy trust defaults to NONE. Any deploy behind an edge proxy MUST set `proxy.trustedHops` (or trustedProxies) in config/rate-limits.json in the same change, or ip-scoped classes bucket by the ingress. The plugin warns at boot naming the field; setting both fields refuses to boot. Owner: OPS deploy runbook.
- 2026-08-08 ADR-0022: OPS-9, OPS-15, OPS-16, OPS-18 deferred post-P0 — no P0 PRD basis (PRD §5 non-goals exclude custom compliance programs); all four return before public beta. Backups themselves (Neon PITR, logical dumps, nightly Git bundles) stay in P0.
