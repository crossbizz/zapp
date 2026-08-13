import { describe, expect, it } from 'vitest';
import { internalRepoRef, newId } from '@zapp/contracts';

import {
  ApprovedTemplateNotFoundError,
  createRepositoryFeatures,
} from '../src/provider/repository-features.js';
import type {
  CompareCommitsInput,
  RepositoryOperations,
  SeedRepositoryInput,
} from '../src/provider/repository-operations.js';
import { createTemplateRegistry } from '../src/template-registry.js';
import type { ApprovedTemplateTokenService, MintedToken } from '../src/tokens.js';

const SOURCE_SHA = '1'.repeat(40);

function registry() {
  return createTemplateRegistry({
    version: 1,
    templates: [
      {
        slug: 'saas-starter',
        name: 'SaaS Starter',
        description: 'An approved starter.',
        pagesIncluded: ['Landing'],
        highlights: ['Authentication'],
        demoUrl: 'https://saas-starter.demo.zapp.build',
        stack: 'TypeScript',
        source: {
          approved: true,
          repoRef: 'zapp-projects/saas-starter',
          commitSha: SOURCE_SHA,
        },
      },
    ],
  });
}

interface RecordingOperations extends RepositoryOperations {
  readonly comparisons: CompareCommitsInput[];
  readonly seeds: SeedRepositoryInput[];
  comparisonFailure?: Error;
  seedFailure?: Error;
}

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

interface RecordingTokens extends ApprovedTemplateTokenService {
  readonly calls: RecordedCall[];
  readonly minted: MintedToken;
  readonly sourceMinted: MintedToken;
}

function recordingTokens(): RecordingTokens {
  const calls: RecordedCall[] = [];
  const minted: MintedToken = {
    token: 'target-repository-credential',
    username: 'zt-1900000000-0123456789ab',
    cloneUrl: 'https://git.internal.example/org_target/proj_target.git',
    expiresAt: new Date('2030-03-17T17:46:40.000Z'),
  };
  const sourceMinted: MintedToken = {
    token: 'approved-source-read-credential',
    username: 'zt-1900000000-abcdef012345',
    cloneUrl: 'https://git.internal.example/base/zapp-projects/saas-starter.git',
    expiresAt: new Date('2030-03-17T17:46:40.000Z'),
  };
  return {
    calls,
    minted,
    sourceMinted,
    mint(input) {
      calls.push({ method: 'mint', args: [input] });
      return Promise.resolve(minted);
    },
    mintForRepository(input) {
      calls.push({ method: 'mintForRepository', args: [input] });
      return Promise.resolve(minted);
    },
    revokeForProject(input) {
      calls.push({ method: 'revokeForProject', args: [input] });
      return Promise.resolve(0);
    },
    revokeEphemeral(input) {
      calls.push({ method: 'revokeEphemeral', args: [input] });
      return Promise.resolve();
    },
    mintApprovedTemplateSource(input) {
      calls.push({ method: 'mintApprovedTemplateSource', args: [input] });
      return Promise.resolve(sourceMinted);
    },
    revokeApprovedTemplateSource(input) {
      calls.push({ method: 'revokeApprovedTemplateSource', args: [input] });
      return Promise.resolve();
    },
    sweepExpired(now) {
      calls.push({ method: 'sweepExpired', args: [now] });
      return Promise.resolve(0);
    },
  };
}

function newProject() {
  return { organizationId: newId('org'), projectId: newId('proj') };
}

function recordingOperations(): RecordingOperations {
  const comparisons: CompareCommitsInput[] = [];
  const seeds: SeedRepositoryInput[] = [];
  const operations: RecordingOperations = {
    comparisons,
    seeds,
    compare(input) {
      comparisons.push(input);
      if (operations.comparisonFailure !== undefined) {
        return Promise.reject(operations.comparisonFailure);
      }
      return Promise.resolve({
        beforeSha: input.beforeSha,
        afterSha: input.afterSha,
        patch: 'bounded patch',
      });
    },
    seed(input) {
      seeds.push(input);
      if (operations.seedFailure !== undefined) {
        return Promise.reject(operations.seedFailure);
      }
      return Promise.resolve({ headCommitSha: input.sourceCommitSha, replayed: false });
    },
  };
  return operations;
}

function subject(headSequence: readonly (string | undefined)[] = [SOURCE_SHA]) {
  const tokens = recordingTokens();
  const operations = recordingOperations();
  const headReads: { readonly ref: string; readonly branch: string }[] = [];
  let delayCalls = 0;
  const features = createRepositoryFeatures({
    registry: registry(),
    tokens,
    operations,
    headReader: {
      getBranch(ref: string, branch: string) {
        if (tokens.calls.some((call) => call.method === 'revokeEphemeral')) {
          return Promise.reject(new Error('writer was revoked before head confirmation'));
        }
        headReads.push({ ref, branch });
        const headSha = headSequence[Math.min(headReads.length - 1, headSequence.length - 1)];
        return Promise.resolve(headSha === undefined ? undefined : { name: branch, headSha });
      },
    },
    headPoll: {
      attempts: 3,
      delay: () => {
        delayCalls += 1;
        return Promise.resolve();
      },
    },
  });
  return { features, operations, tokens, headReads, delayCalls: () => delayCalls };
}

