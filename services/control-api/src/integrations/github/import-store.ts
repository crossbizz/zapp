import { CommitShaSchema, idSchema, newId } from '@zapp/contracts';
import {
  auditEvents,
  branches,
  githubImportOutbox,
  githubImports,
  repositories,
  type Database,
  type Executor,
} from '@zapp/db';
import { CapabilityScanOutputSchema } from '@zapp/project-adapters';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { TenantDbFactory } from '../../tenant/db.js';
import { NO_TRANSACTION } from '../../plugins/audit.js';
import {
  GitHubImportErrorCodeSchema,
  GitHubImportRowSchema,
  GitHubImportStatusValueSchema,
  GitHubRepositoryFullNameSchema,
} from './schemas.js';

export { GitHubImportErrorCodeSchema } from './schemas.js';

export const GitHubImportWorkerRecordSchema = GitHubImportRowSchema.extend({
  branchId: idSchema('br').nullable(),
}).strict();

export const GitHubImportReadInputSchema = z.object({ projectId: idSchema('proj') }).strict();
export const MarkGitHubImportMirroringInputSchema = GitHubImportReadInputSchema.extend({
  now: z.date(),
}).strict();
export const CompleteGitHubImportMirrorInputSchema = z
  .object({
    projectId: idSchema('proj'),
    externalRepoRef: GitHubRepositoryFullNameSchema,
    branch: z.string().trim().min(1).max(255),
    headCommitSha: CommitShaSchema,
    scanId: z.string().min(1),
    now: z.date(),
  })
  .strict();
export const GitHubImportFailureInputSchema = z
  .object({
    projectId: idSchema('proj'),
    errorCode: GitHubImportErrorCodeSchema,
    now: z.date(),
  })
  .strict();
export const CompleteGitHubImportScanInputSchema = z
  .object({ projectId: idSchema('proj'), output: CapabilityScanOutputSchema, now: z.date() })
  .strict();

export type GitHubImportStatus = z.infer<typeof GitHubImportStatusValueSchema>;
export type GitHubImportErrorCode = z.infer<typeof GitHubImportErrorCodeSchema>;
export type GitHubImportWorkerRecord = z.infer<typeof GitHubImportWorkerRecordSchema>;
export type CompleteGitHubImportMirrorInput = z.infer<
  typeof CompleteGitHubImportMirrorInputSchema
>;
export type CompleteGitHubImportScanInput = z.infer<typeof CompleteGitHubImportScanInputSchema>;

export interface GitHubImportWorkerStore {
  read(projectId: string): Promise<GitHubImportWorkerRecord | undefined>;
  markMirroring(projectId: string, now: Date): Promise<GitHubImportWorkerRecord | undefined>;
  completeMirror(input: CompleteGitHubImportMirrorInput): Promise<GitHubImportWorkerRecord>;
  recordRetryableFailure(
    projectId: string,
    errorCode: GitHubImportErrorCode,
    now: Date,
  ): Promise<void>;
  fail(projectId: string, errorCode: GitHubImportErrorCode, now: Date): Promise<void>;
  completeScan(input: CompleteGitHubImportScanInput): Promise<void>;
}

async function readRecord(
  executor: Executor,
  projectId: string,
): Promise<GitHubImportWorkerRecord | undefined> {
  const parsed = GitHubImportReadInputSchema.parse({ projectId });
  const [row] = await executor
    .select({
      projectId: githubImports.projectId,
      organizationId: githubImports.organizationId,
      installationId: githubImports.installationId,
      repo: githubImports.repo,
      branch: githubImports.branch,
      operationKey: githubImports.operationKey,
      status: githubImports.status,
      externalRepoRef: githubImports.externalRepoRef,
      headCommitSha: githubImports.headCommitSha,
      scanId: githubImports.scanId,
      errorCode: githubImports.errorCode,
      createdAt: githubImports.createdAt,
      updatedAt: githubImports.updatedAt,
      branchId: branches.id,
    })
    .from(githubImports)
    .leftJoin(
      branches,
      and(eq(branches.projectId, githubImports.projectId), eq(branches.name, githubImports.branch)),
    )
    .where(eq(githubImports.projectId, parsed.projectId))
    .limit(1);
  return row === undefined ? undefined : GitHubImportWorkerRecordSchema.parse(row);
}

