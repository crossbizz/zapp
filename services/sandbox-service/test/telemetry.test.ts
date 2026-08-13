import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

import {
  createGrafanaSandboxTelemetryRelay,
  registerSandboxTelemetryRoute,
} from '../src/routes/telemetry.js';

const AGENT_TOKEN = 'sandbox-only-agent-capability';
const GRAFANA_TOKEN = 'encoded-grafana-account-and-token';

function payload() {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'zapp-workspace-agent' } }],
        },
        scopeMetrics: [
          {
            scope: { name: 'zapp.sandbox.telemetry-relay' },
            metrics: [
              {
                name: 'zapp.sandbox.active_children',
                gauge: { dataPoints: [{ asDouble: 2, timeUnixNano: '1786500000000000000' }] },
              },
              {
                name: 'zapp.sandbox.cpu.user',
                unit: 'us',
                gauge: { dataPoints: [{ asDouble: 20, timeUnixNano: '1786500000000000000' }] },
              },
              {
                name: 'zapp.sandbox.cpu.system',
                unit: 'us',
                gauge: { dataPoints: [{ asDouble: 10, timeUnixNano: '1786500000000000000' }] },
              },
              {
                name: 'zapp.sandbox.memory.rss',
                unit: 'By',
                gauge: { dataPoints: [{ asDouble: 1024, timeUnixNano: '1786500000000000000' }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('sandbox telemetry collector relay', () => {
  it('requires the sandbox-only capability and forwards with server-held Grafana credentials', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerSandboxTelemetryRoute(app, {
      relay: createGrafanaSandboxTelemetryRelay({
        agentToken: AGENT_TOKEN,
        metricsEndpoint: 'https://otlp.example.test/otlp/v1/metrics',
        grafanaHeaders: { authorization: `Basic ${GRAFANA_TOKEN}` },
        fetch,
      }),
    });

    const missing = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: payload() });
    expect(missing.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: payload(),
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://otlp.example.test/otlp/v1/metrics',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: `Basic ${GRAFANA_TOKEN}`,
          'content-type': 'application/json',
        },
      }),
    );
    expect(JSON.stringify(accepted.json())).not.toContain(GRAFANA_TOKEN);
    await app.close();
  });

  it('rejects malformed or oversized OTLP JSON without forwarding it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerSandboxTelemetryRoute(app, {
      relay: createGrafanaSandboxTelemetryRelay({
        agentToken: AGENT_TOKEN,
        metricsEndpoint: 'https://otlp.example.test/otlp/v1/metrics',
        grafanaHeaders: { authorization: `Basic ${GRAFANA_TOKEN}` },
        fetch,
      }),
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { arbitrary: 'customer data' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();

    const secretAttribute = payload();
    const resourceMetric = secretAttribute.resourceMetrics[0];
    expect(resourceMetric).toBeDefined();
    if (resourceMetric === undefined) throw new Error('expected one resource metric');
    resourceMetric.resource.attributes.push({
      key: 'prompt',
      value: { stringValue: 'customer source and secret' },
    });
    const secretBearing = await app.inject({
      method: 'POST',
      url: '/v1/telemetry',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: secretAttribute,
    });
    expect(secretBearing.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    await app.close();
  });
});
