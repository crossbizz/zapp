import { CheckpointKindSchema, idSchema } from '@zapp/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const CheckpointIdSchema = z.string().regex(/^ckpt_[a-f0-9]{64}$/u);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const BytesSchema = z.custom<Uint8Array>(
  (value): value is Uint8Array => value instanceof Uint8Array,
);

const ScopeSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br'),
  })
  .strict();

const WorkspaceScopeSchema = ScopeSchema.extend({ workspaceId: idSchema('ws') }).strict();

const UncommittedBundleSchema = z
  .object({ patch: BytesSchema, untrackedTar: BytesSchema })
  .strict();

const EncryptedArtifactSchema = z
  .object({ ciphertext: BytesSchema, keyVersion: z.number().int().positive() })
  .strict();

const ArtifactRefSchema = z
  .object({
    key: z.string().min(1),
    sha256: Sha256Schema,
    keyVersion: z.number().int().positive(),
  })
  .strict();

const SnapshotRefSchema = z
  .object({
    providerSnapshotId: z.string().min(1),
    logicalBytes: z.string().regex(/^\d+$/u),
    expiresAt: z.string().datetime(),
  })
  .strict();

const CheckpointRecordSchema = ScopeSchema.extend({
  checkpointId: CheckpointIdSchema,
  workspaceId: idSchema('ws'),
  operationKey: OperationKeySchema,
  kind: CheckpointKindSchema,
  taskBoundary: z.boolean(),
  includeSnapshot: z.boolean(),
  createdAt: z.string().datetime(),
  artifact: ArtifactRefSchema,
  snapshot: SnapshotRefSchema.nullable(),
}).strict();

export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

const CheckpointInputSchema = WorkspaceScopeSchema.extend({
  operationKey: OperationKeySchema,
  kind: CheckpointKindSchema,
  taskBoundary: z.boolean(),
  includeSnapshot: z.boolean(),
}).strict();

const RestoreInputSchema = ScopeSchema.extend({
  checkpointId: CheckpointIdSchema.optional(),
  targetWorkspaceId: idSchema('ws'),
  operationKey: OperationKeySchema,
}).strict();

const RestoreResultSchema = z
  .object({
    checkpointId: CheckpointIdSchema,
    source: z.enum(['snapshot', 'git_artifact']),
  })
  .strict();

type RestoreResult = z.infer<typeof RestoreResultSchema>;

export type CheckpointClaimResult =
  | { status: 'claimed' }
  | { status: 'conflict' }
  | { status: 'completed'; record: CheckpointRecord };

export type RestoreClaimResult =
  | { status: 'claimed' }
  | { status: 'conflict' }
  | { status: 'completed'; result: RestoreResult };

export interface CheckpointServiceDependencies {
  now(): Date;
  git: {
    commitAndPush(scope: z.infer<typeof WorkspaceScopeSchema>): Promise<void>;
    captureUncommitted(
      scope: z.infer<typeof WorkspaceScopeSchema>,
    ): Promise<z.infer<typeof UncommittedBundleSchema>>;
    clone(scope: z.infer<typeof RestoreInputSchema>): Promise<void>;
    applyUncommitted(
      scope: z.infer<typeof RestoreInputSchema>,
      bundle: z.infer<typeof UncommittedBundleSchema>,
    ): Promise<void>;
  };
  codec: {
    compressZstd(bundle: z.infer<typeof UncommittedBundleSchema>): Promise<Uint8Array>;
    decompressZstd(value: Uint8Array): Promise<z.infer<typeof UncommittedBundleSchema>>;
  };
  crypto: {
    encrypt(
      scope: z.infer<typeof ScopeSchema> & { checkpointId: string },
      plaintext: Uint8Array,
    ): Promise<z.infer<typeof EncryptedArtifactSchema>>;
    decrypt(
      scope: z.infer<typeof ScopeSchema> & { checkpointId: string },
      encrypted: z.infer<typeof EncryptedArtifactSchema>,
    ): Promise<Uint8Array>;
  };
  artifacts: {
    putIfAbsent(input: {
      organizationId: string;
      projectId: string;
      key: string;
      ciphertext: Uint8Array;
      keyVersion: number;
    }): Promise<{ key: string; sha256: string; keyVersion: number }>;
    get(input: {
      organizationId: string;
      projectId: string;
      key: string;
    }): Promise<Uint8Array | undefined>;
  };
  snapshots: {
    create(input: {
      checkpointId: string;
      workspaceId: string;
      organizationId: string;
      projectId: string;
      branchId: string;
      ttlMs: number;
    }): Promise<{ providerSnapshotId: string; logicalBytes: string }>;
    restore(input: {
      providerSnapshotId: string;
      targetWorkspaceId: string;
      organizationId: string;
      projectId: string;
      branchId: string;
    }): Promise<boolean>;
  };
  snapshotMeasurements: {
    record(input: {
      readonly providerSnapshotId: string;
      readonly organizationId: string;
      readonly projectId: string;
      readonly logicalBytes: string;
      readonly kind: z.infer<typeof CheckpointKindSchema>;
      readonly createdAt: string;
      readonly expiresAt: string;
    }): Promise<void>;
  };
  records: {
    findByOperationKey(input: {
      organizationId: string;
      projectId: string;
      operationKey: string;
    }): Promise<CheckpointRecord | undefined>;
    claimCheckpoint(input: {
      checkpointId: string;
      organizationId: string;
      projectId: string;
      branchId: string;
      workspaceId: string;
      operationKey: string;
      kind: z.infer<typeof CheckpointKindSchema>;
      taskBoundary: boolean;
      includeSnapshot: boolean;
    }): Promise<CheckpointClaimResult>;
    save(record: CheckpointRecord): Promise<CheckpointRecord>;
    resolve(input: {
      organizationId: string;
      projectId: string;
      branchId: string;
      checkpointId?: string;
    }): Promise<CheckpointRecord | undefined>;
    claimRestore(input: {
      checkpointId: string;
      organizationId: string;
      projectId: string;
      branchId: string;
      targetWorkspaceId: string;
      operationKey: string;
    }): Promise<RestoreClaimResult>;
    completeRestore(input: {
      checkpointId: string;
      organizationId: string;
      projectId: string;
      branchId: string;
      targetWorkspaceId: string;
      operationKey: string;
      result: RestoreResult;
    }): Promise<void>;
  };
}

