import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { CreditBalanceGate } from '../src/usage/limits.js';
import type { UsageLedgerRepository } from '../src/usage/ledger.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

describe('WEB-16 public usage summary', () => {
  it('returns tenant-scoped credits and ledger aggregates for an explicit window', async () => {
    const projectId = newId('proj');
    const runId = newId('run');
    const summary = vi.fn<UsageLedgerRepository['getUsageSummary']>(() =>
      Promise.resolve({
        byCategory: [{ category: 'model_input_tokens', credits: '1.2000' }],
        byProject: [{ projectId, credits: '1.2000' }],
        byRun: [{ runId, credits: '1.2000' }],
      }),
    );
    const availableCredits = vi.fn<CreditBalanceGate['availableCredits']>(() =>
      Promise.resolve({
        availableCredits: '82.5000',
        walletBalance: '100.0000',
        reservedCredits: '17.5000',
        source: 'wallet',
      }),
    );
    const ledger: UsageLedgerRepository = {
      recordUsage: () => Promise.reject(new Error('not used')),
      getUsageSummary: summary,
    };
    const credits: CreditBalanceGate = {
      availableCredits,
      requireRunAdmission: () => Promise.reject(new Error('not used')),
    };
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      usageLedger: ledger,
      creditBalance: credits,
    });
    harnesses.push(built);
    const owner = await signIn(built, {
      externalId: 'usage-owner',
      email: 'usage-owner@zapp.test',
      displayName: 'Usage Owner',
    });
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Usage Organization' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const organizationId = created.json<{ organization: { id: string } }>().organization.id;
    const from = '2026-08-01T00:00:00.000Z';
    const to = '2026-09-01T00:00:00.000Z';

    const response = await built.app.inject({
      method: 'GET',
      url: `/v1/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { ...owner.headers, [ORGANIZATION_HEADER]: organizationId },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      window: { from, to },
      credits: {
        available: '82.5000',
        wallet: '100.0000',
        reserved: '17.5000',
        source: 'wallet',
      },
      usage: {
        byCategory: [{ category: 'model_input_tokens', credits: '1.2000' }],
        byProject: [{ projectId, credits: '1.2000' }],
        byRun: [{ runId, credits: '1.2000' }],
      },
    });
    expect(summary).toHaveBeenCalledWith(organizationId, { from, to });
    expect(availableCredits).toHaveBeenCalledWith(organizationId);
  });

  it('returns 404 before either usage dependency can read another organization', async () => {
    const summary = vi.fn<UsageLedgerRepository['getUsageSummary']>(() =>
      Promise.resolve({ byCategory: [], byProject: [], byRun: [] }),
    );
    const availableCredits = vi.fn<CreditBalanceGate['availableCredits']>(() =>
      Promise.resolve({
        availableCredits: '0.0000',
        walletBalance: '0.0000',
        reservedCredits: '0.0000',
        source: 'wallet',
      }),
    );
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      usageLedger: {
        recordUsage: () => Promise.reject(new Error('not used')),
        getUsageSummary: summary,
      },
      creditBalance: {
        availableCredits,
        requireRunAdmission: () => Promise.reject(new Error('not used')),
      },
    });
    harnesses.push(built);
    const member = await signIn(built, {
      externalId: 'usage-member',
      email: 'usage-member@zapp.test',
      displayName: 'Usage Member',
    });

    const response = await built.app.inject({
      method: 'GET',
      url: '/v1/usage/summary?from=2026-08-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z',
      headers: { ...member.headers, [ORGANIZATION_HEADER]: newId('org') },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(summary).not.toHaveBeenCalled();
    expect(availableCredits).not.toHaveBeenCalled();
  });
});
