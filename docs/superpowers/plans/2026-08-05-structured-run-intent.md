# Structured Run Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the user's web/mobile target and policy-approved model choice through the versioned run API, durable row, orchestrator boundary, generated SDK, and WEB-3 home flow.

**Architecture:** A shared Zod run-intent contract defines `appType` and model identifiers. The control plane validates explicit models against the selected organization's policy before persisting the intent, stores both values on `agent_runs`, and passes them to the durable orchestrator port. OpenAPI and the generated SDK expose the same public fields before WEB-3 enables either selector.

**Tech Stack:** TypeScript, Zod, Fastify, Drizzle/PostgreSQL, OpenAPI, openapi-typescript, React/Next.js, Playwright, Vitest.

## Global Constraints

- API first: the UI consumes only `/v1` through the generated `@zapp/api-client`.
- Zod validates every new service boundary; TypeScript types are inferred from schemas.
- `appType` is exactly `"web" | "mobile"`; omitted public input defaults durably to `"web"`.
- `model` is omitted/null for policy-managed automatic routing; an explicit value must be in the selected organization's allowed set, extracted compatibly from either `defaultModelPolicy: string[]` or `defaultModelPolicy: { allowedModels: string[] }`.
- New run intent is persisted before Temporal dispatch and is stable under an idempotent retry.
- Cross-tenant behavior remains 404, never 403; no model-provider SDK call is introduced outside `services/model-gateway`.
- No secret, TODO/FIXME, skipped test, private UI endpoint, or prose-encoded run intent.

---

### Task 1: Accept ADR-0009 and bind the authored plans

**Files:**
- Modify: `docs/adr/0009-structured-run-target-and-model-selection.md`
- Modify: `docs/plans/02-control-plane.md`
- Modify: `docs/plans/04-agent-runtime.md`
- Modify: `docs/plans/08-web-ux.md`

**Interfaces:**
- Produces: accepted names `appType` and `model`, with the persistence/default/validation semantics in this plan's Global Constraints.

- [ ] **Step 1: Record controller approval**

Change ADR-0009 status from `Proposed` to `Accepted` and record that the controller exercised the user's explicit delegated-decision authority on 2026-08-04.

- [ ] **Step 2: Update binding task interfaces**

Add the two request/read fields to CP-9 and AR-8, and state in WEB-3 that selectors remain disabled until the generated SDK includes them. Do not change any completed checkbox.

- [ ] **Step 3: Self-check the decision record**

Run:

```bash
rg -n 'Status: Accepted|appType|model' docs/adr/0009-structured-run-target-and-model-selection.md docs/plans/{02-control-plane,04-agent-runtime,08-web-ux}.md
git diff --check
```

Expected: all four documents use the exact same names and defaults; `git diff --check` emits no output.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0009-structured-run-target-and-model-selection.md docs/plans/02-control-plane.md docs/plans/04-agent-runtime.md docs/plans/08-web-ux.md docs/superpowers/plans/2026-08-05-structured-run-intent.md
git commit -m "docs(architecture): accept structured run intent"
```

### Task 2: Persist and dispatch structured run intent

**Files:**
- Create: `packages/contracts/src/run-intent.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/run-intent.test.ts`
- Modify: `packages/db/src/schema/planning.ts`
- Create: `packages/db/drizzle/0011_structured_run_intent.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `docs/zapp-build-prd.md`
- Test: `packages/db/test/schema-planning.test.ts`
- Test: `packages/db/test/prd-schema-conformance.test.ts`
- Create: `services/control-api/src/orgs/model-policy.ts`
- Test: `services/control-api/test/model-policy.test.ts`
- Modify: `services/control-api/src/orchestrator/port.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/src/tenant/view.ts`
- Modify: `services/control-api/src/routes/runs.ts`
- Modify: `services/control-api/src/app.ts`
- Modify: `services/control-api/test/support/tenant-db.ts`
- Test: `services/control-api/test/runs.test.ts`
- Test: `services/control-api/test/integration/tenant-isolation.test.ts`

