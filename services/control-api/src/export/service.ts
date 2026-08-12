import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import {
  agentPhases,
  agentRuns,
  agentTasks,
  artifacts,
  auditEvents,
  deployments,
  projectDeletions,
  projects,
  releases,
  secretMetadata,
  specifications,
  testCases,
  testRuns,
  verificationResults,
  type Database,
} from '@zapp/db';
import { and, asc, desc, eq, inArray, or, isNull } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import type { AuditHook } from '../plugins/audit.js';
import { IdempotencyHeadersSchema } from '../plugins/idempotency.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { operationOf, stableId } from '../routes/runs.js';

const SIGNED_URL_TTL_SECONDS = 300;
const MAX_GIT_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_RUNS = 10_000;
const MAX_EXPORT_RECORDS = 100_000;
const MAX_EXPORT_RELEASES = 10_000;
const MAX_EXPORT_VARIABLE_NAMES = 10_000;
const SQL_ID_BATCH_SIZE = 10_000;
const CONTENT_TYPE = 'application/x-tar';

const ProjectParamsSchema = z.object({ projectId: idSchema('proj') }).strict();
const EnvironmentVariableNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const JsonDocumentSchema = z
  .unknown()
  .refine((value) => isExportJson(value, new WeakSet()), 'Expected serializable JSON data');

export const ProjectExportDataSchema = z
  .object({
    specification: JsonDocumentSchema,
    plan: JsonDocumentSchema,
    evidence: z.array(JsonDocumentSchema).max(MAX_EXPORT_RECORDS),
    releases: z.array(JsonDocumentSchema).max(MAX_EXPORT_RELEASES),
    environmentVariableNames: z
      .array(EnvironmentVariableNameSchema)
      .max(MAX_EXPORT_VARIABLE_NAMES),
    auditLog: z.array(JsonDocumentSchema).max(MAX_EXPORT_RECORDS),
  })
  .strict();
export type ProjectExportData = z.infer<typeof ProjectExportDataSchema>;

function isExportJson(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (seen.has(value)) return false;
  seen.add(value);
  const serializable = Array.isArray(value)
    ? value.every((entry) => isExportJson(entry, seen))
    : (() => {
        const prototype = Object.getPrototypeOf(value) as unknown;
        return (
          (prototype === Object.prototype || prototype === null) &&
          Object.values(value).every((entry) => isExportJson(entry, seen))
        );
      })();
  seen.delete(value);
  return serializable;
}

const ProjectExportSchema = z
  .object({
    exportId: idSchema('art'),
    projectId: idSchema('proj'),
    contentType: z.literal(CONTENT_TYPE),
    byteSize: z.number().int().positive().max(MAX_EXPORT_BYTES),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    url: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export interface ProjectExportSourcePort {
  get(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly exportId: string;
  }): Promise<ProjectExportReceipt | undefined>;
  collect(input: {
    readonly organizationId: string;
    readonly projectId: string;
  }): Promise<ProjectExportData | undefined>;
  record(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly exportId: string;
    readonly storageRef: string;
    readonly contentHash: string;
    readonly byteSize: number;
    readonly operationKey: string;
    readonly createdAt: Date;
    readonly audit: AuditHook<{ readonly exportId: string }>;
  }): Promise<'created' | 'existing' | 'conflict' | 'deleting' | 'not_found'>;
}

interface ProjectExportReceipt {
  readonly storageRef: string;
  readonly contentHash: string;
  readonly byteSize: number;
}

export interface ProjectExportGitPort {
  bundle(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationKey: string;
  }): Promise<Buffer>;
}

export interface ProjectExportStoragePort {
  put(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: typeof CONTENT_TYPE;
  }): Promise<void>;
  delete(input: { readonly key: string }): Promise<void>;
  signGet(input: { readonly key: string; readonly expiresInSeconds: number }): Promise<string>;
}

export interface ProjectExportDeps {
  readonly source: ProjectExportSourcePort;
  readonly git: ProjectExportGitPort;
  readonly storage: ProjectExportStoragePort;
}

