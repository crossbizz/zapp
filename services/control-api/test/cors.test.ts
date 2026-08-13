import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildHarness } from './support/harness.js';

describe('browser API CORS', () => {
  const origin = 'http://localhost:3000';
  const harness = buildHarness({ config: { appBaseUrl: origin } });

  beforeAll(async () => {
    await harness.app.ready();
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('answers an allowed app-origin preflight before authentication', async () => {
    const response = await harness.app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: {
        origin,
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'content-type,x-organization-id',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(
      response.headers['access-control-allow-methods']?.split(',').map((method) => method.trim()),
    ).toEqual(expect.arrayContaining(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']));
    expect(response.headers['access-control-allow-headers']?.split(',')).toEqual([
      'content-type',
      'x-organization-id',
    ]);
  });

  it('does not grant a different origin access to API responses', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://attacker.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
