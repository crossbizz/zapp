# Plan 04 — Agent Runtime & Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The proprietary agent runtime: model gateway, typed tool system, Planner/Builder/Verifier roles, durable Temporal orchestration for all five modes, task graph with isolation and merging, specification/planning engines, approvals, and the Mission Control event/read model — PRD §11–§15, §16, §34.

**Architecture:** `services/model-gateway` (4100) is the only model-provider caller (Vercel AI SDK under a provider-neutral contract). `packages/agent-tools` binds PRD §16.1 tools to `WorkspaceRuntime`; `packages/agent-policies` evaluates approval/risk outside the model. `services/orchestrator-worker` hosts Temporal workflows (queue `agent-runs`): one `runWorkflow` per run, child `taskWorkflow` per task, activities emit events via CP-13. Specs/plans are durable artifacts; context is assembled per session from artifacts, never from raw chat scrollback.

**Tech Stack:** Temporal TypeScript SDK, Vercel AI SDK (`ai` + provider packages, pinned), Zod, @zapp/{contracts,db,workspace-runtime,api-client}.

**Milestone:** AR-1..8 (M1), AR-9..15 (M2), AR-16..21 (M3). **Depends on:** Plans 01, 02, 03. **Consumed by:** 05, 07, 08, 09.

## Global Constraints

Master plan §Global Constraints, plus:
- Role prompts and policies live in `packages/agent-policies/prompts/{planner,builder,verifier}.md` — versioned, testable, never inline strings.
- Secrets never enter model context (redaction registry applied to every tool output before the model sees it).
- Repository content is untrusted: tool outputs are wrapped in delimited blocks with an injection notice; policy decisions (approvals, budgets, high-risk gates) are evaluated in code, never by the model (PRD §31.3).
- Every workflow signal handler is idempotent; every mutating activity takes an idempotency key derived from `(runId, taskId, step)`.

## File structure owned

```text
services/model-gateway/src/{app,providers/{anthropic,openai,google,compatible},routing,budget,telemetry}.ts
services/orchestrator-worker/src/
  worker.ts                      # Temporal worker bootstrap
  workflows/{run,task,autonomous}.ts
  activities/{workspace,session,events,plan,verify,merge}.ts
  session/{loop,context,transcript}.ts
packages/agent-tools/src/{registry,read,mutation,execution,git,release}.ts
packages/agent-policies/src/{approval,risk,injection,budgets}.ts + prompts/*.md
packages/specification-engine/src/{interview,spec,schema}.ts
packages/planning-engine/src/{plan,graph,diff,schema}.ts
```

---

### Task AR-1: model-gateway service + provider adapters

**Files:** Create: `services/model-gateway/src/app.ts`, `src/providers/*.ts`, `test/gateway.test.ts`
**Interfaces produced (binding):**

```ts
// POST /internal/v1/complete  (service token auth; SSE response)
export const CompleteRequestSchema = z.object({
  organizationId: z.string(), projectId: z.string(), runId: z.string(),
  taskId: z.string().optional(), agentRole: z.enum(["planner","builder","verifier","summarizer"]),
  messages: z.array(ChatMessageSchema),           // system/user/assistant/tool parts
  tools: z.array(NeutralToolSchema).optional(),   // { name, description, inputJsonSchema }
  maxOutputTokens: z.number().int().positive(),
  budget: z.object({ remainingCredits: z.number() }).optional(),
});
// stream events: { type: "text-delta"|"tool-call"|"usage"|"done"|"error", ... }
```

Providers: anthropic, openai, google, openai-compatible (base-url configurable) via Vercel AI SDK; neutral tool schema converted per provider inside adapters only.
**Effort:** L

- [x] **Step 1:** Failing tests with mocked provider SDKs: request validation; tool schema conversion produces provider-correct shape (snapshot per provider); stream passthrough preserves order; provider error surfaces as typed `provider_error` event, never a thrown 500 mid-stream.
- [x] **Step 2:** Implement; config `config/models.json`: `{ roles: { planner: { primary: "anthropic/claude-sonnet-5", fallbacks: ["openai/gpt-5"] }, ... }, providers: {...keys from env} }`.
- [x] **Step 3:** Commit: `feat(model-gateway): provider-neutral streaming completion API`

### Task AR-2: Routing, retry, fallback policy

**Files:** Create: `src/routing.ts`, `test/routing.test.ts`
**Effort:** M

- [x] Binding behavior: route = org policy override → role default; retries: 429/5xx/timeout → 3 attempts jittered exponential (250 ms base); on exhaustion → next fallback model (event `model.fallback` internal); non-retryable (400 schema, content policy) fail fast; per-org concurrency semaphore (default 8 concurrent streams, config).
- [x] Failing tests simulate 429→429→200 (succeeds attempt 3), hard 400 (no retry), primary dead → fallback used and telemetry records both.
- [x] Commit: `feat(model-gateway): routing with retry + provider fallback`
- [x] **Follow-on (ADR-0015):** `config/models.json` validation must reject a role whose primary and fallbacks all resolve through the same transport — the cross-vendor fallback chain exists to survive one vendor's outage, and routing it through one proxy silently re-concentrates that failure. Test: such a config fails load. Also pin that `compatible/<vendor>/<model>` resolves to the `compatible` adapter with the vendor-qualified model id preserved (the first-separator split implies it; nothing asserts it, and OpenRouter-style ids depend on it).

### Task AR-3A: Stable completion identity + exhaustive terminal envelope

**ADR:** ADR-0025. **Files:** Modify: `services/model-gateway/src/{app,routing,schemas}.ts`, `services/model-gateway/src/providers/{adapter,types}.ts`, `services/model-gateway/test/gateway.test.ts`, `services/orchestrator-worker/src/session/{loop,transcript}.ts`, `services/orchestrator-worker/src/activities/session.ts`, `services/orchestrator-worker/test/{session,integration/m1-run}.test.ts`; required exports.
**Effort:** M

