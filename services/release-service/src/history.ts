import { SupportLevelSchema, idSchema } from '@zapp/contracts';
import { deployments, environments, projects, releases, type Database } from '@zapp/db';
import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';

const DeploymentHistorySchema = z
  .object({
    id: idSchema('dep'),
    provider: z.string().min(1),
    providerDeploymentId: z.string().nullable(),
    status: z.string().min(1),
    url: z.string().url().nullable(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    rollbackOfDeploymentId: idSchema('dep').nullable(),
  })
  .strict();

export const ReleaseHistoryItemSchema = z
  .object({
    id: idSchema('rel'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    status: z.string().min(1),
    supportLevel: SupportLevelSchema,
    activeProduction: z.boolean(),
    createdAt: z.string().datetime(),
    deployments: z.array(DeploymentHistorySchema).max(100),
    evidenceArtifactId: idSchema('art').nullable(),
  })
  .strict();

export const RollbackTargetSchema = DeploymentHistorySchema.extend({
  releaseId: idSchema('rel'),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();

export const ReleaseHistoryPageSchema = z
  .object({
    items: z.array(ReleaseHistoryItemSchema).max(50),
    rollbackTargets: z.array(RollbackTargetSchema).max(100),
    nextCursor: idSchema('rel').nullable(),
  })
  .strict();

export const ReleaseHistoryInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    cursor: idSchema('rel').nullable().default(null),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export type ReleaseHistoryPage = z.infer<typeof ReleaseHistoryPageSchema>;
export type ReleaseHistoryInput = z.infer<typeof ReleaseHistoryInputSchema>;

export interface ReleaseHistoryPort {
  list(input: ReleaseHistoryInput): Promise<ReleaseHistoryPage>;
}

function deploymentView(row: typeof deployments.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    providerDeploymentId: row.providerDeploymentId,
    status: row.status,
    url: row.url,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    rollbackOfDeploymentId: row.rollbackOfDeploymentId,
  };
}

export function createPostgresReleaseHistory(database: Database): ReleaseHistoryPort {
  return {
    async list(rawInput) {
      const input = ReleaseHistoryInputSchema.parse(rawInput);
      const pageRows = await database
        .select({ release: releases, supportLevel: projects.supportLevel })
        .from(releases)
        .innerJoin(
          projects,
          and(
            eq(projects.id, releases.projectId),
            eq(projects.organizationId, releases.organizationId),
          ),
        )
        .where(
          and(
            eq(releases.organizationId, input.organizationId),
            eq(releases.projectId, input.projectId),
            input.cursor === null ? undefined : lt(releases.id, input.cursor),
          ),
        )
        .orderBy(desc(releases.id))
        .limit(input.limit + 1);
      const visible = pageRows.slice(0, input.limit);
      const releaseIds = visible.map(({ release }) => release.id);
      const deploymentRows =
        releaseIds.length === 0
          ? []
          : await database
              .select()
              .from(deployments)
              .where(
                and(
                  eq(deployments.organizationId, input.organizationId),
                  inArray(deployments.releaseId, releaseIds),
                ),
              )
              .orderBy(desc(deployments.startedAt))
              .limit(input.limit * 100);
      const production = await database
        .select({ releaseId: releases.id })
        .from(deployments)
        .innerJoin(releases, eq(releases.id, deployments.releaseId))
        .innerJoin(environments, eq(environments.id, releases.environmentId))
        .where(
          and(
            eq(releases.organizationId, input.organizationId),
            eq(releases.projectId, input.projectId),
            eq(deployments.organizationId, input.organizationId),
            eq(environments.type, 'production'),
            eq(deployments.status, 'healthy'),
            isNotNull(deployments.completedAt),
          ),
        )
        .orderBy(desc(deployments.completedAt), desc(deployments.id))
        .limit(1);
      const targets = await database
        .select({ deployment: deployments, releaseId: releases.id, commitSha: releases.commitSha })
        .from(deployments)
        .innerJoin(releases, eq(releases.id, deployments.releaseId))
        .where(
          and(
            eq(releases.organizationId, input.organizationId),
            eq(releases.projectId, input.projectId),
            eq(deployments.organizationId, input.organizationId),
            eq(deployments.status, 'healthy'),
            isNotNull(deployments.completedAt),
          ),
        )
        .orderBy(desc(deployments.completedAt), desc(deployments.id))
        .limit(100);

      return ReleaseHistoryPageSchema.parse({
        items: visible.map(({ release, supportLevel }) => ({
          id: release.id,
          projectId: release.projectId,
          environmentId: release.environmentId,
          commitSha: release.commitSha,
          status: release.status,
          supportLevel,
          activeProduction: production[0]?.releaseId === release.id,
          createdAt: release.createdAt.toISOString(),
          deployments: deploymentRows
            .filter((deployment) => deployment.releaseId === release.id)
            .slice(0, 100)
            .map(deploymentView),
          evidenceArtifactId: release.evidenceManifestArtifactId,
        })),
        rollbackTargets: targets.map(({ deployment, releaseId, commitSha }) => ({
          ...deploymentView(deployment),
          releaseId,
          commitSha,
        })),
        nextCursor: pageRows.length > input.limit ? (visible.at(-1)?.release.id ?? null) : null,
      });
    },
  };
}
