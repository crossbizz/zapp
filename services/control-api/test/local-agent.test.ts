import { IdempotencyHeader, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'local-agent-owner',
  email: 'owner@local-agent.test',
  displayName: 'Local Agent Owner',
};

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.app.close();
    }),
  );
});

describe('desktop local-agent public boundary', () => {
  it('creates one durable server-owned accounting scope without dispatching cloud work', async () => {
    const data = new InMemoryTenantData();
    const scope = {
      sessionId: '01912f8f-6cb0-7a52-9d3d-2b24f32062b0',
      organizationId: newId('org'),
      projectId: newId('proj'),
      runId: newId('run'),
      taskId: newId('task'),
    };
    const ensureCalls: unknown[] = [];
    const built = buildHarness({
      tenantDb: data.factory,
      localAgent: {
        sessions: {
          ensure(input: { organizationId: string }) {
            ensureCalls.push(input);
            return Promise.resolve({ ...scope, organizationId: input.organizationId });
          },
          get() {
            return Promise.resolve(undefined);
          },
        },
        gateway: { async *stream() {} },
      },
    });
    harnesses.push(built);

    const owner = await signIn(built, OWNER);
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Local Work' },
    });
    expect(organization.statusCode).toBe(201);
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;

    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/local-agent/sessions',
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: organizationId,
        [IdempotencyHeader]: 'local-session-bootstrap-1',
      },
      payload: {
        sessionId: scope.sessionId,
        localProjectName: 'Checkout prototype',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      session: {
        ...scope,
        organizationId,
      },
    });
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]).toMatchObject({
      sessionId: scope.sessionId,
      organizationId,
      userId: owner.userId,
      localProjectName: 'Checkout prototype',
    });
  });

  it('streams a completion only through the authenticated session accounting scope', async () => {
    const data = new InMemoryTenantData();
    const sessionId = '01912f8f-6cb0-7a52-9d3d-2b24f32062b1';
    const scope = {
      sessionId,
      organizationId: newId('org'),
      projectId: newId('proj'),
      runId: newId('run'),
      taskId: newId('task'),
    };
    const gatewayRequests: unknown[] = [];
    const built = buildHarness({
      tenantDb: data.factory,
      localAgent: {
        sessions: {
          ensure(input: { organizationId: string }) {
            return Promise.resolve({ ...scope, organizationId: input.organizationId });
          },
          get(input: { organizationId: string; sessionId: string }) {
            return Promise.resolve(
              input.sessionId === sessionId
                ? { ...scope, organizationId: input.organizationId }
                : undefined,
            );
          },
        },
        gateway: {
          async *stream(request: unknown) {
            await Promise.resolve();
            gatewayRequests.push(request);
            yield { type: 'text-delta', text: 'hello from the platform' };
            yield { type: 'done' };
          },
        },
      },
    });
    harnesses.push(built);

    const owner = await signIn(built, OWNER);
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Local Completion' },
    });
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/local-agent/sessions/${sessionId}/completions`,
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: organizationId,
        accept: 'text/event-stream',
      },
      payload: {
        completionId: `cmp_${'a'.repeat(64)}`,
        agentRole: 'builder',
        messages: [{ role: 'user', content: 'Change the heading' }],
        cacheBreakpointMessageIndexes: [],
        maxInputTokens: 8,
        maxOutputTokens: 64,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe(
      'data: {"type":"text-delta","text":"hello from the platform"}\n\n' +
        'data: {"type":"done"}\n\n',
    );
    expect(gatewayRequests).toEqual([
      expect.objectContaining({
        completionId: `cmp_${'a'.repeat(64)}`,
        organizationId,
        projectId: scope.projectId,
        runId: scope.runId,
        taskId: scope.taskId,
      }),
    ]);
  });

  it('returns 404 without gateway access when the session belongs to another tenant', async () => {
    const data = new InMemoryTenantData();
    const sessionId = '01912f8f-6cb0-7a52-9d3d-2b24f32062b2';
    const sessionOrganizationId = newId('org');
    const gatewayRequests: unknown[] = [];
    const built = buildHarness({
      tenantDb: data.factory,
      localAgent: {
        sessions: {
          ensure() {
            throw new Error('not used');
          },
          get(input: { organizationId: string }) {
            return Promise.resolve(
              input.organizationId === sessionOrganizationId
                ? {
                    sessionId,
                    organizationId: sessionOrganizationId,
                    projectId: newId('proj'),
                    runId: newId('run'),
                    taskId: newId('task'),
                  }
                : undefined,
            );
          },
        },
        gateway: {
          async *stream(request: unknown) {
            await Promise.resolve();
            gatewayRequests.push(request);
          },
        },
      },
    });
    harnesses.push(built);

    const owner = await signIn(built, OWNER);
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Different tenant' },
    });
    const requestedOrganizationId = organization.json<{ organization: { id: string } }>()
      .organization.id;
    expect(requestedOrganizationId).not.toBe(sessionOrganizationId);

    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/local-agent/sessions/${sessionId}/completions`,
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: requestedOrganizationId,
        accept: 'text/event-stream',
      },
      payload: {
        completionId: `cmp_${'b'.repeat(64)}`,
        agentRole: 'builder',
        messages: [{ role: 'user', content: 'Do not cross the tenant boundary' }],
        cacheBreakpointMessageIndexes: [],
        maxInputTokens: 8,
        maxOutputTokens: 64,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: 'local_agent_session_not_found',
        message: 'That local session does not exist.',
      },
    });
    expect(gatewayRequests).toEqual([]);
  });
});
