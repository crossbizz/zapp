import { createHash, createHmac } from 'node:crypto';

import {
  AppTypeSchema,
  AttachmentRefSchema,
  BudgetApprovalReasonSchema,
  ConversationCardEventPayloadSchema,
  ConversationCardResponseSchema,
  ConversationResponseEventPayloadSchema,
  CreditDecimalSchema,
  FixRequestSchema,
  MessageUserPayloadSchema,
  idSchema,
  ModelIdentifierSchema,
  RunApprovalKindSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import {
  registerRunEventStreamRoute,
  type EventStreamAuthorizationContext,
  type EventStreamDependencies,
} from '../events/sse.js';
import {
  OperationKeySchema,
  DispatchNotStartedError,
  OrchestratorError,
  SignalRunInputSchema,
  SignalRunResultSchema,
  StartRunInputSchema,
  type OrchestratorPort,
} from '../orchestrator/port.js';
import { allowedModelsFromPolicy } from '../orgs/model-policy.js';
import type { OrganizationStore } from '../orgs/store.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import {
  RunSchema,
  SpecificationResponseSchema,
  toRun,
  toSpecification,
} from '../tenant/view.js';
import {
  BuilderRetryReasonSchema,
  BuilderSkipReasonSchema,
  deriveBuilderActions,
} from './mission-control.js';
import type { PricingConfig } from '../usage/pricing.js';
import type { ModelCompletionRepository } from '../usage/model-completions.js';
import {
  CreditBalanceExhaustedError,
  PlanLimitConcurrentRunsError,
  planLimitsFor,
  resolveRunBudget as resolvePlanRunBudget,
  type PlanLimitsConfig,
  type CreditBalanceGate,
} from '../usage/limits.js';
import type { IncidentRecord, IncidentStore } from './incidents.js';
import {
  MAX_PUBLIC_RUN_ARTIFACT_BYTES,
  type RunArtifactReaderPort,
} from './run-artifacts.js';

const RunParams = z.object({ runId: idSchema('run') });
const ProjectParams = z.object({ projectId: idSchema('proj') });
const RunBudgetSchema = z
  .object({ maxCredits: z.number().int().positive().max(1_000_000) })
  .strict();
const CreateRunBodyShape = {
  prompt: z.string().trim().min(1).max(20_000),
  branchId: idSchema('br').optional(),
  budget: RunBudgetSchema.optional(),
  appType: AppTypeSchema.default('web'),
  model: ModelIdentifierSchema.optional(),
} as const;
const CreateRunBody = z.discriminatedUnion('mode', [
  z
    .object({ ...CreateRunBodyShape, mode: z.literal('fix'), fixRequest: FixRequestSchema })
    .strict(),
  z
    .object({
      ...CreateRunBodyShape,
      mode: z.enum(['ask', 'prototype', 'build', 'autonomous']),
    })
    .strict(),
]);
const RedirectRunBody = z.object({ prompt: z.string().trim().min(1).max(20_000) }).strict();
const ContinueRunBody = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    attachments: z.array(AttachmentRefSchema).max(10).default([]),
  })
  .strict();
const AttachmentMetadataSchema = AttachmentRefSchema.omit({ attachmentId: true }).strict();
const ContinueRunResponse = z
  .object({
    messageId: z.string().regex(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u),
    sequence: z.number().int().positive(),
  })
  .strict();
const ApprovalParams = z.object({ runId: idSchema('run'), approvalId: idSchema('appr') }).strict();
const ApprovalDecisionShape = {
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(2_000).optional(),
} as const;
const ResolveApprovalBody = z.union([
  z.object({
    ...ApprovalDecisionShape,
    kind: z.literal('budget_increase').optional().default('budget_increase'),
  })
  .strict(),
  z.object({ ...ApprovalDecisionShape, kind: z.enum([
    'specification', 'plan', 'plan_diff', 'migration', 'deploy',
  ]) }).strict(),
]);
const ApprovalRequestPayload = z
  .object({
    currentCeiling: CreditDecimalSchema,
    absoluteCeiling: CreditDecimalSchema,
    workspaceId: z.string().min(1).max(512).nullable(),
    reason: BudgetApprovalReasonSchema,
  })
  .strict();
type ApprovalRequest = z.infer<typeof ApprovalRequestPayload>;

function decodeApprovalRequestPayload(value: unknown): ApprovalRequest {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'reason')
  ) {
    return ApprovalRequestPayload.parse({
      ...value,
      reason: 'run_budget_exhausted',
    });
  }
  return ApprovalRequestPayload.parse(value);
}
const ResolvedBudgetApprovalResponse = z
  .object({
    approval: z
      .object({
        approvalId: idSchema('appr'),
        kind: z.literal('budget_increase'),
        status: z.enum(['approved', 'rejected']),
        absoluteCeiling: CreditDecimalSchema,
      })
      .strict(),
  })
  .strict();
const ResolvedTypedApprovalResponse = z
  .object({
    approval: z.object({
      approvalId: idSchema('appr'),
      kind: RunApprovalKindSchema.exclude(['budget_increase']),
      status: z.enum(['approved', 'rejected']),
    }).strict(),
  })
  .strict();
