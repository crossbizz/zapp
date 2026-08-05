import type { ZappClient } from '../src/client.js';

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
