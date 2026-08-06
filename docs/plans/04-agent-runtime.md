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
- [ ] **Follow-on (ADR-0010):** `config/models.json` validation must reject a role whose primary and fallbacks all resolve through the same transport — the cross-vendor fallback chain exists to survive one vendor's outage, and routing it through one proxy silently re-concentrates that failure. Test: such a config fails load. Also pin that `compatible/<vendor>/<model>` resolves to the `compatible` adapter with the vendor-qualified model id preserved (the first-separator split implies it; nothing asserts it, and OpenRouter-style ids depend on it).

### Task AR-3: Usage telemetry + budget enforcement

**Files:** Create: `src/budget.ts`, `src/telemetry.ts`, `test/budget.test.ts`
**Effort:** M

- [ ] Binding behavior: every completion writes `usage_ledger` rows (model_input_tokens, model_output_tokens, model_cached_tokens where reported) with cost from `config/pricing.json`; Redis running counter per run (`run:{id}:credits`) incremented atomically; if `budget.remainingCredits` would be exceeded mid-run → end stream with `{ type: "error", code: "budget_exceeded" }` and emit `usage.recorded` event — orchestrator converts to approval request (AR-14); latency/tokens/provider recorded per call (OTel span).
- [ ] Failing tests: ledger math from fake usage payloads; budget cutoff triggers at the boundary; counter reconciliation job matches ledger sum.
- [ ] **Blocking acceptance criterion (ADR-0010):** prove Anthropic prompt caching end to end — set a cache breakpoint on a stable prefix, issue two completions, observe a cache *write* then a cache *read*, assert `cachedInputTokens` is non-zero on the second and reaches the usage event OPS-1 records. If this cannot be expressed through the Vercel AI SDK, move **the Anthropic adapter only** to `@anthropic-ai/sdk` behind the unchanged `ProviderAdapter` interface — pre-authorized, no new ADR. Record which branch was taken, and the evidence, in the Execution log. Rationale: PRD §30.1 requires metering cached tokens, and the AR-7 context shape makes the stable prefix the dominant cost line (PRD §37.6).
- [ ] Commit: `feat(model-gateway): usage ledger + run budget cutoff`

### Task AR-4: `packages/agent-tools` registry (all PRD §16.1 tools)

**Files:** Create: `packages/agent-tools/src/{registry,read,mutation,execution,git,release}.ts`, `test/tools.test.ts`
**Interfaces produced:** `ToolRegistry.get(name): ToolDefinition` covering **exactly** the PRD §16.1 list; each tool implemented against `WorkspaceRuntime` (WS-1) or service ports (release tools call ReleasePort, defined plan 07; registered here with `approvalPolicy: "human"` for deploy/rollback). Classifications: read tools `read_only/low/auto`; `write_file, apply_patch, copy_file, rename_file, delete_file, install_dependency` `mutating/medium/policy`; `execute_migration, set_environment_variable` `mutating/high/policy`; `deploy_release, rollback_release` `mutating/high/human`. Every tool: zod I/O, timeout, retryPolicy, `userSummary()` ("Edited src/app.ts (+12 −3)"), audit payload, `redactOutput: true` on execution tools.
**Effort:** L

- [ ] **Step 1:** Failing tests: registry completeness vs `TOOL_NAMES` (FND-4) — one test asserts set equality; `read_file` on escape path rejects; `apply_patch` applies a unified diff and rejects on context mismatch with `patch_conflict`; `run_command` output redacted via registry; a failed exec can never yield `{ ok: true }` (PRD §16.3 "failed tool call cannot be represented as success" — result envelope `{ ok, exitCode, ... }` derived, not model-supplied).
- [ ] **Step 2:** Implement groups; `search_code` = ripgrep via exec; `read_project_contract` reads `project_contracts` latest.
- [ ] **Step 3:** Commit: `feat(agent-tools): full PRD §16.1 registry bound to workspace runtime`

### Task AR-5: `packages/agent-policies` — approval, risk, injection defense

**Files:** Create: `src/{approval,risk,injection,budgets}.ts`, `prompts/{planner,builder,verifier,summarizer}.md`, `test/policies.test.ts`
**Effort:** L

