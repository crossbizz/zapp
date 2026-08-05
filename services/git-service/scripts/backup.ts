import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { idSchema, internalRepoRef, parseInternalRepoRef } from '@zapp/contracts';
import { createDb, type Db } from '@zapp/db';
import { z } from 'zod';

import {
  BackupDateSchema,
  BackupRepositorySchema,
  createDbBackupInventory,
  createGitBundleCommands,
  createR2BackupObjectStore,
  RestoreRepositoryResultSchema,
  RESTORE_CREDENTIAL_SAFETY_MARGIN_MS,
  restoreRepositoryBackup,
  runNightlyBackups,
  selectRestoreDrillBackup,
  type BackupGit,
  type BackupInventory,
  type BackupObjectStore,
  type NightlyBackupReport,
  type RestoreBackupInspectionGit,
  type RestorePhase,
  type RestoreRemoteGit,
  type RestoreRepositoryResult,
} from '../src/backup.js';
import { createDbGitAuditSink } from '../src/audit.js';
import {
  loadArtifactEnv,
  loadDatabaseUrl,
  loadForgejoEnv,
  loadGitCommandDeadlineEnv,
  MAX_FORGEJO_TIMEOUT_MS,
} from '../src/env.js';
import { createForgejoClient, type ForgejoClient } from '../src/forgejo/client.js';
import { createTokenService, DEFAULT_TOKEN_TTL_SECONDS, type TokenService } from '../src/tokens.js';

const RestoreIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

function isExactBackupKey(organizationId: string, projectId: string, key: string): boolean {
  const prefix = `org/${organizationId}/project/${projectId}/git-backups/`;
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  const date = suffix.endsWith('.bundle') ? suffix.slice(0, -'.bundle'.length) : '';
  return BackupDateSchema.safeParse(date).success && key === `${prefix}${date}.bundle`;
}

const RestoreSelectorSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    key: z.string().min(1),
    idempotencyKey: RestoreIdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!isExactBackupKey(value.organizationId, value.projectId, value.key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid backup key' });
    }
  });

export type RestoreSelector = z.infer<typeof RestoreSelectorSchema>;

const BackupActionSchema = z.enum(['nightly', 'restore', 'restore-drill']);

export interface BackupCliProcess {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: { write(message: string): unknown };
  readonly stderr: { write(message: string): unknown };
  exitCode?: string | number | null | undefined;
}

type RestoreResult = {
  readonly status: 'restored';
  readonly organizationId: string;
  readonly projectId: string;
} & RestoreRepositoryResult;

type RestoreDrillResult = {
  readonly status: 'restore-drill-verified';
  readonly projectId: string;
} & RestoreRepositoryResult;

export interface BackupCliOperations {
  nightly(): Promise<NightlyBackupReport>;
  restore(selector: RestoreSelector): Promise<RestoreResult>;
  restoreDrill(): Promise<RestoreDrillResult>;
  close(): Promise<void>;
}

export interface RestoreDrillLease {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

const RESTORE_DRILL_ADVISORY_LOCK_NAMESPACE = 0x5a415050;
const RESTORE_DRILL_ADVISORY_LOCK_KEY = 0x47495434;

export function createPostgresRestoreDrillLease(
  sql: Pick<Db['sql'], 'reserve'>,
): RestoreDrillLease {
  return {
    runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
      const session = await sql.reserve();
      let acquired = false;
      try {
        const rows = await session`
          SELECT pg_try_advisory_lock(
            ${RESTORE_DRILL_ADVISORY_LOCK_NAMESPACE},
            ${RESTORE_DRILL_ADVISORY_LOCK_KEY}
          ) AS acquired
        `;
        const result = z
          .array(z.object({ acquired: z.boolean() }).passthrough())
          .length(1)
          .safeParse(rows);
        if (!result.success || !result.data[0]?.acquired) {
          throw new Error('Restore drill is already in progress');
        }
        acquired = true;
        return await operation();
      } finally {
        try {
          if (acquired) {
            await session`
              SELECT pg_advisory_unlock(
                ${RESTORE_DRILL_ADVISORY_LOCK_NAMESPACE},
                ${RESTORE_DRILL_ADVISORY_LOCK_KEY}
              ) AS released
            `;
          }
        } finally {
          session.release();
        }
      }
    },
  };
}

const ForgejoRestoreRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    clone_url: z.string().min(1),
    description: z.string(),
    empty: z.boolean(),
  })
  .passthrough();

type ForgejoRestoreRepository = z.infer<typeof ForgejoRestoreRepositorySchema>;

const RestoreOperationInputSchema = z
  .object({
    kind: z.enum(['manual', 'drill']),
    idempotencyKey: RestoreIdempotencyKeySchema,
    source: BackupRepositorySchema,
    backupKey: z.string().min(1),
    targetMode: z.enum(['persistent', 'empty']).default('persistent'),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isExactBackupKey(value.source.organizationId, value.source.projectId, value.backupKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid backup key' });
    }
  });

const RestoreIntentSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['manual', 'drill']),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    sourceOrganizationId: idSchema('org'),
    sourceProjectId: idSchema('proj'),
    backupKey: z.string().min(1),
    targetOrganizationId: idSchema('org'),
    targetProjectId: idSchema('proj'),
    targetReceiptKey: z.string().min(1),
    targetMarker: z.string().min(1).max(255),
    defaultBranch: z.string().min(1).max(255),
  })
  .strict();

