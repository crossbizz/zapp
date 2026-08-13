import { parseInternalRepoRef } from '@zapp/contracts';

export interface ForgejoRepositoryInventoryRow {
  readonly full_name?: unknown;
  readonly private?: unknown;
}

export interface OrphanInventory {
  readonly candidates: readonly string[];
  readonly excluded: Readonly<{ dbBacked: number; nonCanonical: number; nonPrivate: number }>;
}

export const LOCAL_DEV_FORGEJO_URL = 'http://localhost:3300';

/** This inventory is intentionally argument-free; it has no mutation mode. */
export function assertNoOrphanInventoryArguments(args: readonly string[]): void {
  if (args.length !== 0) {
    throw new Error('Forgejo orphan inventory does not accept arguments');
  }
}

/** Refuses anything other than the local root URL written by `scripts/dev-up.sh`. */
export function assertLocalForgejoUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('refusing non-local dev Forgejo URL');
  }
  if (
    value !== LOCAL_DEV_FORGEJO_URL ||
    url.protocol !== 'http:' ||
    url.hostname !== 'localhost' ||
    url.port !== '3300' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('refusing non-local dev Forgejo URL');
  }
  return url;
}

/** The only database the local compose control plane is allowed to authorize. */
export function assertLocalDevDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('refusing non-local control-plane DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== 'localhost' ||
    url.port !== '5432' ||
    url.pathname !== '/zapp' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('refusing non-local control-plane DATABASE_URL');
  }
  return url;
}

/**
 * Applies the exact same canonical-ref parser that production provider paths
 * use. Everything else remains inventory only; only the returned refs may be
 * given to a destructive request.
 */
export function selectOrphanedRepositories(
  repositories: readonly ForgejoRepositoryInventoryRow[],
  databaseRefs: ReadonlySet<string>,
): OrphanInventory {
  const candidates: string[] = [];
  let dbBacked = 0;
  let nonCanonical = 0;
  let nonPrivate = 0;

  for (const repository of repositories) {
    if (repository.private !== true) {
      nonPrivate += 1;
      continue;
    }
    if (typeof repository.full_name !== 'string') {
      nonCanonical += 1;
      continue;
    }
    try {
      parseInternalRepoRef(repository.full_name);
    } catch {
      nonCanonical += 1;
      continue;
    }
    if (databaseRefs.has(repository.full_name)) {
      dbBacked += 1;
      continue;
    }
    candidates.push(repository.full_name);
  }

  return { candidates: candidates.sort(), excluded: { dbBacked, nonCanonical, nonPrivate } };
}
