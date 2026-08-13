import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  AuditRecordSchema,
  SignalRunInputSchema,
  SignalRunResultSchema,
  WorkspaceStatusSchema,
  idSchema,
} from '@zapp/contracts';
import { defineEnv } from '@zapp/config';
import { z } from 'zod';

import type { SupportTenantAccessPort } from '../admin/tenant-access.js';
import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import type { OrganizationStore } from '../orgs/store.js';
import type { OrchestratorPort } from '../orchestrator/port.js';
import type { AuditSink } from '../plugins/audit.js';
import { actorOf } from '../plugins/auth.js';
import { IdempotencyHeadersSchema } from '../plugins/idempotency.js';
import {
  SupportTerminateWorkspaceResultSchema,
  TerminateOrganizationInputSchema,
  TerminateOrganizationResultSchema,
  TerminateWorkspaceInputSchema,
  type SupportSandboxServicePort,
} from '../sandbox/port.js';
import { toRun, toWorkspace } from '../tenant/view.js';
import type { UsageLedgerRepository } from '../usage/ledger.js';
import { operationOf } from './runs.js';
import { toSandboxWorkspace } from './workspaces.js';

export const SUPPORT_SESSION_HEADER = 'x-zapp-support-session';
const SUPPORT_SESSION_TTL_MS = 30 * 60_000;
const SUPPORT_SESSION_ID = /^support_[0-9a-f]{32}$/u;

const SupportReasonSchema = z.string().trim().min(10).max(500);
const SupportSessionPayloadSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(SUPPORT_SESSION_ID),
    staffUserId: idSchema('user'),
    organizationId: idSchema('org'),
    reason: SupportReasonSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
type SupportSession = z.infer<typeof SupportSessionPayloadSchema>;

const StartSupportSessionBodySchema = z
  .object({ organizationId: idSchema('org'), reason: z.string().optional() })
  .strict();
const StartSupportSessionResponseSchema = z
  .object({
    id: z.string().regex(SUPPORT_SESSION_ID),
    token: z.string().min(1),
    organizationId: idSchema('org'),
    expiresAt: z.string().datetime(),
  })
  .strict();
const OrganizationParamsSchema = z.object({ organizationId: idSchema('org') }).strict();
const RunParamsSchema = OrganizationParamsSchema.extend({ runId: idSchema('run') }).strict();
const WorkspaceParamsSchema = OrganizationParamsSchema.extend({
  workspaceId: idSchema('ws'),
}).strict();
const UsageWindowQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((window) => Date.parse(window.from) < Date.parse(window.to), {
    message: 'from must be before to',
  });
const SupportHeadersSchema = z
  .object({ [SUPPORT_SESSION_HEADER]: z.string().min(1) })
  .passthrough();
const SupportMutationHeadersSchema = IdempotencyHeadersSchema.extend({
  [SUPPORT_SESSION_HEADER]: z.string().min(1),
});