export function createGitServiceProjectExportPort(options: {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Test-only lowering of the production ceiling; values can never raise it. */
  readonly maxBundleBytes?: number;
}): ProjectExportGitPort {
  const baseUrl = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value))
    .transform((value) => value.replace(/\/+$/u, ''))
    .parse(options.baseUrl);
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const maxBundleBytes = z
    .number()
    .int()
    .positive()
    .max(MAX_GIT_BUNDLE_BYTES)
    .parse(options.maxBundleBytes ?? MAX_GIT_BUNDLE_BYTES);
  return {
    async bundle(rawInput) {
      const input = z
        .object({
          organizationId: idSchema('org'),
          projectId: idSchema('proj'),
          operationKey: z.string().min(8).max(255),
        })
        .strict()
        .parse(rawInput);
      const token = await signer.signServiceToken({
        service: 'control-api',
        aud: 'git-service',
      });
      let response: Response;
      try {
        response = await doFetch(
          `${baseUrl}/internal/git/repositories/${input.organizationId}/${input.projectId}/export-bundle`,
          {
            method: 'POST',
            headers: {
              accept: 'application/x-git-bundle',
              'idempotency-key': input.operationKey,
              'x-zapp-service-token': token.token,
            },
            signal: AbortSignal.timeout(10 * 60_000),
          },
        );
      } catch (error) {
        throw new Error('Git bundle export service is unreachable', { cause: error });
      }
      if (response.status !== 200) throw new Error('Git bundle export service refused');
      const declaredLength = response.headers.get('content-length');
      if (
        declaredLength !== null &&
        (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBundleBytes)
      ) {
        throw exportTooLarge();
      }
      const bundle = await readBoundedResponse(response, maxBundleBytes);
      if (bundle.length === 0) throw new Error('Git bundle export service returned no bytes');
      return bundle;
    },
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is the caller-facing failure even if the peer
          // has already torn down its stream while cancellation is in flight.
        }
        throw exportTooLarge();
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function registerProjectExportRoutes(
  app: AppInstance,
  deps: ProjectExportDeps & { readonly now: () => Date },
): void {
  app.post(
    '/v1/projects/:projectId/export',
    {
      config: { idempotency: 'refresh-response' },
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: { 201: z.object({ export: ProjectExportSchema }).strict() },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      authorize(tenant, 'manage_organization');
      const operationKey = operationOf(request);
      const exportId = stableId('art', operationKey);
      const storageRef = `org/${tenant.organizationId}/project/${request.params.projectId}/exports/${exportId}.tar`;
      const data = await deps.source.collect({
        organizationId: tenant.organizationId,
        projectId: request.params.projectId,
      });
      if (data === undefined) {
        await deleteProjectExportObject(deps.storage, storageRef, request.log);
        throw projectNotFound();
      }
      const parsed = ProjectExportDataSchema.parse(data);
      const existing = await deps.source.get({
        organizationId: tenant.organizationId,
        projectId: request.params.projectId,
        exportId,
      });
      if (existing !== undefined) {
        return await sendProjectExport(reply, deps, {
          exportId,
          projectId: request.params.projectId,
          ...existing,
        });
      }
      const gitBundle = await deps.git.bundle({
        organizationId: tenant.organizationId,
        projectId: request.params.projectId,
        operationKey,
      });
      if (!Buffer.isBuffer(gitBundle) || gitBundle.length === 0) {
        throw new Error('git service returned an empty export bundle');
      }
      if (gitBundle.length > MAX_GIT_BUNDLE_BYTES) throw exportTooLarge();
      const body = buildProjectExportTar({
        projectId: request.params.projectId,
        exportId,
        gitBundle,
        data: parsed,
      });
      if (body.length > MAX_EXPORT_BYTES) throw exportTooLarge();
      const contentHash = createHash('sha256').update(body).digest('hex');
      await deps.storage.put({ key: storageRef, body, contentType: CONTENT_TYPE });
      const recorded = await deps.source.record({
        organizationId: tenant.organizationId,
        projectId: request.params.projectId,
        exportId,
        storageRef,
        contentHash,
        byteSize: body.length,
        operationKey,
        createdAt: deps.now(),
        audit: async (tx) => {
          await request.audit(tx, {
            organizationId: tenant.organizationId,
            action: 'project.exported',
            target: { type: 'artifact', id: exportId },
            metadata: { projectId: request.params.projectId, operationKey },
          });
        },
      });
      if (recorded === 'not_found' || recorded === 'deleting') {
        await deleteProjectExportObject(deps.storage, storageRef, request.log);
        throw projectNotFound();
      }
      if (recorded === 'conflict') {
        throw new ApiError(
          'project_export_conflict',
          409,
          'That export operation identifies different content.',
        );
      }
      return await sendProjectExport(reply, deps, {
        exportId,
        projectId: request.params.projectId,
        storageRef,
        byteSize: body.length,
        contentHash,
      });
    },
  );
}

