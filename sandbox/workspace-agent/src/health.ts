import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { execa } from 'execa';
import { z } from 'zod';

const DevServerHealthSchema = z
  .object({ port: z.number().int().min(1).max(65_535), ready: z.boolean() })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    details: z.string(),
    devServer: DevServerHealthSchema.optional(),
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
  sample(activePids: readonly number[]): Promise<MetricsUsage>;
}

function parseCpuTime(value: string): number {
  const daySplit = value.split('-');
  const clock = daySplit.at(-1)?.split(':').map(Number) ?? [];
  if (clock.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const [hours = 0, minutes = 0, seconds = 0] =
    clock.length === 3 ? clock : [0, clock[0] ?? 0, clock[1] ?? 0];
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000_000;
}

async function readCgroupUsage(): Promise<MetricsUsage | undefined> {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    const [cpuStat, memoryCurrent] = await Promise.all([
      readFile('/sys/fs/cgroup/cpu.stat', 'utf8'),
      readFile('/sys/fs/cgroup/memory.current', 'utf8'),
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

async function readPortableUsage(activePids: readonly number[]): Promise<MetricsUsage> {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  let childCpuMicros = 0;
  let childRssBytes = 0;
  if (activePids.length > 0) {
    try {
      const result = await execa(
        'ps',
        ['-o', 'time=,rss=', '-p', activePids.join(',')],
        {
          reject: false,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          extendEnv: false,
        },
      );
      for (const line of result.stdout.trim().split('\n')) {
        const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          childCpuMicros += parseCpuTime(match[1]);
          childRssBytes += Number(match[2]) * 1_024;
        }
      }
    } catch {
      // A process may exit between the active-process snapshot and sampling.
    }
  }
  return MetricsUsageSchema.parse({
    cpu: { userMicros: cpu.user + childCpuMicros, systemMicros: cpu.system },
    memory: {
      rssBytes: memory.rss + childRssBytes,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
  });
}

const defaultMetricsSource: MetricsSource = {
  async sample(activePids) {
    return (await readCgroupUsage()) ?? readPortableUsage(activePids);
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

export async function getHealth(devServerPort?: number): Promise<HealthResponse> {
  if (devServerPort === undefined) {
    return HealthResponseSchema.parse({ ok: true, details: 'workspace-agent ready' });
  }
  const ready = await portIsReady(devServerPort);
  return HealthResponseSchema.parse({
    ok: ready,
    details: ready ? 'workspace-agent ready' : 'workspace-agent ready; dev server not ready',
    devServer: { port: devServerPort, ready },
  });
}

export async function getMetrics(
  activePids: readonly number[],
  source: MetricsSource = defaultMetricsSource,
): Promise<MetricsResponse> {
  const usage = await source.sample(activePids);
  return MetricsResponseSchema.parse({
    at: new Date().toISOString(),
    activeChildren: activePids.length,
    ...usage,
  });
}
