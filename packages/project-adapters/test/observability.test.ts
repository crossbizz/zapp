import { readFile } from 'node:fs/promises';

import type { ProjectContext } from '@zapp/contracts';
import { describe, expect, test } from 'vitest';

import { frameworkAdapters } from '../src/frameworks.js';
import { genericNodeAdapter } from '../src/generic-node.js';

function context(input: {
  readonly adapterId: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}): ProjectContext {
  const contents: Readonly<Record<string, string>> = {
    'package.json': JSON.stringify({ dependencies: input.dependencies ?? {} }),
    ...(input.files ?? {}),
  };
  return {
    workspaceRoot: '.',
    detection: {
      adapterId: input.adapterId,
      confidence: 1,
      evidence: ['package.json'],
    },
    listFiles: () => Promise.resolve(Object.keys(contents)),
    readFile: (path) => {
      const value = contents[path];
      return value === undefined
        ? Promise.reject(new Error(`missing_fixture_file:${path}`))
        : Promise.resolve(value);
    },
  };
}

describe('OPS-10 managed-app instrumentation plans', () => {
  test.each([...frameworkAdapters, genericNodeAdapter])(
    '$id proposes every Managed observability capability as a visible agent task',
    async (adapter) => {
      const plan = await adapter.proposeInstrumentation(context({ adapterId: adapter.id }));

      expect(plan.steps.map(({ id, capability, alreadyPresent }) => ({ id, capability, alreadyPresent })))
        .toEqual([
          { id: 'managed-faro-web', capability: 'frontend_errors', alreadyPresent: false },
          { id: 'managed-otel-node', capability: 'backend_tracing', alreadyPresent: false },
          { id: 'managed-structured-logging', capability: 'structured_logging', alreadyPresent: false },
          { id: 'managed-health-endpoint', capability: 'health_endpoint', alreadyPresent: false },
        ]);
      expect(plan.steps.map(({ rationale }) => rationale)).toEqual([
        expect.stringMatching(/faro-web\.ts\.hbs.*web vitals.*per-project Faro/u),
        expect.stringMatching(/otel-node\.ts\.hbs.*per-project scoped OTLP token/u),
        expect.stringMatching(/logging\.ts\.hbs.*structured/u),
        expect.stringMatching(/health-endpoint\.ts\.hbs.*\/api\/health/u),
      ]);
    },
  );

  test('uses adapter-specific health routes and detects installed capabilities from source plus dependencies', async () => {
    const adapter = frameworkAdapters.find(({ id }) => id === 'next');
    if (adapter === undefined) throw new Error('next_adapter_missing');
    const project = context({
      adapterId: 'next',
      dependencies: {
        '@grafana/faro-web-sdk': 'latest',
        '@opentelemetry/sdk-node': 'latest',
        pino: 'latest',
      },
      files: {
        'src/observability/faro-web.ts':
          'getWebInstrumentations(); initializeFaro({ url: ZAPP_PROJECT_FARO_URL, app: { name: ZAPP_PROJECT_ID, version: ZAPP_RELEASE } });',
        'src/observability/otel-node.ts':
          'const sdk = new NodeSDK({ ZAPP_PROJECT_OTLP_ENDPOINT, ZAPP_PROJECT_OTLP_TOKEN, ZAPP_PROJECT_ID });',
        'src/observability/logging.ts':
          "export const logger = pino({ traceId: 'trace', redact: '[secret:redacted]' });",
        'app/api/health/route.ts':
          'export function GET() { return Response.json({ status: "ok", release: ZAPP_RELEASE }); }',
      },
    });

    await expect(adapter.proposeInstrumentation(project)).resolves.toEqual({
      steps: [
        expect.objectContaining({
          id: 'managed-faro-web',
          targetPath: 'src/observability/faro-web.ts',
          alreadyPresent: true,
        }),
        expect.objectContaining({
          id: 'managed-otel-node',
          targetPath: 'src/observability/otel-node.ts',
          alreadyPresent: true,
        }),
        expect.objectContaining({
          id: 'managed-structured-logging',
          targetPath: 'src/observability/logging.ts',
          alreadyPresent: true,
        }),
        expect.objectContaining({
          id: 'managed-health-endpoint',
          targetPath: 'app/api/health/route.ts',
          alreadyPresent: true,
        }),
      ],
    });
  });

  test('ships templates with release wiring and project-isolated collector configuration', async () => {
    const template = async (name: string) =>
      await readFile(new URL(`../../../templates/observability/${name}.ts.hbs`, import.meta.url), 'utf8');
    const [faro, otel, logging, health] = await Promise.all([
      template('faro-web'),
      template('otel-node'),
      template('logging'),
      template('health-endpoint'),
    ]);

    expect(faro).toContain("from '@grafana/faro-web-sdk'");
    expect(faro).toContain('getWebInstrumentations');
    expect(faro).toContain('ZAPP_PROJECT_FARO_URL');
    expect(faro).toContain('ZAPP_PROJECT_ID');
    expect(faro).toContain('ZAPP_RELEASE');
    expect(otel).toContain("from '@opentelemetry/sdk-node'");
    expect(otel).toContain('ZAPP_PROJECT_OTLP_TOKEN');
    expect(otel).toContain('ZAPP_PROJECT_OTLP_ENDPOINT');
    expect(otel).toContain("'zapp.project.id'");
    expect(logging).toContain("from 'pino'");
    expect(logging).toContain('[secret:');
    expect(health).toContain("status: 'ok'");
    expect(health).toContain('release: process.env.ZAPP_RELEASE');
  });
});
