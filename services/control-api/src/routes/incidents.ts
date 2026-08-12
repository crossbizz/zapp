import { createHash, timingSafeEqual } from 'node:crypto';

import { CommitShaSchema, FixRequestSchema, PageSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import type { AuditExecutor } from '../plugins/audit.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { DEFAULT_PAGE_SIZE, type StorePage } from '../pagination.js';
import type { NotificationTrigger } from '../notifications/service.js';
import type { ReleasePort, ReleaseRow } from './releases.js';
import { operationOf } from './runs.js';

export const IncidentSourceSchema = z.enum([
  'grafana_faro',
  'grafana_loki',
  'synthetic_failure',
  'user_report',
]);
export type IncidentSource = z.infer<typeof IncidentSourceSchema>;

const IncidentStatusSchema = z.enum(['open', 'fix_running', 'resolved']);

export const IncidentRecordSchema = z
  .object({
    id: idSchema('aud'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    source: IncidentSourceSchema,
    title: z.string().trim().min(1).max(200),
    errorPayload: z.string().trim().min(1).max(10_000),
    traceUrl: z.string().url().max(4_096).nullable(),
    logsUrl: z.string().url().max(4_096).nullable(),
    reproductionRoute: z.string().trim().min(1).max(4_096),
    evidenceArtifactId: idSchema('art').nullable(),
    fixRunId: idSchema('run').nullable(),
    resolutionReleaseId: idSchema('rel').nullable(),
    createdAt: z.date(),
  })
  .strict();
export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

const PublicIncidentSchema = IncidentRecordSchema.omit({ createdAt: true })
  .extend({
    status: IncidentStatusSchema,
    createdAt: z.string().datetime(),
    fixRequest: FixRequestSchema,
  })
  .strict();

export const CreateIncidentInputSchema = IncidentRecordSchema.pick({
  organizationId: true,
  projectId: true,
  releaseId: true,
  commitSha: true,
  source: true,
  title: true,
  errorPayload: true,
  traceUrl: true,
  logsUrl: true,
  reproductionRoute: true,
  evidenceArtifactId: true,
  createdAt: true,
})
  .extend({
    idempotencyKey: z.string().trim().min(8).max(512),
    actorType: z.enum(['user', 'service']),
    actorId: z.string().trim().min(1).max(255),
  })
  .strict();
export type CreateIncidentInput = z.infer<typeof CreateIncidentInputSchema>;

export const IncidentLookupSchema = z
  .object({ organizationId: idSchema('org'), incidentId: idSchema('aud') })
  .strict();
export type IncidentLookup = z.infer<typeof IncidentLookupSchema>;

export const IncidentListInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    limit: z.number().int().min(1).max(100),
    cursor: idSchema('aud').optional(),
  })
  .strict();
export type IncidentListInput = z.infer<typeof IncidentListInputSchema>;

export const LinkIncidentFixRunInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    incidentId: idSchema('aud'),
    releaseId: idSchema('rel'),
    runId: idSchema('run'),
    actorId: idSchema('user'),
    occurredAt: z.date(),
  })
  .strict();
export type LinkIncidentFixRunInput = z.infer<typeof LinkIncidentFixRunInputSchema>;

export const ResolveIncidentInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    fixRunId: idSchema('run'),
    releaseId: idSchema('rel'),
    actorId: idSchema('user'),
    occurredAt: z.date(),
  })
  .strict();
export type ResolveIncidentInput = z.infer<typeof ResolveIncidentInputSchema>;

export interface IncidentStore {
  create(input: CreateIncidentInput): Promise<IncidentRecord>;
  get(input: IncidentLookup): Promise<IncidentRecord | undefined>;
  list(input: IncidentListInput): Promise<StorePage<IncidentRecord>>;
  linkFixRun(tx: AuditExecutor, input: LinkIncidentFixRunInput): Promise<void>;
  resolveForRun(tx: AuditExecutor, input: ResolveIncidentInput): Promise<void>;
}

function stableAuditId(namespace: string, key: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(`${namespace}:${key}`).digest();
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
  return idSchema('aud').parse(`aud_${output}`);
}

export function incidentIdFor(organizationId: string, idempotencyKey: string): string {
  return stableAuditId('incident', `${organizationId}:${idempotencyKey}`);
}

export function incidentLinkId(incidentId: string, runId: string): string {
  return stableAuditId('incident-fix', `${incidentId}:${runId}`);
}