**Interfaces:**
- Produces: `APP_TYPES`, `AppTypeSchema`, and `ModelIdentifierSchema` from `@zapp/contracts`.
- Produces: public create-run body `{ mode, prompt, branchId?, budget?, appType?, model? }` and run view `{ ..., appType, model }`.
- Produces: `StartRunInputSchema` fields `appType: AppTypeSchema` and `model: ModelIdentifierSchema.nullable()`.
- Consumes: `OrganizationStore.getSettings(organizationId)` and `defaultModelPolicy` shaped as either `string[]` or `{ allowedModels: string[] }`.

- [ ] **Step 1: Write shared-contract RED tests**

Add assertions equivalent to:

```ts
expect(AppTypeSchema.parse('web')).toBe('web');
expect(AppTypeSchema.parse('mobile')).toBe('mobile');
expect(() => AppTypeSchema.parse('desktop')).toThrow();
expect(ModelIdentifierSchema.parse('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
expect(() => ModelIdentifierSchema.parse(' model with spaces ')).toThrow();
```

Run `pnpm --filter @zapp/contracts test -- run-intent.test.ts`; expected RED is the missing exports/module.

- [ ] **Step 2: Implement the shared schemas**

Use a literal tuple for `APP_TYPES` and a bounded provider/model identifier (1–160 characters, alphanumeric first character, then alphanumeric plus `.`, `_`, `-`, `:`, and `/`). Export only schema-inferred types.

- [ ] **Step 3: Write persistence RED tests**

Update the exact `agent_runs` column assertion to include `app_type` immediately after `mode` and `model` immediately after `app_type`. Add row-type/store tests proving omitted intent becomes `appType: 'web', model: null` and explicit intent survives create/read unchanged.

Run `pnpm --filter @zapp/db test -- schema-planning.test.ts`; expected RED shows the two missing columns.

- [ ] **Step 4: Implement columns and forward-only migration**

Add:

```ts
appType: text('app_type', { enum: APP_TYPES }).notNull().default('web'),
model: text('model'),
```

Create migration `0011_structured_run_intent.sql` with `app_type text NOT NULL DEFAULT 'web'`, nullable `model`, and an `agent_runs_app_type_check` constraint. Append journal index 11 without rewriting prior migrations.
Update PRD §23.3's `agent_runs` list with `app_type` and `model` immediately after `mode`; keep the bidirectional PRD schema conformance test unchanged.

- [ ] **Step 5: Write model-policy RED tests**

Cover array policy, `{ allowedModels }`, duplicate/blank entries, malformed JSON values, missing policy, an allowed explicit model, and a denied explicit model. Expected public denial is `400 { error: 'model_not_allowed' }`; automatic/null routing remains allowed with any policy shape.

Run `pnpm --filter @zapp/control-api test -- model-policy.test.ts runs.test.ts`; expected RED is the absent policy helper and rejected new body fields.

- [ ] **Step 6: Implement policy validation and route/store propagation**

Create pure `allowedModelsFromPolicy(policy: unknown): ReadonlySet<string>` using `ModelIdentifierSchema.safeParse`. Inject `OrganizationStore` into `registerRunRoutes`; read settings only when `model` is explicit, reject absent/nonmatching policy, and never substitute an unapproved model. Parse the request as:

```ts
appType: AppTypeSchema.default('web'),
model: ModelIdentifierSchema.optional(),
```

Persist `appType` and `model ?? null`, include both in audit metadata and `RunSchema`, and pass the persisted values—not raw request values—to `StartRunInputSchema`.

- [ ] **Step 7: Add idempotency and tenant regression coverage**

In `runs.test.ts`, prove one operation key replay returns one row/start intent and a changed body conflicts. In tenant-isolation integration coverage, prove another organization's policy cannot authorize a model and the foreign project still returns 404.

- [ ] **Step 8: Run Task 2 verification**

```bash
pnpm --filter @zapp/contracts test -- run-intent.test.ts
pnpm --filter @zapp/db test -- schema-planning.test.ts schema-execution.test.ts
pnpm --filter @zapp/db test -- prd-schema-conformance.test.ts
pnpm --filter @zapp/control-api test -- model-policy.test.ts runs.test.ts boundary-schemas.test.ts route-isolation.test.ts
pnpm --filter @zapp/contracts lint && pnpm --filter @zapp/contracts typecheck && pnpm --filter @zapp/contracts build
pnpm --filter @zapp/db lint && pnpm --filter @zapp/db typecheck && pnpm --filter @zapp/db build
pnpm --filter @zapp/control-api lint && pnpm --filter @zapp/control-api typecheck && pnpm --filter @zapp/control-api build
git diff --check
```

