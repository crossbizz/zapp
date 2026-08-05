import { isDeepStrictEqual } from 'node:util';

import { newId } from '@zapp/contracts';

import {
  DEFAULT_PAGE_SIZE,
  SlugTakenError,
  type CreateOrganizationInput,
  type CreatedOrganization,
  type MemberUpdate,
  type MembershipRecord,
  type OrganizationMembership,
  type OrganizationRecord,
  OrganizationSettingsPatchSchema,
  OrganizationSettingsSchema,
  OrganizationSettingsUpdateSchema,
  type OrganizationSettings,
  type OrganizationStore,
  type PageRequest,
  type RoleUpdate,
  type StorePage,
} from '../../src/orgs/store.js';
import { NO_TRANSACTION, type AuditHook } from '../../src/plugins/audit.js';
import type { Role } from '../../src/policy/permissions.js';

/**
 * An `OrganizationStore` with two Maps behind it, so route tests need no
 * PostgreSQL — the same trade CP-2 made for `InMemoryUserStore`.
 *
 * It is a *double*, not a second implementation: every rule it enforces (slug
 * uniqueness, the creator's Owner membership, the last-owner guard, rollback
 * when the provider refuses) is also asserted against the shipping Drizzle store
 * by the shared contract in `test/support/store-contract.ts`. When the two
 * disagree, the contract fails for one of them.
 *
 * The audit hooks are called where the Drizzle store calls them — after the
 * write, before it is visible — and with {@link NO_TRANSACTION}, since a Map has
 * none to offer. A hook that throws therefore leaves nothing behind here either,
 * which is the property the routes depend on.
 */
export class InMemoryOrganizationStore implements OrganizationStore {
  readonly organizations = new Map<string, OrganizationRecord>();
  /** Keyed `organizationId\0userId`, removed rows included. */
  readonly memberships = new Map<string, MembershipRecord>();
  readonly settings = new Map<string, OrganizationSettings>();
  private readonly settingsOperations = new Set<string>();

  private key(organizationId: string, userId: string): string {
    // The separator is spelled as an escape rather than typed as a byte: a
    // literal NUL in a source file makes git treat it as binary and stop
    // showing diffs for it. It cannot occur inside either id, which is the
    // point — no pair of ids can collide on the joined key.
    return `${organizationId}\u0000${userId}`;
  }

  private activeOwners(organizationId: string, except?: string): MembershipRecord[] {
    return [...this.memberships.values()].filter(
      (row) =>
        row.organizationId === organizationId &&
        row.role === 'owner' &&
        row.status === 'active' &&
        row.userId !== except,
    );
  }

  async create(input: CreateOrganizationInput): Promise<CreatedOrganization> {
    for (const existing of this.organizations.values()) {
      if (existing.slug === input.slug) {
        throw new SlugTakenError();
      }
    }

    const organization: OrganizationRecord = {
      id: newId('org'),
      name: input.name,
      slug: input.slug,
      plan: 'trial',
    };
    const membership: MembershipRecord = {
      organizationId: organization.id,
      userId: input.creatorUserId,
      role: 'owner',
      status: 'active',
    };

    // Nothing is written until the provider has answered and the audit row has
    // been taken: this stands in for the transaction the Drizzle store opens,
    // and it is what the rollback test exercises on both sides.
    const { externalOrgId } = await input.link(organization);
    const created: CreatedOrganization = { organization, membership, externalOrgId };
    await input.audit(NO_TRANSACTION, created);

    this.organizations.set(organization.id, organization);
    this.memberships.set(this.key(organization.id, membership.userId), membership);
    return created;
  }

  findById(organizationId: string): Promise<OrganizationRecord | undefined> {
    return Promise.resolve(this.organizations.get(organizationId));
  }

  getSettings(organizationId: string): Promise<OrganizationSettings | undefined> {
    if (!this.organizations.has(organizationId)) return Promise.resolve(undefined);
    return Promise.resolve(
      OrganizationSettingsSchema.parse(this.settings.get(organizationId) ?? {}),
    );
  }

  async updateSettings(
    input: Parameters<OrganizationStore['updateSettings']>[0],
  ): Promise<OrganizationSettings | undefined> {
    if (!this.organizations.has(input.organizationId)) return undefined;
    const current = OrganizationSettingsSchema.parse(this.settings.get(input.organizationId) ?? {});
    const operation = `${input.organizationId}\u0000${input.operationKey}`;
    if (this.settingsOperations.has(operation)) return current;

    const patch = OrganizationSettingsPatchSchema.parse(input.patch);
    const settings = OrganizationSettingsSchema.parse({ ...current, ...patch });
    const changedFields = (Object.keys(patch) as (keyof typeof patch)[])
      .filter((field) => !isDeepStrictEqual(current[field], settings[field]))
      .sort();
    const update = OrganizationSettingsUpdateSchema.parse({
      settings,
      changedFields,
      noOp: changedFields.length === 0,
    });
    await input.audit(NO_TRANSACTION, update);
    if (!update.noOp) this.settings.set(input.organizationId, settings);
    this.settingsOperations.add(operation);
    return settings;
  }

