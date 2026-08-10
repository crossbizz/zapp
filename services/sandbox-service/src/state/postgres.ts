import { randomUUID } from 'node:crypto';

import {
  branches,
  projects,
  workspaces,
  type Database,
  type Workspace,
} from '@zapp/db';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';

import { ModalWorkspaceAttachmentSchema } from '../provider/modal.js';
import {
  WorkspaceLifecycleRowSchema,
  WorkspaceRowIdempotencyKeySchema,
  type PreviewMonitorCoordinator,
  type WorkspaceAttachmentRecord,
  type WorkspaceLifecycleRow,
  type WorkspaceRowBoundary,
  type WorkspaceRowClaim,
} from '../routes/workspaces.js';

const CREATE_REPLAY_WAIT_MS = 30_000;
const CREATE_REPLAY_POLL_MS = 25;

function lifecycleRow(row: Workspace): WorkspaceLifecycleRow {
  return WorkspaceLifecycleRowSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    branchId: row.branchId,
    provider: row.provider,
    providerWorkspaceId: row.providerWorkspaceId,
    status: row.status,
    resourceProfile: row.resourceProfile,
    snapshotRef: row.snapshotRef,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    terminatedAt: row.terminatedAt,
  });
}

function attachmentRecord(row: Workspace): WorkspaceAttachmentRecord | undefined {
  if (
    row.runId === null ||
    row.taskId === null ||
    row.purpose === null ||
    row.environment === null ||
    row.imageTag === null ||
    row.branchId === null
  ) {
    return undefined;
  }
  return {
    row: lifecycleRow(row),
    attachment: ModalWorkspaceAttachmentSchema.parse({
      resourceProfile: row.resourceProfile,
      imageTag: row.imageTag,
      createdAt: row.createdAt,
      requiredTags: {
        org_id: row.organizationId,
        project_id: row.projectId,
        branch_id: row.branchId,
        run_id: row.runId,
        task_id: row.taskId,
        purpose: row.purpose,
        environment: row.environment,
      },
    }),
  };
}

