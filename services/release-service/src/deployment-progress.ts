import { newId, idSchema } from '@zapp/contracts';
import {
  deploymentActionRequests,
  deploymentEvents,
  deployments,
  releases,
  type Database,
} from '@zapp/db';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { DeploymentSuccessSchema } from './release/success.js';
import {
  DEPLOYMENT_STAGES,
  DeploymentStageSchema,
  DeploymentUpdatedPayloadSchema,
  EmitDeploymentUpdatedActivityInputSchema,
} from './workflows/deploy.js';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const ActorSchema = z.object({ id: idSchema('user'), organizationId: idSchema('org') }).strict();

export const AppendDeploymentEventSchema = z
  .object({
    organizationId: idSchema('org'),
    deploymentId: idSchema('dep'),
    sequence: z.number().int().nonnegative(),
    payload: DeploymentUpdatedPayloadSchema,
    terminalSuccess: DeploymentSuccessSchema.nullable().default(null),
    occurredAt: z.string().datetime(),
  })
  .strict();

export const DeploymentProgressEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    stage: DeploymentStageSchema,
    status: z.enum(['running', 'passed', 'failed']),
    elapsedMs: z.number().int().nonnegative(),
    summary: z.string().min(1).max(500),
    evidenceArtifactId: idSchema('art').nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();

export const DeploymentProgressSchema = z
  .object({
    deploymentId: idSchema('dep'),
    releaseId: idSchema('rel'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    status: z.string().min(1),
    url: z.string().url().nullable(),
    events: z.array(DeploymentProgressEventSchema).max(100),
    terminalSuccess: DeploymentSuccessSchema.nullable(),
  })
  .strict();

const DeploymentActionObjectSchema = z
  .object({
    organizationId: idSchema('org'),
    resourceType: z.enum(['release', 'deployment']),
    resourceId: z.union([idSchema('rel'), idSchema('dep')]),
    action: z.enum(['fix', 'review', 'waive', 'retry', 'ask']),
    actor: ActorSchema,
    operationKey: OperationKeySchema,
    payload: z.record(z.unknown()),
  })
  .strict();
export const DeploymentActionBodySchema = DeploymentActionObjectSchema.omit({
  resourceType: true,
  resourceId: true,
}).strict();
export const DeploymentActionInputSchema = DeploymentActionObjectSchema
  .superRefine((input, context) => {
    const expectedPrefix = input.resourceType === 'release' ? 'rel_' : 'dep_';
    if (!input.resourceId.startsWith(expectedPrefix)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['resourceId'], message: 'resource identity does not match resourceType' });
    }
  });

export type DeploymentProgress = z.infer<typeof DeploymentProgressSchema>;
export type DeploymentActionInput = z.infer<typeof DeploymentActionInputSchema>;

export interface DeploymentActionDispatcher {
  dispatch(input: DeploymentActionInput): Promise<void>;
}

export interface DeploymentProgressPort {
  append(input: z.infer<typeof AppendDeploymentEventSchema>): Promise<DeploymentProgress>;
  get(input: { organizationId: string; deploymentId: string }): Promise<DeploymentProgress | undefined>;
  act(input: DeploymentActionInput): Promise<{ status: 'dispatched' }>;
}

function progressEvent(row: typeof deploymentEvents.$inferSelect) {
  return DeploymentProgressEventSchema.parse({
    sequence: row.sequence,
    stage: row.stage,
    status: row.status,
    elapsedMs: row.elapsedMs,
    summary: row.summary,
    evidenceArtifactId: row.evidenceArtifactId,
    occurredAt: row.occurredAt.toISOString(),
  });
}

