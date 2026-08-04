import { ApiErrorSchema } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import type { IdempotencyStore } from '../src/plugins/idempotency.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import type { SpecificationContent, SpecificationResponse } from '../src/tenant/view.js';
import { buildHarness, signIn, type Harness, type TestSession } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'spec-owner',
  email: 'owner@specs.test',
  displayName: 'Olivia Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'spec-builder',
  email: 'builder@specs.test',
  displayName: 'Bea Builder',
};
const VIEWER: AuthIdentity = {
  externalId: 'spec-viewer',
  email: 'viewer@specs.test',
  displayName: 'Vera Viewer',
};

const CONTENT = {
  problem: 'Teams cannot find approved delivery requirements.',
  targetUsers: ['Product managers', 'Engineers'],
  goals: ['Make the approved scope durable'],
  nonGoals: ['Generate implementation code'],
  journeys: ['A manager drafts and approves a specification'],
  pagesRoutes: ['GET /v1/projects/:projectId/specifications/:version'],
  rolesPermissions: ['Builder may edit specifications'],
  dataModel: ['Specification version'],
  integrations: ['None'],
  functionalRequirements: ['Persist immutable approved versions'],
  nonfunctionalRequirements: ['Tenant-scoped reads'],
  acceptanceCriteria: [
    { id: 'AC-1', text: 'An approved version cannot be changed.', priority: 'high', criticalFlow: true },
  ],
  assumptions: ['A project already exists.'],
  risks: ['A dropped response could cause a replay.'],
  definitionOfDone: ['Specification is readable by project version.'],
} as const satisfies SpecificationContent;

function errorOf(response: { json: () => unknown }): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  readonly as: (session: TestSession, organizationId?: string) => Record<string, string>;
}

async function wire(options: { idempotency?: IdempotencyStore } = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const built = buildHarness({
    tenantDb: data.factory,
    ...(options.idempotency === undefined ? {} : { idempotency: options.idempotency }),
  });
  harnesses.push(built);
  const owner = await signIn(built, OWNER);
  const organization = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Specification Factory' },
  });
  expect(organization.statusCode, organization.body).toBe(201);
  const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
  const as = (session: TestSession, organization = organizationId): Record<string, string> => ({
    ...session.headers,
    [ORGANIZATION_HEADER]: organization,
  });
  const project = await built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: as(owner),
    payload: { name: 'Specification Target' },
  });
  expect(project.statusCode, project.body).toBe(201);
  return {
    built,
    data,
    owner,
    organizationId,
    projectId: project.json<{ project: { id: string } }>().project.id,
    as,
  };
}

async function join(
  wired: Wired,
  identity: AuthIdentity,
  role: 'builder' | 'viewer',
): Promise<TestSession> {
  const invitation = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: identity.email, role },
  });
  expect(invitation.statusCode, invitation.body).toBe(201);
  const session = await signIn(wired.built, identity);
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${invitation.json<{ token: string }>().token}/accept`,
    headers: session.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return session;
}

async function createSpecification(
  wired: Wired,
  key: string,
  session = wired.owner,
  projectId = wired.projectId,
  content: SpecificationContent = CONTENT,
  organizationId = wired.organizationId,
) {
  return await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/specifications`,
    headers: { ...wired.as(session, organizationId), 'idempotency-key': key },
    payload: content,
  });
}