const BuilderTaskParams = RunParams.extend({ taskId: idSchema('task') }).strict();
const BuilderPhaseParams = RunParams.extend({ phaseId: idSchema('phase') }).strict();
const BuilderControlResponse = z.object({ operationKey: OperationKeySchema }).strict();
const ConversationResponseAccepted = z.object({ operationKey: OperationKeySchema }).strict();
const RunSpecificationParams = RunParams.extend({ specificationId: idSchema('spec') }).strict();
const RunPlanParams = RunParams.extend({ artifactId: idSchema('art') }).strict();
const PlanReferenceEventSchema = z.object({
  artifactId: idSchema('art'),
  artifactType: z.literal('implementation_plan'),
  phases: z.array(z.object({ phaseId: idSchema('phase'), optional: z.boolean() }).strict()).max(1_000),
}).passthrough();
const BoundedCriteriaSchema = z.array(z.string().min(1).max(2_000)).max(1_000);
const RunPlanResponse = z.object({
  plan: z.object({
    artifactId: idSchema('art'),
    approvalId: idSchema('appr'),
    approvalKind: z.enum(['plan', 'plan_diff']),
    phaseCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    phases: z.array(z.object({
      id: idSchema('phase'), sequence: z.number().int().positive(), title: z.string().min(1).max(500),
      status: z.string().min(1).max(64), acceptanceCriteria: BoundedCriteriaSchema,
      optional: z.boolean(),
    }).strict()).max(100),
    tasks: z.array(z.object({
      id: idSchema('task'), phaseId: idSchema('phase'), title: z.string().min(1).max(500),
      status: z.string().min(1).max(64), riskLevel: z.enum(['low', 'medium', 'high']),
      acceptanceCriteria: BoundedCriteriaSchema, dependencies: z.array(idSchema('task')).max(1_000),
      assignedAgentRole: z.string().min(1).max(160).nullable(),
    }).strict()).max(1_000),
  }).strict(),
}).strict();
const RunArtifactResponse = z.object({
  artifact: z.object({
    id: idSchema('art'),
    type: z.string().min(1).max(160),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    byteSize: z.number().int().nonnegative().max(MAX_PUBLIC_RUN_ARTIFACT_BYTES),
    contentType: z.string().min(1).max(255),
    encoding: z.enum(['utf8', 'base64']),
    content: z.string().max(100_000),
  }).strict(),
}).strict();
const RunArtifactReferenceSchema = z.object({
  artifactId: idSchema('art'),
  type: z.string().min(1).max(160),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).passthrough();

const SIGNALS = {
  pause: {
    allowed: ['queued', 'running'],
    status: 'paused',
    requested: 'run.pause_requested',
    completed: 'run.paused',
    rejected: 'run.pause_rejected',
  },
  resume: {
    allowed: ['paused'],
    status: 'queued',
    requested: 'run.resume_requested',
    completed: 'run.resumed',
    rejected: 'run.resume_rejected',
  },
  cancel: {
    allowed: ['queued', 'running', 'paused'],
    status: 'cancelled',
    requested: 'run.cancel_requested',
    completed: 'run.cancelled',
    rejected: 'run.cancel_rejected',
  },
  redirect: {
    allowed: ['queued', 'running', 'paused'],
    status: 'queued',
    requested: 'run.redirect_requested',
    completed: 'run.redirected',
    rejected: 'run.redirect_rejected',
  },
} as const;

export interface RunRoutesDeps {
  readonly now: () => Date;
  /** Cross-instance key; never logged, returned, or handed to a repository. */
  readonly runIntentHmacKey: Buffer;
  readonly orchestrator: OrchestratorPort;
  readonly organizations: OrganizationStore;
  readonly eventStream: EventStreamDependencies;
  readonly revalidateEventStream: (context: EventStreamAuthorizationContext) => Promise<boolean>;
  readonly pricing?: PricingConfig;
  readonly planLimits?: PlanLimitsConfig;
  readonly creditBalance?: CreditBalanceGate;
  readonly modelCompletions?: ModelCompletionRepository;
  readonly incidents?: IncidentStore;
  readonly artifactReader: RunArtifactReaderPort;
}

export function registerRunRoutes(app: AppInstance, deps: RunRoutesDeps): void {
  app.post(
    '/v1/projects/:projectId/runs',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: CreateRunBody,
        response: { 201: z.object({ run: RunSchema }) },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      if (
        request.body.branchId !== undefined &&
        (await ctx.db.branches.getForProject(project.id, request.body.branchId)) === undefined
      )
        throw branchNotFound();
      authorize(ctx, 'start_run');
      let sourceIncident: IncidentRecord | undefined;
      if (request.body.mode === 'fix') {
        const incidentFields = [
          request.body.fixRequest.incidentId,
          request.body.fixRequest.releaseId,
          request.body.fixRequest.errorPayload,
        ];
        if (
          incidentFields.some((value) => value !== undefined) &&
          incidentFields.some((value) => value === undefined)
        ) {
          throw new ApiError('validation_failed', 400, 'The request failed validation.');
        }
      }
      if (request.body.mode === 'fix' && request.body.fixRequest.incidentId !== undefined) {
        sourceIncident = await deps.incidents?.get({
          organizationId: ctx.organizationId,
          incidentId: request.body.fixRequest.incidentId,
        });
        if (
          sourceIncident === undefined ||
          sourceIncident.projectId !== project.id ||
          sourceIncident.releaseId !== request.body.fixRequest.releaseId ||
          sourceIncident.commitSha !== request.body.fixRequest.relevantCommitSha ||
          sourceIncident.errorPayload !== request.body.fixRequest.errorPayload
        ) {
          throw new ApiError('incident_not_found', 404, 'That incident does not exist.');
        }
      }
      const idempotency = idempotencyOf(request);
      // The plugin's raw digest remains suitable for its short-lived Redis
      // record. PostgreSQL gets only this keyed, cross-instance derivative.
      const requestFingerprint = createHmac('sha256', deps.runIntentHmacKey)
        .update(idempotency.fingerprint)
        .digest('hex');
      const operationKey = creationOperationOf(request);
      const runId = stableId('run', operationKey);
      const organization =
        deps.planLimits === undefined
          ? undefined
          : await deps.organizations.findById(ctx.organizationId);
      const limit =
        deps.planLimits === undefined || organization === undefined
          ? undefined
          : planLimitsFor(deps.planLimits, organization.plan);
      let run = await ctx.db.runs.getById(runId);
      if (run !== undefined && run.requestFingerprint !== requestFingerprint) {
        throw idempotencyConflict();
      }
      if (run === undefined) {
        const pricing = deps.pricing;
        if (pricing === undefined) throw pricingUnavailable();
        if (request.body.model !== undefined && pricing.models[request.body.model] === undefined) {
          throw pricingUnavailable();
        }
        if (deps.creditBalance !== undefined) {
          try {
            await deps.creditBalance.requireRunAdmission(ctx.organizationId);
          } catch (error) {
            if (error instanceof CreditBalanceExhaustedError) throw creditBalanceExhausted();
            throw error;
          }
        }
        const resolvedBudget =
          limit === undefined
            ? resolveRunBudget(pricing, request.body.budget)
            : resolvePlanRunBudget(limit, request.body.budget);
        let explicitModelAllowed = true;
        if (request.body.model !== undefined) {
          const settings = await deps.organizations.getSettings(ctx.organizationId);
          explicitModelAllowed = allowedModelsFromPolicy(settings?.defaultModelPolicy).has(
            request.body.model,
          );
        }
        let created;
        try {
          created = await ctx.db.runs.create({
            id: runId,
            workflowId: runId,
            requestFingerprint,
            projectId: project.id,
            branchId: request.body.branchId ?? null,
            mode: request.body.mode,
            ...(request.body.mode === 'autonomous' && limit !== undefined
              ? { concurrentAutonomousLimit: limit.concurrentAutonomousRuns }
              : {}),
            appType: request.body.appType,
            model: request.body.model ?? null,
            budget: resolvedBudget,
            planMaxCredits: `${String(
              limit === undefined
                ? Number(pricing.defaultRunCreditCeiling)
                : Number(limit.maxRunBudgetCredits),
            )}.0000`,
            accounting: {
              baseCeiling: `${String(resolvedBudget.maxCredits)}.0000`,
              pricingVersion: pricing.version,
              pricingSnapshot: pricing,
            },
            startedBy: actorOf(request),
            now: deps.now(),
            authorize: (inserted) => {
              if (inserted.model !== null && !explicitModelAllowed) throw modelNotAllowed();
            },
            audit: async (tx, inserted) => {
              await request.audit(tx, {
                organizationId: ctx.organizationId,
                action: 'run.created',
                target: { type: 'run', id: inserted.id },
                metadata: {
                  projectId: inserted.projectId,
                  mode: inserted.mode,
                  appType: inserted.appType,
                  model: inserted.model,
                },
              });
              if (sourceIncident !== undefined && deps.incidents !== undefined) {
                await deps.incidents.linkFixRun(tx, {
                  organizationId: ctx.organizationId,
                  projectId: project.id,
                  incidentId: sourceIncident.id,
                  releaseId: sourceIncident.releaseId,
                  runId: inserted.id,
                  actorId: actorOf(request),
                  occurredAt: deps.now(),
                });
              }
            },
          });
        } catch (error) {
          if (error instanceof PlanLimitConcurrentRunsError) throw planLimitConcurrentRuns();
          throw error;
        }
        if (created.outcome === 'conflict') throw idempotencyConflict();
        run = created.run;
      } else if (run.status === 'dispatch_failed') {
        let readmitted;
        try {
          readmitted = await ctx.db.runs.readmitDispatch({
            runId: run.id,
            requestFingerprint,
            ...(run.mode === 'autonomous' && limit !== undefined
              ? { concurrentAutonomousLimit: limit.concurrentAutonomousRuns }
              : {}),
            audit: async (tx, row) => {
              await request.audit(tx, {
                organizationId: ctx.organizationId,
                action: 'run.dispatch_retried',
                target: { type: 'run', id: row.id },
                metadata: { operationKey, priorStatus: 'dispatch_failed' },
              });
            },
          });
        } catch (error) {
          if (error instanceof PlanLimitConcurrentRunsError) throw planLimitConcurrentRuns();
          throw error;
        }
        if (readmitted === undefined) throw runNotFound();
        if (readmitted.outcome === 'conflict') throw idempotencyConflict();
        run = readmitted.run;
      }
      try {
        const started = await deps.orchestrator.startRun(
          StartRunInputSchema.parse({
            runId: run.id,
            workflowId: run.temporalWorkflowId ?? run.id,
            organizationId: run.organizationId,
            projectId: run.projectId,
            branchId: run.branchId,
            mode: run.mode,
            appType: run.appType,
            model: run.model,
            prompt: request.body.prompt,
            budget: RunBudgetSchema.parse(run.budgetJson),
            planMaxCredits: Number(run.planMaxCredits),
            operationKey,
            ...(request.body.mode === 'fix' ? { fixRequest: request.body.fixRequest } : {}),
          }),
        );
        z.void().parse(started);
      } catch (error) {
        if (error instanceof DispatchNotStartedError) {
          await ctx.db.runs.markDispatchFailed({
            runId: run.id,
            audit: async (tx, row) => {
              await request.audit(tx, {
                organizationId: ctx.organizationId,
                action: 'run.dispatch_failed',
                target: { type: 'run', id: row.id },
                metadata: { operationKey, status: row.status },
              });
            },
          });
          throw dispatchNotStarted();
        }
        if (error instanceof OrchestratorError || error instanceof z.ZodError)
          throw workflowFailed();
        throw error;
      }
      return await reply.status(201).send({ run: toRun(run) });
    },
  );

  for (const action of Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]) {
    const config = SIGNALS[action];
    app.post(
      `/v1/runs/:runId/${action}`,
      {
        preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
        schema: {
          params: RunParams,
          ...(action === 'redirect' ? { body: RedirectRunBody } : {}),
          response: { 200: z.object({ run: RunSchema }) },
        },
      },
      async (request) => {
        const ctx = tenantOf(request);
        const run = await ctx.db.runs.getById(request.params.runId);
        if (run === undefined) throw runNotFound();
        authorize(ctx, 'start_run');
        const operationKey = operationOf(request);
        const prompt =
          action === 'redirect' ? RedirectRunBody.parse(request.body).prompt : undefined;
        const claim = await ctx.db.runs.claimOperation({
          runId: run.id,
          operationKey,
          allowedStatuses: config.allowed,
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: config.requested,
              target: { type: 'run', id: row.id },
              metadata: { operationKey, operationState: 'requested', priorStatus: row.status },
            });
          },
        });
        if (claim === undefined) throw runNotFound();
        if (claim.outcome === 'blocked' || claim.outcome === 'rejected') throw invalidRunState();
        if (claim.outcome === 'completed') return { run: toRun(claim.entity) };
        let result: z.infer<typeof SignalRunResultSchema>;
        try {
          result = SignalRunResultSchema.parse(
            await deps.orchestrator.signalRun(
              SignalRunInputSchema.parse({
                runId: claim.entity.id,
                workflowId: claim.entity.temporalWorkflowId ?? claim.entity.id,
                mode: claim.entity.mode,
                signal: action,
                ...(prompt === undefined ? {} : { prompt }),
                operationKey,
              }),
            ),
          );
        } catch (error) {
          if (error instanceof OrchestratorError || error instanceof z.ZodError)
            throw workflowFailed();
          throw error;
        }
        if (!result.applied) {
          await ctx.db.runs.rejectOperation({
            runId: claim.entity.id,
            operationKey,
            audit: async (tx, row) => {
              await request.audit(tx, {
                organizationId: ctx.organizationId,
                action: config.rejected,
                target: { type: 'run', id: row.id },
                metadata: { operationKey, operationState: 'rejected' },
              });
            },
          });
          throw invalidRunState();
        }
        if (action !== 'redirect') {
          // Pause, resume, and cancel are acknowledged only after the workflow
          // reaches its durable control boundary. CP-13 atomically closes the
          // requested operation, run status, event, audit, and notification.
          return { run: toRun(claim.entity) };
        }
        const updated = await ctx.db.runs.completeOperation({
          runId: claim.entity.id,
          operationKey,
          expectedStatus: claim.entity.status,
          status: config.status,
          completedAt: null,
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: config.completed,
              target: { type: 'run', id: row.id },
              metadata: { operationKey, operationState: 'completed', status: row.status },
            });
          },
        });
        if (updated === undefined) throw invalidRunState();
        return { run: toRun(updated) };
      },
    );
  }

  app.post(
    '/v1/runs/:runId/tasks/:taskId/retry',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: BuilderTaskParams, response: { 202: BuilderControlResponse } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'start_run');
      const operationKey = operationOf(request);
      const claim = await ctx.db.runs.claimOperation({
        runId: run.id,
        operationKey,
        allowedStatuses: ['queued', 'running', 'paused', 'waiting_for_approval'],
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.task_retry_requested',
            target: { type: 'run', id: row.id },
            metadata: { operationKey, operationState: 'requested', taskId: request.params.taskId },
          });
        },
      });
      if (claim === undefined) throw runNotFound();
      if (claim.outcome === 'completed') {
        return await reply.status(202).send({ operationKey });
      }
      if (claim.outcome !== 'dispatch') throw invalidRunState();
      const [events, rows] = await Promise.all([
        ctx.db.events.byRun(run.id),
        ctx.db.missionControl.forRun(run.id),
      ]);
      const action = deriveBuilderActions(claim.entity, events, rows).retryFailedTasks.find(
        ({ taskId }) => taskId === request.params.taskId,
      );
      const reason = action?.reason ?? BuilderRetryReasonSchema.parse('task_not_found');
      if (reason !== 'eligible') {
        await ctx.db.runs.rejectOperation({
          runId: claim.entity.id,
          operationKey,
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'run.task_retry_rejected',
              target: { type: 'run', id: row.id },
              metadata: { operationKey, operationState: 'rejected', taskId: request.params.taskId, reason },
            });
          },
        });
        throw builderControlConflict(reason);
      }
      await signalBuilderControl(deps.orchestrator, SignalRunInputSchema.parse({
        runId: claim.entity.id,
        workflowId: claim.entity.temporalWorkflowId ?? claim.entity.id,
        mode: claim.entity.mode,
        signal: 'retry_failed_task',
        taskId: request.params.taskId,
        operationKey,
      }));
      const completed = await ctx.db.runs.completeOperation({
        runId: claim.entity.id,
        operationKey,
        expectedStatus: claim.entity.status,
        status: claim.entity.status,
        completedAt: claim.entity.completedAt,
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.task_retry_signalled',
            target: { type: 'run', id: row.id },
            metadata: { operationKey, operationState: 'completed', taskId: request.params.taskId },
          });
        },
      });
      if (completed === undefined) throw invalidRunState();
      return await reply.status(202).send({ operationKey });
    },
  );

  app.post(
    '/v1/runs/:runId/phases/:phaseId/skip',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: BuilderPhaseParams, response: { 202: BuilderControlResponse } },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'start_run');
      const operationKey = operationOf(request);
      const claim = await ctx.db.runs.claimOperation({
        runId: run.id,
        operationKey,
        allowedStatuses: ['queued', 'running', 'paused', 'waiting_for_approval'],
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.phase_skip_requested',
            target: { type: 'run', id: row.id },
            metadata: { operationKey, operationState: 'requested', phaseId: request.params.phaseId },
          });
        },
      });
      if (claim === undefined) throw runNotFound();
      if (claim.outcome === 'completed') {
        return await reply.status(202).send({ operationKey });
      }
      if (claim.outcome !== 'dispatch') throw invalidRunState();
      const [events, rows] = await Promise.all([
        ctx.db.events.byRun(run.id),
        ctx.db.missionControl.forRun(run.id),
      ]);
      const action = deriveBuilderActions(claim.entity, events, rows).skipOptionalPhases.find(
        ({ phaseId }) => phaseId === request.params.phaseId,
      );
      const reason = action?.reason ?? BuilderSkipReasonSchema.parse('phase_not_found');
      if (reason !== 'eligible') {
        await ctx.db.runs.rejectOperation({
          runId: claim.entity.id,
          operationKey,
          audit: async (tx, row) => {
            await request.audit(tx, {
              organizationId: ctx.organizationId,
              action: 'run.phase_skip_rejected',
              target: { type: 'run', id: row.id },
              metadata: { operationKey, operationState: 'rejected', phaseId: request.params.phaseId, reason },
            });
          },
        });
        throw builderControlConflict(reason);
      }
      await signalBuilderControl(deps.orchestrator, SignalRunInputSchema.parse({
        runId: claim.entity.id,
        workflowId: claim.entity.temporalWorkflowId ?? claim.entity.id,
        mode: claim.entity.mode,
        signal: 'skip_optional_phase',
        phaseId: request.params.phaseId,
        operationKey,
      }));
      const completed = await ctx.db.runs.completeOperation({
        runId: claim.entity.id,
        operationKey,
        expectedStatus: claim.entity.status,
        status: claim.entity.status,
        completedAt: claim.entity.completedAt,
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.phase_skip_signalled',
            target: { type: 'run', id: row.id },
            metadata: { operationKey, operationState: 'completed', phaseId: request.params.phaseId },
          });
        },
      });
      if (completed === undefined) throw invalidRunState();
      return await reply.status(202).send({ operationKey });
    },
  );

  app.post(
    '/v1/runs/:runId/messages',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: RunParams,
        body: ContinueRunBody,
        response: { 202: ContinueRunResponse },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'start_run');
      const operationKey = operationOf(request);
      const messageId = stableId('msg', operationKey);
      const attachments: z.infer<typeof AttachmentRefSchema>[] = [];
      const attachmentArtifacts: Array<{
        readonly id: string;
        readonly type: string;
        readonly contentHash: string;
      }> = [];
      for (const supplied of request.body.attachments) {
        const artifact = await ctx.db.attachments.getById(supplied.attachmentId);
        if (artifact === undefined || artifact.projectId !== run.projectId)
          throw attachmentNotFound();
        attachmentArtifacts.push(artifact);
        attachments.push(
          AttachmentRefSchema.parse({
            attachmentId: artifact.id,
            ...AttachmentMetadataSchema.parse(artifact.metadataJson),
          }),
        );
      }
      const message = MessageUserPayloadSchema.parse({
        messageId,
        content: request.body.content,
        attachments,
        source: 'api',
      });
      const ingested = await ctx.db.events.ingest({
        runId: run.id,
        projectId: run.projectId,
        events: [
          ...attachmentArtifacts.map((artifact) => ({
            runId: run.id,
            organizationId: ctx.organizationId,
            projectId: run.projectId,
            occurredAt: deps.now().toISOString(),
            type: 'artifact.created' as const,
            visibility: 'user' as const,
            payload: {
              artifactId: artifact.id,
              type: artifact.type,
              contentHash: artifact.contentHash,
            },
          })),
          {
            runId: run.id,
            organizationId: ctx.organizationId,
            projectId: run.projectId,
            occurredAt: deps.now().toISOString(),
            type: 'message.user',
            visibility: 'user',
            payload: message,
          },
        ],
        audit: async (tx, events) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.message_created',
            target: { type: 'run', id: run.id },
            metadata: {
              operationKey,
              messageId,
              sequence: events[0]?.sequence ?? null,
              attachmentCount: attachments.length,
            },
          });
        },
      });
      if (ingested.kind === 'run_not_found') throw runNotFound();
      if (ingested.kind === 'run_not_active') throw runNotActive();
      if (ingested.kind !== 'stored') throw messageIngestFailed();
      const stored = ingested.events.find((event) => event.type === 'message.user');
      if (stored === undefined) throw messageIngestFailed();
      try {
        const result = SignalRunResultSchema.parse(
          await deps.orchestrator.signalRun(
            SignalRunInputSchema.parse({
              runId: run.id,
              workflowId: run.temporalWorkflowId ?? run.id,
              mode: run.mode,
              signal: 'message',
              message,
              operationKey,
            }),
          ),
        );
        if (!result.applied) throw runNotActive();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof OrchestratorError || error instanceof z.ZodError) {
          throw workflowFailed();
        }
        throw error;
      }
      return await reply.status(202).send({ messageId, sequence: stored.sequence });
    },
  );

  app.post(
    '/v1/runs/:runId/conversation-responses',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: RunParams,
        body: ConversationCardResponseSchema,
        response: { 202: ConversationResponseAccepted },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'start_run');
      if (run.mode !== 'autonomous') throw conversationCardsUnsupported();
      const events = await ctx.db.events.byRun(run.id);
      const card = events
        .filter(({ type }) => type === 'conversation.card')
        .map(({ payloadJson }) => ConversationCardEventPayloadSchema.safeParse(payloadJson))
        .find((parsed) => parsed.success && parsed.data.card.cardId === request.body.cardId);
      if (card === undefined || !card.success || card.data.card.kind !== 'question') {
        throw conversationCardNotFound();
      }
      const expectedQuestionIds = card.data.card.questions.map(({ questionId }) => questionId);
      const suppliedQuestionIds = request.body.answers.map(({ questionId }) => questionId);
      if (
        expectedQuestionIds.length !== suppliedQuestionIds.length ||
        expectedQuestionIds.some((questionId) => !suppliedQuestionIds.includes(questionId))
      ) throw conversationResponseMismatch();
      const resolved = events
        .filter(({ type }) => type === 'conversation.response')
        .map(({ payloadJson }) => ConversationResponseEventPayloadSchema.safeParse(payloadJson))
        .some((parsed) => parsed.success && parsed.data.response.cardId === request.body.cardId);
      if (resolved) throw conversationResponseConflict();
      const operationKey = operationOf(request);
      const claim = await ctx.db.runs.claimOperation({
        runId: run.id,
        operationKey,
        allowedStatuses: ['queued', 'running', 'paused', 'waiting_for_approval'],
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.conversation_response_requested',
            target: { type: 'run', id: row.id },
            metadata: {
              operationKey,
              operationState: 'requested',
              cardId: request.body.cardId,
            },
          });
        },
      });
      if (claim === undefined) throw runNotFound();
      if (claim.outcome === 'completed') {
        return await reply.status(202).send({ operationKey });
      }
      if (claim.outcome !== 'dispatch') throw invalidRunState();
      await signalBuilderControl(deps.orchestrator, SignalRunInputSchema.parse({
        runId: claim.entity.id,
        workflowId: claim.entity.temporalWorkflowId ?? claim.entity.id,
        mode: 'autonomous',
        signal: 'conversation_card_response',
        cardId: request.body.cardId,
        response: request.body,
        operationKey,
      }));
      const completed = await ctx.db.runs.completeOperation({
        runId: claim.entity.id,
        operationKey,
        expectedStatus: claim.entity.status,
        status: claim.entity.status,
        completedAt: claim.entity.completedAt,
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.conversation_response_signalled',
            target: { type: 'run', id: row.id },
            metadata: {
              operationKey,
              operationState: 'completed',
              cardId: request.body.cardId,
            },
          });
        },
      });
      if (completed === undefined) throw invalidRunState();
      return await reply.status(202).send({ operationKey });
    },
  );

  app.get(
    '/v1/runs/:runId/specifications/:specificationId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: RunSpecificationParams,
        response: { 200: SpecificationResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'view_project');
      const rows = await ctx.db.missionControl.forRun(run.id);
      const reference = rows.approvals.find((approval) =>
        approval.type === 'specification' &&
        referencedArtifactId(approval.requestJson) === request.params.specificationId
      );
      if (reference === undefined) throw runArtifactNotFound();
      const specification = await ctx.db.specifications.getForProject(
        run.projectId,
        request.params.specificationId,
      );
      if (
        specification === undefined ||
        referencedArtifactVersion(reference.requestJson) !== specification.version
      ) throw runArtifactNotFound();
      return { specification: toSpecification(specification) };
    },
  );

  app.get(
    '/v1/runs/:runId/plans/:artifactId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: RunPlanParams, response: { 200: RunPlanResponse } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'view_project');
      const [events, rows] = await Promise.all([
        ctx.db.events.byRun(run.id),
        ctx.db.missionControl.forRun(run.id),
      ]);
      const approval = rows.approvals.find((candidate) =>
        (candidate.type === 'plan' || candidate.type === 'plan_diff') &&
        referencedArtifactId(candidate.requestJson) === request.params.artifactId
      );
      const reference = events.find(({ type, payloadJson }) =>
        type === 'artifact.created' &&
        PlanReferenceEventSchema.safeParse(payloadJson).data?.artifactId === request.params.artifactId
      );
      if (approval === undefined || reference === undefined) throw runArtifactNotFound();
      const parsedReference = PlanReferenceEventSchema.parse(reference.payloadJson);
      const optionalByPhase = new Map(parsedReference.phases.map(({ phaseId, optional }) => [phaseId, optional]));
      const phases = rows.phases.slice(0, 100).map((phase) => ({
        id: phase.id,
        sequence: phase.sequence,
        title: phase.title,
        status: phase.status,
        acceptanceCriteria: BoundedCriteriaSchema.parse(phase.acceptanceCriteriaJson),
        optional: optionalByPhase.get(phase.id) ?? false,
      }));
      const tasks = rows.tasks.slice(0, 1_000).map((task) => ({
        id: task.id,
        phaseId: task.phaseId,
        title: task.title,
        status: task.status,
        riskLevel: task.riskLevel,
        acceptanceCriteria: BoundedCriteriaSchema.parse(task.acceptanceCriteriaJson),
        dependencies: z.array(idSchema('task')).max(1_000).parse(task.dependenciesJson),
        assignedAgentRole: task.assignedAgentRole,
      }));
      return RunPlanResponse.parse({
        plan: {
          artifactId: request.params.artifactId,
          approvalId: approval.id,
          approvalKind: approval.type,
          phaseCount: rows.phases.length,
          taskCount: rows.tasks.length,
          truncated: rows.phases.length > phases.length || rows.tasks.length > tasks.length,
          phases,
          tasks,
        },
      });
    },
  );

  app.get(
    '/v1/runs/:runId/artifacts/:artifactId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: RunPlanParams, response: { 200: RunArtifactResponse } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'view_project');
      const [artifact, events] = await Promise.all([
        ctx.db.runArtifacts.getForRun(run.id, request.params.artifactId),
        ctx.db.events.byRun(run.id),
      ]);
      const reference = events
        .filter(({ type }) => type === 'artifact.created')
        .map(({ payloadJson }) => RunArtifactReferenceSchema.safeParse(payloadJson))
        .find((parsed) => parsed.success && parsed.data.artifactId === request.params.artifactId);
      if (
        artifact === undefined || reference === undefined || !reference.success ||
        artifact.projectId !== run.projectId || artifact.type !== reference.data.type ||
        artifact.contentHash !== reference.data.contentHash
      ) throw runArtifactNotFound();
      const object = await deps.artifactReader.read({
        key: artifact.storageRef,
        maxBytes: MAX_PUBLIC_RUN_ARTIFACT_BYTES,
      });
      if (object === undefined) throw runArtifactNotFound();
      if (object === 'too_large') throw runArtifactTooLarge();
      if (createHash('sha256').update(object.body).digest('hex') !== artifact.contentHash) {
        throw runArtifactContentInvalid();
      }
      const encoded = encodePublicArtifact(object.body, object.contentType);
      return RunArtifactResponse.parse({
        artifact: {
          id: artifact.id,
          type: artifact.type,
          contentHash: artifact.contentHash,
          byteSize: object.body.length,
          contentType: object.contentType,
          encoding: encoded.encoding,
          content: encoded.content,
        },
      });
    },
  );

  app.post(
    '/v1/runs/:runId/approvals/:approvalId',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ApprovalParams,
        body: ResolveApprovalBody,
        response: { 200: z.union([ResolvedBudgetApprovalResponse, ResolvedTypedApprovalResponse]) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      const operationKey = operationOf(request);
      const approval = await ctx.db.approvals.get(run.id, request.params.approvalId);
      if (approval === undefined || approval.type !== request.body.kind) throw approvalNotFound();
      if (request.body.kind === 'deploy') {
        const settings = await deps.organizations.getSettings(ctx.organizationId);
        authorize(ctx, 'approve_production_deploy', {
          builderCanDeploy: settings?.builderCanDeploy ?? false,
        });
      } else {
        authorize(ctx, 'start_run');
      }
      let budgetRequest: ApprovalRequest | undefined;
      let artifactId: string | undefined;
      if (request.body.kind === 'budget_increase') {
        budgetRequest = decodeApprovalRequestPayload(approval.requestJson);
        if (request.body.decision === 'approved') {
          const proposed = budgetRequest.absoluteCeiling;
          if (Number(proposed) > Number(run.planMaxCredits)) throw planBudgetExceeded();
          const current = creditUnits(budgetRequest.currentCeiling);
          const requested = creditUnits(proposed);
          if (
            (budgetRequest.reason === 'run_budget_exhausted' && requested <= current) ||
            (budgetRequest.reason === 'organization_credit_exhausted' && requested !== current)
          ) throw planBudgetExceeded();
        }
      } else if (
        request.body.kind === 'specification' ||
        request.body.kind === 'plan' ||
        request.body.kind === 'plan_diff'
      ) {
        artifactId = z.object({
          artifactId: request.body.kind === 'specification'
            ? z.string().min(1).max(512)
            : idSchema('art'),
        }).passthrough()
          .parse(approval.requestJson).artifactId;
      }
      const resolved = await ctx.db.approvals.resolve({
        runId: run.id,
        approvalId: request.params.approvalId,
        type: request.body.kind,
        decision: request.body.decision,
        reason: request.body.reason ?? null,
        resolvedBy: actorOf(request),
        resolvedAt: deps.now(),
        audit: async (tx, approval) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'run.approval_resolved',
            target: { type: 'run', id: run.id },
            metadata: {
              runId: run.id,
              approvalId: approval.id,
              kind: request.body.kind,
              decision: request.body.decision,
              operationKey,
            },
          });
        },
      });
      if (resolved === undefined || resolved.approval.type !== request.body.kind)
        throw approvalNotFound();
      if (resolved.outcome === 'conflict') throw approvalConflict();
      if (request.body.kind === 'budget_increase') {
        const approvalRequest = budgetRequest ?? decodeApprovalRequestPayload(resolved.approval.requestJson);
        if (
          request.body.decision === 'approved' &&
          approvalRequest.reason === 'run_budget_exhausted'
        ) {
          if (deps.modelCompletions === undefined) throw accountingUnavailable();
          await deps.modelCompletions.increaseCeiling({
            organizationId: ctx.organizationId,
            projectId: run.projectId,
            runId: run.id,
            approvalId: resolved.approval.id,
            operationKey,
            absoluteCeiling: approvalRequest.absoluteCeiling,
          });
        }
        await signalBuilderControl(deps.orchestrator, SignalRunInputSchema.parse({
          runId: run.id,
          workflowId: run.temporalWorkflowId ?? run.id,
          mode: run.mode,
          signal: 'budget_approval',
          approvalId: resolved.approval.id,
          decision: request.body.decision,
          reason: approvalRequest.reason,
          ...(request.body.decision === 'approved'
            ? { absoluteCeiling: approvalRequest.absoluteCeiling }
            : {}),
          operationKey,
        }));
        return ResolvedBudgetApprovalResponse.parse({
          approval: {
            approvalId: resolved.approval.id,
            kind: request.body.kind,
            status: request.body.decision,
            absoluteCeiling: approvalRequest.absoluteCeiling,
          },
        });
      }
      await signalBuilderControl(deps.orchestrator, SignalRunInputSchema.parse({
        runId: run.id,
        workflowId: run.temporalWorkflowId ?? run.id,
        mode: run.mode,
        signal: 'approval_decision',
        approvalId: resolved.approval.id,
        approvalKind: request.body.kind,
        decision: request.body.decision,
        ...(artifactId === undefined ? {} : { artifactId }),
        operationKey,
      }));
      return ResolvedTypedApprovalResponse.parse({
        approval: {
          approvalId: resolved.approval.id,
          kind: request.body.kind,
          status: request.body.decision,
        },
      });
    },
  );

  app.get(
    '/v1/runs/:runId',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: RunParams, response: { 200: z.object({ run: RunSchema }) } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'view_project');
      return { run: toRun(run) };
    },
  );
  registerRunEventStreamRoute(app, {
    eventStream: deps.eventStream,
    revalidate: deps.revalidateEventStream,
  });
}

