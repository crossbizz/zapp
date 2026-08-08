import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    async mkdir(path: Parameters<typeof original.mkdir>[0], options?: Parameters<typeof original.mkdir>[1]) {
      const result = await original.mkdir(path, options);
      const directory = String(path);
      if (basename(directory).startsWith('zapp-exec-')) {
        await Promise.all([
          original.writeFile(join(directory, 'cgroup.procs'), ''),
          original.writeFile(join(directory, 'cgroup.events'), 'populated 0\n'),
          original.writeFile(join(directory, 'cgroup.kill'), ''),
        ]);
      }
      return result;
    },
    async rmdir(path: Parameters<typeof original.rmdir>[0], options?: Parameters<typeof original.rmdir>[1]) {
      const directory = String(path);
      if (basename(directory).startsWith('zapp-exec-')) {
        await Promise.all(
          ['cgroup.procs', 'cgroup.events', 'cgroup.kill'].map((name) =>
            original.unlink(join(directory, name)),
          ),
        );
      }
      return original.rmdir(path, options);
    },
  };
});

import { CgroupV2Containment } from '../src/containment/cgroup.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cgroup-v2 directory removal', () => {
  test('removes the cgroup directory after the authoritative empty signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zapp-cgroup-remove-'));
    roots.push(root);
    await writeFile(join(root, 'cgroup.controllers'), '');

    const execution = await new CgroupV2Containment(root).create();
    const directory = join(root, execution.id);
    await execution.waitForEmpty();
    await execution.remove();

    await expect(readFile(directory, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