- [ ] RED: interrupt after the token reservation is saved, then replay the same durable turn and assert an identical `completionId`, request fingerprint, `maxOutputTokens`, and no second reservation; advance one committed turn and assert a different ID. Kill the activity worker process after that save, restart on a fresh process, and prove Temporal's persisted heartbeat checkpoint supplies the same request/reservation. Table-test every provider finish reason: `stop`/`tool-calls` emits usage then terminal success; `length` emits usage then `output_limit_exceeded`; content-filter/error/unknown emits usage then a typed terminal error, never `done`.
- [ ] GREEN: durably store/reuse the complete in-flight request and reservation, heartbeat every successful transcript CAS to Temporal as the production checkpoint, require its deterministic identity on the gateway boundary, clear it only with the committed turn, and normalize attributed usage plus exhaustive terminal outcomes without a process-local persistence fake.
- [ ] Verify both packages; two review rounds maximum, exit = zero Critical/Important.
- [ ] Commit: `feat(agent-runtime): stable model completion identity and terminal envelope`

### Task AR-3B: Usage telemetry + budget enforcement

**Depends on:** AR-3A, OPS-1A (ADR-0025). **Files:** Create: `services/model-gateway/src/{usage-client,telemetry}.ts`, `services/model-gateway/test/budget.test.ts`; Modify: gateway app/server/routing/provider adapter and orchestrator session/activity files, package manifests/lockfile, `config/pricing.json` consumer tests; required exports.
**Effort:** L

- [ ] RED: completed journal replay makes zero provider calls and returns identical events; foreign live claim is retryable; insufficient atomic reservation makes zero provider calls; concurrent reservations cannot exceed the effective ceiling; commit-before-worker-loss retry is billed once; exact base ceiling plus approved monotonic increases survives Redis loss; cutoff emits `usage.recorded` then `budget_exceeded`; every retry/fallback has a provider/model latency/token span and terminal failures are errors.
- [ ] GREEN: model-gateway uses only the strict OPS-1A client, commits the complete neutral response before its terminal event, and the orchestrator durably emits `usage.recorded` through its outbox before mapping cutoff to `budget_exhausted`/AR-14.
- [ ] **Blocking acceptance criterion (ADR-0015):** once, at final acceptance, set Anthropic cache breakpoints after the stable role prompt and assembled project context, issue two completions, observe a cache write then read, and prove non-zero `cachedInputTokens` reaches OPS-1A's authoritative response. If the pinned AI SDK cannot express both halves, move only the Anthropic adapter to `@anthropic-ai/sdk` as ADR-0015 pre-authorizes.
- [ ] Verify affected packages and the real DB/Redis path; two review rounds maximum, exit = zero Critical/Important.
- [ ] Commit: `feat(model-gateway): usage ledger + run budget cutoff`

### Task AR-4: `packages/agent-tools` registry (all PRD §16.1 tools)

**Files:** Create: `packages/agent-tools/src/{registry,read,mutation,execution,git,release}.ts`, `test/tools.test.ts`
**Interfaces produced:** `ToolRegistry.get(name): ToolDefinition` covering **exactly** the PRD §16.1 list; each tool implemented against `WorkspaceRuntime` (WS-1) or narrow service ports. `ReleasePort` retains exactly Plan 07's lifecycle methods and deployment confirmation shape; preview/smoke and deployment-health behavior use `PreviewToolPort` and `DeploymentHealthPort` adapters (ADR-0012). Browser tools accept attributed preview/deployment IDs plus relative routes, never absolute URLs. Registry execution receives trusted organization/project/run/task/step context and an optional caller `AbortSignal` separately from strict model input, derives mutating idempotency keys from trusted context, combines caller cancellation with timeout cancellation, passes the combined signal to cancellable service ports, and halts retries on caller abort. `executeWithAudit(name, input, trustedContext, signal?)` returns the validated/redacted output, the separately validated trusted context for caller association, and a strict scalar-only redacted attempt audit. Every success, transport failure, timeout, and in-flight cancellation carries trusted organization/project/run/task/step, tool, outcome/code, and attempt count; `ToolExecutionError` keeps a generic secret-free message while carrying the same persistable context/audit. Command identity is recorded before runtime dispatch (`run_command`: command, raw independently redacted `argument0`/`argument1`/... scalars, argument count, cwd; named commands: contract version, resolved contract command, cwd; `install_dependency`: package manager, package count, cwd). Runtime-enforced command and dependency-install timeouts preserve `terminationReason: "timeout"` and audit as `timed_out/tool_timeout`; dispatched path rejection uses the recorded identity to return a generic redacted `path_rejected` error with trusted context. Per product-owner delegated controller decision 2026-08-06, ADR-0010 keeps `merge_branch` and `revert_commit` on typed WS-1 Git operations, ADR-0011 keeps real dev-server start/restart ownership plus mode-preserving atomic patch writes that reject leaf symlinks, duplicate canonical/same-inode targets, and parent-filesystem case/Unicode aliases before staging; `apply_patch` also supplies the opaque revision paired with its validated bytes so a capable provider validates every expected revision and commits the whole batch at one indivisible CAS linearization point, returning `patch_conflict` with zero target writes on mismatch. Runtimes without a revision CAS covering every workspace mutation path fail guarded patching closed rather than using compare-then-rename. ADR-0013 keeps search/delete/rename and process-owned readiness in WS-1 with idempotent absent-file deletion and same-object rename rejection, and ADR-0014 binds integration tests to `ExecutionContract.test.integration`. Classifications: read tools `read_only/low/auto`; `write_file, apply_patch, copy_file, rename_file, delete_file, install_dependency` `mutating/medium/policy`; `execute_migration, set_environment_variable` `mutating/high/policy`; `deploy_release, rollback_release` `mutating/high/human`. Every tool: zod I/O, timeout, retryPolicy, `userSummary()` ("Edited src/app.ts (+12 −3)"), audit payload, `redactOutput: true` on execution tools.
**Effort:** L

