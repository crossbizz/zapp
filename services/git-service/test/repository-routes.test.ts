import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApprovedTemplateNotFoundError } from '../src/provider/repository-features.js';
import {
  CommitComparisonNotFoundError,
  CommitComparisonTooLargeError,
  RepositoryOperationError,
  RepositorySeedConflictError,
} from '../src/provider/repository-operations.js';
import {
  harness,
  newProject,
  serviceHeaders,
  serviceToken,
  type Harness,
} from './support/harness.js';

let h: Harness;

beforeEach(() => {
  h = harness();
});

afterEach(async () => {
  await h.app.close();
});

describe('GET /internal/git/repositories/:organizationId/:projectId/compare', () => {
  it('derives the tenant project and returns only the bounded exact comparison', async () => {
    const project = newProject();
    const beforeSha = '1'.repeat(40);
    const afterSha = '2'.repeat(40);
    h.features.comparison = { beforeSha, afterSha, patch: 'diff --git a/a b/a\n' };

    const response = await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/compare?beforeSha=${beforeSha}&afterSha=${afterSha}`,
      headers: serviceHeaders(await serviceToken()),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(h.features.comparison);
    expect(h.features.calls).toEqual([
      {
        method: 'compare',
        args: [
          {
            organizationId: project.organizationId,
            projectId: project.projectId,
            beforeSha,
            afterSha,
          },
        ],
      },
    ]);
  });

  it.each([
    [new CommitComparisonTooLargeError(), 413, 'git_comparison_too_large'],
    [new CommitComparisonNotFoundError(), 404, 'git_commit_not_found'],
    [new RepositoryOperationError(), 502, 'git_repository_operation_failed'],
  ] as const)('maps a comparison refusal without provider detail', async (error, status, code) => {
    const project = newProject();
    h.features.failNext('compare', error);
    const response = await h.app.inject({
      method: 'GET',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/compare?beforeSha=${'3'.repeat(40)}&afterSha=${'4'.repeat(40)}`,
      headers: serviceHeaders(await serviceToken()),
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    if (error instanceof RepositoryOperationError) {
      expect(response.body).not.toContain(error.message);
    }
  });
});

describe('POST /internal/git/repositories/:organizationId/:projectId/template-seed', () => {
  it('accepts only an approved slug plus key and returns no source credential', async () => {
    const project = newProject();
    h.features.seedResult = { headCommitSha: '5'.repeat(40), replayed: true };
    const response = await h.app.inject({
      method: 'POST',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/template-seed`,
      headers: {
        ...serviceHeaders(await serviceToken()),
        'idempotency-key': 'seed-request-100',
      },
      payload: { templateSlug: 'saas-starter' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      templateSlug: 'saas-starter',
      headCommitSha: '5'.repeat(40),
      replayed: true,
    });
    expect(response.body).not.toContain('credential');
    expect(h.features.calls[0]?.args[0]).toEqual({
      organizationId: project.organizationId,
      projectId: project.projectId,
      templateSlug: 'saas-starter',
      operationKey: 'seed-request-100',
    });

    const arbitrarySource = await h.app.inject({
      method: 'POST',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/template-seed`,
      headers: {
        ...serviceHeaders(await serviceToken()),
        'idempotency-key': 'seed-request-101',
      },
      payload: {
        templateSlug: 'saas-starter',
        sourceCloneUrl: 'https://attacker.example/repository.git',
        sourceCommitSha: '6'.repeat(40),
      },
    });
    expect(arbitrarySource.statusCode).toBe(400);
    expect(h.features.calls).toHaveLength(1);
  });

  it.each([
    [new ApprovedTemplateNotFoundError(), 404, 'approved_template_not_found'],
    [new RepositorySeedConflictError(), 409, 'git_seed_conflict'],
    [new RepositoryOperationError(), 502, 'git_repository_operation_failed'],
  ] as const)('maps a seed refusal without source detail', async (error, status, code) => {
    const project = newProject();
    h.features.failNext('seedApprovedTemplate', error);
    const response = await h.app.inject({
      method: 'POST',
      url: `/internal/git/repositories/${project.organizationId}/${project.projectId}/template-seed`,
      headers: {
        ...serviceHeaders(await serviceToken()),
        'idempotency-key': 'seed-request-102',
      },
      payload: { templateSlug: 'saas-starter' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    if (error instanceof RepositoryOperationError) {
      expect(response.body).not.toContain(error.message);
    }
  });

  it('is callable only by control-api and requires the idempotency key', async () => {
    const project = newProject();
    const url = `/internal/git/repositories/${project.organizationId}/${project.projectId}/template-seed`;
    const forbidden = await h.app.inject({
      method: 'POST',
      url,
      headers: {
        ...serviceHeaders(await serviceToken('sandbox-service')),
        'idempotency-key': 'seed-request-103',
      },
      payload: { templateSlug: 'saas-starter' },
    });
    expect(forbidden.statusCode).toBe(403);

    const noKey = await h.app.inject({
      method: 'POST',
      url,
      headers: serviceHeaders(await serviceToken()),
      payload: { templateSlug: 'saas-starter' },
    });
    expect(noKey.statusCode).toBe(400);
    expect(h.features.calls).toEqual([]);
  });
});
