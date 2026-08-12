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

### Cross-plan gate repairs
- [x] M1-PLAN-1 Rebind WS-12 preview access to zapp-owned authenticated ingress (ADR-0023)
- [x] M1-PLAN-2 Reorder durable model completion + authoritative usage accounting (ADR-0025)
- [x] M1-GATE-1 Deterministic cold-state local validation (Turbo ordering + test isolation; CI billing-blocked)
- [x] M1-GATE-2 Bound real-process test fixtures under full cold-gate contention (CI billing-blocked)
- [x] M1-GATE-3 Bound workspace-runtime real-Git fixture under local Forgejo cold-gate load (CI billing-blocked)
- [x] M1-GATE-4 Remove disposable upstream response from the allowed-model web fixture (CI billing-blocked)
- [x] M1-GATE-5 Construct preview redaction credential fixtures at runtime (pre-push guard; CI billing-blocked)
- [x] M1-GATE-6 Let bounded real-Git child deadlines govern the aggregate fixture (CI billing-blocked)
- [x] M1-GATE-7 Serialize local integration packages that reset the shared database
- [x] M1-GATE-8 Arm the live Git backup proof in local verification
- [x] M1-GATE-9 Await cancelled SSE replay before connection reuse
- [x] M1-GATE-10 Settle SSE Accept-probe streams before connection reuse
- [x] M1-GATE-11 Bound the real PostgreSQL 100-way sequence allocation proof
- [x] M1-GATE-12 Bound Plan 03 clean-gate cleanup probes
- [x] M1-GATE-13 Await server-side SSE Accept-probe cleanup before connection reuse
- [x] M1-GATE-14 Restore awaited SSE CancelRequest barrier before connection reuse
- [x] M1-GATE-15 Bound the real PostgreSQL append-only reset proof
- [x] M1-GATE-16 Track only committed sources and bound lifecycle cleanup under full cold-gate contention

### Plan 02 — Control plane (part 2)
- [x] CP-9 Run + workspace routes
- [x] CP-10 Specification routes
- [x] CP-11 Release/integration route shells + RBAC
- [x] CP-12 Audit reads + org settings
- [x] CP-13 Sequenced event ingest
- [x] CP-14 LISTEN/NOTIFY → Redis fanout
- [x] CP-15 Resumable SSE stream
- [x] CP-16 OpenAPI + generated SDK
- [x] CP-20 Conversation continuation + attachments API (ADR-0027)
### Plan 03 — Workspace/sandbox core
- [x] WS-1 workspace-runtime interface + path safety
- [x] WS-1-FIX-1 Await Linux descendant reaping in cold CI
- [x] WS-2 Modal images (forge-node-base, forge-web-test)
- [x] WS-3 workspace-agent daemon
- [x] WS-4 Modal provider create/exec/terminate/attach
- [x] WS-5 Scoped-token git clone/push
- [x] WS-6-FIX-1 Locked-image health compatibility in Modal smoke
- [x] WS-6 Lifecycle state machine + reaper + reconciler
- [x] WS-7 Checkpoints + snapshot-free restore
- [x] WS-8 Resource profiles + cost recorder
- [x] WS-9 Cache volumes + branch locks
- [x] WS-10 Preview proxy + capture client
- [x] WS-11 Secret injection + network profiles + redaction
- [x] WS-12 Preview tokens + share records
### Plan 06
- [x] GIT-4 Nightly bundle backups + restore
### Plan 04 — Agent runtime core
- [x] AR-1 model-gateway streaming API
- [x] AR-2 Routing/retry/fallback
- [x] AR-3A Stable completion identity + exhaustive terminal envelope
- [x] OPS-1A Durable completion journal + authoritative usage reservation
- [x] AR-3B Usage telemetry + budget cutoff + Anthropic cache proof
- [x] AR-3B-FIX-1 Durable abort settlement + renewal retry classification
- [x] AR-4 agent-tools registry (PRD §16.1 complete)
- [x] AR-5 agent-policies + injection defense + role prompts
- [x] AR-6 Session loop
- [x] AR-7 Context builder + compaction
- [x] AR-8 M1 durable chat run on Temporal
- [x] AR-22 Conversation event emission (ADR-0027)
### Plan 08 — Web core
- [x] WEB-1 Next scaffold + session + org context
- [x] WEB-2 packages/ui design system (Next+Vite)
- [x] WEB-3 Home screen (Emergent-modeled)
- [x] CP-21 Project dashboard summary read model (M1 pull-forward)
- [x] INT-1 GitHub App installation, discovery + verified webhooks (M1 pull-forward)
- [x] INT-2 Durable GitHub import + internal mirror (M1 pull-forward)
- [x] WEB-4 Dashboard + org switcher + import entry
- [x] WEB-5 Builder two-pane shell
- [x] WEB-6 Event-sourced conversation thread

