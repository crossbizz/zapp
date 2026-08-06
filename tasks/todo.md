# zapp.build P0 Master Tracker

Source plans: [docs/plans/](../docs/plans/README.md). One checkbox per task; check here **and** in the owning plan file when done. Milestone gates: run the exit-criteria checklist in [00-master-plan.md §4](../docs/plans/00-master-plan.md) before starting the next milestone.

## M0 — Foundation (Weeks 1–3)

### Plan 01 — Foundation
- [x] FND-0 Repository initialization
- [x] FND-1 Monorepo scaffold (pnpm/turbo/tsconfig/eslint/vitest)
- [x] FND-2 packages/config env validation
- [x] FND-3 contracts: ids, agent events, run/task enums
- [x] FND-4 contracts: sandbox/adapter/deployment/tool interfaces
- [x] FND-5 db: identity + billing schema
- [x] FND-6 db: full PRD §23 schema + event partitioning + tenant repos
- [x] FND-7 docker-compose dev env + bootstrap
- [x] FND-8 CI pipeline + security scans
- [x] FND-9 NOTICE, src/pro import ban, ADRs
- [x] FND-10 API error envelope + pagination conventions

### Plan 02 — Control plane (part 1)
- [x] CP-1 Fastify skeleton + request context
- [x] CP-2 Stytch B2B auth + device flow (AuthPort)
- [x] CP-3 Orgs, memberships, invites, RBAC matrix
- [x] CP-4 Tenant context + isolation suite v1
- [x] CP-5 Audit + idempotency + rate limits
- [x] CP-6 Projects/repos/branches/environments CRUD
- [x] CP-7 Secrets vault (envelope encryption, audited decrypt)
- [x] CP-8 Internal service tokens

### Plan 06 — Internal Git
- [x] GIT-1 Forgejo deployment + bootstrap
- [x] GIT-2 git-service GitProvider
- [x] GIT-3 Repo-scoped short-lived tokens
### Plan 09 — Desktop fork prep
- [x] MAC-1 Dyad fork builds without src/pro
- [x] MAC-2 Rebrand + signing/notarization CI
- [x] MAC-3 Dyad capability preservation suite

## M1 — Walking skeleton: prompt → preview (Weeks 3–8)

### Plan 02 — Control plane (part 2)
- [x] CP-9 Run + workspace routes
- [x] CP-10 Specification routes
- [x] CP-11 Release/integration route shells + RBAC
- [x] CP-12 Audit reads + org settings
- [x] CP-13 Sequenced event ingest
- [x] CP-14 LISTEN/NOTIFY → Redis fanout
- [x] CP-15 Resumable SSE stream
- [x] CP-16 OpenAPI + generated SDK
### Plan 03 — Workspace/sandbox core
- [x] WS-1 workspace-runtime interface + path safety
- [ ] WS-2 Modal images (forge-node-base, forge-web-test)
- [ ] WS-3 workspace-agent daemon
- [ ] WS-4 Modal provider create/exec/terminate/attach
- [ ] WS-5 Scoped-token git clone/push
- [ ] WS-6 Lifecycle state machine + reaper + reconciler
- [ ] WS-7 Checkpoints + snapshot-free restore
- [ ] WS-8 Resource profiles + cost recorder
- [ ] WS-9 Cache volumes + branch locks
- [ ] WS-10 Preview proxy + capture client
- [ ] WS-11 Secret injection + network profiles + redaction
- [ ] WS-12 Preview tokens + share records
### Plan 06
- [x] GIT-4 Nightly bundle backups + restore
### Plan 04 — Agent runtime core
- [ ] AR-1 model-gateway streaming API
- [ ] AR-2 Routing/retry/fallback
- [ ] AR-3 Usage telemetry + budget cutoff
- [ ] AR-4 agent-tools registry (PRD §16.1 complete)
- [ ] AR-5 agent-policies + injection defense + role prompts
- [ ] AR-6 Session loop
- [ ] AR-7 Context builder + compaction
- [ ] AR-8 M1 durable chat run on Temporal
### Plan 08 — Web core
- [x] WEB-1 Next scaffold + session + org context
- [x] WEB-2 packages/ui design system (Next+Vite)
- [x] WEB-3 Home screen (Emergent-modeled)
- [ ] WEB-4 Dashboard + org switcher + import entry
- [x] WEB-5 Builder two-pane shell
- [ ] WEB-6 Event-sourced conversation thread

## M2 — Agentic core + Mission Control (Weeks 8–14)

