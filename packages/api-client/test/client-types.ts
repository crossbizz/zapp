import type { PublicApiMethod, ZappClient } from '../src/client.js';

declare const client: ZappClient;

void client.request('/v1/runs/{runId}', {
  method: 'GET',
  path: { runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC' },
});

void client.request('/v1/auth/device/token', {
  method: 'POST',
  body: { deviceCode: 'device-code' },
});

async function generatedResponseContract(): Promise<void> {
  const response = await client.request('/v1/auth/device/token', {
    method: 'POST',
    body: { deviceCode: 'device-code' },
  });
  void response.expiresIn;
  // @ts-expect-error the successful response has no caller-invented project field
  void response.project;
}
void generatedResponseContract;

void client.request('/v1/auth/refresh', { method: 'POST' });
void client.request('/v1/auth/refresh', { method: 'POST', body: null });
void client.request('/v1/auth/refresh', {
  method: 'POST',
  body: { refreshToken: 'refresh-token' },
});
void client.request('/v1/auth/logout', { method: 'POST' });
void client.request('/v1/auth/logout', { method: 'POST', body: null });

void client.request('/v1/auth/refresh', {
  method: 'POST',
  // @ts-expect-error refresh accepts only its generated strict object or null
  body: { invented: true },
});
void client.request('/v1/auth/logout', {
  method: 'POST',
  // @ts-expect-error logout does not accept an array body
  body: [],
});

async function redirectResponseContract(): Promise<void> {
  const login = await client.request('/v1/auth/login', { method: 'GET' });
  const callback = await client.request('/v1/auth/callback', {
    method: 'GET',
    query: { state: 'state' },
  });
  const loginStatus: 302 = login.status;
  const callbackStatus: 302 = callback.status;
  const loginLocation: string = login.headers.Location;
  const callbackLocation: string = callback.headers.Location;
  // @ts-expect-error redirects do not invent a JSON response body
  void login.project;
  void [loginStatus, callbackStatus, loginLocation, callbackLocation];
}
void redirectResponseContract;

function noContentResponseContract(): void {
  const logout: Promise<undefined> = client.request('/v1/auth/logout', { method: 'POST' });
  const approve: Promise<undefined> = client.request('/v1/auth/device/approve', {
    method: 'POST',
    body: { userCode: 'ABCD-EFGH' },
  });
  const deny: Promise<undefined> = client.request('/v1/auth/device/deny', {
    method: 'POST',
    body: { userCode: 'ABCD-EFGH' },
  });
  const memberDelete: Promise<undefined> = client.request(
    '/v1/organizations/{orgId}/members/{userId}',
    {
      method: 'DELETE',
      path: { orgId: 'org_01J8ME7YQZJ2V9Q0X3T5B6K7NA', userId: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NB' },
    },
  );
  const secretDelete: Promise<undefined> = client.request(
    '/v1/projects/{projectId}/secrets/{secretId}',
    {
      method: 'DELETE',
      path: {
        projectId: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NC',
        secretId: 'secret_01J8ME7YQZJ2V9Q0X3T5B6K7ND',
      },
    },
  );
  void [logout, approve, deny, memberDelete, secretDelete];
}
void noContentResponseContract;

// @ts-expect-error event streams use subscribeRunEvents, not the JSON request API
const streamRequestMethod: PublicApiMethod<'/v1/runs/{runId}/events'> = 'GET';
void streamRequestMethod;
void client.request('/v1/runs/{runId}/events', {
  // @ts-expect-error SSE GET is excluded from the generic request method set
  method: 'GET',
  // @ts-expect-error SSE path options are excluded with the operation
  path: { runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC' },
});

// @ts-expect-error only generated public path keys are accepted
void client.request('https://attacker.example/collect', { method: 'GET' });

void client.request('/v1/runs/{runId}', {
  // @ts-expect-error GET is the only operation generated for this endpoint
  method: 'POST',
  path: { runId: 'run_01J8ME7YQZJ2V9Q0X3T5B6K7NC' },
});

void client.request('/v1/auth/device/token', {
  method: 'POST',
  // @ts-expect-error deviceCode is generated as a string
  body: { deviceCode: 42 },
});

void client.request('/v1/projects', {
  method: 'GET',
  // @ts-expect-error generated includeArchived query values are string literals
  query: { includeArchived: true },
});

// @ts-expect-error callers cannot select their own response type
void client.request<{ invented: true }>('/v1/auth/device/token', {
  method: 'POST',
  body: { deviceCode: 'device-code' },
});
