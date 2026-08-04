# 0001 — Locked P0 product and stack decisions

Status: accepted (product owner, 2026-08-03)
Affects: every plan in `docs/plans/`; `packages/config` (model and pricing defaults); all
service and adapter boundaries
References: PRD §35, §38.1, §43; master plan §2 (`docs/plans/00-master-plan.md`);
ADR-0002 (Dyad fork)

## Context

PRD §43 leaves thirteen product decisions explicitly open, and PRD §35 records several
infrastructure choices as suggestions rather than commitments. Ten workstream plans
depend on those answers: `services/model-gateway` cannot pick defaults without decision
6, `CP-2` cannot build `AuthPort` without decision 3, and `OPS-1..5` cannot meter
anything without decision 5.

Master plan §2 resolved all thirteen, and on 2026-08-03 the product owner issued
directives that decided identity, queues/notifications and the remaining §35 gaps
outright. Those answers currently live only in the master plan, mixed in with sequencing
and scope. That is the wrong home for them: plans get rewritten as milestones land,
while a locked decision must stay legible — and refutable — for as long as it holds.

Without a stable record, executing agents re-litigate settled choices task by task, and
a silent deviation in one service is indistinguishable from an intentional change.

## Decision

The tables below are the source of truth for P0 technology and product-policy choices.
They are transcribed from master plan §2; where the two ever disagree, this ADR wins.

Each row is **locked for planning**. A row is revisited only at its gate, or by a new
ADR that supersedes it.

### Resolved PRD §43 open decisions

| # | Decision | Resolution | Rationale | Gate |
|---|----------|------------|-----------|------|
| 1 | Internal Git service | **Forgejo** (containerized on Fly.io, volume + nightly `git bundle` backups to R2) behind a `GitProvider` interface | Battle-tested, MIT, repo-scoped tokens, webhooks, admin API; provider-neutral contract preserved | End of M0 |
| 2 | Generic Node deploy provider | **Fly.io Machines** | OCI-image deploys, per-app isolation, certs API for custom domains, image-pinned rollback, regions | End of M0 |
| 3 | Platform identity | **Stytch B2B** (+ `AuthPort` abstraction) — decided by product owner 2026-08-03 | One Stytch Organization per zapp org; email+password, magic link, Google/GitHub OAuth in P0; enterprise path: Stytch SSO (SAML/OIDC) + SCIM enabled later without migration | Decided |
| 4 | Hosting model for generated apps | **zapp-managed Fly.io org by default** (one-click, metered into credits); optional user-connected Vercel | Emergent-parity one-click deploy for nontechnical users; BYO Vercel for agencies | End of M3 |
| 5 | Pricing/credit model | Config-driven credits (1 credit = $0.01 cost basis × plan margin), rated and walleted in **Flexprice**; plans Free-trial / Builder / Studio as placeholders | GTM decides packaging; engineering ships the metering pipeline + config (OPS-1..5) | M5 |
| 6 | Default models per role | Config: planner=`claude-sonnet-5`, builder=`claude-sonnet-5`, verifier=`claude-opus-5`, summarizer=`claude-haiku-4-5`; OpenAI + Gemini wired as alternates | Benchmark in M3 repair-loop evals; all config, no code | M3 |
| 7 | Autonomous execution per plan | Plan-tier caps: concurrent runs, sandboxes, max resource profile, run budget (table in plan 10) | Matches PRD §30.3 | M5 |
| 8 | Visual editing scope | P0: click-to-attach element context (selection → agent context). Full property editing: public beta | PRD §10.0.1 step 6 requires attach; Dyad-style editing is not on the P0 critical path | M2 |
| 9 | Imported monorepos | **Compatible** at launch; **Verified** when detection succeeds for pnpm/turbo standard layouts | Progressive guarantees principle | M3 |
| 10 | Data residency | US-only P0, stated in docs/ToS | Scope control | M5 |
| 11 | Support inspection | Metadata + `visibility: support` events by default; source code requires explicit customer grant (audited support session) | PRD §22.3, §31.2 | M5 |
| 12 | Local-only macOS | Free, but requires zapp account sign-in; model usage metered through platform gateway (BYO keys post-P0) | Funnel + abuse control; PRD §15.4 defers BYOK | M4 |
| 13 | Dyad Apache policy | Fork lives in `apps/desktop` + extracted `packages/dyad-*`; NOTICE maintained; no `src/pro` code (CI-enforced); quarterly upstream merge owner; generic fixes upstreamed when practical | PRD §38.1, license safety | M0 |

