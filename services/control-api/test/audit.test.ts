import { ApiErrorSchema, newId } from '@zapp/contracts';
import type { AuditEvent } from '@zapp/db';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import type { IdempotencyStore } from '../src/plugins/idempotency.js';
import type { InMemoryAuditSink } from '../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import {
  buildHarness,
  signIn,
  type Harness,
  type HarnessOptions,
  type TestSession,
} from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'audit-reader-owner',
  email: 'owner@audit-reader.test',
  displayName: 'Olivia Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'audit-reader-builder',
  email: 'builder@audit-reader.test',
  displayName: 'Bea Builder',
};
const FOREIGN_OWNER: AuthIdentity = {
  externalId: 'audit-reader-foreign-owner',
  email: 'foreign-owner@audit-reader.test',
  displayName: 'Farah Foreign',
};

interface Wired {
  readonly built: Harness;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly rows: AuditEvent[];
  headers(session: TestSession): Record<string, string>;
}

async function wire(options: Pick<HarnessOptions, 'audit' | 'idempotency'> = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const rows: AuditEvent[] = [];
  Object.assign(data, { auditEvents: rows });
  const built = buildHarness({ ...options, tenantDb: data.factory });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const created = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Audit Factory' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json<{ organization: { id: string } }>().organization.id;
  return {
    built,
    owner,
    organizationId,
    rows,
    headers: (session) => ({
      ...session.headers,
      [ORGANIZATION_HEADER]: organizationId,
    }),
  };
}

async function createForeignOrganization(wired: Wired): Promise<string> {
  const foreign = await signIn(wired.built, FOREIGN_OWNER);
  const response = await wired.built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: foreign.headers,
    payload: { name: 'Foreign Factory' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ organization: { id: string } }>().organization.id;
}

