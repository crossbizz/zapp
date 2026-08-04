import { describe, expect, it, vi } from 'vitest';

import {
  ForgejoError,
  createForgejoClient,
  redactToken,
  type FetchLike,
} from '../src/forgejo/client.js';

const ADMIN_TOKEN = 'admin-token-value';

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * A `fetch` that answers from `make` and records what it was given.
 *
 * A *factory* rather than a `Response`: a body can be read once, so a stub that
 * handed the same instance to two calls would fail the second with "body already
 * read" — which looks like a bug in the client and is a bug in the test.
 */
function stubFetch(make: () => Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(make());
    },
  };
}

function client(fetchLike: FetchLike, timeoutMs = 5_000) {
  return createForgejoClient({
    baseUrl: 'https://git.test',
    adminToken: ADMIN_TOKEN,
    timeoutMs,
    fetch: fetchLike,
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The error a call was refused with. Fails the test when the call *succeeded* —
 * `.catch(e => e)` alone would hand back the successful response and let the
 * assertions below run against it.
 */
async function refusal(call: Promise<unknown>): Promise<ForgejoError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(ForgejoError);
    return error as ForgejoError;
  }
  throw new Error('expected the request to be refused, and it was not');
}

describe('the Forgejo client', () => {
  it('versions an API path and leaves /api/* alone', async () => {
    const stub = stubFetch(() => json({ ok: true }));

    await client(stub.fetch).send({ method: 'GET', path: '/orgs/zapp-projects' });
    await client(stub.fetch).send({ method: 'GET', path: '/api/healthz' });

    expect(stub.calls[0]?.url).toBe('https://git.test/api/v1/orgs/zapp-projects');
    // `/api/healthz` is outside the versioned API; prefixing it would 404.
    expect(stub.calls[1]?.url).toBe('https://git.test/api/healthz');
  });

  it('sends the admin token by default and nothing at all when anonymous', async () => {
    const stub = stubFetch(() => json({}));
    const api = client(stub.fetch);

    await api.send({ method: 'GET', path: '/user' });
    await api.send({ method: 'GET', path: '/user', auth: { kind: 'anonymous' } });

    expect((stub.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      `token ${ADMIN_TOKEN}`,
    );
    expect(
      (stub.calls[1]?.init.headers as Record<string, string>)['authorization'],
    ).toBeUndefined();
  });

  it('builds basic auth for the endpoints that accept nothing else', async () => {
    // Token creation (`POST /users/{name}/tokens`) refuses token auth — which is
    // the whole reason GIT-3's ephemeral users get a password.
    const stub = stubFetch(() => json({}));

    await client(stub.fetch).send({
      method: 'POST',
      path: '/users/zt-1/tokens',
      auth: { kind: 'basic', username: 'zt-1', password: 'pw' },
      body: { name: 't' },
    });

    expect((stub.calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      `Basic ${Buffer.from('zt-1:pw').toString('base64')}`,
    );
  });

  it('throws for an unexpected status and returns one the caller allowed', async () => {
    const missing = stubFetch(() => json({ message: 'user redirect does not exist' }, 404));

    await expect(
      client(missing.fetch).send({ method: 'GET', path: '/orgs/nope' }),
    ).rejects.toBeInstanceOf(ForgejoError);

    const allowed = await client(stubFetch(() => json({ message: 'nope' }, 404)).fetch).send({
      method: 'GET',
      path: '/orgs/nope',
      allow: [404],
    });
    // The status is the answer, and the body is deliberately dropped: a caller
    // that allowed a 404 asked "is it there?", not "what does the error say?".
    expect(allowed).toEqual({ status: 404, body: undefined });
  });

  it('never puts a credential in the error, whatever the response body says', async () => {
    const leak = 'ghp_thisisacredential';
    const stub = stubFetch(() =>
      json({ message: `failed cloning https://user:${leak}@git.test/x.git` }, 500),
    );

    const error = await refusal(
      client(stub.fetch).send({ method: 'POST', path: '/repos/migrate' }),
    );

    expect(error.message).not.toContain(leak);
    expect(error.message).toContain('forgejo POST /repos/migrate failed (500)');
    expect(error.status).toBe(500);
  });

  it('reports a transport failure as status 0 rather than as a refusal', async () => {
    // The distinction the provider branches on: a 404 means the thing is not
    // there, and a 0 means we do not know — which is not a state to create over.
    const error = await refusal(
      client(() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:3000'))).send({
        method: 'GET',
        path: '/user',
      }),
    );

    expect(error.status).toBe(0);
    expect(error.message).toContain('no response');
    // The fetch error can quote the URL, and a clone URL carries a credential in
    // its userinfo. It goes on `cause`, for the log, and never into the message.
    expect(error.message).not.toContain('10.0.0.1');
  });

  it('gives every request a deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const stub = stubFetch(() => json({}));

    await client(stub.fetch, 1_234).send({ method: 'GET', path: '/user' });

    // Per call, not per client: a shared signal would abort every in-flight
    // request the first time one of them timed out.
    expect(timeout).toHaveBeenCalledWith(1_234);
    expect(stub.calls[0]?.init.signal).toBeDefined();
    timeout.mockRestore();
  });

  it('reads 204 as an answer with no body', async () => {
    const stub = stubFetch(() => new Response(null, { status: 204 }));

    expect(await client(stub.fetch).send({ method: 'DELETE', path: '/repos/o/r' })).toEqual({
      status: 204,
      body: undefined,
    });
  });

  it('refuses a 2xx that is not JSON', async () => {
    // A proxy answering instead of Forgejo. Treating it as success would hand
    // the caller `undefined` where it expects a repository.
    const stub = stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));

    await expect(client(stub.fetch).send({ method: 'GET', path: '/user' })).rejects.toThrow(
      /not JSON/,
    );
  });
});

describe('redactToken', () => {
  it('removes URL userinfo and leaves the rest of the sentence', () => {
    expect(redactToken('cloning https://zt-1:secret@git.test/org_1/proj_2.git failed')).toBe(
      'cloning https://***@git.test/org_1/proj_2.git failed',
    );
  });

  it('leaves a string with no credential in it alone', () => {
    expect(redactToken('branch protection already exists')).toBe(
      'branch protection already exists',
    );
  });
});
