import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';

const ProjectParams = z.object({ projectId: idSchema('proj') });
const SpecificationParams = ProjectParams.extend({
  version: z.coerce.number().int().positive(),
});

const TextSchema = z.string().trim().min(1).max(20_000);
const TextListSchema = z.array(TextSchema).min(1).max(200);
const AcceptanceCriterionSchema = z
  .object({
    id: z.string().regex(/^AC-[1-9][0-9]*$/, 'Acceptance criterion ids must be AC-n.'),
    text: TextSchema,
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    criticalFlow: z.boolean(),
  })
  .strict();

/**
 * Temporary CP-10 boundary schema for PRD §12.2. AR-16 owns the shared
 * SpecificationSchema; until it lands this local schema is intentionally
 * concrete and strict, rather than allowing JSON through the public API.
 */
const SpecificationContentSchema = z
  .object({
    problem: TextSchema,
    targetUsers: TextListSchema,
    goals: TextListSchema,
    nonGoals: TextListSchema,
    journeys: TextListSchema,
    pagesRoutes: TextListSchema,
    rolesPermissions: TextListSchema,
    dataModel: TextListSchema,
    integrations: TextListSchema,
    functionalRequirements: TextListSchema,
    nonfunctionalRequirements: TextListSchema,
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(200),
    assumptions: TextListSchema,
    risks: TextListSchema,
    definitionOfDone: TextListSchema,
  })
  .strict();

const SpecificationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'approved']),
  content: SpecificationContentSchema,
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().datetime().nullable(),
});

const SpecificationResponseSchema = z.object({ specification: SpecificationSchema });

export interface SpecificationRoutesDeps {
  readonly now: () => Date;
}

export function registerSpecificationRoutes(app: AppInstance, deps: SpecificationRoutesDeps): void {
  app.post(
    '/v1/projects/:projectId/specifications',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: ProjectParams,
        body: SpecificationContentSchema,
        response: { 201: SpecificationResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      authorize(ctx, 'edit_code');
      const specification = await ctx.db.specifications.create({
        id: stableSpecificationId(operationOf(request)),
        projectId: project.id,
        content: request.body,
        createdBy: actorOf(request),
        now: deps.now(),
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'specification.created',
            target: { type: 'specification', id: row.id },
            metadata: { projectId: row.projectId, version: row.version },
          });
        },
      });
      return await reply.status(201).send({ specification: toSpecification(specification) });
    },
  );

  app.get(
    '/v1/projects/:projectId/specifications/:version',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { params: SpecificationParams, response: { 200: SpecificationResponseSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      const specification = await ctx.db.specifications.getByProjectVersion(project.id, request.params.version);
      if (specification === undefined) throw specificationNotFound();
      authorize(ctx, 'view_project');
      return { specification: toSpecification(specification) };
    },
  );

  app.patch(
    '/v1/projects/:projectId/specifications/:version',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: SpecificationParams,
        body: SpecificationContentSchema,
        response: { 200: SpecificationResponseSchema },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      const existing = await ctx.db.specifications.getByProjectVersion(project.id, request.params.version);
      if (existing === undefined) throw specificationNotFound();
      authorize(ctx, 'edit_code');
      const updated = await ctx.db.specifications.update({
        projectId: project.id,
        version: existing.version,
        content: request.body,
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'specification.updated',
            target: { type: 'specification', id: row.id },
            metadata: { projectId: row.projectId, version: row.version },
          });
        },
      });
      if (updated === undefined) throw specificationNotFound();
      if (updated === 'immutable') throw specificationImmutable();
      return { specification: toSpecification(updated) };
    },
  );

  app.post(
    '/v1/projects/:projectId/specifications/:version/approve',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: SpecificationParams, response: { 200: SpecificationResponseSchema } },
    },
    async (request) => {
      const ctx = tenantOf(request);
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) throw projectNotFound();
      const existing = await ctx.db.specifications.getByProjectVersion(project.id, request.params.version);
      if (existing === undefined) throw specificationNotFound();
      authorize(ctx, 'edit_code');
      const approved = await ctx.db.specifications.approve({
        projectId: project.id,
        version: existing.version,
        approvedBy: actorOf(request),
        approvedAt: deps.now(),
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'specification.approved',
            target: { type: 'specification', id: row.id },
            metadata: { projectId: row.projectId, version: row.version },
          });
        },
      });
      if (approved === undefined) throw specificationNotFound();
      return { specification: toSpecification(approved) };
    },
  );
}

function operationOf(request: { idempotency?: { key: string; fingerprint: string } }): string {
  if (request.idempotency === undefined) {
    throw new ApiError('idempotency_key_required', 400, 'An Idempotency-Key header is required.');
  }
  return createHash('sha256')
    .update(`${request.idempotency.key}\n${request.idempotency.fingerprint}`)
    .digest('hex');
}

function stableSpecificationId(operation: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(operation).digest();
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
  return `spec_${output}`;
}

function toSpecification(row: {
  id: string;
  organizationId: string;
  projectId: string;
  version: number;
  status: string;
  contentJson: unknown;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
}): z.infer<typeof SpecificationSchema> {
  return SpecificationSchema.parse({
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    version: row.version,
    status: row.status,
    content: row.contentJson,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
  });
}

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'The project was not found.');
}

function specificationNotFound(): ApiError {
  return new ApiError('specification_not_found', 404, 'The specification was not found.');
}

function specificationImmutable(): ApiError {
  return new ApiError('specification_immutable', 409, 'Approved specifications cannot be changed.');
}
