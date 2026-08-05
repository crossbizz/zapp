import { ApiErrorSchema, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { NO_TRANSACTION, type AuditHook } from '../src/plugins/audit.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type {
  ApproveReleaseMutationInput,
  CreateReleaseMutationInput,
  DeployReleaseMutationInput,
  DeploymentResult,
  EvidenceManifest,
  ReadinessReport,
  ReleaseLookupInput,
  ReleasePort,
  ReleaseRow,
  RollbackReleaseMutationInput,
} from '../src/routes/releases.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'release-owner',
  email: 'owner@release.test',
  displayName: 'Olivia Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'release-builder',
  email: 'builder@release.test',
  displayName: 'Bea Builder',
};
const VIEWER: AuthIdentity = {
  externalId: 'release-viewer',
  email: 'viewer@release.test',
  displayName: 'Vera Viewer',
};

class RecordingReleasePort implements ReleasePort {
  readonly creates: CreateReleaseMutationInput[] = [];
  readonly approvals: ApproveReleaseMutationInput[] = [];
  readonly deploys: DeployReleaseMutationInput[] = [];
  readonly rollbacks: RollbackReleaseMutationInput[] = [];
  fail = false;
  invalid = false;
  createResultOverride: Partial<ReleaseRow> | undefined;
  approveResultOverride: Partial<ReleaseRow> | undefined;
  skipCreateAudit = false;
  skipApproveAudit = false;
  lookupOverrideId: string | undefined;
  evidenceResultOverride: Partial<EvidenceManifest> | undefined;
  readonly releaseId = newId('rel');
  readonly releases = new Map<string, ReleaseRow>();

  release(): ReleaseRow {
    return {
      id: this.releaseId,
      organizationId: this.creates[0]?.organizationId ?? 'org_01J00000000000000000000000',
      projectId: 'proj_01J00000000000000000000000',
      environmentId: 'env_01J00000000000000000000000',
      commitSha: 'a'.repeat(40),
      specificationId: null,
      status: 'ready',
      evidenceManifestArtifactId: null,
      createdBy: this.creates[0]?.actorId ?? 'user_01J0000000000000000000000',
      createdAt: new Date('2026-08-04T12:00:00.000Z'),
    };
  }

