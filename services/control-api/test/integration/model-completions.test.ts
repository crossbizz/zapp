import {
  newId,
  type CreditCeilingIncreaseRequest,
  type ModelCompletionClaimRequest,
  type ModelCompletionCommitRequest,
} from '@zapp/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CompletionConflictError,
  CompletionNotFoundError,
  createModelCompletionRepository,
} from '../../src/usage/model-completions.js';
import {
  createUsageEventConsumer,
  createUsageOutboxPublisher,
} from '../../src/usage/outbox.js';
import { loadPricingConfig } from '../../src/usage/pricing.js';
import {
  createAccountingReconciler,
  createRedisCreditMirror,
} from '../../src/usage/reconciliation.js';
import { createRedisConnection } from '../../src/redis/client.js';
import {
  hasDatabase,
  hasRedis,
  redisUrl,
  setUpTestDatabase,
  type TestDatabase,
} from './helpers.js';

const pricing = loadPricingConfig({
  version: 'm1-test',
  defaultRunCreditCeiling: '10.0000',
  creditsPerUsd: '100.0000',
  models: {
    'anthropic/claude-sonnet-5': {
      inputUsdPerMillion: '3.000000',
      outputUsdPerMillion: '15.000000',
      cacheReadUsdPerMillion: '0.300000',
      cacheWriteUsdPerMillion: '3.750000',
    },
  },
});

