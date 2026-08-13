import { internalRepoRef, newId } from '@zapp/contracts';
import { describe, expect, it } from 'vitest';

import {
  assertNoOrphanInventoryArguments,
  assertLocalDevDatabaseUrl,
  assertLocalForgejoUrl,
  selectOrphanedRepositories,
} from '../src/forgejo/orphan-inventory.js';

function ref(): string {
  return internalRepoRef({ organizationId: newId('org'), projectId: newId('proj') });
}

describe('Forgejo orphan inventory', () => {
  it('rejects every command argument so inventory has no destructive mode', () => {
    expect(() => {
      assertNoOrphanInventoryArguments([]);
    }).not.toThrow();
    expect(() => {
      assertNoOrphanInventoryArguments(['--apply']);
    }).toThrow(/does not accept arguments/i);
    expect(() => {
      assertNoOrphanInventoryArguments(['--help']);
    }).toThrow(/does not accept arguments/i);
    expect(() => {
      assertNoOrphanInventoryArguments(['--apply', '--force']);
    }).toThrow(
      /does not accept arguments/i,
    );
  });

  it('selects only private canonical refs that are absent from the control-plane repository table', () => {
    const orphan = ref();
    const dbBacked = ref();
    const inventory = selectOrphanedRepositories(
      [
        { full_name: orphan, private: true },
        { full_name: dbBacked, private: true },
        { full_name: ref(), private: false },
        { full_name: 'not-a-zapp-repository', private: true },
      ],
      new Set([dbBacked]),
    );

    expect(inventory.candidates).toEqual([orphan]);
    expect(inventory.excluded).toEqual({ dbBacked: 1, nonCanonical: 1, nonPrivate: 1 });
  });

  it('requires the exact generated local Forgejo root identity', () => {
    expect(() => assertLocalForgejoUrl('https://forgejo.example.com')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://localhost:3300/forgejo')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://127.0.0.1:3300')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://[::1]:3300')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://localhost:3301')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://user:password@localhost:3300')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://localhost:3300?target=other')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://localhost:3300#other')).toThrow(/local dev/i);
    expect(() => assertLocalForgejoUrl('http://localhost:3300')).not.toThrow();
  });

  it('refuses every database except the exact local control-plane zapp database', () => {
    expect(() => assertLocalDevDatabaseUrl('postgres://zapp:zapp@localhost:5432/zapp')).not.toThrow();
    expect(() => assertLocalDevDatabaseUrl('postgres://zapp:zapp@localhost:5432/zapp_test')).toThrow(
      /control-plane/i,
    );
    expect(() => assertLocalDevDatabaseUrl('postgres://zapp:zapp@localhost:5433/zapp')).toThrow(
      /control-plane/i,
    );
    expect(() => assertLocalDevDatabaseUrl('postgres://zapp:zapp@127.0.0.1:5432/zapp')).toThrow(
      /control-plane/i,
    );
    expect(() => assertLocalDevDatabaseUrl('postgres://zapp:zapp@[::1]:5432/zapp')).toThrow(
      /control-plane/i,
    );
  });

  it('rejects TypeID alphabets that no zapp organization or project can produce', () => {
    const invalid = 'org_iiiiiiiiiiiiiiiiiiiiiiiiii/proj_iiiiiiiiiiiiiiiiiiiiiiiiii';
    expect(selectOrphanedRepositories([{ full_name: invalid, private: true }], new Set()).candidates).toEqual(
      [],
    );
  });
});
