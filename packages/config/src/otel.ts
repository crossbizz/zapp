import {
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { z } from 'zod';

import { SERVICE_NAMES, type ServiceName } from './service-token.js';

const DeploymentEnvironmentSchema = z.enum(['development', 'test', 'staging', 'production']);
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

const ServiceNameSchema = z.enum(SERVICE_NAMES);

const OpenTelemetryEnvironmentSchema = z
  .object({
    ZAPP_ENV: DeploymentEnvironmentSchema.optional(),
    NODE_ENV: DeploymentEnvironmentSchema.optional(),
    ZAPP_RELEASE: z.string().trim().min(1).max(200).optional(),
    GRAFANA_OTLP_ENDPOINT: z.string().url().optional(),
    GRAFANA_OTLP_TOKEN: z.string().trim().min(1).optional(),
  })
  .passthrough();

export interface OpenTelemetryConfig {
  readonly serviceName: ServiceName;
  readonly environment: DeploymentEnvironment;
  readonly stackName: 'zapp-dev' | 'zapp-staging' | 'zapp-prod';
  readonly release: string | undefined;
  readonly exportEnabled: boolean;
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly signalEndpoints: {
    readonly traces: string;
    readonly metrics: string;
    readonly logs: string;
  } | null;
  /** Export credentials. Never log or serialize this object. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface PublicOpenTelemetryConfig {
  readonly serviceName: ServiceName;
  readonly environment: DeploymentEnvironment;
  readonly stackName: OpenTelemetryConfig['stackName'];
  readonly release: string | undefined;
  readonly exportEnabled: boolean;
  readonly resourceAttributes: OpenTelemetryConfig['resourceAttributes'];
  readonly signalEndpoints: OpenTelemetryConfig['signalEndpoints'];
}

function deploymentStack(environment: DeploymentEnvironment): OpenTelemetryConfig['stackName'] {
  if (environment === 'production') return 'zapp-prod';
  if (environment === 'staging') return 'zapp-staging';
  return 'zapp-dev';
}

function signalEndpoints(endpoint: string): NonNullable<OpenTelemetryConfig['signalEndpoints']> {
  const root = endpoint.replace(/\/+$/u, '');
  return {
    traces: `${root}/v1/traces`,
    metrics: `${root}/v1/metrics`,
    logs: `${root}/v1/logs`,
  };
}

/**
 * Builds one validated exporter configuration for every service. Production
 * fails closed: a process must never appear healthy while silently dropping
 * all three telemetry signals.
 */
export function buildOpenTelemetryConfig(input: {
  readonly serviceName: ServiceName;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): OpenTelemetryConfig {
  const serviceName = ServiceNameSchema.parse(input.serviceName);
  const parsed = OpenTelemetryEnvironmentSchema.parse(input.env ?? process.env);
  const environment = parsed.ZAPP_ENV ?? parsed.NODE_ENV ?? 'development';
  const endpoint = parsed.GRAFANA_OTLP_ENDPOINT;
  const token = parsed.GRAFANA_OTLP_TOKEN;

  if ((endpoint === undefined) !== (token === undefined)) {
    throw new Error(
      endpoint === undefined
        ? 'GRAFANA_OTLP_ENDPOINT is required when GRAFANA_OTLP_TOKEN is set'
        : 'GRAFANA_OTLP_TOKEN is required when GRAFANA_OTLP_ENDPOINT is set',
    );
  }
  if (environment === 'production' && endpoint === undefined) {
    throw new Error('Grafana OTLP export is required in production');
  }

  const stackName = deploymentStack(environment);
  const release = parsed.ZAPP_RELEASE;
  const resourceAttributes = {
    'service.name': serviceName,
    'deployment.environment.name': environment,
    'zapp.grafana.stack': stackName,
    ...(release === undefined ? {} : { 'service.version': release }),
  };

  return {
    serviceName,
    environment,
    stackName,
    release,
    exportEnabled: endpoint !== undefined,
    resourceAttributes,
    signalEndpoints: endpoint === undefined ? null : signalEndpoints(endpoint),
    headers: token === undefined ? {} : { authorization: `Basic ${token}` },
  };
}

/** A safe projection for startup logs and health diagnostics. */
export function publicOpenTelemetryConfig(config: OpenTelemetryConfig): PublicOpenTelemetryConfig {
  return {
    serviceName: config.serviceName,
    environment: config.environment,
    stackName: config.stackName,
    release: config.release,
    exportEnabled: config.exportEnabled,
    resourceAttributes: config.resourceAttributes,
    signalEndpoints: config.signalEndpoints,
  };
}

export const OBSERVABILITY_METRICS = {
  apiDuration: { name: 'zapp.api.server.duration', kind: 'histogram', unit: 'ms' },
  apiErrors: { name: 'zapp.api.server.errors', kind: 'counter', unit: '{error}' },
  temporalWorkflowDuration: {
    name: 'zapp.temporal.workflow.duration',
    kind: 'histogram',
    unit: 'ms',
  },
  temporalWorkflowFailures: {
    name: 'zapp.temporal.workflow.failures',
    kind: 'counter',
    unit: '{failure}',
  },
  temporalActivityDuration: {
    name: 'zapp.temporal.activity.duration',
    kind: 'histogram',
    unit: 'ms',
  },
  temporalActivityFailures: {
    name: 'zapp.temporal.activity.failures',
    kind: 'counter',
    unit: '{failure}',
  },
  agentStepDuration: { name: 'zapp.agent.step.duration', kind: 'histogram', unit: 'ms' },
  agentToolDuration: { name: 'zapp.agent.tool.duration', kind: 'histogram', unit: 'ms' },
  modelDuration: { name: 'zapp.model.request.duration', kind: 'histogram', unit: 'ms' },
  modelTokens: { name: 'zapp.model.tokens', kind: 'counter', unit: '{token}' },
  modelCost: { name: 'zapp.model.cost', kind: 'counter', unit: 'USD' },
  sandboxLifecycleDuration: {
    name: 'zapp.sandbox.lifecycle.duration',
    kind: 'histogram',
    unit: 'ms',
  },
  previewReadiness: { name: 'zapp.preview.readiness.duration', kind: 'histogram', unit: 'ms' },
  deploymentDuration: { name: 'zapp.deployment.duration', kind: 'histogram', unit: 'ms' },
  deploymentSuccesses: {
    name: 'zapp.deployment.successes',
    kind: 'counter',
    unit: '{deployment}',
  },
  queueDelay: { name: 'zapp.queue.delay', kind: 'histogram', unit: 'ms' },
  eventStreamLag: { name: 'zapp.event_stream.sequence_age', kind: 'gauge', unit: 'ms' },
} as const;

export type ObservabilityMetric = keyof typeof OBSERVABILITY_METRICS;

const SAFE_ATTRIBUTE_KEYS = new Set([
  'deployment.environment.name',
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'model',
  'operation',
  'outcome',
  'provider',
  'queue',
  'service.name',
  'zapp.organization.id',
  'zapp.project.id',
  'zapp.release.id',
  'zapp.run.id',
  'zapp.sandbox.id',
  'zapp.task.id',
  'zapp.tool.name',
  'zapp.workflow.name',
]);

/** Drops anything outside the reviewed tenant-safe attribute vocabulary. */
export function tenantSafeTelemetryAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]) =>
        SAFE_ATTRIBUTE_KEYS.has(key) &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          (Array.isArray(value) &&
            value.every(
              (item) =>
                typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
            ))),
    ),
  ) as Attributes;
}