type RestoreIntent = z.infer<typeof RestoreIntentSchema>;

const RestoreTargetReceiptSchema = z
  .object({
    version: z.literal(1),
    targetRef: z.string().min(1),
    repositoryId: z.number().int().positive(),
    targetMarker: z.string().min(1).max(255),
  })
  .strict();

type RestoreTargetReceipt = z.infer<typeof RestoreTargetReceiptSchema>;

const RestoreCredentialAllocationSchema = z
  .object({
    version: z.literal(1),
    intentKey: z.string().min(1),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    targetRef: z.string().min(1),
    repositoryId: z.number().int().positive(),
    generation: z.number().int().positive(),
    username: z.string().regex(/^zt-\d{10,12}-[0-9a-f]{12}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();

type RestoreCredentialAllocation = z.infer<typeof RestoreCredentialAllocationSchema>;

const RestoreCredentialReleaseSchema = z
  .object({
    version: z.literal(1),
    allocationKey: z.string().min(1),
    allocationDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const RestoreCredentialCreatedSchema = RestoreCredentialReleaseSchema;

const RestoreVerificationFenceSchema = z
  .object({
    version: z.literal(1),
    intentKey: z.string().min(1),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    backupKey: z.string().min(1),
    targetRef: z.string().min(1),
    repositoryId: z.number().int().positive(),
    resultDigest: z.string().regex(/^[0-9a-f]{64}$/),
    result: RestoreRepositoryResultSchema,
  })
  .strict();

type RestoreVerificationFence = z.infer<typeof RestoreVerificationFenceSchema>;

export interface ResolvedForgejoRestoreTarget {
  readonly repositoryId: number;
  readonly cloneUrl: string;
}

export interface RestoreOperation {
  readonly intentKey: string;
  readonly targetRef: string;
  readonly completedResult?: RestoreRepositoryResult;
  resolveTarget(): Promise<ResolvedForgejoRestoreTarget>;
  reserveCredentialCleanup(identity: {
    readonly username: string;
    readonly expiresAt: Date;
  }): Promise<RestoreCredentialAllocation>;
  recordCredentialCreated(allocation: RestoreCredentialAllocation): Promise<void>;
  completeCredentialCleanup(allocation: RestoreCredentialAllocation): Promise<void>;
  recordPhase(phase: RestorePhase, result?: RestoreRepositoryResult): Promise<void>;
}

export interface RestoreCredentialIssuer {
  issue(input: {
    readonly sourceOrganizationId: string;
    readonly sourceProjectId: string;
    readonly targetRef: string;
    readonly repositoryId: number;
    readonly cloneUrl: string;
    reserveCredentialCleanup(identity: {
      readonly username: string;
      readonly expiresAt: Date;
    }): Promise<RestoreCredentialAllocation>;
    recordCredentialCreated(allocation: RestoreCredentialAllocation): Promise<void>;
    completeCredentialCleanup(allocation: RestoreCredentialAllocation): Promise<void>;
  }): Promise<{
    readonly cloneUrl: string;
    readonly git: RestoreRemoteGit;
    readonly expiresAt: Date;
    readonly deadlineAt: Date;
    release(): Promise<void>;
  }>;
}

export function createForgejoRestoreCredentialIssuer(
  client: ForgejoClient,
  tokens: Pick<TokenService, 'mintForRepository'>,
  commandDeadlineMs: number,
  options: { readonly now?: () => Date } = {},
): RestoreCredentialIssuer {
  if (
    !Number.isInteger(commandDeadlineMs) ||
    commandDeadlineMs < 100 ||
    commandDeadlineMs >= DEFAULT_TOKEN_TTL_SECONDS * 1_000
  ) {
    throw new Error('Invalid restore command deadline');
  }
  const now = options.now ?? ((): Date => new Date());
  return {
    issue: async (input) => {
      let allocation: RestoreCredentialAllocation | undefined;
      try {
        const minted = await tokens.mintForRepository({
          organizationId: input.sourceOrganizationId,
          projectId: input.sourceProjectId,
          targetRef: input.targetRef,
          expectedRepositoryId: input.repositoryId,
          access: 'write',
          requestingService: 'git-service',
          reason: 'restore a verified Git bundle into its receipt-owned target',
          onIdentityAllocated: async (identity) => {
            allocation = await input.reserveCredentialCleanup(identity);
          },
          onIdentityCreated: async (identity) => {
            const reserved = allocation;
            if (
              reserved === undefined ||
              reserved.username !== identity.username ||
              reserved.expiresAt !== identity.expiresAt.toISOString()
            ) {
              throw new Error('Restore credential creation has no durable allocation');
            }
            await input.recordCredentialCreated(reserved);
          },
        });
        const reservedAllocation = allocation;
        if (
          reservedAllocation === undefined ||
          reservedAllocation.username !== minted.username ||
          reservedAllocation.expiresAt !== minted.expiresAt.toISOString()
        ) {
          throw new Error('Restore credential cleanup identity was not durably reserved');
        }
        const expiresAtMs = minted.expiresAt.getTime();
        const issuedAtMs = now().getTime();
        const deadlineAtMs = Math.min(
          issuedAtMs + commandDeadlineMs,
          expiresAtMs - RESTORE_CREDENTIAL_SAFETY_MARGIN_MS,
        );
        if (
          !Number.isFinite(expiresAtMs) ||
          !Number.isFinite(issuedAtMs) ||
          deadlineAtMs <= issuedAtMs
        ) {
          throw new Error('Restore credential expires before its command window');
        }
        return {
          cloneUrl: minted.cloneUrl,
          git: createGitBundleCommands({
            username: minted.username,
            password: minted.token,
            timeoutMs: commandDeadlineMs,
          }),
          expiresAt: new Date(expiresAtMs),
          deadlineAt: new Date(deadlineAtMs),
          release: async () => {
            await client.send({
              method: 'DELETE',
              path: `/admin/users/${encodeURIComponent(minted.username)}?purge=true`,
              allow: [404],
            });
            await input.completeCredentialCleanup(reservedAllocation);
          },
        };
      } catch (error) {
        if (allocation !== undefined) {
          try {
            await client.send({
              method: 'DELETE',
              path: `/admin/users/${encodeURIComponent(allocation.username)}?purge=true`,
              allow: [404],
            });
          } catch {
            // The durable allocation (and created receipt, if one was written)
            // remains pending. Replay retries deletion before it can verify.
          }
        }
        throw error;
      }
    },
  };
}

const RestorePhaseReceiptSchema = z
  .object({
    version: z.literal(1),
    intentKey: z.string().min(1),
    operationId: z.string().regex(/^[0-9a-f]{64}$/),
    backupKey: z.string().min(1),
    repositoryId: z.number().int().positive(),
    phase: z.enum(['push-started', 'push-complete', 'verified']),
    resultDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    result: RestoreRepositoryResultSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.phase === 'verified' &&
      (value.result === undefined || value.resultDigest === undefined)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'verified result is required' });
    }
    if (
      value.phase !== 'verified' &&
      (value.result !== undefined || value.resultDigest !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'result is only valid when verified',
      });
    }
  });

async function readSmallJson(store: BackupObjectStore, key: string): Promise<unknown> {
  const stream = await store.get(key);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 16_384) {
      throw new Error('Restore receipt is invalid');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Restore receipt is invalid');
  }
}

