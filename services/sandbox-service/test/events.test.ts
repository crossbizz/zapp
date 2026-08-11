import { createServiceTokenSigner } from '@zapp/config';
import { describe, expect, it, vi } from 'vitest';

import { createControlPlanePreviewEventClient } from '../src/events/client.js';

const SERVICE_SECRET = 's'.repeat(32);
const EVENT = {
  eventKey: 'ws13:op_event:start:preview.ready',
  organizationId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA',
  projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB',
  runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
  taskId: 'task_01J8ME7YQZJ2V9Q0X3T5B6K7NE',
  occurredAt: '2026-08-09T12:00:00.000Z',
  type: 'preview.ready' as const,
  visibility: 'user' as const,
  payload: {
    workspaceId: 'ws_01J8ME7YQZJ2V9Q0X3T5B6K7NF',
    action: 'start' as const,
    port: 4_173,
    supervisorId: 'preview-supervisor-event-test',
  },
};

describe('WS-13 control-plane preview event client', () => {
  it('publishes through CP-13 with sandbox identity and the stable event key', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const fetch = vi.fn((input: string, init: RequestInit) => {
      requests.push({ input, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            events: [
              {
                id: 'evt_01J8ME7YQZJ2V9Q0X3T5B6K7NZ',
                sequence: 7,
                ...EVENT,
                eventKey: undefined,
              },
            ],
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const client = createControlPlanePreviewEventClient({
      baseUrl: 'https://control.test',
      serviceTokens: { secret: SERVICE_SECRET },
      fetch,
    });

    await client.emit(EVENT);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.input).toBe(`https://control.test/internal/runs/${EVENT.runId}/events`);
    const headers = new Headers(request?.init.headers);
    expect(headers.get('idempotency-key')).toBe(EVENT.eventKey);
    const token = headers.get('x-zapp-service-token');
    expect(token).toBeTruthy();
    const verdict = await createServiceTokenSigner({ secret: SERVICE_SECRET }).verifyServiceToken(
      token ?? '',
      'control-api:events.ingest',
    );
    expect(verdict).toMatchObject({
      ok: true,
      claims: { service: 'sandbox-service', audience: 'control-api:events.ingest' },
    });
    const requestBody = request?.init.body;
    expect(typeof requestBody).toBe('string');
    if (typeof requestBody !== 'string') throw new Error('Expected JSON request body');
    expect(JSON.parse(requestBody)).toEqual([
      expect.objectContaining({ runId: EVENT.runId, type: 'preview.ready' }),
    ]);
    expect(requestBody).not.toContain('eventKey');
  });
});
