import { z } from 'zod';
import type { ServiceAudience } from '@zapp/config';
import {
  AgentEventObjectSchema,
  AgentEventSchema,
  newId,
} from '@zapp/contracts';
import {
  agentPhases,
  agentRuns,
  agentTasks,
  createDb,
  decisions,
  organizations,
  projects,
  users,
  workspaces,
} from '@zapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { createDbUserStore } from '../../src/auth/users.js';
import { SERVICE_TOKEN_HEADER } from '../../src/internal/service-auth.js';
import { createInMemoryInviteStore } from '../../src/orgs/invites.js';
import { createDbOrganizationStore } from '../../src/orgs/store.js';
import { createDbAuditSink } from '../../src/plugins/audit.js';
import { createTenantDbFactory } from '../../src/tenant/db.js';
import { FakeAuthPort } from '../support/fake-auth-port.js';
import { TEST_AUTH_CONFIG, TEST_MASTER_KEY, TEST_RATE_LIMITS } from '../support/harness.js';
import { TestServiceTokens } from '../support/service-tokens.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

const EVENTS_INGEST_AUDIENCE = 'control-api:events.ingest' as ServiceAudience;
const EventInputSchema = AgentEventObjectSchema.omit({ id: true, sequence: true }).strict();
const EventResponseSchema = z.object({ events: z.array(AgentEventSchema) }).strict();

