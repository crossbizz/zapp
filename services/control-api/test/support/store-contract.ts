import { beforeEach, describe, expect, it } from 'vitest';

import {
  SlugTakenError,
  type MembershipRecord,
  type OrganizationStore,
} from '../../src/orgs/store.js';

/**
 * What every `OrganizationStore` must do, run against each implementation.
 *
 * The unit suite runs it against the in-memory double and the integration suite
 * against the Drizzle store, from this one file — so the double cannot drift
 * into being kinder than PostgreSQL, which is the failure mode that makes route
 * tests pass and production break. The last-owner guard, the create-rollback and
 * the audit hook's atomicity are the three rules this exists for; all three are
 * invisible to a route test, because a route can only see the answer, not
 * whether it was atomic.
 */

export interface StoreFixture {
  readonly store: OrganizationStore;
  /** A user id this store will accept a membership for. */
  createUser: (email: string) => Promise<string>;
}

const link =
  (externalOrgId = 'organization-test') =>
  () =>
    Promise.resolve({ externalOrgId });

/** For the assertions that are not about the trail. */
const noAudit = (): Promise<void> => Promise.resolve();

/** The failure every "the audit row is part of the mutation" assertion is built on. */
const AUDIT_FAILED = new Error('audit sink refused');
const failingAudit = (): Promise<void> => Promise.reject(AUDIT_FAILED);