  async createReleaseCandidate(input: CreateReleaseMutationInput): Promise<ReleaseRow> {
    if (this.fail) throw new Error('provider token is never public');
    if (this.invalid) {
      const invalid = { privateProviderThing: true };
      this.creates.push(input);
      return invalid as unknown as ReleaseRow;
    }
    const row = {
      ...this.release(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      specificationId: input.specificationId,
      createdBy: input.actorId,
      ...this.createResultOverride,
    };
    if (this.skipCreateAudit) return row;
    await this.record(input, row);
    this.creates.push(input);
    this.releases.set(row.id, row);
    return row;
  }
  getRelease(input: ReleaseLookupInput): Promise<ReleaseRow | undefined> {
    const row = this.releases.get(this.lookupOverrideId ?? input.releaseId);
    return Promise.resolve(row?.organizationId === input.organizationId ? row : undefined);
  }
  getReadiness(): Promise<ReadinessReport> {
    return Promise.resolve({
      state: 'ready',
      findings: [
        {
          id: 'build',
          severity: 'warning',
          title: 'Optional check',
          detail: 'A non-blocking check needs review.',
          action: 'review',
        },
      ],
    });
  }
  async approve(input: ApproveReleaseMutationInput): Promise<ReleaseRow> {
    const release = this.releases.get(input.releaseId);
    const row = release === undefined ? undefined : { ...release, ...this.approveResultOverride };
    if (row === undefined) throw new Error('release missing');
    if (this.skipApproveAudit) return row;
    await this.record(input, row);
    this.approvals.push(input);
    return row;
  }
  async deploy(input: DeployReleaseMutationInput): Promise<DeploymentResult> {
    if (this.fail) throw new Error('provider token is never public');
    const result = { deploymentId: newId('dep') };
    await this.record(input, result);
    this.deploys.push(input);
    return result;
  }
  async rollback(input: RollbackReleaseMutationInput): Promise<DeploymentResult> {
    const result = { deploymentId: newId('dep') };
    await this.record(input, result);
    this.rollbacks.push(input);
    return result;
  }
  getEvidence(input: ReleaseLookupInput): Promise<EvidenceManifest> {
    return Promise.resolve({
      release_id: input.releaseId,
      commit_sha: 'a'.repeat(40),
      specification_version: 1,
      criteria: [],
      build: { status: 'passed' },
      typecheck: { status: 'passed' },
      tests: { status: 'passed' },
      browser_tests: { status: 'passed' },
      security: { status: 'passed' },
      migration: { status: 'not_required' },
      preview: { url: 'https://preview.zapp.test' },
      rollback: { supported: true },
      known_risks: [],
      ...this.evidenceResultOverride,
    });
  }
  seed(row: ReleaseRow): void {
    this.releases.set(row.id, row);
  }
  private async record<TResult>(input: { readonly audit: AuditHook<TResult> }, result: TResult): Promise<void> {
    await input.audit(NO_TRANSACTION, result);
  }
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly releases: RecordingReleasePort;
  as: (session: TestSession) => Record<string, string>;
}

async function wire(): Promise<Wired> {
  const data = new InMemoryTenantData();
  const releases = new RecordingReleasePort();
  const built = buildHarness({
    tenantDb: data.factory,
    releasePort: releases,
  });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({
    method: 'POST', url: '/v1/organizations', headers: owner.headers, payload: { name: 'Release Factory' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const as = (session: TestSession): Record<string, string> => ({ ...session.headers, [ORGANIZATION_HEADER]: organizationId });
  const project = await built.app.inject({
    method: 'POST', url: '/v1/projects', headers: as(owner), payload: { name: 'Release Target' },
  });
  expect(project.statusCode, project.body).toBe(201);
  const body = project.json<{ project: { id: string }; environments: { id: string; type: string }[] }>();
  return { built, data, owner, organizationId, projectId: body.project.id, environmentId: body.environments.find((entry) => entry.type === 'production')?.id ?? '', releases, as };
}

async function join(wired: Wired, identity: AuthIdentity, role: 'builder' | 'viewer'): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST', url: `/v1/organizations/${wired.organizationId}/invites`, headers: wired.owner.headers,
    payload: { email: identity.email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const member = await signIn(wired.built, identity);
  const accepted = await wired.built.app.inject({
    method: 'POST', url: `/v1/invites/${invited.json<{ token: string }>().token}/accept`, headers: member.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return member;
}

function mutationHeaders(wired: Wired, session: TestSession, key: string): Record<string, string> {
  return { ...wired.as(session), 'idempotency-key': key };
}

const candidateBody = (wired: Wired) => ({
  environmentId: wired.environmentId,
  commitSha: 'a'.repeat(40),
  specificationId: null,
});

describe('release route shells', () => {
  it('lets Owner create, read, approve, deploy, rollback, and read strict evidence', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-create-01'), payload: candidateBody(wired) });
    expect(created.statusCode, created.body).toBe(201);
    const releaseId = created.json<{ release: { id: string } }>().release.id;
    expect((await wired.built.app.inject({ method: 'GET', url: `/v1/releases/${releaseId}`, headers: wired.as(wired.owner) })).statusCode).toBe(200);
    expect((await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/approve`, headers: mutationHeaders(wired, wired.owner, 'release-approve-01') })).statusCode).toBe(200);
    expect((await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/deploy`, headers: mutationHeaders(wired, wired.owner, 'release-deploy-01'), payload: { deploymentType: 'first_deploy' } })).statusCode).toBe(200);
    expect((await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/rollback`, headers: mutationHeaders(wired, wired.owner, 'release-rollback-01'), payload: { reason: 'Restore the prior healthy deployment.' } })).statusCode).toBe(200);
    const evidence = await wired.built.app.inject({ method: 'GET', url: `/v1/releases/${releaseId}/evidence`, headers: wired.as(wired.owner) });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json()).toMatchObject({ evidence: { release_id: releaseId, rollback: { supported: true } } });
    for (const call of [
      ...wired.releases.creates,
      ...wired.releases.approvals,
      ...wired.releases.deploys,
      ...wired.releases.rollbacks,
    ]) {
      expect(call).toMatchObject({
        organizationId: wired.organizationId,
        actorId: wired.owner.userId,
      });
      expect(call.operationKey).toMatch(/^op_[a-f0-9]{64}$/);
    }
    const auditEvents = wired.built.audit.events.filter((event) => event.action.startsWith('release.'));
    const releaseCalls = [
      ...wired.releases.creates,
      ...wired.releases.approvals,
      ...wired.releases.deploys,
      ...wired.releases.rollbacks,
    ];
    expect(auditEvents.map((event) => event.action)).toEqual([
      'release.created',
      'release.approved',
      'release.deploy_requested',
      'release.rollback_requested',
    ]);
    for (const [index, event] of auditEvents.entries()) {
      expect(event).toMatchObject({
        organizationId: wired.organizationId,
        actorId: wired.owner.userId,
        targetType: 'release',
        targetId: releaseId,
      });
      expect(event.metadata.operationKey).toBe(releaseCalls[index]?.operationKey);
    }
  });

  it('allows Builder create/read but reads persisted organization settings before deployment', async () => {
    const denied = await wire();
    const builder = await join(denied, BUILDER, 'builder');
    const created = await denied.built.app.inject({ method: 'POST', url: `/v1/projects/${denied.projectId}/releases`, headers: mutationHeaders(denied, builder, 'builder-create-01'), payload: candidateBody(denied) });
    expect(created.statusCode, created.body).toBe(201);
    const releaseId = created.json<{ release: { id: string } }>().release.id;
    expect((await denied.built.app.inject({ method: 'GET', url: `/v1/releases/${releaseId}`, headers: denied.as(builder) })).statusCode).toBe(200);
    const deploy = await denied.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/deploy`, headers: mutationHeaders(denied, builder, 'builder-deploy-denied'), payload: { deploymentType: 'redeploy' } });
    expect(deploy.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(deploy.json()).error.code).toBe('permission_denied');
    expect(denied.releases.deploys).toHaveLength(0);
    const viewer = await join(denied, VIEWER, 'viewer');
    expect((await denied.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/approve`, headers: mutationHeaders(denied, viewer, 'viewer-approve-denied') })).statusCode).toBe(403);

    const allowed = await wire();
    const enabled = await allowed.built.app.inject({ method: 'PATCH', url: `/v1/organizations/${allowed.organizationId}/settings`, headers: mutationHeaders(allowed, allowed.owner, 'release-enable-builder-deploy-01'), payload: { builderCanDeploy: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const allowedBuilder = await join(allowed, { ...BUILDER, email: 'allowed-builder@release.test' }, 'builder');
    const allowedCreated = await allowed.built.app.inject({ method: 'POST', url: `/v1/projects/${allowed.projectId}/releases`, headers: mutationHeaders(allowed, allowedBuilder, 'builder-create-02'), payload: candidateBody(allowed) });
    const allowedReleaseId = allowedCreated.json<{ release: { id: string } }>().release.id;
    expect((await allowed.built.app.inject({ method: 'POST', url: `/v1/releases/${allowedReleaseId}/deploy`, headers: mutationHeaders(allowed, allowedBuilder, 'builder-deploy-allowed'), payload: { deploymentType: 'redeploy' } })).statusCode).toBe(200);
    expect(allowed.releases.deploys).toHaveLength(1);
  });

  it('returns a tenant-hidden 404 before Viewer RBAC for a foreign release', async () => {
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');
    const foreign = await createForeignProject(wired);
    const releaseId = newId('rel');
    wired.releases.seed({
      ...wired.releases.release(), id: releaseId, organizationId: foreign.organizationId,
      projectId: foreign.projectId, environmentId: foreign.environmentId, createdBy: wired.owner.userId,
    });
    expect((await wired.built.app.inject({ method: 'GET', url: `/v1/releases/${releaseId}`, headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: foreign.organizationId } })).statusCode).toBe(200);
    for (const request of [
      { key: 'foreign-release-read', method: 'GET' as const, url: `/v1/releases/${releaseId}`, payload: undefined },
      { key: 'foreign-release-evidence', method: 'GET' as const, url: `/v1/releases/${releaseId}/evidence`, payload: undefined },
      { key: 'foreign-release-approve', method: 'POST' as const, url: `/v1/releases/${releaseId}/approve`, payload: undefined },
      { key: 'foreign-release-deploy', method: 'POST' as const, url: `/v1/releases/${releaseId}/deploy`, payload: { deploymentType: 'redeploy' } },
      { key: 'foreign-release-rollback', method: 'POST' as const, url: `/v1/releases/${releaseId}/rollback`, payload: { reason: 'foreign resource' } },
    ]) {
      const options = request.payload === undefined
        ? { method: request.method, url: request.url, headers: wired.as(viewer) }
        : { method: request.method, url: request.url, headers: mutationHeaders(wired, viewer, request.key), payload: request.payload };
      const response = await wired.built.app.inject(options);
      expect(response.statusCode).toBe(404);
      expect(ApiErrorSchema.parse(JSON.parse(response.body) as unknown).error.code).toBe('release_not_found');
    }
    expect(wired.releases.approvals).toHaveLength(0);
    expect(wired.releases.deploys).toHaveLength(0);
    expect(wired.releases.rollbacks).toHaveLength(0);
    expect(wired.built.audit.events.filter((event) => event.action.startsWith('release.'))).toEqual([]);
  });

  it('rejects a same-tenant different release returned for reads and mutations', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-requested-source-01'), payload: candidateBody(wired) });
    expect(created.statusCode, created.body).toBe(201);
    const requestedReleaseId = created.json<{ release: { id: string } }>().release.id;
    const returnedReleaseId = newId('rel');
    wired.releases.seed({
      ...wired.releases.release(),
      id: returnedReleaseId,
      organizationId: wired.organizationId,
      projectId: wired.projectId,
      environmentId: wired.environmentId,
      commitSha: 'b'.repeat(40),
      createdBy: wired.owner.userId,
    });
    wired.releases.lookupOverrideId = returnedReleaseId;
    const auditCount = wired.built.audit.events.length;
    for (const request of [
      { key: 'same-tenant-wrong-read', method: 'GET' as const, url: `/v1/releases/${requestedReleaseId}`, payload: undefined },
      { key: 'same-tenant-wrong-evidence', method: 'GET' as const, url: `/v1/releases/${requestedReleaseId}/evidence`, payload: undefined },
      { key: 'same-tenant-wrong-approve', method: 'POST' as const, url: `/v1/releases/${requestedReleaseId}/approve`, payload: undefined },
      { key: 'same-tenant-wrong-deploy', method: 'POST' as const, url: `/v1/releases/${requestedReleaseId}/deploy`, payload: { deploymentType: 'redeploy' } },
      { key: 'same-tenant-wrong-rollback', method: 'POST' as const, url: `/v1/releases/${requestedReleaseId}/rollback`, payload: { reason: 'wrong selected release' } },
    ]) {
      const options = request.payload === undefined
        ? { method: request.method, url: request.url, headers: wired.as(wired.owner) }
        : { method: request.method, url: request.url, headers: mutationHeaders(wired, wired.owner, request.key), payload: request.payload };
      const response = await wired.built.app.inject(options);
      expect(response.statusCode).toBe(502);
      expect(ApiErrorSchema.parse(JSON.parse(response.body) as unknown).error.code).toBe('release_service_unavailable');
      expect(response.body).not.toContain(returnedReleaseId);
    }
    expect(wired.releases.approvals).toEqual([]);
    expect(wired.releases.deploys).toEqual([]);
    expect(wired.releases.rollbacks).toEqual([]);
    expect(wired.built.audit.events).toHaveLength(auditCount);
  });

  it('rejects evidence bound to another release without leaking its criteria or risks', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-evidence-source-01'), payload: candidateBody(wired) });
    expect(created.statusCode, created.body).toBe(201);
    const wrongReleaseId = newId('rel');
    const wrongCriterion = 'foreign-criterion-release-id';
    const wrongRisk = 'foreign-risk-release-id';
    wired.releases.evidenceResultOverride = {
      release_id: wrongReleaseId,
      criteria: [{ id: wrongCriterion, status: 'failed' }],
      known_risks: [{ id: wrongRisk, detail: 'Foreign release risk.' }],
    };
    const auditCount = wired.built.audit.events.length;
    const response = await wired.built.app.inject({ method: 'GET', url: `/v1/releases/${created.json<{ release: { id: string } }>().release.id}/evidence`, headers: wired.as(wired.owner) });
    expect(response.statusCode).toBe(502);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('release_service_unavailable');
    expect(response.body).not.toContain(wrongReleaseId);
    expect(response.body).not.toContain(wrongCriterion);
    expect(response.body).not.toContain(wrongRisk);
    expect(wired.built.audit.events).toHaveLength(auditCount);
  });

  it('rejects evidence bound to a different commit without leaking its criteria or risks', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-evidence-commit-source-01'), payload: candidateBody(wired) });
    expect(created.statusCode, created.body).toBe(201);
    const wrongCommit = 'b'.repeat(40);
    const wrongCriterion = 'foreign-criterion-commit';
    const wrongRisk = 'foreign-risk-commit';
    wired.releases.evidenceResultOverride = {
      commit_sha: wrongCommit,
      criteria: [{ id: wrongCriterion, status: 'failed' }],
      known_risks: [{ id: wrongRisk, detail: 'Foreign commit risk.' }],
    };
    const auditCount = wired.built.audit.events.length;
    const response = await wired.built.app.inject({ method: 'GET', url: `/v1/releases/${created.json<{ release: { id: string } }>().release.id}/evidence`, headers: wired.as(wired.owner) });
    expect(response.statusCode).toBe(502);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('release_service_unavailable');
    expect(response.body).not.toContain(wrongCommit);
    expect(response.body).not.toContain(wrongCriterion);
    expect(response.body).not.toContain(wrongRisk);
    expect(wired.built.audit.events).toHaveLength(auditCount);
  });

  it('tenant-validates release environment and specification children before port or audit', async () => {
    const wired = await wire();
    const other = await createProject(wired, 'Other Release Target');
    const foreign = await createForeignProject(wired);
    const otherSpecificationId = newId('spec');
    const foreignSpecificationId = newId('spec');
    wired.data.specifications.push({ id: otherSpecificationId, organizationId: wired.organizationId, projectId: other.projectId, version: 1, status: 'draft', contentJson: {}, createdBy: wired.owner.userId, approvedBy: null, approvedAt: null });
    wired.data.specifications.push({ id: foreignSpecificationId, organizationId: foreign.organizationId, projectId: foreign.projectId, version: 1, status: 'draft', contentJson: {}, createdBy: wired.owner.userId, approvedBy: null, approvedAt: null });
    for (const body of [
      { ...candidateBody(wired), environmentId: other.environmentId },
      { ...candidateBody(wired), environmentId: foreign.environmentId },
      { ...candidateBody(wired), specificationId: otherSpecificationId },
      { ...candidateBody(wired), specificationId: foreignSpecificationId },
    ]) {
      const response = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, `release-child-${body.environmentId}-${body.specificationId ?? 'none'}`), payload: body });
      expect(response.statusCode).toBe(404);
    }
    expect(wired.releases.creates).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'release.created')).toEqual([]);
  });

  it('rolls back release mutation intent when its audit callback fails', async () => {
    const wired = await wire();
    const failingAudit = wired.built.audit as unknown as { record: () => Promise<void> };
    failingAudit.record = () => Promise.reject(new Error('audit sink unavailable'));
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-audit-fail-01'), payload: candidateBody(wired) });
    expect(response.statusCode).toBe(502);
    expect(wired.releases.creates).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'release.created')).toEqual([]);
  });

  it('rejects a wrong-identity release create result before audit or commit', async () => {
    const wired = await wire();
    const wrong = {
      organizationId: newId('org'),
      projectId: newId('proj'),
      environmentId: newId('env'),
      specificationId: newId('spec'),
    };
    wired.releases.createResultOverride = wrong;
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-wrong-create-01'), payload: candidateBody(wired) });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(wrong.organizationId);
    expect(response.body).not.toContain(wrong.projectId);
    expect(response.body).not.toContain(wrong.environmentId);
    expect(response.body).not.toContain(wrong.specificationId);
    expect(wired.releases.creates).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'release.created')).toEqual([]);
  });

  it('rejects a wrong-identity release approval result before audit or commit', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-identity-source-01'), payload: candidateBody(wired) });
    expect(created.statusCode, created.body).toBe(201);
    const selectedReleaseId = created.json<{ release: { id: string } }>().release.id;
    expect(wired.releases.releases.has(selectedReleaseId)).toBe(true);
    expect(wired.releases.releases.get(selectedReleaseId)?.organizationId).toBe(wired.organizationId);
    const wrong = {
      id: newId('rel'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      environmentId: newId('env'),
      specificationId: newId('spec'),
    };
    wired.releases.approveResultOverride = wrong;
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${selectedReleaseId}/approve`, headers: mutationHeaders(wired, wired.owner, 'release-wrong-approve-01') });
    expect(response.statusCode, response.body).toBe(502);
    for (const id of Object.values(wrong)) expect(response.body).not.toContain(id);
    expect(wired.releases.approvals).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'release.approved')).toEqual([]);
  });

  it('rejects an unaudited wrong-identity release create result at the final-result guard', async () => {
    const wired = await wire();
    const wrong = {
      organizationId: newId('org'),
      projectId: newId('proj'),
      environmentId: newId('env'),
      specificationId: newId('spec'),
    };
    wired.releases.createResultOverride = wrong;
    wired.releases.skipCreateAudit = true;
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-unaudited-create-01'), payload: candidateBody(wired) });
    expect(response.statusCode).toBe(502);
    for (const id of Object.values(wrong)) expect(response.body).not.toContain(id);
    expect(wired.releases.creates).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'release.created')).toEqual([]);
  });

