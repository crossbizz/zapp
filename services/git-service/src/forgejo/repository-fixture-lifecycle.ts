import { parseInternalRepoRef } from '@zapp/contracts';

import type { ForgejoClient } from './client.js';
import type { GitProvider } from '../provider/types.js';

/** The only provider operations a suite cleanup is allowed to use. */
export type RepositoryFixtureCleanupPort = Pick<
  GitProvider,
  'deleteRepository' | 'repositoryExists'
>;

/**
 * Tracks suite-owned Forgejo repositories before their creation is attempted.
 *
 * Registering first means a provider failure after creating a repository cannot
 * make that repository unreachable by teardown. Cleanup attempts every target,
 * verifies absence, and reports all failures after it has made its best effort.
 */
export class RepositoryFixtureLifecycle {
  readonly #refs = new Set<string>();

  record(ref: string): void {
    parseInternalRepoRef(ref);
    this.#refs.add(ref);
  }

  refs(): readonly string[] {
    return [...this.#refs];
  }

  async cleanup(port: RepositoryFixtureCleanupPort): Promise<void> {
    const failures: string[] = [];
    for (const ref of this.#refs) {
      try {
        await port.deleteRepository(ref);
      } catch {
        failures.push(`${ref}: delete failed`);
      }

      try {
        if (await port.repositoryExists(ref)) {
          failures.push(`${ref}: still exists`);
        }
      } catch {
        failures.push(`${ref}: absence could not be verified`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Forgejo fixture cleanup failed: ${failures.join('; ')}`);
    }
  }
}

/** Runs every cleanup action and throws only after every action has been attempted. */
export async function runFixtureCleanup(
  actions: readonly { readonly name: string; readonly run: () => Promise<void> }[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      failures.push(new Error(`Forgejo fixture cleanup failed: ${action.name}`, { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Forgejo fixture cleanup failed');
}

/** Deletes fixture-owned organizations only after their repositories are gone. */
export async function cleanupFixtureOrganizations(
  client: ForgejoClient,
  refs: readonly string[],
): Promise<void> {
  const failures: string[] = [];
  for (const owner of new Set(refs.map((ref) => parseInternalRepoRef(ref).owner))) {
    try {
      await client.send({ method: 'DELETE', path: `/orgs/${owner}`, allow: [404] });
      const remaining = await client.send({ method: 'GET', path: `/orgs/${owner}`, allow: [404] });
      if (remaining.status !== 404) failures.push(`${owner}: still exists`);
    } catch {
      failures.push(`${owner}: deletion or absence verification failed`);
    }
  }
  if (failures.length > 0) throw new Error(`Forgejo fixture cleanup failed: ${failures.join('; ')}`);
}
