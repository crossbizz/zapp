import { newId } from '@zapp/contracts';
import {
  agentEvents,
  agentRuns,
  organizations,
  projects,
  users,
  nextEventSequence,
} from '@zapp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTenantDbFactory, type NewRunInput } from '../../src/tenant/db.js';
import { TEST_PRICING } from '../support/harness.js';
import { hasDatabase, setUpTestDatabase, type TestDatabase } from './helpers.js';

describe.skipIf(!hasDatabase)('durable conversation repository', () => {
  let database: TestDatabase;
  let organizationId: string;
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    database = await setUpTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.truncateIdentity();
    userId = newId('user');
    organizationId = newId('org');
    projectId = newId('proj');
    await database.db.insert(users).values({
      id: userId,
      email: `${userId}@conversation-integration.test`,
      displayName: 'Conversation Owner',
      avatarUrl: null,
      externalId: null,
    });
    await database.db.insert(organizations).values({
      id: organizationId,
      name: 'Conversation Integration',
      slug: `conversation-${organizationId.slice(-8).toLowerCase()}`,
      plan: 'trial',
      billingCustomerId: null,
    });
    await database.db.insert(projects).values({
      id: projectId,
      organizationId,
      name: 'Conversation Project',
      slug: `conversation-${projectId.slice(-8).toLowerCase()}`,
      description: null,
      sourceType: 'prompt',
      supportLevel: 'compatible',
      createdBy: userId,
    });
  });

  function runInput(input: {
    readonly runId: string;
    readonly newConversationId: string;
    readonly conversationId?: string;
    readonly fingerprint: string;
  }): NewRunInput {
    return {
      id: input.runId,
      workflowId: input.runId,
      requestFingerprint: input.fingerprint,
      projectId,
      ...(input.conversationId === undefined
        ? {}
        : { conversationId: input.conversationId }),
      newConversationId: input.newConversationId,
      conversationTitle: 'Build durable history',
      contextArtifactId: newId('art'),
      branchId: null,
      mode: 'build',
      appType: 'web',
      model: null,
      budget: { maxCredits: 100 },
      planMaxCredits: '1000.0000',
      accounting: {
        baseCeiling: '100.0000',
        pricingVersion: TEST_PRICING.version,
        pricingSnapshot: TEST_PRICING,
      },
      startedBy: userId,
      now: new Date('2026-08-16T12:00:00.000Z'),
      authorize: () => undefined,
      audit: () => Promise.resolve(),
    };
  }

  it('orders cross-run history, creates one concurrent successor, and scopes reads', async () => {
    const tenant = createTenantDbFactory(database.db)(organizationId);
    const firstInput = runInput({
      runId: newId('run'),
      newConversationId: newId('conv'),
      fingerprint: 'a'.repeat(64),
    });
    const firstAttempts = await Promise.all([
      tenant.runs.create(firstInput),
      tenant.runs.create(firstInput),
    ]);
    expect(firstAttempts.map((result) => result.outcome).sort()).toEqual([
      'created',
      'recovered',
    ]);
    const first = firstAttempts.find((result) => result.outcome === 'created');
    expect(first).toBeDefined();
    if (first === undefined) throw new Error('first run was not created');
    if (!('run' in first)) throw new Error('first run was not created');
    const sequence = await nextEventSequence(database.db, first.run.id);
    await database.db.insert(agentEvents).values({
      id: newId('evt'),
      organizationId,
      projectId,
      runId: first.run.id,
      sequence,
      phaseId: null,
      taskId: null,
      agentId: null,
      type: 'message.user',
      payloadJson: {
        messageId: `msg_${'1'.repeat(26)}`,
        content: 'Build durable history',
        attachments: [],
        source: 'web',
      },
      visibility: 'user',
      occurredAt: new Date('2026-08-16T12:00:01.000Z'),
    });
    await database.db
      .update(agentRuns)
      .set({ status: 'completed', completedAt: new Date('2026-08-16T12:01:00.000Z') })
      .where(eq(agentRuns.id, first.run.id));

    const nextA = runInput({
      runId: newId('run'),
      newConversationId: newId('conv'),
      conversationId: first.run.conversationId,
      fingerprint: 'b'.repeat(64),
    });
    const nextB = runInput({
      runId: newId('run'),
      newConversationId: newId('conv'),
      conversationId: first.run.conversationId,
      fingerprint: 'c'.repeat(64),
    });
    const successors = await Promise.all([tenant.runs.create(nextA), tenant.runs.create(nextB)]);
    expect(successors.map((result) => result.outcome).sort()).toEqual([
      'conversation_run_active',
      'created',
    ]);
    const created = successors.find((result) => result.outcome === 'created');
    if (created === undefined || !('run' in created)) throw new Error('successor was not created');
    expect(created.run.conversationRunNumber).toBe(2);
    expect(created.contextArtifactId).toMatch(/^art_/u);
    const replayInput = created.run.id === nextA.id ? nextA : nextB;
    const concurrentReplay = await Promise.all([
      tenant.runs.create(replayInput),
      tenant.runs.create(replayInput),
    ]);
    for (const replay of concurrentReplay) {
      expect(replay.outcome).toBe('recovered');
      if (!('run' in replay)) throw new Error('same-key successor replay was not recovered');
      expect(replay.run.id).toBe(created.run.id);
      expect(replay.contextArtifactId).toBe(created.contextArtifactId);
    }

    const summaries = await tenant.conversations.listByProject(projectId, { limit: 10 });
    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0]).toMatchObject({
      conversation: { id: first.run.conversationId },
      latestRun: { id: created.run.id },
      runCount: 2,
    });
    const history = await tenant.conversations.listEvents(first.run.conversationId, {
      limit: 10,
    });
    expect(history.items.map((item) => [item.runNumber, item.event.sequence])).toEqual([[1, 1]]);

    const foreign = createTenantDbFactory(database.db)(newId('org'));
    await expect(foreign.conversations.getById(first.run.conversationId)).resolves.toBeUndefined();
    await expect(foreign.conversations.listByProject(projectId, { limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('refuses to readmit a failed dispatch while its successor is active', async () => {
    const tenant = createTenantDbFactory(database.db)(organizationId);
    const failedInput = runInput({
      runId: newId('run'),
      newConversationId: newId('conv'),
      fingerprint: 'd'.repeat(64),
    });
    const first = await tenant.runs.create(failedInput);
    if (!('run' in first)) throw new Error('failed-dispatch fixture was not created');
    await database.db
      .update(agentRuns)
      .set({ status: 'dispatch_failed' })
      .where(eq(agentRuns.id, first.run.id));

    const successor = await tenant.runs.create(runInput({
      runId: newId('run'),
      newConversationId: newId('conv'),
      conversationId: first.run.conversationId,
      fingerprint: 'e'.repeat(64),
    }));
    if (!('run' in successor)) throw new Error('successor fixture was not created');

    const readmitted = await tenant.runs.readmitDispatch({
      runId: first.run.id,
      requestFingerprint: failedInput.requestFingerprint,
      audit: () => Promise.resolve(),
    });
    expect(readmitted).toMatchObject({
      outcome: 'conversation_run_active',
      activeRun: { id: successor.run.id },
    });
  });
});