## M2 — Agentic core + Mission Control (Weeks 8–14)

- [x] M2-M6-PLAN-2 Public product completion contracts + dependency graph (ADR-0032)
- [ ] AR-23 Durable retry/skip builder-control protocol
- [ ] CP-22 Public builder controls + generic approval contract
- [ ] AR-24 Typed interactive conversation-card workflow
- [ ] CP-23 Public card responses + artifact reads
- [x] WS-16 Workspace file/list/read/direct-edit-commit boundary
- [ ] GIT-6 Approved template registry source pipeline
- [ ] GIT-5 Commit comparison + approved template seeding
- [ ] VF-17 Test/evidence read contract
- [ ] CP-24 Public code/diff/log/test/evidence bridge
- [ ] CP-25 Public template APIs + template project creation

- [x] AR-9 Worker/queues/idempotency hardening
- [x] AR-10 Pause/resume/cancel/redirect signals
- [x] AR-10-FIX-1 Bound control acknowledgements + truthful approval status query
- [x] AR-10-FIX-2 Receiver-enforced atomic control acknowledgement deadline
- [x] AR-11 planning-engine schema + scheduler
- [x] AR-12 Isolated task workflows + merge/conflict tasks
- [x] AR-13 Mission Control read model
- [x] AR-14 Run budgets + approval loop
- [x] AR-15 Ask + Prototype modes
- [x] VF-1 Adapter framework + generic node
- [x] VF-2 Framework adapters (P0 set)
- [x] VF-3 Capability scan pipeline
- [x] VF-4 Gate registry + §24.2 policy matrix
- [x] VF-5 Deterministic gates (build/type/lint/unit/secret/dev-server)
- [x] WS-13 Dev-server supervisor + logs
- [x] WS-13-FIX-1 Durable preview replay and monitor recovery
- [x] WS-13-FIX-2 Preview monitor lease handoff and terminal closure
- [x] WS-13-FIX-3 Transactionally fenced terminal event delivery
- [x] WS-13-FIX-4 Atomic terminal batch rollback
- [x] WS-13-FIX-5 Bounded immutable-image acceptance
- [x] WS-13-FIX-6 Collision-safe immutable-image acceptance
- [x] WS-13-FIX-7 Abort-settled Modal execution streams
- [x] WS-13-FIX-8 Cancellation-settled SSE replay gate
- [x] WS-13-FIX-9 Scheduler-independent replay framing gate
- [x] WS-14 Nightly Modal E2E suite
- [x] WS-14-FIX-1 Explicit cache environment for agent exec
- [x] WS-14-FIX-2 Standalone fixture install inside sparse checkout
- [x] WS-14-FIX-3 Strict restore volume input
- [x] WS-14-FIX-4 Deterministic mounted-cache proof
- [x] WS-14-FIX-5 Contention-safe explicit-kill gate deadline
- [x] WS-15 Runaway-compute governor
- [x] WS-15-FIX-1 Fenced sweep and shutdown closure
- [x] WS-15-FIX-2 Preview-proxy smoke readiness
- [x] M2-CI-PREVIEW-CDP Deterministic aborted CDP serialization gate
- [x] CP-21 Public builder preview bridge (ADR-0028)
- [x] CP-21-FIX-1 Durable screenshot operation reservation
- [x] WEB-7 Preview panel + states + capture drawer
- [x] WEB-7-FIX-1 Bounded preview lifecycle closure
- [x] WEB-7-FIX-2 Structured preview Fix evidence
- [x] WEB-8 Element selection attachments
- [x] WEB-COLD-FIX-1 Isolate E2E Next build output
- [x] WEB-COLD-FIX-2 Align the repository test contract with isolated E2E startup
- [ ] WEB-9 Mission Control drawer
- [ ] WEB-10 Interview/spec/plan approval cards
- [ ] WEB-11 Code/Logs/Tests surfaces
- [ ] WEB-17 Template gallery + detail with demo preview & Remix
- [x] OPS-1B Flexprice bootstrap + usage summaries + complete metering acceptance
- [x] OPS-1B-FIX-1 Application-role correction serialization
- [x] OPS-2 Metering coverage + three-way reconciliation
- [x] OPS-2-FIX-1 Durable metering and reconciliation closure
- [x] OPS-3 Plan quotas + budget enforcement
- [x] OPS-3-FIX-1 Production enforcement closure
- [x] OPS-3-FIX-2 Credit-boundary and legacy-approval rollout closure
- [x] OPS-3-FIX-3 Build scheduling and legacy activity boundary closure
- [x] MAC-4 Platform auth + Keychain
- [x] MAC-4-FIX-1 Close auth revocation and startup bounds
- [x] MAC-5 Unified local+cloud dashboard
- [x] MAC-5-FIX-1 Preserve cloud creation retry identity
- [x] MAC-5.5 Triage 51 Pro-dependent integration test files + fix upstream monaco replaceEditorContent helper (aria-hidden ime-text-area breaks edit_code + editor_commit_menu) (spec source: 13 local_agent_* files; before/with MAC-6)
- [x] MAC-6A Local runtime + resumable-session foundation
- [x] MAC-6 Local WorkspaceRuntime + local sessions
- [x] MAC-6-FIX-1 Structural local-agent containment + terminal recovery
- [x] MAC-6-FIX-2 Durable local turn results + mutation recovery
- [x] MAC-6-FIX-3 Single-writer local operation finalization

