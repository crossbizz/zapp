import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const services = [
  'control-api',
  'git-service',
  'model-gateway',
  'orchestrator-worker',
  'release-service',
  'sandbox-service',
  'verification-service',
] as const;
const httpHosts = [
  'control-api',
  'git-service',
  'model-gateway',
  'sandbox-service',
  'verification-service',
] as const;
const standaloneServers = ['control-api', 'git-service', 'model-gateway'] as const;
const libraryServiceEntries = [
  ['release-service', 'src/index.ts'],
  ['sandbox-service', 'src/compose.ts'],
  ['verification-service', 'src/index.ts'],
] as const;

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

describe('service observability wiring', () => {
  it.each(services)('%s owns an exact service-named OTel bootstrap', async (service) => {
    const manifest = JSON.parse(await source(`services/${service}/package.json`)) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@zapp/config']).toBe('workspace:*');

    const instrumentation = await source(`services/${service}/src/instrumentation.ts`);
    expect(instrumentation).toContain('startOpenTelemetryFromEnv');
    expect(instrumentation).toContain(`serviceName: '${service}'`);
  });

  it.each(httpHosts)('%s attaches the shared API latency/error hooks', async (service) => {
    const app = await source(`services/${service}/src/app.ts`);
    expect(app).toContain('createHttpServerTelemetry');
    expect(app).toContain("addHook('onRequest'");
    expect(app).toContain("addHook('onResponse'");
  });

  it.each(standaloneServers)(
    '%s preloads instrumentation before its server module',
    async (service) => {
      const manifest = JSON.parse(await source(`services/${service}/package.json`)) as {
        scripts?: Record<string, string>;
      };
      expect(manifest.scripts?.start).toContain('--import ./dist/instrumentation.js');
    },
  );

  it.each(libraryServiceEntries)(
    '%s starts instrumentation from its production package entry',
    async (_service, entry) => {
      expect(await source(`services/${_service}/${entry}`)).toContain('./instrumentation.js');
    },
  );

  it('propagates the active control-api trace through Temporal workflows and activities', async () => {
    const controlServer = await source('services/control-api/src/server.ts');
    const worker = await source('services/orchestrator-worker/src/worker.ts');
    expect(controlServer).toContain('OpenTelemetryWorkflowClientInterceptor');
    expect(worker).toContain('OpenTelemetryPlugin');
    expect(worker).toContain("getOpenTelemetryRuntime('orchestrator-worker')");
  });

  it('measures each required domain at its execution boundary', async () => {
    const sessionLoop = await source('services/orchestrator-worker/src/session/loop.ts');
    const lifecycle = await source('services/sandbox-service/src/lifecycle/manager.ts');
    const workspaces = await source('services/sandbox-service/src/routes/workspaces.ts');
    const notifications = await source('services/control-api/src/notifications/service.ts');
    const eventStream = await source('services/control-api/src/events/sse.ts');
    const modelCompletions = await source('services/control-api/src/usage/model-completions.ts');

    expect(sessionLoop).toContain("startObservabilitySpan('agent.step:model'");
    expect(sessionLoop).toContain('withObservabilitySpan');
    expect(sessionLoop).toContain('`agent.tool:${call.toolName}`');
    expect(lifecycle).toContain('withObservabilitySpan');
    expect(lifecycle).toContain("'sandbox.lifecycle:provision'");
    expect(workspaces).toContain('preview.readiness:');
    expect(notifications).toContain("'queueDelay'");
    expect(eventStream).toContain("'eventStreamLag'");
    expect(modelCompletions).toContain("'modelCost'");
  });

  it('enables Faro error, web-vital, and trace instrumentation in both frontends', async () => {
    const web = await source('apps/web/src/components/frontend-observability.tsx');
    const desktop = await source('apps/desktop/src/lib/faro.ts');
    const renderer = await source('apps/desktop/src/renderer.tsx');
    for (const frontend of [web, desktop]) {
      expect(frontend).toContain('getWebInstrumentations');
      expect(frontend).toContain('TracingInstrumentation');
    }
    expect(renderer).toContain('initializeDesktopFaro');
  });

  it('keeps source maps private and provisions the required Grafana alerts', async () => {
    const ci = await source('.github/workflows/ci.yml');
    const desktopCi = await source('.github/workflows/desktop.yml');
    const desktopForge = await source('apps/desktop/forge.config.ts');
    const alerts = await source('infra/observability/alerts.tf');
    expect(ci).toContain('faro-cli upload');
    expect(desktopCi).toContain('faro-cli upload');
    expect(desktopForge).toContain('file.endsWith(".map")');
    expect(alerts).toContain('zapp_api_server_errors_total');
    expect(alerts).toContain('unhandledRejection');
    expect(alerts).toContain('grafana_rule_group');
  });
});
