import { PageSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { DEFAULT_PAGE_SIZE } from '../pagination.js';
import type { SecretVault } from '../secrets/vault.js';
import { SecretMetadataSchema, toSecretMetadata } from '../tenant/view.js';

/**
 * PRD §32.5 — the secrets surface a user session may reach.
 *
 * **The whole file is a write-only vault**, and everything below follows from
 * that. PRD §22.2's tenth row reads "Read secret values: No through UI" for
 * Owner, Builder and Viewer alike — not "only Owners", *nobody* — so there is no
 * route here that returns a value, no query parameter that asks for one, and no
 * permission that would grant it. `src/policy/permissions.ts` deliberately does
 * not even name such a capability, so there is nothing to flip to `true` by
 * accident. Reading a value is an audited vault operation performed by a
 * service, on `/internal/secrets/decrypt` (`src/internal/secrets.ts`), and it is
 * the only path that exists.
 *
 * The rest:
 *
 *   - **Metadata reads take `view_secret_metadata`.** PRD §22.2 grants it to
 *     Owner and Builder and denies it to Viewer, which is the one place secrets
 *     diverge from `view_project`.
 *   - **Writes take `edit_code`.** PRD §22.2 has no "manage secrets" row, so
 *     rather than invent a capability the permission matrix does not name — the
 *     matrix is the PRD verbatim, and a row nobody decided is a row nobody
 *     reviewed — writes use the capability whose reach already includes them: a
 *     Builder who may change what the code does may already read every secret
 *     the code is given at runtime. Granting them `edit_code` and withholding
 *     "set a secret" would be a distinction with nothing behind it. If the PRD
 *     grows the row, it becomes a matrix cell and one word changes here.
 *   - **A miss is a 404, always.** Another tenant's project, another tenant's
 *     secret, and a secret that never existed are one answer — the tenant handle
 *     cannot tell them apart, so neither can this file (`src/tenant/db.ts`).
 *   - **Every mutation is audited in its own transaction** and honours
 *     `Idempotency-Key`, like every other mutating route in this service. The
 *     audit metadata carries the secret's *name*, never its value: the trail is
 *     read years later, and `audit_events` is append-only.
 */

const SecretParams = z.object({ projectId: idSchema('proj') });
const SecretIdParams = SecretParams.extend({ secretId: idSchema('sec') });

/**
 * A secret's name is the environment-variable name it is injected as (PRD
 * §18.12), so the shape is the shape a shell will accept: a leading letter or
 * underscore, then letters, digits and underscores. Rejecting `PATH=x` or
 * `a b` here is what stops a name from becoming an injection into whatever
 * builds the environment later.
 */
const SecretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A secret name must look like an environment variable name');

/**
 * The value. Bounded generously rather than tightly — a service-account JSON
 * key or a PEM private key is measured in kilobytes and both are ordinary
 * secrets — and bounded all the same, because this is encrypted and stored
 * whole, and an unbounded body is a way to fill a table.
 */
const SecretValueSchema = z
  .string()
  .min(1)
  .max(16 * 1024);

const CreateSecretBody = z
  .object({
    name: SecretNameSchema,
    value: SecretValueSchema,
    /** Absent means every environment of the project (PRD §23.6). */
    environmentId: idSchema('env').optional(),
  })
  .strict();

const RotateSecretBody = z.object({ value: SecretValueSchema }).strict();

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  cursor: idSchema('sec').optional(),
});

export interface SecretRoutesDeps {
  readonly now: () => Date;
  /** Encrypts on the way in; the routes here never see key material. */
  readonly vault: SecretVault;
}