interface MetricRecorder {
  record(value: number, attributes?: Attributes): void;
}

interface CounterRecorder {
  add(value: number, attributes?: Attributes): void;
}

export interface ObservabilityInstruments {
  record(metric: ObservabilityMetric, value: number, attributes?: Record<string, unknown>): void;
}

export interface ObservabilitySpan {
  end(outcome: 'ok' | 'error'): void;
}

export function startObservabilitySpan(
  name: string,
  attributes: Readonly<Record<string, unknown>> = {},
): ObservabilitySpan {
  const span = trace.getTracer('@zapp/platform').startSpan(name, {
    attributes: tenantSafeTelemetryAttributes(attributes),
  });
  let ended = false;
  return {
    end(outcome) {
      if (ended) return;
      ended = true;
      span.setStatus(
        outcome === 'ok'
          ? { code: SpanStatusCode.OK }
          : { code: SpanStatusCode.ERROR, message: 'operation failed' },
      );
      span.end();
    },
  };
}

export async function withObservabilitySpan<T>(
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  operation: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('@zapp/platform');
  return tracer.startActiveSpan(
    name,
    { attributes: tenantSafeTelemetryAttributes(attributes) },
    async (span) => {
      try {
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'operation failed' });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function createObservabilityInstruments(
  meter: Meter = metrics.getMeter('@zapp/platform'),
): ObservabilityInstruments {
  const instruments = Object.fromEntries(
    Object.entries(OBSERVABILITY_METRICS).map(([key, definition]) => [
      key,
      definition.kind === 'counter'
        ? meter.createCounter(definition.name, { unit: definition.unit })
        : definition.kind === 'gauge'
          ? meter.createGauge(definition.name, { unit: definition.unit })
          : meter.createHistogram(definition.name, { unit: definition.unit }),
    ]),
  ) as Record<ObservabilityMetric, MetricRecorder | CounterRecorder>;

  return {
    record(metric, value, attributes = {}) {
      try {
        const instrument = instruments[metric];
        const safe = tenantSafeTelemetryAttributes(attributes);
        if ('add' in instrument) instrument.add(value, safe);
        else instrument.record(value, safe);
      } catch {
        // Telemetry is observational and must never alter a platform outcome.
      }
    },
  };
}

export interface HttpServerTelemetryFinish {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly runId?: string;
}

export interface HttpServerTelemetry {
  start(request: object): void;
  finish(request: object, result: HttpServerTelemetryFinish): void;
}

/** Framework-neutral hooks used by every Fastify service. */
export function createHttpServerTelemetry(
  options: {
    readonly instruments?: ObservabilityInstruments;
    readonly now?: () => number;
  } = {},
): HttpServerTelemetry {
  const instruments = options.instruments ?? createObservabilityInstruments();
  const now = options.now ?? performance.now.bind(performance);
  const starts = new WeakMap<object, number>();

  return {
    start(request) {
      starts.set(request, now());
    },
    finish(request, result) {
      const startedAt = starts.get(request);
      starts.delete(request);
      if (startedAt === undefined) return;
      const attributes = {
        'http.request.method': result.method,
        'http.response.status_code': result.statusCode,
        'http.route': result.route,
        ...(result.organizationId === undefined
          ? {}
          : { 'zapp.organization.id': result.organizationId }),
        ...(result.projectId === undefined ? {} : { 'zapp.project.id': result.projectId }),
        ...(result.runId === undefined ? {} : { 'zapp.run.id': result.runId }),
      };
      instruments.record('apiDuration', Math.max(0, now() - startedAt), attributes);
      if (result.statusCode >= 500) instruments.record('apiErrors', 1, attributes);
    },
  };
}

function spanDurationMs(span: ReadableSpan): number {
  return span.duration[0] * 1_000 + span.duration[1] / 1_000_000;
}

function operationAfter(name: string, prefix: string): string {
  const operation = name.slice(prefix.length).replace(/^[: ]+/u, '');
  return operation === '' ? 'unknown' : operation.slice(0, 200);
}

/** Derives stable metrics from the spans emitted by Temporal and zapp domains. */
export function createSpanMetricsProcessor(instruments: ObservabilityInstruments): SpanProcessor {
  return {
    onStart() {},
    onEnd(span: ReadableSpan) {
      const duration = spanDurationMs(span);
      if (span.name.startsWith('RunWorkflow')) {
        const attributes = { operation: operationAfter(span.name, 'RunWorkflow') };
        instruments.record('temporalWorkflowDuration', duration, attributes);
        if (span.status.code === SpanStatusCode.ERROR) {
          instruments.record('temporalWorkflowFailures', 1, attributes);
        }
        if (attributes.operation === 'deployWorkflow') {
          instruments.record('deploymentDuration', duration, attributes);
          if (span.status.code !== SpanStatusCode.ERROR) {
            instruments.record('deploymentSuccesses', 1, attributes);
          }
        }
        return;
      }
      if (span.name.startsWith('RunActivity')) {
        const attributes = { operation: operationAfter(span.name, 'RunActivity') };
        instruments.record('temporalActivityDuration', duration, attributes);
        if (span.status.code === SpanStatusCode.ERROR) {
          instruments.record('temporalActivityFailures', 1, attributes);
        }
        return;
      }
      if (span.name.startsWith('agent.step')) {
        instruments.record('agentStepDuration', duration, {
          operation: operationAfter(span.name, 'agent.step'),
        });
        return;
      }
      if (span.name.startsWith('agent.tool')) {
        instruments.record('agentToolDuration', duration, {
          operation: operationAfter(span.name, 'agent.tool'),
        });
        return;
      }
      if (span.name === 'model.completion.attempt') {
        const attributes = {
          ...(typeof span.attributes['gen_ai.provider.name'] === 'string'
            ? { provider: span.attributes['gen_ai.provider.name'] }
            : {}),
          ...(typeof span.attributes['gen_ai.request.model'] === 'string'
            ? { model: span.attributes['gen_ai.request.model'] }
            : {}),
        };
        instruments.record('modelDuration', duration, attributes);
        const inputTokens = span.attributes['gen_ai.usage.input_tokens'];
        const outputTokens = span.attributes['gen_ai.usage.output_tokens'];
        if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
          instruments.record(
            'modelTokens',
            (typeof inputTokens === 'number' ? inputTokens : 0) +
              (typeof outputTokens === 'number' ? outputTokens : 0),
            attributes,
          );
        }
        return;
      }
      if (span.name.startsWith('sandbox.lifecycle')) {
        instruments.record('sandboxLifecycleDuration', duration, {
          operation: operationAfter(span.name, 'sandbox.lifecycle'),
        });
      } else if (span.name.startsWith('preview.readiness')) {
        instruments.record('previewReadiness', duration, {
          operation: operationAfter(span.name, 'preview.readiness'),
        });
      } else if (span.name.startsWith('deployment')) {
        const attributes = { operation: operationAfter(span.name, 'deployment') };
        instruments.record('deploymentDuration', duration, attributes);
        if (span.status.code !== SpanStatusCode.ERROR) {
          instruments.record('deploymentSuccesses', 1, attributes);
        }
      } else if (span.name.startsWith('queue.delivery')) {
        instruments.record('queueDelay', duration, {
          operation: operationAfter(span.name, 'queue.delivery'),
        });
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function compositeSpanProcessor(processors: readonly SpanProcessor[]): SpanProcessor {
  return {
    onStart(span, parentContext) {
      for (const processor of processors) processor.onStart(span, parentContext);
    },
    onEnd(span) {
      for (const processor of processors) processor.onEnd(span);
    },
    async forceFlush() {
      await Promise.all(processors.map((processor) => processor.forceFlush()));
    },
    async shutdown() {
      await Promise.all(processors.map((processor) => processor.shutdown()));
    },
  };
}

export interface OpenTelemetryRuntime {
  readonly config: PublicOpenTelemetryConfig;
  readonly tracer: Tracer;
  readonly instruments: ObservabilityInstruments;
  readonly resource: Resource;
  readonly spanProcessor: SpanProcessor;
  shutdown(): Promise<void>;
}

/** Starts traces, metrics, logs, and automatic Node instrumentation as one unit. */
export function startOpenTelemetry(config: OpenTelemetryConfig): OpenTelemetryRuntime {
  const resource = resourceFromAttributes(config.resourceAttributes);
  const instruments = createObservabilityInstruments();
  const exportSpanProcessor =
    config.signalEndpoints === null
      ? undefined
      : new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: config.signalEndpoints.traces,
            headers: config.headers,
          }),
        );
  const spanProcessor = compositeSpanProcessor([
    createSpanMetricsProcessor(instruments),
    ...(exportSpanProcessor === undefined ? [] : [exportSpanProcessor]),
  ]);
  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
    ...(config.signalEndpoints === null
      ? {}
      : {
          metricReaders: [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                url: config.signalEndpoints.metrics,
                headers: config.headers,
              }),
            }),
          ],
          logRecordProcessors: [
            new BatchLogRecordProcessor({
              exporter: new OTLPLogExporter({
                url: config.signalEndpoints.logs,
                headers: config.headers,
              }),
            }),
          ],
        }),
  });
  sdk.start();

  return {
    config: publicOpenTelemetryConfig(config),
    tracer: trace.getTracer(`@zapp/${config.serviceName}`, config.release),
    instruments,
    resource,
    spanProcessor,
    shutdown: () => sdk.shutdown(),
  };
}

const startedRuntimes = new Map<ServiceName, OpenTelemetryRuntime>();

export function startOpenTelemetryFromEnv(input: {
  readonly serviceName: ServiceName;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): OpenTelemetryRuntime {
  const existing = startedRuntimes.get(input.serviceName);
  if (existing !== undefined) return existing;
  const runtime = startOpenTelemetry(buildOpenTelemetryConfig(input));
  startedRuntimes.set(input.serviceName, runtime);
  return runtime;
}

export function getOpenTelemetryRuntime(
  serviceName: ServiceName,
): OpenTelemetryRuntime | undefined {
  return startedRuntimes.get(serviceName);
}
