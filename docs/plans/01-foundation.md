# Plan 01 — Foundation & Shared Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the zapp monorepo, shared contract/db/config packages, local dev environment, and CI so every other plan builds on typed, tested foundations.

**Architecture:** pnpm + Turborepo monorepo. `packages/contracts` is the single source of truth for domain types (Zod-first, types inferred). `packages/db` owns the Drizzle schema for the PRD §23 data model with tenant-scoped query helpers. Dev infra runs in docker-compose (Postgres, Redis, Forgejo, Temporal dev server, MinIO).

**Tech Stack:** Node 22, TypeScript 5.6+ strict, pnpm 9, Turborepo 2, Zod 3, Drizzle ORM + drizzle-kit, Vitest 2, ESLint 9 flat config + Prettier, GitHub Actions.

**Milestone:** M0. **Depends on:** nothing. **Consumed by:** every other plan.

## Global Constraints

See master plan §Global Constraints. Specific to this plan:
- Types are inferred from Zod schemas (`z.infer`) — never hand-written duplicates.
- `packages/contracts` has zero runtime dependencies besides `zod` and `ulid`. *(Amended 2026-08-03: FND-3 mandates the ulid package; original "zod only" line contradicted it.)*
- Table and column names match PRD §23 exactly (snake_case in SQL, camelCase in TS via Drizzle mapping).
- All IDs are prefixed TypeIDs: `org_`, `user_`, `proj_`, `run_`, `task_`, `ws_`, `rel_`, `dep_`, `evt_`, `art_`, `spec_`, `sec_` (ULID suffix, sortable).

---

### Task FND-0: Repository initialization

**Files:** Create: `.gitignore`, `README.md`
**Effort:** S

- [x] **Step 1:** `git init` in `/Users/manishmaheshwari/Projects/zapp`; create `.gitignore` with: `node_modules/`, `dist/`, `.turbo/`, `.next/`, `out/`, `*.log`, `.env`, `.env.*`, `!.env.example`, `.DS_Store`, `coverage/`, `drizzle/meta/_journal.json.bak`
- [x] **Step 2:** `README.md` with one-paragraph product summary (from PRD §1) and links to `docs/zapp-build-prd.md`, `docs/plans/00-master-plan.md`, `tasks/todo.md`.
- [x] **Step 3:** Commit: `chore: initialize repository with PRD and P0 plan set`

### Task FND-1: Monorepo scaffold

**Files:** Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `vitest.workspace.ts`, `.nvmrc`, `.npmrc`
**Effort:** M

- [x] **Step 1:** Root `package.json`:

```json
{
  "name": "zapp",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:integration": "turbo run test:integration",
    "db:generate": "pnpm --filter @zapp/db db:generate",
    "db:migrate": "pnpm --filter @zapp/db db:migrate",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.6.3",
    "prettier": "^3.3.3",
    "eslint": "^9.14.0",
    "typescript-eslint": "^8.14.0",
    "vitest": "^2.1.4"
  }
}
```

- [x] **Step 2:** `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "services/*"
  - "packages/*"
  - "sandbox/*"
```

- [x] **Step 3:** `turbo.json` with task graph: `build` (dependsOn `^build`, outputs `dist/**`, `.next/**`), `typecheck` (dependsOn `^build`), `lint`, `test` (dependsOn `build`), `test:integration` (cache false, env `DATABASE_URL`, `REDIS_URL`), `dev` (persistent, cache false).
- [x] **Step 4:** `tsconfig.base.json`: `strict: true`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, path-less (workspace deps via package exports).
- [x] **Step 5:** ESLint 9 flat config: typescript-eslint strict-type-checked base; custom rules on: `no-empty` (catch blocks), `@typescript-eslint/no-floating-promises`. Add rule stub package reference for the `src/pro` import ban (implemented FND-9).
- [x] **Step 6:** `vitest.workspace.ts` globbing `packages/*/vitest.config.ts`, `services/*/vitest.config.ts`.
- [x] **Step 7:** Verify: `pnpm install && pnpm lint && pnpm typecheck` exit 0 (no packages yet — trivially green). Commit: `chore: monorepo scaffold (pnpm, turbo, tsconfig, eslint, vitest)`

### Task FND-2: `packages/config` — environment validation

