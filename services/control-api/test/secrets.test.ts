import { ApiErrorSchema, IdempotencyHeader, newId } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../src/auth/port.js';
import { SERVICE_TOKEN_HEADER } from '../src/internal/service-auth.js';
import { ORGANIZATION_HEADER } from '../src/plugins/tenant.js';
import {
  KEY_BYTES,
  SecretDecryptionError,
  createEnvMasterKey,
  decryptSecret,
  encryptSecret,
} from '../src/secrets/crypto.js';
import { redactCredentials, redactSecrets } from '../src/secrets/redaction.js';
import {
  buildHarness,
  signIn,
  TEST_MASTER_KEY,
  type Harness,
  type TestSession,
} from './support/harness.js';
import { InMemoryTenantData } from './support/tenant-db.js';

/**
 * The secrets vault (CP-7), through the real HTTP pipeline.
 *
 * The identity provider, the stores and the clock are substituted. The session
 * plugin, the CSRF rule, the PRD §22.2 matrix, the idempotency plugin, the audit
 * seam, the service-token gate, **and the real AES-256-GCM envelope** are the
 * shipping code — `TEST_MASTER_KEY` wraps `createEnvMasterKey`, not a stub, so a
 * mistake in the cipher fails here rather than in production.
 *
 * The four properties this file exists to defend, each of which is a way a
 * secrets API is usually wrong:
 *
 * 1. **No response anywhere contains a plaintext.** Asserted recursively over
 *    every body of a full lifecycle, not field by field — a field-by-field
 *    assertion passes the day somebody adds a field.
 * 2. **A user session cannot reach the decrypt route.** Not "is not authorized
 *    to": a valid session with a valid CSRF header gets 401, because the
 *    internal gate refuses a user credential before it looks at anything else.
 * 3. **Every successful decrypt writes exactly one audit row**, naming the
 *    secret, the service and the reason — and a decrypt whose audit write fails
 *    returns no value at all.
 * 4. **A Viewer cannot list secret metadata**, though they can read the project
 *    it belongs to (PRD §22.2).
 */

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((built) => built.app.close()));
});

const OWNER: AuthIdentity = {
  externalId: 'secrets-test-owner',
  email: 'owner@acme.test',
  displayName: 'Olivia Owner',
};
const BUILDER: AuthIdentity = {
  externalId: 'secrets-test-builder',
  email: 'builder@acme.test',
  displayName: 'Bruno Builder',
};
const VIEWER: AuthIdentity = {
  externalId: 'secrets-test-viewer',
  email: 'viewer@acme.test',
  displayName: 'Vera Viewer',
};

/** The value every assertion below hunts for. Distinctive enough to grep a whole body for. */
const PLAINTEXT = 'postgres://zapp:hunter2-do-not-leak@db.internal:5432/acme';

function errorOf(response: { json: () => unknown }): string {
  return ApiErrorSchema.parse(response.json()).error.code;
}

interface Wired {
  readonly built: Harness;
  readonly data: InMemoryTenantData;
  readonly owner: TestSession;
  readonly organizationId: string;
  readonly projectId: string;
  /** The project's `preview` and `production` environment ids, in that order. */
  readonly environmentIds: [string, string];
  as: (member: TestSession, organizationId?: string) => Record<string, string>;
}