describe('repository features', () => {
  it('compares exact commits through a read credential scoped to the tenant project', async () => {
    const { features, operations, tokens } = subject();
    const project = newProject();
    const beforeSha = '2'.repeat(40);
    const afterSha = '3'.repeat(40);

    await expect(features.compare({ ...project, beforeSha, afterSha })).resolves.toEqual({
      beforeSha,
      afterSha,
      patch: 'bounded patch',
    });

    expect(tokens.calls).toEqual([
      {
        method: 'mint',
        args: [
          {
            organizationId: project.organizationId,
            projectId: project.projectId,
            access: 'read',
            ttlSec: 300,
            requestingService: 'control-api',
          },
        ],
      },
      {
        method: 'revokeEphemeral',
        args: [
          {
            organizationId: project.organizationId,
            projectId: project.projectId,
            username: tokens.minted.username,
            requestingService: 'control-api',
          },
        ],
      },
    ]);
    expect(operations.comparisons).toEqual([
      {
        repository: {
          cloneUrl: tokens.minted.cloneUrl,
          username: tokens.minted.username,
          credential: tokens.minted.token,
        },
        beforeSha,
        afterSha,
      },
    ]);
  });

  it('seeds only a registry-approved exact source commit into the tenant project', async () => {
    const { features, operations, tokens } = subject();
    const project = newProject();

    await expect(
      features.seedApprovedTemplate({
        ...project,
        templateSlug: 'saas-starter',
        operationKey: 'seed-request-001',
      }),
    ).resolves.toEqual({ headCommitSha: SOURCE_SHA, replayed: false });

    expect(operations.seeds).toEqual([
      {
        source: {
          cloneUrl: 'https://git.internal.example/base/zapp-projects/saas-starter.git',
          username: tokens.sourceMinted.username,
          credential: tokens.sourceMinted.token,
        },
        target: {
          cloneUrl: tokens.minted.cloneUrl,
          username: tokens.minted.username,
          credential: tokens.minted.token,
        },
        sourceCommitSha: SOURCE_SHA,
        sourceIdentity: 'zapp-projects/saas-starter',
        targetIdentity: internalRepoRef(project),
        operationKey: 'seed-request-001',
      },
    ]);
    expect(JSON.stringify(operations.seeds)).not.toContain('source-admin-credential');
    expect(tokens.calls.map((call) => call.method)).toEqual([
      'mintApprovedTemplateSource',
      'mint',
      'revokeEphemeral',
      'revokeApprovedTemplateSource',
    ]);
    expect(tokens.calls[0]?.args[0]).toMatchObject({
      organizationId: project.organizationId,
      projectId: project.projectId,
      repositoryRef: 'zapp-projects/saas-starter',
    });
    expect(tokens.calls[1]?.args[0]).toMatchObject({
      organizationId: project.organizationId,
      projectId: project.projectId,
      access: 'write',
    });
  });

  it('rejects arbitrary and unapproved sources before minting a project credential', async () => {
    const { features, operations, tokens } = subject();

    await expect(
      features.seedApprovedTemplate({
        ...newProject(),
        templateSlug: 'https://attacker.example/repository.git',
        operationKey: 'seed-request-002',
      }),
    ).rejects.toThrow();
    await expect(
      features.seedApprovedTemplate({
        ...newProject(),
        templateSlug: 'unapproved-source',
        operationKey: 'seed-request-003',
      }),
    ).rejects.toBeInstanceOf(ApprovedTemplateNotFoundError);
    expect(tokens.calls).toEqual([]);
    expect(operations.seeds).toEqual([]);
  });

  it('revokes the project credential when an operation fails', async () => {
    const { features, operations, tokens } = subject();
    operations.comparisonFailure = new Error('git failed');

    await expect(
      features.compare({
        ...newProject(),
        beforeSha: '4'.repeat(40),
        afterSha: '5'.repeat(40),
      }),
    ).rejects.toThrow('git failed');
    expect(tokens.calls.map((call) => call.method)).toEqual(['mint', 'revokeEphemeral']);
  });

  it('revokes both scoped credentials when template seeding fails', async () => {
    const { features, operations, tokens } = subject();
    operations.seedFailure = new Error('seed failed');

    await expect(
      features.seedApprovedTemplate({
        ...newProject(),
        templateSlug: 'saas-starter',
        operationKey: 'seed-request-failure',
      }),
    ).rejects.toThrow('seed failed');
    expect(tokens.calls.map((call) => call.method)).toEqual([
      'mintApprovedTemplateSource',
      'mint',
      'revokeEphemeral',
      'revokeApprovedTemplateSource',
    ]);
  });

  it('keeps the scoped writer alive until the exact seeded head is visible', async () => {
    const project = newProject();
    const { features, headReads, delayCalls, tokens } = subject([undefined, SOURCE_SHA]);

    await features.seedApprovedTemplate({
      ...project,
      templateSlug: 'saas-starter',
      operationKey: 'seed-request-visible',
    });

    expect(headReads).toEqual([
      { ref: internalRepoRef(project), branch: 'main' },
      { ref: internalRepoRef(project), branch: 'main' },
    ]);
    expect(delayCalls()).toBe(1);
    expect(tokens.calls.map((call) => call.method).at(-2)).toBe('revokeEphemeral');
  });
});