const AdminRunSchema = z
  .object({
    id: idSchema('run'),
    projectId: idSchema('proj'),
    mode: z.string(),
    status: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
const AdminWorkspaceSchema = z
  .object({
    id: idSchema('ws'),
    projectId: idSchema('proj'),
    runId: idSchema('run').nullable(),
    provider: z.string(),
    status: WorkspaceStatusSchema,
    resourceProfile: z.string(),
    createdAt: z.string().datetime(),
    lastActiveAt: z.string().datetime().nullable(),
    terminatedAt: z.string().datetime().nullable(),
  })
  .strict();
const ProjectOverviewSchema = z
  .object({
    id: idSchema('proj'),
    name: z.string(),
    slug: z.string(),
    supportLevel: z.string(),
    archivedAt: z.string().datetime().nullable(),
    lastActivityAt: z.string().datetime().nullable(),
    releaseStatus: z.string().nullable(),
    deploymentStatus: z.string().nullable(),
    runs: z.array(AdminRunSchema).max(25),
    workspaces: z.array(AdminWorkspaceSchema).max(25),
  })
  .strict();
const UsageBreakdownSchema = z
  .object({
    byCategory: z.array(z.object({ category: z.string(), quantity: z.string() }).strict()),
    byProject: z.array(z.object({ projectId: z.string().nullable(), quantity: z.string() }).strict()),
    byRun: z.array(z.object({ runId: z.string().nullable(), quantity: z.string() }).strict()),
  })
  .strict();
const OverviewResponseSchema = z
  .object({
    organization: z
      .object({ id: idSchema('org'), name: z.string(), slug: z.string(), plan: z.string() })
      .strict(),
    projects: z.array(ProjectOverviewSchema).max(50),
    usage: UsageBreakdownSchema,
  })
  .strict();
const SupportEventSchema = z
  .object({
    id: idSchema('evt'),
    sequence: z.number().int().positive(),
    type: z.string(),
    occurredAt: z.string().datetime(),
    phaseId: z.string().nullable(),
    taskId: z.string().nullable(),
    agentId: z.string().nullable(),
    payload: z.record(z.unknown()),
  })
  .strict();
const DiagnosticArtifactSchema = z
  .object({
    id: idSchema('art'),
    type: z.string(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: z.string().datetime(),
  })
  .strict();
const DiagnosticsResponseSchema = z
  .object({
    run: AdminRunSchema,
    events: z.array(SupportEventSchema).max(100),
    artifacts: z.array(DiagnosticArtifactSchema).max(100),
    sourceInspection: z
      .object({ allowed: z.literal(false), requiresCustomerGrant: z.literal(true) })
      .strict(),
  })
  .strict();
const RunTerminationResponseSchema = z.object({ run: AdminRunSchema }).strict();
const WorkspaceTerminationResponseSchema = z.object({ workspace: AdminWorkspaceSchema }).strict();
const OrganizationTerminationResponseSchema = TerminateOrganizationResultSchema;

export interface AdminRoutesConfig {
  readonly enabled: boolean;
  readonly staffUserIds: readonly string[];
}

const SupportAdminEnvSchema = z
  .object({
    SUPPORT_ADMIN_ENABLED: z.enum(['true', 'false']).default('false'),
    SUPPORT_ADMIN_USER_IDS: z.string().default(''),
  })
  .transform((environment, context): AdminRoutesConfig => {
    const staffUserIds = environment.SUPPORT_ADMIN_USER_IDS.split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    if (staffUserIds.some((value) => !idSchema('user').safeParse(value).success)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'staff user ids must be valid user identifiers',
        path: ['SUPPORT_ADMIN_USER_IDS'],
      });
    }
    if (environment.SUPPORT_ADMIN_ENABLED === 'true' && staffUserIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enabled support admin requires at least one staff user',
        path: ['SUPPORT_ADMIN_USER_IDS'],
      });
    }
    return { enabled: environment.SUPPORT_ADMIN_ENABLED === 'true', staffUserIds };
  });

export function loadSupportAdminConfig(source: unknown = process.env): AdminRoutesConfig {
  return defineEnv(SupportAdminEnvSchema, source);
}

export interface AdminRoutesDeps {
  readonly config: AdminRoutesConfig;
  readonly sessionSecret: string;
  readonly organizations: OrganizationStore;
  readonly tenants: SupportTenantAccessPort;
  readonly orchestrator: OrchestratorPort;
  readonly sandbox: SupportSandboxServicePort;
  readonly usage: UsageLedgerRepository;
  readonly audit: AuditSink;
  readonly now: () => Date;
}

type AdminRunRow = Exclude<
  Awaited<ReturnType<ReturnType<SupportTenantAccessPort['forOrganization']>['runs']['getById']>>,
  undefined
>;
type AdminWorkspaceRow = Exclude<
  Awaited<
    ReturnType<ReturnType<SupportTenantAccessPort['forOrganization']>['workspaces']['getById']>
  >,
  undefined
>;