async function putExactJson(
  store: BackupObjectStore,
  key: string,
  value: unknown,
  conflictMessage = 'Restore idempotency key conflicts with a different selector',
): Promise<void> {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json, 'utf8');
  await store.put(key, {
    contentLength: bytes.length,
    contentType: 'application/json',
    open: () => Readable.from(bytes),
  });
  if (JSON.stringify(await readSmallJson(store, key)) !== json) {
    throw new Error(conflictMessage);
  }
}

function credentialReceiptPrefix(intentKey: string): string {
  return intentKey.replace(/\.json$/, '.credentials/');
}

function verificationFenceKey(intentKey: string): string {
  return intentKey.replace(/\.json$/, '.verification-fence.json');
}

function credentialAllocationKey(prefix: string, generation: number): string {
  return `${prefix}${String(generation).padStart(8, '0')}.allocated.json`;
}

function credentialReleaseKey(prefix: string, generation: number): string {
  return `${prefix}${String(generation).padStart(8, '0')}.released.json`;
}

function credentialCreatedKey(prefix: string, generation: number): string {
  return `${prefix}${String(generation).padStart(8, '0')}.created.json`;
}

function jsonDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function listCredentialReceiptKeys(
  store: BackupObjectStore,
  prefix: string,
): Promise<readonly string[]> {
  const keys: string[] = [];
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;
  for (;;) {
    const page = await store.list(prefix, continuationToken);
    const parsed = z
      .object({
        objects: z.array(z.object({ key: z.string().min(1), lastModified: z.date() }).strict()),
        continuationToken: z.string().min(1).optional(),
      })
      .strict()
      .safeParse(page);
    if (!parsed.success || parsed.data.objects.some((object) => !object.key.startsWith(prefix))) {
      throw new Error('Restore credential receipt listing is invalid');
    }
    keys.push(...parsed.data.objects.map((object) => object.key));
    const next = parsed.data.continuationToken;
    if (next === undefined) {
      return keys;
    }
    if (seenTokens.has(next)) {
      throw new Error('Restore credential receipt pagination did not advance');
    }
    seenTokens.add(next);
    continuationToken = next;
  }
}

