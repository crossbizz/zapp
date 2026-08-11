import { newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createForkActivity,
  ForkActivityInputSchema,
  type ForkContextPort,
  type ForkDeploymentPort,
  type ForkEntityPort,
  type ForkGitPort,
  type ForkReleasePort,
  type ForkSourcePort,
  type ForkUsagePort,
  type ProjectForkSource,
  type RunForkSource,
} from '../src/activities/fork.js';
import type { AuthIdentity } from '../src/auth/port.js';
import type { ForkActivity } from '../src/routes/forks.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import { buildHarness, signIn, type Harness } from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'fork-owner',
  email: 'fork-owner@zapp.test',
  displayName: 'Fiona Forker',
};

class ForkFixture
  implements
    ForkSourcePort,
    ForkEntityPort,
    ForkGitPort,
    ForkContextPort,
    ForkDeploymentPort,
    ForkReleasePort,
    ForkUsagePort
{
  readonly projectSources = new Map<string, ProjectForkSource>();
  readonly runSources = new Map<string, RunForkSource>();
  readonly immutableArtifacts = new Map<string, string>();
  readonly projectCreates: unknown[] = [];
  readonly branchCreates: unknown[] = [];
  readonly runCreates: unknown[] = [];
  readonly repositoryCopies: unknown[] = [];
  readonly gitBranches: unknown[] = [];
  readonly contextLinks: unknown[] = [];
  readonly restores: unknown[] = [];
  readonly deploymentCopies: unknown[] = [];
  readonly releaseForks: unknown[] = [];
  readonly usageRows: Array<{ organizationId: string; operationKey: string }> = [];
  failRunCreateOnce = false;
  failUsageOnce = false;
  private runCreateFailed = false;
  private usageFailed = false;
  private readonly completedMutations = new Map<string, unknown>();

  private async replay<T>(
    idempotencyKey: string,
    mutation: () => T | Promise<T>,
  ): Promise<T> {
    if (this.completedMutations.has(idempotencyKey)) {
      return this.completedMutations.get(idempotencyKey) as T;
    }
    const result = await mutation();
    this.completedMutations.set(idempotencyKey, result);
    return result;
  }

  project(input: { sourceOrganizationId: string; sourceProjectId: string }) {
    return Promise.resolve(
      this.projectSources.get(`${input.sourceOrganizationId}:${input.sourceProjectId}`),
    );
  }

  run(input: { sourceOrganizationId: string; sourceRunId: string }) {
    return Promise.resolve(this.runSources.get(`${input.sourceOrganizationId}:${input.sourceRunId}`));
  }

  async createProject(input: Parameters<ForkEntityPort['createProject']>[0]) {
    return this.replay(input.idempotencyKey, async () => {
      this.projectCreates.push(input);
      await input.copyRepository();
      return { projectId: input.projectId, branchId: input.branchId };
    });
  }

  async createBranch(input: Parameters<ForkEntityPort['createBranch']>[0]) {
    return this.replay(input.idempotencyKey, async () => {
      this.branchCreates.push(input);
      await input.createBranchRef();
      return { branchId: input.branchId };
    });
  }

  createRun(input: Parameters<ForkEntityPort['createRun']>[0]) {
    if (this.completedMutations.has(input.idempotencyKey)) {
      return Promise.resolve(
        this.completedMutations.get(input.idempotencyKey) as { runId: string },
      );
    }
    this.runCreates.push(input);
    const result = { runId: input.runId };
    this.completedMutations.set(input.idempotencyKey, result);
    if (this.failRunCreateOnce && !this.runCreateFailed) {
      this.runCreateFailed = true;
      return Promise.reject(new Error('run create unavailable'));
    }
    return Promise.resolve(result);
  }

  copyRepository(input: Parameters<ForkGitPort['copyRepository']>[0]) {
    return this.replay(input.idempotencyKey, () => {
      this.repositoryCopies.push(input);
    });
  }

  createBranchRef(input: Parameters<ForkGitPort['createBranchRef']>[0]) {
    return this.replay(input.idempotencyKey, () => {
      this.gitBranches.push(input);
    });
  }

  compactAndLink(input: Parameters<ForkContextPort['compactAndLink']>[0]) {
    return this.replay(input.idempotencyKey, () => {
      this.contextLinks.push(input);
      const artifactId = input.destinationArtifactId;
      if (this.immutableArtifacts.has(artifactId)) {
        throw new Error('immutable artifact id collision');
      }
      this.immutableArtifacts.set(artifactId, input.sourceRunId);
      return { artifactId, sourceRunId: input.sourceRunId };
    });
  }

  restoreCheckpoint(input: Parameters<ForkContextPort['restoreCheckpoint']>[0]) {
    return this.replay(input.idempotencyKey, () => {
      this.restores.push(input);
      return { workspaceId: input.workspaceId, checkpointRef: input.checkpointRef };
    });
  }

  copyConfiguration(input: Parameters<ForkDeploymentPort['copyConfiguration']>[0]) {
    return this.replay(input.idempotencyKey, () => {
      this.deploymentCopies.push(input);
    });
  }

  forkRelease(input: Parameters<ForkReleasePort['forkRelease']>[0]) {
    return this.replay(input.idempotencyKey, () => {
      this.releaseForks.push(input);
      return {
        releaseId: input.releaseId,
        branchId: input.branchId,
        fixRunId: input.startFixRun ? input.fixRunId : null,
      };
    });
  }

  record(input: Parameters<ForkUsagePort['record']>[0]) {
    if (this.completedMutations.has(input.idempotencyKey)) {
      return Promise.resolve(this.completedMutations.get(input.idempotencyKey));
    }
    this.usageRows.push({
      organizationId: input.organizationId,
      operationKey: input.operationKey,
    });
    const result = { organizationId: input.organizationId };
    this.completedMutations.set(input.idempotencyKey, result);
    if (this.failUsageOnce && !this.usageFailed) {
      this.usageFailed = true;
      return Promise.reject(new Error('usage unavailable'));
    }
    return Promise.resolve(result);
  }
}

