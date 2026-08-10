import { createServiceTokenSigner } from '@zapp/config';
import { newId } from '@zapp/contracts';
import {
  capabilityScanActivityIdempotencyKey,
  type CapabilityScanInput,
} from '@zapp/project-adapters';
import { describe, expect, it, vi } from 'vitest';

import {
  createProductionCapabilityScanActivities,
  type CapabilityScanObjectClient,
} from '../src/activities/capability-scan-production.js';

const NOW = new Date('2026-08-09T07:00:00.000Z');
const TOKEN_CONFIG = { secret: 's'.repeat(64) };

function scanInput(): CapabilityScanInput {
  const organizationId = newId('org');
  const projectId = newId('proj');
  const scanId = 'production-scan-0001';
  return {
    scanId,
    idempotencyKey: capabilityScanActivityIdempotencyKey({ organizationId, projectId, scanId }),
    organizationId,
    projectId,
    branchId: newId('br'),
    branchName: 'main',
    workspaceId: newId('ws'),
    runId: newId('run'),
    taskId: newId('task'),
    workspaceCreatedAt: NOW.toISOString(),
  };
}

describe('VF-3 production capability scan adapters', () => {
  it('creates a restricted scan workspace, reads it through the sandbox API, stores R2 evidence, and terminates', async () => {
    const input = scanInput();
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    let workspaceId: string | undefined;
    const fetchImpl = vi.fn((resource: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url);
      calls.push({ url, init });
      if (url.pathname === '/internal/workspaces' && init.method === 'POST') {
        if (typeof init.body !== 'string') {
          throw new Error('workspace create request body was not JSON text');
        }
        const body = JSON.parse(init.body) as {
          workspace: { id: string };
          purpose: string;
          networkProfile: string;
          branchName: string;
        };
        workspaceId = body.workspace.id;
        expect(body).toMatchObject({
          purpose: 'scan',
          networkProfile: 'restricted_verification',
          branchName: input.branchName,
        });
        return Promise.resolve(Response.json({ workspace: { id: workspaceId } }, { status: 201 }));
      }
      if (url.pathname.endsWith('/files/list')) {
        return Promise.resolve(
          Response.json([
            { path: 'package.json', type: 'file' },
            { path: 'pnpm-lock.yaml', type: 'file' },
          ]),
        );
      }
      if (url.pathname.endsWith('/files')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              name: 'production-scan-fixture',
              scripts: { build: 'build', typecheck: 'tsc --noEmit', test: 'vitest run' },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.pathname.endsWith('/terminate') && init.method === 'POST') {
        return Promise.resolve(Response.json({ workspace: { id: workspaceId } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const sent: unknown[] = [];
    const objects: CapabilityScanObjectClient = {
      send(command) {
        sent.push(command);
        return Promise.resolve({});
      },
    };
    const activities = createProductionCapabilityScanActivities({
      sandbox: {
        baseUrl: 'https://sandbox.internal',
        serviceTokens: TOKEN_CONFIG,
        fetch: fetchImpl,
        now: () => NOW,
      },
      artifacts: {
        client: objects,
        bucket: 'zapp-artifacts',
      },
    });

    const output = await activities.scanProjectCapabilities(input);

    expect(output.result.contract).toMatchObject({ package_manager: 'pnpm' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      input: {
        Bucket: 'zapp-artifacts',
        Key: output.reportArtifact.storageRef,
        ContentType: 'application/json',
        Metadata: { sha256: output.reportArtifact.contentHash },
      },
    });
    expect(calls.some(({ url }) => url.pathname.endsWith('/terminate'))).toBe(true);
    const createCall = calls.find(({ url }) => url.pathname === '/internal/workspaces');
    const token = new Headers(createCall?.init.headers).get('x-zapp-service-token');
    expect(token).not.toBeNull();
    await expect(
      createServiceTokenSigner(TOKEN_CONFIG).verifyServiceToken(
        token ?? '',
        'sandbox-service',
        NOW,
      ),
    ).resolves.toMatchObject({
      ok: true,
      claims: { service: 'orchestrator-worker', audience: 'sandbox-service' },
    });
  });

  it('replays one stable workspace after a committed create response is lost', async () => {
    const input = scanInput();
    const createBodies: string[] = [];
    const createKeys: string[] = [];
    const terminated: string[] = [];
    let createAttempts = 0;
    const fetchImpl = vi.fn(
      (resource: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(
          typeof resource === 'string' || resource instanceof URL ? resource : resource.url,
        );
        if (url.pathname === '/internal/workspaces' && init.method === 'POST') {
          if (typeof init.body !== 'string') {
            throw new Error('workspace create request body was not JSON text');
          }
          createBodies.push(init.body);
          createKeys.push(new Headers(init.headers).get('idempotency-key') ?? '');
          createAttempts += 1;
          if (createAttempts === 1) {
            return Promise.reject(new Error('create response lost after commit'));
          }
          return Promise.resolve(
            Response.json({ workspace: { id: input.workspaceId } }, { status: 201 }),
          );
        }
        if (url.pathname.endsWith('/files/list')) {
          return Promise.resolve(Response.json([{ path: 'package.json', type: 'file' }]));
        }
        if (url.pathname.endsWith('/files')) {
          return Promise.resolve(
            Response.json({ name: 'retry-fixture', scripts: { build: 'build' } }),
          );
        }
        if (url.pathname.endsWith('/terminate') && init.method === 'POST') {
          terminated.push(url.pathname);
          return Promise.resolve(Response.json({ workspace: { id: input.workspaceId } }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    );
    const activities = createProductionCapabilityScanActivities({
      sandbox: {
        baseUrl: 'https://sandbox.internal',
        serviceTokens: TOKEN_CONFIG,
        fetch: fetchImpl,
        now: () => NOW,
      },
      artifacts: {
        client: { send: () => Promise.resolve({}) },
        bucket: 'zapp-artifacts',
      },
    });

    await expect(activities.scanProjectCapabilities(input)).rejects.toThrow(
      'create response lost after commit',
    );
    await expect(activities.scanProjectCapabilities(input)).resolves.toBeDefined();

    expect(createBodies).toHaveLength(2);
    expect(createBodies[1]).toBe(createBodies[0]);
    expect(createKeys[1]).toBe(createKeys[0]);
    expect(JSON.parse(createBodies[0] ?? '{}')).toMatchObject({
      workspace: { id: input.workspaceId, createdAt: input.workspaceCreatedAt },
      runId: input.runId,
      taskId: input.taskId,
    });
    expect(terminated).toEqual([`/internal/workspaces/${input.workspaceId}/terminate`]);
  });
});
