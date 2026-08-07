import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { describe, expect, test } from 'vitest';
import { getMetrics } from '../src/health.js';

describe('workspace-agent metrics', () => {
  test('reads cgroup metrics from the configured delegated root by default', async () => {
    const cgroupRoot = await mkdtemp(join(tmpdir(), 'zapp-metrics-cgroup-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalCgroupRoot = process.env.ZAPP_CGROUP_ROOT;

    try {
      await Promise.all([
        writeFile(cgroupRoot + '/cpu.stat', 'user_usec 1234\nsystem_usec 5678\n'),
        writeFile(cgroupRoot + '/memory.current', '987654\n'),
      ]);
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      process.env.ZAPP_CGROUP_ROOT = cgroupRoot;

      const metrics = await getMetrics([]);

      expect(metrics.cpu).toEqual({ userMicros: 1234, systemMicros: 5678 });
      expect(metrics.memory.rssBytes).toBe(987654);
    } finally {
      if (originalPlatform === undefined) {
        delete (process as { platform?: string }).platform;
      } else {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      if (originalCgroupRoot === undefined) {
        delete process.env.ZAPP_CGROUP_ROOT;
      } else {
        process.env.ZAPP_CGROUP_ROOT = originalCgroupRoot;
      }
      await rm(cgroupRoot, { recursive: true, force: true });
    }
  });
});