async function wire(options: { decryptCallers?: readonly string[] } = {}): Promise<Wired> {
  const data = new InMemoryTenantData();
  const built = buildHarness({
    tenantDb: data.factory,
    ...(options.decryptCallers === undefined ? {} : { decryptCallers: options.decryptCallers }),
  });
  harnesses.push(built);

  const owner = await signIn(built, OWNER);
  const created = await built.app.inject({
    method: 'POST',
    url: '/v1/organizations',
    headers: owner.headers,
    payload: { name: 'Acme Rockets' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const organizationId = created.json<{ organization: { id: string } }>().organization.id;

  const as = (member: TestSession, organization = organizationId): Record<string, string> => ({
    ...member.headers,
    [ORGANIZATION_HEADER]: organization,
  });

  const project = await built.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: as(owner),
    payload: { name: 'Checkout Service' },
  });
  expect(project.statusCode, project.body).toBe(201);
  const resources = project.json<{
    project: { id: string };
    environments: { id: string }[];
  }>();

  return {
    built,
    data,
    owner,
    organizationId,
    projectId: resources.project.id,
    environmentIds: [resources.environments[0]?.id ?? '', resources.environments[1]?.id ?? ''],
    as,
  };
}

async function join(
  wired: Wired,
  identity: AuthIdentity,
  role: 'owner' | 'builder' | 'viewer',
): Promise<TestSession> {
  const invited = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/organizations/${wired.organizationId}/invites`,
    headers: wired.owner.headers,
    payload: { email: identity.email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const token = invited.json<{ token: string }>().token;

  const session = await signIn(wired.built, identity);
  const accepted = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/invites/${token}/accept`,
    headers: session.headers,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  return session;
}

interface SecretView {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string | null;
  readonly keyVersion: number;
  readonly rotatedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

async function setSecret(
  wired: Wired,
  body: { name: string; value: string; environmentId?: string },
  session = wired.owner,
): Promise<SecretView> {
  const response = await wired.built.app.inject({
    method: 'POST',
    url: `/v1/projects/${wired.projectId}/secrets`,
    headers: wired.as(session),
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ secret: SecretView }>().secret;
}

/**
 * Every string anywhere in a JSON value, however deeply nested.
 *
 * The recursion is the assertion: checking `body.secret.value` would pass the
 * day a value appeared under `body.debug.envelope[0]`, and the failure mode this
 * suite exists for is exactly the one nobody predicted the shape of.
 */
function everyString(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(everyString);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...everyString(nested)]);
  }
  return [];
}

/** Asserts that nothing in `body` — at any depth, in any key or value — contains `secret`. */
function expectNoPlaintext(label: string, body: unknown, secret: string): void {
  for (const found of everyString(body)) {
    expect(found.includes(secret), `${label} leaked the secret value`).toBe(false);
  }
}