export function createDbGitHubImportWorkerStore(input: {
  readonly database: Database;
  readonly tenantDb: TenantDbFactory;
}): GitHubImportWorkerStore {
  return {
    read(projectId) {
      const parsed = GitHubImportReadInputSchema.parse({ projectId });
      return readRecord(input.database, parsed.projectId);
    },
    async markMirroring(projectId, now) {
      const parsed = MarkGitHubImportMirroringInputSchema.parse({ projectId, now });
      return await input.database.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: githubImports.status })
          .from(githubImports)
          .where(eq(githubImports.projectId, parsed.projectId))
          .for('update')
          .limit(1);
        if (row?.status === 'queued') {
          await tx
            .update(githubImports)
            .set({ status: 'mirroring', errorCode: null, updatedAt: parsed.now })
            .where(eq(githubImports.projectId, parsed.projectId));
        }
        return await readRecord(tx, parsed.projectId);
      });
    },
    async completeMirror(rawInput) {
      const parsed = CompleteGitHubImportMirrorInputSchema.parse(rawInput);
      return await input.database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(githubImports)
          .where(eq(githubImports.projectId, parsed.projectId))
          .for('update')
          .limit(1);
        if (current === undefined) throw new Error('GitHub import disappeared');
        if (current.status === 'scan_pending' || current.status === 'scan_accepted') {
          const replay = await readRecord(tx, parsed.projectId);
          if (replay === undefined) throw new Error('GitHub import disappeared');
          return replay;
        }
        if (current.status !== 'mirroring') throw new Error('GitHub import is not mirroring');

        await tx
          .update(repositories)
          .set({
            externalRepoRef: parsed.externalRepoRef,
            defaultBranch: parsed.branch,
            syncPolicy: 'manual_push',
          })
          .where(
            and(
              eq(repositories.projectId, parsed.projectId),
              eq(repositories.organizationId, current.organizationId),
            ),
          );
        await tx
          .insert(branches)
          .values({
            id: newId('br'),
            organizationId: current.organizationId,
            projectId: parsed.projectId,
            name: parsed.branch,
            headCommitSha: parsed.headCommitSha,
            baseBranchId: null,
            status: 'active',
          })
          .onConflictDoUpdate({
            target: [branches.projectId, branches.name],
            set: { headCommitSha: parsed.headCommitSha, status: 'active' },
          });
        await tx
          .update(githubImports)
          .set({
            status: 'scan_pending',
            externalRepoRef: parsed.externalRepoRef,
            headCommitSha: parsed.headCommitSha,
            scanId: parsed.scanId,
            errorCode: null,
            updatedAt: parsed.now,
          })
          .where(eq(githubImports.projectId, parsed.projectId));
        await tx
          .insert(githubImportOutbox)
          .values({
            projectId: parsed.projectId,
            stage: 'scan_pending',
            status: 'pending',
            attempts: 0,
            nextAttemptAt: parsed.now,
            createdAt: parsed.now,
            publishedAt: null,
          })
          .onConflictDoNothing({
            target: [githubImportOutbox.projectId, githubImportOutbox.stage],
          });
        const completed = await readRecord(tx, parsed.projectId);
        if (completed === undefined) throw new Error('GitHub import disappeared');
        return completed;
      });
    },
    async recordRetryableFailure(projectId, errorCode, now) {
      const parsed = GitHubImportFailureInputSchema.parse({ projectId, errorCode, now });
      await input.database
        .update(githubImports)
        .set({ errorCode: parsed.errorCode, updatedAt: parsed.now })
        .where(
          and(
            eq(githubImports.projectId, parsed.projectId),
            eq(
              githubImports.status,
              parsed.errorCode === 'scan_unavailable' ? 'scan_pending' : 'mirroring',
            ),
          ),
        );
    },
    async fail(projectId, errorCode, now) {
      const parsed = GitHubImportFailureInputSchema.parse({ projectId, errorCode, now });
      const eligibleStatuses =
        parsed.errorCode === 'scan_unavailable'
          ? ['scan_pending']
          : parsed.errorCode === 'repository_not_found' || parsed.errorCode === 'branch_not_found'
            ? ['mirroring']
            : ['queued', 'mirroring'];
      await input.database
        .update(githubImports)
        .set({ status: 'failed', errorCode: parsed.errorCode, updatedAt: parsed.now })
        .where(
          and(
            eq(githubImports.projectId, parsed.projectId),
            inArray(githubImports.status, eligibleStatuses),
          ),
        );
    },
    async completeScan(rawInput) {
      const parsed = CompleteGitHubImportScanInputSchema.parse(rawInput);
      const current = await readRecord(input.database, parsed.projectId);
      if (current === undefined) throw new Error('GitHub import disappeared');
      if (current.status === 'scan_accepted') return;
      if (current.status !== 'scan_pending' || current.scanId === null) {
        throw new Error('GitHub import is not awaiting a scan');
      }
      const tenant = input.tenantDb(current.organizationId);
      const recorded = await tenant.contracts.recordScan({
        projectId: current.projectId,
        scanId: current.scanId,
        result: parsed.output.result,
        reportArtifact: parsed.output.reportArtifact,
        createdAt: parsed.now,
        audit: async (tx) => {
          if (tx === NO_TRANSACTION) throw new Error('GitHub import scan requires a transaction');
          await tx.insert(auditEvents).values({
            id: newId('aud'),
            organizationId: current.organizationId,
            actorType: 'service',
            actorId: 'control-api',
            action: 'project.scan_requested',
            targetType: 'project',
            targetId: current.projectId,
            metadataJson: { scanId: current.scanId },
            occurredAt: parsed.now,
          });
        },
      });
      if (recorded === undefined) throw new Error('GitHub import project disappeared');
      await input.database
        .update(githubImports)
        .set({ status: 'scan_accepted', errorCode: null, updatedAt: parsed.now })
        .where(
          and(
            eq(githubImports.projectId, parsed.projectId),
            eq(githubImports.status, 'scan_pending'),
          ),
        );
    },
  };
}