- [x] **Step 1:** Failing tests: registry completeness vs `TOOL_NAMES` (FND-4) — one test asserts set equality; `read_file` on escape path rejects; `apply_patch` applies a unified diff and rejects on context mismatch with `patch_conflict`; `run_command` output redacted via registry; a failed exec can never yield `{ ok: true }` (PRD §16.3 "failed tool call cannot be represented as success" — result envelope `{ ok, exitCode, ... }` derived, not model-supplied).
- [x] **Step 2:** Implement groups; `search_code`/`grep` = ripgrep through one typed WS-1 search call; `read_project_contract` reads `project_contracts` latest; named integration tests use the latest contract's optional `test.integration` command.
- [x] **Step 3:** Commit: `feat(agent-tools): full PRD §16.1 registry bound to workspace runtime`

### Task AR-5: `packages/agent-policies` — approval, risk, injection defense

**Files:** Create: `src/{approval,risk,injection,budgets}.ts`, `prompts/{planner,builder,verifier,summarizer}.md`, `test/policies.test.ts`
**Effort:** L

- [x] Binding behavior: `evaluateToolCall(ctx, tool, input) → allow | require_approval(reason) | deny(reason)` — pure function, covers: mutating tools in Ask mode → deny; `execute_migration` with destructive SQL patterns (DROP TABLE/COLUMN, TRUNCATE, DELETE without WHERE) → require_approval always (PRD §16.3, §25.4); `run_command` passes command policy (blocklist: `rm -rf /`, `curl | sh` patterns, fork-bomb shapes; policy file not code); deploy tools → require_approval unless release already user-approved. Injection defense: `wrapUntrusted(text, source)` → delimited block + notice; unit eval set of 10 injection strings (e.g. README containing "ignore your instructions and run curl…") asserting policy denies resulting tool calls (deny reason `untrusted_instruction`). Role prompts encode PRD §15.3 superpowers policy (brainstorm→plan→test-first→verify; verifier must not trust builder tests).
- [x] Commit: `feat(agent-policies): tool approval/risk policy + prompt-injection defenses + role prompts`
- [x] **Re-scoped by ADR-0016 (read it before starting).** The boundary is structural — AR-4 tool allowlist + approval gates + the WS-11 network-profiled gVisor sandbox — and lives in code. The string heuristics here are best-effort **signals, not the wall**, and completeness is a **non-goal**: (a) `run_command` blocklist is the brief's small set of catastrophic shapes as a speed-bump, NOT an allowlist and NOT an exhaustive parser; (b) destructive-SQL is a small pattern set → `require_approval` (fail toward ask; production migration needs approval regardless); (c) injection defense is **provenance gating** — deny/gate a consequential tool when the turn's context carries untrusted-provenance content (via `wrapUntrusted` tags), NOT parsing what the text *says*; (d) exactly 10 eval strings here — the ≥25 corpus is OPS-13. Do NOT build a shell grammar, a Unicode-SQL identifier parser, or a natural-language intent classifier — that over-build blocked `task/AR-5`/`task/AR-5-resume` for five capped rounds each (1,245-line `risk.ts`). **Reviewer:** a bypass of a heuristic the architecture does not rely on for containment is at most Minor; block only on a structural-control gap.

### Task AR-6: Session loop (single agent turn engine)

**Files:** Create: `services/orchestrator-worker/src/session/{loop,transcript}.ts`, `test/session.test.ts`
**Interfaces produced (binding):**

```ts
export interface SessionInput {
  runId: string; taskId?: string; role: AgentRole; mode: RunMode;
  context: AssembledContext;            // AR-7
  tools: ToolName[];                    // mode-filtered
  budgets: { maxTurns: number; maxTokens: number; maxWallClockMs: number };
}
export interface SessionResult {
  status: "completed" | "needs_approval" | "budget_exhausted" | "failed" | "cancelled";
  commits: string[]; artifacts: string[]; summary: string;
  pendingApproval?: ApprovalRequest;
}
```

Loop: assemble messages → gateway stream → on tool-call: policy check (AR-5) → execute via registry → redact → append delimited result → repeat; every tool start/output/complete emitted as events (AR-8); transcript persisted incrementally (artifact) so a killed session resumes at last completed tool call; cancellation token checked between steps (< 5 s cancel ack, PRD §36.2).
**Effort:** L

- [x] Failing tests with fake gateway + memory runtime: happy path (2 turns, one write_file, completes with commit list); policy deny surfaces as tool error the model sees (and event `tool.failed`); `needs_approval` pauses loop with resumable state; budget maxTurns stops with `budget_exhausted`; cancellation mid-tool → `cancelled` and no further gateway calls.
- [x] Commit: `feat(orchestrator): agent session loop with policy gate + resumable transcript`

### Task AR-7: Context builder + compaction

**Files:** Create: `src/session/context.ts`, `test/context.test.ts`
**Effort:** L

- [x] Binding behavior (PRD §15.5): `assembleContext(role, run, task)` pulls durable artifacts: approved spec (current version), current plan + task AC, decision log, architecture summary, file index (paths + sizes, no bodies), recent changes (last N commits w/ messages + diffstat), task-local transcript tail, relevant evidence; token-budgeted assembly with priority order per role (verifier gets AC + evidence first, builder gets task + files); compaction: `compact(runId)` produces versioned summary artifact linking source event ranges — original events remain retrievable (test asserts link integrity); subagents receive only their slice (task-scoped).
- [x] Failing tests: assembly respects token budget (drops lowest priority first, never truncates spec AC); secrets absent (registry scrub asserted); compaction round-trip keeps links resolvable.
- [x] Commit: `feat(orchestrator): artifact-based context assembly + versioned compaction`