### Control-plane infrastructure (PRD §35 gaps)

| Concern | Decision | Notes |
|---|---|---|
| Control-plane Postgres | **Neon** | Branch-per-CI-run dogfoods a P0 integration |
| Artifact storage | **Cloudflare R2** | Egress-free evidence and screenshots |
| Cache / rate limit / pub-sub | **Upstash Redis** | |
| Workflow orchestration | **Temporal Cloud** | Local dev via `temporal server start-dev` |

### Additional stack decisions (product owner, 2026-08-03)

These supersede PRD §35 suggestions where they differ.

| Concern | Decision | Notes |
|---|---|---|
| Identity | **Stytch B2B** | Replaces the earlier WorkOS recommendation; `AuthPort` abstraction unchanged (CP-2) |
| Control-plane DB | **Neon** | Confirmed |
| Platform billing | **Stripe Billing** | Confirmed — subscriptions, seats, checkout, portal (OPS-4/5) |
| Usage metering / credits / rating | **Flexprice** (docs.flexprice.io) | Meters + metered features per usage category; org = Flexprice customer; wallets = credits. The local append-only `usage_ledger` remains the attribution/audit record and idempotency source (`event_id` = ledger row id) — OPS-1..5 |
| Observability | **OpenTelemetry instrumentation → Grafana Cloud** (Tempo traces, Mimir metrics, Loki logs, **Faro** frontend errors/web vitals, Grafana Alerting + OnCall) | Replaces the PRD §35 Sentry suggestion for both platform and generated-app observability — OPS-8..11 |
| Product analytics **and feature flags** | **PostHog** | Analytics catalog + flags (kill-switches for risky subsystems, gradual rollouts) — OPS-6 |
| Queues & notifications | **AWS SQS** (work queues + DLQs), **SNS** (fan-out), **SES** (email); **LocalStack** for local dev/CI | AWS SDK v3 with an env endpoint override so LocalStack ≡ prod code path; Redis stays on the latency path (cache, rate limits, SSE pub-sub ping), not a work queue; Temporal task queues unaffected — OPS-1/7, INT-1, FND-7 |

### Rejected alternatives

Recorded so they are not re-proposed: Supabase Auth and WorkOS for identity (lost to
Stytch B2B on B2B org modelling and the SSO/SCIM upgrade path), Sentry for error
tracking (lost to Grafana Cloud + Faro to keep one observability vendor), a
self-operated Postgres (lost to Neon on branch-per-CI-run), and GitLab/Gitea for
internal Git (lost to Forgejo on licence and operational weight).

## Consequences

- Executing agents implement these choices without re-opening them. A task that finds a
  row wrong raises it as a new ADR rather than deviating in code.
- **Deviating from any row above requires a new ADR that supersedes that row.** The row
  stays in this file; the superseding ADR is linked from it.
- Rows 5, 6 and 7 are deliberately config-shaped (master plan constraint 20: image tags,
  SDK versions and pricing assumptions live in configuration). Changing a *value* inside
  those configs is not a deviation and needs no ADR; changing the *mechanism* does.
- Rows carrying a gate later than "Decided" are commitments for planning, not forever.
  At the gate, the owner either confirms the row or supersedes it.
- Row 13 is enforced mechanically, not by review: the `zapp/no-dyad-pro-imports` ESLint
  rule (`packages/eslint-rules`) plus the `license-boundary` job in
  `.github/workflows/security.yml`. See ADR-0002 and the root `NOTICE`.
- Single-vendor concentration is accepted twice over (Grafana Cloud for all telemetry,
  AWS for all queues and email). Both sit behind adapters, but neither has a tested
  second implementation in P0; a migration would be real work.
