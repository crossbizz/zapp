import { PageSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import {
  OrganizationSettingsPatchSchema,
  OrganizationSettingsSchema,
  type OrganizationStore,
} from '../orgs/store.js';
import { AUDIT_ACTIONS, type AuditMetadata, type AuditValue } from '../plugins/audit.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { DEFAULT_PAGE_SIZE } from '../pagination.js';
import { operationOf } from './runs.js';

const OrganizationParams = z.object({ orgId: idSchema('org') }).strict();
const AuditActionSchema = z.enum(AUDIT_ACTIONS);
const ActorTypeSchema = z.enum(['user', 'service', 'agent', 'support']);
const TargetTypeSchema = z.enum([
  'organization',
  'membership',
  'invite',
  'project',
  'specification',
  'run',
  'workspace',
  'secret',
  'release',
  'integration_connection',
]);
const AuditValueSchema: z.ZodType<AuditValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
]);
const AuditMetadataSchema: z.ZodType<AuditMetadata> = z.record(AuditValueSchema);

const AuditEventSchema = z
  .object({
    id: idSchema('aud'),
    organizationId: idSchema('org'),
    actorType: ActorTypeSchema,
    actorId: z.string().min(1),
    action: AuditActionSchema,
    targetType: TargetTypeSchema,
    targetId: z.string().nullable(),
    metadata: AuditMetadataSchema,
    occurredAt: z.string().datetime(),
  })
  .strict();

const AuditListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
    cursor: idSchema('aud').optional(),
    actorId: z.string().min(1).max(255).optional(),
    action: AuditActionSchema.optional(),
    targetType: TargetTypeSchema.optional(),
    targetId: z.string().min(1).max(255).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.from) <= Date.parse(query.to),
    { message: 'from must not be after to' },
  );

const AuditPageSchema = PageSchema(AuditEventSchema);
const SettingsResponseSchema = z.object({ settings: OrganizationSettingsSchema }).strict();

export interface AuditRoutesDeps {
  readonly organizations: OrganizationStore;
}

export function registerAuditRoutes(app: AppInstance, deps: AuditRoutesDeps): void {
  app.get(
    '/v1/organizations/:orgId/audit-events',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: OrganizationParams,
        querystring: AuditListQuery,
        response: { 200: AuditPageSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'manage_organization');
      const page = await ctx.db.auditEvents.list({
        limit: request.query.limit,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        ...(request.query.actorId === undefined ? {} : { actorId: request.query.actorId }),
        ...(request.query.action === undefined ? {} : { action: request.query.action }),
        ...(request.query.targetType === undefined ? {} : { targetType: request.query.targetType }),
        ...(request.query.targetId === undefined ? {} : { targetId: request.query.targetId }),
        ...(request.query.from === undefined ? {} : { from: new Date(request.query.from) }),
        ...(request.query.to === undefined ? {} : { to: new Date(request.query.to) }),
      });
      return {
        items: page.items.map((event) =>
          AuditEventSchema.parse({
            id: event.id,
            organizationId: event.organizationId,
            actorType: event.actorType,
            actorId: event.actorId,
            action: event.action,
            targetType: event.targetType,
            targetId: event.targetId,
            metadata: event.metadataJson,
            occurredAt: new Date(event.occurredAt).toISOString(),
          }),
        ),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/organizations/:orgId/settings',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: OrganizationParams,
        response: { 200: SettingsResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'manage_organization');
      const settings = await deps.organizations.getSettings(ctx.organizationId);
      if (settings === undefined) throw organizationNotFound();
      return { settings: OrganizationSettingsSchema.parse(settings) };
    },
  );

  app.patch(
    '/v1/organizations/:orgId/settings',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: OrganizationParams,
        body: OrganizationSettingsPatchSchema,
        response: { 200: SettingsResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'manage_organization');
      const operationKey = operationOf(request);
      const fields = Object.keys(request.body).sort();
      const settings = await deps.organizations.updateSettings({
        organizationId: ctx.organizationId,
        patch: request.body,
        operationKey,
        audit: async (tx) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'organization.settings_updated',
            target: { type: 'organization', id: ctx.organizationId },
            metadata: { fields, operationKey },
          });
        },
      });
      if (settings === undefined) throw organizationNotFound();
      return { settings: OrganizationSettingsSchema.parse(settings) };
    },
  );
}

function organizationNotFound(): ApiError {
  return new ApiError('organization_not_found', 404, 'The organization was not found.');
}