describe('the envelope', () => {
  it('round-trips a value, and produces a different ciphertext every time', async () => {
    const first = await encryptSecret(PLAINTEXT, TEST_MASTER_KEY);
    const second = await encryptSecret(PLAINTEXT, TEST_MASTER_KEY);

    expect(await decryptSecret(first, TEST_MASTER_KEY)).toBe(PLAINTEXT);
    expect(await decryptSecret(second, TEST_MASTER_KEY)).toBe(PLAINTEXT);
    // A fresh nonce and a fresh data key per secret: two encryptions of one
    // value must not be recognisable as the same value.
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
    expect(first.wrappedDek).not.toBe(second.wrappedDek);
    // And the plaintext is nowhere in what gets stored.
    expectNoPlaintext('the envelope', first, PLAINTEXT);
    expect(Buffer.from(first.ciphertext, 'base64').toString('utf8')).not.toContain('hunter2');
  });

  it('refuses a tampered ciphertext, tag or wrapped key rather than guessing', async () => {
    const envelope = await encryptSecret(PLAINTEXT, TEST_MASTER_KEY);
    const flip = (value: string): string => {
      const raw = Buffer.from(value, 'base64');
      raw[0] = (raw[0] ?? 0) ^ 0xff;
      return raw.toString('base64');
    };

    for (const broken of [
      { ...envelope, ciphertext: flip(envelope.ciphertext) },
      { ...envelope, authTag: flip(envelope.authTag) },
      { ...envelope, iv: flip(envelope.iv) },
      { ...envelope, wrappedDek: flip(envelope.wrappedDek) },
    ]) {
      await expect(decryptSecret(broken, TEST_MASTER_KEY)).rejects.toBeInstanceOf(
        SecretDecryptionError,
      );
    }
  });

  it('refuses a data key wrapped under a master key this process does not have', async () => {
    const other = createEnvMasterKey({ key: Buffer.alloc(KEY_BYTES, 0x99), version: 1 });
    const envelope = await encryptSecret(PLAINTEXT, other);

    await expect(decryptSecret(envelope, TEST_MASTER_KEY)).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it('reads a secret wrapped under the previous key while a rotation sweep runs', async () => {
    // Master-key rotation, as `src/env.ts` describes it: the old generation
    // stays readable, and nothing re-encrypts a *value* — that is the whole
    // point of the envelope.
    const previousKey = Buffer.alloc(KEY_BYTES, 0x11);
    const old = createEnvMasterKey({ key: previousKey, version: 1 });
    const rotated = createEnvMasterKey({
      key: Buffer.alloc(KEY_BYTES, 0x22),
      version: 2,
      previous: { key: previousKey, version: 1 },
    });

    const legacy = await encryptSecret(PLAINTEXT, old);
    expect(legacy.keyVersion).toBe(1);
    expect(await decryptSecret(legacy, rotated)).toBe(PLAINTEXT);
    // New secrets are wrapped under the new generation.
    expect((await encryptSecret('x', rotated)).keyVersion).toBe(2);
  });
});

describe('redaction', () => {
  it('replaces a value wherever it appears with the marker', () => {
    const registry = new Map([['DATABASE_URL', PLAINTEXT]]);
    const line = `connecting to ${PLAINTEXT} ... retrying ${PLAINTEXT}`;

    expect(redactSecrets(line, registry)).toBe(
      'connecting to [secret:DATABASE_URL] ... retrying [secret:DATABASE_URL]',
    );
    expect(redactSecrets(line, registry)).not.toContain('hunter2');
  });

  it('redacts the longest value first, so no fragment survives', () => {
    // `SHORT`'s value is a substring of `LONG`'s. Replacing the short one first
    // would leave `-suffix` in the output, which is still part of a credential.
    const registry = new Map([
      ['SHORT', 'abc123'],
      ['LONG', 'abc123-suffix'],
    ]);

    expect(redactSecrets('token=abc123-suffix', registry)).toBe('token=[secret:LONG]');
  });

  it('matches values literally, whatever regex metacharacters they contain', () => {
    const registry = new Map([['WEIRD', 'a.*b$(c)[d]\\e']]);

    expect(redactSecrets('value is a.*b$(c)[d]\\e here', registry)).toBe(
      'value is [secret:WEIRD] here',
    );
    // And does not match the pattern it looks like.
    expect(redactSecrets('value is aXXXb here', registry)).toBe('value is aXXXb here');
  });

  it('leaves text alone when nothing matches, and skips empty values', () => {
    expect(redactSecrets('nothing here', new Map([['A', 'zzz']]))).toBe('nothing here');
    expect(redactSecrets('nothing here', new Map([['EMPTY', '']]))).toBe('nothing here');
  });

  it('strips credential-shaped fragments from text we did not author', () => {
    // The git-failure log line (plan 02 CP-6 review): the provider quotes the
    // request, and the request carries our credentials.
    expect(
      redactCredentials('clone of https://zapp:ghp_secret@git.internal/acme/x.git failed'),
    ).toBe('clone of https://[redacted]@git.internal/acme/x.git failed');
    expect(redactCredentials('401 for Authorization: Bearer eyJhbGciOi.J9.sig')).toBe(
      '401 for Authorization: Bearer [redacted]',
    );
    expect(redactCredentials('GET /repos?access_token=abc123&page=2')).toBe(
      'GET /repos?access_token=[redacted]&page=2',
    );
  });
});

describe('setting a secret', () => {
  it('stores it encrypted, answers with metadata only, and audits the name', async () => {
    const wired = await wire();

    const secret = await setSecret(wired, {
      name: 'DATABASE_URL',
      value: PLAINTEXT,
      environmentId: wired.environmentIds[0],
    });

    expect(secret).toMatchObject({
      name: 'DATABASE_URL',
      environmentId: wired.environmentIds[0],
      keyVersion: 1,
      rotatedAt: null,
      createdBy: wired.owner.userId,
    });

    // What actually landed in the store: a metadata row with no value on it at
    // all, and a separate vault entry whose ciphertext is not the plaintext.
    expect(wired.data.secrets).toHaveLength(1);
    expectNoPlaintext('the metadata row', wired.data.secrets[0], PLAINTEXT);
    const envelope = wired.data.ciphertexts.get(secret.id);
    if (envelope === undefined) {
      throw new Error('the create wrote no vault row');
    }
    expectNoPlaintext('the vault row', envelope, PLAINTEXT);
    expect(await decryptSecret(envelope, TEST_MASTER_KEY)).toBe(PLAINTEXT);

    const entry = wired.built.audit.events.find((event) => event.action === 'secret.created');
    expect(entry).toMatchObject({ targetType: 'secret', targetId: secret.id, actorType: 'user' });
    expect(entry?.metadata).toMatchObject({ secretName: 'DATABASE_URL', keyVersion: 1 });
    // The trail is kept for years and is append-only. The name, never the value.
    expectNoPlaintext('the audit row', entry, PLAINTEXT);
  });

  it('lets a Builder set one and refuses a Viewer', async () => {
    const wired = await wire();
    const builder = await join(wired, BUILDER, 'builder');
    const viewer = await join(wired, VIEWER, 'viewer');

    await setSecret(wired, { name: 'STRIPE_KEY', value: 'sk_test_x' }, builder);

    const refused = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers: wired.as(viewer),
      payload: { name: 'NOPE', value: 'x' },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorOf(refused)).toBe('permission_denied');
    expect(wired.data.secrets).toHaveLength(1);
  });

  it('refuses a duplicate name in the same scope, and allows one per environment', async () => {
    const wired = await wire();
    const [preview, production] = wired.environmentIds;

    await setSecret(wired, { name: 'API_KEY', value: 'preview-value', environmentId: preview });
    await setSecret(wired, {
      name: 'API_KEY',
      value: 'production-value',
      environmentId: production,
    });
    // And once more with no environment at all, which is its own scope.
    await setSecret(wired, { name: 'API_KEY', value: 'default-value' });

    const duplicate = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers: wired.as(wired.owner),
      payload: { name: 'API_KEY', value: 'again', environmentId: preview },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(errorOf(duplicate)).toBe('secret_name_taken');
    expect(wired.data.secrets).toHaveLength(3);
  });

  it('refuses an environment that is not this project’s, and a name that is not a variable', async () => {
    const wired = await wire();

    const foreign = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers: wired.as(wired.owner),
      payload: { name: 'API_KEY', value: 'x', environmentId: newId('env') },
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(errorOf(foreign)).toBe('environment_not_found');

    for (const name of ['1LEADING_DIGIT', 'has space', 'PATH=x', 'dash-ed']) {
      const response = await wired.built.app.inject({
        method: 'POST',
        url: `/v1/projects/${wired.projectId}/secrets`,
        headers: wired.as(wired.owner),
        payload: { name, value: 'x' },
      });
      expect(response.statusCode, name).toBe(400);
    }
    expect(wired.data.secrets).toEqual([]);
  });

  it('answers 404 for a project that is not this tenant’s', async () => {
    const wired = await wire();

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${newId('proj')}/secrets`,
      headers: wired.as(wired.owner),
      payload: { name: 'API_KEY', value: 'x' },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(errorOf(response)).toBe('project_not_found');
  });

  it('does not create a second secret on a retried request', async () => {
    const wired = await wire();
    const payload = { name: 'API_KEY', value: PLAINTEXT };
    const headers = { ...wired.as(wired.owner), [IdempotencyHeader]: 'set-api-key-once' };

    const first = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers,
      payload,
    });
    const replay = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers,
      payload,
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(wired.data.secrets).toHaveLength(1);
    // Even the replayed body — which came out of the idempotency store rather
    // than out of the handler — carries no value.
    expectNoPlaintext('the replayed create', replay.json(), PLAINTEXT);
  });
});

describe('reading secret metadata', () => {
  it('never returns a value, at any depth, on any route of the lifecycle', async () => {
    const wired = await wire();
    const bodies: [string, unknown][] = [];

    const created = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers: wired.as(wired.owner),
      payload: { name: 'DATABASE_URL', value: PLAINTEXT, environmentId: wired.environmentIds[0] },
    });
    bodies.push(['POST /secrets', created.json()]);
    const secretId = created.json<{ secret: SecretView }>().secret.id;

    const listed = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers: wired.as(wired.owner),
    });
    bodies.push(['GET /secrets', listed.json()]);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ items: SecretView[] }>().items.map((item) => item.name)).toEqual([
      'DATABASE_URL',
    ]);

    const rotated = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets/${secretId}/rotate`,
      headers: wired.as(wired.owner),
      payload: { value: 'rotated-to-something-else' },
    });
    bodies.push(['POST /rotate', rotated.json()]);

    const projectView = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}`,
      headers: wired.as(wired.owner),
    });
    bodies.push(['GET /projects/:id', projectView.json()]);

    // The whole point: recursive, over every body, for both the original value
    // and the one it was rotated to.
    for (const [label, body] of bodies) {
      expectNoPlaintext(label, body, PLAINTEXT);
      expectNoPlaintext(label, body, 'rotated-to-something-else');
      // And the vault locator is not published either.
      expect(everyString(body)).not.toContain('encryptedValueRef');
    }

    // The raw response text too, not only the parsed body — a leak through a
    // header or a serialization quirk would not be in `json()`.
    for (const raw of [created.body, listed.body, rotated.body, projectView.body]) {
      expect(raw).not.toContain('hunter2');
    }
  });

  it('refuses a Viewer the metadata it grants them the project for', async () => {
    // PRD §22.2: `view_project` yes, `view_secret_metadata` no. Knowing a
    // project holds STRIPE_SECRET_KEY is information about how it is deployed.
    const wired = await wire();
    const viewer = await join(wired, VIEWER, 'viewer');
    await setSecret(wired, { name: 'STRIPE_SECRET_KEY', value: 'sk_live_x' });

    const project = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}`,
      headers: wired.as(viewer),
    });
    expect(project.statusCode).toBe(200);

    const secrets = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/secrets`,
      headers: wired.as(viewer),
    });
    expect(secrets.statusCode, secrets.body).toBe(403);
    expect(errorOf(secrets)).toBe('permission_denied');
  });

  it('pages with a cursor rather than returning everything', async () => {
    const wired = await wire();
    for (const name of ['A_KEY', 'B_KEY', 'C_KEY']) {
      await setSecret(wired, { name, value: `value-of-${name}` });
    }

    const first = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/secrets?limit=2`,
      headers: wired.as(wired.owner),
    });
    const page = first.json<{ items: SecretView[]; nextCursor: string | null }>();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBe(null);

    const second = await wired.built.app.inject({
      method: 'GET',
      url: `/v1/projects/${wired.projectId}/secrets?limit=2&cursor=${page.nextCursor ?? ''}`,
      headers: wired.as(wired.owner),
    });
    const rest = second.json<{ items: SecretView[]; nextCursor: string | null }>();
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBe(null);
    expect(new Set([...page.items, ...rest.items].map((item) => item.name))).toEqual(
      new Set(['A_KEY', 'B_KEY', 'C_KEY']),
    );
  });
});

