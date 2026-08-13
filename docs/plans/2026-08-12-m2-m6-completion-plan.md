# M2-M6 completion implementation plan

> Execute with subagent-driven development. The repository's two-review-round cap overrides
> the skill default. Each task is RED-GREEN, verified, reviewed, committed, and recorded before
> the next task begins.

**Goal:** Complete every remaining code-owned M2-M6 task through public APIs and produce
truthful final evidence for credential- and agency-owned gates.

**Architecture:** Follow ADR-0032. Service-owned capabilities stay behind control-api ports;
all clients use the regenerated SDK; durable workflow/deployment state drives every action.

**Tech stack:** TypeScript, Zod, Fastify, Temporal, Drizzle/PostgreSQL, Redis, Next.js,
Playwright, Electron, Vitest, pnpm/turbo.

### Task 1: AR-23 durable builder-control protocol

**Files:** `packages/planning-engine/src/schema.ts`, `packages/contracts/src/temporal-run.ts`,
`services/orchestrator-worker/src/workflows/*`, worker tests, Plan 04, tracker.

- RED: prove failed-task retry eligibility, optional-phase skip eligibility, stable replay,
  dependency safety, and skip rejection after any phase task starts.
- GREEN: add compatible optional metadata, keyed retry/skip signals, durable transitions, and
  structured events.
- Verify worker unit/Temporal suites, lint/typecheck/build, architecture; review twice max.
- Commit: `feat(orchestrator): durable retry and optional-phase controls`

### Task 2: CP-22 public builder controls and generic approvals

**Files:** contracts, control-api run/Mission Control routes and tenant ports, OpenAPI/SDK,
control/API-client tests, Plan 02, tracker.

- RED: public eligibility/reasons, keyed retry/skip, typed stale conflicts, and strict approval
  kind/id matching fail before implementation.
- GREEN: expose only server-computed actions; broaden the existing approval route through a
  discriminated union without weakening budget approval invariants.
- Verify contracts/control/API-client gates and SDK determinism; review twice max.
- Commit: `feat(control-api): public builder controls and typed approvals`

### Task 3: AR-24 interactive conversation-card workflow

**Files:** contracts event schemas, orchestrator interview/spec/plan/redirect workflows and
activities, tests, Plan 04, tracker.

- RED: question/spec/plan/approval cards and keyed responses do not round-trip or survive
  workflow replay.
- GREEN: emit typed versioned cards, wait on matching response ids, preserve old histories,
  and never infer decisions from assistant text.
- Verify contracts and actual Temporal tests; review twice max.
- Commit: `feat(orchestrator): typed interactive conversation cards`

### Task 4: CP-23 public card responses and artifact reads

**Files:** control-api message/spec/run routes and ports, OpenAPI/SDK, tests, Plan 02, tracker.

- RED: structured card responses, plan/spec reads, and tenant-safe artifact reads fail.
- GREEN: add keyed response operations and typed reads mapped to AR-24; preserve 404 tenant
  behavior and bounded artifact payloads.
- Verify control/API-client/contracts; review twice max.
- Commit: `feat(control-api): public conversation-card responses`

### Task 5: WS-16 workspace file and direct-edit boundary

**Files:** sandbox-service workspace routes/services, DB/ports if required, integration tests,
Plan 03, tracker.

- RED: list/read/path rejection/stale compare/direct-edit atomic commit cases fail.
- GREEN: service-authenticated list/read and compare-and-write+commit operation; exact commit
  subject `manual edit via web`; rollback partial writes.
- Verify sandbox unit/integration, path safety, lint/typecheck/build; review twice max.
- Commit: `feat(sandbox): attributed workspace file edits`

### Task 6: GIT-6 template registry source pipeline

**Files:** `config/templates.json`, config schema/tests, server registry loader, Plan 06,
tracker.

- RED: invalid/unapproved/duplicate registry sources, mutable source identities, unsafe demo
  URLs, and accidental public `repoRef` serialization fail.