**Files:** Create: `packages/config/package.json`, `packages/config/src/env.ts`, `packages/config/src/index.ts`, `packages/config/test/env.test.ts`
**Interfaces produced:** `defineEnv(schema)` helper; per-service env schemas colocated with services.
**Effort:** S

- [x] **Step 1:** Failing test `env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defineEnv } from "../src/env";
import { z } from "zod";

describe("defineEnv", () => {
  it("parses valid env and strips unknown keys", () => {
    const env = defineEnv(z.object({ PORT: z.coerce.number() }), { PORT: "4000", OTHER: "x" });
    expect(env).toEqual({ PORT: 4000 });
  });
  it("throws with the missing key names, never values", () => {
    expect(() => defineEnv(z.object({ SECRET_KEY: z.string() }), {})).toThrowError(/SECRET_KEY/);
  });
});
```

- [x] **Step 2:** Run `pnpm --filter @zapp/config test` → FAIL (module not found).
- [x] **Step 3:** Implement `defineEnv(schema, source = process.env)`: parse, on error throw `new Error("Invalid environment: " + names.join(", "))` where `names = [...new Set(issues.map(i => i.path.join(".")).filter(Boolean))]`, falling back to `"<schema>"` when no issue carries a path — key names only, never values. *(Amended 2026-08-03 from the original per-issue formula: empty-path issues (top-level refine, non-object source) previously produced a nameless error; controller-approved deviation, see FND-2 review.)*
- [x] **Step 4:** Test passes. Commit: `feat(config): typed environment validation`

### Task FND-3: `packages/contracts` — identifiers, events, task states

**Files:** Create: `packages/contracts/package.json`, `src/ids.ts`, `src/events.ts`, `src/run.ts`, `src/index.ts`, `test/ids.test.ts`, `test/events.test.ts`
**Interfaces produced (binding for all plans):**
- `newId(prefix: IdPrefix): string`, `idSchema(prefix)` — TypeID (prefix + ULID)
- `AgentEventSchema`, `type AgentEvent` — exactly PRD §14.4 fields
- `AGENT_EVENT_TYPES` — exactly the PRD §14.4 list (run.created … usage.recorded)
- `TaskStateSchema` — exactly PRD §13.2: queued, blocked, ready, running, waiting_for_approval, verifying, repairing, passed, failed, cancelled, superseded
- `RunModeSchema`: ask | prototype | build | fix | autonomous
- `SupportLevelSchema`: compatible | verified | managed
**Effort:** M

- [ ] **Step 1:** Failing tests:

```ts
// test/events.test.ts
import { AgentEventSchema, AGENT_EVENT_TYPES } from "../src/events";

it("accepts a valid tool.completed event", () => {
  const evt = {
    id: "evt_01J8ME7YQZJ2V9Q0X3T5B6K7N8",
    runId: "run_01J8ME7YQZJ2V9Q0X3T5B6K7N9",
    sequence: 42,
    occurredAt: "2026-08-03T12:00:00.000Z",
    organizationId: "org_01J8ME7YQZJ2V9Q0X3T5B6K7NA",
    projectId: "proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB",
    type: "tool.completed",
    visibility: "user",
    payload: { tool: "run_build", exitCode: 0 }
  };
  expect(AgentEventSchema.parse(evt)).toMatchObject(evt);
});
it("rejects unknown event types and negative sequence", () => { /* parse failures asserted */ });
it("event type list matches PRD count", () => {
  expect(AGENT_EVENT_TYPES).toHaveLength(34);
});
```

