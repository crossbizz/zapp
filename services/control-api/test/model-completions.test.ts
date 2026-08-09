import {
  CreditCeilingIncreaseResponseSchema,
  ModelCompletionCommitResponseSchema,
  ModelCompletionGetResponseSchema,
  ModelCompletionClaimResponseSchema,
  newId,
  type ModelCompletionClaimRequest,
  type ModelCompletionCommitRequest,
} from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVICE_TOKEN_HEADER } from '../src/internal/service-auth.js';
import {
  CreditCeilingIncreaseRejectedError,
  type ModelCompletionRepository,
} from '../src/usage/model-completions.js';
import { buildHarness, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.app.close();
    }),
  );
});

describe('OPS-1A internal model completion routes', () => {
  it('authenticates model-gateway and validates the stable claim boundary', async () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const runId = newId('run');
    const request: ModelCompletionClaimRequest = {
      completionId: `cmp_${'a'.repeat(64)}`,
      organizationId,
      projectId,
      runId,
      requestFingerprint: 'b'.repeat(64),
      claimOwner: 'gateway-1',
      leaseMs: 30_000,
      route: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          maxInputTokens: 1_000,
          maxOutputTokens: 100,
        },
      ],
    };
    const repository: ModelCompletionRepository = {
      claim: () =>
        Promise.resolve({
          status: 'claimed',
          claimExpiresAt: '2026-08-09T12:00:30.000Z',
          reservedCredits: '0.4500',
          credits: { used: '0.0000', reserved: '0.4500', ceiling: '10.0000', version: 1 },
        }),
      commit: () => Promise.reject(new Error('commit reached')),
      get: () => Promise.reject(new Error('get reached')),
      increaseCeiling: () => Promise.reject(new Error('increase reached')),
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      modelCompletions: repository,
    });
    harnesses.push(built);
    const token = await built.serviceTokens.issue('model-gateway', {
      aud: 'control-api:model-completions',
    });
    const response = await built.app.inject({
      method: 'POST',
      url: '/internal/model-completions/claim',
      headers: { [SERVICE_TOKEN_HEADER]: token },
      payload: request,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(ModelCompletionClaimResponseSchema.parse(response.json())).toMatchObject({
      status: 'claimed',
      reservedCredits: '0.4500',
    });
  });

  it('commits, reads and raises an approved ceiling through caller-scoped strict routes', async () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const runId = newId('run');
    const completionId = `cmp_${'c'.repeat(64)}`;
    const completion = {
      completionId,
      organizationId,
      projectId,
      runId,
      requestFingerprint: 'd'.repeat(64),
      events: [{ type: 'text-delta' as const, text: 'saved' }],
      terminal: { type: 'done' as const },
      usage: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          occurredAt: '2026-08-09T12:00:00.000Z',
        },
      ],
    };
    const commit: ModelCompletionCommitRequest = {
      ...completion,
      claimOwner: 'gateway-1',
    };
    const calls: string[] = [];
    const repository: ModelCompletionRepository = {
      claim: () => Promise.reject(new Error('claim reached')),
      commit: (input) => {
        calls.push(`commit:${input.completionId}`);
        return Promise.resolve({
          completion,
          credits: { used: '0.1000', reserved: '0.0000', ceiling: '10.0000', version: 2 },
          ledgerRowIds: ['usage_1'],
        });
      },
      get: (scopedOrganizationId, scopedCompletionId) => {
        calls.push(`get:${scopedOrganizationId}:${scopedCompletionId}`);
        return Promise.resolve(scopedOrganizationId === organizationId ? completion : undefined);
      },
      increaseCeiling: (input) => {
        calls.push(`increase:${input.runId}:${input.approvalId}`);
        return Promise.resolve({
          used: '0.1000',
          reserved: '0.0000',
          ceiling: input.absoluteCeiling,
          version: 3,
        });
      },
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      modelCompletions: repository,
    });
    harnesses.push(built);
    const gatewayToken = await built.serviceTokens.issue('model-gateway', {
      aud: 'control-api:model-completions',
    });
    const workerToken = await built.serviceTokens.issue('orchestrator-worker', {
      aud: 'control-api:credit-ceilings',
    });

    const committed = await built.app.inject({
      method: 'POST',
      url: `/internal/model-completions/${completionId}/commit`,
      headers: { [SERVICE_TOKEN_HEADER]: gatewayToken },
      payload: commit,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(ModelCompletionCommitResponseSchema.parse(committed.json()).completion).toEqual(
      completion,
    );

    const read = await built.app.inject({
      method: 'GET',
      url: `/internal/model-completions/${completionId}?organizationId=${organizationId}`,
      headers: { [SERVICE_TOKEN_HEADER]: gatewayToken },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(ModelCompletionGetResponseSchema.parse(read.json()).completion).toEqual(completion);

    const approvalId = newId('appr');
    const increased = await built.app.inject({
      method: 'POST',
      url: `/internal/runs/${runId}/credit-ceiling-increases`,
      headers: { [SERVICE_TOKEN_HEADER]: workerToken },
      payload: {
        organizationId,
        projectId,
        runId,
        approvalId,
        operationKey: 'approved-budget-20',
        absoluteCeiling: '20.0000',
      },
    });
    expect(increased.statusCode, increased.body).toBe(200);
    expect(CreditCeilingIncreaseResponseSchema.parse(increased.json()).credits.ceiling).toBe(
      '20.0000',
    );
    expect(calls).toEqual([
      `commit:${completionId}`,
      `get:${organizationId}:${completionId}`,
      `increase:${runId}:${approvalId}`,
    ]);
  });

  it('fails closed on wrong callers, path mismatches and cross-tenant reads', async () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const runId = newId('run');
    const completionId = `cmp_${'e'.repeat(64)}`;
    let repositoryCalls = 0;
    const repository: ModelCompletionRepository = {
      claim: () => {
        repositoryCalls += 1;
        return Promise.reject(new Error('claim must not be reached'));
      },
      commit: () => {
        repositoryCalls += 1;
        return Promise.reject(new Error('commit must not be reached'));
      },
      get: () => {
        repositoryCalls += 1;
        return Promise.resolve(undefined);
      },
      increaseCeiling: () => {
        repositoryCalls += 1;
        return Promise.reject(new Error('increase must not be reached'));
      },
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      modelCompletions: repository,
    });
    harnesses.push(built);
    const wrongCaller = await built.serviceTokens.issue('sandbox-service', {
      aud: 'control-api:model-completions',
    });
    const gatewayToken = await built.serviceTokens.issue('model-gateway', {
      aud: 'control-api:model-completions',
    });
    const commit = {
      completionId,
      organizationId,
      projectId,
      runId,
      requestFingerprint: 'f'.repeat(64),
      claimOwner: 'gateway-1',
      events: [],
      usage: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          occurredAt: '2026-08-09T12:00:00.000Z',
        },
      ],
      terminal: { type: 'done' },
    };

    const unauthorized = await built.app.inject({
      method: 'POST',
      url: `/internal/model-completions/${completionId}/commit`,
      headers: { [SERVICE_TOKEN_HEADER]: wrongCaller },
      payload: commit,
    });
    expect(unauthorized.statusCode).toBe(403);

    const mismatched = await built.app.inject({
      method: 'POST',
      url: `/internal/model-completions/cmp_${'a'.repeat(64)}/commit`,
      headers: { [SERVICE_TOKEN_HEADER]: gatewayToken },
      payload: commit,
    });
    expect(mismatched.statusCode).toBe(404);

    const missing = await built.app.inject({
      method: 'GET',
      url: `/internal/model-completions/${completionId}?organizationId=${newId('org')}`,
      headers: { [SERVICE_TOKEN_HEADER]: gatewayToken },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(organizationId);
    expect(repositoryCalls).toBe(1);
  });

  it('returns a stable conflict when a ceiling increase lacks a matching approval', async () => {
    const organizationId = newId('org');
    const projectId = newId('proj');
    const runId = newId('run');
    const repository: ModelCompletionRepository = {
      claim: () => Promise.reject(new Error('claim reached')),
      commit: () => Promise.reject(new Error('commit reached')),
      get: () => Promise.reject(new Error('get reached')),
      increaseCeiling: () =>
        Promise.reject(new CreditCeilingIncreaseRejectedError('approval_not_resolved')),
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      modelCompletions: repository,
    });
    harnesses.push(built);
    const token = await built.serviceTokens.issue('orchestrator-worker', {
      aud: 'control-api:credit-ceilings',
    });
    const response = await built.app.inject({
      method: 'POST',
      url: `/internal/runs/${runId}/credit-ceiling-increases`,
      headers: { [SERVICE_TOKEN_HEADER]: token },
      payload: {
        organizationId,
        projectId,
        runId,
        approvalId: newId('appr'),
        operationKey: 'unapproved-ceiling',
        absoluteCeiling: '20.0000',
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'credit_ceiling_increase_rejected',
    );
  });
});
