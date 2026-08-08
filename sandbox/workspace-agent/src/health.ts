import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import type { DevServerEvidence } from './dev-server.js';

const LegacyDevServerHealthSchema = z
  .object({ port: z.number().int().min(1).max(65_535), ready: z.boolean() })
  .strict();
const ManagedDevServerHealthSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    owned: z.boolean(),
    httpReady: z.boolean(),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    details: z.string(),
    devServer: z.union([LegacyDevServerHealthSchema, ManagedDevServerHealthSchema]).nullable(),
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const MetricsResponseSchema = z
  .object({
    at: z.string().datetime(),
    activeChildren: z.number().int().nonnegative(),
    cpu: z
      .object({ userMicros: z.number().finite().nonnegative(), systemMicros: z.number().finite().nonnegative() })
      .strict(),
    memory: z
      .object({
        rssBytes: z.number().finite().nonnegative(),
        heapTotalBytes: z.number().finite().nonnegative(),
        heapUsedBytes: z.number().finite().nonnegative(),
        externalBytes: z.number().finite().nonnegative(),
        arrayBuffersBytes: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;

const MetricsUsageSchema = MetricsResponseSchema.omit({ at: true, activeChildren: true });
type MetricsUsage = z.infer<typeof MetricsUsageSchema>;

export interface MetricsSource {
  sample(activeProcessGroups: readonly number[]): Promise<MetricsUsage>;
}

async function readCgroupUsage(): Promise<MetricsUsage | undefined> {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    const cgroupRoot = resolve(process.env.ZAPP_CGROUP_ROOT ?? '/sys/fs/cgroup');
    const [cpuStat, memoryCurrent] = await Promise.all([
      readFile(join(cgroupRoot, 'cpu.stat'), 'utf8'),
      readFile(join(cgroupRoot, 'memory.current'), 'utf8'),
    ]);
    const cpuValues = new Map(
      cpuStat
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/, 2) as [string, string]),
    );
    const memory = process.memoryUsage();
    return MetricsUsageSchema.parse({
      cpu: {
        userMicros: Number(cpuValues.get('user_usec')),
        systemMicros: Number(cpuValues.get('system_usec')),
      },
      memory: {
        rssBytes: Number(memoryCurrent.trim()),
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
    });
  } catch {
    return undefined;
  }
}

function readAgentUsage(): MetricsUsage {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return MetricsUsageSchema.parse({
    cpu: { userMicros: cpu.user, systemMicros: cpu.system },
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
  });
}

const defaultMetricsSource: MetricsSource = {
  async sample() {
    // cgroup-v2 is authoritative when it is available.  A host-local agent
    // snapshot is deliberately less detailed than polling PIDs or PGIDs: the
    // latter is not a safe containment or accounting fallback.
    return (await readCgroupUsage()) ?? readAgentUsage();
  },
};

async function portIsReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const complete = (ready: boolean): void => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(ready);
    };
    const timeout = setTimeout(() => {
      complete(false);
    }, 250);
    socket.once('connect', () => {
      complete(true);
    });
    socket.once('error', () => {
      complete(false);
    });
  });
}

export async function getHealth(
  devServer?: number | DevServerEvidence | null,
): Promise<HealthResponse> {
  if (devServer === undefined || devServer === null) {
    return HealthResponseSchema.parse({
      ok: true,
      details: 'workspace-agent ready',
      devServer: null,
    });
  }
  if (typeof devServer !== 'number') {
    const ready = devServer.owned && devServer.httpReady;
    return HealthResponseSchema.parse({
      ok: ready,
      details: ready ? 'workspace-agent ready' : 'workspace-agent ready; dev server not ready',
      devServer,
    });
  }
  const ready = await portIsReady(devServer);
  return HealthResponseSchema.parse({
    ok: ready,
    details: ready ? 'workspace-agent ready' : 'workspace-agent ready; dev server not ready',
    devServer: { port: devServer, ready },
  });
}

export async function getMetrics(
  activeProcessGroups: readonly number[],
  source: MetricsSource = defaultMetricsSource,
): Promise<MetricsResponse> {
  const usage = await source.sample(activeProcessGroups);
  return MetricsResponseSchema.parse({
    at: new Date().toISOString(),
    activeChildren: activeProcessGroups.length,
    ...usage,
  });
}