describe.skipIf(!hasDatabase)('POST /internal/runs/:runId/events', () => {
  let database: TestDatabase;
  let app: AppInstance;
  let tokens: TestServiceTokens;
  let organizationId: string;
  let projectId: string;
  let runId: string;
  let phaseId: string;
  let taskId: string;
  let secondPhaseId: string;
  let secondTaskId: string;
  let auditFails = false;

  beforeAll(async () => {
    database = await setUpTestDatabase();
    tokens = new TestServiceTokens();
    const realAudit = createDbAuditSink(database.db);
    app = buildApp({
      logger: false,
      auth: {
        port: new FakeAuthPort(),
        users: createDbUserStore(database.db),
        config: TEST_AUTH_CONFIG,
      },
      orgs: {
        organizations: createDbOrganizationStore(database.db),
        invites: createInMemoryInviteStore(),
        audit: {
          async record(tx, event) {
            await realAudit.record(tx, event);
            if (auditFails) throw new Error('forced CP-13 audit failure');
          },
          async recordDetached(event) {
            await realAudit.recordDetached(event);
            if (auditFails) throw new Error('forced CP-13 audit failure');
          },
          async recordDetachedOnce(key, event) {
            await realAudit.recordDetachedOnce(key, event);
            if (auditFails) throw new Error('forced CP-13 audit failure');
          },
        },
      },
      tenant: { tenantDb: createTenantDbFactory(database.db) },
      secrets: { masterKey: TEST_MASTER_KEY, serviceTokens: tokens.verifier },
      limits: { config: TEST_RATE_LIMITS },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  beforeEach(async () => {
    auditFails = false;
    await database.truncateIdentity();
    const userId = newId('user');
    organizationId = newId('org');
    projectId = newId('proj');
    runId = newId('run');
    phaseId = newId('phase');
    taskId = newId('task');
    secondPhaseId = newId('phase');
    secondTaskId = newId('task');

    await database.db.insert(users).values({
      id: userId,
      email: `${userId}@events.test`,
      displayName: 'Event Owner',
      avatarUrl: null,
      externalId: null,
    });
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'Events Org',
      slug: `events-${organizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
      billingCustomerId: null,
    });
    await database.db.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'Events Project',
      slug: `events-${projectId.slice(-8).toLowerCase()}`,
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: userId,
    });
    await database.db.insert(agentRuns).values({
      id: runId,
      organizationId,
      projectId,
      branchId: null,
      mode: 'build',
      requestFingerprint: `seed:${runId}`,
      status: 'running',
      specificationId: null,
      temporalWorkflowId: runId,
      startedBy: userId,
      budgetJson: null,
      planMaxCredits: '1000.0000',
    });
    await database.db.insert(agentPhases).values({
      id: phaseId,
      organizationId,
      runId,
      sequence: 1,
      title: 'Implement ingestion',
      status: 'running',
      acceptanceCriteriaJson: [],
    });
    await database.db.insert(agentTasks).values({
      id: taskId,
      organizationId,
      phaseId,
      parentTaskId: null,
      title: 'Persist event batch',
      status: 'running',
      riskLevel: 'low',
      baseCommitSha: null,
      outputCommitSha: null,
      acceptanceCriteriaJson: [],
      dependenciesJson: [],
      assignedAgentRole: 'builder',
    });
    await database.db.insert(agentPhases).values({
      id: secondPhaseId,
      organizationId,
      runId,
      sequence: 2,
      title: 'Verify event semantics',
      status: 'queued',
      acceptanceCriteriaJson: [],
    });
    await database.db.insert(agentTasks).values({
      id: secondTaskId,
      organizationId,
      phaseId: secondPhaseId,
      parentTaskId: null,
      title: 'Reject mismatched event context',
      status: 'queued',
      riskLevel: 'low',
      baseCommitSha: null,
      outputCommitSha: null,
      acceptanceCriteriaJson: [],
      dependenciesJson: [],
      assignedAgentRole: 'builder',
    });
  });

  function event(overrides: Record<string, unknown> = {}) {
    return EventInputSchema.parse({
      runId,
      occurredAt: '2026-08-04T12:00:00.000Z',
      organizationId,
      projectId,
      type: 'run.started',
      visibility: 'internal',
      payload: { source: 'orchestrator' },
      ...overrides,
    });
  }

  async function post(
    events: readonly z.input<typeof EventInputSchema>[],
    options: {
      readonly key?: string;
      readonly token?: string;
      readonly service?: 'orchestrator-worker' | 'sandbox-service' | 'git-service';
      readonly audience?: ServiceAudience;
      readonly headers?: Record<string, string>;
      readonly pathRunId?: string;
      readonly remoteAddress?: string;
    } = {},
  ) {
    const service = options.service ?? 'orchestrator-worker';
    const token =
      options.token ??
      (await tokens.issue(service, { aud: options.audience ?? EVENTS_INGEST_AUDIENCE }));
    return await app.inject({
      method: 'POST',
      url: `/internal/runs/${options.pathRunId ?? runId}/events`,
      headers: {
        [SERVICE_TOKEN_HEADER]: token,
        ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
        ...options.headers,
      },
      ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
      payload: events,
    });
  }

  async function count(table: 'agent_events' | 'run_event_counters' | 'audit_events'): Promise<number> {
    const [row] = await database.sql<{ count: string }[]>`
      select count(*)::text as count from ${database.sql(table)}
    `;
    return Number(row?.count ?? '-1');
  }

  async function counter(run = runId): Promise<number | undefined> {
    const [row] = await database.sql<{ last_sequence: string }[]>`
      select last_sequence::text from run_event_counters where run_id = ${run}
    `;
    return row === undefined ? undefined : Number(row.last_sequence);
  }

  async function jsonbPayloadBytes(payload: unknown): Promise<number> {
    const [row] = await database.sql<{ size: string }[]>`
      select pg_column_size(${JSON.stringify(payload)}::jsonb)::text as size
    `;
    return Number(row?.size ?? '-1');
  }

  async function expectRunNotFoundWithoutEffects(
    body: readonly z.input<typeof EventInputSchema>[],
    key: string,
  ): Promise<void> {
    const listener = createDb(database.url);
    const notifications: string[] = [];
    await listener.sql.listen('agent_events', (payload) => {
      notifications.push(payload);
    });
    try {
      const response = await post(body, { key });
      expect(response.statusCode, response.body).toBe(404);
      const error = response.json<{ error: { code: string; message: string; requestId: string } }>().error;
      expect(error.code).toBe('run_not_found');
      expect(error.message).toBe('That run does not exist.');
      expect(error.requestId.length).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await count('agent_events')).toBe(0);
      expect(await count('audit_events')).toBe(0);
      expect(await counter()).toBeUndefined();
      expect(notifications).toEqual([]);
    } finally {
      await listener.close();
    }
  }

  async function expectPayloadTooLargeWithoutEffects(
    payload: unknown,
    key: string,
  ): Promise<void> {
    const listener = createDb(database.url);
    const notifications: string[] = [];
    await listener.sql.listen('agent_events', (value) => {
      notifications.push(value);
    });
    try {
      const response = await post([event({ payload })], { key });
      expect(response.statusCode, response.body).toBe(413);
      expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'payload_too_large',
      });
      expect(response.body).toContain('artifacts');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await count('agent_events')).toBe(0);
      expect(await count('audit_events')).toBe(0);
      expect(await counter()).toBeUndefined();
      expect(notifications).toEqual([]);
    } finally {
      await listener.close();
    }
  }

  it('registers the service-only route and persists a complete committed batch', async () => {
    // Break caught: removing route registration, omitting any replay field, or
    // allocating anything other than contiguous one-based sequences.
    const inputs = [
      EventInputSchema.parse({
        runId,
        occurredAt: '2026-08-04T12:00:00.000Z',
        organizationId,
        projectId,
        phaseId,
        taskId,
        agentId: 'builder',
        type: 'task.started',
        visibility: 'internal',
        payload: { step: 'write failing test' },
      }),
      EventInputSchema.parse({
        runId,
        occurredAt: '2026-08-04T12:00:01.000Z',
        organizationId,
        projectId,
        agentId: 'builder',
        type: 'tool.output',
        visibility: 'user',
        payload: { message: 'event persisted' },
      }),
    ];

    const response = await app.inject({
      method: 'POST',
      url: `/internal/runs/${runId}/events`,
      headers: {
        [SERVICE_TOKEN_HEADER]: await tokens.issue('orchestrator-worker', {
          aud: EVENTS_INGEST_AUDIENCE,
        }),
        'idempotency-key': 'events-valid-batch-01',
      },
      payload: inputs,
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = EventResponseSchema.parse(response.json());
    for (const event of body.events) {
      expect(event.id).toMatch(/^evt_/);
    }
    const replayedWithoutIds = body.events.map((responseEvent) => {
      const { id, ...event } = responseEvent;
      void id;
      return event;
    });
    expect(replayedWithoutIds).toEqual([
      {
        runId,
        sequence: 1,
        occurredAt: '2026-08-04T12:00:00.000Z',
        organizationId,
        projectId,
        phaseId,
        taskId,
        agentId: 'builder',
        type: 'task.started',
        visibility: 'internal',
        payload: { step: 'write failing test' },
      },
      {
        runId,
        sequence: 2,
        occurredAt: '2026-08-04T12:00:01.000Z',
        organizationId,
        projectId,
        agentId: 'builder',
        type: 'tool.output',
        visibility: 'user',
        payload: { message: 'event persisted' },
      },
    ]);

    const persisted = await database.sql<{
      id: string;
      run_id: string;
      sequence: string;
      organization_id: string;
      project_id: string;
      phase_id: string | null;
      task_id: string | null;
      agent_id: string | null;
      type: string;
      visibility: string;
      occurred_at: string;
      payload_json: unknown;
    }[]>`
      select id, run_id, sequence::text, organization_id, project_id, phase_id, task_id, agent_id,
             type, visibility, occurred_at::text, payload_json
        from agent_events
       where run_id = ${runId}
       order by sequence
    `;
    expect(persisted).toEqual([
      expect.objectContaining({
        id: body.events[0]?.id,
        run_id: runId,
        sequence: '1',
        organization_id: organizationId,
        project_id: projectId,
        phase_id: phaseId,
        task_id: taskId,
        agent_id: 'builder',
        type: 'task.started',
        visibility: 'internal',
        payload_json: { step: 'write failing test' },
      }),
      expect.objectContaining({
        id: body.events[1]?.id,
        run_id: runId,
        sequence: '2',
        organization_id: organizationId,
        project_id: projectId,
        phase_id: null,
        task_id: null,
        agent_id: 'builder',
        type: 'tool.output',
        visibility: 'user',
        payload_json: { message: 'event persisted' },
      }),
    ]);
  });

  it('atomically rejects an expired control acknowledgement and applies a live one', async () => {
    const expired = await post(
      [
        event({
          type: 'run.paused',
          visibility: 'user',
          payload: {
            checkpointRef: 'checkpoint-expired-control',
            control: {
              operationKey: `op_${'e'.repeat(64)}`,
              acknowledgementDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
            },
          },
        }),
      ],
      { key: 'events-expired-control-ack-01' },
    );

    expect(expired.statusCode, expired.body).toBe(409);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe(
      'control_acknowledgement_expired',
    );
    expect(await count('agent_events')).toBe(0);
    expect(await count('audit_events')).toBe(0);
    expect(await counter()).toBeUndefined();
    expect(
      await database.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).toEqual([{ status: 'running' }]);

    const forged = await post(
      [
        event({
          type: 'run.paused',
          visibility: 'user',
          payload: {
            checkpointRef: 'checkpoint-forged-control',
            control: {
              operationKey: `op_${'a'.repeat(64)}`,
              acknowledgementDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        }),
      ],
      {
        key: 'events-forged-control-ack-01',
        service: 'sandbox-service',
      },
    );

    expect(forged.statusCode, forged.body).toBe(403);
    expect(await count('agent_events')).toBe(0);
    expect(await count('audit_events')).toBe(0);
    expect(await counter()).toBeUndefined();
    expect(
      await database.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).toEqual([{ status: 'running' }]);

    const live = await post(
      [
        event({
          type: 'run.paused',
          visibility: 'user',
          payload: {
            checkpointRef: 'checkpoint-live-control',
            control: {
              operationKey: `op_${'f'.repeat(64)}`,
              acknowledgementDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        }),
      ],
      { key: 'events-live-control-ack-01' },
    );

    expect(live.statusCode, live.body).toBe(201);
    expect(await count('agent_events')).toBe(1);
    expect(await count('audit_events')).toBe(1);
    expect(await counter()).toBe(1);
    expect(
      await database.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).toEqual([{ status: 'paused' }]);
  });

  it('rolls back a control acknowledgement whose row-lock wait crosses its deadline', async () => {
    let markLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locker = database.sql.begin(async (tx) => {
      await tx`
        update agent_runs set status = status
        where id = ${runId}
      `;
      markLocked();
      await release;
    });
    await locked;

    const pending = post(
      [
        event({
          type: 'run.paused',
          visibility: 'user',
          payload: {
            checkpointRef: 'checkpoint-lock-deadline',
            control: {
              operationKey: `op_${'b'.repeat(64)}`,
              acknowledgementDeadlineAt: new Date(Date.now() + 250).toISOString(),
            },
          },
        }),
      ],
      { key: 'events-lock-deadline-01' },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      releaseLock();
      await locker;
    }
    const response = await pending;

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'control_acknowledgement_expired',
    );
    expect(await count('agent_events')).toBe(0);
    expect(await count('audit_events')).toBe(0);
    expect(await counter()).toBeUndefined();
    expect(
      await database.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).toEqual([{ status: 'running' }]);
  });

  it('records every Prototype mock as a durable assumption decision in the event transaction', async () => {
    const response = await post(
      [
        event({
          type: 'artifact.created',
          visibility: 'user',
          payload: {
            kind: 'prototype_assumptions',
            mocks: [
              { name: 'payment-provider', reason: 'Preview checkout before provider setup.' },
              { name: 'email-delivery', reason: 'Preview receipts before mail setup.' },
            ],
          },
        }),
      ],
      { key: 'events-prototype-assumptions-01' },
    );

    expect(response.statusCode, response.body).toBe(201);
    expect(
      await database.db
        .select({
          organizationId: decisions.organizationId,
          projectId: decisions.projectId,
          question: decisions.question,
          decision: decisions.decision,
          rationale: decisions.rationale,
          madeBy: decisions.madeBy,
        })
        .from(decisions),
    ).toEqual([
      {
        organizationId,
        projectId,
        question: 'May Prototype mode mock payment-provider?',
        decision: 'Mock payment-provider for this prototype.',
        rationale: 'Preview checkout before provider setup.',
        madeBy: 'builder',
      },
      {
        organizationId,
        projectId,
        question: 'May Prototype mode mock email-delivery?',
        decision: 'Mock email-delivery for this prototype.',
        rationale: 'Preview receipts before mail setup.',
        madeBy: 'builder',
      },
    ]);
  });

  it('rejects malformed visibility and batch cardinality without allocating a sequence', async () => {
    // Break caught: accepting non-PRD visibility, an empty batch, a 101st item,
    // or unknown keys at the public service boundary.
    const tooMany = Array.from({ length: 101 }, (_, index) =>
      event({ occurredAt: `2026-08-04T12:00:${String(index % 60).padStart(2, '0')}.000Z` }),
    );
    const invalidVisibility = { ...event(), visibility: 'public' };
    for (const [label, body] of [
      ['visibility', [invalidVisibility]],
      ['empty', []],
      ['too many', tooMany],
      ['unknown event key', [{ ...event(), unexpected: true }]],
    ] as const) {
      const response = await post(body as unknown as readonly z.input<typeof EventInputSchema>[], {
        key: `events-invalid-${label.replaceAll(' ', '-')}`,
      });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(await counter(), label).toBeUndefined();
      expect(await count('agent_events'), label).toBe(0);
    }
  });

  it('measures payload JSON in UTF-8 bytes before allocation and directs callers to artifacts', async () => {
    // Break caught: changing Buffer.byteLength(JSON.stringify(payload), 'utf8')
    // to JavaScript character length lets this multibyte body evade the cap.
    const response = await post([event({ payload: { blob: 'é'.repeat(32_769) } })], {
      key: 'events-multibyte-cap-01',
    });

    expect(response.statusCode, response.body).toBe(413);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'payload_too_large',
    });
    expect(response.body).toContain('artifacts');
    expect(await counter()).toBeUndefined();
    expect(await count('agent_events')).toBe(0);
  });

  it('rejects an over-cap JSON payload before opening a tenant transaction', async () => {
    // Break caught: removing the cheap JavaScript cap would reach the tenant
    // writer; a closed real database makes that mistake observable as a 500.
    const unavailableDb = createDb(database.url);
    const unavailableApp = buildApp({
      logger: false,
      auth: {
        port: new FakeAuthPort(),
        users: createDbUserStore(unavailableDb.db),
        config: TEST_AUTH_CONFIG,
      },
      orgs: {
        organizations: createDbOrganizationStore(unavailableDb.db),
        invites: createInMemoryInviteStore(),
        audit: createDbAuditSink(unavailableDb.db),
      },
      tenant: {
        tenantDb: () => {
          throw new Error('the route must reject before opening the tenant writer');
        },
      },
      secrets: { masterKey: TEST_MASTER_KEY, serviceTokens: tokens.verifier },
      limits: { config: TEST_RATE_LIMITS },
    });
    await unavailableApp.ready();
    await unavailableDb.close();
    try {
      const response = await unavailableApp.inject({
        method: 'POST',
        url: `/internal/runs/${runId}/events`,
        headers: {
          [SERVICE_TOKEN_HEADER]: await tokens.issue('orchestrator-worker', {
            aud: EVENTS_INGEST_AUDIENCE,
          }),
          'idempotency-key': 'events-js-cap-before-tenant-01',
        },
        payload: [event({ payload: { blob: 'é'.repeat(32_769) } })],
      });
      expect(response.statusCode, response.body).toBe(413);
      expect(response.body).toContain('artifacts');
    } finally {
      await unavailableApp.close();
    }
  });

  it('rejects a 65,536-byte JSON payload whose PostgreSQL JSONB datum exceeds the cap', async () => {
    // Break caught: measuring only JSON.stringify bytes allows PostgreSQL's
    // larger jsonb datum to hit the CHECK as a 500 after entering the writer.
    const payload = { blob: 'x'.repeat(65_525) };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBe(65_536);
    expect(await jsonbPayloadBytes(payload)).toBeGreaterThan(65_536);

    await expectPayloadTooLargeWithoutEffects(payload, 'events-jsonb-exact-boundary-01');
  });

  it('rejects a structured payload by PostgreSQL JSONB size, not JSON string length', async () => {
    // Break caught: applying only a JavaScript string cap misses jsonb object
    // and array representation overhead that the database CHECK enforces.
    const payload = {
      records: Array.from({ length: 1000 }, (_, index) => ({ index, value: 'x'.repeat(40) })),
    };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(65_536);
    expect(await jsonbPayloadBytes(payload)).toBeGreaterThan(65_536);

    await expectPayloadTooLargeWithoutEffects(payload, 'events-jsonb-structured-boundary-01');
  });

  it('commits an at-or-under-cap structured JSONB payload', async () => {
    // Break caught: a conservative preflight that rejects based on serialized
    // JSON bytes rather than PostgreSQL's actual JSONB datum size.
    const payload = {
      records: Array.from({ length: 775 }, (_, index) => ({ index, value: 'x'.repeat(40) })),
    };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(65_536);
    expect(await jsonbPayloadBytes(payload)).toBeLessThanOrEqual(65_536);

    const response = await post([event({ payload })], { key: 'events-jsonb-structured-valid-01' });
    expect(response.statusCode, response.body).toBe(201);
    expect(await count('agent_events')).toBe(1);
    expect(await count('audit_events')).toBe(1);
    expect(await counter()).toBe(1);
  });

  it('rejects foreign, wrong-project, and path/body run identities before allocation', async () => {
    // Break caught: calling nextEventSequence before tenant/run/project/path
    // validation creates an invisible counter gap for a rejected request.
    const otherProjectId = newId('proj');
    await database.db.insert(projects).values({
      id: otherProjectId,
      organizationId,
      name: 'Other Project',
      slug: `other-${otherProjectId.slice(-8).toLowerCase()}`,
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: (await database.sql<{ id: string }[]>`select id from users limit 1`)[0]?.id ?? '',
    });
    const foreignOrganizationId = newId('org');
    const foreignProjectId = newId('proj');
    const foreignRunId = newId('run');
    await database.db.insert(organizations).values({
      id: foreignOrganizationId,
      name: 'Foreign Org',
      slug: `foreign-${foreignOrganizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
      billingCustomerId: null,
    });
    await database.db.insert(projects).values({
      id: foreignProjectId,
      organizationId: foreignOrganizationId,
      name: 'Foreign Project',
      slug: `foreign-${foreignProjectId.slice(-8).toLowerCase()}`,
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: (await database.sql<{ id: string }[]>`select id from users limit 1`)[0]?.id ?? '',
    });
    await database.db.insert(agentRuns).values({
      id: foreignRunId,
      organizationId: foreignOrganizationId,
      projectId: foreignProjectId,
      branchId: null,
      mode: 'build',
      requestFingerprint: `seed:${foreignRunId}`,
      status: 'running',
      specificationId: null,
      temporalWorkflowId: foreignRunId,
      startedBy: (await database.sql<{ id: string }[]>`select id from users limit 1`)[0]?.id ?? '',
      budgetJson: null,
      planMaxCredits: '1000.0000',
    });

    const cases = [
      ['wrong project', [event({ projectId: otherProjectId })], runId],
      ['path body mismatch', [event({ runId: foreignRunId })], runId],
      ['mixed tenant identity', [event({ runId: foreignRunId })], foreignRunId],
    ] as const;
    for (const [label, body, pathRunId] of cases) {
      const response = await post(body, {
        key: `events-reject-${label.replaceAll(' ', '-')}`,
        pathRunId,
      });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(404);
      expect(await counter(runId), label).toBeUndefined();
      expect(await counter(foreignRunId), label).toBeUndefined();
      expect(await count('agent_events'), label).toBe(0);
    }
  });

  it('rejects an event whose task belongs to another phase of the same run', async () => {
    // Break caught: validating phase and task separately accepts an impossible
    // event context and lets a task be replayed under the wrong phase.
    await expectRunNotFoundWithoutEffects(
      [event({ phaseId, taskId: secondTaskId })],
      'events-task-phase-mismatch-01',
    );
  });

  it('accepts a task-only event when the task phase belongs to the path run', async () => {
    // Break caught: requiring an explicit phase would reject the valid
    // task-only form, even though the task's own phase binds it to the run.
    const response = await post([event({ taskId })], { key: 'events-task-only-valid-01' });
    expect(response.statusCode, response.body).toBe(201);
    const body = EventResponseSchema.parse(response.json());
    expect(body.events[0]).toMatchObject({ runId, taskId, sequence: 1 });
    expect(body.events[0]).not.toHaveProperty('phaseId');
  });

  it('rejects a task-only event whose task phase belongs to another run', async () => {
    // Break caught: removing the task-phase-to-run predicate permits a task
    // from a different run while the event claims this path run.
    const otherRunId = newId('run');
    const otherPhaseId = newId('phase');
    const otherTaskId = newId('task');
    const [owner] = await database.sql<{ id: string }[]>`select id from users limit 1`;
    await database.db.insert(agentRuns).values({
      id: otherRunId,
      organizationId,
      projectId,
      branchId: null,
      mode: 'build',
      requestFingerprint: `seed:${otherRunId}`,
      status: 'running',
      specificationId: null,
      temporalWorkflowId: otherRunId,
      startedBy: owner?.id ?? '',
      budgetJson: null,
      planMaxCredits: '1000.0000',
    });
    await database.db.insert(agentPhases).values({
      id: otherPhaseId,
      organizationId,
      runId: otherRunId,
      sequence: 1,
      title: 'Other run phase',
      status: 'running',
      acceptanceCriteriaJson: [],
    });
    await database.db.insert(agentTasks).values({
      id: otherTaskId,
      organizationId,
      phaseId: otherPhaseId,
      parentTaskId: null,
      title: 'Other run task',
      status: 'running',
      riskLevel: 'low',
      baseCommitSha: null,
      outputCommitSha: null,
      acceptanceCriteriaJson: [],
      dependenciesJson: [],
      assignedAgentRole: 'builder',
    });

    await expectRunNotFoundWithoutEffects(
      [event({ taskId: otherTaskId })],
      'events-task-only-foreign-run-01',
    );
  });

  it('allows only an approved service token minted for this route and never a browser credential', async () => {
    // Break caught: a broad audience, broad service allowlist, or accepting a
    // session/bearer credential would turn an internal mutation into a browser API.
    const wrongAudience = await tokens.issue('orchestrator-worker');
    const cases = [
      ['wrong route audience', { token: wrongAudience }, 401],
      ['wrong service identity', { service: 'git-service' as const }, 403],
      [
        'browser cookie with a valid service token',
        { headers: { cookie: `${SESSION_COOKIE}=browser-credential` } },
        401,
      ],
    ] as const;
    for (const [label, options, status] of cases) {
      const response = await post([event()], {
        key: `events-credential-${label.replaceAll(' ', '-')}`,
        ...options,
      });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(status);
      expect(await count('agent_events'), label).toBe(0);
    }
  });

  it('accepts a sandbox-service token for preview lifecycle events', async () => {
    const response = await post(
      [event({ type: 'preview.ready', visibility: 'user', payload: { workspaceId: 'ws_visible' } })],
      { key: 'ws13-preview-ready', service: 'sandbox-service' },
    );
    expect(response.statusCode, response.body).toBe(201);
    expect(EventResponseSchema.parse(response.json()).events).toHaveLength(1);
    expect(await count('agent_events')).toBe(1);
  });

  it('replays one sandbox preview event when only retry occurrence time advances', async () => {
    const token = await tokens.issue('sandbox-service', { aud: EVENTS_INGEST_AUDIENCE });
    const key = 'ws13-preview-ready-ambiguous-response';
    const first = await post(
      [event({ occurredAt: '2026-08-09T12:00:00.000Z', type: 'preview.ready' })],
      { key, token },
    );
    const replay = await post(
      [event({ occurredAt: '2026-08-09T12:00:01.000Z', type: 'preview.ready' })],
      { key, token },
    );

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.body).toBe(first.body);
    expect(EventResponseSchema.parse(replay.json()).events[0]?.occurredAt).toBe(
      '2026-08-09T12:00:00.000Z',
    );
    expect(await count('agent_events')).toBe(1);
  });

  it('fences terminal preview failure ingestion to the live monitor generation', async () => {
    const workspaceId = newId('ws');
    await database.db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      projectId,
      branchId: null,
      provider: 'modal',
      providerWorkspaceId: 'sb-fenced-preview',
      status: 'ready',
      resourceProfile: 'standard',
      runId,
      taskId,
      purpose: 'preview',
      environment: 'zapp-dev',
      imageTag: 'forge-node-base:test',
      previewMonitorEnabled: true,
      previewMonitorOwnerId: 'current-monitor-generation',
      previewMonitorLeaseExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const terminalEvent = (leaseToken: string) =>
      event({
        type: 'preview.failed',
        visibility: 'user',
        payload: {
          workspaceId,
          code: 'restart_limit_exceeded',
          monitorLeaseToken: leaseToken,
        },
      });

    const stale = await post([terminalEvent('expired-monitor-generation')], {
      key: 'ws13-stale-terminal-generation',
      service: 'sandbox-service',
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe(
      'preview_monitor_stale',
    );
    expect(await count('agent_events')).toBe(0);

    const current = await post([terminalEvent('current-monitor-generation')], {
      key: 'ws13-current-terminal-generation',
      service: 'sandbox-service',
    });
    expect(current.statusCode, current.body).toBe(201);
    const [stored] = EventResponseSchema.parse(current.json()).events;
    expect(stored?.payload).toEqual({
      workspaceId,
      code: 'restart_limit_exceeded',
    });
    expect(current.body).not.toContain('current-monitor-generation');
    const [disabledMonitor] = await database.db
      .select({
        enabled: workspaces.previewMonitorEnabled,
        ownerId: workspaces.previewMonitorOwnerId,
        leaseExpiresAt: workspaces.previewMonitorLeaseExpiresAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(disabledMonitor).toEqual({
      enabled: false,
      ownerId: null,
      leaseExpiresAt: null,
    });
  });

  it('rolls back an earlier live monitor when a later terminal batch item is stale', async () => {
    const liveWorkspaceId = newId('ws');
    const staleWorkspaceId = newId('ws');
    await database.db.insert(workspaces).values([
      {
        id: liveWorkspaceId,
        organizationId,
        projectId,
        branchId: null,
        provider: 'modal',
        providerWorkspaceId: 'sb-live-preview-batch',
        status: 'ready',
        resourceProfile: 'standard',
        runId,
        taskId,
        purpose: 'preview',
        environment: 'zapp-dev',
        imageTag: 'forge-node-base:test',
        previewMonitorEnabled: true,
        previewMonitorOwnerId: 'live-batch-generation',
        previewMonitorLeaseExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
      {
        id: staleWorkspaceId,
        organizationId,
        projectId,
        branchId: null,
        provider: 'modal',
        providerWorkspaceId: 'sb-stale-preview-batch',
        status: 'ready',
        resourceProfile: 'standard',
        runId,
        taskId,
        purpose: 'preview',
        environment: 'zapp-dev',
        imageTag: 'forge-node-base:test',
        previewMonitorEnabled: true,
        previewMonitorOwnerId: 'different-batch-generation',
        previewMonitorLeaseExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ]);
    const terminal = (workspaceId: string, monitorLeaseToken: string) =>
      event({
        type: 'preview.failed',
        visibility: 'user',
        payload: { workspaceId, code: 'restart_limit_exceeded', monitorLeaseToken },
      });

    const response = await post(
      [
        terminal(liveWorkspaceId, 'live-batch-generation'),
        terminal(staleWorkspaceId, 'stale-batch-generation'),
      ],
      { key: 'ws13-mixed-terminal-generations', service: 'sandbox-service' },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'preview_monitor_stale',
    );
    expect(await count('agent_events')).toBe(0);
    expect(await count('audit_events')).toBe(0);
    const [liveMonitor] = await database.db
      .select({
        enabled: workspaces.previewMonitorEnabled,
        ownerId: workspaces.previewMonitorOwnerId,
        leaseExpiresAt: workspaces.previewMonitorLeaseExpiresAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, liveWorkspaceId));
    expect(liveMonitor).toEqual({
      enabled: true,
      ownerId: 'live-batch-generation',
      leaseExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  it('requires a key and replays exactly once for the verified service identity across source IPs', async () => {
    // Break caught: optional idempotency, scope keyed by source IP rather than
    // request.service, or replay executing the transaction a second time.
    const missing = await post([event()]);
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_required');

    const token = await tokens.issue('orchestrator-worker', { aud: EVENTS_INGEST_AUDIENCE });
    const body = [event()];
    const listener = createDb(database.url);
    const notifications: string[] = [];
    await listener.sql.listen('agent_events', (payload) => {
      notifications.push(payload);
    });
    try {
      const first = await post(body, {
        key: 'events-replay-service-scope-01',
        token,
        remoteAddress: '198.51.100.1',
      });
      const replay = await post(body, {
        key: 'events-replay-service-scope-01',
        token,
        remoteAddress: '203.0.113.2',
      });
      expect(first.statusCode, first.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.headers['x-idempotent-replay']).toBe('true');
      expect(replay.body).toBe(first.body);
      await vi.waitFor(() => {
        expect(notifications).toEqual([runId]);
      });
      expect(await count('agent_events')).toBe(1);
      expect(await count('audit_events')).toBe(1);
    } finally {
      await listener.close();
    }
  });

  it('assigns non-overlapping contiguous blocks to concurrent batches', async () => {
    // Break caught: allocating from MAX(sequence), allocating outside the
    // insert transaction, or dropping a member of a batch under contention.
    const [first, second] = await Promise.all([
      post([event({ type: 'run.started' }), event({ type: 'phase.started' })], {
        key: 'events-concurrent-first-01',
      }),
      post([
        event({ type: 'task.started' }),
        event({ type: 'tool.started', payload: { tool: 'read_file', userSummary: 'Read a file' } }),
      ], {
        key: 'events-concurrent-second-01',
      }),
    ]);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    const sequences = await database.sql<{ sequence: string }[]>`
      select sequence::text from agent_events where run_id = ${runId} order by sequence
    `;
    expect(sequences.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4]);
    expect(await counter()).toBe(4);
  });

  it('notifies once for a committed batch and rolls back events, counter, audit, and notification on audit failure', async () => {
    // Break caught: NOTIFY outside the transaction, missing batch audit, or a
    // transaction that commits an event/counter despite an audit failure.
    const listener = createDb(database.url);
    const notifications: string[] = [];
    await listener.sql.listen('agent_events', (payload) => {
      notifications.push(payload);
    });
    try {
      const committed = await post([event(), event({ type: 'phase.started' })], {
        key: 'events-notify-committed-01',
      });
      expect(committed.statusCode, committed.body).toBe(201);
      await vi.waitFor(() => {
        expect(notifications).toEqual([runId]);
      });

      auditFails = true;
      const rejected = await post([event({ type: 'task.started' })], {
        key: 'events-notify-rollback-01',
      });
      expect(rejected.statusCode, rejected.body).toBe(500);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(notifications).toEqual([runId]);
      expect(await count('agent_events')).toBe(2);
      expect(await counter()).toBe(2);
      expect(await count('audit_events')).toBe(1);
    } finally {
      await listener.close();
    }
  });
});