  it('rejects an unaudited wrong-identity release approval result at the final-result guard', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-unaudited-approval-source-01'), payload: candidateBody(wired) });
    expect(created.statusCode, created.body).toBe(201);
    const wrong = {
      id: newId('rel'),
      organizationId: newId('org'),
      projectId: newId('proj'),
      environmentId: newId('env'),
      specificationId: newId('spec'),
    };
    wired.releases.approveResultOverride = wrong;
    wired.releases.skipApproveAudit = true;
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${created.json<{ release: { id: string } }>().release.id}/approve`, headers: mutationHeaders(wired, wired.owner, 'release-unaudited-approve-01') });
    expect(response.statusCode).toBe(502);
    for (const id of Object.values(wrong)) expect(response.body).not.toContain(id);
    expect(wired.releases.approvals).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'release.approved')).toEqual([]);
  });

  it('replays a release mutation without a second port call and forwards tenant actor and stable operation key', async () => {
    const wired = await wire();
    const headers = mutationHeaders(wired, wired.owner, 'release-replay-01');
    const first = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers, payload: candidateBody(wired) });
    const replay = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers, payload: candidateBody(wired) });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(wired.releases.creates).toHaveLength(1);
    expect(wired.releases.creates[0]).toMatchObject({ organizationId: wired.organizationId, actorId: wired.owner.userId });
    expect(wired.releases.creates[0]?.operationKey).toMatch(/^op_[a-f0-9]{64}$/);
  });

  it('rejects a replace deployment without a data disposition and invalid rollback reasons', async () => {
    const wired = await wire();
    const created = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-create-for-replace'), payload: candidateBody(wired) });
    const releaseId = created.json<{ release: { id: string } }>().release.id;
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/deploy`, headers: mutationHeaders(wired, wired.owner, 'release-replace-01'), payload: { deploymentType: 'replace_deployment' } });
    expect(response.statusCode).toBe(422);
    const invalidDisposition = await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/deploy`, headers: mutationHeaders(wired, wired.owner, 'release-replace-invalid'), payload: { deploymentType: 'replace_deployment', dataDisposition: 'erase-everything' } });
    expect(invalidDisposition.statusCode).toBe(400);
    expect(wired.releases.deploys).toEqual([]);
    const rollback = await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${releaseId}/rollback`, headers: mutationHeaders(wired, wired.owner, 'release-rollback-empty'), payload: { reason: ' ' } });
    expect(rollback.statusCode).toBe(400);
  });

  it('does not report a failed or malformed port result as a success', async () => {
    const wired = await wire();
    wired.releases.fail = true;
    const failed = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-failure-01'), payload: candidateBody(wired) });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('provider token is never public');
    wired.releases.fail = false;
    wired.releases.invalid = true;
    const invalid = await wired.built.app.inject({ method: 'POST', url: `/v1/projects/${wired.projectId}/releases`, headers: mutationHeaders(wired, wired.owner, 'release-invalid-01'), payload: candidateBody(wired) });
    expect(invalid.statusCode).toBe(502);
  });
});

async function createProject(wired: Wired, name: string): Promise<{ projectId: string; environmentId: string }> {
  const response = await wired.built.app.inject({ method: 'POST', url: '/v1/projects', headers: wired.as(wired.owner), payload: { name } });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ project: { id: string }; environments: { id: string; type: string }[] }>();
  return { projectId: body.project.id, environmentId: body.environments.find((entry) => entry.type === 'production')?.id ?? '' };
}

async function createForeignProject(wired: Wired): Promise<{ organizationId: string; projectId: string; environmentId: string }> {
  const organization = await wired.built.app.inject({ method: 'POST', url: '/v1/organizations', headers: wired.owner.headers, payload: { name: 'Foreign Release Factory' } });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const project = await wired.built.app.inject({ method: 'POST', url: '/v1/projects', headers: { ...wired.owner.headers, [ORGANIZATION_HEADER]: organizationId }, payload: { name: 'Foreign Release Target' } });
  expect(project.statusCode, project.body).toBe(201);
  const body = project.json<{ project: { id: string }; environments: { id: string; type: string }[] }>();
  return { organizationId, projectId: body.project.id, environmentId: body.environments.find((entry) => entry.type === 'production')?.id ?? '' };
}
