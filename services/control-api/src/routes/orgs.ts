import { PageSchema, idSchema } from '@zapp/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { AuthPortError, type AuthPort } from '../auth/port.js';
import type { UserStore } from '../auth/users.js';
import { ApiError } from '../errors.js';
import {
  INVITE_TOKEN_PATTERN,
  INVITE_TTL_MS,
  hashInviteToken,
  newInviteToken,
  normalizeEmail,
  type InviteStore,
} from '../orgs/invites.js';
import {
  DEFAULT_PAGE_SIZE,
  SlugTakenError,
  type CreatedOrganization,
  type MembershipRecord,
  type OrganizationRecord,
  type OrganizationStore,
} from '../orgs/store.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, organizationNotFound, selectOrganizationId } from '../plugins/tenant.js';
import { ROLES } from '../policy/permissions.js';
import { SlugSchema, derivedSlug, randomSuffix } from '../slug.js';
import type { TrialGrantPort } from '../billing/topup.js';

/**
 * PRD §32 organizations, memberships and invites.
 *
 * Four rules run through every handler here:
 *
 * 1. **The PRD §22.2 matrix decides.** No handler compares roles by hand; each
 *    asks `can(role, action)` and nothing else. Which action a route requires is
 *    part of its definition, not of its body.
 * 2. **Not yours reads as not there.** A caller with no active membership gets
 *    `404 organization_not_found` for an organization that exists, exactly as it
 *    does for one that does not (plan 02 §Global Constraints). A 403 would
 *    confirm the organization by refusing to talk about it.
 * 3. **One organization per request.** `:orgId` is the tenant selector for these
 *    route shapes, and `selectOrganizationId` (CP-4) is what says so — the same
 *    function every other tenant-scoped route uses, so an `x-organization-id`
 *    header that contradicts the path is refused here exactly as it is there
 *    rather than being quietly ignored.
 * 4. **An organization keeps an Owner.** The last one cannot be demoted or
 *    removed; the store enforces it atomically and this maps it to
 *    `409 last_owner`.
 *
 * These routes administer organizations rather than reading tenant data, so they
 * take the `OrganizationStore` port rather than `ctx.db` — there is no tenant
 * table involved. Everything that does read tenant data goes through
 * `./projects.ts` and `./runs.ts`.
 */

const RoleSchema = z.enum(ROLES);

const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
});

const MembershipSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  role: RoleSchema,
  status: z.enum(['invited', 'active', 'removed']),
});

const MembershipEntrySchema = z.object({
  organization: OrganizationSchema,
  role: RoleSchema,
  status: z.enum(['invited', 'active', 'removed']),
});

const NameSchema = z.string().trim().min(1).max(80);

const OrganizationParams = z.object({ orgId: idSchema('org') });
const MemberParams = z.object({ orgId: idSchema('org'), userId: idSchema('user') });

const CreateOrganizationBody = z.object({
  name: NameSchema,
  /** Optional: derived from the name when absent, which is the common path. */
  slug: SlugSchema.optional(),
});

const UpdateOrganizationBody = z
  .object({ name: NameSchema.optional(), slug: SlugSchema.optional() })
  // A PATCH that changes nothing is a client bug, and answering 200 to it hides
  // the bug behind a success.
  .refine((body) => body.name !== undefined || body.slug !== undefined, {
    message: 'at least one of name or slug is required',
  });

const CreateInviteBody = z.object({
  /** RFC 5321's practical ceiling; anything longer is not an address. */
  email: z.string().email().max(254),
  role: RoleSchema,
});

const SetRoleBody = z.object({ role: RoleSchema });

/**
 * Keyset pagination, as the FND-10 envelope describes it: `cursor` is the
 * opaque `nextCursor` of the previous page, handed back untouched.
 */
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
  cursor: idSchema('org').optional(),
});

/** How many suffixed slugs to try before giving up on a derived one. */
const MAX_SLUG_ATTEMPTS = 5;

export interface OrgRoutesDeps {
  readonly organizations: OrganizationStore;
  readonly invites: InviteStore;
  readonly users: UserStore;
  readonly port: AuthPort;
  readonly now: () => Date;
  readonly trial?: TrialGrantPort;
}

/** Nothing carrying a credential — an invite token — may be cached. */
function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

function unauthenticated(): ApiError {
  return new ApiError('unauthenticated', 401, 'Authentication is required.');
}