export function incidentResolutionId(incidentId: string, releaseId: string): string {
  return stableAuditId('incident-resolution', `${incidentId}:${releaseId}`);
}

export class IncidentConflictError extends Error {
  constructor() {
    super('incident idempotency conflict');
    this.name = 'IncidentConflictError';
  }
}

export function createInMemoryIncidentStore(): IncidentStore {
  const incidents = new Map<string, IncidentRecord>();

  return {
    create(rawInput) {
      const input = CreateIncidentInputSchema.parse(rawInput);
      const id = incidentIdFor(input.organizationId, input.idempotencyKey);
      const record = IncidentRecordSchema.parse({
        id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        releaseId: input.releaseId,
        commitSha: input.commitSha,
        source: input.source,
        title: input.title,
        errorPayload: input.errorPayload,
        traceUrl: input.traceUrl,
        logsUrl: input.logsUrl,
        reproductionRoute: input.reproductionRoute,
        evidenceArtifactId: input.evidenceArtifactId,
        fixRunId: null,
        resolutionReleaseId: null,
        createdAt: input.createdAt,
      });
      const existing = incidents.get(id);
      if (existing !== undefined) {
        const comparable = { ...existing, fixRunId: null, resolutionReleaseId: null };
        if (JSON.stringify(comparable) !== JSON.stringify(record)) {
          throw new IncidentConflictError();
        }
        return Promise.resolve(existing);
      }
      incidents.set(id, record);
      return Promise.resolve(record);
    },
    get(rawInput) {
      const input = IncidentLookupSchema.parse(rawInput);
      const record = incidents.get(input.incidentId);
      return Promise.resolve(record?.organizationId === input.organizationId ? record : undefined);
    },
    list(rawInput) {
      const input = IncidentListInputSchema.parse(rawInput);
      const rows = [...incidents.values()]
        .filter(
          (record) =>
            record.organizationId === input.organizationId &&
            record.projectId === input.projectId &&
            (input.cursor === undefined || record.id < input.cursor),
        )
        .sort((left, right) => (left.id < right.id ? 1 : -1));
      const items = rows.slice(0, input.limit);
      return Promise.resolve({
        items,
        nextCursor: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
      });
    },
    linkFixRun(_tx, rawInput) {
      const input = LinkIncidentFixRunInputSchema.parse(rawInput);
      const incident = incidents.get(input.incidentId);
      if (
        incident === undefined ||
        incident.organizationId !== input.organizationId ||
        incident.projectId !== input.projectId ||
        incident.releaseId !== input.releaseId
      ) {
        return Promise.reject(new IncidentConflictError());
      }
      if (incident.fixRunId !== null && incident.fixRunId !== input.runId) {
        return Promise.reject(new IncidentConflictError());
      }
      incident.fixRunId = input.runId;
      return Promise.resolve();
    },
    resolveForRun(_tx, rawInput) {
      const input = ResolveIncidentInputSchema.parse(rawInput);
      for (const incident of incidents.values()) {
        if (
          incident.organizationId === input.organizationId &&
          incident.projectId === input.projectId &&
          incident.fixRunId === input.fixRunId
        ) {
          incident.resolutionReleaseId = input.releaseId;
        }
      }
      return Promise.resolve();
    },
  };
}

const ProjectParams = z.object({ projectId: idSchema('proj') }).strict();
const IncidentListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
    cursor: idSchema('aud').optional(),
  })
  .strict();
const UserReportBody = z
  .object({
    releaseId: idSchema('rel'),
    title: z.string().trim().min(1).max(200),
    errorPayload: z.string().trim().min(1).max(10_000),
    traceUrl: z.string().url().max(4_096).optional(),
    logsUrl: z.string().url().max(4_096).optional(),
    reproductionRoute: z.string().trim().min(1).max(4_096),
  })
  .strict();

const GrafanaAlertSchema = z
  .object({
    fingerprint: z.string().trim().min(1).max(512),
    status: z.enum(['firing', 'resolved']),
    labels: z
      .object({
        organization_id: idSchema('org'),
        project_id: idSchema('proj'),
        release_id: idSchema('rel'),
        source: z.enum(['grafana_faro', 'grafana_loki']),
      })
      .passthrough(),
    annotations: z
      .object({
        summary: z.string().trim().min(1).max(200),
        error_payload: z.string().trim().min(1).max(10_000),
        trace_url: z.string().url().max(4_096).optional(),
        logs_url: z.string().url().max(4_096).optional(),
        repro_route: z.string().trim().min(1).max(4_096),
      })
      .passthrough(),
  })
  .passthrough();
