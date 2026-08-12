import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  createReleaseRecordService,
  releaseIncidentResolutionId,
  ReleaseSchema,
  ReleaseServiceError,
  type Actor,
  type CandidateContext,
  type CreateCandidateStoreInput,
  type Release,
  type ReleaseContextPort,
  type ReleaseGitPort,
  type ReleaseStore,
  type TransitionStoreInput,
} from '../src/release/create.js';
import { registerReleaseRoutes } from '../src/routes.js';

const ULID = '01J00000000000000000000000';
const ORG = `org_${ULID}`;
const PROJECT = `proj_${ULID}`;
const ENVIRONMENT = `env_${ULID}`;
const SPECIFICATION = `spec_${ULID}`;
const OWNER_ID = `user_${ULID}`;
const VIEWER_ID = 'user_01J00000000000000000000001';
const RELEASE_ID = `rel_${ULID}`;
const COMMIT = 'a'.repeat(40);
const OPERATION = `op_${'b'.repeat(64)}`;

class MemoryReleaseStore implements ReleaseStore {
  readonly rows = new Map<string, Release>();
  readonly operations = new Map<string, { readonly fingerprint: string; readonly row: Release }>();
  createCalls = 0;
  transitionCalls = 0;
  readonly waivers: CreateCandidateStoreInput['specificationWaiver'][] = [];
  readonly audits: CreateCandidateStoreInput['audit'][] = [];

  createCandidate(input: CreateCandidateStoreInput): Promise<Release> {
    const operation = this.operations.get(`create:${input.operationKey}`);
    if (operation !== undefined) {
      if (operation.fingerprint !== input.fingerprint) {
        throw new ReleaseServiceError(
          'idempotency_conflict',
          409,
          'The operation key was already used for different input.',
        );
      }
      return Promise.resolve(operation.row);
    }
    this.createCalls += 1;
    this.waivers.push(input.specificationWaiver);
    this.audits.push(input.audit);
    this.rows.set(input.release.id, input.release);
    this.operations.set(`create:${input.operationKey}`, {
      fingerprint: input.fingerprint,
      row: input.release,
    });
    return Promise.resolve(input.release);
  }

  get(organizationId: string, releaseId: string): Promise<Release | undefined> {
    const release = this.rows.get(releaseId);
    return Promise.resolve(release?.organizationId === organizationId ? release : undefined);
  }

  getTransitionReplay(input: {
    readonly operationKey: string;
    readonly fingerprint: string;
  }): Promise<Release | undefined> {
    const operation = this.operations.get(`transition:${input.operationKey}`);
    if (operation === undefined) return Promise.resolve(undefined);
    if (operation.fingerprint !== input.fingerprint) {
      throw new ReleaseServiceError(
        'idempotency_conflict',
        409,
        'The operation key was already used for different input.',
      );
    }
    return Promise.resolve(operation.row);
  }

  transition(input: TransitionStoreInput): Promise<Release> {
    const operation = this.operations.get(`transition:${input.operationKey}`);
    if (operation !== undefined) {
      if (operation.fingerprint !== input.fingerprint) {
        throw new ReleaseServiceError(
          'idempotency_conflict',
          409,
          'The operation key was already used for different input.',
        );
      }
      return Promise.resolve(operation.row);
    }
    if (input.from === input.to) {
      throw new ReleaseServiceError(
        'invalid_release_transition',
        409,
        `Release status ${input.from} cannot transition to ${input.to}.`,
      );
    }
    const current = this.rows.get(input.releaseId);
    if (current === undefined || current.organizationId !== input.organizationId) {
      throw new ReleaseServiceError('release_not_found', 404, 'Release not found.');
    }
    if (current.status !== input.from) {
      throw new ReleaseServiceError(
        'release_transition_conflict',
        409,
        'The release changed before this transition could be applied.',
      );
    }
    this.transitionCalls += 1;
    if (input.audit !== undefined) this.audits.push(input.audit);
    const changed = { ...current, status: input.to };
    this.rows.set(changed.id, changed);
    this.operations.set(`transition:${input.operationKey}`, {
      fingerprint: input.fingerprint,
      row: changed,
    });
    return Promise.resolve(changed);
  }
}

class RecordingGit implements ReleaseGitPort {
  commitExists = true;
  readonly tags: Array<{ readonly projectId: string; readonly tag: string; readonly sha: string }> = [];

  getCommit(input: { readonly projectId: string; readonly sha: string }): Promise<boolean> {
    void input;
    return Promise.resolve(this.commitExists);
  }

  createTag(input: {
    readonly projectId: string;
    readonly tag: string;
    readonly sha: string;
  }): Promise<void> {
    this.tags.push(input);
    return Promise.resolve();
  }
}

class MemoryReleaseContext implements ReleaseContextPort {
  candidate: CandidateContext | undefined = {
    actorRole: 'owner',
    prototypeOnly: false,
    waiverApproved: true,
  };
  mayApprove = true;

