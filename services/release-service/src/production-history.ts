import { idSchema, newId } from '@zapp/contracts';
import {
  deployments,
  environments,
  productionHealthResults,
  releaseAnnotations,
  releases,
  syntheticCheckResults,
  type Database,
} from '@zapp/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { ProductionHealthResultSchema } from './release/health.js';

const HealthRecordSchema = z
  .object({
    organizationId: idSchema('org'), projectId: idSchema('proj'), environmentId: idSchema('env'),
    releaseId: idSchema('rel'), deploymentId: idSchema('dep'),
    result: ProductionHealthResultSchema, occurredAt: z.string().datetime(),
  })
  .strict();
const SyntheticRecordSchema = z
  .object({
    organizationId: idSchema('org'), projectId: idSchema('proj'), environmentId: idSchema('env'),
    releaseId: idSchema('rel'), syntheticCheckId: idSchema('syn'),
    status: z.enum(['passed', 'failed']), summary: z.string().min(1).max(2_000),
    evidenceArtifactIds: z.array(idSchema('art')).max(1_000),
    completedAt: z.string().datetime(), retainUntil: z.string().datetime(),
  })
  .strict();
export const AnnotationRecordSchema = z
  .object({
    organizationId: idSchema('org'), projectId: idSchema('proj'), releaseId: idSchema('rel'),
    deploymentId: idSchema('dep').nullable(), provider: z.enum(['grafana', 'posthog']),
    kind: z.string().min(1).max(100), link: z.string().url(), occurredAt: z.string().datetime(),
  })
  .strict();

const DeploymentViewSchema = z.object({
  id: idSchema('dep'), releaseId: idSchema('rel'), commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
  status: z.string().min(1), url: z.string().url().nullable(), startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(), rollbackOfDeploymentId: idSchema('dep').nullable(),
}).strict();
const HealthViewSchema = z.object({
  id: idSchema('vr'), releaseId: idSchema('rel'), deploymentId: idSchema('dep'),
  status: z.enum(['healthy', 'failed']), evidenceArtifactId: idSchema('art'),
  result: ProductionHealthResultSchema, occurredAt: z.string().datetime(),
}).strict();
const SyntheticViewSchema = z.object({
  id: idSchema('trun'), releaseId: idSchema('rel'), syntheticCheckId: idSchema('syn'),
  status: z.enum(['passed', 'failed']), summary: z.string().min(1),
  evidenceArtifactIds: z.array(idSchema('art')).max(1_000), completedAt: z.string().datetime(),
}).strict();
const AnnotationViewSchema = AnnotationRecordSchema.omit({ organizationId: true, projectId: true }).extend({ id: idSchema('aud') }).strict();

export const ProductionHistorySchema = z.object({
  deployments: z.array(DeploymentViewSchema).max(100),
  health: z.array(HealthViewSchema).max(100),
  synthetics: z.array(SyntheticViewSchema).max(100),
  annotations: z.array(AnnotationViewSchema).max(100),
  healthyTargets: z.array(DeploymentViewSchema).max(100),
}).strict();
export type ProductionHistory = z.infer<typeof ProductionHistorySchema>;

export interface ProductionProjectionPort {
  recordHealth(input: z.infer<typeof HealthRecordSchema>): Promise<void>;
  recordSynthetic(input: z.infer<typeof SyntheticRecordSchema>): Promise<void>;
  recordAnnotation(input: z.infer<typeof AnnotationRecordSchema>): Promise<void>;
  get(input: { organizationId: string; projectId: string }): Promise<ProductionHistory>;
}

