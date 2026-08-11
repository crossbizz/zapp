import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import { SpecificationContentEtagSchema } from '@zapp/specification-engine';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import {
  SpecificationContentSchema,
  SpecificationResponseSchema,
  toSpecification,
} from '../tenant/view.js';

const ProjectParams = z.object({ projectId: idSchema('proj') });
const SpecificationParams = ProjectParams.extend({
  version: z.coerce.number().int().positive(),
});
const SpecificationApprovalHeaders = z
  .object({ 'if-match': SpecificationContentEtagSchema.optional() })
  .passthrough();

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
      schema: {
        params: SpecificationParams,
        headers: SpecificationApprovalHeaders,
        response: { 200: SpecificationResponseSchema },
      },
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
      const operationKey = operationOf(request);
      const updated = await ctx.db.specifications.update({
        projectId: project.id,
        version: existing.version,
        content: request.body,
        operationKey,
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'specification.updated',
            target: { type: 'specification', id: row.id },
            metadata: { projectId: row.projectId, version: row.version, operationKey },
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
      const operationKey = operationOf(request);
      const approved = await ctx.db.specifications.approve({
        projectId: project.id,
        version: existing.version,
        approvedBy: actorOf(request),
        approvedAt: deps.now(),
        operationKey,
        ...(request.headers['if-match'] === undefined
          ? {}
          : { expectedContentEtag: request.headers['if-match'] }),
        audit: async (tx, row) => {
          await request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'specification.approved',
            target: { type: 'specification', id: row.id },
            metadata: { projectId: row.projectId, version: row.version, operationKey },
          });
        },
      });
      if (approved === undefined) throw specificationNotFound();
      if (approved === 'content_changed') throw specificationContentChanged();
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

function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'The project was not found.');
}

function specificationNotFound(): ApiError {
  return new ApiError('specification_not_found', 404, 'The specification was not found.');
}

function specificationImmutable(): ApiError {
  return new ApiError('specification_immutable', 409, 'Approved specifications cannot be changed.');
}

function specificationContentChanged(): ApiError {
  return new ApiError(
    'specification_content_changed',
    409,
    'The specification changed before approval. Refresh it and approve the current version.',
  );
}