export function createPostgresDeploymentProgress(
  database: Database,
  dispatcher: DeploymentActionDispatcher,
): DeploymentProgressPort {
  async function get(raw: { organizationId: string; deploymentId: string }) {
    const input = z
      .object({ organizationId: idSchema('org'), deploymentId: idSchema('dep') })
      .strict()
      .parse(raw);
    const [deployment] = await database
      .select({ deployment: deployments, projectId: releases.projectId, environmentId: releases.environmentId })
      .from(deployments)
      .innerJoin(releases, and(eq(releases.id, deployments.releaseId), eq(releases.organizationId, input.organizationId)))
      .where(and(eq(deployments.organizationId, input.organizationId), eq(deployments.id, input.deploymentId)))
      .limit(1);
    if (deployment === undefined) return undefined;
    const eventRows = await database
      .select()
      .from(deploymentEvents)
      .where(
        and(
          eq(deploymentEvents.organizationId, input.organizationId),
          eq(deploymentEvents.deploymentId, input.deploymentId),
        ),
      )
      .orderBy(asc(deploymentEvents.sequence))
      .limit(100);
    const terminal = [...eventRows].reverse().find((event) => event.terminalSuccessJson !== null);
    return DeploymentProgressSchema.parse({
      deploymentId: deployment.deployment.id,
      releaseId: deployment.deployment.releaseId,
      projectId: deployment.projectId,
      environmentId: deployment.environmentId,
      status: deployment.deployment.status,
      url: deployment.deployment.url,
      events: eventRows.map(progressEvent),
      terminalSuccess: terminal?.terminalSuccessJson ?? null,
    });
  }

  return {
    async append(rawInput) {
      const input = AppendDeploymentEventSchema.parse(rawInput);
      const existing = await get(input);
      if (existing === undefined) throw new Error('deployment_not_found');
      if (
        input.terminalSuccess !== null &&
        (input.payload.stage !== 'go_live' ||
          input.payload.status !== 'passed' ||
          input.terminalSuccess.release.id !== existing.releaseId ||
          input.terminalSuccess.customDomainAction.href !==
            `/v1/projects/${existing.projectId}/domains`)
      ) {
        throw new Error('deployment_terminal_success_identity_mismatch');
      }
      await database
        .insert(deploymentEvents)
        .values({
          id: newId('evt'),
          organizationId: input.organizationId,
          deploymentId: input.deploymentId,
          sequence: input.sequence,
          stage: input.payload.stage,
          status: input.payload.status,
          elapsedMs: input.payload.elapsedMs,
          summary: input.payload.summary,
          evidenceArtifactId: input.payload.evidenceArtifactId ?? null,
          terminalSuccessJson: input.terminalSuccess,
          occurredAt: new Date(input.occurredAt),
        })
        .onConflictDoNothing();
      const progress = await get(input);
      if (progress === undefined) throw new Error('deployment_not_found');
      const stored = progress.events.find((event) => event.sequence === input.sequence);
      if (
        stored === undefined ||
        stored.stage !== input.payload.stage ||
        stored.status !== input.payload.status ||
        stored.summary !== input.payload.summary
      ) {
        throw new Error('deployment_event_sequence_conflict');
      }
      return progress;
    },
    get,
    async act(rawInput) {
      const input = DeploymentActionInputSchema.parse(rawInput);
      if (input.actor.organizationId !== input.organizationId) throw new Error('actor_tenant_mismatch');
      const [existing] = await database
        .select()
        .from(deploymentActionRequests)
        .where(
          and(
            eq(deploymentActionRequests.organizationId, input.organizationId),
            eq(deploymentActionRequests.operationKey, input.operationKey),
          ),
        )
        .limit(1);
      if (
        existing !== undefined &&
        (existing.resourceType !== input.resourceType ||
          existing.resourceId !== input.resourceId ||
          existing.action !== input.action ||
          JSON.stringify(existing.payloadJson) !== JSON.stringify(input.payload))
      ) {
        throw new Error('deployment_action_idempotency_conflict');
      }
      if (existing?.status !== 'dispatched') {
        await database
          .insert(deploymentActionRequests)
          .values({
            organizationId: input.organizationId,
            operationKey: input.operationKey,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            action: input.action,
            payloadJson: input.payload,
            status: 'pending',
            createdAt: new Date(),
          })
          .onConflictDoNothing();
        await dispatcher.dispatch(input);
        await database
          .update(deploymentActionRequests)
          .set({ status: 'dispatched', dispatchedAt: new Date() })
          .where(
            and(
              eq(deploymentActionRequests.organizationId, input.organizationId),
              eq(deploymentActionRequests.operationKey, input.operationKey),
            ),
          );
      }
      return { status: 'dispatched' };
    },
  };
}

/** Production Temporal activity adapter: retries map to the same durable sequence. */
export function createDeploymentProgressActivities(
  progress: DeploymentProgressPort,
  now: () => Date = () => new Date(),
) {
  return {
    async emitDeploymentUpdated(rawInput: unknown): Promise<void> {
      const input = EmitDeploymentUpdatedActivityInputSchema.parse(rawInput);
      const stageIndex = DEPLOYMENT_STAGES.indexOf(input.payload.stage);
      const sequence = stageIndex * 2 + (input.payload.status === 'running' ? 0 : 1);
      await progress.append({
        organizationId: input.organizationId,
        deploymentId: input.deploymentId,
        sequence,
        payload: input.payload,
        terminalSuccess: null,
        occurredAt: now().toISOString(),
      });
    },
  };
}