  resolveCandidate(): Promise<CandidateContext | undefined> {
    return Promise.resolve(this.candidate);
  }

  canApprove(): Promise<boolean> {
    return Promise.resolve(this.mayApprove);
  }
}

const owner: Actor = {
  id: OWNER_ID,
  organizationId: ORG,
};
const viewer: Actor = {
  id: VIEWER_ID,
  organizationId: ORG,
};

function candidate(operationKey = OPERATION) {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    commitSha: COMMIT,
    specificationId: SPECIFICATION,
    actorId: OWNER_ID,
    operationKey,
    resolvedFixRunIds: [],
  };
}

function harness() {
  const store = new MemoryReleaseStore();
  const git = new RecordingGit();
  const context = new MemoryReleaseContext();
  const service = createReleaseRecordService({
    store,
    git,
    context,
    newReleaseId: () => RELEASE_ID,
    now: () => new Date('2026-08-11T15:00:00.000Z'),
  });
  return { store, git, context, service };
}

async function releaseAt(
  status: Release['status'],
  operationKey = OPERATION,
): Promise<ReturnType<typeof harness>> {
  const built = harness();
  await built.service.createReleaseCandidate(candidate(operationKey));
  built.store.rows.set(RELEASE_ID, { ...(built.store.rows.get(RELEASE_ID) as Release), status });
  return built;
}