function slugTaken(): ApiError {
  return new ApiError('slug_taken', 409, 'That organization slug is already in use.');
}

function lastOwner(): ApiError {
  return new ApiError(
    'last_owner',
    409,
    'An organization must keep at least one owner. Promote another member first.',
  );
}

export function registerOrgRoutes(app: AppInstance, deps: OrgRoutesDeps): void {
  const { organizations, invites, users, port, now } = deps;

  /**
   * The session's user, from the users table. A token that verifies for a user
   * who no longer exists is not a session — and the membership rows every
   * handler here writes reference that row.
   */
  async function currentUser(request: FastifyRequest): Promise<{ id: string; email: string }> {
    const profile = await users.profile(actorOf(request));
    if (profile === undefined) {
      throw unauthenticated();
    }
    return { id: profile.user.id, email: profile.user.email };
  }

  /**
   * The caller's active membership of the organization this request names, or a
   * 404 — see rules 2 and 3 above. Every organization-scoped handler starts
   * here, which is what makes tenant isolation a property of the route file
   * rather than of each handler.
   *
   * `organizationId` is the path's, and `selectOrganizationId` is what makes an
   * `x-organization-id` header that disagrees with it a 404 rather than a
   * silently ignored contradiction.
   */
  async function membershipOf(
    request: FastifyRequest,
    organizationId: string,
  ): Promise<MembershipRecord> {
    const selected = selectOrganizationId(request, organizationId);
    const membership = await organizations.membership(selected, actorOf(request));
    // `active`, not merely "not removed": an invitation that was issued and
    // never accepted is a row, not an access grant — the same rule the tenant
    // plugin applies, because it is the same question.
    if (membership === undefined || membership.status !== 'active') {
      throw organizationNotFound();
    }
    return membership;
  }

  app.post(
    '/v1/organizations',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        body: CreateOrganizationBody,
        response: { 201: z.object({ organization: OrganizationSchema, role: RoleSchema }) },
      },
    },
    async (request, reply) => {
      const user = await currentUser(request);
      const requested = request.body.slug;
      // A name that does not reduce to a valid slug — punctuation, a single
      // character, a script with no Latin form — still needs one, and a random
      // slug is better than a collision-prone constant.
      const base = requested ?? derivedSlug(request.body.name, 'org');

      /**
       * The Stytch organization is created inside the store's transaction, so a
       * refusal leaves no zapp organization to clean up. The provider's own
       * message never reaches the client — it quotes the request, and the
       * request contains our API key.
       *
       * The slug comes from the organization the store is writing, not from
       * `base`: a collision retry changes it, and the two sides of a paired
       * organization have to agree on which one it is.
       */
      const link = async (organization: OrganizationRecord): Promise<{ externalOrgId: string }> => {
        try {
          return await port.createOrganization({
            name: organization.name,
            slug: organization.slug,
          });
        } catch (error) {
          request.log.warn(
            { errorCode: error instanceof AuthPortError ? error.code : 'unknown' },
            'provider refused the organization',
          );
          throw new ApiError(
            'organization_create_failed',
            502,
            'The organization could not be created. Please try again.',
          );
        }
      };

      let created: CreatedOrganization | undefined;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && created === undefined; attempt += 1) {
        const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
        try {
          created = await organizations.create({
            name: request.body.name,
            slug,
            creatorUserId: user.id,
            now: now(),
            link,
            // Inside the store's transaction, with the organization it actually
            // wrote: an audit row for an organization that was rolled back
            // would name an id nothing else in the database has.
            audit: (tx, organization) =>
              request.audit(tx, {
                organizationId: organization.organization.id,
                action: 'organization.created',
                target: { type: 'organization', id: organization.organization.id },
                metadata: {
                  slug: organization.organization.slug,
                  externalOrgId: organization.externalOrgId,
                },
              }),
          });
        } catch (error) {
          if (!(error instanceof SlugTakenError)) {
            throw error;
          }
          // A slug the client chose is a request we cannot silently rewrite; one
          // we derived is ours to vary.
          if (requested !== undefined) {
            throw slugTaken();
          }
        }
      }
      if (created === undefined) {
        throw slugTaken();
      }

      if (deps.trial !== undefined) {
        try {
          await deps.trial.ensureTrial({
            organizationId: created.organization.id,
            userId: user.id,
          });
        } catch (error) {
          // The durable claim remains pending. The billing lifecycle retries it;
          // provider availability must not roll back an otherwise valid org.
          request.log.error(
            { err: error, organizationId: created.organization.id },
            'trial credit delivery deferred',
          );
        }
      }

      return await reply
        .status(201)
        .send({ organization: created.organization, role: created.membership.role });
    },
  );

  app.get(
    '/v1/organizations',
    {
      preHandler: [app.requireSession],
      schema: {
        querystring: ListQuery,
        response: { 200: PageSchema(MembershipEntrySchema) },
      },
    },
    async (request) => {
      // Only the caller's own memberships: this endpoint is not a directory of
      // organizations, and there is no query that would make it one.
      //
      // Really paginated, rather than answering `nextCursor: null` to every
      // request whatever the size of the answer (plan 02 CP-3 review): the
      // envelope promises keyset pagination, and a client that reads the
      // promise and pages with the cursor has to get the second page.
      const page = await organizations.listForUser(actorOf(request), {
        limit: request.query.limit,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      });
      // `nextCursor` is explicitly null rather than absent (FND-10): a client
      // must never read a missing field as "there might be more".
      return { items: page.items, nextCursor: page.nextCursor };
    },
  );

  app.patch(
    '/v1/organizations/:orgId',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        params: OrganizationParams,
        body: UpdateOrganizationBody,
        response: { 200: z.object({ organization: OrganizationSchema }) },
      },
    },
    async (request) => {
      const membership = await membershipOf(request, request.params.orgId);
      authorize(membership, 'manage_organization');

      const patch = {
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.slug === undefined ? {} : { slug: request.body.slug }),
      };
      // `try`, not `.catch`: a store is free to reject *or* to throw before it
      // returns a promise, and a rejection handler attached afterwards would
      // never see the second kind.
      let organization;
      try {
        organization = await organizations.update(request.params.orgId, patch, (tx, updated) =>
          request.audit(tx, {
            organizationId: updated.id,
            action: 'organization.updated',
            target: { type: 'organization', id: updated.id },
            // Which fields moved, not what they moved to: the row is the trail,
            // not a second copy of the record.
            metadata: { fields: Object.keys(patch).sort() },
          }),
        );
      } catch (error) {
        if (error instanceof SlugTakenError) {
          throw slugTaken();
        }
        throw error;
      }
      if (organization === undefined) {
        throw organizationNotFound();
      }

      return { organization };
    },
  );

  app.post(
    '/v1/organizations/:orgId/invites',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        params: OrganizationParams,
        body: CreateInviteBody,
        response: {
          201: z.object({
            invite: z.object({
              email: z.string(),
              role: RoleSchema,
              expiresAt: z.string().datetime(),
            }),
            /**
             * The only time the token is ever legible. There is no endpoint that
             * reads it back — the store holds a SHA-256 of it — so an invite
             * that is lost is reissued rather than recovered. Until email
             * delivery exists (plan 03), this response *is* the delivery.
             */
            token: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const membership = await membershipOf(request, request.params.orgId);
      authorize(membership, 'manage_members');

      const email = normalizeEmail(request.body.email);
      const token = newInviteToken();
      const expiresAt = new Date(now().getTime() + INVITE_TTL_MS);
      await invites.issue({
        tokenHash: hashInviteToken(token),
        organizationId: request.params.orgId,
        email,
        role: request.body.role,
        invitedBy: actorOf(request),
        expiresAt,
      });

      // `auditDetached`, and the only call site of it: the invite lives in
      // Redis, so there is no transaction for this row to be atomic *with*.
      // Ordered after the issue so a failure here means the token was never
      // returned to anybody — an invite nobody holds expires unused.
      await request.auditDetached({
        organizationId: request.params.orgId,
        action: 'member.invited',
        target: { type: 'invite', id: null },
        // The address and the role — never the token. This row outlives the
        // invite by years.
        metadata: { email, role: request.body.role },
      });

      noStore(reply);
      return await reply.status(201).send({
        invite: { email, role: request.body.role, expiresAt: expiresAt.toISOString() },
        token,
      });
    },
  );

  app.post(
    '/v1/invites/:token/accept',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        params: z.object({ token: z.string().regex(INVITE_TOKEN_PATTERN) }),
        response: { 200: z.object({ organization: OrganizationSchema, role: RoleSchema }) },
      },
    },
    async (request, reply) => {
      const user = await currentUser(request);
      /**
       * The membership write happens *inside* the claim, and that is the whole
       * point: `claim` marks the invite used, runs this, and puts the invite
       * back if it throws. Spending the invite first and writing the membership
       * afterwards — which is what this route used to do — strands an invitee
       * whose membership write failed on `410 invite_used`, holding a link that
       * can never work again (plan 02 CP-3 review).
       */
      const claim = await invites.claim({
        tokenHash: hashInviteToken(request.params.token),
        email: normalizeEmail(user.email),
        complete: async (invite) => {
          const organization = await organizations.findById(invite.organizationId);
          if (organization === undefined) {
            throw organizationNotFound();
          }
          const membership = await organizations.addMember({
            organizationId: organization.id,
            userId: user.id,
            role: invite.role,
            now: now(),
            audit: (tx, written) =>
              request.audit(tx, {
                organizationId: organization.id,
                action: 'member.joined',
                target: { type: 'membership', id: user.id },
                metadata: { role: written.role, invitedRole: invite.role },
              }),
          });
          return { organization, membership };
        },
      });

      switch (claim.status) {
        case 'unknown':
          throw new ApiError('invite_not_found', 404, 'That invitation does not exist.');
        case 'expired':
          // 410, not 404: the link was real, and saying so is what tells the
          // person to ask for another one.
          throw new ApiError('invite_expired', 410, 'That invitation has expired.');
        case 'used':
          throw new ApiError('invite_used', 410, 'That invitation has already been used.');
        case 'email_mismatch':
          // The invite is untouched — the wrong person following a link must not
          // spend it. 403 rather than 404 because they are holding a real token;
          // the address it is for is not disclosed.
          throw new ApiError(
            'invite_email_mismatch',
            403,
            'That invitation was sent to a different email address.',
          );
        case 'claimed': {
          noStore(reply);
          return {
            organization: claim.result.organization,
            role: claim.result.membership.role,
          };
        }
      }
    },
  );

  app.patch(
    '/v1/organizations/:orgId/members/:userId',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: {
        params: MemberParams,
        body: SetRoleBody,
        response: { 200: z.object({ membership: MembershipSchema }) },
      },
    },
    async (request) => {
      const membership = await membershipOf(request, request.params.orgId);
      authorize(membership, 'manage_members');

      // The store returns the row it wrote. Re-reading it here instead would
      // reintroduce two bugs at once: a concurrent removal between the write
      // and the read turns a successful change into a spurious 404 with no
      // audit row, and a concurrent second change makes the trail record a role
      // nobody asked for (plan 02 CP-3 review).
      const outcome = await organizations.setRole(
        request.params.orgId,
        request.params.userId,
        request.body.role,
        (tx, updated) =>
          request.audit(tx, {
            organizationId: request.params.orgId,
            action: 'member.role_changed',
            target: { type: 'membership', id: request.params.userId },
            metadata: { role: updated.role },
          }),
      );
      if (outcome === 'member_not_found') {
        throw new ApiError('member_not_found', 404, 'That member does not exist.');
      }
      if (outcome === 'last_owner') {
        throw lastOwner();
      }

      return { membership: outcome };
    },
  );

  app.delete(
    '/v1/organizations/:orgId/members/:userId',
    {
      preHandler: [app.requireSession, app.requireCsrf],
      schema: { params: MemberParams, response: { 204: z.void() } },
    },
    async (request, reply) => {
      const membership = await membershipOf(request, request.params.orgId);
      authorize(membership, 'manage_members');

      const outcome = await organizations.removeMember(
        request.params.orgId,
        request.params.userId,
        (tx, removed) =>
          request.audit(tx, {
            organizationId: request.params.orgId,
            action: 'member.removed',
            target: { type: 'membership', id: request.params.userId },
            // The role they held when it was taken away: the membership row is
            // now `removed`, so this is the only record of what was lost.
            metadata: { role: removed.role },
          }),
      );
      if (outcome === 'member_not_found') {
        throw new ApiError('member_not_found', 404, 'That member does not exist.');
      }
      if (outcome === 'last_owner') {
        throw lastOwner();
      }

      return await reply.status(204).send();
    },
  );
}