- GREEN: checked-in approved registry with server-only repository refs and immutable release
  identity.
- Verify config and registry-loader tests; review twice max.
- Commit: `feat(templates): approved source registry`

### Task 7: GIT-5 commit comparison and approved template seeding

**Files:** git-service provider/routes/ports/tests, Plan 06, tracker.

- RED: bounded before/after patch and idempotent approved-template seed fail.
- GREEN: service-authenticated operations with repository scope, size limits, and stable
  operation keys; reject arbitrary source refs outside the registry boundary.
- Verify git-service unit/integration and architecture; review twice max.
- Commit: `feat(git-service): commit diff and template seeding`

### Task 8: VF-17 test and evidence read contract

**Files:** verification-engine evidence/test-run schemas and ports, artifact storage adapter,
tests, Plan 05, tracker.

- RED: run/case metadata, criterion linkage, descriptions, and bounded signed downloads fail.
- GREEN: typed service boundary retaining organization/run/task/artifact provenance.
- Verify verification and storage boundary suites; review twice max.
- Commit: `feat(verification): public evidence read model`

### Task 9: CP-24 public code, diff, log, test, and evidence bridge

**Files:** control-api workspace/mission-control routes and service clients, OpenAPI/SDK,
tests, Plan 02, tracker.

- RED: tenant/RBAC, list/read/edit, compare, test cases, evidence, and fix-run entry fail.
- GREEN: bridge WS-16/GIT-5/VF-17; direct edits are Owner/Builder-only, downloads bounded,
  internal credentials never returned.
- Verify contracts/control/API-client/integration; review twice max.
- Commit: `feat(control-api): public builder artifact surfaces`

### Task 10: CP-25 template APIs and template project creation

**Files:** control-api project/template routes and composition, contracts/OpenAPI/SDK, tests,
Plan 02, tracker.

- RED: registry list/detail, unknown slug, clone-before-create, and idempotent replay fail.
- GREEN: discriminated template source using a slug resolved server-side and GIT-5 seeding.
- Verify control/API-client/git integration; review twice max.
- Commit: `feat(control-api): public template remix contract`

### Task 11: WEB-9 Mission Control drawer

**Files:** Plan 08 task files plus shared reducer/components in `packages/ui`, web tests.

- RED: fixture aggregate/actions and optimistic reconciliation cases fail.
- GREEN: all eight tabs/actions, accessible announcements, compare links, and shared pure event
  reducer; consume only generated SDK operations.
- Verify web unit/E2E/a11y/lint/typecheck/build; review twice max.
- Commit: `feat(web): mission control drawer (views + actions)`

### Task 12: WEB-10 interview/spec/plan approval cards

**Files:** Plan 08 task files, shared card primitives if reused, web tests.

- RED: structured question submission, spec/plan decisions, and typed diff/approval rendering.
- GREEN: card union renderer and exact keyed SDK mutations; no prose parsing.
- Verify web unit/E2E/a11y; review twice max.
- Commit: `feat(web): interview + spec/plan approval cards`

### Task 13: WEB-11 code/log/test surfaces

**Files:** Plan 08 task files, web tests.

- RED: file read, edit commit, diff, structured logs, failed evidence, and Fix CTA.
- GREEN: SDK-backed CodeMirror/xterm/test/evidence surfaces with role guards.
- Verify web unit/E2E/a11y; review twice max.
- Commit: `feat(web): code/logs/tests surfaces`

### Task 14: WEB-17 template gallery and Remix

**Files:** Plan 08 task files and web tests.

- RED: registry/detail/demo/Remix-to-builder journey.
- GREEN: SDK registry, sandboxed demo iframe, device toolbar, seeded first message.
- Verify web unit/E2E/a11y; review twice max.
- Commit: `feat(web): template gallery + detail with demo preview and remix`