async function readCredentialCleanupState(
  store: BackupObjectStore,
  intentKey: string,
  intent: RestoreIntent,
  targetRef: string,
): Promise<{
  readonly allocations: readonly {
    readonly key: string;
    readonly releaseKey: string;
    readonly createdKey: string;
    readonly allocation: RestoreCredentialAllocation;
    readonly created: boolean;
    readonly released: boolean;
  }[];
  readonly nextGeneration: number;
}> {
  const prefix = credentialReceiptPrefix(intentKey);
  const keys = await listCredentialReceiptKeys(store, prefix);
  const allocationKeys = new Map<number, string>();
  const createdKeys = new Map<number, string>();
  const releaseKeys = new Map<number, string>();
  for (const key of keys) {
    const suffix = key.slice(prefix.length);
    const match = /^(\d{8})\.(allocated|created|released)\.json$/.exec(suffix);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error('Restore credential receipt key is invalid');
    }
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error('Restore credential receipt key is invalid');
    }
    const collection =
      match[2] === 'allocated'
        ? allocationKeys
        : match[2] === 'created'
          ? createdKeys
          : releaseKeys;
    if (collection.has(generation)) {
      throw new Error('Restore credential receipt generation is duplicated');
    }
    collection.set(generation, key);
  }
  if ([...releaseKeys.keys()].some((generation) => !allocationKeys.has(generation))) {
    throw new Error('Restore credential release has no allocation');
  }
  if ([...createdKeys.keys()].some((generation) => !allocationKeys.has(generation))) {
    throw new Error('Restore credential creation has no allocation');
  }

  const allocations: {
    key: string;
    releaseKey: string;
    createdKey: string;
    allocation: RestoreCredentialAllocation;
    created: boolean;
    released: boolean;
  }[] = [];
  for (const [generation, key] of [...allocationKeys].sort(([left], [right]) => left - right)) {
    const parsed = RestoreCredentialAllocationSchema.safeParse(await readSmallJson(store, key));
    if (
      !parsed.success ||
      parsed.data.intentKey !== intentKey ||
      parsed.data.operationId !== intent.operationId ||
      parsed.data.targetRef !== targetRef ||
      parsed.data.generation !== generation
    ) {
      throw new Error('Restore credential allocation receipt is invalid');
    }
    const releaseKey = credentialReleaseKey(prefix, generation);
    const createdKey = credentialCreatedKey(prefix, generation);
    const created = createdKeys.has(generation);
    if (created) {
      const creation = RestoreCredentialCreatedSchema.safeParse(
        await readSmallJson(store, createdKey),
      );
      if (
        !creation.success ||
        creation.data.allocationKey !== key ||
        creation.data.allocationDigest !== jsonDigest(parsed.data)
      ) {
        throw new Error('Restore credential creation receipt is invalid');
      }
    }
    const released = releaseKeys.has(generation);
    if (released) {
      const release = RestoreCredentialReleaseSchema.safeParse(
        await readSmallJson(store, releaseKey),
      );
      if (
        !release.success ||
        release.data.allocationKey !== key ||
        release.data.allocationDigest !== jsonDigest(parsed.data)
      ) {
        throw new Error('Restore credential release receipt is invalid');
      }
    }
    allocations.push({
      key,
      releaseKey,
      createdKey,
      allocation: parsed.data,
      created,
      released,
    });
  }

  const lastGeneration = allocations.at(-1)?.allocation.generation ?? 0;
  if (lastGeneration >= 99_999_999) {
    throw new Error('Restore credential receipt generations are exhausted');
  }
  return { allocations, nextGeneration: lastGeneration + 1 };
}

async function readTargetReceipt(
  store: BackupObjectStore,
  key: string,
): Promise<RestoreTargetReceipt> {
  const parsed = RestoreTargetReceiptSchema.safeParse(await readSmallJson(store, key));
  if (!parsed.success) {
    throw new Error('Restore target receipt is invalid');
  }
  return parsed.data;
}

async function readVerificationFence(
  store: BackupObjectStore,
  intentKey: string,
  intent: RestoreIntent,
  targetRef: string,
): Promise<RestoreVerificationFence | undefined> {
  const fenceKey = verificationFenceKey(intentKey);
  if (!(await store.exists(fenceKey))) {
    return undefined;
  }
  const parsed = RestoreVerificationFenceSchema.safeParse(await readSmallJson(store, fenceKey));
  if (
    !parsed.success ||
    parsed.data.intentKey !== intentKey ||
    parsed.data.operationId !== intent.operationId ||
    parsed.data.backupKey !== intent.backupKey ||
    parsed.data.targetRef !== targetRef ||
    parsed.data.resultDigest !== jsonDigest(parsed.data.result)
  ) {
    throw new Error('Restore verification fence is invalid');
  }
  if (!(await store.exists(intent.targetReceiptKey))) {
    throw new Error('Restore verification fence has no immutable target receipt');
  }
  const targetReceipt = await readTargetReceipt(store, intent.targetReceiptKey);
  if (
    targetReceipt.targetRef !== targetRef ||
    targetReceipt.repositoryId !== parsed.data.repositoryId ||
    targetReceipt.targetMarker !== intent.targetMarker
  ) {
    throw new Error('Restore verification fence does not match the immutable target receipt');
  }
  return parsed.data;
}

async function readCompletedRestoreResult(
  store: BackupObjectStore,
  intentKey: string,
  intent: RestoreIntent,
  targetRef: string,
): Promise<RestoreRepositoryResult | undefined> {
  const verifiedKey = intentKey.replace(/\.json$/, '.verified.json');
  if (!(await store.exists(verifiedKey))) {
    return undefined;
  }
  const fence = await readVerificationFence(store, intentKey, intent, targetRef);
  if (fence === undefined) {
    throw new Error('Restore verified receipt has no verification fence');
  }
  const parsed = RestorePhaseReceiptSchema.safeParse(await readSmallJson(store, verifiedKey));
  if (
    !parsed.success ||
    parsed.data.phase !== 'verified' ||
    parsed.data.intentKey !== intentKey ||
    parsed.data.operationId !== intent.operationId ||
    parsed.data.backupKey !== intent.backupKey ||
    parsed.data.result === undefined ||
    parsed.data.resultDigest !==
      createHash('sha256').update(JSON.stringify(parsed.data.result)).digest('hex') ||
    parsed.data.repositoryId !== fence.repositoryId ||
    parsed.data.resultDigest !== fence.resultDigest ||
    JSON.stringify(parsed.data.result) !== JSON.stringify(fence.result)
  ) {
    throw new Error('Restore verified receipt is invalid');
  }
  if (!(await store.exists(intent.targetReceiptKey))) {
    throw new Error('Restore verified receipt has no immutable target receipt');
  }
  const targetReceipt = await readTargetReceipt(store, intent.targetReceiptKey);
  if (
    targetReceipt.targetRef !== targetRef ||
    targetReceipt.repositoryId !== parsed.data.repositoryId ||
    targetReceipt.targetMarker !== intent.targetMarker
  ) {
    throw new Error('Restore verified receipt does not match the immutable target receipt');
  }
  return parsed.data.result;
}

