import { idSchema } from '@zapp/contracts';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { ApiError } from '../errors.js';
import type { MembershipRecord } from '../orgs/store.js';
import { can, type Action, type PermissionContext, type Role } from '../policy/permissions.js';
import type { TenantDatabase, TenantDbFactory } from '../tenant/db.js';

/**
 * Tenant resolution: which organization a request is for, and whether the
 * caller is in it.
 *
 * This is the boundary the whole multitenancy story rests on, so it is one
 * function in one file rather than a check each handler remembers to make.
 * Composed after CP-2's `requireSession`, exactly as `requireCsrf` is: a session
 * says *who*, this says *whose*.
 *
 * Three rules, and each of them is a security answer:
 *
 * 1. **Not yours reads as not there.** A caller with no active membership gets
 *    `404 organization_not_found` for an organization that exists, byte for byte
 *    the same answer as for one that never did. A 403 would confirm the
 *    organization by refusing to talk about it, and that confirmation is exactly
 *    what an attacker enumerating ids is after (plan 02 §Global Constraints).
 * 2. **Naming no organization is a client error.** A tenant-scoped route with no
 *    `x-organization-id` and no organization in its path gets
 *    `400 organization_required` — the request is not wrong about who may see
 *    what, it is incomplete.
 * 3. **Two organizations in one request is neither of them.** A header that
 *    disagrees with the path is not a selector, it is an attempt at one, and
 *    resolving it in favour of either half is how a cross-tenant read gets
 *    written by accident. It is a 404, like every other answer that would
 *    otherwise report which organization exists.
 *
 * What a handler receives is `request.tenant`: the organization, the caller's
 * role in it, and `db` — an organization-bound handle (`src/tenant/db.ts`) that
 * is the *only* database access a route module has. Plan 02's `ctx` is this plus
 * CP-1's `request.id` and CP-2's `request.auth`; it is assembled from the
 * decorators that own each part rather than copied into a fourth object that
 * could disagree with them.
 */

/** How a browser names the organization it is acting in. Lowercase: HTTP/2 field names are. */
export const ORGANIZATION_HEADER = 'x-organization-id';

const ORGANIZATION_ID = idSchema('org');

export interface TenantContext {
  readonly organizationId: string;
  /** The caller's role in this organization — what `can(role, action)` is asked about. */
  readonly role: Role;
  /** Bound to {@link TenantContext.organizationId}; no route reaches any other handle. */
  readonly db: TenantDatabase;
}

/** The part of `OrganizationStore` tenant resolution needs, and no more. */
export interface MembershipLookup {
  membership(organizationId: string, userId: string): Promise<MembershipRecord | undefined>;
}