### Task 15: CP-26 settings and organization directory APIs

**Files:** control-api org/integration/project routes and tenant views, DB where required,
OpenAPI/SDK/tests, Plan 02, tracker.

- RED: member/invite directory, integration status/disconnect including Vercel, and deletion
  timeline cases fail.
- GREEN: authoritative tenant read models and keyed mutations; secrets remain write-only.
- Verify DB/control/API-client; review twice max.
- Commit: `feat(control-api): settings and member directory APIs`

### Task 16: INT-10 public GitHub sync policy and operations

**Files:** control-api GitHub integration composition/routes, DB schema if required, SDK/tests,
Plan 06, tracker.

- RED: policy/state/manual-sync/export, stale base, RBAC, and replay cases fail.
- GREEN: public operations over existing sync/export engines; never last-writer-wins.
- Verify control/git integration and SDK; review twice max.
- Commit: `feat(integrations): public GitHub sync controls`

### Task 17: DEP-13 release list/history projection

**Files:** release-service/control-api release views, DB schema/repos, SDK/tests, Plan 07,
tracker.

- RED: project list, active-production marker, support badge, history, rollback targets, and
  artifact links fail.
- GREEN: durable tenant projection with cursor pagination.
- Verify DB/release/control/API-client; review twice max.
- Commit: `feat(releases): public release history projection`

### Task 18: WEB-12 settings suite

**Files:** Plan 08 task files and web tests.

- RED/GREEN: secrets, integrations, members, GitHub sync, archive/delete, RBAC, and network
  assertion that secret values never return.
- Verify web unit/E2E/a11y; review twice max.
- Commit: `feat(web): project settings suite`

### Task 19: WEB-13 releases and evidence viewer

**Files:** Plan 08 task files and web tests.

- RED/GREEN: list/detail/all criteria, failed prominence, deploy, and repair fork.
- Verify web unit/E2E/a11y; review twice max.
- Commit: `feat(web): release history + evidence report viewer`

### Task 20: DEP-14 public deployment progress contract

**Files:** release DB schema/repos, release-service lifecycle/routes, control bridge, SDK/tests,
Plan 07, tracker.

- RED: classification/confirmation, readiness actions, eight-stage replay/SSE, safe retry,
  terminal success, and domains fail.
- GREEN: deployment-scoped append-only event stream and keyed mutations.
- Verify DB/release/control/API-client and lifecycle integration; review twice max.
- Commit: `feat(releases): public deployment progress and actions`

### Task 21: WEB-14 deploy flow

**Files:** Plan 08 task files and web tests.

- RED/GREEN: blocked/warning/ready, replace disposition, stage failure/retry, and success data.
- Verify web E2E/a11y including connected fixture lifecycle; review twice max.
- Commit: `feat(web): readiness → confirm → staged deploy → success flow`

### Task 22: DEP-15 production health and rollback projection

**Files:** release DB schema/repos, release-service health/synthetics/annotations/rollback,
control bridge/SDK/tests, Plan 07, tracker.

- RED: health history, synthetic history, annotations, monitoring links, healthy targets, and
  pre-mutation database compatibility fail.
- GREEN: append-only histories and tenant-scoped read/preview operations.
- Verify DB/release/control/API-client; review twice max.
- Commit: `feat(releases): production health and rollback preview`

### Task 23: WEB-15 production health and rollback UI

**Files:** Plan 08 task files and web tests.

- RED/GREEN: health/synthetic failures/Fix CTA and all rollback compatibility states.
- Verify web E2E/a11y; review twice max.
- Commit: `feat(web): production health + guarded rollback UI`

### Task 24: WEB-16 usage/billing/audit + connected activation completion

**Files:** Plan 08 WEB-16 task pages and cross-app accessibility files, existing WEB-16
E2E/activation files, and required control/API read-model tests; Plan 08 and tracker.