const GrafanaWebhookBody = z
  .object({
    status: z.enum(['firing', 'resolved']),
    alerts: z.array(GrafanaAlertSchema).min(1).max(100),
  })
  .passthrough();

const SyntheticIncidentBody = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(512),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    releaseId: idSchema('rel'),
    syntheticCheckId: idSchema('syn'),
    title: z.string().trim().min(1).max(200),
    errorPayload: z.string().trim().min(1).max(10_000),
    evidenceArtifactId: idSchema('art'),
    reproductionRoute: z.string().trim().min(1).max(4_096),
  })
  .strict();

export interface IncidentRoutesDeps {
  readonly store: IncidentStore;
  readonly releases: ReleasePort;
  readonly now: () => Date;
  readonly grafanaWebhookSecret?: string;
  readonly enqueueNotification?: (trigger: NotificationTrigger) => Promise<void>;
}

function incidentStatus(record: IncidentRecord): z.infer<typeof IncidentStatusSchema> {
  if (record.resolutionReleaseId !== null) return 'resolved';
  if (record.fixRunId !== null) return 'fix_running';
  return 'open';
}

function fixRequest(record: IncidentRecord): z.infer<typeof FixRequestSchema> {
  const evidence: z.infer<typeof FixRequestSchema>['evidence'] = [
    {
      kind: 'incident_record',
      incidentId: record.id,
      summary: record.title,
    },
  ];
  if (record.evidenceArtifactId !== null) {
    evidence.push({
      kind: record.source === 'synthetic_failure' ? 'failed_check' : 'user_report',
      artifactId: record.evidenceArtifactId,
      summary: record.title,
    });
  }
  if (record.traceUrl !== null) {
    evidence.push({ kind: 'grafana_faro', url: record.traceUrl, summary: record.title });
  }
  if (record.logsUrl !== null) {
    evidence.push({ kind: 'grafana_loki', url: record.logsUrl, summary: record.title });
  }
  const source =
    record.source === 'user_report'
      ? 'user_bug'
      : record.source === 'synthetic_failure'
        ? 'failed_check'
        : 'error_report';
  return FixRequestSchema.parse({
    source,
    summary: record.title,
    relevantCommitSha: record.commitSha,
    reproductionRef: record.reproductionRoute,
    evidence,
    incidentId: record.id,
    releaseId: record.releaseId,
    errorPayload: record.errorPayload,
  });
}

function publicIncident(record: IncidentRecord): z.infer<typeof PublicIncidentSchema> {
  return PublicIncidentSchema.parse({
    ...record,
    status: incidentStatus(record),
    createdAt: record.createdAt.toISOString(),
    fixRequest: fixRequest(record),
  });
}

async function releaseForIncident(
  deps: IncidentRoutesDeps,
  organizationId: string,
  projectId: string,
  releaseId: string,
): Promise<ReleaseRow> {
  const release = await deps.releases.getRelease({ organizationId, releaseId });
  if (release === undefined || release.projectId !== projectId) {
    throw new ApiError('release_not_found', 404, 'That release does not exist.');
  }
  return release;
}

function webhookAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (secret === undefined || header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(supplied, expected);
}

function incidentNotification(record: IncidentRecord): NotificationTrigger {
  return {
    triggerId: `incident:${record.id}`,
    type: 'production_incident',
    organizationId: record.organizationId,
    projectId: record.projectId,
    occurredAt: record.createdAt.toISOString(),
    audience: { kind: 'organization', roles: ['owner', 'builder'] },
    context: { incidentId: record.id },
  };
}