Expected: all commands exit 0 with no skipped tests.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts packages/db services/control-api
git commit -m "feat(control-api): persist structured run intent"
```

### Task 3: Regenerate and verify the public SDK

**Files:**
- Modify (generated): `packages/api-client/openapi.json`
- Modify (generated): `packages/api-client/src/generated.ts`
- Modify (generated): `packages/api-client/src/generated-operations.ts`
- Test: `services/control-api/test/openapi-contract.test.ts`
- Test: `packages/api-client/test/client.test.ts`

**Interfaces:**
- Consumes: Task 2's create-run and run-view schemas.
- Produces: `paths['/v1/projects/{projectId}/runs']['post']` with optional `appType`/`model` request fields and required `appType` plus nullable `model` response fields.

- [ ] **Step 1: Write OpenAPI/SDK RED assertions**

Assert the create-run request advertises optional `appType` enum `[web,mobile]` and optional bounded `model`; assert the 201 run schema requires `appType` and `model`. Add a client typing/runtime fixture sending both fields through `createZappClient`.

Run `pnpm --filter @zapp/control-api test -- openapi-contract.test.ts`; expected RED is missing generated fields.

- [ ] **Step 2: Regenerate artifacts**

Run:

```bash
pnpm --filter @zapp/api-client generate
```

Do not hand-edit generated TypeScript or JSON.

- [ ] **Step 3: Verify generated drift and client gates**

```bash
pnpm --filter @zapp/control-api test -- openapi-contract.test.ts
pnpm --filter @zapp/api-client test
pnpm --filter @zapp/api-client lint
pnpm --filter @zapp/api-client typecheck
pnpm --filter @zapp/api-client build
git diff --check
```

Expected: generation is repeatable (`pnpm --filter @zapp/api-client generate` a second time produces no diff) and all commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add services/control-api/test/openapi-contract.test.ts packages/api-client
git commit -m "feat(api-client): expose structured run intent"
```

### Task 4: Wire WEB-3 selectors through the generated SDK

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/components/home/PromptComposer.tsx`
- Modify: `apps/web/src/components/home/Hero.tsx`
- Test: `apps/web/e2e/home.spec.ts`

**Interfaces:**
- Consumes: Task 3's generated create-run input with `appType` and `model`.
- Produces: a submitted home intent whose visible target/model choices exactly match the persisted run request.

- [ ] **Step 1: Integrate Tasks 1–3 into `task/WEB-3`**

Merge or cherry-pick the accepted ADR, control API, and generated SDK commits without discarding the existing WEB-3 changes or its local review fixes. Resolve only conflicts in the generated create-run type and home API wrapper.

- [ ] **Step 2: Write selector RED tests**

With `mobile-app-tab` enabled, select Mobile App and assert the POST body contains `appType: 'mobile'`. With an organization policy allowing two models, select one and assert the POST body contains that exact `model`. In Auto, assert `appType: 'web'` and no `model` field. Expected RED is that the current UI disables/discards these values.

- [ ] **Step 3: Implement selector propagation**

Keep Auto as the default. Enable Mobile App only under its PostHog flag. Render explicit model choices only from policy-approved names. Pass selections to `createRun`; never append them to prompt text or browser-only handoff state.

- [ ] **Step 4: Verify WEB-3**

```bash
pnpm --filter @zapp/web test:e2e -- --grep 'home'
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
pnpm --filter @zapp/web build
git diff --check
```

Expected: all WEB-3 acceptance and selector tests pass with no skips.

- [ ] **Step 5: Commit and record**

After independent spec and quality review, commit the complete WEB-3 task with its prescribed message:

```bash
git add apps/web docs/plans/08-web-ux.md tasks/todo.md
git commit -m "feat(web): prompt-first home screen"
```

Check WEB-3 only after the full task verification and append its Plan 08 execution-log line with exact evidence.
