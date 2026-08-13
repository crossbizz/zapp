import { describe, expect, it } from 'vitest';

import {
  OBSERVABILITY_METRICS,
  buildOpenTelemetryConfig,
  createHttpServerTelemetry,
  createObservabilityInstruments,
  createSpanMetricsProcessor,
  publicOpenTelemetryConfig,
  tenantSafeTelemetryAttributes,
} from '../src/otel.js';

describe('shared OpenTelemetry configuration', () => {
  it('maps each deployment environment to its isolated Grafana stack and resource attributes', () => {
    const config = buildOpenTelemetryConfig({
      serviceName: 'control-api',
      env: {
        ZAPP_ENV: 'staging',
        ZAPP_RELEASE: '4f4f4f4',
        GRAFANA_OTLP_ENDPOINT: 'https://otlp.example.test/otlp/',
        GRAFANA_OTLP_TOKEN: 'encoded-account-and-token',
      },
    });

    expect(config.stackName).toBe('zapp-staging');
    expect(config.resourceAttributes).toEqual({
      'deployment.environment.name': 'staging',
      'service.name': 'control-api',
      'service.version': '4f4f4f4',
      'zapp.grafana.stack': 'zapp-staging',
    });
    expect(config.signalEndpoints).toEqual({
      logs: 'https://otlp.example.test/otlp/v1/logs',
      metrics: 'https://otlp.example.test/otlp/v1/metrics',
      traces: 'https://otlp.example.test/otlp/v1/traces',
    });
    expect(config.headers).toEqual({ authorization: 'Basic encoded-account-and-token' });
    expect(publicOpenTelemetryConfig(config)).not.toHaveProperty('headers');
    expect(JSON.stringify(publicOpenTelemetryConfig(config))).not.toContain(
      'encoded-account-and-token',
    );
  });

  it('fails closed when production has only half of the Grafana credential pair', () => {
    expect(() =>
      buildOpenTelemetryConfig({
        serviceName: 'release-service',
        env: {
          ZAPP_ENV: 'production',
          GRAFANA_OTLP_ENDPOINT: 'https://otlp.example.test/otlp',
        },
      }),
    ).toThrow(/GRAFANA_OTLP_TOKEN/u);

    expect(() =>
      buildOpenTelemetryConfig({
        serviceName: 'release-service',
        env: { ZAPP_ENV: 'production' },
      }),
    ).toThrow(/Grafana OTLP export is required/u);
  });

  it('keeps local and test processes observable without requiring cloud credentials', () => {
    const config = buildOpenTelemetryConfig({
      serviceName: 'sandbox-service',
      env: { ZAPP_ENV: 'test' },
    });

    expect(config.exportEnabled).toBe(false);
    expect(config.stackName).toBe('zapp-dev');
    expect(config.signalEndpoints).toBeNull();
  });

  it('defines every metric required by PRD 29.1 as a stable code-owned catalog', () => {
    expect(Object.keys(OBSERVABILITY_METRICS).sort()).toEqual([
      'agentStepDuration',
      'agentToolDuration',
      'apiDuration',
      'apiErrors',
      'deploymentDuration',
      'deploymentSuccesses',
      'eventStreamLag',
      'modelCost',
      'modelDuration',
      'modelTokens',
      'previewReadiness',
      'queueDelay',
      'sandboxLifecycleDuration',
      'temporalActivityDuration',
      'temporalActivityFailures',
      'temporalWorkflowDuration',
      'temporalWorkflowFailures',
    ]);
    expect(new Set(Object.values(OBSERVABILITY_METRICS).map(({ name }) => name)).size).toBe(
      Object.keys(OBSERVABILITY_METRICS).length,
    );
  });

  it('records route latency and one error with only tenant-safe dimensions', () => {
    const calls: unknown[] = [];
    let now = 1_000;
    const telemetry = createHttpServerTelemetry({
      now: () => now,
      instruments: {
        record: (metric, value, attributes) => calls.push({ metric, value, attributes }),
      },
    });
    const request = {};

    telemetry.start(request);
    now = 1_037;
    telemetry.finish(request, {
      method: 'POST',
      route: '/v1/projects/:projectId/runs',
      statusCode: 503,
      organizationId: 'org_01J00000000000000000000000',
      projectId: 'proj_01J00000000000000000000000',
    });

    expect(calls).toEqual([
      {
        metric: 'apiDuration',
        value: 37,
        attributes: {
          'http.request.method': 'POST',
          'http.response.status_code': 503,
          'http.route': '/v1/projects/:projectId/runs',
          'zapp.organization.id': 'org_01J00000000000000000000000',
          'zapp.project.id': 'proj_01J00000000000000000000000',
        },
      },
      {
        metric: 'apiErrors',
        value: 1,
        attributes: {
          'http.request.method': 'POST',
          'http.response.status_code': 503,
          'http.route': '/v1/projects/:projectId/runs',
          'zapp.organization.id': 'org_01J00000000000000000000000',
          'zapp.project.id': 'proj_01J00000000000000000000000',
        },
      },
    ]);
  });

  it('drops content and identity attributes outside the reviewed telemetry vocabulary', () => {
    expect(
      tenantSafeTelemetryAttributes({
        'zapp.organization.id': 'org_01J00000000000000000000000',
        email: 'person@example.test',
        prompt: 'make a payroll app',
        code: 'const secret = 1',
        secretName: 'DATABASE_URL',
      }),
    ).toEqual({ 'zapp.organization.id': 'org_01J00000000000000000000000' });
  });

  it('never lets a broken metric provider alter a platform operation', () => {
    const brokenMeter = {
      createCounter: () => ({
        add: () => {
          throw new Error('collector failed');
        },
      }),
      createGauge: () => ({
        record: () => {
          throw new Error('collector failed');
        },
      }),
      createHistogram: () => ({
        record: () => {
          throw new Error('collector failed');
        },
      }),
    };
    const instruments = createObservabilityInstruments(brokenMeter as never);

    expect(() => {
      instruments.record('modelCost', 0.001, { provider: 'anthropic' });
    }).not.toThrow();
    expect(() => {
      instruments.record('apiDuration', 10, { operation: 'request' });
    }).not.toThrow();
  });

  it('turns Temporal interceptor spans into workflow/activity latency and failure metrics', () => {
    const calls: unknown[] = [];
    const processor = createSpanMetricsProcessor({
      record: (metric, value, attributes) => calls.push({ metric, value, attributes }),
    });

    processor.onEnd({
      name: 'RunActivity:executeWorkspaceTask',
      duration: [0, 42_000_000],
      status: { code: 2 },
      attributes: { prompt: 'customer content' },
    } as never);

    expect(calls).toEqual([
      {
        metric: 'temporalActivityDuration',
        value: 42,
        attributes: { operation: 'executeWorkspaceTask' },
      },
      {
        metric: 'temporalActivityFailures',
        value: 1,
        attributes: { operation: 'executeWorkspaceTask' },
      },
    ]);
  });

  it('derives a successful deployment metric from the durable deploy workflow span', () => {
    const calls: unknown[] = [];
    const processor = createSpanMetricsProcessor({
      record: (metric, value, attributes) => calls.push({ metric, value, attributes }),
    });

    processor.onEnd({
      name: 'RunWorkflow:deployWorkflow',
      duration: [2, 500_000_000],
      status: { code: 1 },
      attributes: {},
    } as never);

    expect(calls).toEqual([
      {
        metric: 'temporalWorkflowDuration',
        value: 2_500,
        attributes: { operation: 'deployWorkflow' },
      },
      {
        metric: 'deploymentDuration',
        value: 2_500,
        attributes: { operation: 'deployWorkflow' },
      },
      {
        metric: 'deploymentSuccesses',
        value: 1,
        attributes: { operation: 'deployWorkflow' },
      },
    ]);
  });
});
