import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import { RepositoryFixtureLifecycle } from '../src/forgejo/repository-fixture-lifecycle.js';

function ref(): string {
  return internalRepoRef({ organizationId: newId('org'), projectId: newId('proj') });
}

describe('RepositoryFixtureLifecycle', () => {
  it('continues cleanup after one deletion fails, verifies every surviving repository, and fails closed', async () => {
    const first = ref();
    const second = ref();
    const lifecycle = new RepositoryFixtureLifecycle();
    lifecycle.record(first);
    lifecycle.record(second);

    const deleted: string[] = [];
    await expect(
      lifecycle.cleanup({
        deleteRepository(target) {
          deleted.push(target);
          if (target === first) throw new Error('temporary Forgejo failure');
          return Promise.resolve();
        },
        repositoryExists(target) {
          return Promise.resolve(target === first);
        },
      }),
    ).rejects.toThrow(/cleanup failed/i);

    // A cleanup failure cannot strand later fixtures: every registered target
    // was attempted, and the failure names a still-present target.
    expect(deleted).toEqual([first, second]);
  });

  it('is idempotent and rejects any ref the provider did not structurally derive', async () => {
    const target = ref();
    const lifecycle = new RepositoryFixtureLifecycle();
    lifecycle.record(target);
    expect(() => {
      lifecycle.record('someone/else');
    }).toThrow(/Invalid internal repository ref/);

    const deleted = new Set<string>();
    const port = {
      deleteRepository(value: string) {
        deleted.add(value);
        return Promise.resolve();
      },
      repositoryExists(value: string) {
        return Promise.resolve(!deleted.has(value));
      },
    };
    await lifecycle.cleanup(port);
    await lifecycle.cleanup(port);
    expect(deleted).toEqual(new Set([target]));
  });
});
