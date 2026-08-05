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
  sample(activeProcessGroups: readonly number[]): Promise<MetricsUsage>;
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

interface ProcessUsageRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly rssBytes: number;
  readonly userMicros: number;
  readonly systemMicros: number;
}

function parseProcessUsage(output: string): ProcessUsageRow[] {
  const rows: ProcessUsageRow[] = [];
  for (const line of output.trim().split('\n')) {
    const [pid, parentPid, processGroupId, rssKiB, userTime, systemTime] = line
      .trim()
      .split(/\s+/u);
    if (
      pid === undefined ||
      parentPid === undefined ||
      processGroupId === undefined ||
      rssKiB === undefined ||
      userTime === undefined ||
      systemTime === undefined
    ) {
      continue;
    }
    const numeric = [pid, parentPid, processGroupId, rssKiB].map(Number);
    if (numeric.some((value) => !Number.isInteger(value) || value < 0)) {
      continue;
    }
    rows.push({
      pid: numeric[0] ?? 0,
      parentPid: numeric[1] ?? 0,
      processGroupId: numeric[2] ?? 0,
      rssBytes: (numeric[3] ?? 0) * 1_024,
      userMicros: parseCpuTime(userTime),
      systemMicros: parseCpuTime(systemTime),
    });
  }
  return rows;
}

function selectWorkspaceProcesses(
  rows: readonly ProcessUsageRow[],
  activeProcessGroups: readonly number[],
): ProcessUsageRow[] {
  const processGroups = new Set(activeProcessGroups);
  const selected = new Set<number>();
  for (const row of rows) {
    if (processGroups.has(row.processGroupId)) {
      selected.add(row.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.parentPid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => selected.has(row.pid));
}

async function readPortableUsage(activeProcessGroups: readonly number[]): Promise<MetricsUsage> {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  let childUserMicros = 0;
  let childSystemMicros = 0;
  let childRssBytes = 0;
  if (activeProcessGroups.length > 0) {
    try {
      const result = await execa('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,utime=,stime='], {
        reject: false,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        extendEnv: false,
      });
      for (const row of selectWorkspaceProcesses(
        parseProcessUsage(result.stdout),
        activeProcessGroups,
      )) {
        childUserMicros += row.userMicros;
        childSystemMicros += row.systemMicros;
        childRssBytes += row.rssBytes;
      }
    } catch {
      // A process may exit between the active-process snapshot and sampling.
    }
  }
  return MetricsUsageSchema.parse({
    cpu: {
      userMicros: cpu.user + childUserMicros,
      systemMicros: cpu.system + childSystemMicros,
    },
    memory: {
      rssBytes: memory.rss + childRssBytes,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
  });
}

export const portableMetricsSource: MetricsSource = {
  sample: readPortableUsage,
};

const defaultMetricsSource: MetricsSource = {
  async sample(activeProcessGroups) {
    return (await readCgroupUsage()) ?? portableMetricsSource.sample(activeProcessGroups);
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