export function describeOrganizationStore(name: string, setUp: () => Promise<StoreFixture>): void {
  describe(`OrganizationStore contract: ${name}`, () => {
    let store: OrganizationStore;
    let alice = '';
    let bob = '';
    let now = new Date();

    beforeEach(async () => {
      const fixture = await setUp();
      store = fixture.store;
      alice = await fixture.createUser('alice@acme.test');
      bob = await fixture.createUser('bob@acme.test');
      now = new Date();
    });

    /** An organization owned by `alice`. */
    async function found(slug = 'acme'): Promise<string> {
      const created = await store.create({
        name: 'Acme',
        slug,
        creatorUserId: alice,
        now,
        link: link(),
        audit: noAudit,
      });
      return created.organization.id;
    }

    /** `alice`'s memberships, as the list they used to be before pagination. */
    async function membershipsOf(userId: string): Promise<string[]> {
      const page = await store.listForUser(userId);
      return page.items.map((entry) => entry.role);
    }

    it('creates an organization, its Owner and the provider link in one step', async () => {
      const created = await store.create({
        name: 'Acme',
        slug: 'acme',
        creatorUserId: alice,
        now,
        link: link('organization-live-1'),
        audit: noAudit,
      });

      expect(created.organization).toMatchObject({ name: 'Acme', slug: 'acme', plan: 'trial' });
      expect(created.externalOrgId).toBe('organization-live-1');
      expect(await store.membership(created.organization.id, alice)).toMatchObject({
        role: 'owner',
        status: 'active',
      });
    });

    it('refuses a slug that is taken', async () => {
      await found('acme');

      await expect(
        store.create({
          name: 'Acme Two',
          slug: 'acme',
          creatorUserId: bob,
          now,
          link: link(),
          audit: noAudit,
        }),
      ).rejects.toBeInstanceOf(SlugTakenError);
    });

    it('leaves nothing behind when the provider link fails', async () => {
      const boom = new Error('provider refused');

      await expect(
        store.create({
          name: 'Acme',
          slug: 'acme',
          creatorUserId: alice,
          now,
          link: () => Promise.reject(boom),
          audit: noAudit,
        }),
      ).rejects.toBe(boom);

      // No orphan organization and no orphan membership: the slug is free, and
      // the would-be Owner belongs to nothing.
      expect((await store.listForUser(alice)).items).toEqual([]);
      const retried = await store.create({
        name: 'Acme',
        slug: 'acme',
        creatorUserId: alice,
        now,
        link: link(),
        audit: noAudit,
      });
      expect(retried.organization.slug).toBe('acme');
    });

    it('leaves nothing behind when the audit hook fails', async () => {
      // The other half of "the audit row is written in the same transaction as
      // the mutation": if the row cannot be written, the mutation did not
      // happen either. A store that swallowed this would produce organizations
      // nothing in the trail accounts for.
      await expect(
        store.create({
          name: 'Acme',
          slug: 'acme',
          creatorUserId: alice,
          now,
          link: link(),
          audit: failingAudit,
        }),
      ).rejects.toBe(AUDIT_FAILED);

      expect((await store.listForUser(alice)).items).toEqual([]);
    });

    it('undoes a rename whose audit row could not be written', async () => {
      const organizationId = await found('acme');

      await expect(
        store.update(organizationId, { name: 'Acme Two', slug: 'acme-two' }, failingAudit),
      ).rejects.toBe(AUDIT_FAILED);

      expect(await store.findById(organizationId)).toMatchObject({ name: 'Acme', slug: 'acme' });
    });

    it('normalizes existing organization settings to fail closed', async () => {
      const organizationId = await found();

      expect(await store.getSettings(organizationId)).toEqual({ builderCanDeploy: false });
      expect(await store.getSettings('org_01J00000000000000000000000')).toBeUndefined();
    });

    it('partially merges only the supplied settings and preserves arbitrary JSON policy', async () => {
      const organizationId = await found();
      const policy = {
        routing: ['fast', { provider: null }],
        budget: 0,
        enabled: true,
      };

      await store.updateSettings({
        organizationId,
        patch: { defaultModelPolicy: policy },
        operationKey: 'op_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        audit: noAudit,
      });
      const merged = await store.updateSettings({
        organizationId,
        patch: { builderCanDeploy: true },
        operationKey: 'op_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        audit: noAudit,
      });

      expect(merged).toEqual({ builderCanDeploy: true, defaultModelPolicy: policy });
      expect(await store.getSettings(organizationId)).toEqual(merged);
    });

    it('rolls back a settings patch whose audit row could not be written', async () => {
      const organizationId = await found();

      await expect(
        store.updateSettings({
          organizationId,
          patch: { builderCanDeploy: true },
          operationKey: 'op_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          audit: failingAudit,
        }),
      ).rejects.toBe(AUDIT_FAILED);

      expect(await store.getSettings(organizationId)).toEqual({ builderCanDeploy: false });
    });

    it('undoes a membership write whose audit row could not be written', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: noAudit });

      await expect(store.setRole(organizationId, bob, 'owner', failingAudit)).rejects.toBe(
        AUDIT_FAILED,
      );
      expect(await store.membership(organizationId, bob)).toMatchObject({ role: 'builder' });

      await expect(store.removeMember(organizationId, bob, failingAudit)).rejects.toBe(
        AUDIT_FAILED,
      );
      expect(await store.membership(organizationId, bob)).toMatchObject({ status: 'active' });
    });

    it('hands the audit hook the row it actually wrote', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: noAudit });

      let seen: MembershipRecord | undefined;
      const outcome = await store.setRole(organizationId, bob, 'viewer', (_tx, membership) => {
        seen = membership;
        return Promise.resolve();
      });

      // The role that was requested, from the write itself — not from a
      // re-read that a concurrent change could have moved on.
      expect(seen).toMatchObject({ userId: bob, role: 'viewer', status: 'active' });
      expect(outcome).toMatchObject({ userId: bob, role: 'viewer' });
    });

    it('lists a user’s own memberships and forgets removed ones', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: noAudit });

      expect(await membershipsOf(bob)).toEqual(['builder']);
      expect(await store.removeMember(organizationId, bob, noAudit)).toBe('updated');
      expect(await membershipsOf(bob)).toEqual([]);
      expect(await store.membership(organizationId, bob)).toBeUndefined();
    });

    it('pages the list, and says so only when there is another page', async () => {
      const first = await found('acme');
      const second = await store.create({
        name: 'Beta',
        slug: 'beta',
        creatorUserId: alice,
        now,
        link: link(),
        audit: noAudit,
      });

      const page = await store.listForUser(alice, { limit: 1 });
      expect(page.items).toHaveLength(1);
      // Newest first: ids are monotonic, so the second organization leads.
      expect(page.items[0]?.organization.id).toBe(second.organization.id);
      expect(page.nextCursor).toBe(second.organization.id);

      const next = await store.listForUser(alice, { limit: 1, cursor: page.nextCursor ?? '' });
      expect(next.items.map((entry) => entry.organization.id)).toEqual([first]);
      // The last page says so rather than promising a third.
      expect(next.nextCursor).toBeNull();
    });

    it('reactivates a removed membership rather than duplicating it', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: noAudit });
      await store.removeMember(organizationId, bob, noAudit);

      await store.addMember({ organizationId, userId: bob, role: 'viewer', now, audit: noAudit });

      expect(await store.membership(organizationId, bob)).toMatchObject({
        role: 'viewer',
        status: 'active',
      });
      expect((await store.listForUser(bob)).items).toHaveLength(1);
    });

    it('never rewrites an active membership, and records nothing when it does not', async () => {
      const organizationId = await found();
      let audited = 0;
      const count = (): Promise<void> => {
        audited += 1;
        return Promise.resolve();
      };

      // The Owner "accepts" a viewer invitation to their own organization.
      await store.addMember({ organizationId, userId: alice, role: 'viewer', now, audit: count });

      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'owner' });
      // Nothing changed, so nothing happened, so nothing is recorded. A
      // `member.joined` row for a join that did not occur is permanent —
      // `audit_events` is append-only, so it could never be taken back.
      expect(audited).toBe(0);

      // …and a membership that really is written still records itself.
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: count });
      expect(audited).toBe(1);
    });

    it('refuses to demote the last Owner, and says which rule stopped it', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: noAudit });

      expect(await store.setRole(organizationId, alice, 'viewer', noAudit)).toBe('last_owner');
      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'owner' });
    });

    it('allows the demotion once a second Owner exists', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'owner', now, audit: noAudit });

      expect(await store.setRole(organizationId, alice, 'viewer', noAudit)).toMatchObject({
        role: 'viewer',
        status: 'active',
      });
      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'viewer' });
    });

    it('always allows a promotion to Owner', async () => {
      const organizationId = await found();

      // Re-setting the last Owner's own role must not trip the guard.
      expect(await store.setRole(organizationId, alice, 'owner', noAudit)).toMatchObject({
        role: 'owner',
      });
      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'owner' });
    });

    it('refuses to remove the last Owner but not the last member', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now, audit: noAudit });

      expect(await store.removeMember(organizationId, alice, noAudit)).toBe('last_owner');
      // A non-Owner is not load-bearing.
      expect(await store.removeMember(organizationId, bob, noAudit)).toBe('updated');
      expect(await store.membership(organizationId, alice)).toMatchObject({ status: 'active' });
    });

    it('reports a stranger as not a member, for both writes', async () => {
      const organizationId = await found();

      expect(await store.setRole(organizationId, bob, 'viewer', noAudit)).toBe('member_not_found');
      expect(await store.removeMember(organizationId, bob, noAudit)).toBe('member_not_found');
    });

    it('renames an organization and refuses a slug someone else holds', async () => {
      const organizationId = await found('acme');
      await store.create({
        name: 'Beta',
        slug: 'beta',
        creatorUserId: bob,
        now,
        link: link(),
        audit: noAudit,
      });

      expect(await store.update(organizationId, { name: 'Acme Two' }, noAudit)).toMatchObject({
        name: 'Acme Two',
        slug: 'acme',
      });
      await expect(store.update(organizationId, { slug: 'beta' }, noAudit)).rejects.toBeInstanceOf(
        SlugTakenError,
      );
      expect(await store.findById(organizationId)).toMatchObject({ slug: 'acme' });
    });
  });
}
