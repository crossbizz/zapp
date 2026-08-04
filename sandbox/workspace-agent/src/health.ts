import { createConnection } from 'node:net';
import process from 'node:process';
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

export function getMetrics(): MetricsResponse {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return MetricsResponseSchema.parse({
    at: new Date().toISOString(),
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