describe('rotating and deleting', () => {
  it('replaces the stored value, keeps no history, and audits it', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    const before = wired.data.ciphertexts.get(secret.id);

    const response = await wired.built.app.inject({
      method: 'POST',
      url: `/v1/projects/${wired.projectId}/secrets/${secret.id}/rotate`,
      headers: wired.as(wired.owner),
      payload: { value: 'the-new-value' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ secret: SecretView }>().secret.rotatedAt).not.toBe(null);

    const after = wired.data.ciphertexts.get(secret.id);
    if (after === undefined) {
      throw new Error('the rotation left no vault row');
    }
    expect(after).not.toEqual(before);
    expect(await decryptSecret(after, TEST_MASTER_KEY)).toBe('the-new-value');
    // One vault row, not two: P0 keeps no version history, so the value that was
    // rotated away from is unrecoverable — which is what "rotated" has to mean.
    expect(wired.data.ciphertexts.size).toBe(1);

    const entry = wired.built.audit.events.find((event) => event.action === 'secret.rotated');
    expect(entry).toMatchObject({ targetType: 'secret', targetId: secret.id });
    expectNoPlaintext('the rotation audit row', entry, 'the-new-value');
  });

  it('deletes the metadata and the ciphertext together', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });

    const response = await wired.built.app.inject({
      method: 'DELETE',
      url: `/v1/projects/${wired.projectId}/secrets/${secret.id}`,
      headers: wired.as(wired.owner),
    });

    expect(response.statusCode, response.body).toBe(204);
    expect(wired.data.secrets).toEqual([]);
    // The cascade: no orphaned encrypted value survives the row that named it.
    expect(wired.data.ciphertexts.size).toBe(0);

    const entry = wired.built.audit.events.find((event) => event.action === 'secret.deleted');
    // The row is gone, so this is the only record that the secret ever existed.
    expect(entry?.metadata).toMatchObject({ secretName: 'DATABASE_URL' });
  });

  it('refuses a secret reached through the wrong project’s path', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });

    const other = await wired.built.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: wired.as(wired.owner),
      payload: { name: 'Other Project' },
    });
    const otherProjectId = other.json<{ project: { id: string } }>().project.id;

    for (const [method, url] of [
      ['DELETE', `/v1/projects/${otherProjectId}/secrets/${secret.id}`],
      ['POST', `/v1/projects/${otherProjectId}/secrets/${secret.id}/rotate`],
    ] as const) {
      const response = await wired.built.app.inject({
        method,
        url,
        headers: wired.as(wired.owner),
        ...(method === 'POST' ? { payload: { value: 'x' } } : {}),
      });
      // The path segment is not decoration: a secret of another project of the
      // same tenant is not reachable through this one.
      expect(response.statusCode, url).toBe(404);
      expect(errorOf(response)).toBe('secret_not_found');
    }
    expect(wired.data.secrets).toHaveLength(1);
  });
});