async function ensureRestoreOrganization(client: ForgejoClient, owner: string): Promise<void> {
  const organization = await client.send({
    method: 'GET',
    path: `/orgs/${encodeURIComponent(owner)}`,
    allow: [404],
  });
  if (organization.status === 404) {
    await client.send({
      method: 'POST',
      path: '/orgs',
      body: {
        username: owner,
        visibility: 'private',
        description: 'zapp.build tenant',
      },
      allow: [409, 422],
    });
  }
}

async function resolveIntentTarget(
  deps: { readonly store: BackupObjectStore; readonly client: ForgejoClient },
  intentKey: string,
  intent: RestoreIntent,
): Promise<ResolvedForgejoRestoreTarget> {
  const targetRef = internalRepoRef({
    organizationId: intent.targetOrganizationId,
    projectId: intent.targetProjectId,
  });
  const { owner, name } = parseInternalRepoRef(targetRef);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const targetReceiptKey = intent.targetReceiptKey;
  await ensureRestoreOrganization(deps.client, owner);

  const hasReceipt = await deps.store.exists(targetReceiptKey);
  const receipt = hasReceipt ? await readTargetReceipt(deps.store, targetReceiptKey) : undefined;
  let response = await deps.client.send<ForgejoRestoreRepository>({
    method: 'GET',
    path: repositoryPath,
    allow: [404],
  });
  if (response.status === 404) {
    if (receipt !== undefined) {
      throw new Error('Restore target ownership was lost; absent target preserved');
    }
    const created = await deps.client.send<ForgejoRestoreRepository>({
      method: 'POST',
      path: `/orgs/${encodeURIComponent(owner)}/repos`,
      body: {
        name,
        private: true,
        auto_init: false,
        default_branch: intent.defaultBranch,
        description: intent.targetMarker,
      },
      allow: [409],
    });
    if (created.status === 409) {
      throw new Error('Restore target has no immutable repository receipt; repository preserved');
    }
    response = created;
  } else if (receipt === undefined) {
    throw new Error('Restore target has no immutable repository receipt; repository preserved');
  }

  const repository = ForgejoRestoreRepositorySchema.safeParse(response.body);
  if (
    response.status === 404 ||
    !repository.success ||
    repository.data.description !== intent.targetMarker
  ) {
    throw new Error('Restore target does not match the durable intent; repository preserved');
  }
  if (
    receipt !== undefined &&
    (receipt.targetRef !== targetRef ||
      receipt.repositoryId !== repository.data.id ||
      receipt.targetMarker !== intent.targetMarker)
  ) {
    throw new Error('Restore target ownership was lost; replacement preserved');
  }

  const expectedReceipt = RestoreTargetReceiptSchema.parse({
    version: 1,
    targetRef,
    repositoryId: repository.data.id,
    targetMarker: intent.targetMarker,
  });
  await putExactJson(
    deps.store,
    targetReceiptKey,
    expectedReceipt,
    'Restore target receipt conflicts with the live repository',
  );

  const currentResponse = await deps.client.send<ForgejoRestoreRepository>({
    method: 'GET',
    path: repositoryPath,
    allow: [404],
  });
  const current = ForgejoRestoreRepositorySchema.safeParse(currentResponse.body);
  if (
    currentResponse.status === 404 ||
    !current.success ||
    current.data.id !== expectedReceipt.repositoryId ||
    current.data.description !== expectedReceipt.targetMarker
  ) {
    throw new Error('Restore target ownership was lost; replacement preserved');
  }
  return { repositoryId: current.data.id, cloneUrl: current.data.clone_url };
}