export class CheckpointNotFoundError extends Error {
  public constructor() {
    super('Checkpoint not found');
    this.name = 'CheckpointNotFoundError';
  }
}

export class CheckpointConflictError extends Error {
  public constructor() {
    super('Checkpoint operation key was already used with different input');
    this.name = 'CheckpointConflictError';
  }
}

function checkpointIdFor(input: z.infer<typeof CheckpointInputSchema>): string {
  return `ckpt_${createHash('sha256')
    .update(
      `${input.organizationId}:${input.projectId}:${input.branchId}:${input.operationKey}`,
    )
    .digest('hex')}`;
}

function artifactKeyFor(record: Pick<CheckpointRecord, 'organizationId' | 'projectId' | 'branchId' | 'checkpointId'>): string {
  return [
    'checkpoints',
    record.organizationId,
    record.projectId,
    record.branchId,
    `${record.checkpointId}.zst.enc`,
  ].join('/');
}

function snapshotTtlMs(kind: z.infer<typeof CheckpointKindSchema>): number {
  return kind === 'diagnostic' ? 7 * DAY_MS : 30 * DAY_MS;
}

function matchesScope(
  record: CheckpointRecord,
  scope: z.infer<typeof ScopeSchema>,
): boolean {
  return (
    record.organizationId === scope.organizationId &&
    record.projectId === scope.projectId &&
    record.branchId === scope.branchId
  );
}