function sameAttachment(
  left: WorkspaceAttachmentRecord['attachment'],
  right: WorkspaceAttachmentRecord['attachment'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The authoritative workspace row remains CP-9's record. This adapter only
 * supplies the sandbox-service mutation boundary that CP-9 invokes: durable
 * attachment attribution and a renewable preview-observer lease live on that
 * same row, so a process restart cannot lose either fact.
 */
export function createPostgresWorkspaceStateStore(
  database: Database,
  now: () => Date = () => new Date(),
): WorkspaceRowBoundary & PreviewMonitorCoordinator {
  const getUnscoped = async (workspaceId: string): Promise<Workspace | undefined> => {
    const [row] = await database
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row;
  };

  const store: WorkspaceRowBoundary & PreviewMonitorCoordinator = {
    async projectOwnedBy(projectId, organizationId) {
      const [row] = await database
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
        .limit(1);
      return row !== undefined;
    },

    async claimCreate(untrustedRow, untrustedKey, untrustedAttachment): Promise<WorkspaceRowClaim> {
      const row = WorkspaceLifecycleRowSchema.parse(untrustedRow);
      const key = WorkspaceRowIdempotencyKeySchema.parse(untrustedKey);
      const attachment = ModalWorkspaceAttachmentSchema.parse(untrustedAttachment);
      if (
        row.status !== 'requested' ||
        row.providerWorkspaceId !== null ||
        row.branchId !== key.branchId ||
        attachment.requiredTags.org_id !== row.organizationId ||
        attachment.requiredTags.project_id !== row.projectId ||
        attachment.requiredTags.branch_id !== row.branchId ||
        attachment.requiredTags.run_id !== key.runId ||
        attachment.requiredTags.task_id !== key.taskId ||
        attachment.requiredTags.purpose !== key.purpose ||
        attachment.resourceProfile !== row.resourceProfile ||
        attachment.createdAt.getTime() !== row.createdAt.getTime()
      ) {
        throw new Error('Workspace attachment does not match the durable create intent.');
      }

      const claimed = await database.transaction(async (tx) => {
        const [branch] = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(
            and(
              eq(branches.id, key.branchId),
              eq(branches.organizationId, row.organizationId),
              eq(branches.projectId, row.projectId),
              eq(branches.name, key.branchName),
            ),
          )
          .limit(1);
        if (branch === undefined) {
          throw new Error('Workspace branch does not match the durable create intent.');
        }
        const [created] = await tx
          .update(workspaces)
          .set({
            runId: key.runId,
            taskId: key.taskId,
            purpose: key.purpose,
            environment: attachment.requiredTags.environment,
            imageTag: attachment.imageTag,
          })
          .where(
            and(
              eq(workspaces.id, row.id),
              eq(workspaces.organizationId, row.organizationId),
              eq(workspaces.projectId, row.projectId),
              eq(workspaces.branchId, key.branchId),
              eq(workspaces.status, 'requested'),
              isNull(workspaces.providerWorkspaceId),
              isNull(workspaces.runId),
              isNull(workspaces.taskId),
              isNull(workspaces.purpose),
              isNull(workspaces.environment),
              isNull(workspaces.imageTag),
            ),
          )
          .returning();
        return created;
      });
      if (claimed !== undefined) return { created: true, row: lifecycleRow(claimed) };

      const deadline = Date.now() + CREATE_REPLAY_WAIT_MS;
      for (;;) {
        const current = await getUnscoped(row.id);
        const record = current === undefined ? undefined : attachmentRecord(current);
        if (
          record === undefined ||
          record.row.organizationId !== row.organizationId ||
          record.row.projectId !== row.projectId ||
          !sameAttachment(record.attachment, attachment)
        ) {
          throw new Error('Workspace create intent conflicts with its durable attachment.');
        }
        if (record.row.status === 'ready' || record.row.status === 'terminated') {
          return { created: false, row: record.row };
        }
        if (Date.now() >= deadline) {
          throw new Error('Original workspace creation did not reach a terminal create state.');
        }
        await wait(CREATE_REPLAY_POLL_MS);
      }
    },

    async bindProviderWorkspaceId(workspaceId, providerWorkspaceId, expectedStatus) {
      const [updated] = await database
        .update(workspaces)
        .set({ providerWorkspaceId })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.status, expectedStatus),
            or(isNull(workspaces.providerWorkspaceId), eq(workspaces.providerWorkspaceId, providerWorkspaceId)),
          ),
        )
        .returning();
      const current = updated ?? (await getUnscoped(workspaceId));
      if (current === undefined) throw new Error('Workspace was not found.');
      return lifecycleRow(current);
    },

    async get(workspaceId, organizationId, projectId) {
      const [row] = await database
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.organizationId, organizationId),
            eq(workspaces.projectId, projectId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : lifecycleRow(row);
    },

    async getAttachment(workspaceId, organizationId, projectId) {
      const [row] = await database
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.organizationId, organizationId),
            eq(workspaces.projectId, projectId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : attachmentRecord(row);
    },

    async listAttachments() {
      const rows = await database
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.status, 'ready'),
            eq(workspaces.previewMonitorEnabled, true),
            isNull(workspaces.terminatedAt),
          ),
        );
      return rows.flatMap((row) => {
        const record = attachmentRecord(row);
        return record === undefined || record.row.providerWorkspaceId === null ? [] : [record];
      });
    },

    async transition(workspaceId, status, patch = {}, expectedStatus) {
      const [updated] = await database
        .update(workspaces)
        .set({
          status,
          ...(patch.providerWorkspaceId === undefined
            ? {}
            : { providerWorkspaceId: patch.providerWorkspaceId }),
          ...(patch.terminatedAt === undefined ? {} : { terminatedAt: patch.terminatedAt }),
          ...(status === 'terminated'
            ? {
                previewMonitorEnabled: false,
                previewMonitorOwnerId: null,
                previewMonitorLeaseExpiresAt: null,
              }
            : {}),
        })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            ...(expectedStatus === undefined ? [] : [eq(workspaces.status, expectedStatus)]),
          ),
        )
        .returning();
      const current = updated ?? (await getUnscoped(workspaceId));
      if (current === undefined) throw new Error('Workspace was not found.');
      return lifecycleRow(current);
    },

    async activateAndClaim(workspaceId, ownerId, leaseMs) {
      const instant = now();
      const leaseToken = `${ownerId}:${randomUUID()}`;
      const [claimed] = await database
        .update(workspaces)
        .set({
          previewMonitorEnabled: true,
          previewMonitorOwnerId: leaseToken,
          previewMonitorLeaseExpiresAt: new Date(instant.getTime() + leaseMs),
        })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.status, 'ready'),
            or(
              eq(workspaces.previewMonitorEnabled, false),
              isNull(workspaces.previewMonitorOwnerId),
              lte(workspaces.previewMonitorLeaseExpiresAt, instant),
            ),
          ),
        )
        .returning({ id: workspaces.id });
      return claimed === undefined ? undefined : leaseToken;
    },

    async claim(workspaceId, ownerId, leaseMs) {
      const instant = now();
      const leaseToken = `${ownerId}:${randomUUID()}`;
      const [claimed] = await database
        .update(workspaces)
        .set({
          previewMonitorOwnerId: leaseToken,
          previewMonitorLeaseExpiresAt: new Date(instant.getTime() + leaseMs),
        })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.status, 'ready'),
            eq(workspaces.previewMonitorEnabled, true),
            or(
              isNull(workspaces.previewMonitorOwnerId),
              lte(workspaces.previewMonitorLeaseExpiresAt, instant),
            ),
          ),
        )
        .returning({ id: workspaces.id });
      return claimed === undefined ? undefined : leaseToken;
    },

    async renew(workspaceId, leaseToken, leaseMs) {
      const instant = now();
      const [renewed] = await database
        .update(workspaces)
        .set({ previewMonitorLeaseExpiresAt: new Date(instant.getTime() + leaseMs) })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.status, 'ready'),
            eq(workspaces.previewMonitorEnabled, true),
            eq(workspaces.previewMonitorOwnerId, leaseToken),
            gt(workspaces.previewMonitorLeaseExpiresAt, instant),
          ),
        )
        .returning({ id: workspaces.id });
      return renewed !== undefined;
    },

    async complete(workspaceId, leaseToken) {
      const instant = now();
      const [completed] = await database
        .update(workspaces)
        .set({
          previewMonitorEnabled: false,
          previewMonitorOwnerId: null,
          previewMonitorLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.status, 'ready'),
            eq(workspaces.previewMonitorEnabled, true),
            eq(workspaces.previewMonitorOwnerId, leaseToken),
            gt(workspaces.previewMonitorLeaseExpiresAt, instant),
          ),
        )
        .returning({ id: workspaces.id });
      return completed !== undefined;
    },

    async revoke(workspaceId) {
      await database
        .update(workspaces)
        .set({
          previewMonitorEnabled: false,
          previewMonitorOwnerId: null,
          previewMonitorLeaseExpiresAt: null,
        })
        .where(eq(workspaces.id, workspaceId));
    },

    async release(workspaceId, leaseToken) {
      await database
        .update(workspaces)
        .set({ previewMonitorOwnerId: null, previewMonitorLeaseExpiresAt: null })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.previewMonitorOwnerId, leaseToken),
          ),
        );
    },
  };
  return store;
}