- [ ] **Step 2:** Run → FAIL. Implement `ids.ts` (ULID via `ulid` package pinned; `newId`, `idSchema` regex `^{prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `events.ts` (schema fields: id, runId, sequence `z.number().int().nonneg()`, occurredAt ISO string, organizationId, projectId, phaseId?, taskId?, agentId?, type `z.enum(AGENT_EVENT_TYPES)`, visibility `z.enum(["user","internal","support"])`, payload `z.record(z.unknown())`), `run.ts` (TaskState, RunMode, SupportLevel enums).
- [ ] **Step 3:** Tests pass. Commit: `feat(contracts): ids, agent events, run/task state enums`

### Task FND-4: `packages/contracts` — provider & tool interfaces

**Files:** Create: `src/sandbox.ts`, `src/project-adapter.ts`, `src/deployment.ts`, `src/tools.ts`, `src/execution-contract.ts`, `test/execution-contract.test.ts`
**Interfaces produced (binding):**
- `CloudSandboxProvider` — exactly PRD §18.2 method set; input/output types as Zod schemas (`CreateWorkspaceInputSchema` includes `organizationId, projectId, branchId, runId?, taskId?, purpose, resourceProfile, imageTag, env: Record<string,string>, networkProfile`)
- `WorkspaceStatusSchema` lifecycle: requested | provisioning | started | ready | active | checkpointing | idle | terminated (PRD §18.9)
- `ResourceProfileSchema`: small | standard | large with the PRD §18.10 cpu/mem table as `RESOURCE_PROFILES` const
- `ProjectAdapter` — exactly PRD §17.3
- `DeploymentProvider` — exactly PRD §27.1
- `ExecutionContractSchema` — PRD §17.2 YAML shape (version, package_manager, workspace_root, install/develop/build/typecheck/lint/test/health blocks with commands, timeouts, port)
- `ToolDefinition<I, O>`: `{ name, description, inputSchema, outputSchema, classification: "read_only"|"mutating", riskLevel: "low"|"medium"|"high", approvalPolicy: "auto"|"policy"|"human", idempotent: boolean, timeoutMs, retryPolicy: {maxAttempts, backoffMs}, redactOutput: boolean, userSummary(input, output): string }` (PRD §16.2)
- `TOOL_NAMES` — exactly the PRD §16.1 list (read/mutation/execution/git/release groups)
**Effort:** M

- [ ] **Step 1:** Failing test: parse the PRD §17.2 example execution contract verbatim (as JS object) → success; parse with missing `install.command` → failure; `TOOL_NAMES` covers all 5 groups (spot-check `read_project_contract`, `execute_migration`, `rollback_release` present).
- [ ] **Step 2:** Implement; interfaces are TS types over Zod schemas; providers are `interface` (implementations live in services).
- [ ] **Step 3:** Tests pass. Commit: `feat(contracts): sandbox/deployment/adapter/tool contracts + execution contract schema`

### Task FND-5: `packages/db` — Drizzle setup + identity & billing tables

**Files:** Create: `packages/db/package.json`, `drizzle.config.ts`, `src/client.ts`, `src/schema/identity.ts`, `src/schema/billing.ts`, `src/schema/index.ts`, `test/integration/identity.test.ts`
**Interfaces produced:** `createDb(url): Db`; tables `users`, `organizations`, `memberships`, `subscriptions`, `usage_ledger` with columns exactly per PRD §23.1.
**Effort:** M

- [ ] **Step 1:** `src/schema/identity.ts` (complete):

```ts
import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),                       // user_*
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),                       // org_*
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  plan: text("plan").notNull().default("trial"),
  billingCustomerId: text("billing_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("organizations_slug_idx").on(t.slug)]);

export const memberships = pgTable("memberships", {
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["owner", "builder", "viewer"] }).notNull(),
  status: text("status", { enum: ["invited", "active", "removed"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("memberships_org_user_idx").on(t.organizationId, t.userId),
  index("memberships_user_idx").on(t.userId),
]);
```

`billing.ts`: `subscriptions` (id, organization_id FK, stripe_subscription_id, plan_id, status, current_period_start/end timestamps) and `usage_ledger` (id, organization_id, project_id?, run_id?, task_id?, category enum: model_input_tokens|model_output_tokens|model_cached_tokens|sandbox_cpu_seconds|sandbox_mem_gib_seconds|storage_gib_hours|deploy_provider|artifact_storage, provider, quantity numeric, unit, cost_usd numeric(12,6), credits_charged numeric(12,4), occurred_at, index (organization_id, occurred_at)). **Append-only:** no update/delete helpers exported for this table.

- [ ] **Step 2:** Integration test (needs FND-7 compose; use `DATABASE_URL`): insert org + user + membership; unique (org,user) violation on duplicate insert; `usage_ledger` insert works with numeric cost.
- [ ] **Step 3:** `drizzle-kit generate` produces migration SQL; `db:migrate` applies. Commit: `feat(db): drizzle client, identity + billing schema (PRD §23.1)`

### Task FND-6: `packages/db` — project/spec/run/event/release/security tables + tenant scoping

**Files:** Create: `src/schema/projects.ts`, `src/schema/planning.ts`, `src/schema/execution.ts`, `src/schema/releases.ts`, `src/schema/security.ts`, `src/tenant.ts`, `test/integration/tenant.test.ts`, migration SQL for `agent_events` partitioning
**Interfaces produced:**
- Tables exactly per PRD §23.2–23.6: `projects`, `repositories`, `branches`, `environments`, `project_contracts`, `specifications`, `decisions`, `agent_runs`, `agent_phases`, `agent_tasks`, `approvals`, `workspaces`, `agent_events`, `artifacts`, `test_runs`, `test_cases`, `verification_results`, `releases`, `deployments`, `synthetic_checks`, `secret_metadata`, `integration_connections`, `audit_events`.
- `agent_events`: `PARTITION BY RANGE (occurred_at)` monthly (raw SQL migration; drizzle table maps the parent), unique `(run_id, sequence)`, payload `jsonb` with a CHECK `pg_column_size(payload_json) <= 65536`.
- `TenantDb` helper: `forOrg(db, organizationId)` returning repositories whose every query auto-filters by `organization_id` (projects, runs, events join through projects for tables without the column — `agent_runs.project_id → projects.organization_id` denormalized: **add `organization_id` column to every tenant-owned table** for direct scoping and simpler partition pruning: projects, agent_runs, agent_events, artifacts, releases, workspaces, secret_metadata, audit_events already have it per PRD; add to branches, environments, specifications, agent_phases via migration note).
- `run_event_counters` table (`run_id` pk, `last_sequence` bigint) + `nextEventSequence(tx, runId)` helper using `INSERT ... ON CONFLICT DO UPDATE SET last_sequence = run_event_counters.last_sequence + 1 RETURNING last_sequence`.
**Effort:** L

- [ ] **Step 1:** Failing integration test `tenant.test.ts`: seed two orgs each with a project + run + 3 events; `forOrg(db, orgA).projects.list()` returns only org A's; `forOrg(db, orgA).events.byRun(runB.id)` returns `[]` (not error — invisible); `nextEventSequence` called 100× concurrently for one run yields 1..100 with no gaps/dupes.
- [ ] **Step 2:** Implement schema files (columns exactly as PRD §23 lists; all FKs; status/text enums as in contracts package), partition migration (create parent + 12 monthly partitions + a `create_next_partition()` SQL function), tenant helper, sequence helper.
- [ ] **Step 3:** Tests pass against compose Postgres. Commit: `feat(db): full PRD §23 schema, event partitioning, tenant-scoped repositories`

### Task FND-7: Local dev environment

**Files:** Create: `infra/docker/docker-compose.dev.yml`, `infra/docker/forgejo/app.ini`, `.env.example`, `docs/dev-setup.md`, `scripts/dev-up.sh`
**Effort:** M

- [ ] **Step 1:** Compose services: `postgres:16` (port 5432, db `zapp`), `redis:7` (6379), `codeberg.org/forgejo/forgejo:9` (3300 HTTP, 2222 SSH, pre-configured admin via app.ini + init script), `temporalio/auto-setup` dev stack or documented `temporal server start-dev` (7233 + UI 8233), `minio/minio` (9000/9001, bucket `zapp-artifacts` auto-created), `localstack/localstack` (4566, services SQS/SNS/SES; init script creates queues `zapp-usage-events`, `zapp-github-webhooks`, `zapp-notifications` each with DLQ, and verifies SES sender `dev@zapp.local`).
- [ ] **Step 2:** `.env.example` with every variable services will need (DATABASE_URL, REDIS_URL, ARTIFACT_ENDPOINT/KEY/SECRET/BUCKET, FORGEJO_URL/ADMIN_TOKEN, TEMPORAL_ADDRESS, STYTCH_PROJECT_ID/SECRET/PUBLIC_TOKEN, FLEXPRICE_API_KEY/BASE_URL, GRAFANA_OTLP_ENDPOINT/TOKEN, POSTHOG_KEY/HOST, AWS_REGION/AWS_ENDPOINT_URL/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (LocalStack test values locally), MODAL_*, provider keys) — placeholder values, real keys never committed.
- [ ] **Step 3:** `scripts/dev-up.sh`: compose up, wait-for healthchecks, run `pnpm db:migrate`, create Forgejo admin token if absent, create MinIO bucket. Verify: script exits 0 from clean state.
- [ ] **Step 4:** `docs/dev-setup.md`: prerequisites (Node 22, pnpm, Docker, temporal CLI), one-command bootstrap, service URLs table. Commit: `chore(infra): docker-compose dev environment + bootstrap script`

### Task FND-8: CI pipeline

**Files:** Create: `.github/workflows/ci.yml`, `.github/workflows/security.yml`
**Effort:** M

- [ ] **Step 1:** `ci.yml`: on PR + main push → pnpm install (cache), `turbo run lint typecheck build test` (turbo remote cache via GitHub artifacts or Vercel cache), then `test:integration` job with service containers (postgres, redis) running FND-5/6 integration suites. Matrix not needed (single Node 22).
- [ ] **Step 2:** `security.yml`: gitleaks action (secret scan, fails on findings), `osv-scanner` on lockfile (advisory in M0: `continue-on-error: true` with report, flips to blocking in M5/OPS-13).
- [ ] **Step 3:** Verify: push branch, both workflows green. Commit: `ci: lint/typecheck/test/integration + secret/dependency scanning`

### Task FND-9: License boundary & ADR scaffold

**Files:** Create: `NOTICE`, `docs/adr/0000-template.md`, `docs/adr/0001-locked-p0-decisions.md`, `eslint-rules/no-dyad-pro-imports.mjs` (flat-config custom rule), CI grep step
**Effort:** S

- [ ] **Step 1:** `NOTICE`: Apache 2.0 attribution block for Dyad-derived code, listing `apps/desktop` + any `packages/dyad-*` as derived; maintenance instruction (update on every upstream merge).
- [ ] **Step 2:** ESLint rule + CI step: fail on any import path matching `/src\/pro|@dyad.*\/pro/` anywhere in repo. Test: fixture file with such an import fails lint.
- [ ] **Step 3:** `docs/adr/0001-locked-p0-decisions.md`: copy the master plan §2 decision table (source of truth for deviations).
- [ ] **Step 4:** Commit: `chore: license NOTICE, src/pro import ban, ADR scaffold`

### Task FND-10: Shared error envelope & API conventions

**Files:** Create: `packages/contracts/src/api.ts`, `test/api.test.ts`
**Interfaces produced (binding for CP + all services):**

```ts
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),            // machine code: "project_not_found", "budget_exceeded", ...
    message: z.string(),         // human, tenant-safe, no secrets/internals
    requestId: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export const PageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }); // keyset pagination everywhere
