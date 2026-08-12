import { ApiErrorSchema, IdempotencyHeader } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { CSRF_HEADER } from '../src/auth/cookies.js';
import { IDEMPOTENT_REPLAY_HEADER } from '../src/plugins/idempotency.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { NO_TRANSACTION } from '../src/plugins/audit.js';
import {
  buildProjectExportTar,
  createGitServiceProjectExportPort,
  ProjectExportDataSchema,
} from '../src/routes/export.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'export-owner',
  email: 'export-owner@zapp.test',
  displayName: 'Export Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'export-builder',
  email: 'export-builder@zapp.test',
  displayName: 'Export Builder',
};
const VIEWER: AuthIdentity = {
  externalId: 'export-viewer',
  email: 'export-viewer@zapp.test',
  displayName: 'Export Viewer',
};

function tarEntries(tar: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText, 8);
    const start = offset + 512;
    entries.set(name, tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('CP-18 portable project exports', () => {
  it('rejects a chunked Git response as soon as it crosses the configured byte bound', async () => {
    const port = createGitServiceProjectExportPort({
      baseUrl: 'https://git.zapp.test',
      serviceTokens: { secret: 'g'.repeat(64) },
      maxBundleBytes: 5,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from('four'));
                controller.enqueue(Buffer.from('more'));
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
    });

    await expect(
      port.bundle({
        organizationId: `org_${'1'.repeat(26)}`,
        projectId: `proj_${'2'.repeat(26)}`,
        operationKey: 'bounded-export',
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('creates one Owner-only portable bundle and returns a short-lived signed URL', async () => {
    const data = new InMemoryTenantData();
    const puts: { readonly key: string; readonly body: Buffer; readonly contentType: string }[] = [];
    let gitCalls = 0;
    let signCalls = 0;
    let receipt:
      | { readonly storageRef: string; readonly contentHash: string; readonly byteSize: number }
      | undefined;
    const built = buildHarness({
      tenantDb: data.factory,
      projectExport: {
        source: {
          get: () => Promise.resolve(receipt),
          collect: () =>
            Promise.resolve({
              specification: { version: 3, status: 'approved', content: { title: 'Checkout' } },
              plan: { runs: [{ id: 'run_public', phases: [], tasks: [] }] },
              evidence: [{ id: 'vr_public', status: 'passed' }],
              releases: [{ id: 'rel_public', commitSha: 'a'.repeat(40) }],
              environmentVariableNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
              auditLog: [{ action: 'project.created', targetId: 'proj_public' }],
            }),
          async record(input) {
            receipt = {
              storageRef: input.storageRef,
              contentHash: input.contentHash,
              byteSize: input.byteSize,
            };
            await input.audit(NO_TRANSACTION, { exportId: input.exportId });
            return 'created' as const;
          },
        },
        git: {
          bundle: () => {
            gitCalls += 1;
            return Promise.resolve(Buffer.from('verified git bundle'));
          },
        },
        storage: {
          put: (input: { readonly key: string; readonly body: Buffer; readonly contentType: string }) => {
            puts.push(input);
            return Promise.resolve();
          },
          delete: () => Promise.resolve(),
          signGet: ({ key }: { readonly key: string }) => {
            signCalls += 1;
            return Promise.resolve(
              `https://objects.zapp.test/${encodeURIComponent(key)}?signed=${String(signCalls)}`,
            );
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
      payload: { name: 'Portable Inc' },
    });
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { name: 'Checkout' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const projectId = created.json<{ project: { id: string } }>().project.id;

    const request = {
      method: 'POST' as const,
      url: `/v1/projects/${projectId}/export`,
      headers: { ...headers, [IdempotencyHeader]: 'export-checkout-v1' },
    };
    const response = await built.app.inject(request);
    const replay = await built.app.inject(request);

    expect(response.statusCode, response.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    const responseBody = response.json<{
      export: { projectId: string; contentType: string; url: string };
    }>();
    const replayBody = replay.json<{ export: { url: string } }>();
    expect(responseBody.export).toMatchObject({
      projectId,
      contentType: 'application/x-tar',
    });
    expect(responseBody.export.url).toMatch(/^https:\/\/objects\.zapp\.test\//u);
    expect(replayBody.export.url).not.toBe(responseBody.export.url);
    expect(signCalls).toBe(2);
    expect(gitCalls).toBe(1);
    expect(puts).toHaveLength(1);
    const entries = tarEntries(puts[0]?.body ?? Buffer.alloc(0));
    expect([...entries.keys()]).toEqual([
      'repository.bundle',
      'specification.json',
      'plan.json',
      'evidence-manifests.json',
      'release-manifests.json',
      'environment-variable-names.json',
      'audit-log.json',
      'export-manifest.json',
    ]);
    expect(entries.get('repository.bundle')).toEqual(Buffer.from('verified git bundle'));
    expect(JSON.parse(entries.get('environment-variable-names.json')?.toString('utf8') ?? 'null'))
      .toEqual(['DATABASE_URL', 'STRIPE_SECRET_KEY']);
    const exportAudit = built.audit.events.find((event) => event.action === 'project.exported');
    expect(exportAudit).toMatchObject({
      action: 'project.exported',
      targetType: 'artifact',
    });
    expect(exportAudit?.metadata).toMatchObject({ projectId });

    const invite = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invites`,
      headers: owner.headers,
      payload: { email: BUILDER.email, role: 'builder' },
    });
    const builder = await signIn(built, BUILDER);
    await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${invite.json<{ token: string }>().token}/accept`,
      headers: builder.headers,
    });
    const denied = await built.app.inject({
      ...request,
      headers: {
        ...builder.headers,
        [ORGANIZATION_HEADER]: organizationId,
        [IdempotencyHeader]: 'export-builder-denied',
      },
    });
    expect(denied.statusCode).toBe(403);
    const viewerInvite = await built.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invites`,
      headers: owner.headers,
      payload: { email: VIEWER.email, role: 'viewer' },
    });
    const viewer = await signIn(built, VIEWER);
    await built.app.inject({
      method: 'POST',
      url: `/v1/invites/${viewerInvite.json<{ token: string }>().token}/accept`,
      headers: viewer.headers,
    });
    const viewerDenied = await built.app.inject({
      ...request,
      headers: {
        ...viewer.headers,
        [ORGANIZATION_HEADER]: organizationId,
        [IdempotencyHeader]: 'export-viewer-denied',
      },
    });
    expect(viewerDenied.statusCode).toBe(403);
    expect(gitCalls).toBe(1);
  });

  it('requires an idempotency key and never treats a cross-tenant project as visible', async () => {
    const data = new InMemoryTenantData();
    const built = buildHarness({
      tenantDb: data.factory,
      projectExport: {
        source: {
          get: () => Promise.resolve(undefined),
          collect: () => Promise.resolve(undefined),
          record: () => Promise.reject(new Error('must not run')),
        },
        git: { bundle: () => Promise.reject(new Error('must not run')) },
        storage: {
          put: () => Promise.reject(new Error('must not run')),
          delete: () => Promise.resolve(),
          signGet: () => Promise.reject(new Error('must not run')),
        },
      },
    });
    harnesses.push(built);
    const owner = await signIn(built, { ...OWNER, externalId: 'export-owner-two' });
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Empty Exports' },
    });
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const projectId = `proj_${'0'.repeat(26)}`;
    const headers = { ...owner.headers, [ORGANIZATION_HEADER]: organizationId };

    const withoutCsrf = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== CSRF_HEADER),
    );
    const missingCsrf = await built.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/export`,
      headers: { ...withoutCsrf, [IdempotencyHeader]: 'export-without-csrf' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(ApiErrorSchema.parse(missingCsrf.json()).error.code).toBe('csrf_required');

    const missingKey = await built.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/export`,
      headers,
    });
    expect(missingKey.statusCode).toBe(400);

    const hidden = await built.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/export`,
      headers: { ...headers, [IdempotencyHeader]: 'hidden-export-v1' },
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(ApiErrorSchema.parse(hidden.json()).error.code).toBe('project_not_found');
  });

  it('removes an uploaded object when project deletion wins the final database fence', async () => {
    let deleteCalls = 0;
    const built = buildHarness({
      tenantDb: new InMemoryTenantData().factory,
      projectExport: {
        source: {
          get: () => Promise.resolve(undefined),
          collect: () =>
            Promise.resolve({
              specification: null,
              plan: {},
              evidence: [],
              releases: [],
              environmentVariableNames: [],
              auditLog: [],
            }),
          record: () => Promise.resolve('deleting' as const),
        },
        git: { bundle: () => Promise.resolve(Buffer.from('bundle')) },
        storage: {
          put: () => Promise.resolve(),
          signGet: () => Promise.reject(new Error('must not sign')),
          delete: () => {
            deleteCalls += 1;
            return Promise.resolve();
          },
        },
      },
    });
    harnesses.push(built);
    const owner = await signIn(built, { ...OWNER, externalId: 'export-delete-race' });
    const organization = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: owner.headers,
      payload: { name: 'Deleting Export' },
    });
    const organizationId = organization.json<{ organization: { id: string } }>().organization.id;
    const response = await built.app.inject({
      method: 'POST',
      url: `/v1/projects/proj_${'4'.repeat(26)}/export`,
      headers: {
        ...owner.headers,
        [ORGANIZATION_HEADER]: organizationId,
        [IdempotencyHeader]: 'export-delete-race',
      },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(deleteCalls).toBe(1);
  });

  it('has no schema field through which a caller can provide secret values or ciphertext', () => {
    const safe = {
      specification: null,
      plan: {},
      evidence: [],
      releases: [],
      environmentVariableNames: ['API_TOKEN'],
      auditLog: [],
    };
    expect(ProjectExportDataSchema.safeParse(safe).success).toBe(true);
    expect(ProjectExportDataSchema.safeParse({ ...safe, plan: undefined }).success).toBe(false);
    expect(
      ProjectExportDataSchema.safeParse({
        ...safe,
        secretValues: { API_TOKEN: 'plaintext-sentinel' },
      }).success,
    ).toBe(false);
    expect(
      buildProjectExportTar({
        projectId: `proj_${'2'.repeat(26)}`,
        exportId: `art_${'3'.repeat(26)}`,
        gitBundle: Buffer.from('git'),
        data: safe,
      }).includes(Buffer.from('plaintext-sentinel')),
    ).toBe(false);
  });
});