export function registerAdminRoutes(app: AppInstance, deps: AdminRoutesDeps): void {
  const allowedStaff = new Set(deps.config.staffUserIds.map((id) => idSchema('user').parse(id)));
  const secret = createHmac(
    'sha256',
    Buffer.from(z.string().min(32).parse(deps.sessionSecret), 'utf8'),
  )
    .update('zapp-support-session/v1')
    .digest();

  function requireStaff(request: Parameters<typeof actorOf>[0]): string {
    const userId = actorOf(request);
    if (!deps.config.enabled || !allowedStaff.has(userId)) {
      throw new ApiError('staff_access_denied', 403, 'Staff access is not available.');
    }
    return userId;
  }

  function createSession(staffUserId: string, organizationId: string, reason: string): {
    readonly session: SupportSession;
    readonly token: string;
  } {
    const issuedAt = deps.now();
    const session = SupportSessionPayloadSchema.parse({
      version: 1,
      id: `support_${randomBytes(16).toString('hex')}`,
      staffUserId,
      organizationId,
      reason,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + SUPPORT_SESSION_TTL_MS).toISOString(),
    });
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return { session, token: `${payload}.${signature}` };
  }

  function requireSupportSession(
    request: Parameters<typeof actorOf>[0] & { readonly headers: Record<string, unknown> },
    organizationId: string,
  ): SupportSession {
    const staffUserId = requireStaff(request);
    const raw = request.headers[SUPPORT_SESSION_HEADER];
    const token = typeof raw === 'string' ? raw : '';
    const [payload, suppliedSignature, extra] = token.split('.');
    if (payload === undefined || suppliedSignature === undefined || extra !== undefined) {
      throw supportSessionInvalid();
    }
    const expectedSignature = createHmac('sha256', secret).update(payload).digest();
    let signature: Buffer;
    try {
      signature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      throw supportSessionInvalid();
    }
    if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
      throw supportSessionInvalid();
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw supportSessionInvalid();
    }
    const session = SupportSessionPayloadSchema.safeParse(decoded);
    if (
      !session.success ||
      session.data.staffUserId !== staffUserId ||
      Date.parse(session.data.expiresAt) <= deps.now().getTime()
    ) {
      throw supportSessionInvalid();
    }
    if (session.data.organizationId !== organizationId) throw organizationNotFound();
    return session.data;
  }

  function supportAudit(
    session: SupportSession,
    operation: string,
    target: { readonly type: 'organization' | 'project' | 'run' | 'workspace'; readonly id: string },
    metadata: Record<string, string | number | boolean | null> = {},
  ) {
    return AuditRecordSchema.parse({
      organizationId: session.organizationId,
      actorType: 'support',
      actorId: session.staffUserId,
      action: 'support.impersonation',
      targetType: target.type,
      targetId: target.id,
      metadata: {
        supportSessionId: session.id,
        reason: session.reason,
        operation,
        ...metadata,
      },
      occurredAt: deps.now(),
    });
  }

  async function auditRead(
    session: SupportSession,
    operation: string,
    target: { readonly type: 'organization' | 'project' | 'run' | 'workspace'; readonly id: string },
  ): Promise<void> {
    await deps.audit.recordDetached(supportAudit(session, operation, target));
  }

  app.post(
    '/v1/admin/support-sessions',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        headers: IdempotencyHeadersSchema,
        body: StartSupportSessionBodySchema,
        response: { 201: StartSupportSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const staffUserId = requireStaff(request);
      const parsedReason = SupportReasonSchema.safeParse(request.body.reason);
      if (!parsedReason.success) {
        throw new ApiError(
          'support_reason_required',
          422,
          'An explicit support access reason is required.',
        );
      }
      const organization = await deps.organizations.findById(request.body.organizationId);
      if (organization === undefined) throw organizationNotFound();
      const created = createSession(staffUserId, organization.id, parsedReason.data);
      await deps.audit.recordDetached(
        supportAudit(created.session, 'session.started', {
          type: 'organization',
          id: organization.id,
        }),
      );
      return await reply.status(201).send({
        id: created.session.id,
        token: created.token,
        organizationId: organization.id,
        expiresAt: created.session.expiresAt,
      });
    },
  );

  app.get(
    '/v1/admin/organizations/:organizationId/overview',
    {
      preHandler: [app.requireSession],
      schema: {
        headers: SupportHeadersSchema,
        params: OrganizationParamsSchema,
        querystring: UsageWindowQuerySchema,
        response: { 200: OverviewResponseSchema },
      },
    },
    async (request) => {
      const session = requireSupportSession(request, request.params.organizationId);
      await auditRead(session, 'tenant.overview', {
        type: 'organization',
        id: session.organizationId,
      });
      const organization = await deps.organizations.findById(session.organizationId);
      if (organization === undefined) throw organizationNotFound();
      const database = deps.tenants.forOrganization(session.organizationId);
      const page = await database.projects.list({ limit: 50 });
      const summaries =
        (await database.projectSummaries.forProjects(page.items.map((project) => project.id))) ?? [];
      const summaryByProject = new Map(summaries.map((summary) => [summary.projectId, summary]));
      const projects = await Promise.all(
        page.items.map(async (project) => {
          const [runs, workspaces] = await Promise.all([
            database.runs.byProject(project.id, 25),
            database.workspaces.byProject(project.id, 25),
          ]);
          const summary = summaryByProject.get(project.id);
          return ProjectOverviewSchema.parse({
            id: project.id,
            name: project.name,
            slug: project.slug,
            supportLevel: project.supportLevel,
            archivedAt: project.archivedAt?.toISOString() ?? null,
            lastActivityAt: summary?.lastActivityAt?.toISOString() ?? null,
            releaseStatus: summary?.release?.status ?? null,
            deploymentStatus: summary?.deployment?.status ?? null,
            runs: runs.map(adminRun),
            workspaces: workspaces.map(adminWorkspace),
          });
        }),
      );
      const usage = await deps.usage.getUsageSummary(session.organizationId, request.query);
      return OverviewResponseSchema.parse({ organization, projects, usage });
    },
  );

  app.get(
    '/v1/admin/organizations/:organizationId/runs/:runId/diagnostics',
    {
      preHandler: [app.requireSession],
      schema: {
        headers: SupportHeadersSchema,
        params: RunParamsSchema,
        response: { 200: DiagnosticsResponseSchema },
      },
    },
    async (request) => {
      const session = requireSupportSession(request, request.params.organizationId);
      await auditRead(session, 'run.diagnostics', { type: 'run', id: request.params.runId });
      const database = deps.tenants.forOrganization(session.organizationId);
      const run = await database.runs.getById(request.params.runId);
      if (run === undefined) throw runNotFound();
      const [events, mission] = await Promise.all([
        database.events.byRun(run.id, { limit: 100 }),
        database.missionControl.forRun(run.id),
      ]);
      return DiagnosticsResponseSchema.parse({
        run: adminRun(run),
        events: events
          .filter((event) => event.visibility === 'support')
          .map((event) => ({
            id: event.id,
            sequence: event.sequence,
            type: event.type,
            occurredAt: new Date(event.occurredAt).toISOString(),
            phaseId: event.phaseId,
            taskId: event.taskId,
            agentId: event.agentId,
            payload: event.payloadJson,
          })),
        artifacts: mission.artifacts.slice(0, 100).map((artifact) => ({
          id: artifact.id,
          type: artifact.type,
          contentHash: artifact.contentHash,
          createdAt: artifact.createdAt.toISOString(),
        })),
        sourceInspection: { allowed: false, requiresCustomerGrant: true },
      });
    },
  );

  app.post(
    '/v1/admin/organizations/:organizationId/terminate-all',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        headers: SupportMutationHeadersSchema,
        params: OrganizationParamsSchema,
        response: { 200: OrganizationTerminationResponseSchema },
      },
    },
    async (request) => {
      const session = requireSupportSession(request, request.params.organizationId);
      const operationKey = operationOf(request);
      await deps.audit.recordDetached(
        supportAudit(
          session,
          'organization.terminate_all',
          { type: 'organization', id: session.organizationId },
          { operationKey },
        ),
      );
      return OrganizationTerminationResponseSchema.parse(
        await deps.sandbox.terminateOrganization(
          TerminateOrganizationInputSchema.parse({
            organizationId: session.organizationId,
            actorUserId: session.staffUserId,
            reason: session.reason,
            operationKey,
          }),
        ),
      );
    },
  );

  app.post(
    '/v1/admin/organizations/:organizationId/runs/:runId/terminate',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        headers: SupportMutationHeadersSchema,
        params: RunParamsSchema,
        response: { 202: RunTerminationResponseSchema },
      },
    },
    async (request, reply) => {
      const session = requireSupportSession(request, request.params.organizationId);
      const database = deps.tenants.forOrganization(session.organizationId);
      const operationKey = operationOf(request);
      const claim = await database.runs.claimOperation({
        runId: request.params.runId,
        operationKey,
        allowedStatuses: ['queued', 'running', 'paused', 'waiting_for_approval'],
        audit: (tx, run) =>
          deps.audit.record(
            tx,
            supportAudit(session, 'run.terminate', { type: 'run', id: run.id }, { operationKey }),
          ),
      });
      if (claim === undefined) throw runNotFound();
      if (claim.outcome === 'blocked' || claim.outcome === 'rejected') throw invalidRunState();
      if (claim.outcome === 'dispatch') {
        const result = SignalRunResultSchema.parse(
          await deps.orchestrator.signalRun(
            SignalRunInputSchema.parse({
              runId: claim.entity.id,
              workflowId: claim.entity.temporalWorkflowId ?? claim.entity.id,
              mode: claim.entity.mode,
              signal: 'cancel',
              operationKey,
            }),
          ),
        );
        if (!result.applied) {
          await database.runs.rejectOperation({
            runId: claim.entity.id,
            operationKey,
            audit: (tx, run) =>
              deps.audit.record(
                tx,
                supportAudit(session, 'run.terminate_rejected', { type: 'run', id: run.id }, {
                  operationKey,
                }),
              ),
          });
          throw invalidRunState();
        }
      }
      return await reply.status(202).send({ run: adminRun(claim.entity) });
    },
  );

  app.post(
    '/v1/admin/organizations/:organizationId/workspaces/:workspaceId/terminate',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        headers: SupportMutationHeadersSchema,
        params: WorkspaceParamsSchema,
        response: { 200: WorkspaceTerminationResponseSchema },
      },
    },
    async (request) => {
      const session = requireSupportSession(request, request.params.organizationId);
      const database = deps.tenants.forOrganization(session.organizationId);
      const operationKey = operationOf(request);
      const workspace = await database.workspaces.getById(request.params.workspaceId);
      if (workspace === undefined) throw workspaceNotFound();
      if (workspace.status === 'terminated') throw invalidWorkspaceState();
      await deps.audit.recordDetached(
        supportAudit(
          session,
          'workspace.terminate',
          { type: 'workspace', id: workspace.id },
          { operationKey },
        ),
      );
      const result = SupportTerminateWorkspaceResultSchema.parse(
        await deps.sandbox.terminateWorkspace(
          TerminateWorkspaceInputSchema.parse({
            workspace: toSandboxWorkspace(workspace),
            operationKey,
          }),
        ),
      );
      return {
        workspace: adminWorkspace({
          ...workspace,
          status: result.status,
          terminatedAt: result.terminatedAt,
        }),
      };
    },
  );
}

