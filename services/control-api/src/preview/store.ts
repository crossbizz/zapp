import { previewShares, type Database, type PreviewShareRow } from '@zapp/db';
import { and, desc, eq } from 'drizzle-orm';

import type { PreviewShareStore } from '../routes/preview.js';

export type StoredPreviewShare = PreviewShareRow;

/** Raw database access stays behind this tenant-explicit store; route modules receive the port. */
export function createDbPreviewShareStore(db: Database): PreviewShareStore {
  return {
    async byOperation(organizationId, operationKey) {
      const [row] = await db
        .select()
        .from(previewShares)
        .where(
          and(
            eq(previewShares.organizationId, organizationId),
            eq(previewShares.operationKey, operationKey),
          ),
        )
        .limit(1);
      return row;
    },
    async get(organizationId, shareId) {
      const [row] = await db
        .select()
        .from(previewShares)
        .where(and(eq(previewShares.organizationId, organizationId), eq(previewShares.id, shareId)))
        .limit(1);
      return row;
    },
    async list(organizationId, projectId) {
      return await db
        .select()
        .from(previewShares)
        .where(
          and(
            eq(previewShares.organizationId, organizationId),
            eq(previewShares.projectId, projectId),
          ),
        )
        .orderBy(desc(previewShares.id));
    },
    async create(row) {
      const [inserted] = await db
        .insert(previewShares)
        .values(row)
        .onConflictDoNothing({ target: [previewShares.organizationId, previewShares.operationKey] })
        .returning();
      if (inserted !== undefined) return inserted;
      const existing = await this.byOperation(row.organizationId, row.operationKey);
      if (existing === undefined) throw new Error('preview share create lost its operation row');
      return existing;
    },
    async revoke(organizationId, workspaceId, shareId, now) {
      const [updated] = await db
        .update(previewShares)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(previewShares.organizationId, organizationId),
            eq(previewShares.workspaceId, workspaceId),
            eq(previewShares.id, shareId),
          ),
        )
        .returning();
      return updated;
    },
  };
}