export function createPostgresProductionProjection(database: Database): ProductionProjectionPort {
  return {
    async recordHealth(rawInput) {
      const input = HealthRecordSchema.parse(rawInput);
      await database.insert(productionHealthResults).values({
        id: newId('vr'), organizationId: input.organizationId, projectId: input.projectId,
        environmentId: input.environmentId, releaseId: input.releaseId,
        deploymentId: input.deploymentId, status: input.result.status,
        evidenceArtifactId: input.result.evidenceArtifactId, resultJson: input.result,
        occurredAt: new Date(input.occurredAt),
      }).onConflictDoNothing();
    },
    async recordSynthetic(rawInput) {
      const input = SyntheticRecordSchema.parse(rawInput);
      await database.insert(syntheticCheckResults).values({
        id: newId('trun'), organizationId: input.organizationId, projectId: input.projectId,
        environmentId: input.environmentId, releaseId: input.releaseId,
        syntheticCheckId: input.syntheticCheckId, status: input.status, summary: input.summary,
        evidenceArtifactIdsJson: input.evidenceArtifactIds,
        completedAt: new Date(input.completedAt), retainUntil: new Date(input.retainUntil),
      }).onConflictDoNothing();
    },
    async recordAnnotation(rawInput) {
      const input = AnnotationRecordSchema.parse(rawInput);
      await database.insert(releaseAnnotations).values({
        id: newId('aud'), organizationId: input.organizationId, projectId: input.projectId,
        releaseId: input.releaseId, deploymentId: input.deploymentId, provider: input.provider,
        kind: input.kind, link: input.link, occurredAt: new Date(input.occurredAt),
      }).onConflictDoNothing();
    },
    async get(rawInput) {
      const input = z.object({ organizationId: idSchema('org'), projectId: idSchema('proj') }).strict().parse(rawInput);
      const deploymentRows = await database.select({ deployment: deployments, release: releases })
        .from(deployments).innerJoin(releases, eq(releases.id, deployments.releaseId))
        .innerJoin(environments, eq(environments.id, releases.environmentId))
        .where(and(eq(deployments.organizationId, input.organizationId), eq(releases.organizationId, input.organizationId), eq(releases.projectId, input.projectId), eq(environments.type, 'production')))
        .orderBy(desc(deployments.startedAt)).limit(100);
      const healthRows = await database.select().from(productionHealthResults)
        .where(and(eq(productionHealthResults.organizationId, input.organizationId), eq(productionHealthResults.projectId, input.projectId)))
        .orderBy(desc(productionHealthResults.occurredAt)).limit(100);
      const syntheticRows = await database.select().from(syntheticCheckResults)
        .where(and(eq(syntheticCheckResults.organizationId, input.organizationId), eq(syntheticCheckResults.projectId, input.projectId)))
        .orderBy(desc(syntheticCheckResults.completedAt)).limit(100);
      const annotationRows = await database.select().from(releaseAnnotations)
        .where(and(eq(releaseAnnotations.organizationId, input.organizationId), eq(releaseAnnotations.projectId, input.projectId)))
        .orderBy(desc(releaseAnnotations.occurredAt)).limit(100);
      const deploymentView = ({ deployment, release }: (typeof deploymentRows)[number]) => ({
        id: deployment.id, releaseId: release.id, commitSha: release.commitSha,
        status: deployment.status, url: deployment.url, startedAt: deployment.startedAt.toISOString(),
        completedAt: deployment.completedAt?.toISOString() ?? null,
        rollbackOfDeploymentId: deployment.rollbackOfDeploymentId,
      });
      const allDeployments = deploymentRows.map(deploymentView);
      return ProductionHistorySchema.parse({
        deployments: allDeployments,
        healthyTargets: allDeployments.filter(({ status }) => status === 'healthy'),
        health: healthRows.map((row) => ({ id: row.id, releaseId: row.releaseId,
          deploymentId: row.deploymentId, status: row.status, evidenceArtifactId: row.evidenceArtifactId,
          result: row.resultJson, occurredAt: row.occurredAt.toISOString() })),
        synthetics: syntheticRows.map((row) => ({ id: row.id, releaseId: row.releaseId,
          syntheticCheckId: row.syntheticCheckId, status: row.status, summary: row.summary,
          evidenceArtifactIds: row.evidenceArtifactIdsJson, completedAt: row.completedAt.toISOString() })),
        annotations: annotationRows.map((row) => ({ id: row.id, releaseId: row.releaseId,
          deploymentId: row.deploymentId, provider: row.provider, kind: row.kind,
          link: row.link, occurredAt: row.occurredAt.toISOString() })),
      });
    },
  };
}
