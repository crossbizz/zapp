import { ApiErrorSchema, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
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

interface ReleaseCall {
  readonly operationKey?: string;
  readonly organizationId?: string;
  readonly actorId?: string;
}

class RecordingReleasePort {
  readonly creates: ReleaseCall[] = [];
  readonly approvals: ReleaseCall[] = [];
  readonly deploys: ReleaseCall[] = [];
  readonly rollbacks: ReleaseCall[] = [];
  fail = false;
  invalid = false;
  readonly releaseId = newId('rel');

  private release() {
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

  createReleaseCandidate(input: ReleaseCall) {
    this.creates.push(input);
    return this.fail
      ? Promise.reject(new Error('provider token is never public'))
      : Promise.resolve(this.invalid ? { privateProviderThing: true } : this.release());
  }
  getRelease(input: ReleaseCall & { readonly releaseId: string }) {
    return Promise.resolve(input.releaseId === this.releaseId ? this.release() : undefined);
  }
  getReadiness() {
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
  approve(input: ReleaseCall) {
    this.approvals.push(input);
    return Promise.resolve(this.release());
  }
  deploy(input: ReleaseCall) {
    this.deploys.push(input);
    return this.fail
      ? Promise.reject(new Error('provider token is never public'))
      : Promise.resolve({ deploymentId: newId('dep') });
  }
  rollback(input: ReleaseCall) {
    this.rollbacks.push(input);
    return Promise.resolve({ deploymentId: newId('dep') });
  }
  getEvidence() {
    return Promise.resolve({
      release_id: this.releaseId,
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
    });
  }
}

interface Wired {
  readonly built: Harness;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly releases: RecordingReleasePort;
  as: (session: TestSession) => Record<string, string>;
}

async function wire(builderCanDeploy = false): Promise<Wired> {
  const data = new InMemoryTenantData();
  const releases = new RecordingReleasePort();
  const built = buildHarness({
    tenantDb: data.factory,
    releasePort: releases,
    permissionContextFor: () => Promise.resolve({ builderCanDeploy }),
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
  return { built, owner, organizationId, projectId: body.project.id, environmentId: body.environments.find((entry) => entry.type === 'production')?.id ?? '', releases, as };
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
    const wired = await wire(true);
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
  });

  it('allows Builder create/read but denies deployment unless injected settings allow it', async () => {
    const denied = await wire(false);
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

    const allowed = await wire(true);
    const allowedBuilder = await join(allowed, { ...BUILDER, email: 'allowed-builder@release.test' }, 'builder');
    const allowedCreated = await allowed.built.app.inject({ method: 'POST', url: `/v1/projects/${allowed.projectId}/releases`, headers: mutationHeaders(allowed, allowedBuilder, 'builder-create-02'), payload: candidateBody(allowed) });
    const allowedReleaseId = allowedCreated.json<{ release: { id: string } }>().release.id;
    expect((await allowed.built.app.inject({ method: 'POST', url: `/v1/releases/${allowedReleaseId}/deploy`, headers: mutationHeaders(allowed, allowedBuilder, 'builder-deploy-allowed'), payload: { deploymentType: 'redeploy' } })).statusCode).toBe(200);
    expect(allowed.releases.deploys).toHaveLength(1);
  });

  it('returns a tenant-hidden 404 before Viewer RBAC for a foreign release', async () => {
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');
    const response = await wired.built.app.inject({ method: 'POST', url: `/v1/releases/${newId('rel')}/deploy`, headers: mutationHeaders(wired, viewer, 'foreign-release-01'), payload: { deploymentType: 'redeploy' } });
    expect(response.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(response.json()).error.code).toBe('release_not_found');
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
