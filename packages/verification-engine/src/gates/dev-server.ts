import { GateResultSchema, type Gate } from './registry.js';

export function createDevServerGate(): Gate {
  return {
    id: 'dev_server_start',
    async run(ctx) {
      try {
        const process = await ctx.runtime.startDevServer(ctx.contract);
        const health = await ctx.runtime.health();
        const details = {
          port: process.port,
          pid: process.pid,
          healthy: health.ok,
        };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.dev_server_start',
          body: new TextEncoder().encode(JSON.stringify({ ...details, healthDetails: health.details })),
        });
        return GateResultSchema.parse({
          status: health.ok ? 'passed' : 'failed',
          evidenceArtifactIds: [artifactId],
          details,
        });
      } catch (error: unknown) {
        const details = { healthy: false, error: 'dev_server_start_failed' };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.dev_server_start',
          body: new TextEncoder().encode(
            JSON.stringify({
              ...details,
              cause: error instanceof Error ? error.message : 'unknown',
            }),
          ),
        });
        return GateResultSchema.parse({
          status: 'failed',
          evidenceArtifactIds: [artifactId],
          details,
        });
      }
    },
  };
}