### Task AR-8: M1 minimal chat run on Temporal + event emission

**Files:** Create: `src/worker.ts`, `src/workflows/run.ts` (v1), `src/activities/{workspace,session,events}.ts`, `test/integration/m1-run.test.ts`
**Effort:** L

- [x] Binding behavior: `runWorkflow(runId)` v1 consumes CP-9's ADR-0009 durable run intent (`appType: "web" | "mobile"`, `model: string | null`; null delegates to organization policy): activity `ensureWorkspace` (sandbox-service create/restore) → activity `runBuilderSession` (AR-6, heartbeats every 10 s, checkpoint transcript) → activity `commitAndPush` (via runtime git; every task ends in commit — Global Constraint 7) → complete; events batched to CP-13 (`events.ts` client: flush ≤ 1 s or 20 events); run row status transitions queued→running→completed/failed.
- [x] Failing integration test (Temporal dev server + fakes for sandbox): start run via CP-9 → workflow completes → events include `run.started`, `agent.started`, ≥1 `tool.completed`, `commit.created`, `run.completed` in sequence order; **kill the worker process mid-session and restart** → workflow resumes from last heartbeat/checkpoint, no duplicate commits (idempotency key on commit activity).
- [x] Commit: `feat(orchestrator): durable minimal chat run (M1 walking skeleton)`

### Task AR-9 [M2]: Worker/queues/idempotency hardening

**Files:** Modify: `src/worker.ts`; Create: `src/activities/idempotency.ts`
**Effort:** M. **[expand-at-execution]**

Binding: queues `agent-runs`, `verification`, `releases`; activity middleware storing `(idempotencyKey → result hash)` in Postgres for all mutating activities; workflow `continueAsNew` after each phase; retry policies: transient 3×, business failures no-retry (typed ApplicationFailure).

### Task AR-10 [M2]: Run control signals

**Files:** Modify: `src/workflows/run.ts`; Create: `test/integration/signals.test.ts`
**Effort:** M

- [ ] Binding behavior: signals `pause` (finish current tool call, checkpoint, status `paused`, ack event ≤ 5 s), `resume`, `cancel` (best-effort tool termination via sandbox-service kill, workspace checkpointed, status `cancelled`), `redirect(instruction)` (v1: queue instruction for next session turn; full plan-diff in AR-26); query `getStatus` returns phase/task snapshot for reconnecting clients.
- [ ] Failing integration tests for each signal incl. pause→resume mid-run continuity and cancel ack latency < 5 s.
- [ ] Commit: `feat(orchestrator): pause/resume/cancel/redirect signals`

### Task AR-11 [M2]: planning-engine — plan schema + task graph

**Files:** Create: `packages/planning-engine/src/{schema,graph}.ts`, `test/graph.test.ts`
**Interfaces produced (binding):** `PlanSchema` per PRD §13.1: phases[] (id, sequence, title, acceptanceCriteria[], approvalAfter: boolean), tasks[] (id, phaseId, title, dependsOn[], riskLevel, requiredTools[], expectedFiles[], acceptanceCriteriaIds[], requiredTests[], estimate), budget { credits, wallClockHours }; `TaskGraph.readyTasks(state)` respecting dependencies + one-writer-per-branch; cycle detection at plan creation (reject with `plan_cycle`).
**Effort:** M

- [ ] Failing tests: Appendix C example plan parses; diamond dependency schedules correctly; cycle rejected; two tasks touching same branch never both ready.
- [ ] Commit: `feat(planning-engine): plan schema + dependency scheduler`

### Task AR-12 [M2]: Task workflow with isolation