export async function beginRestoreOperation(
  deps: {
    readonly store: BackupObjectStore;
    readonly client: ForgejoClient;
    readonly now?: () => Date;
  },
  input: z.input<typeof RestoreOperationInputSchema>,
): Promise<RestoreOperation> {
  const parsed = RestoreOperationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid restore operation');
  }
  const operationId = createHash('sha256')
    .update(`${parsed.data.kind}\0${parsed.data.idempotencyKey}`)
    .digest('hex');
  const intentKey = `git-restore-intents/${parsed.data.kind}/${operationId}.json`;
  const persistentDrillTargetSeed = `org/${parsed.data.source.organizationId}/project/${parsed.data.source.projectId}/git-restore-drill-target/v1`;
  const drillTargetSeed =
    parsed.data.targetMode === 'empty'
      ? `${persistentDrillTargetSeed}/empty-repository`
      : persistentDrillTargetSeed;
  const drillTargetDigest = createHash('sha256').update(drillTargetSeed).digest('hex');
  const targetOrganizationId =
    parsed.data.kind === 'drill'
      ? deterministicId('org', `organization:${drillTargetSeed}`)
      : parsed.data.source.organizationId;
  const targetProjectId =
    parsed.data.kind === 'drill'
      ? deterministicId('proj', `project:${drillTargetSeed}`)
      : parsed.data.source.projectId;
  const targetReceiptKey =
    parsed.data.kind === 'drill'
      ? `git-restore-targets/drill/${drillTargetDigest}.json`
      : intentKey.replace(/\.json$/, '.target.json');
  const intent = RestoreIntentSchema.parse({
    version: 1,
    kind: parsed.data.kind,
    operationId,
    sourceOrganizationId: parsed.data.source.organizationId,
    sourceProjectId: parsed.data.source.projectId,
    backupKey: parsed.data.backupKey,
    targetOrganizationId,
    targetProjectId,
    targetReceiptKey,
    targetMarker:
      parsed.data.kind === 'drill'
        ? `zapp.build restore drill ${drillTargetDigest.slice(0, 32)}`
        : `zapp.build restore manual ${operationId.slice(0, 32)}`,
    defaultBranch: parsed.data.source.defaultBranch,
  });
  await putExactJson(deps.store, intentKey, intent);
  const targetRef = internalRepoRef({
    organizationId: targetOrganizationId,
    projectId: targetProjectId,
  });
  let resolvedTarget: ResolvedForgejoRestoreTarget | undefined;
  const now = deps.now ?? ((): Date => new Date());
  const fenceKey = verificationFenceKey(intentKey);

  const credentialBinding = (allocation: RestoreCredentialAllocation) => {
    const prefix = credentialReceiptPrefix(intentKey);
    const allocationKey = credentialAllocationKey(prefix, allocation.generation);
    return {
      prefix,
      allocationKey,
      binding: {
        version: 1 as const,
        allocationKey,
        allocationDigest: jsonDigest(allocation),
      },
    };
  };

  const completeCredentialCleanup = async (
    allocationInput: RestoreCredentialAllocation,
  ): Promise<void> => {
    const allocation = RestoreCredentialAllocationSchema.parse(allocationInput);
    const { prefix, binding } = credentialBinding(allocation);
    await putExactJson(
      deps.store,
      credentialReleaseKey(prefix, allocation.generation),
      RestoreCredentialReleaseSchema.parse(binding),
      'Restore credential release receipt conflicts with replayed state',
    );
  };

  const recordCredentialCreated = async (
    allocationInput: RestoreCredentialAllocation,
  ): Promise<void> => {
    const allocation = RestoreCredentialAllocationSchema.parse(allocationInput);
    const { prefix, binding } = credentialBinding(allocation);
    await putExactJson(
      deps.store,
      credentialCreatedKey(prefix, allocation.generation),
      RestoreCredentialCreatedSchema.parse(binding),
      'Restore credential creation receipt conflicts with replayed state',
    );
  };

  const cleanupOutstandingCredentials = async (): Promise<void> => {
    const state = await readCredentialCleanupState(deps.store, intentKey, intent, targetRef);
    for (const entry of state.allocations) {
      if (entry.released) {
        continue;
      }
      const expiresAtMs = new Date(entry.allocation.expiresAt).getTime();
      const creationImpossibleAtMs = expiresAtMs + MAX_FORGEJO_TIMEOUT_MS;
      if (!entry.created && now().getTime() < creationImpossibleAtMs) {
        throw new Error('Restore credential creator is still pending');
      }
      await deps.client.send({
        method: 'DELETE',
        path: `/admin/users/${encodeURIComponent(entry.allocation.username)}?purge=true`,
        allow: [404],
      });
      await completeCredentialCleanup(entry.allocation);
    }
  };

  const completeTerminalizedRestore = async (): Promise<void> => {
    const fence = await readVerificationFence(deps.store, intentKey, intent, targetRef);
    if (fence === undefined) {
      return;
    }
    const receipt = RestorePhaseReceiptSchema.parse({
      version: 1,
      intentKey,
      operationId: intent.operationId,
      backupKey: intent.backupKey,
      repositoryId: fence.repositoryId,
      phase: 'verified',
      resultDigest: fence.resultDigest,
      result: fence.result,
    });
    await putExactJson(
      deps.store,
      intentKey.replace(/\.json$/, '.verified.json'),
      receipt,
      'Restore phase receipt conflicts with replayed state',
    );
  };

  const reserveCredentialCleanup = async (identity: {
    readonly username: string;
    readonly expiresAt: Date;
  }): Promise<RestoreCredentialAllocation> => {
    if (resolvedTarget === undefined) {
      throw new Error('Restore target must be resolved before allocating a credential');
    }
    if (await deps.store.exists(fenceKey)) {
      throw new Error('Restore credential allocation is closed');
    }
    await cleanupOutstandingCredentials();
    const state = await readCredentialCleanupState(deps.store, intentKey, intent, targetRef);
    const allocation = RestoreCredentialAllocationSchema.parse({
      version: 1,
      intentKey,
      operationId: intent.operationId,
      targetRef,
      repositoryId: resolvedTarget.repositoryId,
      generation: state.nextGeneration,
      username: identity.username,
      expiresAt: identity.expiresAt.toISOString(),
    });
    if (await deps.store.exists(fenceKey)) {
      throw new Error('Restore credential allocation is closed');
    }
    await putExactJson(
      deps.store,
      credentialAllocationKey(
        credentialReceiptPrefix(intentKey),
        allocation.generation,
      ),
      allocation,
      'Restore credential allocation conflicts with a concurrent attempt',
    );
    if (await deps.store.exists(fenceKey)) {
      await completeCredentialCleanup(allocation);
      throw new Error('Restore credential allocation is closed');
    }
    return allocation;
  };

  await cleanupOutstandingCredentials();
  await completeTerminalizedRestore();
  const completedResult = await readCompletedRestoreResult(
    deps.store,
    intentKey,
    intent,
    targetRef,
  );
  return {
    intentKey,
    targetRef,
    ...(completedResult === undefined ? {} : { completedResult }),
    resolveTarget: async () => {
      resolvedTarget = await resolveIntentTarget(deps, intentKey, intent);
      return resolvedTarget;
    },
    reserveCredentialCleanup,
    recordCredentialCreated,
    completeCredentialCleanup,
    recordPhase: async (phase, result) => {
      if (resolvedTarget === undefined) {
        throw new Error('Restore target must be resolved before recording progress');
      }
      if (phase === 'verified') {
        const verifiedResult = RestoreRepositoryResultSchema.parse(result);
        const fence = RestoreVerificationFenceSchema.parse({
          version: 1,
          intentKey,
          operationId: intent.operationId,
          backupKey: intent.backupKey,
          targetRef,
          repositoryId: resolvedTarget.repositoryId,
          resultDigest: jsonDigest(verifiedResult),
          result: verifiedResult,
        });
        await putExactJson(
          deps.store,
          fenceKey,
          fence,
          'Restore verification fence conflicts with replayed state',
        );
        await cleanupOutstandingCredentials();
        await completeTerminalizedRestore();
        return;
      }
      const verifiedResult =
        result === undefined ? undefined : RestoreRepositoryResultSchema.parse(result);
      const receipt = RestorePhaseReceiptSchema.parse({
        version: 1,
        intentKey,
        operationId: intent.operationId,
        backupKey: intent.backupKey,
        repositoryId: resolvedTarget.repositoryId,
        phase,
        ...(verifiedResult === undefined
          ? {}
          : {
              resultDigest: createHash('sha256')
                .update(JSON.stringify(verifiedResult))
                .digest('hex'),
              result: verifiedResult,
            }),
      });
      await putExactJson(
        deps.store,
        intentKey.replace(/\.json$/, `.${phase}.json`),
        receipt,
        'Restore phase receipt conflicts with replayed state',
      );
    },
  };
}