export const IdempotencyHeader = "idempotency-key";
```

**Effort:** S

- [ ] **Step 1:** Failing test: error schema round-trips; page schema generic works. **Step 2:** implement. **Step 3:** Commit: `feat(contracts): API error envelope + keyset pagination conventions`

---

## Testing strategy
- Unit tests colocated per package (Vitest). Integration tests (`test/integration/*`) require compose services and run in the dedicated CI job.
- The tenant-scoping test (FND-6) is the seed of the permanent **tenant-isolation suite** — plans 02/10 extend it; it must stay green in CI forever.

## Security & tenancy notes
- `.env` files are git-ignored; `.env.example` documents names only. gitleaks enforces from first commit.
- `usage_ledger` and `audit_events` are append-only by convention here, enforced by revoked UPDATE/DELETE grants in CP-1 migration.

## Self-review checklist (run after all tasks)
- [ ] Every table in PRD §23 exists in `packages/db` with matching columns.
- [ ] `AGENT_EVENT_TYPES` matches PRD §14.4 exactly (34 types).
- [ ] `TOOL_NAMES` matches PRD §16.1 exactly.
- [ ] No package besides contracts is imported by both a service and a client without going through contracts/api-client.

## Execution log

- (empty — plan not yet executed)
- 2026-08-03: FND-0 done (repo init, 8edc125). FND-1 done (b1de22a, review approved; Important fix applied in follow-up commit: turbo globalDependencies + .prettierignore). Minors deferred to final review: test:integration dependsOn (resolve FND-8), lib ES2023 note, decorative @ts-check.
- 2026-08-03: FND-2 done (49e5ebe + fix ab0362c, review clean; error-formula deviation approved). Plan amendments: AGENT_EVENT_TYPES count corrected 30→34 vs PRD §14.4; contracts dep constraint now zod+ulid.