- RED: authoritative credit balance/burn-down/budget alerts, Stripe-synced plan/seats/portal and
  top-up, Owner-only filterable audit, keyboard prompt→preview→successful deploy, exact
  activation sequence, and axe-clean home/dashboard/builder/deploy fail wherever the phased
  implementation is incomplete.
- GREEN: verify and minimally repair all WEB-16 binding surfaces, then connect the landed
  public deploy flow without broadening analytics semantics.
- Verify usage/billing/audit unit and E2E, real PostgreSQL read models, exact web cold
  build→E2E, axe, keyboard, and analytics; review twice max.
- Commit: `feat(web): usage/billing/audit + accessibility gate + activation funnel`

### Task 25: WS-17 immutable public forge image mirror

**Files:** provider-neutral image recipe, GHCR workflow, image lock/config/tests, Plan 03,
tracker.

- RED: lock validation rejects missing/mutable OCI reference.
- GREEN: publish workflow and digest-pinned public mirror metadata derived from the existing
  recipe. The task remains unmarked if the real digest cannot be observed.
- Verify structural image tests and one final registry pull gate; review twice max.
- Commit: `build(images): publish immutable forge node mirror`

### Task 26: MAC-7 Docker runtime

**Files:** Plan 09 task file, runtime selector/diagnostics, desktop tests.

- RED/GREEN: WorkspaceRuntime conformance over locked image and unavailable-Docker hiding.
- Verify desktop conformance/lint/typecheck/build; review twice max.
- Commit: `feat(desktop): docker runtime mode`

### Task 27: MAC-8 cloud builder parity

**Files:** Plan 09 task files, `packages/ui`, desktop tests.

- RED/GREEN: identical shared reducer snapshots, authenticated preview, menu controls, badge.
- Verify web/desktop parity and Electron smoke; review twice max.
- Commit: `feat(desktop): cloud builder + mission control parity`

### Task 28: GIT-7 public repository credential lease

**Files:** git-service token boundary, control-api project routes/client, SDK/tests, Plan 06,
tracker.

- RED: tenant/RBAC, 300-second maximum, audit/no-store, scope, expiry, and no persisted token.
- GREEN: session-auth public lease wrapping service-only mint.
- Verify git/control/API-client security and integration; review twice max.
- Commit: `feat(git): public short-lived repository lease`

### Task 29: MAC-9 commit-boundary sync

**Files:** Plan 09 task files and desktop tests.

- RED/GREEN: dirty choices, fast-forward, divergence, explicit merge commit, token hygiene.
- Verify desktop unit/real local-Git integration; review twice max.
- Commit: `feat(desktop): commit-boundary sync with guided merge`

### Task 30: MAC-10 local-to-cloud promotion

**Files:** Plan 09 task file and desktop tests.

- RED/GREEN: fingerprint replay and resume after every state-machine step.
- Verify desktop/control/git integration; review twice max.
- Commit: `feat(desktop): local→cloud promotion wizard`

### Task 31: CP-27 public desktop notification projection

**Files:** control-api notification routes/store, DB if required, SDK/tests, Plan 02, tracker.

- RED/GREEN: authenticated cursor replay, per-type preferences, tenant/user isolation, bounded
  reconnect, and no payload secrets.
- Verify DB/control/API-client; review twice max.
- Commit: `feat(control-api): desktop notification delivery API`

### Task 32: MAC-11 notifications and signed updates

**Files:** Plan 09 task files, update-feed tooling/config/tests.

- RED/GREEN: typed notifications/preferences, stable/beta signed feed, notes, nonfatal failure.
- Verify desktop tests/build and signature rejection; review twice max.
- Commit: `feat(desktop): approval/run notifications + auto-update channel`

### Task 33: MAC-12 Dyad migration

**Files:** Plan 09 task file and desktop tests.

- RED/GREEN: safe detect/copy/adopt/git/archive/link/promotion, collisions, replay.
- Verify desktop unit and fixture filesystem integration; review twice max.
- Commit: `feat(desktop): dyad project migration path`

