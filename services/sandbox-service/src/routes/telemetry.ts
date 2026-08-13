import { createHash, timingSafeEqual } from 'node:crypto';

import { buildOpenTelemetryConfig } from '@zapp/config';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const MetricPointSchema = z
  .object({
    asDouble: z.number().finite(),
    timeUnixNano: z.string().regex(/^\d{16,20}$/u),
  })
  .strict();
const GaugeSchema = z.object({ dataPoints: z.array(MetricPointSchema).length(1) }).strict();
const SandboxMetricSchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('zapp.sandbox.active_children'),
      gauge: GaugeSchema,
    })
    .strict(),
  z
    .object({
      name: z.enum(['zapp.sandbox.cpu.user', 'zapp.sandbox.cpu.system']),
      unit: z.literal('us'),
      gauge: GaugeSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal('zapp.sandbox.memory.rss'),
      unit: z.literal('By'),
      gauge: GaugeSchema,
    })
    .strict(),
]);
const OtlpMetricsPayloadSchema = z
  .object({
    resourceMetrics: z
      .array(
        z
          .object({
            resource: z
              .object({
                attributes: z
                  .array(
                    z
                      .object({
                        key: z.literal('service.name'),
                        value: z
                          .object({ stringValue: z.literal('zapp-workspace-agent') })
                          .strict(),
                      })
                      .strict(),
                  )
                  .length(1),
              })
              .strict(),
            scopeMetrics: z
              .array(
                z
                  .object({
                    scope: z.object({ name: z.literal('zapp.sandbox.telemetry-relay') }).strict(),
                    metrics: z
                      .array(SandboxMetricSchema)
                      .length(4)
                      .refine(
                        (metrics) =>
                          new Set(metrics.map(({ name }) => name)).size === metrics.length,
                        'Sandbox metric names must be unique',
                      ),
                  })
                  .strict(),
              )
              .length(1),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

const AcceptedResponseSchema = z.object({ accepted: z.literal(true) }).strict();
const ErrorResponseSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict();

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return token === '' ? undefined : token;
}

export interface SandboxTelemetryRelay {
  authorized(token: string | undefined): boolean;
  forwardMetrics(payload: z.infer<typeof OtlpMetricsPayloadSchema>): Promise<void>;
}

export function createGrafanaSandboxTelemetryRelay(options: {
  readonly agentToken: string;
  readonly metricsEndpoint: string;
  readonly grafanaHeaders: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}): SandboxTelemetryRelay {
  const expectedDigest = digest(z.string().min(16).parse(options.agentToken));
  const endpoint = z.string().url().parse(options.metricsEndpoint);
  const fetch = options.fetch ?? globalThis.fetch;

  return {
    authorized(token) {
      return token !== undefined && timingSafeEqual(expectedDigest, digest(token));
    },
    async forwardMetrics(payload) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...options.grafanaHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(OtlpMetricsPayloadSchema.parse(payload)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Grafana OTLP metrics export failed');
    },
  };
}

/** Builds the relay from service-held credentials, never sandbox environment variables. */
export function createGrafanaSandboxTelemetryRelayFromEnv(input: {
  readonly agentToken: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}): SandboxTelemetryRelay {
  const config = buildOpenTelemetryConfig({
    serviceName: 'sandbox-service',
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  if (config.signalEndpoints === null) {
    throw new Error('Sandbox telemetry relay requires Grafana OTLP export configuration');
  }
  return createGrafanaSandboxTelemetryRelay({
    agentToken: input.agentToken,
    metricsEndpoint: config.signalEndpoints.metrics,
    grafanaHeaders: config.headers,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
}

export function registerSandboxTelemetryRoute(
  app: FastifyInstance,
  options: { readonly relay: SandboxTelemetryRelay },
): void {
  app.post(
    '/v1/telemetry',
    {
      bodyLimit: 512 * 1024,
      schema: {
        response: {
          202: AcceptedResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.relay.authorized(bearerToken(request.headers.authorization))) {
        return reply.status(401).send({
          code: 'telemetry_unauthorized',
          message: 'A valid sandbox telemetry capability is required.',
        });
      }
      const parsed = OtlpMetricsPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'invalid_telemetry',
          message: 'The telemetry payload is invalid.',
        });
      }
      try {
        await options.relay.forwardMetrics(parsed.data);
        return await reply.status(202).send({ accepted: true });
      } catch {
        return reply.status(503).send({
          code: 'telemetry_unavailable',
          message: 'The telemetry collector is unavailable.',
        });
      }
    },
  );
}
