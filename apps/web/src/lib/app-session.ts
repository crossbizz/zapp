import type { MeResponse } from './api';

export type AppMembership = MeResponse['memberships'][number];

export interface ResolvedAppMembership {
  readonly invalidOverride: boolean;
  readonly membership: AppMembership | undefined;
}

export function appSessionStorageKey(userId: string): string {
  return `zapp:selected-organization:${userId}`;
}

export function activeAppMemberships(
  memberships: readonly AppMembership[],
): readonly AppMembership[] {
  return memberships.filter((membership) => membership.status === 'active');
}

export function resolveAppMembership(
  memberships: readonly AppMembership[],
  override: string | null,
  persisted: string | null,
): ResolvedAppMembership {
  const active = activeAppMemberships(memberships);
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
