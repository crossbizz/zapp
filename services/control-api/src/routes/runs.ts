import { createHash, createHmac } from 'node:crypto';

import {
  AppTypeSchema,
  AttachmentRefSchema,
  CreditDecimalSchema,
  FixRequestSchema,
  MessageUserPayloadSchema,
  idSchema,
  ModelIdentifierSchema,
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
import { RunSchema, toRun } from '../tenant/view.js';
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
  z.object({ ...CreateRunBodyShape, mode: z.literal('fix'), fixRequest: FixRequestSchema }).strict(),
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
  .object({ messageId: z.string().regex(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u), sequence: z.number().int().positive() })
  .strict();
const ApprovalParams = z
  .object({ runId: idSchema('run'), approvalId: idSchema('appr') })
  .strict();
const ResolveBudgetApprovalBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();
const ApprovalRequestPayload = z
  .object({
    currentCeiling: CreditDecimalSchema,
    absoluteCeiling: CreditDecimalSchema,
    workspaceId: z.string().min(1).max(512),
  })
  .strict();
const ResolvedBudgetApprovalResponse = z
  .object({
    approval: z
      .object({
        approvalId: idSchema('appr'),
        status: z.enum(['approved', 'rejected']),
        absoluteCeiling: CreditDecimalSchema,
      })
      .strict(),
  })
  .strict();

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
  readonly revalidateEventStream: (
    context: EventStreamAuthorizationContext,
  ) => Promise<boolean>;
  readonly pricing?: PricingConfig;
  readonly planLimits?: PlanLimitsConfig;
  readonly creditBalance?: CreditBalanceGate;
  readonly modelCompletions?: ModelCompletionRepository;
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
      const idempotency = idempotencyOf(request);
      // The plugin's raw digest remains suitable for its short-lived Redis
      // record. PostgreSQL gets only this keyed, cross-instance derivative.
      const requestFingerprint = createHmac('sha256', deps.runIntentHmacKey)
        .update(idempotency.fingerprint)
        .digest('hex');
      const operationKey = creationOperationOf(request);
      const runId = stableId('run', operationKey);
      const organization =
        deps.planLimits === undefined ? undefined : await deps.organizations.findById(ctx.organizationId);
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
        if (
          request.body.model !== undefined &&
          pricing.models[request.body.model] === undefined
        ) {
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
          },
          });
        } catch (error) {
          if (error instanceof PlanLimitConcurrentRunsError) throw planLimitConcurrentRuns();
          throw error;
        }
        if (created.outcome === 'conflict') throw idempotencyConflict();
        run = created.run;
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
            ...(limit === undefined ? {} : { planMaxCredits: Number(limit.maxRunBudgetCredits) }),
            operationKey,
            ...(request.body.mode === 'fix' ? { fixRequest: request.body.fixRequest } : {}),
          }),
        );
        z.void().parse(started);
      } catch (error) {
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
        if (artifact === undefined || artifact.projectId !== run.projectId) throw attachmentNotFound();
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
    '/v1/runs/:runId/approvals/:approvalId',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ApprovalParams,
        body: ResolveBudgetApprovalBody,
        response: { 200: ResolvedBudgetApprovalResponse },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const run = await ctx.db.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      authorize(ctx, 'start_run');
      const operationKey = operationOf(request);
      if (request.body.decision === 'approved' && deps.planLimits !== undefined) {
        const organization = await deps.organizations.findById(ctx.organizationId);
        if (organization === undefined) throw runNotFound();
        const approval = await ctx.db.approvals.get(run.id, request.params.approvalId);
        if (approval === undefined || approval.type !== 'budget_increase') throw approvalNotFound();
        const proposed = ApprovalRequestPayload.parse(approval.requestJson).absoluteCeiling;
        if (Number(proposed) > Number(planLimitsFor(deps.planLimits, organization.plan).maxRunBudgetCredits)) {
          throw planBudgetExceeded();
        }
      }
      const resolved = await ctx.db.approvals.resolve({
        runId: run.id,
        approvalId: request.params.approvalId,
        type: 'budget_increase',
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
              decision: request.body.decision,
              operationKey,
            },
          });
        },
      });
      if (resolved === undefined || resolved.approval.type !== 'budget_increase') {
        throw approvalNotFound();
      }
      if (resolved.outcome === 'conflict') throw approvalConflict();
      const approvalRequest = ApprovalRequestPayload.parse(resolved.approval.requestJson);
      if (request.body.decision === 'approved') {
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
      const signalled = SignalRunResultSchema.parse(
        await deps.orchestrator.signalRun(
          SignalRunInputSchema.parse({
            runId: run.id,
            workflowId: run.temporalWorkflowId ?? run.id,
            signal: 'budget_approval',
            approvalId: resolved.approval.id,
            decision: request.body.decision,
            ...(request.body.decision === 'approved'
              ? { absoluteCeiling: approvalRequest.absoluteCeiling }
              : {}),
            operationKey,
          }),
        ),
      );
      if (!signalled.applied) throw invalidRunState();
      return ResolvedBudgetApprovalResponse.parse({
        approval: {
          approvalId: resolved.approval.id,
          status: request.body.decision,
          absoluteCeiling: approvalRequest.absoluteCeiling,
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
function idempotencyOf(request: {
  idempotency?: { key: string; fingerprint: string };
}): { readonly key: string; readonly fingerprint: string } {
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
  return new ApiError(
    'model_not_allowed',
    400,
    'That model is not allowed by this organization.',
  );
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
function workflowFailed(): ApiError {
  return new ApiError(
    'workflow_start_failed',
    502,
    'The run workflow could not be started. Please try again.',
  );
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
  return new ApiError('credit_balance_exhausted', 402, 'The organization credit balance is exhausted.');
}
function planBudgetExceeded(): ApiError {
  return new ApiError('plan_budget_exceeded', 422, 'The requested budget exceeds the organization plan maximum.');
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
