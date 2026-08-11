import { CommitShaSchema, HttpsUrlSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

const ApiPostActionSchema = z
  .object({
    method: z.literal('POST'),
    href: z.string().regex(/^\/v1\//u),
  })
  .strict();

const MonitoringLinksSchema = z
  .object({
    grafanaDashboardLinks: z.array(HttpsUrlSchema).max(100),
    faroAppLink: HttpsUrlSchema,
    posthogAnnotationLink: HttpsUrlSchema,
  })
  .strict();

const PreviousHealthyReleaseInputSchema = z
  .object({
    releaseId: idSchema('rel'),
    deploymentId: idSchema('dep'),
    commitSha: CommitShaSchema,
  })
  .strict();

export const DeploymentSuccessInputSchema = z
  .object({
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    permanentUrl: HttpsUrlSchema,
    productionHealthStatus: z.literal('healthy'),
    monitoring: MonitoringLinksSchema,
    previousHealthyRelease: PreviousHealthyReleaseInputSchema.nullable(),
  })
  .strict();
export type DeploymentSuccessInput = z.infer<typeof DeploymentSuccessInputSchema>;

const RollbackActionSchema = ApiPostActionSchema.extend({
  body: z.object({ toDeploymentId: idSchema('dep') }).strict(),
}).strict();

const PreviousHealthyReleaseSchema = PreviousHealthyReleaseInputSchema.extend({
  rollbackAction: RollbackActionSchema,
}).strict();

export const DeploymentSuccessSchema = z
  .object({
    status: z.literal('succeeded'),
    permanentUrl: HttpsUrlSchema,
    customDomainAction: ApiPostActionSchema,
    release: z
      .object({
        id: idSchema('rel'),
        commitSha: CommitShaSchema,
      })
      .strict(),
    evidence: z
      .object({
        statusLink: z.string().regex(/^\/v1\/releases\/rel_[0-9A-HJKMNP-TV-Z]{26}\/evidence$/u),
      })
      .strict(),
    productionHealth: z.object({ status: z.literal('healthy') }).strict(),
    monitoring: MonitoringLinksSchema,
    previousHealthyRelease: PreviousHealthyReleaseSchema.nullable(),
    previewChanges: z
      .object({
        requireRedeploy: z.literal(true),
        note: z.literal(
          'Preview changes require a new release and redeploy before they reach production.',
        ),
      })
      .strict(),
  })
  .strict();
export type DeploymentSuccess = z.infer<typeof DeploymentSuccessSchema>;

export function assembleDeploymentSuccess(inputValue: unknown): DeploymentSuccess {
  const input = DeploymentSuccessInputSchema.parse(inputValue);
  return DeploymentSuccessSchema.parse({
    status: 'succeeded',
    permanentUrl: input.permanentUrl,
    customDomainAction: {
      method: 'POST',
      href: `/v1/projects/${input.projectId}/domains`,
    },
    release: { id: input.releaseId, commitSha: input.commitSha },
    evidence: { statusLink: `/v1/releases/${input.releaseId}/evidence` },
    productionHealth: { status: input.productionHealthStatus },
    monitoring: input.monitoring,
    previousHealthyRelease:
      input.previousHealthyRelease === null
        ? null
        : {
            ...input.previousHealthyRelease,
            rollbackAction: {
              method: 'POST',
              href: `/v1/releases/${input.releaseId}/rollback`,
              body: { toDeploymentId: input.previousHealthyRelease.deploymentId },
            },
          },
    previewChanges: {
      requireRedeploy: true,
      note: 'Preview changes require a new release and redeploy before they reach production.',
    },
  });
}