function deterministicId(prefix: 'org' | 'proj', seed: string): string {
  const value = createHash('sha256').update(seed).digest('hex').slice(0, 26).toUpperCase();
  return `${prefix}_${value}`;
}

function restoreSelector(source: NodeJS.ProcessEnv): RestoreSelector {
  const parsed = RestoreSelectorSchema.safeParse({
    organizationId: source['GIT_RESTORE_ORGANIZATION_ID'],
    projectId: source['GIT_RESTORE_PROJECT_ID'],
    key: source['GIT_RESTORE_KEY'],
    idempotencyKey: source['GIT_RESTORE_IDEMPOTENCY_KEY'],
  });
  if (!parsed.success) {
    throw new Error('Invalid restore selector');
  }
  return parsed.data;
}

export function createBackupOperations(deps: {
  readonly inventory: BackupInventory;
  readonly store: BackupObjectStore;
  readonly git: BackupGit;
  readonly restoreGit: RestoreBackupInspectionGit;
  readonly client: ForgejoClient;
  readonly restoreCredentials: RestoreCredentialIssuer;
  readonly restoreDrillLease: RestoreDrillLease;
  readonly close: () => Promise<void>;
}): BackupCliOperations {
  const { inventory, store, git, restoreGit, client } = deps;

  return {
    nightly: async () => await runNightlyBackups({ inventory, store, git }),

    restore: async (selector) => {
      const repositories = await inventory.listProvisionedRepositories();
      const repository = repositories.find(
        (entry) =>
          entry.organizationId === selector.organizationId &&
          entry.projectId === selector.projectId,
      );
      if (repository === undefined) {
        throw new Error('Restore source is not a provisioned internal repository');
      }
      const operation = await beginRestoreOperation(
        { store, client },
        {
          kind: 'manual',
          idempotencyKey: selector.idempotencyKey,
          source: repository,
          backupKey: selector.key,
        },
      );
      if (operation.completedResult !== undefined) {
        return {
          status: 'restored',
          organizationId: selector.organizationId,
          projectId: selector.projectId,
          ...operation.completedResult,
        };
      }
      const expectedBranches = await inventory.expectedBranches(
        selector.organizationId,
        selector.projectId,
      );
      const result = await restoreRepositoryBackup(
        {
          store,
          git: restoreGit,
          resolveTarget: async () => {
            const target = await operation.resolveTarget();
            return await deps.restoreCredentials.issue({
              sourceOrganizationId: repository.organizationId,
              sourceProjectId: repository.projectId,
              targetRef: operation.targetRef,
              repositoryId: target.repositoryId,
              cloneUrl: target.cloneUrl,
              reserveCredentialCleanup: async (allocation) =>
                await operation.reserveCredentialCleanup(allocation),
              recordCredentialCreated: async (allocation) => {
                await operation.recordCredentialCreated(allocation);
              },
              completeCredentialCleanup: async (allocation) => {
                await operation.completeCredentialCleanup(allocation);
              },
            });
          },
          recordPhase: async (phase, result) => {
            await operation.recordPhase(phase, result);
          },
        },
        { key: selector.key, expectedBranches: [...expectedBranches] },
      );
      return {
        status: 'restored',
        organizationId: selector.organizationId,
        projectId: selector.projectId,
        ...result,
      };
    },

    restoreDrill: async () =>
      await deps.restoreDrillLease.runExclusive(async () => {
        const repositories = await inventory.listProvisionedRepositories();
        if (repositories.length === 0) {
          throw new Error('No provisioned internal repository is available for the restore drill');
        }
        const { repository, key, representation } = await selectRestoreDrillBackup(
          { store, git: restoreGit },
          repositories,
        );
        const drillKey = `drill-${createHash('sha256')
          .update(`${repository.organizationId}\0${repository.projectId}\0${key}`)
          .digest('hex')}`;
        const operation = await beginRestoreOperation(
          { store, client },
          {
            kind: 'drill',
            idempotencyKey: drillKey,
            source: repository,
            backupKey: key,
            targetMode: representation === 'empty' ? 'empty' : 'persistent',
          },
        );
        if (operation.completedResult !== undefined) {
          return {
            status: 'restore-drill-verified',
            projectId: repository.projectId,
            ...operation.completedResult,
          };
        }
        const expectedBranches = await inventory.expectedBranches(
          repository.organizationId,
          repository.projectId,
        );
        const result = await restoreRepositoryBackup(
          {
            store,
            git: restoreGit,
            resolveTarget: async () => {
              const target = await operation.resolveTarget();
              return await deps.restoreCredentials.issue({
                sourceOrganizationId: repository.organizationId,
                sourceProjectId: repository.projectId,
                targetRef: operation.targetRef,
                repositoryId: target.repositoryId,
                cloneUrl: target.cloneUrl,
                reserveCredentialCleanup: async (allocation) =>
                  await operation.reserveCredentialCleanup(allocation),
                recordCredentialCreated: async (allocation) => {
                  await operation.recordCredentialCreated(allocation);
                },
                completeCredentialCleanup: async (allocation) => {
                  await operation.completeCredentialCleanup(allocation);
                },
              });
            },
            recordPhase: async (phase, result) => {
              await operation.recordPhase(phase, result);
            },
          },
          { key, expectedBranches: [...expectedBranches] },
        );
        return {
          status: 'restore-drill-verified',
          projectId: repository.projectId,
          ...result,
        };
      }),

    close: deps.close,
  };
}