  listForUser(userId: string, page?: PageRequest): Promise<StorePage<OrganizationMembership>> {
    const limit = page?.limit ?? DEFAULT_PAGE_SIZE;
    const rows = [...this.memberships.values()]
      // `active`, not "not removed": an invitation nobody accepted is a row,
      // not an access grant — the same rule `membership()` applies.
      .filter((row) => row.userId === userId && row.status === 'active')
      .flatMap((row) => {
        const organization = this.organizations.get(row.organizationId);
        return organization === undefined
          ? []
          : [{ organization, role: row.role, status: row.status }];
      })
      // Ids are monotonic ULIDs, so descending id is newest-first.
      .sort((left, right) => (left.organization.id < right.organization.id ? 1 : -1))
      .filter((entry) => page?.cursor === undefined || entry.organization.id < page.cursor);

    const items = rows.slice(0, limit);
    return Promise.resolve({
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.organization.id ?? null) : null,
    });
  }

  membership(organizationId: string, userId: string): Promise<MembershipRecord | undefined> {
    const row = this.memberships.get(this.key(organizationId, userId));
    return Promise.resolve(row === undefined || row.status === 'removed' ? undefined : row);
  }

  async update(
    organizationId: string,
    patch: { name?: string; slug?: string },
    audit: AuditHook<OrganizationRecord>,
  ): Promise<OrganizationRecord | undefined> {
    const organization = this.organizations.get(organizationId);
    if (organization === undefined) {
      return undefined;
    }
    if (patch.slug !== undefined) {
      for (const other of this.organizations.values()) {
        if (other.slug === patch.slug && other.id !== organizationId) {
          // A *rejection*, not a synchronous throw: that is how the Drizzle
          // store surfaces it, and the difference a route written with `.catch`
          // would trip over.
          throw new SlugTakenError();
        }
      }
    }

    const updated: OrganizationRecord = {
      ...organization,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.slug === undefined ? {} : { slug: patch.slug }),
    };
    await audit(NO_TRANSACTION, updated);
    this.organizations.set(organizationId, updated);
    return updated;
  }

  async addMember(input: {
    organizationId: string;
    userId: string;
    role: Role;
    now: Date;
    audit: AuditHook<MembershipRecord>;
  }): Promise<MembershipRecord> {
    const key = this.key(input.organizationId, input.userId);
    const existing = this.memberships.get(key);
    // An active membership is never rewritten: an invite must not be a way to
    // change — least of all lower — the role someone already holds. And nothing
    // changing means nothing to record: the Drizzle store audits only what its
    // `RETURNING` gave back, so this must too.
    if (existing?.status === 'active') {
      return existing;
    }

    const membership: MembershipRecord = {
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      status: 'active',
    };
    await input.audit(NO_TRANSACTION, membership);
    this.memberships.set(key, membership);
    return membership;
  }

  async setRole(
    organizationId: string,
    userId: string,
    role: Role,
    audit: AuditHook<MembershipRecord>,
  ): Promise<RoleUpdate> {
    const key = this.key(organizationId, userId);
    const existing = this.memberships.get(key);
    if (existing === undefined || existing.status === 'removed') {
      return 'member_not_found';
    }
    if (
      existing.role === 'owner' &&
      role !== 'owner' &&
      this.activeOwners(organizationId, userId).length === 0
    ) {
      return 'last_owner';
    }
    const updated: MembershipRecord = { ...existing, role };
    await audit(NO_TRANSACTION, updated);
    this.memberships.set(key, updated);
    return updated;
  }

  async removeMember(
    organizationId: string,
    userId: string,
    audit: AuditHook<MembershipRecord>,
  ): Promise<MemberUpdate> {
    const key = this.key(organizationId, userId);
    const existing = this.memberships.get(key);
    if (existing === undefined || existing.status === 'removed') {
      return 'member_not_found';
    }
    if (existing.role === 'owner' && this.activeOwners(organizationId, userId).length === 0) {
      return 'last_owner';
    }
    const removed: MembershipRecord = { ...existing, status: 'removed' };
    await audit(NO_TRANSACTION, removed);
    this.memberships.set(key, removed);
    return 'updated';
  }
}