describe('release records', () => {
  it('uses the control-plane incident resolution identity for release retries', () => {
    expect(releaseIncidentResolutionId(`aud_${ULID}`, RELEASE_ID)).toBe(
      'aud_F8SWYNA0S3KVDRE0N1Z9SV1SXA',
    );
  });

  it('decodes a completed JSONB idempotency replay back into the release boundary type', () => {
    const replay = ReleaseSchema.parse({
      id: RELEASE_ID,
      organizationId: ORG,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      commitSha: COMMIT,
      specificationId: SPECIFICATION,
      status: 'candidate',
      evidenceManifestArtifactId: null,
      createdBy: OWNER_ID,
      createdAt: '2026-08-11T15:00:00.000Z',
    });

    expect(replay.createdAt).toEqual(new Date('2026-08-11T15:00:00.000Z'));
  });

  it('rejects an unknown internal-Git commit as commit_not_found without persisting', async () => {
    const built = harness();
    built.git.commitExists = false;

    await expect(built.service.createReleaseCandidate(candidate())).rejects.toMatchObject({
      code: 'commit_not_found',
      statusCode: 422,
    });
    expect(built.store.createCalls).toBe(0);
    expect(built.git.tags).toEqual([]);
  });

  it('tenant-scopes candidate context and rejects prototype-only commit provenance', async () => {
    const hidden = harness();
    hidden.context.candidate = undefined;
    await expect(hidden.service.createReleaseCandidate(candidate())).rejects.toMatchObject({
      code: 'release_context_not_found',
      statusCode: 404,
    });
    expect(hidden.store.createCalls).toBe(0);
    expect(hidden.git.tags).toEqual([]);

    const prototype = harness();
    prototype.context.candidate = {
      actorRole: 'owner',
      prototypeOnly: true,
      waiverApproved: true,
    };
    await expect(prototype.service.createReleaseCandidate(candidate())).rejects.toMatchObject({
      code: 'prototype_not_deployable',
      statusCode: 409,
    });
    expect(prototype.store.createCalls).toBe(0);
  });

  it('durably passes an explicit specification waiver into the atomic store', async () => {
    const built = harness();
    const specificationWaiver = {
      reason: 'This imported project has no approved product specification.',
      approvedBy: OWNER_ID,
    };

    await built.service.createReleaseCandidate({
      ...candidate(),
      specificationId: null,
      specificationWaiver,
    });

    expect(built.store.waivers).toEqual([specificationWaiver]);
  });

  it('creates an immutable exact-SHA candidate and reconciles an idempotent release tag', async () => {
    const built = harness();

    const first = await built.service.createReleaseCandidate(candidate());
    const replay = await built.service.createReleaseCandidate(candidate());

    expect(first).toEqual({
      id: RELEASE_ID,
      organizationId: ORG,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      commitSha: COMMIT,
      specificationId: SPECIFICATION,
      status: 'candidate',
      evidenceManifestArtifactId: null,
      createdBy: OWNER_ID,
      createdAt: new Date('2026-08-11T15:00:00.000Z'),
    });
    expect(replay).toEqual(first);
    expect(built.store.createCalls).toBe(1);
    expect(built.git.tags).toEqual([
      { projectId: PROJECT, tag: RELEASE_ID, sha: COMMIT },
      { projectId: PROJECT, tag: RELEASE_ID, sha: COMMIT },
    ]);
    expect(Object.keys(first)).not.toContain('updateCommit');
    expect(built.store.audits).toEqual([
      {
        actorId: OWNER_ID,
        action: 'release.created',
        metadata: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          operationKey: OPERATION,
        },
      },
    ]);
  });

  it('enforces the release status transition table without a commit mutation surface', async () => {
    const built = await releaseAt('candidate');

    await expect(
      built.service.transitionStatus({
        organizationId: ORG,
        releaseId: RELEASE_ID,
        to: 'approved',
        operationKey: `op_${'c'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_release_transition', statusCode: 409 });
    expect(built.store.rows.get(RELEASE_ID)?.commitSha).toBe(COMMIT);

    const verifying = await built.service.transitionStatus({
      organizationId: ORG,
      releaseId: RELEASE_ID,
      to: 'verifying',
      operationKey: `op_${'d'.repeat(64)}`,
    });
    expect(verifying.status).toBe('verifying');
    expect(verifying.commitSha).toBe(COMMIT);
  });

  it('replays an exact status-transition operation after a later transition', async () => {
    const built = await releaseAt('candidate');
    const operationKey = `op_${'4'.repeat(64)}`;

    const first = await built.service.transitionStatus({
      organizationId: ORG,
      releaseId: RELEASE_ID,
      to: 'verifying',
      operationKey,
    });
    await built.service.transitionStatus({
      organizationId: ORG,
      releaseId: RELEASE_ID,
      to: 'ready',
      operationKey: `op_${'5'.repeat(64)}`,
    });
    const replay = await built.service.transitionStatus({
      organizationId: ORG,
      releaseId: RELEASE_ID,
      to: 'verifying',
      operationKey,
    });

    expect(replay).toEqual(first);
    expect(built.store.transitionCalls).toBe(2);
  });

  it('re-checks approve_production_deploy and returns 404 across tenants', async () => {
    const denied = await releaseAt('ready');
    denied.context.mayApprove = false;
    await expect(
      denied.service.approve({
        releaseId: RELEASE_ID,
        actor: viewer,
        operationKey: `op_${'e'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', statusCode: 403 });
    expect(denied.store.transitionCalls).toBe(0);

    await expect(
      denied.service.approve({
        releaseId: RELEASE_ID,
        actor: { ...owner, organizationId: 'org_01J00000000000000000000001' },
        operationKey: `op_${'f'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'release_not_found', statusCode: 404 });

    denied.context.mayApprove = true;
    const approved = await denied.service.approve({
      releaseId: RELEASE_ID,
      actor: owner,
      operationKey: `op_${'1'.repeat(64)}`,
    });
    expect(approved.status).toBe('approved');
    expect(approved.commitSha).toBe(COMMIT);
    expect(denied.store.audits.at(-1)).toEqual({
      actorId: OWNER_ID,
      action: 'release.approved',
      metadata: { operationKey: `op_${'1'.repeat(64)}` },
    });
  });

  it('allows a builder only when the organization enables deploy approval', async () => {
    const built = await releaseAt('warnings');
    const builder: Actor = {
      id: 'user_01J00000000000000000000002',
      organizationId: ORG,
    };
    built.context.mayApprove = false;

    await expect(
      built.service.approve({
        releaseId: RELEASE_ID,
        actor: builder,
        operationKey: `op_${'2'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    built.context.mayApprove = true;
    await expect(
      built.service.approve({
        releaseId: RELEASE_ID,
        actor: builder,
        operationKey: `op_${'3'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({ status: 'approved', commitSha: COMMIT });
  });

  it('keyedly persists approved to deploying with the deployment-request audit', async () => {
    const built = await releaseAt('approved');
    const operationKey = `op_${'6'.repeat(64)}`;
    const input = {
      organizationId: ORG,
      releaseId: RELEASE_ID,
      actorId: OWNER_ID,
      operationKey,
      deploymentType: 'first_deploy' as const,
      confirmation: { dataDisposition: null },
    };

    const started = await built.service.beginDeployment(input);
    const replay = await built.service.beginDeployment(input);

    expect(started).toMatchObject({ status: 'deploying', commitSha: COMMIT });
    expect(replay).toEqual(started);
    expect(built.store.transitionCalls).toBe(1);
    expect(built.store.audits.at(-1)).toEqual({
      actorId: OWNER_ID,
      action: 'release.deploy_requested',
      metadata: {
        operationKey,
        deploymentType: 'first_deploy',
        dataDisposition: null,
      },
    });
  });

  it('guards the internal HTTP boundary and maps an unknown commit to 422', async () => {
    const built = harness();
    built.git.commitExists = false;
    const app = Fastify();
    let authorizationChecks = 0;
    registerReleaseRoutes(app, {
      records: built.service,
      requireService: () => {
        authorizationChecks += 1;
        return Promise.resolve();
      },
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/releases',
        headers: { 'idempotency-key': OPERATION },
        payload: candidate(),
      });

      expect(authorizationChecks).toBe(1);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: {
          code: 'commit_not_found',
          message: 'The requested commit does not exist in internal Git.',
        },
      });
      expect(built.store.createCalls).toBe(0);
    } finally {
      await app.close();
    }
  });
});
