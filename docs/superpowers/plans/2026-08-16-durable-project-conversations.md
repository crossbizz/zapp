# Durable Project Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each project own durable selectable conversation threads, preserve same-thread history across successor runs, and apply busy-run messages visibly at the next safe tool boundary.

**Architecture:** Add a tenant-scoped `conversations` aggregate above immutable agent runs, expose summaries and cross-run events through public `/v1` operations, and carry the selected conversation in the builder URL. Persist Builder session transcripts in PostgreSQL so an activity can yield after a completed tool without replaying the model turn; emit a structured `message.applied` event when a queued message enters that transcript.

**Tech Stack:** TypeScript 5.6, Zod, Drizzle/PostgreSQL, Fastify, generated OpenAPI client, Temporal 1.22, Next.js 15, React 19, Vitest, Playwright.

## Global Constraints

- New capabilities ship as versioned `/v1` API operations and generated SDK methods before the web client consumes them.
- Zod validates every service boundary and exported TypeScript types are inferred from schemas.
- Cross-tenant project, conversation, run, and event reads return 404.
- Every mutation is idempotent or keyed; one key is never reused across different routes or request bodies.
- Agent events stay append-only and clients never infer state by parsing assistant prose.
- Runs remain immutable execution and billing units; conversations group runs but do not reopen terminal runs.
- Existing histories are backfilled without deleting or rewriting run, event, billing, artifact, or Git data.
- A conversation has at most one active run in `queued`, `running`, `paused`, or `waiting_for_approval`.
- Tool execution is never cancelled merely to accept a new message.
- Real-provider verification runs at most once at the final acceptance gate; this feature requires no provider call.

---

### Task 1: CP-28 durable conversation schema and contracts

**Files:**
- Create: `docs/adr/0034-durable-project-conversations.md`
- Create: `packages/contracts/src/conversations.ts`
- Modify: `packages/contracts/src/id-schema.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/conversations.test.ts`
- Test: `packages/contracts/test/events.test.ts`
- Modify: `packages/db/src/schema/planning.ts`
- Modify: `packages/db/src/schema/execution.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/index.ts`
- Create: generated `packages/db/drizzle/0036_*.sql` and `packages/db/drizzle/meta/0036_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Test: `packages/db/test/schema-planning.test.ts`
- Test: `packages/db/test/schema-execution.test.ts`
- Test: `packages/db/test/integration/migrations.test.ts`
- Modify: `docs/plans/02-control-plane.md`
- Modify: `docs/plans/04-agent-runtime.md`
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes: existing `idSchema`, `AgentEventObjectSchema`, `agentRuns`, `agentEvents`, tenant composite project foreign keys.
- Produces: `ConversationSchema`, `ConversationSummarySchema`, `ConversationEventSchema`, `ConversationPageSchema`, `ConversationEventPageSchema`, `MessageAppliedPayloadSchema`, `conversations`, immutable run-linked `conversationContextArtifacts`, `builderSessionTranscripts`, and required `agentRuns.conversationId` / `agentRuns.conversationRunNumber` fields.

- [x] **Step 1: Write failing contract tests**

```ts
it('validates durable conversation summaries and cross-run event identities', () => {
  expect(idSchema('conv').parse(`conv_${'0'.repeat(26)}`)).toMatch(/^conv_/u);
  expect(ConversationSummarySchema.parse({
    id: `conv_${'0'.repeat(26)}`,
    projectId: `proj_${'1'.repeat(26)}`,
    title: 'Repair checkout preview',
    createdAt: '2026-08-16T12:00:00.000Z',
    updatedAt: '2026-08-16T12:01:00.000Z',
    latestRun: { id: `run_${'2'.repeat(26)}`, status: 'running' },
    runCount: 2,
  }).runCount).toBe(2);
});

