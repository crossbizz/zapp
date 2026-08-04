import { beforeEach, describe, expect, it } from 'vitest';

import { SlugTakenError, type OrganizationStore } from '../../src/orgs/store.js';

/**
 * What every `OrganizationStore` must do, run against each implementation.
 *
 * The unit suite runs it against the in-memory double and the integration suite
 * against the Drizzle store, from this one file — so the double cannot drift
 * into being kinder than PostgreSQL, which is the failure mode that makes route
 * tests pass and production break. The last-owner guard and the create-rollback
 * are the two rules this exists for; both are invisible to a route test, because
 * a route can only see the answer, not whether it was atomic.
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
      });
      return created.organization.id;
    }

    it('creates an organization, its Owner and the provider link in one step', async () => {
      const created = await store.create({
        name: 'Acme',
        slug: 'acme',
        creatorUserId: alice,
        now,
        link: link('organization-live-1'),
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
        store.create({ name: 'Acme Two', slug: 'acme', creatorUserId: bob, now, link: link() }),
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
        }),
      ).rejects.toBe(boom);

      // No orphan organization and no orphan membership: the slug is free, and
      // the would-be Owner belongs to nothing.
      expect(await store.listForUser(alice)).toEqual([]);
      const retried = await store.create({
        name: 'Acme',
        slug: 'acme',
        creatorUserId: alice,
        now,
        link: link(),
      });
      expect(retried.organization.slug).toBe('acme');
    });

    it('lists a user’s own memberships and forgets removed ones', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now });

      expect((await store.listForUser(bob)).map((entry) => entry.role)).toEqual(['builder']);
      expect(await store.removeMember(organizationId, bob)).toBe('updated');
      expect(await store.listForUser(bob)).toEqual([]);
      expect(await store.membership(organizationId, bob)).toBeUndefined();
    });

    it('reactivates a removed membership rather than duplicating it', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now });
      await store.removeMember(organizationId, bob);

      await store.addMember({ organizationId, userId: bob, role: 'viewer', now });

      expect(await store.membership(organizationId, bob)).toMatchObject({
        role: 'viewer',
        status: 'active',
      });
      expect(await store.listForUser(bob)).toHaveLength(1);
    });

    it('never rewrites an active membership', async () => {
      const organizationId = await found();

      // The Owner "accepts" a viewer invitation to their own organization.
      await store.addMember({ organizationId, userId: alice, role: 'viewer', now });

      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'owner' });
    });

    it('refuses to demote the last Owner, and says which rule stopped it', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now });

      expect(await store.setRole(organizationId, alice, 'viewer')).toBe('last_owner');
      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'owner' });
    });

    it('allows the demotion once a second Owner exists', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'owner', now });

      expect(await store.setRole(organizationId, alice, 'viewer')).toBe('updated');
      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'viewer' });
    });

    it('always allows a promotion to Owner', async () => {
      const organizationId = await found();

      // Re-setting the last Owner's own role must not trip the guard.
      expect(await store.setRole(organizationId, alice, 'owner')).toBe('updated');
      expect(await store.membership(organizationId, alice)).toMatchObject({ role: 'owner' });
    });

    it('refuses to remove the last Owner but not the last member', async () => {
      const organizationId = await found();
      await store.addMember({ organizationId, userId: bob, role: 'builder', now });

      expect(await store.removeMember(organizationId, alice)).toBe('last_owner');
      // A non-Owner is not load-bearing.
      expect(await store.removeMember(organizationId, bob)).toBe('updated');
      expect(await store.membership(organizationId, alice)).toMatchObject({ status: 'active' });
    });

    it('reports a stranger as not a member, for both writes', async () => {
      const organizationId = await found();

      expect(await store.setRole(organizationId, bob, 'viewer')).toBe('member_not_found');
      expect(await store.removeMember(organizationId, bob)).toBe('member_not_found');
    });

    it('renames an organization and refuses a slug someone else holds', async () => {
      const organizationId = await found('acme');
      await store.create({ name: 'Beta', slug: 'beta', creatorUserId: bob, now, link: link() });

      expect(await store.update(organizationId, { name: 'Acme Two' })).toMatchObject({
        name: 'Acme Two',
        slug: 'acme',
      });
      await expect(store.update(organizationId, { slug: 'beta' })).rejects.toBeInstanceOf(
        SlugTakenError,
      );
      expect(await store.findById(organizationId)).toMatchObject({ slug: 'acme' });
    });
  });
}