async function deleteProjectExportObject(
  storage: ProjectExportStoragePort,
  key: string,
  logger: Pick<AppInstance['log'], 'error'>,
): Promise<void> {
  try {
    await storage.delete({ key });
  } catch (error) {
    logger.error({ err: error, key }, 'project export cleanup failed');
    throw new ApiError(
      'project_export_cleanup_unavailable',
      503,
      'Project export cleanup is temporarily unavailable.',
    );
  }
}

async function sendProjectExport(
  reply: FastifyReply,
  deps: Pick<ProjectExportDeps, 'storage'> & { readonly now: () => Date },
  receipt: ProjectExportReceipt & {
    readonly exportId: string;
    readonly projectId: string;
  },
) {
  const url = await deps.storage.signGet({
    key: receipt.storageRef,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
  });
  return await reply.status(201).send({
    export: {
      exportId: receipt.exportId,
      projectId: receipt.projectId,
      contentType: CONTENT_TYPE,
      byteSize: receipt.byteSize,
      contentHash: receipt.contentHash,
      url,
      expiresAt: new Date(deps.now().getTime() + SIGNED_URL_TTL_SECONDS * 1_000).toISOString(),
    },
  });
}

export function buildProjectExportTar(input: {
  readonly projectId: string;
  readonly exportId: string;
  readonly gitBundle: Buffer;
  readonly data: ProjectExportData;
}): Buffer {
  const data = ProjectExportDataSchema.parse(input.data);
  const entries = [
    ['repository.bundle', input.gitBundle],
    ['specification.json', json(data.specification)],
    ['plan.json', json(data.plan)],
    ['evidence-manifests.json', json(data.evidence)],
    ['release-manifests.json', json(data.releases)],
    [
      'environment-variable-names.json',
      json([...new Set(data.environmentVariableNames)].sort()),
    ],
    ['audit-log.json', json(data.auditLog)],
    [
      'export-manifest.json',
      json({
        formatVersion: 1,
        projectId: idSchema('proj').parse(input.projectId),
        exportId: idSchema('art').parse(input.exportId),
        entries: [
          'repository.bundle',
          'specification.json',
          'plan.json',
          'evidence-manifests.json',
          'release-manifests.json',
          'environment-variable-names.json',
          'audit-log.json',
        ],
      }),
    ],
  ] as const;
  const chunks: Buffer[] = [];
  let total = 1_024;
  for (const [name, body] of entries) {
    total += 512 + Math.ceil(body.length / 512) * 512;
    if (total > MAX_EXPORT_BYTES) throw exportTooLarge();
    chunks.push(tarHeader(name, body.length), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return Buffer.concat(chunks, total);
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, z.string().min(1).max(100).parse(name));
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarText(header, 257, 6, 'ustar');
  writeTarText(header, 263, 2, '00');
  writeTarText(header, 265, 32, 'zapp');
  writeTarText(header, 297, 32, 'zapp');
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, '0');
  header.write(encoded, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarText(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error('tar field exceeds its bound');
  bytes.copy(header, offset);
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) throw exportTooLarge();
  header.write(encoded, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}

function exportTooLarge(): ApiError {
  return new ApiError('project_export_too_large', 413, 'The project export is too large.');
}

function boundedProjection<T>(rows: readonly T[], maximum: number): T[] {
  if (rows.length > maximum) throw exportTooLarge();
  return [...rows];
}

function idBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += SQL_ID_BATCH_SIZE) {
    batches.push(ids.slice(offset, offset + SQL_ID_BATCH_SIZE));
  }
  return batches;
}