it('accepts only structured message.applied payloads', () => {
  expect(MessageAppliedPayloadSchema.parse({
    messageId: `msg_${'3'.repeat(26)}`,
    operationKey: `op_${'a'.repeat(64)}`,
  })).toEqual({
    messageId: `msg_${'3'.repeat(26)}`,
    operationKey: `op_${'a'.repeat(64)}`,
  });
});
```

- [x] **Step 2: Run contract tests to verify RED**

Run: `pnpm --filter @zapp/contracts test -- conversations.test.ts events.test.ts`

Expected: FAIL because `conv`, conversation schemas, and `message.applied` do not exist.

- [x] **Step 3: Implement the conversation and event schemas**

```ts
export const ConversationSummarySchema = z.object({
  id: idSchema('conv'),
  projectId: idSchema('proj'),
  title: z.string().trim().min(1).max(160),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  latestRun: z.object({ id: idSchema('run'), status: z.string().min(1) }).strict(),
  runCount: z.number().int().positive(),
}).strict();

export const ConversationEventSchema = z.object({
  runNumber: z.number().int().positive(),
  event: AgentEventObjectSchema,
}).strict();

export const MessageAppliedPayloadSchema = z.object({
  messageId: z.string().regex(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u),
  operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
}).strict();
```

Add `conv` to the closed ID prefix union, add `message.applied` to `AGENT_EVENT_TYPES`, validate its payload in the event discriminant/refinement, and export all new schemas from `@zapp/contracts`.

- [x] **Step 4: Write failing database schema and migration tests**

```ts
it('defines one ordered conversation and durable transcript per scoped run task', () => {
  expect(getTableName(conversations)).toBe('conversations');
  expect(getTableName(builderSessionTranscripts)).toBe('builder_session_transcripts');
  expect(agentRuns.conversationId.notNull).toBe(true);
  expect(agentRuns.conversationRunNumber.notNull).toBe(true);
});
```

Extend the migration integration fixture with two legacy runs and assert after migration that each has a distinct `conv_*` id and run number `1`, while event and run-credit-account counts are unchanged.

- [x] **Step 5: Run database tests to verify RED**

Run: `pnpm --filter @zapp/db test -- schema-planning.test.ts schema-execution.test.ts`

Expected: FAIL because the tables and run columns do not exist.

- [x] **Step 6: Implement Drizzle schema and generate migration 0036**

```ts
export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  organizationId: organizationId(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => users.id),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('conversations_id_org_idx').on(t.id, t.organizationId),
  index('conversations_project_updated_idx').on(t.projectId, t.updatedAt.desc(), t.id.desc()),
  projectTenantForeignKey('conversations', t.projectId, t.organizationId),
]);

export const builderSessionTranscripts = pgTable('builder_session_transcripts', {
  runId: text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  organizationId: organizationId(),
  taskId: text('task_id').notNull(),
  version: integer('version').notNull(),
  transcriptJson: jsonb('transcript_json').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.runId, t.taskId] }),
  check('builder_session_transcripts_version_check', sql`${t.version} >= 0`),
]);