## M3 — Verification-first + Autonomous (Weeks 12–18)

- [ ] CP-26 Settings + organization directory APIs
- [ ] INT-10 Public GitHub sync policy/state/manual-sync/export
- [ ] DEP-13 Release list/history/active-production projection

- [x] VF-6 Preview health + browser smoke gates
- [x] VF-7 Playwright runner + evidence artifacts
- [x] VF-8 Smoke + acceptance test generation
- [x] VF-9 Criteria traceability
- [x] VF-10 Verifier decision engine (rejection authority)
- [x] VF-11 Browser agent (exploratory)
- [x] VF-12 Accessibility gate
- [x] VF-13 Classified repair loop (hard budgets)
- [x] VF-13-FIX-1 Bound the real-Git repair exhaustion integration timeout
- [x] VF-14 Anti-slop detectors
- [x] VF-15 Evidence manifest + report renderer
- [x] VF-16 Dependency + migration gates
- [x] AR-16 specification-engine (interview + spec)
- [x] AR-17 Autonomous mode workflow
- [x] AR-18 Build mode
- [x] AR-19 Fix mode (reproduce-first)
- [x] AR-19-FIX-1 Serialize Temporal Fix/Autonomous acceptance
- [x] AR-20 Redirect + plan diff
- [x] AR-20-FIX-1 Serialize redirect Temporal acceptance
- [x] AR-21 Forking (project/branch/conversation/run)
- [ ] WEB-12 Settings suite (secrets/integrations/members/GitHub)
- [ ] WEB-13 Releases + evidence viewer
- [x] OPS-12 Security suites (start; complete M5)
- [x] OPS-13 Injection evals + Semgrep gates (start; complete M5)

