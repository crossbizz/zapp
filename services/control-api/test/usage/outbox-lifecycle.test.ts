import { describe, expect, it } from 'vitest';

import {
  createFlexpriceIngestClient,
  createUsageEventConsumer,
  createUsageEventConsumerLifecycle,
  createUsageOutboxPublisherLifecycle,
  type FlexpriceUsageEvent,
} from '../../src/usage/outbox.js';

function deferred(): {
  readonly promise: Promise<number>;
  readonly resolve: (value: number) => void;
} {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('OPS-1A production usage outbox lifecycle', () => {
  const event = {
    event_name: 'model_input_tokens',
    external_customer_id: 'org_01KZKACDW6WB86DS296R83J2BA',
    event_id: 'usage_event_1',
    timestamp: '2026-08-09T12:00:00.000Z',
    properties: {
      project_id: 'proj_01KZKACDW6WB86DS296R83J2BB',
      run_id: 'run_01KZKACDW6WB86DS296R83J2BC',
      task_id: null,
      quantity: 1000,
      unit: 'input_tokens',
      provider: 'anthropic',
    },
  } satisfies FlexpriceUsageEvent;

  it('flushes before readiness, prevents overlapping polls and drains before close', async () => {
    const first = deferred();
    const second = deferred();
    const calls: number[] = [];
    const scheduled: (() => void)[] = [];
    let cleared = false;
    const lifecycle = createUsageOutboxPublisherLifecycle({
      publisher: {
        publishOnce(limit) {
          calls.push(limit);
          return calls.length === 1 ? first.promise : second.promise;
        },
      },
      batchSize: 25,
      intervalMs: 1_000,
      timers: {
        setInterval(callback) {
          scheduled.push(callback);
          return 7;
        },
        clearInterval(handle) {
          expect(handle).toBe(7);
          cleared = true;
        },
      },
    });

    const starting = lifecycle.start();
    expect(calls).toEqual([25]);
    expect(scheduled).toEqual([]);
    first.resolve(4);
    await starting;
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    scheduled[0]?.();
    await Promise.resolve();
    expect(calls).toEqual([25, 25]);

    const closing = lifecycle.close();
    expect(cleared).toBe(true);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    second.resolve(0);
    await closing;
    expect(closed).toBe(true);
  });

  it('reports a failed background poll and continues on the next interval', async () => {
    const failures: Error[] = [];
    const scheduled: (() => void)[] = [];
    let calls = 0;
    const lifecycle = createUsageOutboxPublisherLifecycle({
      publisher: {
        publishOnce() {
          calls += 1;
          return calls === 2 ? Promise.reject(new Error('queue unavailable')) : Promise.resolve(0);
        },
      },
      batchSize: 10,
      intervalMs: 1_000,
      onError(error) {
        failures.push(error);
      },
      timers: {
        setInterval(callback) {
          scheduled.push(callback);
          return 9;
        },
        clearInterval() {},
      },
    });

    await lifecycle.start();
    scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures.map((error) => error.message)).toEqual(['queue unavailable']);
    scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(3);
    await lifecycle.close();
  });

  it('posts the strict event to the official Flexprice endpoint without exposing a failed response', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const apiKey = 'not-a-real-flexprice-key';
    const client = createFlexpriceIngestClient({
      baseUrl: 'https://api.cloud.flexprice.io/v1/',
      apiKey,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        return Promise.resolve(new Response(null, { status: 202 }));
      },
    });

    await client.ingest(event);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.cloud.flexprice.io/v1/events');
    expect(requests[0]?.init?.method).toBe('POST');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-api-key')).toBe(apiKey);
    const body = requests[0]?.init?.body;
    if (typeof body !== 'string') throw new Error('Flexprice request body was not JSON text');
    expect(JSON.parse(body)).toEqual(event);

    const rejecting = createFlexpriceIngestClient({
      baseUrl: 'https://api.cloud.flexprice.io/v1',
      apiKey,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ message: apiKey }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    await expect(rejecting.ingest(event)).rejects.toThrow(
      'Flexprice event ingestion failed with status 503',
    );
    await expect(rejecting.ingest(event)).rejects.not.toThrow(apiKey);
  });

  it('receives queue messages and deletes only those accepted by Flexprice', async () => {
    const goodBody = JSON.stringify({ outboxId: 'outbox_1', event });
    const failedEvent = { ...event, event_id: 'usage_event_failed' };
    const failedBody = JSON.stringify({ outboxId: 'outbox_2', event: failedEvent });
    const deleted: string[] = [];
    const failures: Error[] = [];
    const scheduled: (() => void)[] = [];
    const lifecycle = createUsageEventConsumerLifecycle({
      queue: {
        receive: () =>
          Promise.resolve([
            { body: goodBody, receiptHandle: 'receipt-good' },
            { body: failedBody, receiptHandle: 'receipt-failed' },
          ]),
        delete: (receiptHandle) => {
          deleted.push(receiptHandle);
          return Promise.resolve();
        },
      },
      consumer: createUsageEventConsumer({
        ingest: (received) =>
          received.event_id === failedEvent.event_id
            ? Promise.reject(new Error('Flexprice unavailable'))
            : Promise.resolve(),
      }),
      batchSize: 10,
      waitTimeSeconds: 10,
      visibilityTimeoutSeconds: 30,
      intervalMs: 1_000,
      onError(error) {
        failures.push(error);
      },
      timers: {
        setInterval(callback) {
          scheduled.push(callback);
          return 13;
        },
        clearInterval(handle) {
          expect(handle).toBe(13);
        },
      },
    });

    await lifecycle.start();
    expect(deleted).toEqual(['receipt-good']);
    expect(failures.map((failure) => failure.message)).toEqual(['Flexprice unavailable']);
    expect(scheduled).toHaveLength(1);
    await lifecycle.close();
  });
});