function createProductionOperations(): BackupCliOperations {
  const forgejo = loadForgejoEnv();
  const artifact = loadArtifactEnv();
  const commandDeadlines = loadGitCommandDeadlineEnv();
  const database = createDb(loadDatabaseUrl());
  const client = createForgejoClient(forgejo);
  const inventory = createDbBackupInventory(database.db, forgejo.baseUrl);
  const store = createR2BackupObjectStore(artifact);
  const tokens = createTokenService({
    client,
    audit: createDbGitAuditSink(database.db),
  });
  const backupGit = createGitBundleCommands({
    username: 'zapp-admin-token',
    password: forgejo.adminToken,
    timeoutMs: commandDeadlines.backupCommandDeadlineMs,
  });
  const restoreGit = createGitBundleCommands({
    username: 'zapp-admin-token',
    password: forgejo.adminToken,
    timeoutMs: commandDeadlines.restoreCommandDeadlineMs,
  });
  return createBackupOperations({
    inventory,
    store,
    git: backupGit,
    restoreGit,
    client,
    restoreCredentials: createForgejoRestoreCredentialIssuer(
      client,
      tokens,
      commandDeadlines.restoreCommandDeadlineMs,
    ),
    restoreDrillLease: createPostgresRestoreDrillLease(database.sql),
    close: async () => {
      await database.close();
    },
  });
}

export async function runBackupCli(
  cli: BackupCliProcess,
  createOperations: () =>
    BackupCliOperations | Promise<BackupCliOperations> = createProductionOperations,
): Promise<void> {
  let operations: BackupCliOperations | undefined;
  let failureReported = false;
  try {
    const action = BackupActionSchema.parse(cli.argv[2] ?? 'nightly');
    const selector = action === 'restore' ? restoreSelector(cli.env) : undefined;
    operations = await createOperations();

    switch (action) {
      case 'nightly': {
        const report = await operations.nightly();
        cli.stdout.write(`${JSON.stringify(report)}\n`);
        if (report.failed > 0) {
          cli.exitCode = 1;
        }
        break;
      }
      case 'restore': {
        if (selector === undefined) {
          throw new Error('Invalid restore selector');
        }
        cli.stdout.write(`${JSON.stringify(await operations.restore(selector))}\n`);
        break;
      }
      case 'restore-drill':
        cli.stdout.write(`${JSON.stringify(await operations.restoreDrill())}\n`);
        break;
    }
  } catch {
    failureReported = true;
    cli.stderr.write('Git backup operation failed\n');
    cli.exitCode = 1;
  } finally {
    if (operations !== undefined) {
      try {
        await operations.close();
      } catch {
        if (!failureReported) {
          cli.stderr.write('Git backup operation failed\n');
        }
        cli.exitCode = 1;
      }
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  await runBackupCli(process);
}
