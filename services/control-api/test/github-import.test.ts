import type { Project } from '@zapp/db';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { GitHubImportStatusSchema } from '../src/integrations/github/import.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const OWNER: AuthIdentity = {
  externalId: 'github-import-owner',
  email: 'owner@github-import.test',
  displayName: 'Inez Importer',
};
const BUILDER: AuthIdentity = {
  externalId: 'github-import-builder',
  email: 'builder@github-import.test',
  displayName: 'Basil Builder',
};
const VIEWER: AuthIdentity = {
  externalId: 'github-import-viewer',
  email: 'viewer@github-import.test',
  displayName: 'Vera Viewer',
};
const INSTALLATION_ID = '41122';
const SOURCE_REPOSITORY = 'zapp/example';
const SOURCE_BRANCH = 'release/candidate';
const OPERATION_KEY = 'github-import-operation-0001';
const harnesses: Harness[] = [];

interface ImportRows {
  readonly githubImports?: readonly {
    readonly projectId: string;
    readonly organizationId: string;
    readonly operationKey: string;
    readonly status: string;
  }[];
  readonly githubImportOutbox?: readonly {
    readonly projectId: string;
    readonly stage: string;
    readonly status: string;
  }[];
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

function as(session: TestSession, organizationId: string): Record<string, string> {
  return { ...session.headers, [ORGANIZATION_HEADER]: organizationId };
}

async function createOrganization(
  harness: Harness,
  owner: TestSession,
  name: string,
): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ organization: { id: string } }>().organization.id;
}

async function join(
  harness: Harness,
  owner: TestSession,
  organizationId: string,
  identity: AuthIdentity,
  role: 'builder' | 'viewer',
): Promise<TestSession> {
  const invite = await harness.app.inject({
    method: 'POST',
    url: `/v1/organizations/${organizationId}/invites`,
    headers: owner.headers,
    payload: { email: identity.email, role },
  });
  expect(invite.statusCode, invite.body).toBe(201);
  const session = await signIn(harness, identity);
  const accepted = await harness.app.inject({
    method: 'POST',
    url: `/v1/invites/${invite.json<{ token: string }>().token}/accept`,
    headers: session.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return session;
}

async function createProject(
  harness: Harness,
  session: TestSession,
  organizationId: string,
  sourceType: 'github_import' | 'blank' = 'github_import',
): Promise<Project> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      ...as(session, organizationId),
      'idempotency-key': `create-${sourceType}-${crypto.randomUUID()}`,
    },
    payload: { name: `Import ${crypto.randomUUID()}`, sourceType },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ project: Project }>().project;
}