export interface TenantContextOptions {
  readonly memberships: MembershipLookup;
  readonly tenantDb: TenantDbFactory;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireTenant`; `undefined` on routes that are not tenant-scoped. */
    tenant?: TenantContext;
  }
  interface FastifyInstance {
    /**
     * Resolves the organization and the caller's role in it, or refuses. Always
     * composed after `requireSession` — it needs `request.auth`.
     */
    requireTenant: preHandlerAsyncHookHandler;
  }
}

/**
 * One code and one message for every way an organization can fail to resolve —
 * unknown, malformed, not yours, only invited, removed, or contradicted by the
 * path. Which one it was is only ever useful to someone who should not be told.
 */
export function organizationNotFound(): ApiError {
  return new ApiError('organization_not_found', 404, 'That organization does not exist.');
}

function organizationRequired(): ApiError {
  return new ApiError(
    'organization_required',
    400,
    `The ${ORGANIZATION_HEADER} header is required.`,
  );
}

function unauthenticated(): ApiError {
  return new ApiError('unauthenticated', 401, 'Authentication is required.');
}

/**
 * The organization a request names, from the path and the header — which must
 * agree when both are present.
 *
 * Exported because two callers need the same answer: `requireTenant` below, and
 * the organization routes in `src/routes/orgs.ts`, whose `:orgId` is the tenant
 * selector for their own shape. One function, so the rules above cannot hold on
 * one route shape and not the other.
 *
 * @throws {ApiError} 404 `organization_not_found`, or 400 `organization_required`.
 */
export function selectOrganizationId(request: FastifyRequest, fromPath?: string): string {
  const raw = request.headers[ORGANIZATION_HEADER];
  // An array means the header arrived more than once. Taking the first of them
  // is how a request that names two organizations gets to have whichever one is
  // not being checked; a request like that names neither.
  if (Array.isArray(raw)) {
    throw organizationNotFound();
  }
  const fromHeader = raw?.trim() ?? '';

  if (fromPath !== undefined) {
    if (fromHeader !== '' && fromHeader !== fromPath) {
      throw organizationNotFound(); // Rule 3.
    }
    return wellFormed(fromPath);
  }
  if (fromHeader === '') {
    throw organizationRequired(); // Rule 2.
  }
  return wellFormed(fromHeader);
}

/**
 * Shape is checked here rather than left to `forOrg`, which throws: a malformed
 * id would otherwise become a 500, and a 500 tells a caller that "not an
 * organization id at all" is a different thing from "no organization of yours".
 */
function wellFormed(organizationId: string): string {
  if (!ORGANIZATION_ID.safeParse(organizationId).success) {
    throw organizationNotFound();
  }
  return organizationId;
}

/** `request.params.orgId`, when the route shape has one. */
function organizationInPath(request: FastifyRequest): string | undefined {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null || !('orgId' in params)) {
    return undefined;
  }
  const orgId: unknown = params.orgId;
  return typeof orgId === 'string' ? orgId : undefined;
}

/**
 * PRD §22.2, enforced. No handler compares roles by hand; each asks
 * `can(role, action)` and nothing else. The action is echoed so a client can say
 * what is missing — the role is not, because a caller learning which role would
 * have worked learns the shape of the organization.
 *
 * A 403 here and a 404 above are not in tension: this answer is only ever
 * reached by someone who is already in the organization, so it discloses
 * nothing they did not bring with them.
 *
 * Takes anything carrying a role — a {@link TenantContext} or CP-3's
 * `MembershipRecord` — so the same gate serves every route shape.
 *
 * @throws {ApiError} 403 `permission_denied`.
 */
export function authorize(
  actor: { readonly role: Role },
  action: Action,
  context: PermissionContext = {},
): void {
  if (!can(actor.role, action, context)) {
    throw new ApiError('permission_denied', 403, 'Your role does not allow this action.', {
      action,
    });
  }
}

/** Narrows `request.tenant` for a handler on a route that declared `requireTenant`. */
export function tenantOf(request: FastifyRequest): TenantContext {
  const tenant = request.tenant;
  if (tenant === undefined) {
    // Not reachable from a route with `requireTenant`. Reaching it means a
    // tenant-scoped route was registered without one, and a 500 is the honest
    // outcome — the alternative is a handler improvising a scope.
    throw new Error('this route requires the tenant plugin (app.requireTenant)');
  }
  return tenant;
}

export const tenantContext = fp<TenantContextOptions>(
  (app, options, done) => {
    const { memberships, tenantDb } = options;

    // Declared up front so every request object has the same shape — Fastify
    // (and V8) prefer that to a property that appears on some requests only.
    app.decorateRequest('tenant', undefined);

    app.decorate('requireTenant', async (request: FastifyRequest): Promise<void> => {
      const auth = request.auth;
      if (auth === undefined) {
        // Belt and braces: every tenant route composes `requireSession` first,
        // and this is what makes a route that forgot it fail closed.
        throw unauthenticated();
      }

      const organizationId = selectOrganizationId(request, organizationInPath(request));
      const membership = await memberships.membership(organizationId, auth.userId);
      // `active`, not merely "not removed": an invitation that was issued and
      // never accepted is a row, not an access grant.
      if (membership === undefined || membership.status !== 'active') {
        throw organizationNotFound();
      }

      request.tenant = {
        organizationId,
        role: membership.role,
        db: tenantDb(organizationId),
      };
    });

    done();
  },
  { name: 'tenant-context', fastify: '5.x' },
);