function operationOf(request: {
  idempotency?: { key: string; fingerprint: string };
}): z.infer<typeof OperationKeySchema> {
  const idempotency = idempotencyOf(request);
  return OperationKeySchema.parse(
    `op_${createHash('sha256').update(`${idempotency.key}\n${idempotency.fingerprint}`).digest('hex')}`,
  );
}
function creationOperationOf(request: {
  idempotency?: { key: string; fingerprint: string };
}): z.infer<typeof OperationKeySchema> {
  return OperationKeySchema.parse(
    `op_${createHash('sha256').update(idempotencyOf(request).key).digest('hex')}`,
  );
}
function idempotencyOf(request: { idempotency?: { key: string; fingerprint: string } }): {
  readonly key: string;
  readonly fingerprint: string;
} {
  if (request.idempotency === undefined)
    throw new ApiError('idempotency_key_required', 400, 'An Idempotency-Key header is required.');
  return request.idempotency;
}
function stableId(prefix: 'run' | 'ws' | 'msg' | 'art', operationKey: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(operationKey).digest();
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31] ?? '';
    }
    if (output.length === 26) break;
  }
  return `${prefix}_${output}`;
}
function runNotFound(): ApiError {
  return new ApiError('run_not_found', 404, 'That run does not exist.');
}
function referencedArtifactId(value: unknown): string | undefined {
  return z.object({ artifactId: z.string().min(1).max(512) }).passthrough()
    .safeParse(value).data?.artifactId;
}
function referencedArtifactVersion(value: unknown): number | undefined {
  return z.object({ artifactVersion: z.number().int().positive() }).passthrough()
    .safeParse(value).data?.artifactVersion;
}
function runArtifactNotFound(): ApiError {
  return new ApiError('run_artifact_not_found', 404, 'That run artifact does not exist.');
}
function runArtifactTooLarge(): ApiError {
  return new ApiError(
    'run_artifact_too_large',
    413,
    'That run artifact exceeds the public inline-read limit.',
  );
}
function runArtifactContentInvalid(): ApiError {
  return new ApiError(
    'run_artifact_content_invalid',
    502,
    'That run artifact failed integrity verification.',
  );
}
function encodePublicArtifact(body: Buffer, contentType: string): {
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
} {
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      return { encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true }).decode(body) };
    } catch {
      // Invalid text is still safe to return as explicitly encoded bytes.
    }
  }
  return { encoding: 'base64', content: body.toString('base64') };
}
function conversationCardsUnsupported(): ApiError {
  return new ApiError(
    'conversation_cards_unsupported',
    409,
    'That run does not accept structured conversation-card responses.',
  );
}
function conversationCardNotFound(): ApiError {
  return new ApiError('conversation_card_not_found', 404, 'That conversation card does not exist.');
}
function conversationResponseMismatch(): ApiError {
  return new ApiError(
    'conversation_response_mismatch',
    422,
    'The response does not answer the exact questions on that conversation card.',
  );
}
function conversationResponseConflict(): ApiError {
  return new ApiError(
    'conversation_response_conflict',
    409,
    'That conversation card already has a response.',
  );
}
function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}
function branchNotFound(): ApiError {
  return new ApiError('branch_not_found', 404, 'That branch does not exist.');
}
function approvalNotFound(): ApiError {
  return new ApiError('approval_not_found', 404, 'That approval does not exist.');
}
function attachmentNotFound(): ApiError {
  return new ApiError('attachment_not_found', 404, 'That attachment does not exist.');
}
function runNotActive(): ApiError {
  return new ApiError('run_not_active', 409, 'That run is not accepting messages.');
}
function messageIngestFailed(): ApiError {
  return new ApiError('message_ingest_failed', 409, 'That message could not be accepted.');
}
function approvalConflict(): ApiError {
  return new ApiError('approval_conflict', 409, 'That approval was already resolved differently.');
}
function accountingUnavailable(): ApiError {
  return new ApiError('usage_accounting_unavailable', 503, 'Usage accounting is unavailable.');
}
function modelNotAllowed(): ApiError {
  return new ApiError('model_not_allowed', 400, 'That model is not allowed by this organization.');
}
function idempotencyConflict(): ApiError {
  return new ApiError(
    'idempotency_conflict',
    422,
    'That Idempotency-Key was already used for a different request.',
  );
}
function invalidRunState(): ApiError {
  return new ApiError('invalid_run_state', 409, 'That run cannot accept this action.');
}
function builderControlConflict(
  reason: z.infer<typeof BuilderRetryReasonSchema> | z.infer<typeof BuilderSkipReasonSchema>,
): ApiError {
  return new ApiError(
    `builder_control_${reason}`,
    409,
    'That builder control is not eligible in the current run state.',
  );
}
async function signalBuilderControl(
  orchestrator: OrchestratorPort,
  input: z.infer<typeof SignalRunInputSchema>,
): Promise<void> {
  try {
    const result = SignalRunResultSchema.parse(await orchestrator.signalRun(input));
    if (!result.applied) throw invalidRunState();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof OrchestratorError || error instanceof z.ZodError) throw workflowFailed();
    throw error;
  }
}
function workflowFailed(): ApiError {
  return new ApiError(
    'workflow_start_failed',
    502,
    'The run workflow could not be started. Please try again.',
  );
}
function dispatchNotStarted(): ApiError {
  return new ApiError(
    'dispatch_not_started',
    502,
    'The run workflow was not started. Please try again.',
  );
}

function creditUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}
function pricingUnavailable(): ApiError {
  return new ApiError(
    'pricing_configuration_invalid',
    503,
    'Run pricing is unavailable. Please try again later.',
  );
}
function planLimitConcurrentRuns(): ApiError {
  return new ApiError(
    'plan_limit_concurrent_runs',
    429,
    'The organization autonomous run limit is currently full.',
  );
}
function creditBalanceExhausted(): ApiError {
  return new ApiError(
    'credit_balance_exhausted',
    402,
    'The organization credit balance is exhausted.',
  );
}
function planBudgetExceeded(): ApiError {
  return new ApiError(
    'plan_budget_exceeded',
    422,
    'The requested budget exceeds the organization plan maximum.',
  );
}
function resolveRunBudget(
  pricing: PricingConfig,
  explicit: z.infer<typeof RunBudgetSchema> | undefined,
): z.infer<typeof RunBudgetSchema> {
  if (explicit !== undefined) return explicit;
  const value = Number(pricing.defaultRunCreditCeiling);
  return RunBudgetSchema.parse({ maxCredits: value });
}
export { operationOf, stableId };