function adminRun(run: AdminRunRow) {
  const wire = toRun(run);
  return AdminRunSchema.parse({
    id: wire.id,
    projectId: wire.projectId,
    mode: wire.mode,
    status: wire.status,
    startedAt: wire.startedAt,
    completedAt: wire.completedAt,
  });
}

function adminWorkspace(
  workspace: AdminWorkspaceRow,
) {
  const wire = toWorkspace(workspace);
  return AdminWorkspaceSchema.parse({
    id: wire.id,
    projectId: wire.projectId,
    runId: workspace.runId,
    provider: wire.provider,
    status: wire.status,
    resourceProfile: wire.resourceProfile,
    createdAt: wire.createdAt,
    lastActiveAt: wire.lastActiveAt,
    terminatedAt: wire.terminatedAt,
  });
}

function supportSessionInvalid(): ApiError {
  return new ApiError('support_session_invalid', 403, 'The support session is invalid or expired.');
}

function organizationNotFound(): ApiError {
  return new ApiError('organization_not_found', 404, 'That organization does not exist.');
}

function runNotFound(): ApiError {
  return new ApiError('run_not_found', 404, 'That run does not exist.');
}

function workspaceNotFound(): ApiError {
  return new ApiError('workspace_not_found', 404, 'That workspace does not exist.');
}

function invalidRunState(): ApiError {
  return new ApiError('invalid_run_state', 409, 'That run cannot accept this action.');
}

function invalidWorkspaceState(): ApiError {
  return new ApiError(
    'invalid_workspace_state',
    409,
    'That workspace cannot accept this action.',
  );
}