export function registerIncidentRoutes(app: AppInstance, deps: IncidentRoutesDeps): void {
  app.get(
    '/v1/projects/:projectId/incidents',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: ProjectParams,
        querystring: IncidentListQuery,
        response: { 200: PageSchema(PublicIncidentSchema) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined)
        throw new ApiError('project_not_found', 404, 'That project does not exist.');
      authorize(ctx, 'view_project');
      const page = await deps.store.list({
        organizationId: ctx.organizationId,
        projectId: project.id,
        limit: request.query.limit,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      });
      return { items: page.items.map(publicIncident), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/v1/projects/:projectId/incidents',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: UserReportBody,
        response: { 201: z.object({ incident: PublicIncidentSchema }).strict() },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined)
        throw new ApiError('project_not_found', 404, 'That project does not exist.');
      authorize(ctx, 'start_run');
      const release = await releaseForIncident(
        deps,
        ctx.organizationId,
        project.id,
        request.body.releaseId,
      );
      let incident: IncidentRecord;
      try {
        incident = await deps.store.create({
          idempotencyKey: operationOf(request),
          organizationId: ctx.organizationId,
          projectId: project.id,
          releaseId: release.id,
          commitSha: release.commitSha,
          source: 'user_report',
          title: request.body.title,
          errorPayload: request.body.errorPayload,
          traceUrl: request.body.traceUrl ?? null,
          logsUrl: request.body.logsUrl ?? null,
          reproductionRoute: request.body.reproductionRoute,
          evidenceArtifactId: null,
          actorType: 'user',
          actorId: actorOf(request),
          createdAt: deps.now(),
        });
      } catch (error) {
        if (error instanceof IncidentConflictError) {
          throw new ApiError('idempotency_conflict', 422, 'That incident key was already used.');
        }
        throw error;
      }
      if (deps.enqueueNotification !== undefined) {
        await deps.enqueueNotification(incidentNotification(incident));
      }
      return await reply.status(201).send({ incident: publicIncident(incident) });
    },
  );

  app.post(
    '/v1/webhooks/grafana',
    {
      schema: {
        body: GrafanaWebhookBody,
        response: { 202: z.object({ accepted: z.number().int().nonnegative() }).strict() },
      },
    },
    async (request, reply) => {
      if (!webhookAuthorized(request.headers.authorization, deps.grafanaWebhookSecret)) {
        throw new ApiError(
          'webhook_unauthenticated',
          401,
          'A valid webhook credential is required.',
        );
      }
      const firing = request.body.alerts.filter((alert) => alert.status === 'firing');
      const releases = await Promise.all(
        firing.map(async (alert) => ({
          alert,
          release: await releaseForIncident(
            deps,
            alert.labels.organization_id,
            alert.labels.project_id,
            alert.labels.release_id,
          ),
        })),
      );
      for (const { alert, release } of releases) {
        const incident = await deps.store.create({
          idempotencyKey: `grafana:${release.id}:${alert.fingerprint}`,
          organizationId: alert.labels.organization_id,
          projectId: alert.labels.project_id,
          releaseId: release.id,
          commitSha: release.commitSha,
          source: alert.labels.source,
          title: alert.annotations.summary,
          errorPayload: alert.annotations.error_payload,
          traceUrl: alert.annotations.trace_url ?? null,
          logsUrl: alert.annotations.logs_url ?? null,
          reproductionRoute: alert.annotations.repro_route,
          evidenceArtifactId: null,
          actorType: 'service',
          actorId: 'grafana-alerting',
          createdAt: deps.now(),
        });
        if (deps.enqueueNotification !== undefined) {
          await deps.enqueueNotification(incidentNotification(incident));
        }
      }
      return await reply.status(202).send({ accepted: firing.length });
    },
  );

  app.post(
    '/internal/incidents',
    {
      preHandler: app.requireService({
        audience: 'control-api:incidents.ingest',
        callers: ['release-service'],
        singleUse: false,
      }),
      schema: {
        body: SyntheticIncidentBody,
        response: { 201: z.object({ incident: PublicIncidentSchema }).strict() },
      },
    },
    async (request, reply) => {
      const release = await releaseForIncident(
        deps,
        request.body.organizationId,
        request.body.projectId,
        request.body.releaseId,
      );
      const incident = await deps.store.create({
        idempotencyKey: request.body.idempotencyKey,
        organizationId: request.body.organizationId,
        projectId: request.body.projectId,
        releaseId: release.id,
        commitSha: release.commitSha,
        source: 'synthetic_failure',
        title: request.body.title,
        errorPayload: request.body.errorPayload,
        traceUrl: null,
        logsUrl: null,
        reproductionRoute: request.body.reproductionRoute,
        evidenceArtifactId: request.body.evidenceArtifactId,
        actorType: 'service',
        actorId: request.service?.service ?? 'release-service',
        createdAt: deps.now(),
      });
      if (deps.enqueueNotification !== undefined) {
        await deps.enqueueNotification(incidentNotification(incident));
      }
      return await reply.status(201).send({ incident: publicIncident(incident) });
    },
  );
}
