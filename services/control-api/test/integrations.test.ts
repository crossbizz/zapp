import { ApiErrorSchema, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { NO_TRANSACTION } from '../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { IntegrationPort, IntegrationMutationInput } from '../src/routes/integrations.js';
import type { IntegrationConnectionView } from '../src/tenant/view.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((built) => built.app.close())); });

const OWNER: AuthIdentity = { externalId: 'integration-owner', email: 'owner@integration.test', displayName: 'Olivia Owner' };
const BUILDER: AuthIdentity = { externalId: 'integration-builder', email: 'builder@integration.test', displayName: 'Bea Builder' };
const VIEWER: AuthIdentity = { externalId: 'integration-viewer', email: 'viewer@integration.test', displayName: 'Vera Viewer' };
const CREDENTIAL = 'credential-must-not-leak-4fa22d';

class RecordingIntegrationPort implements IntegrationPort {
  readonly calls: IntegrationMutationInput[] = [];
  readonly auditMetadata: Array<Record<string, unknown>> = [];
  fail = false;

  async connect(input: IntegrationMutationInput): Promise<IntegrationConnectionView> {
    const configuration = input.configuration;
    if (this.fail) throw new Error(`provider rejected ${CREDENTIAL}`);
    const result = {
      id: newId('intc'),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      provider: input.provider,
      status: 'connected',
      credentialRef: 'vault://integration/ref',
      configuration,
    };
    await input.audit(NO_TRANSACTION, result);
    this.calls.push(input);
    this.auditMetadata.push({ provider: input.provider, projectId: input.projectId ?? null, configuration });
    return result;
  }
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly integrations: RecordingIntegrationPort;
  as: (session: TestSession) => Record<string, string>;
}

async function wire(): Promise<Wired> {
  const data = new InMemoryTenantData();
  const integrations = new RecordingIntegrationPort();
  const built = buildHarness({ tenantDb: data.factory, integrationPort: integrations });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({ method: 'POST', url: '/v1/organizations', headers: owner.headers, payload: { name: 'Integration Factory' } });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const as = (session: TestSession): Record<string, string> => ({ ...session.headers, [ORGANIZATION_HEADER]: organizationId });
  const project = await built.app.inject({ method: 'POST', url: '/v1/projects', headers: as(owner), payload: { name: 'Integration Target' } });
  expect(project.statusCode, project.body).toBe(201);
  return { built, data, owner, organizationId, projectId: project.json<{ project: { id: string } }>().project.id, integrations, as };
}

async function join(wired: Wired, identity: AuthIdentity, role: 'builder' | 'viewer'): Promise<TestSession> {
  const invited = await wired.built.app.inject({ method: 'POST', url: `/v1/organizations/${wired.organizationId}/invites`, headers: wired.owner.headers, payload: { email: identity.email, role } });
  expect(invited.statusCode, invited.body).toBe(201);
  const member = await signIn(wired.built, identity);
  expect((await wired.built.app.inject({ method: 'POST', url: `/v1/invites/${invited.json<{ token: string }>().token}/accept`, headers: member.headers })).statusCode).toBe(200);
  return member;
}

function headers(wired: Wired, session: TestSession, key: string): Record<string, string> {
  return { ...wired.as(session), 'idempotency-key': key };
}

function requestFor(provider: 'github' | 'supabase' | 'neon' | 'stripe', projectId: string): { readonly url: string; readonly body: Record<string, unknown> } {
  switch (provider) {
    case 'github': return { url: '/v1/integrations/github/install', body: { installationId: '1188', state: 'oauth-state', code: CREDENTIAL } };
    case 'supabase': return { url: '/v1/integrations/supabase/connect', body: { projectId, accessToken: CREDENTIAL, configuration: { projectRef: 'acme-db' } } };
    case 'neon': return { url: '/v1/integrations/neon/connect', body: { projectId, apiKey: CREDENTIAL, configuration: { projectId: 'neon-db' } } };
    case 'stripe': return { url: '/v1/integrations/stripe/connect', body: { projectId, apiKey: CREDENTIAL, configuration: { accountId: 'acct_123', mode: 'test' } } };
  }
}

describe('integration route shells', () => {
  it.each(['github', 'supabase', 'neon', 'stripe'] as const)('connects %s with a safe strict connection view', async (provider) => {
    const wired = await wire();
    const request = requestFor(provider, wired.projectId);
    const response = await wired.built.app.inject({ method: 'POST', url: request.url, headers: headers(wired, wired.owner, `connect-${provider}-01`), payload: request.body });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ connection: { organizationId: wired.organizationId, provider, status: 'connected' } });
    expect(response.body).not.toContain(CREDENTIAL);
    expect(JSON.stringify(wired.integrations.auditMetadata)).not.toContain(CREDENTIAL);
    expect(wired.integrations.calls[0]).toMatchObject({
      organizationId: wired.organizationId,
      actorId: wired.owner.userId,
      projectId: provider === 'github' ? null : wired.projectId,
    });
    expect(wired.integrations.calls[0]?.operationKey).toMatch(/^op_[a-f0-9]{64}$/);
    const audit = wired.built.audit.events.at(-1);
    expect(audit).toMatchObject({
      organizationId: wired.organizationId,
      actorId: wired.owner.userId,
      action: 'integration.connected',
      targetType: 'integration_connection',
      targetId: response.json<{ connection: { id: string } }>().connection.id,
      metadata: { provider, projectId: provider === 'github' ? null : wired.projectId },
    });
    expect(audit?.metadata.operationKey).toMatch(/^op_[a-f0-9]{64}$/);
    expect(JSON.stringify(audit)).not.toContain(CREDENTIAL);
  });

  it('allows Builder project connections but keeps org GitHub installation Owner-only and denies Viewer', async () => {
    const wired = await wire();
    const builder = await join(wired, BUILDER, 'builder');
    const supabase = requestFor('supabase', wired.projectId);
    expect((await wired.built.app.inject({ method: 'POST', url: supabase.url, headers: headers(wired, builder, 'builder-supabase-01'), payload: supabase.body })).statusCode).toBe(201);
    const github = requestFor('github', wired.projectId);
    expect((await wired.built.app.inject({ method: 'POST', url: github.url, headers: headers(wired, builder, 'builder-github-01'), payload: github.body })).statusCode).toBe(403);
    const viewer = await join(wired, VIEWER, 'viewer');
    expect((await wired.built.app.inject({ method: 'POST', url: supabase.url, headers: headers(wired, viewer, 'viewer-supabase-01'), payload: supabase.body })).statusCode).toBe(403);
  });

  it('returns 404 before RBAC for a real foreign project id', async () => {
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');
    const foreign = await createForeignProject(wired);
    expect((await wired.built.app.inject({ method: 'GET', url: `/v1/projects/${foreign.projectId}`, headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: foreign.organizationId } })).statusCode).toBe(200);
    const request = requestFor('neon', foreign.projectId);
    const response = await wired.built.app.inject({ method: 'POST', url: request.url, headers: headers(wired, viewer, 'foreign-project-01'), payload: request.body });
    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('project_not_found');
    expect(wired.integrations.calls).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'integration.connected')).toEqual([]);
  });

  it('rolls back an integration connection when its audit callback fails', async () => {
    const wired = await wire();
    const failingAudit = wired.built.audit as unknown as { record: () => Promise<void> };
    failingAudit.record = () => Promise.reject(new Error('audit sink unavailable'));
    const request = requestFor('stripe', wired.projectId);
    const response = await wired.built.app.inject({ method: 'POST', url: request.url, headers: headers(wired, wired.owner, 'integration-audit-fail-01'), payload: request.body });
    expect(response.statusCode).toBe(502);
    expect(wired.integrations.calls).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'integration.connected')).toEqual([]);
  });

  it('replays exactly once and forwards tenant actor and stable operation key', async () => {
    const wired = await wire();
    const request = requestFor('stripe', wired.projectId);
    const requestHeaders = headers(wired, wired.owner, 'stripe-replay-01');
    expect((await wired.built.app.inject({ method: 'POST', url: request.url, headers: requestHeaders, payload: request.body })).statusCode).toBe(201);
    const replay = await wired.built.app.inject({ method: 'POST', url: request.url, headers: requestHeaders, payload: request.body });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(wired.integrations.calls).toHaveLength(1);
    expect(wired.integrations.calls[0]).toMatchObject({ organizationId: wired.organizationId, actorId: wired.owner.userId, projectId: wired.projectId });
    expect(wired.integrations.calls[0]?.operationKey).toMatch(/^op_[a-f0-9]{64}$/);
  });

  it('rejects provider-mismatched, unrecognized, and secret-echoing failures', async () => {
    const wired = await wire();
    const mismatch = await wired.built.app.inject({ method: 'POST', url: '/v1/integrations/neon/connect', headers: headers(wired, wired.owner, 'neon-invalid-01'), payload: { projectId: wired.projectId, apiKey: CREDENTIAL, configuration: { projectRef: 'not-neon' } } });
    expect(mismatch.statusCode).toBe(400);
    const unknown = await wired.built.app.inject({ method: 'POST', url: '/v1/integrations/stripe/connect', headers: headers(wired, wired.owner, 'stripe-unknown-01'), payload: { ...requestFor('stripe', wired.projectId).body, extra: true } });
    expect(unknown.statusCode).toBe(400);
    wired.integrations.fail = true;
    const failure = await wired.built.app.inject({ method: 'POST', url: '/v1/integrations/supabase/connect', headers: headers(wired, wired.owner, 'supabase-failure-01'), payload: requestFor('supabase', wired.projectId).body });
    expect(failure.statusCode).toBe(502);
    expect(failure.body).not.toContain(CREDENTIAL);
  });
});

async function createForeignProject(wired: Wired): Promise<{ organizationId: string; projectId: string }> {
  const organization = await wired.built.app.inject({ method: 'POST', url: '/v1/organizations', headers: wired.owner.headers, payload: { name: 'Foreign Integration Factory' } });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const project = await wired.built.app.inject({ method: 'POST', url: '/v1/projects', headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: organizationId }, payload: { name: 'Foreign Integration Target' } });
  expect(project.statusCode, project.body).toBe(201);
  return { organizationId, projectId: project.json<{ project: { id: string } }>().project.id };
}