function importRequest(
  harness: Harness,
  session: TestSession,
  organizationId: string,
  projectId: string,
  operationKey = OPERATION_KEY,
  installationId = INSTALLATION_ID,
) {
  return harness.app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/import/github`,
    headers: { ...as(session, organizationId), 'idempotency-key': operationKey },
    payload: {
      installationId,
      repo: SOURCE_REPOSITORY,
      branch: SOURCE_BRANCH,
    },
  });
}

async function wired(): Promise<{
  harness: Harness;
  data: InMemoryTenantData;
  owner: TestSession;
  organizationId: string;
}> {
  const data = new InMemoryTenantData();
  const harness = buildHarness({ tenantDb: data.factory });
  harnesses.push(harness);
  const owner = await signIn(harness, OWNER);
  const organizationId = await createOrganization(harness, owner, 'GitHub Import');
  data.addGitHubConnection(organizationId, INSTALLATION_ID);
  return { harness, data, owner, organizationId };
}

describe('POST /v1/projects/:projectId/import/github', () => {
  it('returns 202 only after the import and queued delivery are durable', async () => {
    const { harness, data, owner, organizationId } = await wired();
    const project = await createProject(harness, owner, organizationId);

    const response = await importRequest(harness, owner, organizationId, project.id);

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ import: { projectId: project.id, status: 'queued' } });
    const rows = data as InMemoryTenantData & ImportRows;
    expect(rows.githubImports).toEqual([
      expect.objectContaining({
        projectId: project.id,
        organizationId,
        operationKey: OPERATION_KEY,
        status: 'queued',
      }),
    ]);
    expect(rows.githubImportOutbox).toEqual([
      expect.objectContaining({ projectId: project.id, stage: 'queued', status: 'pending' }),
    ]);
  });

  it('replays the exact accepted response for the same key and rejects a distinct key', async () => {
    const { harness, owner, organizationId } = await wired();
    const project = await createProject(harness, owner, organizationId);

    const first = await importRequest(harness, owner, organizationId, project.id);
    const replay = await importRequest(harness, owner, organizationId, project.id);
    const conflict = await importRequest(
      harness,
      owner,
      organizationId,
      project.id,
      'github-import-operation-0002',
    );

    expect(first.statusCode, first.body).toBe(202);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.body).toBe(first.body);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'github_import_conflict' } });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'short'],
    ['invalid characters', 'invalid key'],
    ['too long', 'x'.repeat(256)],
  ] as const)('rejects a %s idempotency key at the public boundary', async (_label, operationKey) => {
    const { harness, data, owner, organizationId } = await wired();
    const project = await createProject(harness, owner, organizationId);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/import/github`,
      headers: {
        ...as(owner, organizationId),
        ...(operationKey === undefined ? {} : { 'idempotency-key': operationKey }),
      },
      payload: {
        installationId: INSTALLATION_ID,
        repo: SOURCE_REPOSITORY,
        branch: SOURCE_BRANCH,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect((data as InMemoryTenantData & ImportRows).githubImports).toHaveLength(0);
  });

  it.each(['zapp', 'zapp/example/extra', 'zapp /example'])(
    'rejects malformed repository full name %s at the public boundary',
    async (repo) => {
      const { harness, data, owner, organizationId } = await wired();
      const project = await createProject(harness, owner, organizationId);

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/import/github`,
        headers: {
          ...as(owner, organizationId),
          'idempotency-key': `invalid-repository-${crypto.randomUUID()}`,
        },
        payload: { installationId: INSTALLATION_ID, repo, branch: SOURCE_BRANCH },
      });

      expect(response.statusCode, response.body).toBe(400);
      expect((data as InMemoryTenantData & ImportRows).githubImports).toHaveLength(0);
    },
  );

  it('returns indistinguishable 404s for a foreign project and installation', async () => {
    const { harness, data, owner, organizationId } = await wired();
    const project = await createProject(harness, owner, organizationId);
    const foreignOrganizationId = await createOrganization(harness, owner, 'Foreign Imports');
    const foreignProject = await createProject(harness, owner, foreignOrganizationId);
    data.addGitHubConnection(foreignOrganizationId, 'foreign-installation');

    const foreignProjectResponse = await importRequest(
      harness,
      owner,
      organizationId,
      foreignProject.id,
      'foreign-project-operation',
    );
    const foreignInstallationResponse = await importRequest(
      harness,
      owner,
      organizationId,
      project.id,
      'foreign-installation-operation',
      'foreign-installation',
    );

    expect(foreignProjectResponse.statusCode).toBe(404);
    expect(foreignInstallationResponse.statusCode).toBe(404);
    expect(foreignProjectResponse.json()).toMatchObject({ error: { code: 'github_import_not_found' } });
    expect(foreignInstallationResponse.json()).toMatchObject({
      error: {
        code: foreignProjectResponse.json<{ error: { code: string } }>().error.code,
        message: foreignProjectResponse.json<{ error: { message: string } }>().error.message,
      },
    });
  });

  it('requires a github_import project and a strict credential-free body', async () => {
    const { harness, owner, organizationId } = await wired();
    const project = await createProject(harness, owner, organizationId, 'blank');

    const wrongSource = await importRequest(harness, owner, organizationId, project.id);
    expect(wrongSource.statusCode, wrongSource.body).toBe(409);
    expect(wrongSource.json()).toMatchObject({ error: { code: 'github_import_source_required' } });

    const credential = 'ghs_must-never-cross-the-public-boundary';
    const malformed = await harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/import/github`,
      headers: { ...as(owner, organizationId), 'idempotency-key': 'credential-attempt' },
      payload: {
        installationId: INSTALLATION_ID,
        repo: SOURCE_REPOSITORY,
        branch: SOURCE_BRANCH,
        sourceToken: credential,
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(credential);
    expect(malformed.body).not.toContain(SOURCE_REPOSITORY);
  });

  it('allows Owner and Builder but denies Viewer', async () => {
    const { harness, owner, organizationId } = await wired();
    const builder = await join(harness, owner, organizationId, BUILDER, 'builder');
    const viewer = await join(harness, owner, organizationId, VIEWER, 'viewer');
    const ownerProject = await createProject(harness, owner, organizationId);
    const builderProject = await createProject(harness, builder, organizationId);
    const viewerProject = await createProject(harness, owner, organizationId);

    const ownerResponse = await importRequest(
      harness,
      owner,
      organizationId,
      ownerProject.id,
      'owner-import-operation',
    );
    const builderResponse = await importRequest(
      harness,
      builder,
      organizationId,
      builderProject.id,
      'builder-import-operation',
    );
    const viewerResponse = await importRequest(
      harness,
      viewer,
      organizationId,
      viewerProject.id,
      'viewer-import-operation',
    );

    expect(ownerResponse.statusCode, ownerResponse.body).toBe(202);
    expect(builderResponse.statusCode, builderResponse.body).toBe(202);
    expect(viewerResponse.statusCode).toBe(403);
  });
});

describe('GET /v1/projects/:projectId/import/github', () => {
  it('returns strict durable progress and hides a missing or foreign import as 404', async () => {
    const { harness, owner, organizationId } = await wired();
    const project = await createProject(harness, owner, organizationId);
    const noImport = await createProject(harness, owner, organizationId);
    const accepted = await importRequest(harness, owner, organizationId, project.id);
    expect(accepted.statusCode, accepted.body).toBe(202);

    const progress = await harness.app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/import/github`,
      headers: as(owner, organizationId),
    });
    expect(progress.statusCode, progress.body).toBe(200);
    const progressBody = GitHubImportStatusSchema.parse(progress.json());
    expect(progressBody.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(progressBody).toEqual({
      projectId: project.id,
      status: 'queued',
      externalRepoRef: null,
      branch: SOURCE_BRANCH,
      headCommitSha: null,
      scanId: null,
      errorCode: null,
      updatedAt: progressBody.updatedAt,
    });
    expect(Object.keys(progressBody).sort()).toEqual(
      [
        'branch',
        'errorCode',
        'externalRepoRef',
        'headCommitSha',
        'projectId',
        'scanId',
        'status',
        'updatedAt',
      ].sort(),
    );

    const missing = await harness.app.inject({
      method: 'GET',
      url: `/v1/projects/${noImport.id}/import/github`,
      headers: as(owner, organizationId),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'github_import_not_found' } });
  });
});