describe.skipIf(!hasDatabase)('OPS-1A completion accounting repository', () => {
  let database: TestDatabase;
  let now = new Date('2026-08-09T12:00:00.000Z');
  let organizationId = '';
  let projectId = '';
  let runId = '';
  let taskId = '';
  let userId = '';

  beforeAll(async () => {
    database = await setUpTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
    now = new Date('2026-08-09T12:00:00.000Z');
    userId = newId('user');
    organizationId = newId('org');
    projectId = newId('proj');
    runId = newId('run');
    const phaseId = newId('phase');
    taskId = newId('task');
    await database.sql.begin(async (tx) => {
      await tx`insert into users (id, email, display_name) values (${userId}, ${`${userId}@test.invalid`}, 'Usage')`;
      await tx`insert into organizations (id, name, slug) values (${organizationId}, 'Usage', ${organizationId})`;
      await tx`insert into projects (id, organization_id, name, slug, source_type, support_level, created_by)
               values (${projectId}, ${organizationId}, 'Usage', ${projectId}, 'prompt', 'compatible', ${userId})`;
      await tx`insert into conversations (id, organization_id, project_id, created_by, title)
               values (${`conv_${runId.slice(4)}`}, ${organizationId}, ${projectId}, ${userId}, 'Usage run')`;
      await tx`insert into agent_runs
               (id, organization_id, project_id, conversation_id, conversation_run_number, mode, app_type, request_fingerprint, status, started_by, budget_json, plan_max_credits)
               values (${runId}, ${organizationId}, ${projectId}, ${`conv_${runId.slice(4)}`}, 1, 'build', 'web', ${'f'.repeat(64)}, 'running', ${userId}, ${JSON.stringify({ maxCredits: 10 })}::jsonb, 10)`;
      await tx`insert into agent_phases
               (id, organization_id, run_id, sequence, title, status, acceptance_criteria_json)
               values (${phaseId}, ${organizationId}, ${runId}, 1, 'Build', 'running', '[]'::jsonb)`;
      await tx`insert into agent_tasks
               (id, organization_id, phase_id, title, status, risk_level, acceptance_criteria_json, dependencies_json)
               values (${taskId}, ${organizationId}, ${phaseId}, 'Implement', 'running', 'low', '[]'::jsonb, '[]'::jsonb)`;
      await tx`insert into run_credit_accounts
               (run_id, organization_id, base_ceiling, pricing_version, pricing_snapshot_json)
               values (${runId}, ${organizationId}, 10, ${pricing.version}, ${JSON.stringify(pricing)}::jsonb)`;
    });
  });

  function claim(
    completionId: string = `cmp_${'a'.repeat(64)}`,
    maxInputTokens = 1_000,
    maxOutputTokens = 100,
  ): ModelCompletionClaimRequest {
    return {
      completionId,
      organizationId,
      projectId,
      runId,
      taskId,
      requestFingerprint: 'b'.repeat(64),
      claimOwner: 'gateway-a',
      leaseMs: 30_000,
      route: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          maxInputTokens,
          maxOutputTokens,
        },
      ],
    };
  }

  function repository() {
    return createModelCompletionRepository({ database: database.db, now: () => now });
  }

  function completion(request: ModelCompletionClaimRequest): ModelCompletionCommitRequest {
    return {
      completionId: request.completionId,
      organizationId,
      projectId,
      runId,
      taskId,
      requestFingerprint: request.requestFingerprint,
      claimOwner: request.claimOwner,
      events: [{ type: 'text-delta', text: 'hello' }],
      usage: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadInputTokens: 200,
          cacheWriteInputTokens: 100,
          occurredAt: now.toISOString(),
        },
      ],
      terminal: { type: 'done' },
    };
  }

  it('claims once, renews the same reservation, rejects conflicts and permits lease takeover', async () => {
    const store = repository();
    const first = await store.claim(claim());
    expect(first).toMatchObject({ status: 'claimed', reservedCredits: '0.5250' });
    expect(await store.claim(claim())).toMatchObject({
      status: 'claimed',
      reservedCredits: '0.5250',
      credits: { reserved: '0.5250' },
    });
    await expect(
      store.claim({ ...claim(), requestFingerprint: 'c'.repeat(64) }),
    ).rejects.toBeInstanceOf(CompletionConflictError);
    expect(await store.claim({ ...claim(), claimOwner: 'gateway-b' })).toMatchObject({
      status: 'leased',
    });
    now = new Date('2026-08-09T12:00:31.000Z');
    expect(await store.claim({ ...claim(), claimOwner: 'gateway-b' })).toMatchObject({
      status: 'claimed',
      reservedCredits: '0.5250',
    });
  });

  it('returns not-found rather than revealing a completion identity across tenants', async () => {
    const store = repository();
    const request = claim();
    await store.claim(request);
    const otherOrganizationId = newId('org');
    const otherProjectId = newId('proj');
    const otherRunId = newId('run');
    const otherPhaseId = newId('phase');
    const otherTaskId = newId('task');
    await database.sql.begin(async (tx) => {
      await tx`insert into organizations (id, name, slug) values (${otherOrganizationId}, 'Other', ${otherOrganizationId})`;
      await tx`insert into projects (id, organization_id, name, slug, source_type, support_level, created_by)
               values (${otherProjectId}, ${otherOrganizationId}, 'Other', ${otherProjectId}, 'prompt', 'compatible', ${userId})`;
      await tx`insert into conversations (id, organization_id, project_id, created_by, title)
               values (${`conv_${otherRunId.slice(4)}`}, ${otherOrganizationId}, ${otherProjectId}, ${userId}, 'Other run')`;
      await tx`insert into agent_runs
               (id, organization_id, project_id, conversation_id, conversation_run_number, mode, app_type, request_fingerprint, status, started_by, budget_json, plan_max_credits)
               values (${otherRunId}, ${otherOrganizationId}, ${otherProjectId}, ${`conv_${otherRunId.slice(4)}`}, 1, 'build', 'web', ${'e'.repeat(64)}, 'running', ${userId}, ${JSON.stringify({ maxCredits: 10 })}::jsonb, 10)`;
      await tx`insert into agent_phases
               (id, organization_id, run_id, sequence, title, status, acceptance_criteria_json)
               values (${otherPhaseId}, ${otherOrganizationId}, ${otherRunId}, 1, 'Other', 'running', '[]'::jsonb)`;
      await tx`insert into agent_tasks
               (id, organization_id, phase_id, title, status, risk_level, acceptance_criteria_json, dependencies_json)
               values (${otherTaskId}, ${otherOrganizationId}, ${otherPhaseId}, 'Other', 'running', 'low', '[]'::jsonb, '[]'::jsonb)`;
      await tx`insert into run_credit_accounts
               (run_id, organization_id, base_ceiling, pricing_version, pricing_snapshot_json)
               values (${otherRunId}, ${otherOrganizationId}, 10, ${pricing.version}, ${JSON.stringify(pricing)}::jsonb)`;
    });

    await expect(
      store.claim({
        ...request,
        organizationId: otherOrganizationId,
        projectId: otherProjectId,
        runId: otherRunId,
        taskId: otherTaskId,
      }),
    ).rejects.toBeInstanceOf(CompletionNotFoundError);
  });

  it('serializes concurrent reservations so the run ceiling is never crossed', async () => {
    const store = repository();
    const results = await Promise.all([
      store.claim(claim(`cmp_${'1'.repeat(64)}`, 10_000, 2_000)),
      store.claim(claim(`cmp_${'2'.repeat(64)}`, 10_000, 2_000)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'budget_exceeded',
      'claimed',
    ]);
    const [account] = await database.sql<{ reserved: string }[]>`
      select reserved_credits::text as reserved from run_credit_accounts where run_id = ${runId}
    `;
    expect(account?.reserved).toBe('6.7500');
  });

  it('commits attributed usage once, releases reservation and replays byte-for-byte', async () => {
    const store = repository();
    const request = claim();
    expect((await store.claim(request)).status).toBe('claimed');
    const commit = completion(request);
    const first = await store.commit(commit);
    const replay = await store.commit(commit);
    expect(replay).toEqual(first);
    expect(await store.get(organizationId, request.completionId)).toEqual(first.completion);
    expect(first).toMatchObject({
      credits: { used: '0.4035', reserved: '0.0000', ceiling: '10.0000' },
    });
    expect(first.ledgerRowIds).toHaveLength(4);
    const [counts] = await database.sql<{ ledger: string; outbox: string }[]>`
      select
        (select count(*)::text from usage_ledger where run_id = ${runId}) as ledger,
        (select count(*)::text from usage_outbox where organization_id = ${organizationId}) as outbox
    `;
    expect(counts).toEqual({ ledger: '4', outbox: '4' });
  });

  it('rejects usage above the claimed maximum without charging or releasing the reservation', async () => {
    const store = repository();
    const request = claim();
    expect((await store.claim(request)).status).toBe('claimed');
    const overrun = completion(request);
    const firstUsage = overrun.usage[0];
    if (firstUsage === undefined) throw new Error('completion fixture has no usage');
    overrun.usage[0] = { ...firstUsage, inputTokens: 2_000 };

    await expect(store.commit(overrun)).rejects.toThrow('exceeds its durable reservation');
    const [state] = await database.sql<{ reserved: string; used: string; ledger: string }[]>`
      select
        reserved_credits::text as reserved,
        used_credits::text as used,
        (select count(*)::text from usage_ledger where run_id = ${runId}) as ledger
      from run_credit_accounts
      where run_id = ${runId}
    `;
    expect(state).toEqual({ reserved: '0.5250', used: '0.0000', ledger: '0' });
  });

  it('applies only resolved, idempotent, monotonic ceiling increases and resumes a blocked claim', async () => {
    const store = repository();
    const first = claim(`cmp_${'3'.repeat(64)}`, 10_000, 2_000);
    const blocked = claim(`cmp_${'4'.repeat(64)}`, 10_000, 2_000);
    expect((await store.claim(first)).status).toBe('claimed');
    expect((await store.claim(blocked)).status).toBe('budget_exceeded');
    const approvalId = newId('appr');
    await database.sql`
      insert into approvals
        (id, organization_id, run_id, type, status, request_json, response_json, resolved_at, resolved_by)
      values
        (${approvalId}, ${organizationId}, ${runId}, 'budget_increase', 'approved',
         ${JSON.stringify({ absoluteCeiling: '14.0000' })}::jsonb,
         ${JSON.stringify({ decision: 'approved' })}::jsonb,
         ${now.toISOString()}, ${userId})
    `;
    const increase: CreditCeilingIncreaseRequest = {
      organizationId,
      projectId,
      runId,
      approvalId,
      operationKey: 'approval-credit-14',
      absoluteCeiling: '14.0000',
    };
    const firstIncrease = await store.increaseCeiling(increase);
    expect(await store.increaseCeiling(increase)).toEqual(firstIncrease);
    expect(firstIncrease).toMatchObject({ ceiling: '14.0000', reserved: '6.7500' });
    expect((await store.claim(blocked)).status).toBe('claimed');

    const secondApprovalId = newId('appr');
    await database.sql`
      insert into approvals
        (id, organization_id, run_id, type, status, request_json, response_json, resolved_at, resolved_by)
      values
        (${secondApprovalId}, ${organizationId}, ${runId}, 'budget_increase', 'approved',
         ${JSON.stringify({ absoluteCeiling: '16.0000' })}::jsonb,
         ${JSON.stringify({ decision: 'approved' })}::jsonb,
         ${now.toISOString()}, ${userId})
    `;
    expect(
      await store.increaseCeiling({
        ...increase,
        approvalId: secondApprovalId,
        operationKey: 'approval-credit-16',
        absoluteCeiling: '16.0000',
      }),
    ).toMatchObject({ ceiling: '16.0000' });
    expect(await store.increaseCeiling(increase)).toMatchObject({ ceiling: '16.0000' });
    const [timestamps] = await database.sql<{ distinct_times: string }[]>`
      select count(distinct created_at)::text as distinct_times
        from run_credit_ceiling_adjustments
       where run_id = ${runId}
    `;
    expect(timestamps?.distinct_times).toBe('2');

    const decreaseApprovalId = newId('appr');
    await database.sql`
      insert into approvals
        (id, organization_id, run_id, type, status, request_json, response_json, resolved_at, resolved_by)
      values
        (${decreaseApprovalId}, ${organizationId}, ${runId}, 'budget_increase', 'approved',
         ${JSON.stringify({ absoluteCeiling: '15.0000' })}::jsonb,
         ${JSON.stringify({ decision: 'approved' })}::jsonb,
         ${now.toISOString()}, ${userId})
    `;
    await expect(
      store.increaseCeiling({
        ...increase,
        approvalId: decreaseApprovalId,
        operationKey: 'approval-credit-decrease',
        absoluteCeiling: '15.0000',
      }),
    ).rejects.toThrow('strictly increase');
    const [count] = await database.sql<{ count: string }[]>`
      select count(*)::text as count
        from run_credit_ceiling_adjustments
       where run_id = ${runId}
    `;
    expect(count?.count).toBe('2');
  }, 15_000);

  it('heals a lost Redis mirror for active runs under one bounded database leader lease', async () => {
    const request = claim();
    const store = createModelCompletionRepository({
      database: database.db,
      now: () => now,
      mirror: {
        write: () => Promise.reject(new Error('redis unavailable after commit')),
      },
    });
    await expect(store.claim(request)).resolves.toMatchObject({ status: 'claimed' });

    const writes: { runId: string; credits: unknown }[] = [];
    const reconciler = createAccountingReconciler({
      database: database.db,
      owner: 'reconciler-a',
      now: () => now,
      mirror: {
        write: (mirroredRunId, credits) => {
          writes.push({ runId: mirroredRunId, credits });
          return Promise.resolve();
        },
      },
    });
    await expect(reconciler.runOnce(1)).resolves.toEqual({ acquired: true, mirrored: 1 });
    expect(writes).toEqual([
      {
        runId,
        credits: { used: '0.0000', reserved: '0.5250', ceiling: '10.0000', version: 1 },
      },
    ]);
    const follower = createAccountingReconciler({
      database: database.db,
      owner: 'reconciler-b',
      now: () => now,
      mirror: { write: () => Promise.reject(new Error('follower must not write')) },
    });
    await expect(follower.runOnce(1)).resolves.toEqual({ acquired: false, mirrored: 0 });
  }, 15_000);

  it('advances a durable reconciliation cursor so every active run is eventually mirrored', async () => {
    const activeRunIds = [runId, newId('run'), newId('run')];
    for (const [index, activeRunId] of activeRunIds.slice(1).entries()) {
      await database.sql`
        insert into conversations (id, organization_id, project_id, created_by, title)
        values (${`conv_${activeRunId.slice(4)}`}, ${organizationId}, ${projectId}, ${userId}, ${`Active run ${String(index + 1)}`})
      `;
      await database.sql`
        insert into agent_runs
          (id, organization_id, project_id, conversation_id, conversation_run_number,
           mode, app_type, request_fingerprint, status,
           started_by, budget_json, plan_max_credits)
        values
          (${activeRunId}, ${organizationId}, ${projectId}, ${`conv_${activeRunId.slice(4)}`}, 1,
           'build', 'web',
           ${String(index + 1).repeat(64)}, 'running', ${userId},
           ${JSON.stringify({ maxCredits: 10 })}::jsonb, 10)
      `;
      await database.sql`
        insert into run_credit_accounts
          (run_id, organization_id, base_ceiling, pricing_version, pricing_snapshot_json)
        values
          (${activeRunId}, ${organizationId}, 10, ${pricing.version},
           ${JSON.stringify(pricing)}::jsonb)
      `;
    }

    const mirroredRunIds: string[] = [];
    const reconciler = createAccountingReconciler({
      database: database.db,
      owner: 'fair-reconciler',
      now: () => now,
      mirror: {
        write: (mirroredRunId) => {
          mirroredRunIds.push(mirroredRunId);
          return Promise.resolve();
        },
      },
    });

    await expect(reconciler.runOnce(1)).resolves.toEqual({ acquired: true, mirrored: 1 });
    await expect(reconciler.runOnce(1)).resolves.toEqual({ acquired: true, mirrored: 1 });
    await expect(reconciler.runOnce(1)).resolves.toEqual({ acquired: true, mirrored: 1 });
    expect(new Set(mirroredRunIds)).toEqual(new Set(activeRunIds));
  }, 15_000);

  it('holds leadership through every mirror write even after the lease deadline passes', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let followerWrites = 0;
    const first = createAccountingReconciler({
      database: database.db,
      owner: 'slow-reconciler',
      now: () => now,
      leaseMs: 1,
      mirror: {
        async write() {
          firstEntered();
          await firstBlocked;
        },
      },
    });
    const follower = createAccountingReconciler({
      database: database.db,
      owner: 'replacement-reconciler',
      now: () => now,
      leaseMs: 1,
      mirror: {
        write() {
          followerWrites += 1;
          return Promise.resolve();
        },
      },
    });

    const firstRun = first.runOnce(1);
    await firstStarted;
    now = new Date(now.getTime() + 60_000);
    const followerRun = follower.runOnce(1);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(followerWrites).toBe(0);

    releaseFirst();
    await expect(firstRun).resolves.toEqual({ acquired: true, mirrored: 1 });
    await expect(followerRun).resolves.toEqual({ acquired: true, mirrored: 1 });
    expect(followerWrites).toBe(1);
  }, 15_000);

  it('publishes each transactional outbox row once and preserves the ledger id for Flexprice', async () => {
    const store = repository();
    const request = claim();
    await store.claim(request);
    const committed = await store.commit(completion(request));
    const messages: string[] = [];
    const publisher = createUsageOutboxPublisher({
      database: database.db,
      now: () => now,
      queue: {
        send: (body) => {
          messages.push(body);
          return Promise.resolve();
        },
      },
    });
    await expect(publisher.publishOnce(10)).resolves.toBe(4);
    await expect(publisher.publishOnce(10)).resolves.toBe(0);
    expect(messages).toHaveLength(4);

    const flexpriceEvents: unknown[] = [];
    const consumer = createUsageEventConsumer({
      ingest: (event) => {
        flexpriceEvents.push(event);
        return Promise.resolve();
      },
    });
    for (const message of messages) await consumer.consume(message);
    expect(
      flexpriceEvents.map((event) => (event as { event_id: string }).event_id).sort(),
    ).toEqual([...committed.ledgerRowIds].sort());
  }, 15_000);

  it.skipIf(!hasRedis)('heals the authoritative active-run state into real Redis', async () => {
    const request = claim();
    await repository().claim(request);
    const redis = createRedisConnection(redisUrl(), { commandTimeoutMs: 2_000 });
    const key = `run:${runId}:credits`;
    try {
      await redis.delete([key]);
      const reconciler = createAccountingReconciler({
        database: database.db,
        owner: `real-redis-${runId}`,
        now: () => now,
        mirror: createRedisCreditMirror(redis),
      });
      await expect(reconciler.runOnce(1)).resolves.toEqual({ acquired: true, mirrored: 1 });
      expect(JSON.parse((await redis.get(key)) ?? 'null')).toEqual({
        used: '0.0000',
        reserved: '0.5250',
        ceiling: '10.0000',
        version: 1,
      });
    } finally {
      await redis.delete([key]);
      await redis.close();
    }
  }, 15_000);
});
