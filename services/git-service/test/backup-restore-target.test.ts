import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import * as backupScript from '../scripts/backup.js';
import type { CreatedRestoreTarget } from '../src/backup.js';
import type { ForgejoClient } from '../src/forgejo/client.js';
import { createFakeForgejo, type Route } from './support/fake-forgejo.js';

const ORGANIZATION_ID = newId('org');
const PROJECT_ID = newId('proj');
const REF = internalRepoRef({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID });
const [OWNER, NAME] = REF.split('/') as [string, string];
const CLONE_URL = `https://git.test/${REF}.git`;
const OPERATION_MARKER = 'zapp.build restore operation unit-marker';

type CreateForgejoRestoreTarget = (
  client: ForgejoClient,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly defaultBranch: string;
    readonly description?: string;
  },
) => Promise<CreatedRestoreTarget>;

function restoreTargetCreator(): CreateForgejoRestoreTarget | undefined {
  return (backupScript as { readonly createForgejoRestoreTarget?: CreateForgejoRestoreTarget })
    .createForgejoRestoreTarget;
}

function routes(repository: Route): Record<string, Route> {
  return {
    [`GET /orgs/${OWNER}`]: { status: 200, body: { username: OWNER } },
    [`GET /repos/${OWNER}/${NAME}`]: repository,
  };
}

async function attempt(client: ForgejoClient): Promise<CreatedRestoreTarget> {
  const create = restoreTargetCreator();
  expect(create, 'restore-specific create-only path is missing').toBeTypeOf('function');
  if (create === undefined) {
    throw new Error('restore-specific create-only path is missing');
  }
  return await create(client, {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    defaultBranch: 'main',
    description: OPERATION_MARKER,
  });
}

describe('createForgejoRestoreTarget', () => {
  it.each([
    ['empty', true],
    ['non-empty', false],
  ])('refuses a pre-existing %s repository with zero deletes', async (_label, empty) => {
    const forgejo = createFakeForgejo(
      routes({ status: 200, body: { clone_url: CLONE_URL, empty } }),
    );

    await expect(attempt(forgejo)).rejects.toThrow('restore target already exists');

    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(forgejo.calls.filter((call) => call.path === `/orgs/${OWNER}/repos`)).toEqual([]);
  });

  it('loses a GET/POST create race without deleting the winner', async () => {
    const forgejo = createFakeForgejo({
      [`GET /orgs/${OWNER}`]: { status: 200, body: { username: OWNER } },
      [`GET /repos/${OWNER}/${NAME}`]: { status: 404 },
      [`POST /orgs/${OWNER}/repos`]: { status: 409 },
    });

    await expect(attempt(forgejo)).rejects.toThrow('restore target creation conflicted');

    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(forgejo.calls.filter((call) => call.path === `/repos/${OWNER}/${NAME}`)).toHaveLength(1);
  });

  it('installs exact deletion only after its repository POST is confirmed', async () => {
    const forgejo = createFakeForgejo({
      [`GET /orgs/${OWNER}`]: { status: 404 },
      'POST /orgs': { status: 422 },
      [`GET /repos/${OWNER}/${NAME}`]: {
        status: 404,
        then: {
          status: 200,
          body: {
            id: 101,
            clone_url: CLONE_URL,
            empty: true,
            description: OPERATION_MARKER,
          },
        },
      },
      [`POST /orgs/${OWNER}/repos`]: {
        status: 201,
        body: {
          id: 101,
          clone_url: CLONE_URL,
          empty: true,
          description: OPERATION_MARKER,
        },
      },
      [`DELETE /repos/${OWNER}/${NAME}`]: { status: 204 },
    });

    const target = await attempt(forgejo);
    expect(target.cloneUrl).toBe(CLONE_URL);
    expect((target as CreatedRestoreTarget & { readonly repositoryId?: number }).repositoryId).toBe(
      101,
    );
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    await target.compensate();

    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([
      expect.objectContaining({ path: `/repos/${OWNER}/${NAME}` }),
    ]);
  });

  it('preserves a replacement installed at the same path before compensation', async () => {
    const forgejo = createFakeForgejo({
      [`GET /orgs/${OWNER}`]: { status: 200, body: { username: OWNER } },
      [`GET /repos/${OWNER}/${NAME}`]: {
        status: 404,
        then: {
          status: 200,
          body: {
            id: 202,
            clone_url: CLONE_URL,
            empty: true,
            description: OPERATION_MARKER,
          },
        },
      },
      [`POST /orgs/${OWNER}/repos`]: {
        status: 201,
        body: {
          id: 101,
          clone_url: CLONE_URL,
          empty: true,
          description: OPERATION_MARKER,
        },
      },
      [`DELETE /repos/${OWNER}/${NAME}`]: { status: 204 },
    });

    const target = await attempt(forgejo);

    await expect(target.compensate()).rejects.toThrow('restore target ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('reports ownership loss without deleting when the created path disappeared', async () => {
    const forgejo = createFakeForgejo({
      [`GET /orgs/${OWNER}`]: { status: 200, body: { username: OWNER } },
      [`GET /repos/${OWNER}/${NAME}`]: { status: 404, then: { status: 404 } },
      [`POST /orgs/${OWNER}/repos`]: {
        status: 201,
        body: {
          id: 101,
          clone_url: CLONE_URL,
          empty: true,
          description: OPERATION_MARKER,
        },
      },
      [`DELETE /repos/${OWNER}/${NAME}`]: { status: 204 },
    });

    const target = await attempt(forgejo);

    await expect(target.compensate()).rejects.toThrow('restore target ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('preserves a repository whose immutable id matches but operation marker changed', async () => {
    const forgejo = createFakeForgejo({
      [`GET /orgs/${OWNER}`]: { status: 200, body: { username: OWNER } },
      [`GET /repos/${OWNER}/${NAME}`]: {
        status: 404,
        then: {
          status: 200,
          body: {
            id: 101,
            clone_url: CLONE_URL,
            empty: true,
            description: 'a different operation marker',
          },
        },
      },
      [`POST /orgs/${OWNER}/repos`]: {
        status: 201,
        body: {
          id: 101,
          clone_url: CLONE_URL,
          empty: true,
          description: OPERATION_MARKER,
        },
      },
      [`DELETE /repos/${OWNER}/${NAME}`]: { status: 204 },
    });

    const target = await attempt(forgejo);

    await expect(target.compensate()).rejects.toThrow('restore target ownership was lost');
    expect(forgejo.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });
});