### Task 34: OPS-8 final Grafana acceptance

**Files:** Plan 10 and tracker unless a code defect is exposed.

- Run the single real OTLP acceptance with a non-placeholder token; fix only demonstrated code
  defects through RED-GREEN. Keep blocked if the credential is absent or rejected.
- Commit only when accepted: `chore(ops): accept Grafana Cloud telemetry`

### Task 35: Milestone exit repairs

**Files:** owning plan/tracker plus only code/tests demonstrated by M2-M5 exit failures.

- Run each master-plan exit checklist in order; create explicit fix tasks for product defects.
- Never reclassify credential/provider failures as green.

### Task 36: V-2 repeat-change protocol

**Files:** `validation/benchmarks/*`, evidence/results, master plan, tracker.

- Execute the materialized 50 changes against the completed product; record immutable inputs,
  outputs, timings, costs, verifier/repair results, and hashes.
- Commit: `test(validation): record repeat-change benchmark`

### Task 37: V-3 P0 exit evidence

**Files:** `validation/exit-criteria/*`, master plan, tracker.

- First repair stale DEP-12 and E10/E12 evidence, then run all E1-E22 commands and bind exact
  outputs. Check only when every criterion is verified.
- Commit: `test(validation): verify P0 exit criteria`

### Task 38: V-5 beta operations acceptance

**Files:** `validation/beta/*`, real approved evidence, master plan, tracker.

- Run readiness with 3-5 real agencies, current two-person support rotation, and task-linked
  feedback. Keep blocked if external participation is absent.
- Commit only when accepted: `docs(validation): record private beta cohort readiness`

### Task 39: V-4 go/no-go

**Files:** `validation/go-no-go/*`, master plan, tracker.

- Populate all eight measurements from V-2, both required evidence artifacts, agency review,
  and all invalidation decisions; run fail-closed evaluator and record the decision.
- Commit only when complete: `docs(validation): record P0 go-no-go decision`

### Task 40: V-2 evidence-contract hardening

**Files:** `validation/benchmarks/*`, this completion plan, master-plan execution log.

- RED: reject correct manifest labels paired with noncanonical prompts, missing or digest-mismatched
  repository evidence, and a passed artifact without one verified rollback per benchmark app.
- GREEN: bind each execution input to its exact manifest feature change, resolve every evidence
  reference inside the repository and verify its bytes, and require ten hash-verified rollbacks.
- Keep V-2 blocked and do not create a live result artifact.
- Commit: `test(validation): harden repeat-change evidence contract`

### Task 41: GATE-6 desktop suites in CI

**Files:** `.github/workflows/desktop.yml`, focused workflow tests, master plan, tracker.

- RED: prove pull requests cannot merge without the desktop Vitest corpus and every Playwright
  project/spec being selected by CI.
- GREEN: restore routine pull-request execution with bounded unit and sharded full-E2E jobs while
  retaining the signed release packaging path and failure artifacts.
- Commit: `ci(desktop): run full test suites on pull requests`

### Task 42: GATE-7 Forgejo test-repository lifecycle

**Files:** git-service integration fixtures/cleanup tests, master plan, tracker.

- RED: reproduce repositories left behind after fixture failure or teardown.
- GREEN: make cleanup fail closed and idempotent, verify a clean post-suite inventory, then remove
  only structurally identified dev test repositories after an exact inventory.
- Commit: `test(git-service): prevent orphaned Forgejo repositories`

## Execution log

- 2026-08-12 Task 41 done — Re-enabled pull-request desktop unit and complete Playwright coverage with four bounded no-retry shards; release packaging stays signed/tag-or-manual and failure reports upload.
- 2026-08-12 Task 40 done — Bound every repeat-change input and evidence reference to the fixed corpus, and required ten verified rollbacks; V-2 remains blocked with no live result artifact.