describe('specification routes', () => {
  it('allocates tenant-project versions monotonically and replays the same stable create', async () => {
    const wired = await wire();
    const first = await createSpecification(wired, 'spec-create-0001');
    expect(first.statusCode, first.body).toBe(201);
    const firstSpecification = first.json<SpecificationResponse>().specification;
    expect(firstSpecification).toMatchObject({
      projectId: wired.projectId,
      organizationId: wired.organizationId,
      version: 1,
      status: 'draft',
      approvedBy: null,
      approvedAt: null,
      content: CONTENT,
    });

    const replay = await createSpecification(wired, 'spec-create-0001');
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['x-idempotent-replay']).toBe('true');
    expect(replay.json<SpecificationResponse>().specification.id).toBe(firstSpecification.id);

    const second = await createSpecification(wired, 'spec-create-0002');
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<SpecificationResponse>().specification.version).toBe(2);

    const missing = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/specifications/99`,
      headers: wired.as(wired.owner),
    });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(errorOf(missing)).toBe('specification_not_found');

    const anotherProject = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: wired.as(wired.owner),
      payload: { name: 'Independent Versions' },
    });
    expect(anotherProject.statusCode, anotherProject.body).toBe(201);
    const independent = await createSpecification(
      wired,
      'spec-create-0003',
      wired.owner,
      anotherProject.json<{ project: { id: string } }>().project.id,
    );
    expect(independent.statusCode, independent.body).toBe(201);
    expect(independent.json<SpecificationResponse>().specification.version).toBe(1);
  });

  it('recovers one stable specification when post-commit idempotency persistence is unavailable', async () => {
    const unavailableAfterCommit: IdempotencyStore = {
      reserve: () => Promise.resolve(undefined),
      complete: () => Promise.reject(new Error('redis unavailable after commit')),
      release: () => Promise.resolve(),
    };
    const wired = await wire({ idempotency: unavailableAfterCommit });

    const first = await createSpecification(wired, 'spec-ambiguous-replay-01');
    expect(first.statusCode, first.body).toBe(201);
    const second = await createSpecification(wired, 'spec-ambiguous-replay-01');
    expect(second.statusCode, second.body).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    expect(second.json<SpecificationResponse>().specification.id).toBe(
      first.json<SpecificationResponse>().specification.id,
    );
    expect(
      wired.built.audit.events.filter((event) => event.action === 'specification.created'),
    ).toHaveLength(1);
  });

  it('requires an Idempotency-Key for draft edits and approval before mutating state', async () => {
    const wired = await wire();
    const created = await createSpecification(wired, 'spec-required-create-01');
    expect(created.statusCode, created.body).toBe(201);
    const version = created.json<SpecificationResponse>().specification.version;

    const unkeyedPatch = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: wired.as(wired.owner),
      payload: { ...CONTENT, goals: ['This must not be written.'] },
    });
    expect(unkeyedPatch.statusCode, unkeyedPatch.body).toBe(400);
    expect(errorOf(unkeyedPatch)).toBe('idempotency_key_required');

    const unkeyedApproval = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}/approve`,
      headers: wired.as(wired.owner),
    });
    expect(unkeyedApproval.statusCode, unkeyedApproval.body).toBe(400);
    expect(errorOf(unkeyedApproval)).toBe('idempotency_key_required');
    expect(wired.data.specifications[0]).toMatchObject({ status: 'draft', contentJson: CONTENT });
    expect(
      wired.built.audit.events.filter(
        (event) => event.action === 'specification.updated' || event.action === 'specification.approved',
      ),
    ).toEqual([]);
  });

  it('does not append a second draft-edit audit event when Redis loses a completed PATCH response', async () => {
    const unavailableAfterCommit: IdempotencyStore = {
      reserve: () => Promise.resolve(undefined),
      complete: () => Promise.reject(new Error('redis unavailable after commit')),
      release: () => Promise.resolve(),
    };
    const wired = await wire({ idempotency: unavailableAfterCommit });
    const created = await createSpecification(wired, 'spec-patch-retry-create-01');
    expect(created.statusCode, created.body).toBe(201);
    const version = created.json<SpecificationResponse>().specification.version;
    const content = { ...CONTENT, goals: ['Persist one edit despite a lost response.'] };

    const first = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-patch-retry-01' },
      payload: content,
    });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-patch-retry-01' },
      payload: content,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<SpecificationResponse>().specification.content).toEqual(content);
    expect(
      wired.built.audit.events.filter((event) => event.action === 'specification.updated'),
    ).toHaveLength(1);
  });

  it('does not roll back a newer draft edit when an older lost PATCH response retries', async () => {
    const unavailableAfterCommit: IdempotencyStore = {
      reserve: () => Promise.resolve(undefined),
      complete: () => Promise.reject(new Error('redis unavailable after commit')),
      release: () => Promise.resolve(),
    };
    const wired = await wire({ idempotency: unavailableAfterCommit });
    const created = await createSpecification(wired, 'spec-stale-retry-create-01');
    expect(created.statusCode, created.body).toBe(201);
    const version = created.json<SpecificationResponse>().specification.version;
    const contentA = { ...CONTENT, goals: ['Draft edit A must not be replayed over B.'] };
    const contentB = { ...CONTENT, goals: ['Draft edit B is the current content.'] };

    const first = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-stale-retry-a-01' },
      payload: contentA,
    });
    expect(first.statusCode, first.body).toBe(200);
    const intervening = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-stale-retry-b-01' },
      payload: contentB,
    });
    expect(intervening.statusCode, intervening.body).toBe(200);

    const replay = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-stale-retry-a-01' },
      payload: contentA,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<SpecificationResponse>().specification.content).toEqual(contentB);
    expect(
      wired.built.audit.events.filter((event) => event.action === 'specification.updated'),
    ).toHaveLength(2);
  });

  it('records distinct same-content PATCH operations while recognizing a stale retry', async () => {
    const unavailableAfterCommit: IdempotencyStore = {
      reserve: () => Promise.resolve(undefined),
      complete: () => Promise.reject(new Error('redis unavailable after commit')),
      release: () => Promise.resolve(),
    };
    const wired = await wire({ idempotency: unavailableAfterCommit });
    const created = await createSpecification(wired, 'spec-same-content-create-01');
    expect(created.statusCode, created.body).toBe(201);
    const version = created.json<SpecificationResponse>().specification.version;
    const content = { ...CONTENT, goals: ['This content belongs to two distinct operations.'] };

    for (const key of ['spec-same-content-a-01', 'spec-same-content-b-01']) {
      const response = await wired.built.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': key },
        payload: content,
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(
      wired.built.audit.events.filter((event) => event.action === 'specification.updated'),
    ).toHaveLength(2);

    const replay = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-same-content-a-01' },
      payload: content,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<SpecificationResponse>().specification.content).toEqual(content);
    expect(
      wired.built.audit.events.filter((event) => event.action === 'specification.updated'),
    ).toHaveLength(2);
  });

  it('serializes distinct concurrent creates into adjacent project-local versions', async () => {
    const wired = await wire();
    wired.data.yieldSpecificationCreates = true;
    const [left, right] = await Promise.all([
      createSpecification(wired, 'spec-concurrent-left-01'),
      createSpecification(wired, 'spec-concurrent-right-01'),
    ]);
    expect(left.statusCode, left.body).toBe(201);
    expect(right.statusCode, right.body).toBe(201);
    expect(
      [
        left.json<SpecificationResponse>().specification.version,
        right.json<SpecificationResponse>().specification.version,
      ].sort(),
    ).toEqual([1, 2]);
  });

  it('serializes a concurrent draft edit and approval into one legal final specification', async () => {
    const wired = await wire();
    const created = await createSpecification(wired, 'spec-lock-create-01');
    expect(created.statusCode, created.body).toBe(201);
    const version = created.json<SpecificationResponse>().specification.version;
    const patchedContent = { ...CONTENT, goals: ['The row lock preserves this edit.'] };

    const [patched, approved] = await Promise.all([
      wired.built.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-lock-patch-01' },
        payload: patchedContent,
      }),
      wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${wired.projectId}/specifications/${String(version)}/approve`,
        headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-lock-approve-01' },
      }),
    ]);
    const final = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/specifications/${String(version)}`,
      headers: wired.as(wired.owner),
    });
    expect(final.statusCode, final.body).toBe(200);
    const specification = final.json<SpecificationResponse>().specification;
    expect(specification.status).toBe('approved');

    if (patched.statusCode === 200) {
      expect(approved.statusCode, approved.body).toBe(200);
      expect(specification.content).toEqual(patchedContent);
    } else {
      expect(patched.statusCode, patched.body).toBe(409);
      expect(errorOf(patched)).toBe('specification_immutable');
      expect(approved.statusCode, approved.body).toBe(200);
      expect(specification.content).toEqual(CONTENT);
    }
  });

  it('edits drafts, approves exactly once, and preserves an approved version when a later draft is created', async () => {
    const wired = await wire();
    const created = await createSpecification(wired, 'spec-life-create-01');
    expect(created.statusCode, created.body).toBe(201);
    const specification = created.json<SpecificationResponse>().specification;
    const editedContent = { ...CONTENT, goals: ['Make draft edits durable'] };
    const edited = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(specification.version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-life-patch-01' },
      payload: editedContent,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<SpecificationResponse>().specification.content.goals).toEqual([
      'Make draft edits durable',
    ]);

    const approved = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/specifications/${String(specification.version)}/approve`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-life-approve-01' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const approvedSpecification = approved.json<SpecificationResponse>().specification;
    expect(approvedSpecification).toMatchObject({
      status: 'approved',
      approvedBy: wired.owner.userId,
      content: editedContent,
    });
    expect(approvedSpecification.approvedAt).not.toBeNull();

    const approvedAgain = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/specifications/${String(specification.version)}/approve`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-life-approve-02' },
    });
    expect(approvedAgain.statusCode, approvedAgain.body).toBe(200);
    expect(approvedAgain.json<SpecificationResponse>().specification.approvedAt).toBe(
      approvedSpecification.approvedAt,
    );

    const immutable = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(specification.version)}`,
      headers: { ...wired.as(wired.owner), 'idempotency-key': 'spec-life-patch-02' },
      payload: CONTENT,
    });
    expect(immutable.statusCode, immutable.body).toBe(409);
    expect(errorOf(immutable)).toBe('specification_immutable');

    const successor = await createSpecification(wired, 'spec-life-create-02');
    expect(successor.statusCode, successor.body).toBe(201);
    expect(successor.json<SpecificationResponse>().specification).toMatchObject({
      version: 2,
      status: 'draft',
      approvedAt: null,
    });
    const readApproved = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/specifications/1`,
      headers: wired.as(wired.owner),
    });
    expect(readApproved.statusCode, readApproved.body).toBe(200);
    expect(readApproved.json<SpecificationResponse>().specification).toMatchObject(
      approvedSpecification,
    );
    expect(
      wired.built.audit.events.filter((event) => event.action === 'specification.approved'),
    ).toHaveLength(1);
    expect(
      wired.built.audit.events
        .filter((event) => event.targetId === specification.id)
        .map((event) => event.action),
    ).toEqual(['specification.created', 'specification.updated', 'specification.approved']);
  });

  it('applies edit_code to mutations, view_project to reads, and resolves foreign resources before authorization', async () => {
    const wired = await wire();
    const builder = await join(wired, BUILDER, 'builder');
    const viewer = await join(wired, VIEWER, 'viewer');
    const created = await createSpecification(wired, 'spec-rbac-owner-01');
    expect(created.statusCode, created.body).toBe(201);
    const builderCreated = await createSpecification(wired, 'spec-rbac-builder-01', builder);
    expect(builderCreated.statusCode, builderCreated.body).toBe(201);
    const builderVersion = builderCreated.json<SpecificationResponse>().specification.version;
    const builderPatched = await wired.built.app.inject({
      method: 'PATCH',
      url: `/v1/projects/${wired.projectId}/specifications/${String(builderVersion)}`,
      headers: { ...wired.as(builder), 'idempotency-key': 'spec-rbac-patch-01' },
      payload: { ...CONTENT, assumptions: ['A Builder may edit a draft.'] },
    });
    expect(builderPatched.statusCode, builderPatched.body).toBe(200);
    const builderApproved = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/specifications/${String(builderVersion)}/approve`,
      headers: { ...wired.as(builder), 'idempotency-key': 'spec-rbac-approve-01' },
    });
    expect(builderApproved.statusCode, builderApproved.body).toBe(200);

    const readable = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/specifications/1`,
      headers: wired.as(viewer),
    });
    expect(readable.statusCode, readable.body).toBe(200);

    const viewerCreate = await createSpecification(wired, 'spec-rbac-viewer-01', viewer);
    expect(viewerCreate.statusCode, viewerCreate.body).toBe(403);
    expect(errorOf(viewerCreate)).toBe('permission_denied');
    for (const [method, suffix, payload] of [
      ['PATCH', '', CONTENT],
      ['POST', '/approve', undefined],
    ] as const) {
      const denied = await wired.built.app.inject({
        method,
        url: `/v1/projects/${wired.projectId}/specifications/1${suffix}`,
        headers: { ...wired.as(viewer), 'idempotency-key': `spec-rbac-viewer-${method}` },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(errorOf(denied)).toBe('permission_denied');
    }

    const foreignOrganization = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: wired.owner.headers,
      payload: { name: 'Foreign Specification Factory' },
    });
    expect(foreignOrganization.statusCode, foreignOrganization.body).toBe(201);
    const foreignOrganizationId = foreignOrganization.json<{ organization: { id: string } }>().organization.id;
    const foreignProject = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: wired.as(wired.owner, foreignOrganizationId),
      payload: { name: 'Foreign Specification Target' },
    });
    expect(foreignProject.statusCode, foreignProject.body).toBe(201);
    const foreignProjectId = foreignProject.json<{ project: { id: string } }>().project.id;
    const foreignSpecification = await createSpecification(
      wired,
      'spec-foreign-seed-01',
      wired.owner,
      foreignProjectId,
      CONTENT,
      foreignOrganizationId,
    );
    expect(foreignSpecification.statusCode, foreignSpecification.body).toBe(201);
    const foreignVersion = foreignSpecification.json<SpecificationResponse>().specification.version;
    const ownerLookup = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${foreignProjectId}/specifications/${String(foreignVersion)}`,
      headers: wired.as(wired.owner, foreignOrganizationId),
    });
    expect(ownerLookup.statusCode, ownerLookup.body).toBe(200);
    const stateBeforeForeign = [...wired.data.specifications];
    const auditBeforeForeign = [...wired.built.audit.events];
    for (const [method, suffix, payload] of [
      ['POST', '', CONTENT],
      ['PATCH', `/${String(foreignVersion)}`, CONTENT],
      ['POST', `/${String(foreignVersion)}/approve`, undefined],
      ['GET', `/${String(foreignVersion)}`, undefined],
    ] as const) {
      const foreign = await wired.built.app.inject({
        method,
        url: `/v1/projects/${foreignProjectId}/specifications${suffix}`,
        headers: { ...wired.as(viewer), 'idempotency-key': `spec-foreign-${method}-${String(suffix.length)}` },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(errorOf(foreign)).toBe('project_not_found');
    }
    expect(wired.data.specifications).toEqual(stateBeforeForeign);
    expect(wired.built.audit.events).toEqual(auditBeforeForeign);
  });

  it('rejects unkeyed or malformed specification content before durable state changes', async () => {
    const wired = await wire();
    const unkeyed = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/specifications`,
      headers: wired.as(wired.owner),
      payload: CONTENT,
    });
    expect(unkeyed.statusCode, unkeyed.body).toBe(400);
    expect(errorOf(unkeyed)).toBe('idempotency_key_required');

    const malformed = await createSpecification(wired, 'spec-invalid-content-01', wired.owner, wired.projectId, {
      ...CONTENT,
      acceptanceCriteria: [
        { id: 'criterion-one', text: 'This id cannot be traced.', priority: 'high', criticalFlow: true },
      ],
    });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect(errorOf(malformed)).toBe('validation_failed');
    const unrecognisedField = await createSpecification(wired, 'spec-invalid-content-02', wired.owner, wired.projectId, {
      ...CONTENT,
      unreviewedField: 'must not be silently stored',
    } as unknown as SpecificationContent);
    expect(unrecognisedField.statusCode, unrecognisedField.body).toBe(400);
    expect(errorOf(unrecognisedField)).toBe('validation_failed');
    expect(wired.built.audit.events.filter((event) => event.action === 'specification.created')).toEqual([]);
  });

  it('commits neither specification state nor its audit event when the in-transaction audit write fails', async () => {
    const wired = await wire();
    const failingAudit = wired.built.audit as unknown as {
      record: (tx: unknown, event: unknown) => Promise<void>;
    };
    failingAudit.record = () => Promise.reject(new Error('audit database unavailable'));

    const response = await createSpecification(wired, 'spec-audit-atomic-01');
    expect(response.statusCode, response.body).toBe(500);
    expect(wired.data.specifications).toEqual([]);
    expect(wired.built.audit.events.filter((event) => event.action === 'specification.created')).toEqual(
      [],
    );
  });
});