describe('the internal decrypt route', () => {
  const SANDBOX = 'sandbox-service';

  async function decrypt(
    wired: Wired,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<Awaited<ReturnType<Harness['app']['inject']>>> {
    return await wired.built.app.inject({
      method: 'POST',
      url: '/internal/secrets/decrypt',
      headers,
      payload: body,
    });
  }

  it('gives an allowlisted service the value, and writes exactly one audit row', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, {
      name: 'DATABASE_URL',
      value: PLAINTEXT,
      environmentId: wired.environmentIds[0],
    });
    const token = wired.built.serviceTokens.issue(SANDBOX);
    const before = wired.built.audit.events.length;

    const response = await decrypt(
      wired,
      {
        organizationId: wired.organizationId,
        secretId: secret.id,
        reason: 'injecting into sandbox for run_01test',
      },
      { [SERVICE_TOKEN_HEADER]: token },
    );

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ secret: { name: string; keyVersion: number }; value: string }>();
    expect(body.value).toBe(PLAINTEXT);
    expect(body.secret).toMatchObject({ name: 'DATABASE_URL', keyVersion: 1 });

    const written = wired.built.audit.events.slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'secret.decrypted',
      actorType: 'service',
      actorId: SANDBOX,
      targetType: 'secret',
      targetId: secret.id,
      organizationId: wired.organizationId,
    });
    expect(written[0]?.metadata).toEqual({
      secretName: 'DATABASE_URL',
      requestingService: SANDBOX,
      reason: 'injecting into sandbox for run_01test',
    });
    // The row records the read; it does not record what was read.
    expectNoPlaintext('the decrypt audit row', written[0], PLAINTEXT);
  });

  it('refuses a user session outright — valid cookie, valid CSRF, 401', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    // A token that *would* work, presented alongside the session: the session is
    // what disqualifies the request, before the token is even read.
    const token = wired.built.serviceTokens.issue(SANDBOX);
    const before = wired.built.audit.events.length;

    const body = {
      organizationId: wired.organizationId,
      secretId: secret.id,
      reason: 'a person trying to read their own secret',
    };

    for (const [label, headers] of [
      ['session cookie + CSRF', wired.as(wired.owner)],
      [
        'session cookie + CSRF + a valid service token',
        {
          ...wired.as(wired.owner),
          [SERVICE_TOKEN_HEADER]: token,
        },
      ],
      ['a bearer user token', { authorization: 'Bearer whatever-a-user-holds' }],
      [
        'a bearer user token + a valid service token',
        {
          authorization: 'Bearer whatever-a-user-holds',
          [SERVICE_TOKEN_HEADER]: token,
        },
      ],
      ['nothing at all', {}],
    ] as [string, Record<string, string>][]) {
      const response = await decrypt(wired, body, headers);

      expect(response.statusCode, label).toBe(401);
      expect(errorOf(response)).toBe('service_unauthenticated');
      expect(response.body).not.toContain('hunter2');
    }

    // PRD §22.2 "Read secret values: No through UI" — no row, because nothing
    // was read.
    expect(wired.built.audit.events).toHaveLength(before);
  });

  it('refuses a verified service that is not on the route’s allowlist', async () => {
    const wired = await wire({ decryptCallers: ['release-service'] });
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    const token = wired.built.serviceTokens.issue(SANDBOX);
    const before = wired.built.audit.events.length;

    const response = await decrypt(
      wired,
      {
        organizationId: wired.organizationId,
        secretId: secret.id,
        reason: 'a service that was never granted this',
      },
      { [SERVICE_TOKEN_HEADER]: token },
    );

    // 403, not 401: it is authenticated. Compromising one service's token does
    // not confer every service's reach.
    expect(response.statusCode, response.body).toBe(403);
    expect(errorOf(response)).toBe('service_not_allowed');
    expect(response.body).not.toContain('hunter2');
    expect(wired.built.audit.events).toHaveLength(before);
  });

  it('refuses an unverifiable token, and the deployed default verifies none', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });

    const response = await decrypt(
      wired,
      {
        organizationId: wired.organizationId,
        secretId: secret.id,
        reason: 'holding a token nobody issued',
      },
      { [SERVICE_TOKEN_HEADER]: 'forged-or-expired' },
    );

    expect(response.statusCode, response.body).toBe(401);
    expect(errorOf(response)).toBe('service_unauthenticated');
  });

  it('requires a reason, and refuses a body carrying anything else', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    const token = wired.built.serviceTokens.issue(SANDBOX);
    const headers = { [SERVICE_TOKEN_HEADER]: token };

    for (const body of [
      { organizationId: wired.organizationId, secretId: secret.id },
      { organizationId: wired.organizationId, secretId: secret.id, reason: '' },
      // A required field that accepts a keystroke is required in name only.
      { organizationId: wired.organizationId, secretId: secret.id, reason: 'x' },
      {
        organizationId: wired.organizationId,
        secretId: secret.id,
        reason: 'legitimate enough reason',
        pretendToBeAnotherService: 'release-service',
      },
    ]) {
      const response = await decrypt(wired, body, headers);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(response)).toBe('validation_failed');
    }
    expect(wired.built.audit.events.filter((event) => event.action === 'secret.decrypted')).toEqual(
      [],
    );
  });

  it('answers 404 for another organization’s secret, whatever the caller names', async () => {
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    const token = wired.built.serviceTokens.issue(SANDBOX);

    const response = await decrypt(
      wired,
      {
        // A real secret id, under an organization that does not own it. The
        // vault handle is bound to the organization named here, so the read
        // finds nothing — and says so exactly as it would for an id that never
        // existed.
        organizationId: newId('org'),
        secretId: secret.id,
        reason: 'reaching across a tenant boundary',
      },
      { [SERVICE_TOKEN_HEADER]: token },
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(errorOf(response)).toBe('secret_not_found');
    expect(response.body).not.toContain('hunter2');
    expect(wired.built.audit.events.filter((event) => event.action === 'secret.decrypted')).toEqual(
      [],
    );
  });

  it('returns nothing when the audit row cannot be written', async () => {
    /**
     * The mutation check for property 3: with the trail broken, the value must
     * not come out. The audit sink is the shipping in-memory one until this
     * point; replacing `record` with a throw is the smallest way to model "the
     * insert failed", and the read is in the same transaction as it.
     */
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    const token = wired.built.serviceTokens.issue(SANDBOX);

    const sink = wired.built.audit as unknown as {
      record: (...args: unknown[]) => Promise<void>;
    };
    sink.record = () => Promise.reject(new Error('audit_events insert failed'));

    const response = await decrypt(
      wired,
      {
        organizationId: wired.organizationId,
        secretId: secret.id,
        reason: 'the trail is broken and this must fail',
      },
      { [SERVICE_TOKEN_HEADER]: token },
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
  });

  it('keeps no copy of the response for idempotent replay', async () => {
    // The response body is a credential and the idempotency store is Redis; the
    // route opts out (`src/plugins/idempotency.ts`). Two identical requests with
    // the same key therefore both run the handler — and both write a row.
    const wired = await wire();
    const secret = await setSecret(wired, { name: 'DATABASE_URL', value: PLAINTEXT });
    const token = wired.built.serviceTokens.issue(SANDBOX);
    const headers = {
      [SERVICE_TOKEN_HEADER]: token,
      [IdempotencyHeader]: 'decrypt-twice-please',
    };
    const body = {
      organizationId: wired.organizationId,
      secretId: secret.id,
      reason: 'called twice with one key',
    };

    const first = await decrypt(wired, body, headers);
    const second = await decrypt(wired, body, headers);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    // Two reads, two rows. A replayed answer would have been one row for two
    // releases of the same credential.
    expect(
      wired.built.audit.events.filter((event) => event.action === 'secret.decrypted'),
    ).toHaveLength(2);
  });
});