export function registerSecretRoutes(app: AppInstance, deps: SecretRoutesDeps): void {
  const { now, vault } = deps;

  app.post(
    '/v1/projects/:projectId/secrets',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: SecretParams,
        body: CreateSecretBody,
        response: { 201: z.object({ secret: SecretMetadataSchema }) },
      },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');

      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }

      const environmentId = request.body.environmentId ?? null;
      if (environmentId !== null) {
        // Resolved through the project's own environments rather than by id
        // alone: a caller must not be able to scope this project's secret to
        // another project's environment, and "does env_… exist" is not a
        // question this API answers outside the project that owns it.
        const environments = await ctx.db.environments.byProject(project.id);
        if (!environments.some((environment) => environment.id === environmentId)) {
          throw new ApiError(
            'environment_not_found',
            404,
            'That environment does not exist in this project.',
          );
        }
      }

      // Encrypted before anything is written, and the plaintext goes no further
      // than this line: `request.body.value` is never logged (the logger builds
      // its lines from an allowlist that has no body in it — `src/logging.ts`),
      // never audited, and never returned.
      const envelope = await vault.encrypt(request.body.value);

      const created = await ctx.db.secrets.create({
        projectId: project.id,
        environmentId,
        name: request.body.name,
        envelope,
        createdBy: actorOf(request),
        now: now(),
        audit: (tx, secret) =>
          request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'secret.created',
            target: { type: 'secret', id: secret.id },
            // The name, the scope and the key version. Not the value — this
            // table is append-only and kept for years.
            metadata: {
              secretName: secret.name,
              projectId: project.id,
              environmentId: secret.environmentId,
              keyVersion: secret.keyVersion,
            },
          }),
      });

      if (created === 'name_taken') {
        throw new ApiError(
          'secret_name_taken',
          409,
          'A secret with that name already exists in this scope. Rotate it instead.',
        );
      }

      return await reply.status(201).send({ secret: toSecretMetadata(created) });
    },
  );

  app.get(
    '/v1/projects/:projectId/secrets',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        params: SecretParams,
        querystring: ListQuery,
        response: { 200: PageSchema(SecretMetadataSchema) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      // Not `view_project`: PRD §22.2 denies a Viewer secret metadata while
      // granting them the project it belongs to. Knowing that a project holds
      // `STRIPE_SECRET_KEY` is itself information about how it is deployed.
      authorize(ctx, 'view_secret_metadata');

      // The project is resolved first so another tenant's project answers 404
      // rather than an empty page — an empty page would say it exists and holds
      // no secrets, which is one bit more than nothing.
      const project = await ctx.db.projects.getById(request.params.projectId);
      if (project === undefined) {
        throw projectNotFound();
      }

      const page = await ctx.db.secrets.list({
        projectId: project.id,
        limit: request.query.limit,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      });
      return { items: page.items.map(toSecretMetadata), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/v1/projects/:projectId/secrets/:secretId/rotate',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: SecretIdParams,
        body: RotateSecretBody,
        response: { 200: z.object({ secret: SecretMetadataSchema }) },
      },
    },
    async (request) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');

      const existing = await ctx.db.secrets.getById(request.params.secretId);
      if (existing === undefined || existing.projectId !== request.params.projectId) {
        // The second half matters: a secret id that is this tenant's but belongs
        // to another of its projects must not be rotatable through this
        // project's path, or the path segment is decoration.
        throw secretNotFound();
      }

      const envelope = await vault.encrypt(request.body.value);
      const rotated = await ctx.db.secrets.rotate({
        secretId: existing.id,
        envelope,
        now: now(),
        audit: (tx, secret) =>
          request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'secret.rotated',
            target: { type: 'secret', id: secret.id },
            metadata: {
              secretName: secret.name,
              projectId: secret.projectId,
              environmentId: secret.environmentId,
              keyVersion: secret.keyVersion,
            },
          }),
      });
      if (rotated === undefined) {
        throw secretNotFound();
      }

      /**
       * The previous ciphertext is gone, not superseded: P0 keeps no version
       * history (`src/tenant/db.ts`), so nothing can produce the value that was
       * rotated away from. That is the intended meaning of the word — a vault
       * that could still hand back the compromised credential would not have
       * rotated anything — and it is why this returns metadata rather than a
       * diff. A future task that wants history adds versions to the vault table;
       * no client of this route learns anything new when it does.
       */
      return { secret: toSecretMetadata(rotated) };
    },
  );

  app.delete(
    '/v1/projects/:projectId/secrets/:secretId',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: { params: SecretIdParams },
    },
    async (request, reply) => {
      const ctx = tenantOf(request);
      authorize(ctx, 'edit_code');

      const existing = await ctx.db.secrets.getById(request.params.secretId);
      if (existing === undefined || existing.projectId !== request.params.projectId) {
        throw secretNotFound();
      }

      const deleted = await ctx.db.secrets.delete({
        secretId: existing.id,
        audit: (tx, secret) =>
          request.audit(tx, {
            organizationId: ctx.organizationId,
            action: 'secret.deleted',
            target: { type: 'secret', id: secret.id },
            // The name is the only record left once the row is gone — which is
            // the whole reason the trail is a different table.
            metadata: {
              secretName: secret.name,
              projectId: secret.projectId,
              environmentId: secret.environmentId,
            },
          }),
      });
      if (deleted === undefined) {
        throw secretNotFound();
      }

      return await reply.status(204).send();
    },
  );
}

/** See the file header: not yours reads as not there. */
function projectNotFound(): ApiError {
  return new ApiError('project_not_found', 404, 'That project does not exist.');
}

function secretNotFound(): ApiError {
  return new ApiError('secret_not_found', 404, 'That secret does not exist.');
}
