import { createDb, repositories } from '@zapp/db';
import { parseInternalRepoRef } from '@zapp/contracts';
import { eq, sql } from 'drizzle-orm';

import { createForgejoClient } from '../src/forgejo/client.js';
import {
  assertLocalForgejoUrl,
  assertLocalDevDatabaseUrl,
  selectOrphanedRepositories,
  type ForgejoRepositoryInventoryRow,
} from '../src/forgejo/orphan-inventory.js';

const APPLY = '--apply';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== APPLY)) {
  throw new Error('usage: pnpm --filter @zapp/git-service forgejo:orphans [--apply]');
}

const forgejoUrl = process.env['FORGEJO_URL'] ?? '';
const adminToken = process.env['FORGEJO_ADMIN_TOKEN'] ?? '';
const databaseUrl = process.env['DATABASE_URL'] ?? '';
if (adminToken === '' || databaseUrl === '') {
  throw new Error('FORGEJO_ADMIN_TOKEN and DATABASE_URL are required for orphan inventory');
}
assertLocalForgejoUrl(forgejoUrl);

assertLocalDevDatabaseUrl(databaseUrl);

const client = createForgejoClient({ baseUrl: forgejoUrl, adminToken, timeoutMs: 30_000 });

interface ForgejoOrganizationInventoryRow {
  readonly username?: unknown;
}

async function listForgejoRepositories(): Promise<ForgejoRepositoryInventoryRow[]> {
  const organizations: ForgejoOrganizationInventoryRow[] = [];
  for (let page = 1; page <= 10_000; page += 1) {
    const response = await client.send<ForgejoOrganizationInventoryRow[]>({
      method: 'GET',
      path: `/orgs?limit=50&page=${String(page)}`,
    });
    if (!Array.isArray(response.body)) {
      throw new Error('Forgejo organization inventory was not an array');
    }
    organizations.push(...response.body);
    if (response.body.length < 50) break;
  }
  if (organizations.length >= 500_000) {
    throw new Error('refusing unbounded Forgejo organization inventory');
  }

  const repositories: ForgejoRepositoryInventoryRow[] = [];
  for (const organization of organizations) {
    if (typeof organization.username !== 'string') continue;
    try {
      // Never issue a repository-list request for a noncanonical owner.
      parseInternalRepoRef(`${organization.username}/proj_00000000000000000000000000`);
    } catch {
      continue;
    }
    for (let page = 1; page <= 10_000; page += 1) {
      const response = await client.send<ForgejoRepositoryInventoryRow[]>({
        method: 'GET',
        path: `/orgs/${encodeURIComponent(organization.username)}/repos?limit=50&page=${String(page)}`,
      });
      if (!Array.isArray(response.body)) {
        throw new Error('Forgejo organization repository inventory was not an array');
      }
      repositories.push(...response.body);
      if (response.body.length < 50) break;
      if (page === 10_000) {
        throw new Error('refusing unbounded Forgejo organization repository inventory');
      }
    }
  }
  return repositories;
}

async function databaseRefs(): Promise<Set<string>> {
  const database = createDb(databaseUrl);
  try {
    const rows = await database.db
      .select({ internalRepoRef: repositories.internalRepoRef })
      .from(repositories);
    return new Set(rows.map((row) => row.internalRepoRef));
  } finally {
    await database.close();
  }
}

async function deleteIfStillOrphan(ref: string): Promise<void> {
  const database = createDb(databaseUrl);
  try {
    await database.db.transaction(async (transaction) => {
      // This excludes a concurrent repositories insert while the external
      // deletion is in flight; the immediate re-read is therefore current.
      await transaction.execute(sql`LOCK TABLE repositories IN SHARE ROW EXCLUSIVE MODE`);
      const backed = await transaction
        .select({ internalRepoRef: repositories.internalRepoRef })
        .from(repositories)
        .where(eq(repositories.internalRepoRef, ref));
      if (backed.length > 0) {
        throw new Error(`refusing DB-backed Forgejo repository: ${ref}`);
      }
      const { owner, name } = parseInternalRepoRef(ref);
      await client.send({ method: 'DELETE', path: `/repos/${owner}/${name}`, allow: [404] });
      const remaining = await client.send({ method: 'GET', path: `/repos/${owner}/${name}`, allow: [404] });
      if (remaining.status !== 404) {
        throw new Error(`Forgejo orphan cleanup failed: ${ref} still exists`);
      }
    });
  } finally {
    await database.close();
  }
}

async function inventory(): Promise<ReturnType<typeof selectOrphanedRepositories>> {
  const [forgejoRepositories, controlPlaneRefs] = await Promise.all([
    listForgejoRepositories(),
    databaseRefs(),
  ]);
  return selectOrphanedRepositories(forgejoRepositories, controlPlaneRefs);
}

const before = await inventory();
console.log(
  `Forgejo orphan inventory: candidates=${String(before.candidates.length)} dbBacked=${String(before.excluded.dbBacked)} nonCanonical=${String(before.excluded.nonCanonical)} nonPrivate=${String(before.excluded.nonPrivate)}`,
);
for (const ref of before.candidates) {
  // Exact candidate inventory is intentionally visible, while credentials never
  // enter output or URLs.
  console.log(`candidate ${ref}`);
}

if (args[0] === APPLY) {
  for (const ref of before.candidates) {
    await deleteIfStillOrphan(ref);
  }
  const after = await inventory();
  console.log(`Forgejo orphan post-cleanup candidates=${String(after.candidates.length)}`);
  if (after.candidates.length !== 0) {
    throw new Error('Forgejo orphan cleanup failed: candidates remain after deletion');
  }
}
