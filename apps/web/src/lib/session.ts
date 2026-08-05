import type { MeResponse } from './api';

type Membership = MeResponse['memberships'][number];

export function organizationStorageKey(userId: string): string {
  return `zapp:selected-organization:${userId}`;
}

export function activeMemberships(memberships: readonly Membership[]): readonly Membership[] {
  return memberships.filter((membership) => membership.status === 'active');
}

export function resolveOrganization(
  memberships: readonly Membership[],
  override: string | null,
  persisted: string | null,
): { readonly membership: Membership | undefined; readonly invalidOverride: boolean } {
  const active = activeMemberships(memberships);
  const selectedId = override ?? persisted;
  const selected = active.find((membership) => membership.organization.id === selectedId);
  if (override !== null && selected === undefined) {
    const persistedMembership = active.find(
      (membership) => membership.organization.id === persisted,
    );
    return { membership: persistedMembership ?? active[0], invalidOverride: true };
  }
  return { membership: selected ?? active[0], invalidOverride: false };
}