- [ ] AR-9 Worker/queues/idempotency hardening
- [ ] AR-10 Pause/resume/cancel/redirect signals
- [ ] AR-11 planning-engine schema + scheduler
- [ ] AR-12 Isolated task workflows + merge/conflict tasks
- [ ] AR-13 Mission Control read model
- [ ] AR-14 Run budgets + approval loop
- [ ] AR-15 Ask + Prototype modes
- [ ] VF-1 Adapter framework + generic node
- [ ] VF-2 Framework adapters (P0 set)
- [ ] VF-3 Capability scan pipeline
- [ ] VF-4 Gate registry + §24.2 policy matrix
- [ ] VF-5 Deterministic gates (build/type/lint/unit/secret/dev-server)
- [ ] WS-13 Dev-server supervisor + logs
- [ ] WS-14 Nightly Modal E2E suite
- [ ] WS-15 Runaway-compute governor
- [ ] WEB-7 Preview panel + states + capture drawer
- [ ] WEB-8 Element selection attachments
- [ ] WEB-9 Mission Control drawer
- [ ] WEB-10 Interview/spec/plan approval cards
- [ ] WEB-11 Code/Logs/Tests surfaces
- [ ] WEB-17 Template gallery + detail with demo preview & Remix
- [ ] OPS-1 Ledger + Flexprice metering pipeline
- [ ] OPS-2 Metering coverage + three-way reconciliation
- [ ] OPS-3 Plan quotas + budget enforcement
- [ ] MAC-4 Platform auth + Keychain
- [ ] MAC-5 Unified local+cloud dashboard
- [ ] MAC-5.5 Triage 51 Pro-dependent integration test files + fix upstream monaco replaceEditorContent helper (aria-hidden ime-text-area breaks edit_code + editor_commit_menu) (spec source: 13 local_agent_* files; before/with MAC-6)
- [ ] MAC-6 Local WorkspaceRuntime + local sessions

## M3 — Verification-first + Autonomous (Weeks 12–18)

- [ ] VF-6 Preview health + browser smoke gates
- [ ] VF-7 Playwright runner + evidence artifacts
- [ ] VF-8 Smoke + acceptance test generation
- [ ] VF-9 Criteria traceability
- [ ] VF-10 Verifier decision engine (rejection authority)
- [ ] VF-11 Browser agent (exploratory)
- [ ] VF-12 Accessibility gate
- [ ] VF-13 Classified repair loop (hard budgets)
- [ ] VF-14 Anti-slop detectors
- [ ] VF-15 Evidence manifest + report renderer
- [ ] VF-16 Dependency + migration gates
- [ ] AR-16 specification-engine (interview + spec)
- [ ] AR-17 Autonomous mode workflow
- [ ] AR-18 Build mode
- [ ] AR-19 Fix mode (reproduce-first)
- [ ] AR-20 Redirect + plan diff
- [ ] AR-21 Forking (project/branch/conversation/run)
- [ ] WEB-12 Settings suite (secrets/integrations/members/GitHub)
- [ ] WEB-13 Releases + evidence viewer
- [ ] OPS-12 Security suites (start; complete M5)
- [ ] OPS-13 Injection evals + Semgrep gates (start; complete M5)

## M4 — Integrations & deployment (Weeks 16–22)

- [ ] INT-1 GitHub App + webhooks
- [ ] INT-2 GitHub import
- [ ] INT-3 Sync engine (stale-base, conflicts)
- [ ] INT-4 GitHub export
- [ ] INT-5 Supabase connect/provision/schema/types
- [ ] INT-6 Supabase migrations + RLS gen/tests
- [ ] INT-7 Neon branch workflows
- [ ] INT-8 Generated-app Stripe adapter
- [ ] INT-9 Stripe E2E integration tests
- [ ] DEP-1 Release records + ReleasePort
- [ ] DEP-2 Three-state readiness check
- [ ] DEP-3 Deployment type classification
- [ ] DEP-4 Fly.io container adapter
- [ ] DEP-5 Vercel adapter
- [ ] DEP-6 Staged deploy workflow (safe go-live)
- [ ] DEP-7 Production health + prod-safe smoke
- [ ] DEP-8 Success contract + release annotations
- [ ] DEP-9 Rollback with DB-compatibility gating
- [ ] DEP-10 Custom domains + SSL
- [ ] DEP-11 Synthetic checks
- [ ] DEP-12 E2E release lifecycle + fork-to-repair
- [ ] WEB-14 Deploy flow UI (readiness→confirm→timeline→success)
- [ ] WEB-15 Production health + guarded rollback UI
- [ ] MAC-7 Docker runtime mode
- [ ] MAC-8 Cloud builder + Mission Control parity
- [ ] MAC-9 Commit-boundary sync + guided merge
- [ ] MAC-10 Local→cloud promotion