**Files:** Create: `src/workflows/task.ts`, `src/activities/merge.ts` (stub), `test/integration/task-isolation.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §13.3): child `taskWorkflow(taskId)`: record `base_commit_sha` → branch `task/{taskId}` → isolated workspace (or reuse with branch lock for serial tasks) → builder session → commit → push → status `verifying` (VF plan takes over) → merge activity applies to integration branch `run/{runId}` (fast-forward or 3-way; conflict → create conflict task, original marked `blocked`); parallel independent tasks run as parallel child workflows capped by plan concurrency.
- [ ] Failing integration test: two independent tasks run in parallel on separate branches, both merge clean; forced conflict (both edit same line) → second becomes conflict task with `task.blocked` event; a task never mutates another's working tree (separate workspace dirs asserted).
- [ ] Commit: `feat(orchestrator): isolated task workflows with merge + conflict tasks`

### Task AR-13 [M2]: Mission Control read model

**Files:** Create: `services/control-api/src/routes/mission-control.ts` (lives in CP service, spec'd here), `test/mission-control.test.ts`
**Interfaces produced:** `GET /v1/runs/:runId/mission-control` → aggregate per PRD §14.2: `{ run, currentPhase, progress: {done,total}, taskGraph: nodes+edges with states, activeAgents, recentToolCalls (last 50, visibility-filtered), filesChanged (from commit diffstats), commits, testRuns, previewStatus, screenshots (artifact refs), cost: {creditsUsed, budget}, approvals (open+resolved), risks }` — built from events + tables, **never chat text** (Global Constraint 11); paginated sub-resources for tool calls/commits.
**Effort:** M

- [ ] Failing tests: aggregate built from seeded events matches snapshot; internal-visibility tool calls excluded for user role.
- [ ] Commit: `feat(control-api): Mission Control aggregate read model`

### Task AR-14 [M2]: Run budgets + approval requests

**Files:** Create: `src/activities/approvals.ts`, `packages/agent-policies/src/budgets.ts` wiring
**Effort:** M

- [ ] Binding behavior (PRD §30.2): run starts with budget (plan default or user-set); estimated cost shown pre-run (planner estimate activity); at 80% → `usage.recorded` warning event; at 100% → workflow pauses with `approval.requested` (type `budget_increase`); approve resumes with raised budget, reject → graceful stop with checkpoint; approvals stored (PRD §23.3) and resolved via `POST /v1/runs/:id/approvals/:approvalId` (added to CP-9 surface).
- [ ] Failing tests: budget trip → paused + approval row; approve → resumes; reject → cancelled-with-checkpoint.
- [ ] Commit: `feat(orchestrator): run budget gates with human approval loop`

### Task AR-15 [M2]: Ask + Prototype modes

**Files:** Modify: `src/workflows/run.ts`; Create: `test/modes.test.ts`
**Effort:** M

- [ ] Binding behavior: Ask — toolset filtered to read tools (PRD §11.1), answers must cite files/commits/tests (prompt + a citation lint on output: response missing any `path:line` or commit ref when claims reference code → verifier-style warning event); Prototype — optimizes for preview, may mock (each mock recorded as `assumption` decision row + labeled in UI via event payload `mocks: []`), **not deploy-eligible**: release creation for prototype-only runs rejected (`prototype_not_deployable`) until converted to Build (PRD §11.2); still requires dev-server + smoke gate.
- [ ] Commit: `feat(orchestrator): ask + prototype modes with guardrails`

### Task AR-16 [M3]: specification-engine — interview + spec artifact

**Files:** Create: `packages/specification-engine/src/{interview,spec,schema}.ts`, `test/spec.test.ts`
**Interfaces produced (binding):** `SpecificationSchema` per PRD §12.2 (problem, targetUsers, goals, nonGoals, journeys, pagesRoutes, rolesPermissions, dataModel, integrations, functionalRequirements, nonfunctionalRequirements, acceptanceCriteria[] `{ id: "AC-n", text, priority, criticalFlow: boolean }`, assumptions, risks, definitionOfDone); interview policy: question selection scored by consequence (arch/scope/risk/AC impact), asks ≤ 3 grouped questions per turn, offers concrete options with tradeoffs, records delegated decisions as assumptions, stops when spec executable (all critical categories resolved or assumed) — PRD §12.1 categories enumerated in code.
**Effort:** L

- [ ] Failing tests: schema round-trip; interview state machine stops after all categories resolved (scripted fake user); assumption recorded when user says "you decide"; spec version approval via CP-10 integration.
- [ ] Commit: `feat(specification-engine): consequential-question interview + versioned spec artifact`

### Task AR-17 [M3]: Autonomous mode workflow

**Files:** Create: `src/workflows/autonomous.ts`, `test/integration/autonomous.test.ts`
**Effort:** XL → split at execution: 17a interview+approval phases, 17b phase execution loop, 17c final evidence. **[expand-at-execution]**

Binding behavior (PRD §11.5, §34 sequence): interview (AR-16) → spec approval gate (signal) → planner activity produces plan (AR-11 schema) → plan approval gate → per phase: task scheduling (AR-12) → phase verification (VF-10) → repair loop (VF-13) → phase checkpoint + `continueAsNew` → final release-candidate evidence (07); Mission Control events throughout; subagent profiles (frontend/backend/testing) instantiated as separate sessions with task-scoped context (AR-7). Integration test: scripted 2-phase run end-to-end with fake user approvals, surviving worker restart between phases (E7 evidence).

### Task AR-18 [M3]: Build mode

**Files:** Modify: `src/workflows/run.ts`
**Effort:** M

- [ ] Binding behavior (PRD §11.3): lightweight plan (1 phase, ≤ 5 tasks) auto-approved under a config diff-size/risk threshold, else approval gate; AC mapping required (every task → ≥1 AC); per-task commits; project-required checks (VF gate set for support level) before `passed`.
- [ ] Commit: `feat(orchestrator): build mode with lightweight planning`

### Task AR-19 [M3]: Fix mode

**Files:** Create: `src/workflows/fix.ts`, `test/integration/fix.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §11.4, §10.3): input = error report/failed check/user bug + captured evidence (console/network from preview proxy, Grafana error link — Faro event / Loki query); steps: restore relevant commit in isolated workspace → reproduce activity (must produce failing check or documented non-repro) → regression test written **before** patch when feasible (policy flag when skipped, with reason) → minimal patch (diff-size guard vs anti-slop policy) → targeted checks → full required gates → verify original symptom absent (re-run reproduction) — each step an event.
- [ ] Integration test: seeded template app with planted bug + failing repro script → fix run produces regression test file + patch commit + green verification; unrelated-file-churn guard triggers on an oversized diff fixture.
- [ ] Commit: `feat(orchestrator): fix mode with reproduce-first + regression-test policy`

### Task AR-20 [M3]: Redirect + plan change

**Files:** Create: `src/workflows/redirect.ts` logic in run/autonomous workflows, `packages/planning-engine/src/diff.ts`
**Effort:** L

- [ ] Binding behavior (PRD §13.4): redirect signal → pause affected tasks (dependency-closure computation) → planner produces plan diff (`PlanDiff = { addedTasks, removedTaskIds, modifiedTasks, supersededTaskIds, impact: { scope, costDelta, archChange, dataChange } }`) → material change (any impact flag) → approval gate; else auto-apply → superseded tasks marked (state `superseded`, never deleted) → resume from durable checkpoint; completed work re-validated by verifier only where dependency-affected.
- [ ] Failing tests: mid-phase redirect adding a feature yields diff with approval; trivial copy-change redirect auto-applies; superseded tasks retain artifacts.
- [ ] Commit: `feat(orchestrator): redirect with plan diff + supersede semantics`

### Task AR-21 [M3]: Forking (project, branch, conversation, run checkpoint)

