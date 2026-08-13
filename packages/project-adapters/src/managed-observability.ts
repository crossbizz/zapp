import {
  InstrumentationPlanSchema,
  type InstrumentationPlan,
  type ProjectContext,
} from '@zapp/contracts';
import { z } from 'zod';

const PackageJsonSchema = z
  .object({
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
  })
  .passthrough();

const HEALTH_TARGETS: Readonly<Record<string, string>> = {
  next: 'app/api/health/route.ts',
  nuxt: 'server/api/health.get.ts',
  sveltekit: 'src/routes/api/health/+server.ts',
  astro: 'src/pages/api/health.ts',
  vite: 'api/health.ts',
  react: 'api/health.ts',
  'express-fastify': 'src/routes/health.ts',
  nest: 'src/health/health.controller.ts',
  capacitor: 'src/observability/health.ts',
  'generic-node': 'src/routes/health.ts',
};

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

async function source(ctx: ProjectContext, path: string): Promise<string> {
  try {
    return await ctx.readFile(path);
  } catch {
    return '';
  }
}

export async function proposeManagedInstrumentation(
  ctx: ProjectContext,
  adapterId: string,
): Promise<InstrumentationPlan> {
  const listed = new Set((await ctx.listFiles('**/*')).map(normalize));
  const manifest = PackageJsonSchema.parse(JSON.parse(await ctx.readFile('package.json')));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const faroPath = 'src/observability/faro-web.ts';
  const otelPath = 'src/observability/otel-node.ts';
  const loggingPath = 'src/observability/logging.ts';
  const healthPath = HEALTH_TARGETS[adapterId] ?? HEALTH_TARGETS['generic-node'];
  if (healthPath === undefined) throw new Error('managed_health_target_missing');

  const [faroSource, otelSource, loggingSource, healthSource] = await Promise.all([
    source(ctx, faroPath),
    source(ctx, otelPath),
    source(ctx, loggingPath),
    source(ctx, healthPath),
  ]);

  return InstrumentationPlanSchema.parse({
    steps: [
      {
        id: 'managed-faro-web',
        capability: 'frontend_errors',
        targetPath: faroPath,
        rationale:
          'Install @grafana/faro-web-sdk and render templates/observability/faro-web.ts.hbs to capture frontend errors and web vitals. Bind only the per-project Faro collector provisioned in the zapp-managed Grafana Cloud organization, and use ZAPP_RELEASE for DEP-8 release correlation.',
        alreadyPresent:
          '@grafana/faro-web-sdk' in dependencies &&
          listed.has(faroPath) &&
          faroSource.includes('initializeFaro') &&
          faroSource.includes('getWebInstrumentations') &&
          faroSource.includes('ZAPP_PROJECT_FARO_URL') &&
          faroSource.includes('ZAPP_PROJECT_ID') &&
          faroSource.includes('ZAPP_RELEASE'),
      },
      {
        id: 'managed-otel-node',
        capability: 'backend_tracing',
        targetPath: otelPath,
        rationale:
          'Install the OpenTelemetry Node SDK, auto-instrumentations, OTLP exporters, and processors imported by templates/observability/otel-node.ts.hbs, then load the rendered file before application imports. Runtime configuration must resolve this project\'s per-project scoped OTLP token and endpoint, never a shared credential.',
        alreadyPresent:
          '@opentelemetry/sdk-node' in dependencies &&
          listed.has(otelPath) &&
          otelSource.includes('NodeSDK') &&
          otelSource.includes('ZAPP_PROJECT_OTLP_ENDPOINT') &&
          otelSource.includes('ZAPP_PROJECT_OTLP_TOKEN') &&
          otelSource.includes('ZAPP_PROJECT_ID'),
      },
      {
        id: 'managed-structured-logging',
        capability: 'structured_logging',
        targetPath: loggingPath,
        rationale:
          'Install pino and render templates/observability/logging.ts.hbs for tenant-safe structured output with trace correlation and secret-value redaction before any destination.',
        alreadyPresent:
          'pino' in dependencies &&
          listed.has(loggingPath) &&
          loggingSource.includes('pino') &&
          loggingSource.includes('[secret:') &&
          loggingSource.includes('traceId'),
      },
      {
        id: 'managed-health-endpoint',
        capability: 'health_endpoint',
        targetPath: healthPath,
        rationale:
          'Render templates/observability/health-endpoint.ts.hbs at the adapter-specific /api/health route and preserve the release identifier used by deployment health checks.',
        alreadyPresent:
          listed.has(healthPath) &&
          (healthSource.includes("status: 'ok'") || healthSource.includes('status: "ok"')) &&
          healthSource.includes('ZAPP_RELEASE'),
      },
    ],
  });
}