async function joinBuilder(wired: Wired): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: BUILDER.email, role: 'builder' },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const builder = await signIn(wired.built, BUILDER);
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${invited.json<{ token: string }>().token}/accept`,
    headers: builder.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return builder;
}

function auditRow(
  wired: Wired,
  input: Partial<AuditEvent> &
    Pick<AuditEvent, 'action' | 'targetType' | 'targetId' | 'occurredAt'>,
): AuditEvent {
  return {
    id: newId('aud'),
    organizationId: wired.organizationId,
    actorType: 'user',
    actorId: wired.owner.userId,
    metadataJson: {},
    ...input,
  };
}

describe('organization audit log reads', () => {
  it('denies a Builder with 403 after resolving their real membership', async () => {
    const wired = await wire();
    const builder = await joinBuilder(wired);

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/organizations/${wired.organizationId}/audit-events`,
      headers: wired.headers(builder),
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('permission_denied');
  });

  it('combines actor, action, target, and inclusive time-range filters', async () => {
    const wired = await wire();
    const wantedTarget = newId('proj');
    const otherTarget = newId('proj');
    wired.rows.push(
      auditRow(wired, {
        action: 'project.updated',
        targetType: 'project',
        targetId: wantedTarget,
        occurredAt: new Date('2026-08-05T10:30:00.000Z'),
        metadataJson: { fields: ['name'] },
      }),
      auditRow(wired, {
        action: 'project.created',
        targetType: 'project',
        targetId: wantedTarget,
        occurredAt: new Date('2026-08-05T10:30:00.000Z'),
      }),
      auditRow(wired, {
        action: 'project.updated',
        targetType: 'project',
        targetId: otherTarget,
        occurredAt: new Date('2026-08-05T10:30:00.000Z'),
      }),
      auditRow(wired, {
        action: 'project.updated',
        targetType: 'project',
        targetId: wantedTarget,
        occurredAt: new Date('2026-08-05T09:59:59.999Z'),
      }),
    );

    const query = new URLSearchParams({
      actorId: wired.owner.userId,
      action: 'project.updated',
      targetType: 'project',
      targetId: wantedTarget,
      from: '2026-08-05T10:00:00.000Z',
      to: '2026-08-05T11:00:00.000Z',
    });
    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/organizations/${wired.organizationId}/audit-events?${query.toString()}`,
      headers: wired.headers(wired.owner),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: wired.rows[0]?.id,
          organizationId: wired.organizationId,
          actorType: 'user',
          actorId: wired.owner.userId,
          action: 'project.updated',
          targetType: 'project',
          targetId: wantedTarget,
          metadata: { fields: ['name'] },
          occurredAt: '2026-08-05T10:30:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('rejects inverted time ranges after normalizing offsets and unknown filters', async () => {
    const wired = await wire();
    const inverted = new URLSearchParams({
      from: '2026-08-05T10:00:00-05:00',
      to: '2026-08-05T14:00:00Z',
    });

    const range = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/organizations/${wired.organizationId}/audit-events?${inverted.toString()}`,
      headers: wired.headers(wired.owner),
    });
    expect(range.statusCode, range.body).toBe(400);

    const unknown = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/organizations/${wired.organizationId}/audit-events?provider=anthropic`,
      headers: wired.headers(wired.owner),
    });
    expect(unknown.statusCode, unknown.body).toBe(400);
  });

  it('walks keyset pages to exhaustion without duplicates or foreign rows', async () => {
    const wired = await wire();
    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const row = auditRow(wired, {
        action: 'project.updated',
        targetType: 'project',
        targetId: newId('proj'),
        occurredAt: new Date(`2026-08-05T10:0${String(index)}:00.000Z`),
      });
      wired.rows.push(row);
      expected.unshift(row.id);
    }
    wired.rows.push({
      ...auditRow(wired, {
        action: 'project.updated',
        targetType: 'project',
        targetId: newId('proj'),
        occurredAt: new Date('2026-08-05T12:00:00.000Z'),
      }),
      organizationId: newId('org'),
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '2' });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await wired.built.app.inject({
        method: 'GET',
        url: `/v1/organizations/${wired.organizationId}/audit-events?${query.toString()}`,
        headers: wired.headers(wired.owner),
      });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('returns foreign organization 404 before applying Builder authorization', async () => {
    const wired = await wire();
    const builder = await joinBuilder(wired);
    const foreignOrganizationId = await createForeignOrganization(wired);
    wired.rows.push({
      ...auditRow(wired, {
        action: 'project.updated',
        targetType: 'project',
        targetId: newId('proj'),
        occurredAt: new Date('2026-08-05T12:00:00.000Z'),
      }),
      organizationId: foreignOrganizationId,
    });

    for (const request of [
      { method: 'GET' as const, suffix: 'audit-events', payload: undefined },
      { method: 'GET' as const, suffix: 'settings', payload: undefined },
      { method: 'PATCH' as const, suffix: 'settings', payload: { builderCanDeploy: true } },
    ]) {
      const response = await wired.built.app.inject({
        method: request.method,
        url: `/v1/organizations/${foreignOrganizationId}/${request.suffix}`,
        headers: {
          ...builder.headers,
          [ORGANIZATION_HEADER]: foreignOrganizationId,
          'idempotency-key': 'foreign-settings-denied-01',
        },
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('organization_not_found');
    }
  });
});

describe('organization settings', () => {
  it('denies Builder reads and writes for their own organization', async () => {
    const wired = await wire();
    const builder = await joinBuilder(wired);

    for (const request of [
      { method: 'GET' as const, payload: undefined },
      { method: 'PATCH' as const, payload: { builderCanDeploy: true } },
    ]) {
      const response = await wired.built.app.inject({
        method: request.method,
        url: `/v1/organizations/${wired.organizationId}/settings`,
        headers: {
          ...wired.headers(builder),
          'idempotency-key': 'builder-settings-denied-01',
        },
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(ApiErrorSchema.parse(response.json()).error.code).toBe('permission_denied');
    }
  });

  it('returns fail-closed defaults for an existing organization', async () => {
    const wired = await wire();

    const response = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/organizations/${wired.organizationId}/settings`,
      headers: wired.headers(wired.owner),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ settings: { builderCanDeploy: false } });
  });

  it('strictly partial-merges both owned keys and passes arbitrary JSON through', async () => {
    const wired = await wire();
    const policy = { route: ['quality', { providers: ['anthropic', null] }], budget: 12.5 };

    const first = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${wired.organizationId}/settings`,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-policy-01' },
      payload: { defaultModelPolicy: policy },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({
      settings: { builderCanDeploy: false, defaultModelPolicy: policy },
    });

    const second = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${wired.organizationId}/settings`,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-deploy-01' },
      payload: { builderCanDeploy: true },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual({
      settings: { builderCanDeploy: true, defaultModelPolicy: policy },
    });

    const events = wired.built.audit.events.filter(
      (event) => event.action === 'organization.settings_updated',
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      organizationId: wired.organizationId,
      actorId: wired.owner.userId,
      targetType: 'organization',
      targetId: wired.organizationId,
      metadata: { changedFields: ['defaultModelPolicy'], noOp: false },
    });
  });

  it('records a fresh-key same-value PATCH as a completed no-op', async () => {
    const wired = await wire();
    const response = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${wired.organizationId}/settings`,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-no-op-01' },
      payload: { builderCanDeploy: false },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-idempotent-replay']).toBeUndefined();
    expect(response.json()).toEqual({ settings: { builderCanDeploy: false } });
    const settingsEvents = wired.built.audit.events.filter(
      (event) => event.action === 'organization.settings_updated',
    );
    expect(settingsEvents).toHaveLength(1);
    expect(settingsEvents[0]?.metadata.changedFields).toEqual([]);
    expect(settingsEvents[0]?.metadata.noOp).toBe(true);
    expect(settingsEvents[0]?.metadata.operationKey).toMatch(/^op_[0-9a-f]{64}$/);
  });

  it('rejects unknown keys, empty patches, and missing idempotency before writing', async () => {
    const wired = await wire();
    const requests = [
      {
        headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-unknown-01' },
        payload: { surprise: true },
      },
      {
        headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-empty-01' },
        payload: {},
      },
      { headers: wired.headers(wired.owner), payload: { builderCanDeploy: true } },
    ];

    for (const request of requests) {
      const response = await wired.built.app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${wired.organizationId}/settings`,
        ...request,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await wired.built.organizations.getSettings(wired.organizationId)).toEqual({
      builderCanDeploy: false,
    });
    expect(
      wired.built.audit.events.filter((event) => event.action === 'organization.settings_updated'),
    ).toEqual([]);
  });

  it('replays one PATCH without applying or auditing it twice', async () => {
    const wired = await wire();
    const request = {
      method: 'PATCH' as const,
      url: `/v1/organizations/${wired.organizationId}/settings`,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-replay-01' },
      payload: { builderCanDeploy: true },
    };

    const first = await wired.built.app.inject(request);
    const replay = await wired.built.app.inject(request);

    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(
      wired.built.audit.events.filter((event) => event.action === 'organization.settings_updated'),
    ).toHaveLength(1);
  });

  it('recognizes a lost-response retry and does not overwrite an intervening patch', async () => {
    const unavailableAfterCommit: IdempotencyStore = {
      reserve: () => Promise.resolve(undefined),
      complete: () => Promise.reject(new Error('redis unavailable after commit')),
      release: () => Promise.resolve(),
    };
    const wired = await wire({ idempotency: unavailableAfterCommit });
    const url = `/v1/organizations/${wired.organizationId}/settings`;
    const oldRequest = {
      method: 'PATCH' as const,
      url,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-lost-old-01' },
      payload: { builderCanDeploy: true },
    };

    expect((await wired.built.app.inject(oldRequest)).statusCode).toBe(200);
    const intervening = await wired.built.app.inject({
      method: 'PATCH',
      url,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-lost-new-01' },
      payload: { builderCanDeploy: false },
    });
    expect(intervening.statusCode, intervening.body).toBe(200);
    const retry = await wired.built.app.inject(oldRequest);

    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual({ settings: { builderCanDeploy: false } });
    expect(
      wired.built.audit.events.filter((event) => event.action === 'organization.settings_updated'),
    ).toHaveLength(2);
  });

  it('commits neither settings nor an audit row when the in-transaction audit fails', async () => {
    let fail = false;
    const events: InMemoryAuditSink['events'] extends readonly (infer T)[] ? T[] : never[] = [];
    const audit: InMemoryAuditSink = {
      events,
      record: (_tx, event) => {
        if (fail) return Promise.reject(new Error('audit refused'));
        events.push(event);
        return Promise.resolve();
      },
      recordDetached: (event) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    const wired = await wire({ audit });
    const before = events.length;
    fail = true;

    const response = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${wired.organizationId}/settings`,
      headers: { ...wired.headers(wired.owner), 'idempotency-key': 'settings-audit-fail-01' },
      payload: { builderCanDeploy: true },
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(await wired.built.organizations.getSettings(wired.organizationId)).toEqual({
      builderCanDeploy: false,
    });
    expect(events).toHaveLength(before);
  });
});