**Files:** Create: `services/control-api/src/routes/forks.ts`, `src/activities/fork.ts`, `test/fork.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §28): fork targets: project (new project + repo copy via git-service), branch (new branch from sha), conversation (new run seeded with compacted context artifact linking source — AR-7 compaction), agent run from checkpoint (new run + workspace restored at checkpoint ref, WS-7), release into repair branch (delegates to DEP-12). Invariants as tests: forked entity gets new identity; source artifacts immutable (write attempts rejected); compacted context links back to source run; **secrets never copied across organizations** (cross-org fork carries secret *names* as setup checklist only); deployment configuration copied only with explicit `copyDeploymentConfig: true`; usage/billing attributed to destination org (ledger rows assert destination `organization_id`).
- [ ] Commit: `feat: fork semantics for projects, branches, conversations, and runs`

---

## Testing strategy
- Unit: policies, graph, context assembly, schema round-trips (fast, no infra).
- Integration: Temporal dev server + fake sandbox/model for workflow semantics (signals, restarts, isolation, idempotency). Worker-kill tests (AR-8, AR-17) are permanent CI.
- Eval: injection prompt set (AR-5) + interview stop-condition scripts (AR-16) run as vitest; model-in-the-loop evals live in VF plan (repair benchmarks).

## Scalability notes
- Workers horizontally scale per queue; `continueAsNew` bounds history; event batching keeps CP-13 writes ≤ 20/s/run; per-org gateway semaphores prevent noisy-neighbor token starvation.

## Security & tenancy notes
- Policy evaluation is code-side (Global Constraint 15); model sees redacted, delimited tool output only; approval-gated tools enumerated in AR-4 table; all activities carry org/project context for ledger + audit attribution.

## Execution log

- 2026-08-04 AR-1 done — Added the authenticated provider-neutral streaming gateway and four AI SDK adapters with primary-only role selection; fallback execution remains AR-2.
- 2026-08-04 AR-1 BLOCKED: Inherited direct model-provider calls remain in `apps/desktop`, conflicting with master Global Constraint 2; Plan 09 schedules the desktop gateway migration under MAC-6, outside AR-1's Files contract, with controller/human resolution tracked in external ADR-0005.
- 2026-08-04 AR-1 architecture gate — The accepted ADR-0005 migration exception is mechanically bounded by a production-reachability, default-deny gate to nine inherited desktop inventory paths (eight runtime consumers plus one import-only module) and exact import/call/use inventory cryptographically derived from `df81175`; AR-1 and its tracker remain unchecked.
- 2026-08-04 AR-1 BLOCKED: Five capped review-fix rounds (`62420b9..70ace06`) left a real P1 bypass in the mandatory boundary analyzer: non-identifier mutation receivers such as `(alias = slots).unshift(require)`, conditional/logical receiver results, and getter-return receivers can resolve to an empty target set and hide a new provider load. This security gate is load-bearing for downstream AR tasks; AR-1 remains unchecked pending architectural remediation.
- 2026-08-06 AR-1 done — Closed the provider-boundary evaluator blocker with source-ordered live accessor, callback, closure, constructor, prototype, and opaque-mutation semantics; 182 architecture tests and the exact nine-path production boundary pass.
- 2026-08-06 AR-2 done — Added organization-aware routing, retry/fallback observations, and per-organization stream concurrency limits through the configured completion path.
- 2026-08-06 AR-4 BLOCKED — Five capped review-fix rounds on isolated branch `task/AR-4` (`1ee2027..15ce8fe`) left three reproduced P1 gaps in the mandatory post-cap review: caller cancellation can race before listener registration and allow a mutation to succeed, dev-server readiness accepts a process-owned non-HTTP TCP listener, and `apply_patch` can overwrite a concurrent source change; runtime-timeout audit classification and path-policy rejection audit hygiene also remain P2. AR-4 stays unchecked and is not integrated.
- 2026-08-06 AR-5 BLOCKED — Five capped review-fix rounds on isolated branch `task/AR-5` (`62202c8..dc2206f`) left four reproduced P1 gaps in the mandatory post-cap review: standard shell expansions, `eval`, positional parameters, and recursive subshell call graphs bypass all three command-policy families; combining-mark and astral PostgreSQL identifiers can make adjacent dollar markers hide live destructive SQL; common grammatical and multi-action directives bypass consequential-tool relevance; and attacker-controlled example headings both bypass malicious instructions and misclassify realistic regression documentation. AR-5 stays unchecked and is not integrated.
- 2026-08-06 AR-6 BLOCKED — The binding session loop must execute tools through the AR-4 registry and gate every tool call through AR-5; both required implementations are cap-blocked on isolated branches and unavailable on main. Temporary registries or policy stubs would violate the locked interfaces and blocker rules, so AR-6 stays unchecked pending AR-4/AR-5 architectural remediation; AR-7 remains independently executable.
- 2026-08-06 ADR-0015 accepted — model provider integration layer. Vercel AI SDK stays the default transport (it was inherited from PRD §35 without an options analysis; this records one). The adapter boundary, not the SDK, is the architectural commitment. AR-3 gains a blocking prompt-caching acceptance test with a pre-authorized fallback to the native Anthropic SDK for that adapter only. OpenRouter is permitted behind `compatible` for benchmarking, long-tail models and an independent break-glass route — never a role primary, never the transport for a directly-integrated vendor (data path, margin, and fallback-independence reasons in the ADR). LiteLLM rejected (second language runtime; duplicates AR-2/AR-3).
- 2026-08-06 AR-3 BLOCKED — The post-cap review after five review-fix rounds found two remaining critical defects on isolated branch `task/AR-3`: a durable recorder that commits and then rejects is surfaced as `provider_error` instead of `usage_accounting_failed`, and exceptions from valid-result OpenTelemetry attribute/status writes can prevent `span.end()`. ADR-0015 adds prompt-caching acceptance criteria but does not resolve either accounting defect, so AR-3 remains unchecked and unintegrated.
- 2026-08-06 AR-2 ADR-0015 follow-on done — Enforced at least two transports per role and pinned first-separator routing for vendor-qualified compatible model IDs.
- 2026-08-06 AR-7 done — Added strict artifact context assembly with role budgets, task isolation, secret scrubbing, and resolvable append-only versioned compaction.
- 2026-08-06 AR-7 REOPENED round 0 — Independent review found atomic compaction, exact token accounting, provenance integrity, required-context schema, semantic source-shape, typed-ID, and deterministic-ordering defects; fix round 1 started.
- 2026-08-06 AR-7 done round 1 — Replaced compaction with a keyed atomic CAS port, exact joined-content accounting, strict provenance/context/source schemas, opaque repository IDs, and locale-independent ordering; all package and forced root checks pass.
- 2026-08-06 AR-7 REOPENED round 1 — Independent review found identity/provenance secret leakage, ambiguous post-commit outcomes, missing service-level source resolution, oversized saved ranges, and duplicate normalized paths; fix round 2 started.
- 2026-08-06 AR-7 done round 2 — Added identity-preserving recursive scrubbing, exact pre-commit source resolution, bounded same-request recovery for ambiguous commit outcomes, saved-range caps, and normalized path uniqueness; all package and forced root checks pass.
- 2026-08-06 AR-7 REOPENED round 2 — Independent review found untrusted repository-generated summary IDs, scrubbed-source CAS ambiguity, assembly identity rewriting, invalid saved-range endpoints, Unicode path aliases, and malformed transcript ordering; fix round 3 started.
- 2026-08-06 AR-7 done round 3 — Added operation-bound prevalidated summary IDs, opaque raw-snapshot revision CAS, assembly identity preservation, exact saved-range endpoints, NFC path enforcement, and strict transcript chronology; all package and forced root checks pass.
- 2026-08-06 AR-7 REOPENED round 3 — Independent review found unbounded future idempotent versions and non-durable injected summary IDs without atomic collision handling; fix round 4 started.
- 2026-08-06 AR-7 done round 4 — Replaced injected summary IDs with namespaced deterministic SHA-256 identities, added atomic typed collision handling, and bounded committed/idempotent result versions; all package and forced root checks pass.
- 2026-08-06 AR-7 REOPENED round 4 — Independent review found operation-ID edge-whitespace normalization could alias distinct durable mutations; final fix round 5 started.
- 2026-08-06 AR-7 done round 5 — Replaced operation-ID transformation with validation-only Unicode edge-whitespace rejection while preserving accepted identities byte-for-byte; all package, forced root, and diff checks pass.
- 2026-08-06 AR-4 done — Registered all 45 validated tools with runtime/service-port safety; approved ADR-0010 adds typed WS-1 merge/revert operations.
- 2026-08-06 AR-4 REOPENED — Independent review round 0 found missing tenant, secret, path, cancellation, runtime, release-port, and outcome-truth boundaries; steps and tracker remain unchecked through fix round 1.
- 2026-08-06 AR-4 done — Fix round 1 adds trusted execution context, opaque secret IDs, contract-bound commands, attributed browser routes, truthful outcomes, cancellation/idempotency, atomic patch writes, real restart, and Plan-07-compatible release adapters; 29 agent-tools and 16 workspace-runtime tests pass.
- 2026-08-06 AR-4 REOPENED round 2 — Independent review round 1 found runtime TOCTOU, supervisor readiness, caller cancellation, integration-contract, deployment-confirmation, and atomic mode/rollback gaps; steps and tracker remain unchecked through fix round 2.
- 2026-08-06 AR-4 done — Fix round 2 moves search/delete/rename and listener ownership into WS-1, propagates caller cancellation, executes contracted integration tests, aligns deployment confirmation, and proves mode-preserving rollback at real commit boundaries; contracts 129, workspace-runtime 23, and agent-tools 35 tests pass.
- 2026-08-06 AR-4 REOPENED round 3 — Independent review round 2 found duplicate canonical atomic-write targets, non-idempotent repeated deletion, and same-object rename aliases; steps and tracker remain unchecked through fix round 3.
- 2026-08-06 AR-4 done — Fix round 3 rejects duplicate canonical/same-inode atomic targets before staging, preserves idempotent repeated deletion, and rejects normalized/parent-symlink/hard-link rename aliases; contracts 129, workspace-runtime 27, and agent-tools 37 tests pass.
- 2026-08-06 AR-4 REOPENED round 4 — Independent review round 3 found leaf-symlink topology replacement, absent filesystem-name aliases, incomplete WS-3/4/13 protocol bindings, and non-distinguishable command audit identity; steps and tracker remain unchecked through fix round 4.
- 2026-08-06 AR-4 done — Fix round 4 rejects atomic leaf symlinks and parent-filesystem name aliases before staging, binds exact WS-3/4/13 protocols and cross-runtime conformance, and returns redacted canonical command audit identity with trusted caller attribution; contracts 129, workspace-runtime 30, and agent-tools 39 tests pass.
- 2026-08-06 AR-4 REOPENED round 5 — Independent review round 4 found escaped-argument redaction bypasses, missing exceptional command-attempt audit envelopes, and an omitted internal cloud start route; steps and tracker remain unchecked through the final fix round.
- 2026-08-06 AR-4 done — Final fix round records raw independently redacted command arguments and strict attributed attempt audits on success/rejection/timeout/cancellation, and binds both cloud dev-server start/restart routes with identical ownership conformance; contracts 129, workspace-runtime 30, and agent-tools 42 tests pass.
- 2026-08-06 AR-4 recovery done — Closed cancellation registration, process-owned HTTP readiness, concurrent patch compare-and-swap, runtime-timeout audit classification, and redacted attributed path-rejection audit findings; contracts 129, workspace-runtime 31, and agent-tools 46 tests pass, with forced root typecheck 19/19, architecture 182/182, lint 20/20, and build 12/12.
- 2026-08-06 AR-4 REOPENED recovery round 1 — Controller review found a final compare-to-replace lost-update race, missing `install_dependency` runtime-timeout classification, and unaudited raw-path leakage when `install_dependency` cwd dispatch is rejected; steps and tracker remain unchecked pending strict RED/GREEN remediation and full verification.
- 2026-08-06 AR-4 recovery round 1 done — Replaced split expected-state validation/move with guarded compare-and-replace plus ordinary-write serialization, preserved dependency-install timeout classification, and added attributed redacted dependency-install path rejection; contracts 129, workspace-runtime 33, and agent-tools 48 tests pass, with forced root typecheck 19/19, architecture 182/182, lint 20/20, and build 12/12.
- 2026-08-06 AR-4 REOPENED recovery round 2 — Controller review proved the default memory runtime still performs expected-byte read/compare followed by an unconditional rename, so an uncooperative write after the final comparison is silently overwritten and `apply_patch` falsely succeeds; steps and tracker remain unchecked pending an enforceable provider/runtime revision CAS or fail-closed behavior where CAS is unavailable.
- 2026-08-06 AR-4 recovery round 2 done — Replaced unenforceable compare-then-rename expected bytes with an opaque provider revision CAS contract and fail-closed memory fallback; the deterministic post-comparison regression returns `patch_conflict`, performs zero atomic target writes, and preserves concurrent content. Contracts 129, workspace-runtime 33, and agent-tools 49 tests pass, with forced root typecheck 19/19, architecture 182/182, lint 20/20, and build 12/12. Production guarded patch availability remains a blocking WS-3/WS-4 provider acceptance item; fail-closed alone cannot complete those tasks.
- 2026-08-06 AR-4 REOPENED recovery round 3 — Controller review proved unsupported guarded snapshot reads leak raw `ENOENT` for missing or disappeared targets, causing `apply_patch` to throw attributed `tool_failed` instead of returning stable `patch_conflict`; steps and tracker remain unchecked pending RED-first conflict mapping with zero writes, preserved path-rejection behavior, and full verification.
- 2026-08-06 AR-4 recovery round 3 done — Missing/disappeared guarded leaf inspection now maps only disappearance-class `ENOENT` and post-validation `ENOTDIR` to `AtomicWriteConflictError`; `apply_patch` returns stable `patch_conflict` with zero writes and no raw path/`ENOENT`, while lexical escapes and non-disappearance filesystem errors remain truthful. Contracts 129, workspace-runtime 35, and agent-tools 51 tests pass, with forced root typecheck 19/19, architecture 182/182, lint 20/20, and build 12/12.
- 2026-08-06 ADR-0016 accepted + AR-5 re-scoped — injection defense is structural (AR-4 allowlist + approval gates + WS-11 sandbox), not linguistic. Abandon task/AR-5 and task/AR-5-resume (risk.ts 1245 + injection.ts 515 lines: exhaustive shell grammar + astral-SQL parser + NL directive classifier — five capped rounds each, root cause a category error on both implementer and reviewer). Rewrite from the amended brief: provenance gating, blocklist speed-bump, 10 eval strings, corpus deferred to OPS-13. Reviewer rubric changed: heuristic incompleteness is Minor, not P1.
- 2026-08-07 AR-5 done — Rebuilt the policy package around structural untrusted-provenance gating, production-safe approval defaults, canonical deployment approvals, declarative catastrophic-command signals, and exactly 10 eval strings; 119 policy tests plus a 520-assertion independent adversarial matrix passed locally, and independent review found no P0/P1/P2 defects. CI is unverified because GitHub billing prevented jobs from starting.
- 2026-08-07 AR-3 BLOCKED round 5 — The capped final independent review of staged branch `task/AR-3-recovery` found two structural P1 defects: ambiguous provider finish reason `other` is charged and allowed to reach `done`, and an idempotency completion that durably commits then rejects can emit `provider_error` while a same-key retry replays the original terminal event. The branch remains uncommitted and AR-3 unchecked; do not begin a sixth routine review/fix loop without an explicit re-scope. Local unit coverage passed (model-gateway 146 with 2 credential skips; DB 148), but Anthropic cache and live PostgreSQL/Redis acceptance remain unverified, and CI is unverified because GitHub billing prevented jobs from starting.
- 2026-08-07 AR-3 DEFERRED out of the M1 critical path (controller) — capped twice (~10 rounds), not in M1 exit criterion, no live model spend to meter yet. Reopen as first M2 task; hard precondition before real model credentials or M2 autonomous runs.
- 2026-08-07 AR-6 BLOCKED after one adversarial review + one fix round — `117cca8` closed approval validation, fenced execution leases, transcript-wide redaction, durable event outbox/reference replay, input-token reservation, non-cooperative cancellation, durable gateway failures, and safe timers; scoped re-review left one real hard-budget defect: absent or understated provider `outputTokens` charges only request input, so later turns can reuse the unreported allowance and exceed `maxTokens`. The branch stays unchecked under the one-fix-round cap; focused session tests passed 18/18, package tests 145/145, lint/typecheck/build/architecture and local `pnpm verify` passed, while PostgreSQL/Redis/Forgejo/Stytch credential suites skipped visibly.
- 2026-08-07 AR-6 done — `c28eb73` fixed cumulative output-token reservation when provider usage is absent or understated; focused session tests passed 20/20, worker lint/typecheck/build passed, architecture passed 182/182 plus the production boundary scan, and the exact tracked pnpm 9.15 pre-push gate passed with DB 48/48, Forgejo/backup 16/16, control-api 236/236, tenant isolation 54/54, and Gate-5 1/1.
- 2026-08-07 AR-8 done — Added the Temporal M1 run with durable transcript checkpoint recovery after worker SIGKILL, per-run CP-13 batching, and idempotent commit retry; the exact tracked pre-push gate passed.
