import { GateResultSchema, type Gate } from './registry.js';
import { executeBrowserProbe } from './browser-smoke.js';

export function createPreviewHealthGate(): Gate {
  return {
    id: 'preview_health',
    async run(ctx) {
      const path = ctx.contract.health?.path;
      if (path === undefined) {
        const details = { error: 'health_path_missing' };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.preview_health',
          body: new TextEncoder().encode(JSON.stringify(details)),
        });
        return GateResultSchema.parse({
          status: 'failed',
          evidenceArtifactIds: [artifactId],
          details,
        });
      }

      const probe = await executeBrowserProbe(ctx, {
        routes: [path],
        authRouteCount: 0,
        captureScreenshots: false,
        discoverNavLinks: false,
        maxRoutes: 1,
      });
      const route = probe.output?.routes[0];
      if (route === undefined || route.path !== path) {
        const details = { path, error: 'preview_health_probe_failed' };
        const artifactId = await ctx.artifacts.store({
          kind: 'verification.preview_health',
          body: new TextEncoder().encode(
            JSON.stringify({
              ...details,
              exitCode: probe.result.exitCode,
              stderr: probe.result.stderr,
              stdout: probe.result.stdout,
              truncated: probe.result.truncated,
              terminationReason: probe.result.terminationReason,
            }),
          ),
        });
        return GateResultSchema.parse({
          status: 'failed',
          evidenceArtifactIds: [artifactId],
          details,
        });
      }

      const consoleErrorCount = route.console.filter((entry) => entry.type === 'error').length;
      const details = {
        path,
        statusCode: route.statusCode,
        consoleErrorCount,
        pageErrorCount: route.pageErrors.length,
      };
      const artifactId = await ctx.artifacts.store({
        kind: 'verification.preview_health',
        body: new TextEncoder().encode(
          JSON.stringify({
            ...details,
            console: route.console,
            pageErrors: route.pageErrors,
            failedRequests: route.failedRequests,
          }),
        ),
      });
      return GateResultSchema.parse({
        status:
          route.statusCode === 200 && consoleErrorCount === 0 && route.pageErrors.length === 0
            ? 'passed'
            : 'failed',
        evidenceArtifactIds: [artifactId],
        details,
      });
    },
  };
}