function fixtureActivity(fixture: ForkFixture): ForkActivity {
  return createForkActivity({
    sources: fixture,
    entities: fixture,
    git: fixture,
    context: fixture,
    deployments: fixture,
    releases: fixture,
    usage: fixture,
  });
}

describe('AR-21 fork activity', () => {
  it('copies a project repository into a new identity without copying cross-org secret values', async () => {
    const fixture = new ForkFixture();
    const sourceOrganizationId = newId('org');
    const destinationOrganizationId = newId('org');
    const sourceProjectId = newId('proj');
    const sourceArtifactId = newId('art');
    fixture.immutableArtifacts.set(sourceArtifactId, 'source bytes');
    fixture.projectSources.set(`${sourceOrganizationId}:${sourceProjectId}`, {
      organizationId: sourceOrganizationId,
      projectId: sourceProjectId,
      repositoryRef: 'source/repository',
      defaultBranch: 'main',
      defaultBranchHeadSha: 'a'.repeat(40),
      name: 'Source project',
      description: 'source description',
      supportLevel: 'compatible',
      secretNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      deploymentConfiguration: { provider: 'fly', environmentNames: ['production'] },
      artifactIds: [sourceArtifactId],
    });

    const activity = fixtureActivity(fixture);
    const result = await activity.execute({
      target: 'project',
      sourceOrganizationId,
      sourceProjectId,
      destinationOrganizationId,
      actorId: newId('user'),
      operationKey: `op_${'1'.repeat(64)}`,
      name: 'Forked project',
      copyDeploymentConfig: false,
    });
    if (result.target !== 'project') throw new Error('expected project fork');

    expect(result).toMatchObject({
      target: 'project',
      sourceProjectId,
      secretSetupChecklist: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      deploymentConfigCopied: false,
    });
    expect(result.projectId).not.toBe(sourceProjectId);
    expect(fixture.repositoryCopies).toHaveLength(1);
    expect(fixture.deploymentCopies).toHaveLength(0);
    expect(fixture.projectCreates[0]).not.toHaveProperty('source.deploymentConfiguration');
    expect(fixture.usageRows).toEqual([
      { organizationId: destinationOrganizationId, operationKey: `op_${'1'.repeat(64)}` },
    ]);
    expect(fixture.immutableArtifacts.get(sourceArtifactId)).toBe('source bytes');
    await expect(
      fixture.compactAndLink({
        sourceOrganizationId,
        sourceRunId: newId('run'),
        destinationOrganizationId,
        destinationProjectId: result.projectId,
        destinationRunId: newId('run'),
        destinationArtifactId: sourceArtifactId,
        operationKey: `op_${'2'.repeat(64)}`,
        idempotencyKey: `op_${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow('immutable artifact id collision');
  });

  it('scopes deterministic identities to the destination organization', async () => {
    const fixture = new ForkFixture();
    const sourceOrganizationId = newId('org');
    const firstDestinationOrganizationId = newId('org');
    const secondDestinationOrganizationId = newId('org');
    const sourceProjectId = newId('proj');
    fixture.projectSources.set(`${sourceOrganizationId}:${sourceProjectId}`, {
      organizationId: sourceOrganizationId,
      projectId: sourceProjectId,
      repositoryRef: 'source/repository',
      defaultBranch: 'main',
      defaultBranchHeadSha: '9'.repeat(40),
      name: 'Source project',
      description: null,
      supportLevel: 'compatible',
      secretNames: [],
      deploymentConfiguration: null,
      artifactIds: [],
    });
    const activity = fixtureActivity(fixture);
    const common = {
      target: 'project' as const,
      sourceOrganizationId,
      sourceProjectId,
      actorId: newId('user'),
      operationKey: `op_${'8'.repeat(64)}`,
      name: 'Forked project',
      copyDeploymentConfig: false,
    };

    const first = await activity.execute({
      ...common,
      destinationOrganizationId: firstDestinationOrganizationId,
    });
    const second = await activity.execute({
      ...common,
      destinationOrganizationId: secondDestinationOrganizationId,
    });
    if (first.target !== 'project' || second.target !== 'project') {
      throw new Error('expected project forks');
    }

    expect(first.projectId).not.toBe(second.projectId);
    expect(first.branchId).not.toBe(second.branchId);
  });

  it('copies deployment configuration only when the caller explicitly opts in', async () => {
    const fixture = new ForkFixture();
    const organizationId = newId('org');
    const projectId = newId('proj');
    fixture.projectSources.set(`${organizationId}:${projectId}`, {
      organizationId,
      projectId,
      repositoryRef: 'same/repository',
      defaultBranch: 'main',
      defaultBranchHeadSha: 'b'.repeat(40),
      name: 'Configured project',
      description: null,
      supportLevel: 'compatible',
      secretNames: [],
      deploymentConfiguration: { provider: 'fly', environmentNames: ['production'] },
      artifactIds: [],
    });

    const result = await fixtureActivity(fixture).execute({
      target: 'project',
      sourceOrganizationId: organizationId,
      sourceProjectId: projectId,
      destinationOrganizationId: organizationId,
      actorId: newId('user'),
      operationKey: `op_${'3'.repeat(64)}`,
      name: 'Configured fork',
      copyDeploymentConfig: true,
    });
    if (result.target !== 'project') throw new Error('expected project fork');

    expect(result).toMatchObject({ deploymentConfigCopied: true, secretSetupChecklist: [] });
    expect(fixture.deploymentCopies).toHaveLength(1);
  });

  it('forks a branch from the exact immutable commit sha', async () => {
    const fixture = new ForkFixture();
    const organizationId = newId('org');
    const projectId = newId('proj');
    const sha = 'c'.repeat(40);

    const result = await fixtureActivity(fixture).execute({
      target: 'branch',
      sourceOrganizationId: organizationId,
      projectId,
      destinationOrganizationId: organizationId,
      actorId: newId('user'),
      operationKey: `op_${'4'.repeat(64)}`,
      name: 'feature/fork',
      fromSha: sha,
    });
    if (result.target !== 'branch') throw new Error('expected branch fork');

    expect(result).toMatchObject({ target: 'branch', projectId, headCommitSha: sha });
    expect(fixture.gitBranches).toEqual([
      expect.objectContaining({ organizationId, projectId, name: 'feature/fork', fromSha: sha }),
    ]);
  });

  it('seeds a conversation fork with a new compacted context artifact linked to its source run', async () => {
    const fixture = new ForkFixture();
    const organizationId = newId('org');
    const projectId = newId('proj');
    const sourceRunId = newId('run');
    fixture.runSources.set(`${organizationId}:${sourceRunId}`, {
      organizationId,
      runId: sourceRunId,
      projectId,
      branchId: null,
      mode: 'ask',
      appType: 'web',
      model: null,
      checkpointRefs: [],
      artifactIds: [newId('art')],
    });

    const result = await fixtureActivity(fixture).execute({
      target: 'conversation',
      sourceOrganizationId: organizationId,
      sourceRunId,
      destinationOrganizationId: organizationId,
      destinationProjectId: projectId,
      destinationBranchId: null,
      actorId: newId('user'),
      operationKey: `op_${'5'.repeat(64)}`,
    });
    if (result.target !== 'conversation') throw new Error('expected conversation fork');

    expect(result).toMatchObject({ target: 'conversation', sourceRunId });
    expect(result.runId).not.toBe(sourceRunId);
    expect(fixture.contextLinks).toEqual([
      expect.objectContaining({ sourceRunId, destinationRunId: result.runId }),
    ]);
    expect(fixture.runCreates).toEqual([
      expect.objectContaining({ runId: result.runId, contextArtifactId: result.contextArtifactId }),
    ]);
  });

  it('replays keyed completed mutations when a later conversation step fails once', async () => {
    const fixture = new ForkFixture();
    fixture.failRunCreateOnce = true;
    fixture.failUsageOnce = true;
    const organizationId = newId('org');
    const projectId = newId('proj');
    const sourceRunId = newId('run');
    fixture.runSources.set(`${organizationId}:${sourceRunId}`, {
      organizationId,
      runId: sourceRunId,
      projectId,
      branchId: null,
      mode: 'ask',
      appType: 'web',
      model: null,
      checkpointRefs: [],
      artifactIds: [],
    });
    const input = {
      target: 'conversation' as const,
      sourceOrganizationId: organizationId,
      sourceRunId,
      destinationOrganizationId: organizationId,
      destinationProjectId: projectId,
      destinationBranchId: null,
      actorId: newId('user'),
      operationKey: `op_${'a'.repeat(64)}`,
    };
    const activity = fixtureActivity(fixture);

    await expect(activity.execute(input)).rejects.toThrow('run create unavailable');
    await expect(activity.execute(input)).rejects.toThrow('usage unavailable');
    await expect(activity.execute(input)).resolves.toMatchObject({
      target: 'conversation',
      sourceRunId,
    });
    expect(fixture.contextLinks).toHaveLength(1);
    expect(fixture.runCreates).toHaveLength(1);
    expect(fixture.usageRows).toHaveLength(1);
  });

  it('restores a checkpoint fork into a new run and workspace identity', async () => {
    const fixture = new ForkFixture();
    const organizationId = newId('org');
    const projectId = newId('proj');
    const branchId = newId('br');
    const sourceRunId = newId('run');
    const checkpointRef = `run:${sourceRunId}:phase:2`;
    fixture.runSources.set(`${organizationId}:${sourceRunId}`, {
      organizationId,
      runId: sourceRunId,
      projectId,
      branchId,
      mode: 'autonomous',
      appType: 'web',
      model: null,
      checkpointRefs: [checkpointRef],
      artifactIds: [],
    });

    const result = await fixtureActivity(fixture).execute({
      target: 'run_checkpoint',
      sourceOrganizationId: organizationId,
      sourceRunId,
      checkpointRef,
      destinationOrganizationId: organizationId,
      destinationProjectId: projectId,
      destinationBranchId: branchId,
      actorId: newId('user'),
      operationKey: `op_${'6'.repeat(64)}`,
    });
    if (result.target !== 'run_checkpoint') throw new Error('expected checkpoint fork');

    expect(result).toMatchObject({ target: 'run_checkpoint', sourceRunId, checkpointRef });
    expect(result.runId).not.toBe(sourceRunId);
    expect(fixture.restores).toEqual([
      expect.objectContaining({
        destinationRunId: result.runId,
        workspaceId: result.workspaceId,
        checkpointRef,
      }),
    ]);
  });

  it('delegates a release fork to the DEP-12 repair-branch boundary', async () => {
    const fixture = new ForkFixture();
    const organizationId = newId('org');
    const releaseId = newId('rel');

    const result = await fixtureActivity(fixture).execute({
      target: 'release_repair',
      sourceOrganizationId: organizationId,
      releaseId,
      destinationOrganizationId: organizationId,
      actorId: newId('user'),
      operationKey: `op_${'7'.repeat(64)}`,
      startFixRun: true,
    });

    expect(result).toMatchObject({ target: 'release_repair', releaseId });
    expect(fixture.releaseForks).toEqual([
      expect.objectContaining({ releaseId, branchName: `fix/rel-${releaseId}`, startFixRun: true }),
    ]);
  });
});

describe('POST /v1/forks', () => {
  it('uses the selected organization as the billing destination and hides unauthorized sources as 404', async () => {
    const calls: unknown[] = [];
    const activity: ForkActivity = {
      execute(untrustedInput) {
        const input = ForkActivityInputSchema.parse(untrustedInput);
        calls.push(input);
        return Promise.resolve({
          target: 'branch',
          projectId: input.target === 'branch' ? input.projectId : newId('proj'),
          branchId: newId('br'),
          headCommitSha: 'd'.repeat(40),
        });
      },
    };
    const tenantData = new InMemoryTenantData();
    const built = buildHarness({
      tenantDb: tenantData.factory,
      fork: activity,
    });
    harnesses.push(built);
    const session = await signIn(built, OWNER);
    const destination = await built.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: session.headers,
      payload: { name: 'Fork destination' },
    });
    expect(destination.statusCode, destination.body).toBe(201);
    const destinationOrganizationId = destination.json<{ organization: { id: string } }>()
      .organization.id;
    const unauthorizedSourceOrganizationId = newId('org');
    const headers = {
      ...session.headers,
      [ORGANIZATION_HEADER]: destinationOrganizationId,
      'idempotency-key': 'fork-route-key',
    };

    const refused = await built.app.inject({
      method: 'POST',
      url: '/v1/forks',
      headers,
      payload: {
        target: 'branch',
        sourceOrganizationId: unauthorizedSourceOrganizationId,
        projectId: newId('proj'),
        name: 'feature/refused',
        fromSha: 'd'.repeat(40),
      },
    });
    expect(refused.statusCode).toBe(404);
    expect(calls).toHaveLength(0);

    const accepted = await built.app.inject({
      method: 'POST',
      url: '/v1/forks',
      headers: { ...headers, 'idempotency-key': 'fork-route-accepted' },
      payload: {
        target: 'branch',
        sourceOrganizationId: destinationOrganizationId,
        projectId: newId('proj'),
        name: 'feature/accepted',
        fromSha: 'd'.repeat(40),
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(calls).toEqual([
      expect.objectContaining({
        target: 'branch',
        sourceOrganizationId: destinationOrganizationId,
        destinationOrganizationId,
        actorId: session.userId,
      }),
    ]);
  });
});