export const conversationContextArtifacts = pgTable('conversation_context_artifacts', {
  id: text('id').primaryKey(),
  organizationId: organizationId(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  sourceRunId: text('source_run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  contextJson: jsonb('context_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('conversation_context_run_idx').on(t.runId),
  projectTenantForeignKey('conversation_context_artifacts', t.projectId, t.organizationId),
]);
```

Add `conversationId` and `conversationRunNumber` to `agentRuns`, the unique run-order index, and the partial unique active-run index. A successor's immutable context row links both the new run and its terminal source run without creating a circular schema dependency. Generate the migration with `pnpm --filter @zapp/db db:generate`, then edit only the generated migration so it creates deterministic legacy conversation IDs from each legacy run, backfills the two required run columns, makes them non-null, and leaves all existing dependent rows unchanged.

- [x] **Step 7: Run schema and migration tests to verify GREEN**

Run: `pnpm --filter @zapp/contracts test && pnpm --filter @zapp/db test && pnpm --filter @zapp/db test:integration`

Expected: all contract, schema, and migration tests pass; credential-gated tests skip visibly if PostgreSQL is unavailable.

- [x] **Step 8: Record the accepted ADR and official task contracts**

```markdown
# ADR-0034: Durable project conversations

**Status:** Accepted (product owner approval, 2026-08-16)

## Decision

Conversation is a tenant-scoped durable aggregate above immutable runs. Public history is structured and cross-run; successor runs retain server-owned context; queued messages are acknowledged with `message.applied`; project-card deletion reuses CP-17.
```

Add CP-28, AR-25, WEB-19, and WEB-20 task blocks with binding Files/Interfaces/Acceptance criteria to their owning plan files and unchecked tracker entries under M6 product corrections.

- [x] **Step 9: Verify and commit CP-28 schema foundation**

Run: `pnpm --filter @zapp/contracts lint && pnpm --filter @zapp/contracts typecheck && pnpm --filter @zapp/db lint && pnpm --filter @zapp/db typecheck && git diff --check`

Commit:

```bash
git add docs/adr/0034-durable-project-conversations.md docs/plans/02-control-plane.md docs/plans/04-agent-runtime.md docs/plans/08-web-ux.md tasks/todo.md packages/contracts packages/db
git commit -m "feat(db): add durable project conversations"
```

### Task 2: CP-28 public conversation history and successor-run API

**Files:**
- Create: `services/control-api/src/routes/conversations.ts`
- Modify: `services/control-api/src/routes/runs.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/src/tenant/view.ts`
- Modify: `services/control-api/src/app.ts`
- Modify: `services/control-api/src/openapi.ts`
- Test: `services/control-api/test/conversations.test.ts`
- Test: `services/control-api/test/runs.test.ts`
- Test: `services/control-api/test/openapi.test.ts`
- Test: `services/control-api/test/openapi-contract.test.ts`
- Test: `services/control-api/test/integration/conversations.test.ts`
- Modify: `packages/api-client/openapi.json`
- Modify: `packages/api-client/src/generated.ts`
- Modify: `packages/api-client/src/index.ts`
- Test: `packages/api-client/test/generated.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas/tables and existing keyed run creation, event ingestion, RBAC, tenant request context, audit hooks, pagination envelope.
- Produces: generated `listProjectConversations`, `listConversationEvents`, and optional `conversationId` on `createProjectRun`; atomic `TenantConversationRepository` methods.

- [x] **Step 1: Write failing route tests for list, history, creation, races, and 404s**

```ts
it('lists tenant conversations and ordered events across successor runs', async () => {
  const summaries = await app.inject(authenticatedGet(`/v1/projects/${projectId}/conversations`));
  expect(summaries.statusCode).toBe(200);
  expect(summaries.json().items[0]).toMatchObject({ id: conversationId, runCount: 2 });
  const history = await app.inject(authenticatedGet(`/v1/conversations/${conversationId}/events`));
  expect(history.json().items.map((item: { runNumber: number; event: { sequence: number } }) =>
    [item.runNumber, item.event.sequence])).toEqual([[1, 1], [1, 2], [2, 1]]);
});

it('returns conversation_run_active for a concurrent successor', async () => {
  const response = await app.inject(authenticatedPost(`/v1/projects/${projectId}/runs`, {
    ...runBody,
    conversationId,
  }));
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe('conversation_run_active');
});
```

- [x] **Step 2: Run focused control-api tests to verify RED**

Run: `pnpm --filter @zapp/control-api test -- conversations.test.ts runs.test.ts`

Expected: FAIL with missing routes and `conversationId` rejected by the strict body schema.

- [x] **Step 3: Implement atomic tenant repositories**

```ts
export interface TenantConversationRepository {
  list(projectId: string, request: PageRequest): Promise<StorePage<ConversationSummary>>;
  getById(conversationId: string): Promise<Conversation | undefined>;
  events(conversationId: string, request: PageRequest): Promise<StorePage<ConversationEvent>>;
  createRun(input: NewConversationRunInput): Promise<RunCreateResult | 'active_run'>;
}
```

Use a transaction and a conversation row lock for create/new-successor. Omitted `conversationId` inserts `stableId('conv', operationKey)` and run number `1`; supplied `conversationId` verifies project ownership, rejects an active run, and inserts `max(run_number)+1`. For a successor, select only prior structured `message.user`/`message.assistant` events in run order, bound them to the existing context token ceiling, insert one immutable `conversationContextArtifacts` row with a deterministic `art_*` id and SHA-256 hash, and link it to the new run through its unique `runId`. Update `conversations.updated_at` in the same transaction. Derive the title from the first 160 normalized characters of the first user prompt.

- [x] **Step 4: Implement public routes and extend create-run dispatch**

```ts
const CreateRunBodyShape = {
  prompt: z.string().trim().min(1).max(20_000),
  conversationId: idSchema('conv').optional(),
  branchId: idSchema('br').optional(),
  budget: RunBudgetSchema.optional(),
  appType: AppTypeSchema.default('web'),
  model: ModelIdentifierSchema.optional(),
} as const;
```

Register both GET routes with session+tenant middleware, authorize project access, and return 404 for foreign/missing resources. Return 201 `{ run, conversation }` from run creation. For successor runs, load and hash-check the linked immutable context artifact and include its bounded projection in the workflow prompt under a structurally delimited `Prior conversation context` section; do not accept context text from the browser. If artifact creation or validation fails, the transaction creates neither run nor conversation mutation.

- [x] **Step 5: Run route and tenant integration tests to verify GREEN**

Run: `pnpm --filter @zapp/control-api test -- conversations.test.ts runs.test.ts && pnpm --filter @zapp/control-api test:integration -- conversations.test.ts`

Expected: focused unit tests and PostgreSQL ordering/race/isolation tests pass.

- [x] **Step 6: Regenerate OpenAPI and SDK, then verify contract inventory**

Run: `pnpm openapi:generate`

Expected: generated methods include `listProjectConversations`, `listConversationEvents`, and the additive create-run field/response.

Run: `pnpm --filter @zapp/control-api test -- openapi.test.ts openapi-contract.test.ts && pnpm --filter @zapp/api-client test`

Expected: public inventory and generated client tests pass.

- [x] **Step 7: Verify and commit CP-28 API**

Run: `pnpm --filter @zapp/control-api lint && pnpm --filter @zapp/control-api typecheck && pnpm --filter @zapp/control-api build && pnpm --filter @zapp/api-client lint && pnpm --filter @zapp/api-client typecheck && pnpm --filter @zapp/api-client build && git diff --check`

Append the CP-28 execution-log line, check CP-28 in `tasks/todo.md`, and commit:

```bash
git add services/control-api packages/api-client docs/plans/02-control-plane.md tasks/todo.md
git commit -m "feat(control-api): expose durable conversation history"
```

### Task 3: AR-25 safe queued-message application

**Files:**
- Modify: `services/orchestrator-worker/src/session/transcript.ts`
- Modify: `services/orchestrator-worker/src/activities/session.ts`
- Modify: `services/orchestrator-worker/src/runtime/run-worker.ts`
- Modify: `services/orchestrator-worker/src/workflows/run.ts`
- Test: `services/orchestrator-worker/test/session.test.ts`
- Test: `services/orchestrator-worker/test/m1-session.test.ts`
- Test: `services/orchestrator-worker/test/integration/m1-run.test.ts`
- Test: `services/orchestrator-worker/test/integration/signals.test.ts`
- Test: `services/orchestrator-worker/test/integration/conversation-events.test.ts`

**Interfaces:**
- Consumes: `builderSessionTranscripts`, `MessageAppliedPayloadSchema`, existing `TranscriptStore`, message signal queue, CP-13 event batcher.
- Produces: `DatabaseTranscriptStore`, safe `yieldAfterTool: true` production behavior, exactly-once `message.applied` events keyed by message operation.

- [x] **Step 1: Write failing durable-store and safe-boundary tests**

```ts
it('persists a yielded transcript and resumes without replaying the first model turn', async () => {
  const first = await activities.runBuilderSession(input({ yieldAfterTool: true }));
  expect(first.status).toBe('yielded');
  const second = await activities.runBuilderSession(input({
    yieldAfterTool: true,
    message: queuedMessage,
  }));
  expect(second.messageApplied).toBe(true);
  expect(gateway.requests).toHaveLength(2);
  expect(tool.executions).toHaveLength(1);
});
```

Add a real Temporal test that blocks a tool, signals a message, asserts pending count `1`, releases the tool, observes `message.applied`, and proves the message appears exactly once in the next model request.

- [x] **Step 2: Run focused worker tests to verify RED**

Run: `pnpm --filter @zapp/orchestrator-worker test -- session.test.ts m1-session.test.ts integration/signals.test.ts`

Expected: FAIL because a new activity starts from an empty heartbeat-only transcript and production sets `yieldAfterTool: false`.

- [x] **Step 3: Implement the PostgreSQL transcript store**

```ts
export class DatabaseTranscriptStore implements TranscriptStore {
  constructor(
    private readonly database: Database,
    private readonly scope: { organizationId: string; runId: string; taskId: string },
  ) {}

  load(key: unknown): Promise<SessionTranscript | undefined>;
  save(expectedVersion: number | null, transcript: unknown): Promise<SessionTranscript>;
}
```

Both methods validate the key and tenant/run scope. `save` uses `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE version = expectedVersion RETURNING` and throws `TranscriptConflictError` on a lost compare-and-swap. Reject serialized transcripts larger than `MAX_TEMPORAL_TRANSCRIPT_BYTES`. Keep activity heartbeats as retry checkpoints, but seed the checkpoint store from the newer of heartbeat and database versions and persist every successful save to both.

- [x] **Step 4: Yield production sessions and emit applied acknowledgements**

```ts
control: {
  yieldAfterTool: true,
  redirect: pendingRedirects[0] ?? null,
  message: pendingMessages[0] ?? null,
}
```

After a session result reports `messageApplied`, emit one `message.applied` event with `{ messageId, operationKey }` using event key `message-applied-<operation suffix>`, then shift the queue. Do not emit before transcript persistence succeeds. Continue-as-new after every yielded tool boundary while queued controls remain observable.

- [x] **Step 5: Run worker tests to verify GREEN**

Run: `pnpm --filter @zapp/orchestrator-worker test`

Expected: all worker unit tests pass, including no first-turn/tool replay and exactly-once application.

Run: `pnpm exec vitest run services/orchestrator-worker/test/integration/signals.test.ts services/orchestrator-worker/test/integration/conversation-events.test.ts --no-file-parallelism`

Expected: real Temporal signal tests pass serially.

- [x] **Step 6: Verify and commit AR-25**

Run: `pnpm --filter @zapp/orchestrator-worker lint && pnpm --filter @zapp/orchestrator-worker typecheck && pnpm --filter @zapp/orchestrator-worker build && git diff --check`

Append the AR-25 execution-log line, check AR-25 in `tasks/todo.md`, and commit:

```bash
git add services/orchestrator-worker docs/plans/04-agent-runtime.md tasks/todo.md
git commit -m "feat(orchestrator): apply queued messages safely"
```

### Task 4: WEB-19 history, new-thread, and same-thread continuity

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/hooks/useProjectConversations.ts`
- Create: `apps/web/src/hooks/useConversationEvents.ts`
- Create: `apps/web/src/components/conversation/ConversationHistoryDrawer.tsx`
- Modify: `apps/web/src/components/conversation/Thread.tsx`
- Modify: `apps/web/src/components/conversation/MessageBubble.tsx`
- Modify: `apps/web/src/components/builder/TopBar.tsx`
- Modify: `apps/web/src/components/builder/Shell.tsx`
- Modify: `apps/web/src/components/builder/builder.module.css`
- Test: `apps/web/e2e/conversation.spec.ts`

**Interfaces:**
- Consumes: generated CP-28 SDK operations, cross-run event identity `(runId, sequence)`, `message.applied`, existing active-run SSE subscription and composer.
- Produces: URL-selected project conversation, paginated history drawer, explicit blank new-thread state, queued/applied user-message status.

- [x] **Step 1: Write failing Playwright acceptance cases**

```ts
test('restores history, keeps same-thread messages, and creates a new thread explicitly', async ({ page }) => {
  await openBuilderWithTwoConversations(page);
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('button', { name: 'Repair checkout preview' }).click();
  await expect(page).toHaveURL(/conversation=conv_/u);
  await expect(page.getByText('First request')).toBeVisible();
  await expect(page.getByText('Follow-up request')).toBeVisible();
  await page.reload();
  await expect(page.getByText('First request')).toBeVisible();
  await page.getByRole('button', { name: 'New thread' }).click();
  await expect(page).toHaveURL(/conversation=new/u);
  await expect(page.getByText('No conversation yet')).toBeVisible();
});
```

Add cases for terminal same-thread successor creation, no empty conversation before first send, Queued → Applied, Back/Forward selection, and organization-switch stale-response fencing.

- [x] **Step 2: Run focused browser tests to verify RED**

Run: `pnpm --filter @zapp/web exec playwright test e2e/conversation.spec.ts --grep "history|new thread|Queued"`

Expected: FAIL because History/New thread controls and conversation endpoints are not consumed.

- [x] **Step 3: Add API wrappers and conversation hooks**

```ts
export function conversationEventKey(event: ConversationEvent): string {
  return `${event.event.runId}:${String(event.event.sequence)}`;
}

export interface ConversationSelection {
  readonly kind: 'existing' | 'new';
  readonly conversationId?: string;
}
```

`useProjectConversations` pages summaries, derives selection only from `?conversation=`, selects newest only when the parameter is absent, and uses generation+abort fencing on organization/project changes. `useConversationEvents` pages historical events and merges the active run SSE without duplicates by `(runId, sequence)`.

- [x] **Step 4: Render the drawer and preserve same-thread transcript during sends**

```tsx
<ConversationHistoryDrawer
  conversations={conversations}
  onNewThread={() => selectConversation('new')}
  onSelect={(id) => selectConversation(id)}
  selected={selection}
/>
```

Refactor `Thread` to submit active-run messages through continuation, terminal-run messages through create-run with `conversationId`, and blank new-thread sends through create-run without it. Keep historical items mounted when a successor becomes active. Store optimistic messages by stable `messageId`; label them `Queued` until matching `message.applied`, then `Applied` until the next assistant event.

- [x] **Step 5: Run the conversation suite to verify GREEN**

Run: `pnpm --filter @zapp/web exec playwright test e2e/conversation.spec.ts`

Expected: all conversation tests pass, including existing cards, controls, uploads, and lifecycle behavior.

- [x] **Step 6: Run web and repository gates**

Run: `pnpm --filter @zapp/web lint && pnpm --filter @zapp/web typecheck && pnpm --filter @zapp/web build`

Expected: lint, typecheck, and production build pass.

Run: `pnpm verify`

Expected: repository gate passes; no real provider call is required.

- [x] **Step 7: Record and commit WEB-19**

Append the WEB-19 execution-log line, check WEB-19 in `tasks/todo.md`, and commit:

```bash
git add apps/web docs/plans/08-web-ux.md tasks/todo.md
git commit -m "feat(web): add durable project conversation history"
```