export function createCheckpointService(dependencies: CheckpointServiceDependencies): {
  checkpoint(input: unknown): Promise<CheckpointRecord>;
  restore(input: unknown): Promise<z.infer<typeof RestoreResultSchema>>;
} {
  return {
    async checkpoint(untrustedInput) {
      const input = CheckpointInputSchema.parse(untrustedInput);
      const existing = await dependencies.records.findByOperationKey({
        organizationId: input.organizationId,
        projectId: input.projectId,
        operationKey: input.operationKey,
      });
      if (existing !== undefined) {
        const parsed = CheckpointRecordSchema.parse(existing);
        if (
          !matchesScope(parsed, input) ||
          parsed.workspaceId !== input.workspaceId ||
          parsed.kind !== input.kind ||
          parsed.taskBoundary !== input.taskBoundary ||
          parsed.includeSnapshot !== input.includeSnapshot
        ) {
          throw new CheckpointConflictError();
        }
        return parsed;
      }

      const checkpointId = CheckpointIdSchema.parse(checkpointIdFor(input));
      const claim = await dependencies.records.claimCheckpoint({
        checkpointId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        workspaceId: input.workspaceId,
        operationKey: input.operationKey,
        kind: input.kind,
        taskBoundary: input.taskBoundary,
        includeSnapshot: input.includeSnapshot,
      });
      if (claim.status === 'conflict') throw new CheckpointConflictError();
      if (claim.status === 'completed') {
        const parsed = CheckpointRecordSchema.parse(claim.record);
        if (
          !matchesScope(parsed, input) ||
          parsed.workspaceId !== input.workspaceId ||
          parsed.kind !== input.kind ||
          parsed.taskBoundary !== input.taskBoundary ||
          parsed.includeSnapshot !== input.includeSnapshot
        ) {
          throw new CheckpointConflictError();
        }
        return parsed;
      }
      const scope = WorkspaceScopeSchema.parse({
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        workspaceId: input.workspaceId,
      });
      if (input.taskBoundary) await dependencies.git.commitAndPush(scope);
      const bundle = UncommittedBundleSchema.parse(
        await dependencies.git.captureUncommitted(scope),
      );
      const compressed = BytesSchema.parse(await dependencies.codec.compressZstd(bundle));
      const tenantScope = ScopeSchema.parse({
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
      });
      const encrypted = EncryptedArtifactSchema.parse(
        await dependencies.crypto.encrypt(
          { ...tenantScope, checkpointId },
          compressed,
        ),
      );
      const key = artifactKeyFor({ ...input, checkpointId });
      const receipt = z
        .object({
          key: z.literal(key),
          sha256: Sha256Schema,
          keyVersion: z.number().int().positive(),
        })
        .strict()
        .parse(
          await dependencies.artifacts.putIfAbsent({
            organizationId: input.organizationId,
            projectId: input.projectId,
            key,
            ciphertext: encrypted.ciphertext,
            keyVersion: encrypted.keyVersion,
          }),
        );
      const createdAt = z.date().parse(dependencies.now());
      const ttlMs = snapshotTtlMs(input.kind);
      let snapshot: z.infer<typeof SnapshotRefSchema> | null = null;
      if (input.includeSnapshot) {
        let createdSnapshot: unknown;
        try {
          createdSnapshot = await dependencies.snapshots.create({
              checkpointId,
              workspaceId: input.workspaceId,
              organizationId: input.organizationId,
              projectId: input.projectId,
              branchId: input.branchId,
              ttlMs,
          });
        } catch {
          createdSnapshot = undefined;
        }
        if (createdSnapshot !== undefined) {
          snapshot = SnapshotRefSchema.parse({
            ...z.object({ providerSnapshotId: z.string(), logicalBytes: z.string() })
              .passthrough()
              .parse(createdSnapshot),
            expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
          });
          await dependencies.snapshotMeasurements.record({
            providerSnapshotId: snapshot.providerSnapshotId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            logicalBytes: snapshot.logicalBytes,
            kind: input.kind,
            createdAt: createdAt.toISOString(),
            expiresAt: snapshot.expiresAt,
          });
        }
      }
      const record = CheckpointRecordSchema.parse({
        checkpointId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        workspaceId: input.workspaceId,
        operationKey: input.operationKey,
        kind: input.kind,
        taskBoundary: input.taskBoundary,
        includeSnapshot: input.includeSnapshot,
        createdAt: createdAt.toISOString(),
        artifact: receipt,
        snapshot,
      });
      return CheckpointRecordSchema.parse(await dependencies.records.save(record));
    },

    async restore(untrustedInput) {
      const input = RestoreInputSchema.parse(untrustedInput);
      const resolved = await dependencies.records.resolve({
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
      });
      if (resolved === undefined) throw new CheckpointNotFoundError();
      const record = CheckpointRecordSchema.parse(resolved);
      if (!matchesScope(record, input)) throw new CheckpointNotFoundError();
      if (input.checkpointId !== undefined && record.checkpointId !== input.checkpointId) {
        throw new CheckpointNotFoundError();
      }

      const restoreClaimInput = {
        checkpointId: record.checkpointId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        branchId: input.branchId,
        targetWorkspaceId: input.targetWorkspaceId,
        operationKey: input.operationKey,
      };
      const restoreClaim = await dependencies.records.claimRestore(restoreClaimInput);
      if (restoreClaim.status === 'conflict') throw new CheckpointConflictError();
      if (restoreClaim.status === 'completed') {
        return RestoreResultSchema.parse(restoreClaim.result);
      }

      const now = z.date().parse(dependencies.now()).getTime();
      if (record.snapshot !== null && Date.parse(record.snapshot.expiresAt) > now) {
        let restored = false;
        try {
          restored = await dependencies.snapshots.restore({
            providerSnapshotId: record.snapshot.providerSnapshotId,
            targetWorkspaceId: input.targetWorkspaceId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            branchId: input.branchId,
          });
        } catch {
          restored = false;
        }
        if (restored) {
          const result = RestoreResultSchema.parse({
            checkpointId: record.checkpointId,
            source: 'snapshot',
          });
          await dependencies.records.completeRestore({ ...restoreClaimInput, result });
          return result;
        }
      }

      const expectedKey = artifactKeyFor(record);
      if (record.artifact.key !== expectedKey) throw new CheckpointNotFoundError();
      const ciphertext = await dependencies.artifacts.get({
        organizationId: input.organizationId,
        projectId: input.projectId,
        key: expectedKey,
      });
      if (ciphertext === undefined) throw new CheckpointNotFoundError();
      if (createHash('sha256').update(ciphertext).digest('hex') !== record.artifact.sha256) {
        throw new Error('Checkpoint artifact integrity check failed');
      }
      const plaintext = BytesSchema.parse(
        await dependencies.crypto.decrypt(
          {
            organizationId: input.organizationId,
            projectId: input.projectId,
            branchId: input.branchId,
            checkpointId: record.checkpointId,
          },
          { ciphertext, keyVersion: record.artifact.keyVersion },
        ),
      );
      const bundle = UncommittedBundleSchema.parse(
        await dependencies.codec.decompressZstd(plaintext),
      );
      await dependencies.git.clone(input);
      await dependencies.git.applyUncommitted(input, bundle);
      const result = RestoreResultSchema.parse({
        checkpointId: record.checkpointId,
        source: 'git_artifact',
      });
      await dependencies.records.completeRestore({ ...restoreClaimInput, result });
      return result;
    },
  };
}