async function loadProjectionBatches<T>(
  ids: readonly string[],
  load: (batch: readonly string[]) => Promise<readonly T[]>,
  maximum: number,
): Promise<T[]> {
  const rows: T[] = [];
  for (const batch of idBatches(ids)) {
    rows.push(...(await load(batch)));
    if (rows.length > maximum) throw exportTooLarge();
  }
  return rows;
}

export function createUnavailableProjectExportDeps(): ProjectExportDeps {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new ApiError('project_export_unavailable', 503, 'Project export is unavailable.'),
    );
  return {
    source: { get: unavailable, collect: unavailable, record: unavailable },
    git: { bundle: unavailable },
    storage: { put: unavailable, delete: unavailable, signGet: unavailable },
  };
}

export function createDatabaseProjectExportSource(
  database: Database,
): ProjectExportSourcePort {
  return {
    async get(rawInput) {
      const input = z
        .object({
          organizationId: idSchema('org'),
          projectId: idSchema('proj'),
          exportId: idSchema('art'),
        })
        .strict()
        .parse(rawInput);
      const [row] = await database
        .select({
          storageRef: artifacts.storageRef,
          contentHash: artifacts.contentHash,
          metadata: artifacts.metadataJson,
        })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.organizationId, input.organizationId),
            eq(artifacts.projectId, input.projectId),
            eq(artifacts.id, input.exportId),
            eq(artifacts.type, 'project_export_bundle'),
          ),
        )
        .limit(1);
      if (row === undefined) return undefined;
      const metadata = z
        .object({ byteSize: z.number().int().positive().max(MAX_EXPORT_BYTES) })
        .passthrough()
        .parse(row.metadata);
      return {
        storageRef: row.storageRef,
        contentHash: z.string().regex(/^[0-9a-f]{64}$/u).parse(row.contentHash),
        byteSize: metadata.byteSize,
      };
    },
    async collect(rawInput) {
      const input = ProjectParamsSchema.extend({ organizationId: idSchema('org') }).parse({
        organizationId: rawInput.organizationId,
        projectId: rawInput.projectId,
      });
      const scope = and(
        eq(projects.organizationId, input.organizationId),
        eq(projects.id, input.projectId),
      );
      const [project] = await database
        .select({ id: projects.id })
        .from(projects)
        .where(scope)
        .limit(1);
      if (project === undefined) return undefined;
      const [deletion] = await database
        .select({ projectId: projectDeletions.projectId })
        .from(projectDeletions)
        .where(
          and(
            eq(projectDeletions.organizationId, input.organizationId),
            eq(projectDeletions.projectId, input.projectId),
          ),
        )
        .limit(1);
      if (deletion !== undefined) return undefined;

      const [
        specification,
        unboundedRuns,
        unboundedEvidenceArtifacts,
        unboundedReleaseRows,
        unboundedVariableRows,
      ] =
        await Promise.all([
          database
            .select({
              id: specifications.id,
              version: specifications.version,
              status: specifications.status,
              content: specifications.contentJson,
              approvedAt: specifications.approvedAt,
            })
            .from(specifications)
            .where(
              and(
                eq(specifications.organizationId, input.organizationId),
                eq(specifications.projectId, input.projectId),
              ),
            )
            .orderBy(desc(specifications.version))
            .limit(1),
          database
            .select({
              id: agentRuns.id,
              mode: agentRuns.mode,
              appType: agentRuns.appType,
              status: agentRuns.status,
              specificationId: agentRuns.specificationId,
              startedAt: agentRuns.startedAt,
              completedAt: agentRuns.completedAt,
            })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.organizationId, input.organizationId),
                eq(agentRuns.projectId, input.projectId),
              ),
            )
            .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
            .limit(MAX_EXPORT_RUNS + 1),
          database
            .select({
              id: artifacts.id,
              runId: artifacts.runId,
              taskId: artifacts.taskId,
              type: artifacts.type,
              storageRef: artifacts.storageRef,
              contentHash: artifacts.contentHash,
              metadata: artifacts.metadataJson,
              createdAt: artifacts.createdAt,
            })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.organizationId, input.organizationId),
                eq(artifacts.projectId, input.projectId),
              ),
            )
            .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
            .limit(MAX_EXPORT_RECORDS + 1),
          database
            .select({
              id: releases.id,
              environmentId: releases.environmentId,
              commitSha: releases.commitSha,
              specificationId: releases.specificationId,
              status: releases.status,
              evidenceManifestArtifactId: releases.evidenceManifestArtifactId,
              createdAt: releases.createdAt,
            })
            .from(releases)
            .where(
              and(
                eq(releases.organizationId, input.organizationId),
                eq(releases.projectId, input.projectId),
              ),
            )
            .orderBy(asc(releases.createdAt), asc(releases.id))
            .limit(MAX_EXPORT_RELEASES + 1),
          database
            .select({ name: secretMetadata.name })
            .from(secretMetadata)
            .where(
              and(
                eq(secretMetadata.organizationId, input.organizationId),
                or(
                  eq(secretMetadata.projectId, input.projectId),
                  isNull(secretMetadata.projectId),
                ),
              ),
            )
            .orderBy(asc(secretMetadata.name))
            .limit(MAX_EXPORT_VARIABLE_NAMES + 1),
        ]);

      const runs = boundedProjection(unboundedRuns, MAX_EXPORT_RUNS);
      const evidenceArtifacts = boundedProjection(
        unboundedEvidenceArtifacts,
        MAX_EXPORT_RECORDS,
      );
      const releaseRows = boundedProjection(unboundedReleaseRows, MAX_EXPORT_RELEASES);
      const variableRows = boundedProjection(
        unboundedVariableRows,
        MAX_EXPORT_VARIABLE_NAMES,
      );

      const runIds = runs.map((run) => run.id);
      const [unboundedPhaseRows, unboundedTestRunRows, unboundedVerificationRows] =
        runIds.length === 0
          ? [[], [], []]
          : await Promise.all([
              database
                .select({
                  id: agentPhases.id,
                  runId: agentPhases.runId,
                  sequence: agentPhases.sequence,
                  title: agentPhases.title,
                  status: agentPhases.status,
                  acceptanceCriteria: agentPhases.acceptanceCriteriaJson,
                })
                .from(agentPhases)
                .where(
                  and(
                    eq(agentPhases.organizationId, input.organizationId),
                    inArray(agentPhases.runId, runIds),
                  ),
                )
                .orderBy(asc(agentPhases.runId), asc(agentPhases.sequence))
                .limit(MAX_EXPORT_RECORDS + 1),
              database
                .select({
                  id: testRuns.id,
                  runId: testRuns.runId,
                  taskId: testRuns.taskId,
                  commitSha: testRuns.commitSha,
                  type: testRuns.type,
                  status: testRuns.status,
                  summary: testRuns.summaryJson,
                  startedAt: testRuns.startedAt,
                  completedAt: testRuns.completedAt,
                })
                .from(testRuns)
                .where(
                  and(
                    eq(testRuns.organizationId, input.organizationId),
                    inArray(testRuns.runId, runIds),
                  ),
                )
                .orderBy(asc(testRuns.startedAt), asc(testRuns.id))
                .limit(MAX_EXPORT_RECORDS + 1),
              database
                .select({
                  id: verificationResults.id,
                  runId: verificationResults.runId,
                  taskId: verificationResults.taskId,
                  commitSha: verificationResults.commitSha,
                  decision: verificationResults.decision,
                  criteriaResults: verificationResults.criteriaResultsJson,
                  risks: verificationResults.risksJson,
                  createdAt: verificationResults.createdAt,
                })
                .from(verificationResults)
                .where(
                  and(
                    eq(verificationResults.organizationId, input.organizationId),
                    inArray(verificationResults.runId, runIds),
                  ),
                )
                .orderBy(asc(verificationResults.createdAt), asc(verificationResults.id))
                .limit(MAX_EXPORT_RECORDS + 1),
            ]);
      const phaseRows = boundedProjection(unboundedPhaseRows, MAX_EXPORT_RECORDS);
      const testRunRows = boundedProjection(unboundedTestRunRows, MAX_EXPORT_RECORDS);
      const verificationRows = boundedProjection(
        unboundedVerificationRows,
        MAX_EXPORT_RECORDS,
      );
      const phaseIds = phaseRows.map((phase) => phase.id);
      const loadTasks = async (ids: readonly string[]) =>
        await database
          .select({
            id: agentTasks.id,
            phaseId: agentTasks.phaseId,
            parentTaskId: agentTasks.parentTaskId,
            title: agentTasks.title,
            status: agentTasks.status,
            riskLevel: agentTasks.riskLevel,
            baseCommitSha: agentTasks.baseCommitSha,
            outputCommitSha: agentTasks.outputCommitSha,
            acceptanceCriteria: agentTasks.acceptanceCriteriaJson,
            dependencies: agentTasks.dependenciesJson,
            assignedAgentRole: agentTasks.assignedAgentRole,
          })
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.organizationId, input.organizationId),
              inArray(agentTasks.phaseId, ids),
            ),
          )
          .orderBy(asc(agentTasks.phaseId), asc(agentTasks.id))
          .limit(MAX_EXPORT_RECORDS + 1);
      const taskRows = boundedProjection(
        (await loadProjectionBatches(phaseIds, loadTasks, MAX_EXPORT_RECORDS))
          .sort(
            (left, right) =>
              left.phaseId.localeCompare(right.phaseId) || left.id.localeCompare(right.id),
          ),
        MAX_EXPORT_RECORDS,
      );
      const testRunIds = testRunRows.map((testRun) => testRun.id);
      const loadCases = async (ids: readonly string[]) =>
        await database
          .select({
            id: testCases.id,
            testRunId: testCases.testRunId,
            name: testCases.name,
            status: testCases.status,
            durationMs: testCases.durationMs,
            evidenceArtifactId: testCases.evidenceArtifactId,
            error: testCases.errorJson,
          })
          .from(testCases)
          .where(
            and(
              eq(testCases.organizationId, input.organizationId),
              inArray(testCases.testRunId, ids),
            ),
          )
          .orderBy(asc(testCases.testRunId), asc(testCases.id))
          .limit(MAX_EXPORT_RECORDS + 1);
      const caseRows = boundedProjection(
        (await loadProjectionBatches(testRunIds, loadCases, MAX_EXPORT_RECORDS))
          .sort(
            (left, right) =>
              left.testRunId.localeCompare(right.testRunId) || left.id.localeCompare(right.id),
          ),
        MAX_EXPORT_RECORDS,
      );
      const releaseIds = releaseRows.map((release) => release.id);
      const deploymentRows =
        releaseIds.length === 0
          ? []
          : await database
              .select({
                id: deployments.id,
                releaseId: deployments.releaseId,
                provider: deployments.provider,
                providerDeploymentId: deployments.providerDeploymentId,
                status: deployments.status,
                url: deployments.url,
                startedAt: deployments.startedAt,
                completedAt: deployments.completedAt,
                rollbackOfDeploymentId: deployments.rollbackOfDeploymentId,
              })
              .from(deployments)
              .where(
                and(
                  eq(deployments.organizationId, input.organizationId),
                  inArray(deployments.releaseId, releaseIds),
                ),
              )
              .orderBy(asc(deployments.startedAt), asc(deployments.id))
              .limit(MAX_EXPORT_RECORDS + 1);
      const boundedDeploymentRows = boundedProjection(
        deploymentRows,
        MAX_EXPORT_RECORDS,
      );
      const targetIds = [
        input.projectId,
        ...runIds,
        ...phaseIds,
        ...taskRows.map((task) => task.id),
        ...evidenceArtifacts.map((artifact) => artifact.id),
        ...testRunIds,
        ...caseRows.map((testCase) => testCase.id),
        ...verificationRows.map((verification) => verification.id),
        ...releaseIds,
        ...boundedDeploymentRows.map((deployment) => deployment.id),
      ];
      const loadAudit = async (ids: readonly string[]) =>
        await database
          .select({
            id: auditEvents.id,
            actorType: auditEvents.actorType,
            actorId: auditEvents.actorId,
            action: auditEvents.action,
            targetType: auditEvents.targetType,
            targetId: auditEvents.targetId,
            metadata: auditEvents.metadataJson,
            occurredAt: auditEvents.occurredAt,
          })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.organizationId, input.organizationId),
              inArray(auditEvents.targetId, ids),
            ),
          )
          .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id))
          .limit(MAX_EXPORT_RECORDS + 1);
      const auditRows = boundedProjection(
        (await loadProjectionBatches(
          [...new Set(targetIds)],
          loadAudit,
          MAX_EXPORT_RECORDS,
        ))
          .sort(
            (left, right) =>
              left.occurredAt.getTime() - right.occurredAt.getTime() ||
              left.id.localeCompare(right.id),
          ),
        MAX_EXPORT_RECORDS,
      );
      const deploymentsByRelease = new Map<
        string,
        (typeof boundedDeploymentRows)[number][]
      >();
      for (const deployment of boundedDeploymentRows) {
        const grouped = deploymentsByRelease.get(deployment.releaseId) ?? [];
        grouped.push(deployment);
        deploymentsByRelease.set(deployment.releaseId, grouped);
      }

      return ProjectExportDataSchema.parse({
        specification: specification[0] ?? null,
        plan: { runs, phases: phaseRows, tasks: taskRows },
        evidence: [
          { kind: 'artifacts', records: evidenceArtifacts },
          { kind: 'test_runs', records: testRunRows },
          { kind: 'test_cases', records: caseRows },
          { kind: 'verification_results', records: verificationRows },
        ],
        releases: releaseRows.map((release) => ({
          ...release,
          deployments: deploymentsByRelease.get(release.id) ?? [],
        })),
        environmentVariableNames: variableRows.map((row) => row.name),
        auditLog: auditRows,
      });
    },
    async record(rawInput) {
      const input = z
        .object({
          organizationId: idSchema('org'),
          projectId: idSchema('proj'),
          exportId: idSchema('art'),
          storageRef: z.string().min(1),
          contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
          byteSize: z.number().int().positive().max(MAX_EXPORT_BYTES),
          operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
          createdAt: z.date(),
          audit: z.function(),
        })
        .strict()
        .parse(rawInput);
      return await database.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.organizationId, input.organizationId),
              eq(projects.id, input.projectId),
            ),
          )
          .for('update')
          .limit(1);
        if (project === undefined) return 'not_found' as const;
        const [deletion] = await tx
          .select({ projectId: projectDeletions.projectId })
          .from(projectDeletions)
          .where(
            and(
              eq(projectDeletions.organizationId, input.organizationId),
              eq(projectDeletions.projectId, input.projectId),
            ),
          )
          .limit(1);
        if (deletion !== undefined) return 'deleting' as const;
        const [existing] = await tx
          .select({
            projectId: artifacts.projectId,
            storageRef: artifacts.storageRef,
            contentHash: artifacts.contentHash,
          })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.organizationId, input.organizationId),
              eq(artifacts.id, input.exportId),
              eq(artifacts.type, 'project_export_bundle'),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          return existing.projectId === input.projectId &&
            existing.storageRef === input.storageRef &&
            existing.contentHash === input.contentHash
            ? ('existing' as const)
            : ('conflict' as const);
        }
        await tx.insert(artifacts).values({
          id: input.exportId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: null,
          taskId: null,
          type: 'project_export_bundle',
          storageRef: input.storageRef,
          contentHash: input.contentHash,
          metadataJson: {
            formatVersion: 1,
            byteSize: input.byteSize,
            operationKey: input.operationKey,
          },
          createdAt: input.createdAt,
        });
        await input.audit(tx, { exportId: input.exportId });
        return 'created' as const;
      });
    },
  };
}