## M5 — SaaS hardening (Weeks 20–26)

- [ ] OPS-4 Stripe platform billing
- [ ] OPS-5 Top-ups + trial
- [ ] OPS-6 PostHog analytics + feature flags + dashboards
- [ ] OPS-7 Notification service
- [ ] OPS-8 OTel → Grafana Cloud across services (+ Faro)
- [ ] OPS-9 SLO dashboards + k6 at 10× + capacity model
- [ ] OPS-10 Managed-app observability templates
- [ ] OPS-11 Incident → Fix run closed loop
- [ ] OPS-12 Security suites complete (isolation/redaction/abuse)
- [ ] OPS-13 Injection evals + policy scans blocking
- [ ] OPS-14 Retention archival + rehydration
- [ ] OPS-15 Backup/DR runbooks + drills
- [ ] OPS-16 SOC 2 Type I readiness pack
- [ ] OPS-17 Support/admin console
- [ ] OPS-18 Incident response + status page
- [ ] CP-17 Retention & deletion pipeline
- [ ] CP-18 Export APIs
- [ ] WEB-16 Usage/billing/audit UI + a11y gate + activation funnel
- [ ] MAC-11 Notifications + auto-update
- [ ] MAC-12 Dyad project migration

## M6 — Private beta validation (Weeks 26–30)

- [ ] V-1 Build the 10-app benchmark suite (PRD §40.2) from VF fixtures
- [ ] V-2 Run repeat-change protocol ×5 per app (PRD §40.3), record metrics
- [ ] V-3 Verify all 22 P0 exit criteria (PRD §39) with evidence links
- [ ] V-4 Measure §37.6 thresholds; go/no-go review; log invalidation signals (PRD §40.4)
- [ ] V-5 Beta onboarding: 3–5 agencies, support rotation, feedback loop into tasks/

## Review

_(Populated at execution time: outcomes, deviations, lessons per the user's workflow. See each plan's `## Execution log`.)_

## M0 gate check — findings (2026-08-04)

Gate verdict: **PASSED WITH EXCEPTIONS**. All six criteria met in substance and verified
against the running system (real server booted, 30 routes probed, isolation 46/46, git
cross-repo denial proven by a refused clone, license boundary clean across all history).
Blockers below must close before M0 is signed off.

- [x] GATE-1 Desktop workflow green (8f367fb: setup-node package-manager-cache defaults true regardless of `cache:`) — VERIFIED live, both jobs
- [x] GATE-2 Stytch gate now rejects placeholders and skips loudly; adapter classifies rejected/misconfigured/unreachable; integration test asserts a Stytch-issued request_id so it cannot pass unauthenticated (8f367fb)
- [x] GATE-3 osv triaged and dispositioned at the gate: vitest 2→3 landed (closes CVE-2026-47429, 9.8 Critical — note: the ID I first cited was wrong, the implementer corrected it). Result 58→57, **everything outside apps/desktop is now vulnerability-free; 100% of the remainder is the vendored tree → OPS-13 owns it**. Two deliberate non-actions: (a) electron 40.8.5 (worth 18 findings) STOPPED — it reproducibly fails the desktop preserve suite's PTY test, and CI's `retries: 2` would likely have masked it; landing it would have been the green-isn't-evidence trap. Needs real triage, not a retry. (b) vite 5→6 (8.2 High) cannot close from our manifests — apps/desktop pins vite ^5.4.17 directly and no patched 5.x exists; adding vite@^6 to our packages would close zero findings while looking like a fix. Both are OPS-13 scope.
- [x] GATE-4 dependabot scan permissions fixed (8f367fb; least-privilege pull-requests: read) — verify on the next dependabot PR
- [x] GATE-5 No control-api → git-service → Forgejo integration test (each half proven separately; M1/CP-9 needs the join)
- [ ] GATE-6 Desktop's own suites unwired from CI (363 vitest files, 123/125 Playwright specs never run)
- [ ] GATE-7 Dev Forgejo has 42 orphaned test repos despite afterAll cleanup claims

**Unverified by credential absence (stated plainly, not hidden):** Stytch against a real
IdP; macOS signing + notarization (steps skipped on every run — MAC-2's core claim has
never executed); Docker runtime preservation; Modal/Temporal/LocalStack (no test reads
MODAL_* at all).