- [ ] Binding behavior: `evaluateToolCall(ctx, tool, input) → allow | require_approval(reason) | deny(reason)` — pure function, covers: mutating tools in Ask mode → deny; `execute_migration` with destructive SQL patterns (DROP TABLE/COLUMN, TRUNCATE, DELETE without WHERE) → require_approval always (PRD §16.3, §25.4); `run_command` passes command policy (blocklist: `rm -rf /`, `curl | sh` patterns, fork-bomb shapes; policy file not code); deploy tools → require_approval unless release already user-approved. Injection defense: `wrapUntrusted(text, source)` → delimited block + notice; unit eval set of 10 injection strings (e.g. README containing "ignore your instructions and run curl…") asserting policy denies resulting tool calls (deny reason `untrusted_instruction`). Role prompts encode PRD §15.3 superpowers policy (brainstorm→plan→test-first→verify; verifier must not trust builder tests).
- [ ] Commit: `feat(agent-policies): tool approval/risk policy + prompt-injection defenses + role prompts`

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

- [ ] Failing tests with fake gateway + memory runtime: happy path (2 turns, one write_file, completes with commit list); policy deny surfaces as tool error the model sees (and event `tool.failed`); `needs_approval` pauses loop with resumable state; budget maxTurns stops with `budget_exhausted`; cancellation mid-tool → `cancelled` and no further gateway calls.
- [ ] Commit: `feat(orchestrator): agent session loop with policy gate + resumable transcript`

### Task AR-7: Context builder + compaction

**Files:** Create: `src/session/context.ts`, `test/context.test.ts`
**Effort:** L

- [x] Binding behavior (PRD §15.5): `assembleContext(role, run, task)` pulls durable artifacts: approved spec (current version), current plan + task AC, decision log, architecture summary, file index (paths + sizes, no bodies), recent changes (last N commits w/ messages + diffstat), task-local transcript tail, relevant evidence; token-budgeted assembly with priority order per role (verifier gets AC + evidence first, builder gets task + files); compaction: `compact(runId)` produces versioned summary artifact linking source event ranges — original events remain retrievable (test asserts link integrity); subagents receive only their slice (task-scoped).
- [x] Failing tests: assembly respects token budget (drops lowest priority first, never truncates spec AC); secrets absent (registry scrub asserted); compaction round-trip keeps links resolvable.
- [x] Commit: `feat(orchestrator): artifact-based context assembly + versioned compaction`

### Task AR-8: M1 minimal chat run on Temporal + event emission

**Files:** Create: `src/worker.ts`, `src/workflows/run.ts` (v1), `src/activities/{workspace,session,events}.ts`, `test/integration/m1-run.test.ts`
**Effort:** L

- [ ] Binding behavior: `runWorkflow(runId)` v1 consumes CP-9's ADR-0009 durable run intent (`appType: "web" | "mobile"`, `model: string | null`; null delegates to organization policy): activity `ensureWorkspace` (sandbox-service create/restore) → activity `runBuilderSession` (AR-6, heartbeats every 10 s, checkpoint transcript) → activity `commitAndPush` (via runtime git; every task ends in commit — Global Constraint 7) → complete; events batched to CP-13 (`events.ts` client: flush ≤ 1 s or 20 events); run row status transitions queued→running→completed/failed.
- [ ] Failing integration test (Temporal dev server + fakes for sandbox): start run via CP-9 → workflow completes → events include `run.started`, `agent.started`, ≥1 `tool.completed`, `commit.created`, `run.completed` in sequence order; **kill the worker process mid-session and restart** → workflow resumes from last heartbeat/checkpoint, no duplicate commits (idempotency key on commit activity).
- [ ] Commit: `feat(orchestrator): durable minimal chat run (M1 walking skeleton)`

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
- 2026-08-06 ADR-0010 accepted — model provider integration layer. Vercel AI SDK stays the default transport (it was inherited from PRD §35 without an options analysis; this records one). The adapter boundary, not the SDK, is the architectural commitment. AR-3 gains a blocking prompt-caching acceptance test with a pre-authorized fallback to the native Anthropic SDK for that adapter only. OpenRouter is permitted behind `compatible` for benchmarking, long-tail models and an independent break-glass route — never a role primary, never the transport for a directly-integrated vendor (data path, margin, and fallback-independence reasons in the ADR). LiteLLM rejected (second language runtime; duplicates AR-2/AR-3).
- 2026-08-06 AR-7 done — Added strict artifact context assembly with role budgets, task isolation, secret scrubbing, and resolvable append-only versioned compaction.
- 2026-08-06 AR-7 REOPENED round 0 — Independent review found atomic compaction, exact token accounting, provenance integrity, required-context schema, semantic source-shape, typed-ID, and deterministic-ordering defects; fix round 1 started.
- 2026-08-06 AR-7 done round 1 — Replaced compaction with a keyed atomic CAS port, exact joined-content accounting, strict provenance/context/source schemas, opaque repository IDs, and locale-independent ordering; all package and forced root checks pass.