## M4 — Integrations & deployment (Weeks 16–22)

- [ ] DEP-14 Public deployment progress/actions/domains contract
- [ ] DEP-15 Production health + rollback-preview projection
- [ ] WS-17 Immutable public forge-node-base OCI mirror
- [ ] GIT-7 Public short-lived repository credential lease

- [x] INT-3 Sync engine (stale-base, conflicts)
- [x] INT-4 GitHub export
- [x] INT-5 Supabase connect/provision/schema/types
- [x] INT-5-FIX-1 Make GitHub import retry integration clock deterministic
- [x] INT-6 Supabase migrations + RLS gen/tests
- [x] INT-7 Neon branch workflows
- [x] INT-8 Generated-app Stripe adapter
- [x] INT-9 Stripe E2E integration tests
- [x] DEP-1 Release records + ReleasePort
- [x] DEP-2 Three-state readiness check
- [x] DEP-3 Deployment type classification
- [x] DEP-4 Fly.io container adapter
- [x] DEP-5 Vercel adapter
- [x] DEP-6 Staged deploy workflow (safe go-live)
- [x] DEP-7 Production health + prod-safe smoke
- [x] DEP-8 Success contract + release annotations
- [x] DEP-9 Rollback with DB-compatibility gating
- [x] DEP-10 Custom domains + SSL
- [x] DEP-11 Synthetic checks
- [x] DEP-12a Authenticated release lifecycle transport + public SDK
- [x] DEP-12b Production adapter composition + real synthetic/E2E journey
- [x] DEP-12 E2E release lifecycle + fork-to-repair (umbrella completion)
- [x] WEB-16-FIX-1 Keep the cold web test command aligned with activation coverage
- [ ] WEB-14 Deploy flow UI (readiness→confirm→timeline→success)
- [ ] WEB-15 Production health + guarded rollback UI
- [ ] MAC-7 Docker runtime mode
- [ ] MAC-8 Cloud builder + Mission Control parity
- [ ] MAC-9 Commit-boundary sync + guided merge
- [ ] MAC-10 Local→cloud promotion

## M5 — SaaS hardening (Weeks 20–26)

- [ ] CP-27 Public desktop notification projection

- [x] OPS-4 Stripe platform billing
- [x] OPS-4-FIX-1 Stripe fixture secret-scan repair
- [x] OPS-5 Top-ups + trial
- [x] OPS-6 PostHog analytics + feature flags + dashboards
- [x] OPS-7 Notification service
- [ ] OPS-8 OTel → Grafana Cloud across services (+ Faro)
- [x] OPS-10 Managed-app observability templates
- [x] OPS-11 Incident → Fix run closed loop
- [x] OPS-12 Security suites complete (isolation/redaction/abuse)
- [x] OPS-13 Injection evals + policy scans blocking
- [x] OPS-14 Retention archival + rehydration
- [x] OPS-17 Support/admin console
- [x] CP-17 Retention & deletion pipeline
- [x] CP-18 Export APIs
- [ ] WEB-16 Usage/billing/audit UI + a11y gate + activation funnel
- [ ] MAC-11 Notifications + auto-update
- [ ] MAC-12 Dyad project migration

## M6 — Private beta validation (Weeks 26–30)

- [x] V-1 Build the 10-app benchmark suite (PRD §40.2) from VF fixtures
- [ ] V-2 Run repeat-change protocol ×5 per app (PRD §40.3), record metrics
- [ ] V-3 Verify all 22 P0 exit criteria (PRD §39) with evidence links
- [ ] V-4 Measure §37.6 thresholds; go/no-go review; log invalidation signals (PRD §40.4)
- [ ] V-5 Beta onboarding: 3–5 agencies, support rotation, feedback loop into tasks/

## Deferred post-P0 (ADR-0022) — return before public beta

- OPS-9 SLO dashboards + k6 at 10× + capacity model
- OPS-15 Backup/DR runbooks + drills
- OPS-16 SOC 2 Type I readiness pack
- OPS-18 Incident response + status page

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
